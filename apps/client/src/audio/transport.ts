import { TRANSPORT_LEAD_IN_SECONDS, type PerformancePlan } from "@handthesia/contracts";
import {
  getAudioContext,
  getMasterVolume,
  setMasterVolume,
} from "./audioContext.ts";
import { PianoSampler } from "./sampler.ts";
import { derivePerformanceStateAt } from "./performancePlan.ts";
import type { SyncedAudioSource } from "./recording/syncedAudioSource.ts";
import type { PerformanceOutput, PerformanceOutputId } from "./output/index.ts";
import { SynthPerformanceOutput } from "./output/index.ts";
import { recordDiagnostic } from "../diagnostics/eventLog";

export type TransportState = "idle" | "playing" | "paused";

export interface TransportOptions {
  audioContext?: AudioContext;
  sampler?: PianoSampler;
  leadInSeconds?: number;
  tailSeconds?: number;
  scheduleAheadSeconds?: number;
  scheduleIntervalMs?: number;
}

export const DEFAULT_TRANSPORT_TAIL_SECONDS = 1.2;
const DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.1; // 100ms lookahead
const DEFAULT_SCHEDULE_INTERVAL_MS = 25; // 25ms polling tick
const MIN_SPEED = 0.25;
const MAX_SPEED = 2.0;

/**
 * Transport controller driven by AudioContext clock.
 * Implements high-precision lookahead event scheduling (~100ms ahead every 25ms),
 * negative lead-in support (down to -2.0s), natural release decay tail, and seamless speed/volume/seeking controls.
 */
export class Transport {
  private readonly audioContext: AudioContext;
  private readonly sampler: PianoSampler;
  private readonly ownsSampler: boolean;
  private readonly defaultSynthOutput: SynthPerformanceOutput;
  private output: PerformanceOutput;

  private leadInSeconds: number;
  private tailSeconds: number;
  private readonly scheduleAheadSeconds: number;
  private readonly scheduleIntervalMs: number;

  private state: TransportState = "idle";
  private plan: PerformancePlan | null = null;
  private durationSeconds = 0;

  private speed = 1.0;
  private currentTime: number;

  // Clock synchronization anchors:
  // When playing, songTime = songStartTime + (audioContext.currentTime - audioStartTime) * speed
  private audioStartTime = 0;
  private songStartTime: number;

  private nextEventIndex = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private playRequestGeneration = 0;
  private disposed = false;
  private syncedAudio: SyncedAudioSource | null = null;
  private unsubscribeSyncedAudioError: (() => void) | null = null;
  private unsubscribeOutputUnavailable: (() => void) | null = null;
  private fatalOutputError: Error | null = null;
  private samplePreparation: {
    output: PerformanceOutput; plan: PerformancePlan; start: number; end: number;
    controller: AbortController; promise: Promise<void>;
  } | null = null;
  private preparingOutput = false;
  private nextSamplePrefetchTime = Number.NEGATIVE_INFINITY;
  private readonly preparationListeners = new Set<(preparing: boolean) => void>();

  // Listeners
  private readonly timeListeners = new Set<(timeSeconds: number) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();
  private readonly speedListeners = new Set<(speed: number) => void>();
  private readonly endedListeners = new Set<() => void>();
  private readonly outputErrorListeners = new Set<(error: Error) => void>();

  constructor(options: TransportOptions = {}) {
    this.audioContext = options.audioContext ?? getAudioContext();
    if (options.sampler) {
      this.sampler = options.sampler;
      this.ownsSampler = false;
    } else {
      this.sampler = new PianoSampler({ audioContext: this.audioContext });
      this.ownsSampler = true;
    }
    this.defaultSynthOutput = new SynthPerformanceOutput(this.sampler);
    this.output = this.defaultSynthOutput;

    this.leadInSeconds = options.leadInSeconds ?? TRANSPORT_LEAD_IN_SECONDS;
    this.tailSeconds = Math.max(0, options.tailSeconds ?? DEFAULT_TRANSPORT_TAIL_SECONDS);
    this.scheduleAheadSeconds = options.scheduleAheadSeconds ?? DEFAULT_SCHEDULE_AHEAD_SECONDS;
    this.scheduleIntervalMs = options.scheduleIntervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS;

    this.currentTime = -this.leadInSeconds;
    this.songStartTime = -this.leadInSeconds;
  }

  /**
   * Sets the active playback output engine (synth, soundfont, or webmidi).
   * Seamlessly transfers sounding voices and pedal state during active playback.
   */
  public setOutput(output: PerformanceOutput | null): void {
    const nextOutput = output ?? this.defaultSynthOutput;
    if (this.output === nextOutput) return;
    recordDiagnostic("transport.output", { fromOutput: this.output.id, toOutput: nextOutput.id, timeSeconds: this.getCurrentTime() });
    const resumePreparation = this.preparingOutput;
    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();

    const prevOutput = this.output;
    this.unsubscribeOutputUnavailable?.();
    this.unsubscribeOutputUnavailable = null;
    prevOutput.panic();
    if (prevOutput !== this.defaultSynthOutput) prevOutput.dispose();

    this.output = nextOutput;
    this.fatalOutputError = null;
    this.unsubscribeOutputUnavailable = this.output.subscribeUnavailable?.((error) => {
      this.fatalOutputError = error;
      this.playRequestGeneration += 1;
      this.cancelSamplePreparation();
      if (this.state === "playing") this.pause();
      for (const listener of this.outputErrorListeners) listener(error);
    }) ?? null;

    // Apply current master volume to the new output
    this.output.setVolume?.(getMasterVolume());

    if (this.state === "playing" && this.plan) {
      if (this.outputWindowReady(this.getCurrentTime(), this.getCurrentTime() + this.scheduleAheadSeconds * this.speed)) {
        this.output.restoreState(derivePerformanceStateAt(this.plan, this.getCurrentTime()));
      } else {
        this.pause();
        void this.play().catch(() => { /* play reports the current output error. */ });
      }
    } else if (this.plan) {
      this.restorePedalStateAt(this.currentTime);
      if (resumePreparation) void this.play().catch(() => { /* Reported by play. */ });
    }
  }

  /**
   * Returns currently active playback output.
   */
  public getOutput(): PerformanceOutput {
    return this.output;
  }

  /**
   * Returns the ID of the currently active output engine ("synth" | "soundfont" | "webmidi").
   */
  public getOutputId(): PerformanceOutputId {
    return this.output.id;
  }

  /** Returns an active-output error until a replacement output is activated. */
  public getOutputError(): Error | null {
    return this.fatalOutputError;
  }

  /**
   * Loads a PerformancePlan into the transport.
   * Resets position to -leadInSeconds and clears active playback.
   */
  public loadPlan(plan: PerformancePlan, explicitDurationSeconds?: number): void {
    this.pause();
    this.output.panic();

    this.plan = plan;

    this.durationSeconds = this.resolveDuration(plan, explicitDurationSeconds);

    this.currentTime = -this.leadInSeconds;
    this.songStartTime = -this.leadInSeconds;
    this.nextEventIndex = 0;
    this.state = "idle";

    this.emitState();
    this.emitTime();
  }

  /**
   * Replaces the active performance without resetting the playhead or transport state.
   * Notes and pedal state are rebuilt at the preserved position when playback is active.
   */
  public updatePlan(plan: PerformancePlan, explicitDurationSeconds?: number): void {
    const wasPlaying = this.state === "playing";
    const resumePreparation = this.preparingOutput;
    const position = wasPlaying ? this.getCurrentTime() : this.currentTime;

    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();
    this.stopScheduler();
    if (!wasPlaying) this.output.panic();
    this.plan = plan;
    this.durationSeconds = this.resolveDuration(plan, explicitDurationSeconds);
    this.currentTime = this.clampSongTime(position);
    this.songStartTime = this.currentTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.updateNextEventIndex(this.currentTime);

    if (wasPlaying) {
      if (this.outputWindowReady(this.currentTime, this.currentTime + this.scheduleAheadSeconds * this.speed)) {
        this.restorePlaybackStateAt(this.currentTime);
        this.startScheduler();
        this.syncedAudio?.seek(this.currentTime, this.speed);
      } else {
        this.pause();
        void this.play().catch(() => { /* Reported by play. */ });
      }
    } else if (resumePreparation) {
      void this.play().catch(() => { /* Reported by play. */ });
    }

    this.emitTime();
  }

  /**
   * Sets the total duration in seconds.
   */
  public setDuration(durationSeconds: number): void {
    if (Number.isFinite(durationSeconds)) {
      this.durationSeconds = Math.max(0, durationSeconds);
    }
  }

  /**
   * Sets lead-in length in seconds. A playhead parked at the old idle start
   * follows the new start; every other position and active clock is preserved.
   */
  public setLeadInSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds === this.leadInSeconds) return;
    const wasAtIdleStart = this.state === "idle" && this.currentTime === -this.leadInSeconds;
    this.leadInSeconds = seconds;
    if (wasAtIdleStart) {
      this.currentTime = -seconds;
      this.songStartTime = this.currentTime;
      this.emitTime();
    }
  }

  /**
   * Returns the total song duration in seconds.
   */
  public getDuration(): number {
    return this.durationSeconds;
  }

  /**
   * Sets natural audio release tail length in seconds.
   */
  public setTailSeconds(seconds: number): void {
    if (Number.isFinite(seconds)) {
      this.tailSeconds = Math.max(0, seconds);
    }
  }

  /**
   * Returns natural audio release tail length in seconds.
   */
  public getTailSeconds(): number {
    return this.tailSeconds;
  }

  /**
   * Returns current transport state: "idle" | "playing" | "paused".
   */
  public getState(): TransportState {
    return this.state;
  }

  /**
   * Returns current song time in seconds.
   * Reads high-precision Web Audio clock on every call with zero allocation,
   * ideal for 60/120fps PixiJS animation loops.
   */
  public getCurrentTime(): number {
    if (this.state === "playing") {
      const audioNow = this.audioContext.currentTime;
      const elapsedAudio = audioNow - this.audioStartTime;
      const songTime = this.songStartTime + elapsedAudio * this.speed;

      if (this.durationSeconds > 0 && songTime >= this.durationSeconds) {
        return this.durationSeconds;
      }
      return songTime;
    }
    return this.currentTime;
  }

  /**
   * Starts or resumes playback.
   */
  public async play(): Promise<void> {
    recordDiagnostic("transport.play-requested", { state: this.state, timeSeconds: this.getCurrentTime(), speed: this.speed, output: this.output.id });
    if (this.disposed || this.state === "playing") {
      return;
    }

    // A disconnected hardware output remains fatal until setOutput activates
    // a newly prepared backend; retrying the same device would be silent.
    if (this.fatalOutputError) return;

    const requestGeneration = ++this.playRequestGeneration;

    // A fresh Play gesture is the only way to retry a fatal recording-DSP
    // schedule after Transport reported it and paused.
    if (this.syncedAudio?.getError()) {
      this.syncedAudio.clearPlaybackErrorForUserRetry();
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Resume is asynchronous. Explicit pause/stop/dispose or a backend/DSP
    // failure while it is pending invalidates this play intent.
    if (this.disposed || requestGeneration !== this.playRequestGeneration ||
        this.fatalOutputError || this.syncedAudio?.getError()) {
      return;
    }

    // If song was at the end or idle past duration, restart from lead-in
    if (this.durationSeconds > 0 && this.currentTime >= this.durationSeconds) {
      this.currentTime = -this.leadInSeconds;
    }

    try {
      if (!this.outputWindowReady(this.currentTime, this.currentTime + 4)) {
        this.setPreparingOutput(true);
        await this.prepareOutputWindow(this.currentTime, this.currentTime + 4);
      }
    } catch (error) {
      if (this.disposed || requestGeneration !== this.playRequestGeneration) return;
      this.setPreparingOutput(false);
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handlePlaybackError(failure);
      throw failure;
    }
    if (this.disposed || requestGeneration !== this.playRequestGeneration || this.fatalOutputError) return;
    this.setPreparingOutput(false);
    const now = this.audioContext.currentTime;

    this.songStartTime = this.currentTime;
    this.audioStartTime = now;
    this.updateNextEventIndex(this.currentTime);
    this.restorePlaybackStateAt(this.currentTime);
    this.state = "playing";
    this.startScheduler();
    if (this.state !== "playing") return;

    this.syncedAudio?.play(this.currentTime, this.speed);

    this.emitState();
  }

  /**
   * Pauses playback.
   */
  public pause(): void {
    recordDiagnostic("transport.pause-requested", { state: this.state, timeSeconds: this.getCurrentTime(), preparingOutput: this.preparingOutput });
    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();
    if (this.state !== "playing") {
      return;
    }

    this.currentTime = this.getCurrentTime();
    this.state = "paused";

    this.stopScheduler();
    this.output.panic();
    this.syncedAudio?.pause();

    this.emitState();
    this.emitTime();
  }

  /**
   * Stops playback and resets playhead to start (-leadInSeconds).
   */
  public stop(): void {
    recordDiagnostic("transport.stop", { state: this.state, timeSeconds: this.getCurrentTime() });
    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();
    this.stopScheduler();
    this.output.panic();
    this.syncedAudio?.pause();

    this.currentTime = -this.leadInSeconds;
    this.songStartTime = -this.leadInSeconds;
    this.state = "idle";
    this.nextEventIndex = 0;

    this.emitState();
    this.emitTime();
  }

  /**
   * Seeks to a specific transport time in seconds.
   * Instantly chokes active audio and updates scheduler pointer.
   */
  public seek(timeSeconds: number): void {
    recordDiagnostic("transport.seek", { fromTimeSeconds: this.getCurrentTime(), toTimeSeconds: timeSeconds, state: this.state });
    if (!Number.isFinite(timeSeconds)) return;
    const clampedTime = this.clampSongTime(timeSeconds);
    const resumePreparation = this.preparingOutput;
    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();

    if (this.state === "playing") {
      const now = this.audioContext.currentTime;
      this.songStartTime = clampedTime;
      this.audioStartTime = now;
      this.currentTime = clampedTime;
      this.updateNextEventIndex(clampedTime);
      if (!this.outputWindowReady(clampedTime, clampedTime + this.scheduleAheadSeconds * this.speed)) {
        this.pause();
        void this.play().catch(() => { /* Reported by play. */ });
        return;
      }
      this.restorePlaybackStateAt(clampedTime);
      this.syncedAudio?.seek(clampedTime, this.speed);
      this.tickScheduler();
    } else {
      this.output.panic();
      this.currentTime = clampedTime;
      this.updateNextEventIndex(clampedTime);
      this.restorePedalStateAt(clampedTime);
      this.syncedAudio?.seek(clampedTime, this.speed);
      if (resumePreparation) void this.play().catch(() => { /* Reported by play. */ });
    }

    this.emitTime();
  }

  /**
   * Sets playback speed in range [0.25, 2.0].
   * Seamlessly re-anchors clock to avoid any audio jumps or gaps.
   */
  public setSpeed(speed: number): void {
    recordDiagnostic("transport.speed", { fromSpeed: this.speed, toSpeed: speed, timeSeconds: this.getCurrentTime() });
    const clampedSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
    if (Math.abs(this.speed - clampedSpeed) < 1e-6) {
      return;
    }

    if (this.state === "playing") {
      const currentSongTime = this.getCurrentTime();
      const now = this.audioContext.currentTime;

      this.songStartTime = currentSongTime;
      this.audioStartTime = now;
      this.speed = clampedSpeed;

      // Reschedule future events at new speed without silencing or re-triggering active notes (A15)
      this.updateNextEventIndex(currentSongTime);
      this.output.cancelScheduledFutureEvents(now);
      this.syncedAudio?.setSpeed(clampedSpeed, currentSongTime);
      this.tickScheduler();
    } else {
      this.speed = clampedSpeed;
    }

    this.emitSpeed();
  }

  /**
   * Returns current playback speed [0.25..2.0].
   */
  public getSpeed(): number {
    return this.speed;
  }

  /**
   * Sets master audio volume in range [0, 1].
   */
  public setVolume(volume: number): void {
    setMasterVolume(volume);
    this.output.setVolume?.(volume);
  }

  /**
   * Returns master audio volume [0, 1].
   */
  public getVolume(): number {
    return getMasterVolume();
  }

  /**
   * Attaches or clears the synchronized external audio recording source.
   */
  public setSyncedAudio(syncedAudio: SyncedAudioSource | null): void {
    this.unsubscribeSyncedAudioError?.();
    this.unsubscribeSyncedAudioError = null;
    if (this.syncedAudio && this.syncedAudio !== syncedAudio) {
      this.syncedAudio.pause();
    }
    this.syncedAudio = syncedAudio;
    this.unsubscribeSyncedAudioError = syncedAudio?.subscribeError((error) => this.handlePlaybackError(error)) ?? null;
    if (syncedAudio && this.state === "playing") {
      syncedAudio.play(this.getCurrentTime(), this.speed);
    }
  }

  /**
   * Returns current synchronized audio source, if attached.
   */
  public getSyncedAudio(): SyncedAudioSource | null {
    return this.syncedAudio;
  }

  /**
   * Returns the underlying PianoSampler instance.
   */
  public getSampler(): PianoSampler {
    return this.sampler;
  }

  /**
   * Subscribes to playhead time updates.
   * Returns an unsubscribe function.
   */
  public subscribeTime(callback: (timeSeconds: number) => void): () => void {
    this.timeListeners.add(callback);
    return () => {
      this.timeListeners.delete(callback);
    };
  }

  /**
   * Subscribes to transport state changes ("idle" | "playing" | "paused").
   * Returns an unsubscribe function.
   */
  public subscribeState(callback: (state: TransportState) => void): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Subscribes to playback speed changes.
   * Returns an unsubscribe function.
   */
  public subscribeSpeed(callback: (speed: number) => void): () => void {
    this.speedListeners.add(callback);
    return () => {
      this.speedListeners.delete(callback);
    };
  }

  /**
   * Subscribes to song completion ("ended").
   * Returns an unsubscribe function.
   */
  public subscribeEnded(callback: () => void): () => void {
    this.endedListeners.add(callback);
    return () => {
      this.endedListeners.delete(callback);
    };
  }

  /** Receives backend errors such as a disconnected hardware MIDI output. */
  public subscribeOutputError(callback: (error: Error) => void): () => void {
    this.outputErrorListeners.add(callback);
    return () => this.outputErrorListeners.delete(callback);
  }

  /** A frozen musical clock while file-backed SoundFont data is prepared. */
  public subscribePreparingOutput(callback: (preparing: boolean) => void): () => void {
    this.preparationListeners.add(callback);
    callback(this.preparingOutput);
    return () => this.preparationListeners.delete(callback);
  }

  public isPreparingOutput(): boolean { return this.preparingOutput; }

  private setPreparingOutput(preparing: boolean): void {
    if (this.preparingOutput === preparing) return;
    recordDiagnostic("transport.preparing-output", { preparing, output: this.output.id, timeSeconds: this.getCurrentTime() });
    this.preparingOutput = preparing;
    for (const listener of this.preparationListeners) listener(preparing);
  }

  private cancelSamplePreparation(): void {
    this.samplePreparation?.controller.abort();
    this.samplePreparation = null;
    this.nextSamplePrefetchTime = Number.NEGATIVE_INFINITY;
    this.setPreparingOutput(false);
  }

  private outputWindowReady(start: number, end: number): boolean {
    return !this.plan || !this.output.isWindowPrepared ||
      this.output.isWindowPrepared(this.plan, start, Math.min(this.durationSeconds, end));
  }

  private prepareOutputWindow(start: number, end: number): Promise<void> {
    const output = this.output;
    const plan = this.plan;
    if (!plan || !output.prepareWindow) return Promise.resolve();
    end = Math.min(this.durationSeconds, end);
    const current = this.samplePreparation;
    if (current && current.output === output && current.plan === plan && current.start <= start && current.end >= end) {
      return current.promise;
    }
    current?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => output.prepareWindow!(plan, start, end, controller.signal));
    const pending = { output, plan, start, end, controller, promise };
    this.samplePreparation = pending;
    void promise.finally(() => {
      if (this.samplePreparation === pending) this.samplePreparation = null;
    }).catch(() => { /* The awaiting playback or prefetch owns error reporting. */ });
    return promise;
  }

  /**
   * Lookahead scheduler tick running every ~25ms.
   * Schedules events in [audioNow, audioNow + scheduleAheadSeconds].
   */
  private tickScheduler(): void {
    if (this.state !== "playing" || !this.plan) {
      return;
    }

    const now = this.audioContext.currentTime;
    const currentSong = this.getCurrentTime();

    const songAudioEnd = this.durationSeconds > 0
      ? this.audioStartTime + (this.durationSeconds - this.songStartTime) / this.speed
      : Number.POSITIVE_INFINITY;
    const playbackAudioEnd = songAudioEnd + this.tailSeconds;

    // Check if song and natural tail decay have completed
    if (this.durationSeconds > 0 && now >= playbackAudioEnd) {
      this.playRequestGeneration += 1;
      this.cancelSamplePreparation();
      this.stopScheduler();
      this.output.panic();
      this.syncedAudio?.pause();
      this.currentTime = this.durationSeconds;
      this.state = "idle";
      this.emitState();
      this.emitTime();
      this.emitEnded();
      return;
    }

    // In the post-roll tail window (song reached duration, notes decaying naturally),
    // no new events remain to schedule.
    if (this.durationSeconds > 0 && now >= songAudioEnd) {
      this.emitTime();
      return;
    }

    const audioHorizon = now + this.scheduleAheadSeconds;
    const songHorizon = this.songStartTime + (audioHorizon - this.audioStartTime) * this.speed;

    if (!this.outputWindowReady(currentSong, songHorizon)) {
      this.pause();
      void this.play().catch(() => { /* play reports the preparation failure. */ });
      return;
    }
    if (this.output.prepareWindow && !this.samplePreparation && currentSong >= this.nextSamplePrefetchTime) {
      const expectedOutput = this.output;
      const expectedPlan = this.plan;
      const generation = this.playRequestGeneration;
      this.nextSamplePrefetchTime = currentSong + 0.5;
      void this.prepareOutputWindow(currentSong, currentSong + 4).catch(error => {
        if (generation === this.playRequestGeneration && this.output === expectedOutput && this.plan === expectedPlan) {
          this.handlePlaybackError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    const events = this.plan.events;
    try { while (this.nextEventIndex < events.length) {
      const event = events[this.nextEventIndex]!;
      if (event.timeSeconds > songHorizon) {
        break;
      }

      // Exact Web Audio time for the event
      const audioTime = this.audioStartTime + (event.timeSeconds - this.songStartTime) / this.speed;
      const clampedAudioTime = Math.max(now, audioTime);

      switch (event.type) {
        case "press":
          this.output.noteOn(event.noteId, event.pitch, event.velocity, clampedAudioTime);
          break;
        case "release":
          this.output.noteOff(event.noteId, undefined, clampedAudioTime);
          break;
        case "pedal":
          this.output.pedal(event.controller, event.value, clampedAudioTime);
          break;
      }

      this.nextEventIndex += 1;
    } } catch (error) {
      this.handlePlaybackError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.emitTime();
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.tickScheduler();
    if (this.state !== "playing") return;
    this.schedulerTimer = setInterval(() => {
      this.tickScheduler();
    }, this.scheduleIntervalMs);
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Binary searches for the first event strictly after songTime. Events exactly
   * at the restored boundary have already been replayed as part of the state.
   */
  private updateNextEventIndex(songTime: number): void {
    if (!this.plan || this.plan.events.length === 0) {
      this.nextEventIndex = 0;
      return;
    }

    const events = this.plan.events;
    let low = 0;
    let high = events.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      if (events[mid]!.timeSeconds <= songTime) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.nextEventIndex = low;
  }

  /**
   * Replays the ordered event prefix through songTime to recreate pressed keys
   * and sustain, sostenuto, and soft pedal state. Replaying at one audio instant
   * preserves equal-time release → pedal → press ordering from PerformancePlan.
   */
  private restorePlaybackStateAt(songTime: number): void {
    const state = derivePerformanceStateAt(this.plan, songTime);
    this.output.restoreState(state);
  }

  private restorePedalStateAt(songTime: number): void {
    if (!this.plan) return;
    let sustain = 0;
    let sostenuto = 0;
    let soft = 0;
    for (const event of this.plan.events) {
      if (event.timeSeconds > songTime) break;
      if (event.type !== "pedal") continue;
      if (event.controller === 64) sustain = event.value;
      else if (event.controller === 66) sostenuto = event.value;
      else soft = event.value;
    }
    const now = this.audioContext.currentTime;
    this.output.pedal(64, sustain, now);
    this.output.pedal(66, sostenuto, now);
    this.output.pedal(67, soft, now);
  }

  private resolveDuration(plan: PerformancePlan, explicitDurationSeconds?: number): number {
    if (explicitDurationSeconds !== undefined && Number.isFinite(explicitDurationSeconds) && explicitDurationSeconds > 0) {
      return explicitDurationSeconds;
    }
    const lastEvent = plan.events[plan.events.length - 1];
    return lastEvent?.timeSeconds ?? 0;
  }

  private clampSongTime(timeSeconds: number): number {
    const minTime = -this.leadInSeconds;
    const maxTime = Math.max(0, this.durationSeconds);
    return Math.max(minTime, Math.min(maxTime, timeSeconds));
  }

  private emitTime(): void {
    const time = this.getCurrentTime();
    for (const listener of this.timeListeners) {
      listener(time);
    }
  }

  private emitState(): void {
    recordDiagnostic("transport.state", { state: this.state, timeSeconds: this.getCurrentTime(), speed: this.speed });
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
  }

  private emitSpeed(): void {
    for (const listener of this.speedListeners) {
      listener(this.speed);
    }
  }

  private emitEnded(): void {
    for (const listener of this.endedListeners) {
      listener();
    }
  }

  private handlePlaybackError(error: Error): void {
    recordDiagnostic("transport.error", { error, output: this.output.id, timeSeconds: this.getCurrentTime() }, "error");
    this.playRequestGeneration += 1;
    this.cancelSamplePreparation();
    if (this.state === "playing") {
      this.currentTime = this.getCurrentTime();
      this.state = "paused";
      this.stopScheduler();
      this.output.panic();
      this.emitState();
      this.emitTime();
    }
    for (const listener of this.outputErrorListeners) listener(error);
  }

  /**
   * Disposes transport and any owned resources.
   */
  public dispose(): void {
    this.disposed = true;
    this.playRequestGeneration += 1;
    this.pause();
    this.timeListeners.clear();
    this.stateListeners.clear();
    this.speedListeners.clear();
    this.endedListeners.clear();
    this.preparationListeners.clear();
    if (this.syncedAudio) {
      this.syncedAudio.dispose();
      this.syncedAudio = null;
    }
    this.unsubscribeSyncedAudioError?.();
    this.unsubscribeSyncedAudioError = null;
    this.unsubscribeOutputUnavailable?.();
    this.unsubscribeOutputUnavailable = null;
    this.output.panic();
    if (this.output !== this.defaultSynthOutput) {
      this.output.dispose();
    }
    this.defaultSynthOutput.dispose();
    this.outputErrorListeners.clear();
  }
}
