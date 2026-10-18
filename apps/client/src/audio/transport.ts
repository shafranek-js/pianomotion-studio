import { TRANSPORT_LEAD_IN_SECONDS, type PerformancePlan } from "@handthesia/contracts";
import {
  getAudioContext,
  getMasterVolume,
  setMasterVolume,
} from "./audioContext.ts";
import { PianoSampler } from "./sampler.ts";
import { derivePerformanceStateAt } from "./performancePlan.ts";
import type { SyncedAudioSource } from "./recording/syncedAudioSource.ts";
import type { PerformanceOutput, PerformanceOutputId, PerformanceOutputWindow } from "./output/index.ts";
import { SynthPerformanceOutput } from "./output/index.ts";
import { recordDiagnostic } from "../diagnostics/eventLog";

export type TransportState = "idle" | "playing" | "paused";

export interface TransportLoopRange {
  startSeconds: number;
  endSeconds: number;
}

export const MIN_LOOP_SPAN_SECONDS = 0.1;
const LOOP_SPAN_TOLERANCE_SECONDS = 1e-9;

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

function normalizeOutputWindows(windows: readonly PerformanceOutputWindow[]): PerformanceOutputWindow[] {
  const ordered = windows.map((window) => ({ ...window }))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  return ordered.filter((window, index) => index === 0 ||
    window.startSeconds !== ordered[index - 1]!.startSeconds || window.endSeconds !== ordered[index - 1]!.endSeconds);
}

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

  private loopRange: TransportLoopRange | null = null;
  /** Audio-clock position of loop A for loopCycleIteration. */
  private loopCycleAudioStart = 0;
  private loopCycleIteration = 0;
  private loopScheduledIteration = 0;
  private loopNextEventIndex = 0;
  private loopLastObservedIteration = 0;
  private loopVoiceEpoch = 0;
  private readonly loopAliases = new Map<string, { noteId: string; pitch: number }>();

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
    output: PerformanceOutput; plan: PerformancePlan; windows: Array<{ startSeconds: number; endSeconds: number }>;
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
  private readonly loopListeners = new Set<(timeSeconds: number) => void>();

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
    this.loopAliases.clear();
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
      const time = this.getCurrentTime();
      const ready = this.loopRange
        ? this.loopOutputWindowReady()
        : this.outputWindowReady(time, time + this.scheduleAheadSeconds * this.speed);
      if (ready) {
        this.restorePlaybackStateAt(time);
        if (this.loopRange) {
          const now = this.audioContext.currentTime;
          this.anchorLoopScheduler(time, now, this.currentLoopIteration(now), false);
          this.tickScheduler();
        }
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
    if (this.loopRange && !this.isLoopRangeValid(this.loopRange)) this.loopRange = null;

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
    if (this.loopRange && !this.isLoopRangeValid(this.loopRange)) this.loopRange = null;
    this.songStartTime = this.currentTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.updateNextEventIndex(this.currentTime);

    if (wasPlaying) {
      if (this.loopRange) this.anchorLoopScheduler(this.currentTime, this.audioContext.currentTime, 0, true);
      if (this.loopRange ? this.loopOutputWindowReady() : this.outputWindowReady(this.currentTime, this.currentTime + this.scheduleAheadSeconds * this.speed)) {
        this.restorePlaybackStateAt(this.currentTime);
        if (this.loopRange) {
          this.syncedAudio?.seek(this.currentTime, this.speed);
          this.startScheduler();
        } else {
          this.startScheduler();
          this.syncedAudio?.seek(this.currentTime, this.speed);
        }
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
      if (this.loopRange && !this.isLoopRangeValid(this.loopRange)) this.setLoop(null);
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

  /** Enables, replaces, or disables exact A–B playback repetition. */
  public setLoop(range: TransportLoopRange | null): void {
    if (range !== null && !this.isLoopRangeValid(range)) {
      throw new RangeError("Loop range must be finite, ordered, at least 0.1 seconds long, and within the song duration.");
    }
    if (range && this.loopRange && range.startSeconds === this.loopRange.startSeconds && range.endSeconds === this.loopRange.endSeconds) return;
    if (!range && !this.loopRange) return;

    const wasPlaying = this.state === "playing";
    const resumePreparation = !wasPlaying && this.preparingOutput;
    const now = this.audioContext.currentTime;
    const position = wasPlaying ? this.getCurrentTime() : this.currentTime;
    const previousRange = this.loopRange;
    const previousIteration = wasPlaying && previousRange ? this.currentLoopIteration(now) : 0;

    if (wasPlaying) this.output.cancelScheduledFutureEvents(now);
    if (resumePreparation) {
      this.playRequestGeneration += 1;
      this.cancelSamplePreparation();
    }
    this.loopRange = range ? { ...range } : null;

    if (range) {
      this.loopAliases.clear();
      const target = wasPlaying
        ? (this.isInsideLoop(position, range) ? position : range.startSeconds)
        : this.currentTime;
      this.currentTime = target;
      this.songStartTime = target;
      this.audioStartTime = now;
      if (wasPlaying) {
        this.anchorLoopScheduler(target, now, 0, true);
        if (this.loopOutputWindowReady(target)) {
          this.restorePlaybackStateAt(target);
          this.syncedAudio?.seek(target, this.speed);
          this.startScheduler();
        } else {
          this.pause();
          void this.play().catch(() => { /* Reported by play. */ });
        }
      }
    } else {
      if (wasPlaying && previousRange && this.plan) {
        for (const voice of derivePerformanceStateAt(this.plan, position).voices) {
          this.loopAliases.set(voice.noteId, {
            noteId: this.loopVoiceId(voice.noteId, previousIteration),
            pitch: voice.pitch,
          });
        }
      } else {
        this.loopAliases.clear();
      }
      this.currentTime = position;
      this.songStartTime = position;
      this.audioStartTime = now;
      this.updateNextEventIndex(position);
      if (wasPlaying) {
        this.syncedAudio?.seek(position, this.speed);
        this.startScheduler();
      }
    }

    if (resumePreparation) void this.play().catch(() => { /* Reported by play. */ });

    this.emitTime();
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

      if (this.loopRange) return this.wrapLoopTime(songTime);

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

    // A looped Play gesture enters at A whenever the parked position is outside [A, B).
    if (this.loopRange && !this.isInsideLoop(this.currentTime)) {
      this.currentTime = this.loopRange.startSeconds;
    } else if (this.durationSeconds > 0 && this.currentTime >= this.durationSeconds) {
      this.currentTime = -this.leadInSeconds;
    }

    try {
      const prepared = this.loopRange
        ? this.loopOutputWindowReady()
        : this.outputWindowReady(this.currentTime, this.currentTime + 4);
      if (!prepared) {
        this.setPreparingOutput(true);
        if (this.loopRange) await this.prepareOutputWindows(this.loopPreparationWindows(this.currentTime));
        else await this.prepareOutputWindow(this.currentTime, this.currentTime + 4);
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
    if (this.loopRange) this.anchorLoopScheduler(this.currentTime, now, 0, true);
    else this.updateNextEventIndex(this.currentTime);
    this.restorePlaybackStateAt(this.currentTime);
    this.state = "playing";
    if (this.loopRange) {
      // Wait until the base recording segment is posted before appending future wraps.
      const recordingStart = this.syncedAudio?.play(this.currentTime, this.speed);
      this.emitState();
      if (recordingStart) await recordingStart;
      if (this.disposed || requestGeneration !== this.playRequestGeneration || this.state !== "playing") return;
      this.startScheduler();
      return;
    }

    this.startScheduler();
    if (this.state !== "playing") return;
    void this.syncedAudio?.play(this.currentTime, this.speed);
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
    this.loopAliases.clear();

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
    this.loopAliases.clear();

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
      const targetTime = this.loopRange && !this.isInsideLoop(clampedTime)
        ? this.loopRange.startSeconds
        : clampedTime;
      this.songStartTime = targetTime;
      this.audioStartTime = now;
      this.currentTime = targetTime;
      if (this.loopRange) this.anchorLoopScheduler(targetTime, now, 0, true);
      else this.updateNextEventIndex(targetTime);
      if (!(this.loopRange ? this.loopOutputWindowReady() : this.outputWindowReady(targetTime, targetTime + this.scheduleAheadSeconds * this.speed))) {
        this.pause();
        void this.play().catch(() => { /* Reported by play. */ });
        return;
      }
      this.restorePlaybackStateAt(targetTime);
      this.syncedAudio?.seek(targetTime, this.speed);
      this.tickScheduler();
    } else {
      this.output.panic();
      this.currentTime = clampedTime;
      this.loopAliases.clear();
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
      const currentIteration = this.loopRange ? this.currentLoopIteration(now) : 0;

      this.songStartTime = currentSongTime;
      this.audioStartTime = now;
      this.speed = clampedSpeed;

      // Reschedule future events at new speed without silencing or re-triggering active notes (A15)
      if (this.loopRange) this.anchorLoopScheduler(currentSongTime, now, currentIteration, false);
      else this.updateNextEventIndex(currentSongTime);
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
      void syncedAudio.play(this.getCurrentTime(), this.speed).then(() => {
        if (this.state === "playing" && this.loopRange && this.syncedAudio === syncedAudio) this.tickScheduler();
      });
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

  /** Reports each A-boundary after the audio clock has actually crossed it. */
  public subscribeLoop(callback: (timeSeconds: number) => void): () => void {
    this.loopListeners.add(callback);
    return () => this.loopListeners.delete(callback);
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

  private loopOutputWindowReady(position = this.getCurrentTime()): boolean {
    const range = this.loopRange;
    if (!range || !this.plan || (!this.output.isWindowPrepared && !this.output.isWindowsPrepared)) return true;
    const lookaheadSongSeconds = this.scheduleAheadSeconds * this.speed;
    const current = Math.max(range.startSeconds, Math.min(range.endSeconds, position));
    const windows = normalizeOutputWindows([
      { startSeconds: current, endSeconds: Math.min(range.endSeconds, current + lookaheadSongSeconds) },
      { startSeconds: range.startSeconds, endSeconds: Math.min(range.endSeconds, range.startSeconds + lookaheadSongSeconds) },
    ]);
    return this.output.isWindowsPrepared
      ? this.output.isWindowsPrepared(this.plan, windows)
      : windows.every((window) => this.outputWindowReady(window.startSeconds, window.endSeconds));
  }

  private loopPreparationWindows(position: number): Array<{ startSeconds: number; endSeconds: number }> {
    const range = this.loopRange;
    if (!range) return [];
    const current = Math.max(range.startSeconds, Math.min(range.endSeconds, position));
    const windows = [
      { startSeconds: range.startSeconds, endSeconds: Math.min(range.endSeconds, range.startSeconds + 4) },
      { startSeconds: current, endSeconds: Math.min(range.endSeconds, current + 4) },
    ].filter((window) => window.endSeconds > window.startSeconds);
    return normalizeOutputWindows(windows);
  }

  private isLoopRangeValid(range: TransportLoopRange): boolean {
    return Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds) &&
      range.startSeconds >= 0 && range.startSeconds < range.endSeconds &&
      range.endSeconds <= this.durationSeconds &&
      range.endSeconds - range.startSeconds + LOOP_SPAN_TOLERANCE_SECONDS >= MIN_LOOP_SPAN_SECONDS;
  }

  private isInsideLoop(timeSeconds: number, range = this.loopRange): boolean {
    return Boolean(range && timeSeconds >= range.startSeconds && timeSeconds < range.endSeconds);
  }

  private wrapLoopTime(timeSeconds: number, range = this.loopRange): number {
    if (!range) return timeSeconds;
    const span = range.endSeconds - range.startSeconds;
    const offset = ((timeSeconds - range.startSeconds) % span + span) % span;
    return range.startSeconds + offset;
  }

  private anchorLoopScheduler(
    songTime: number,
    audioTime: number,
    iteration: number,
    newVoiceEpoch: boolean,
  ): void {
    const range = this.loopRange;
    if (!range) return;
    const position = this.wrapLoopTime(songTime, range);
    if (newVoiceEpoch) {
      this.loopVoiceEpoch += 1;
      this.loopAliases.clear();
    }
    this.loopCycleAudioStart = audioTime - (position - range.startSeconds) / this.speed;
    this.loopCycleIteration = iteration;
    this.loopScheduledIteration = iteration;
    this.loopLastObservedIteration = iteration;
    this.loopNextEventIndex = this.firstEventAfter(position);
  }

  private currentLoopIteration(audioTime: number): number {
    const range = this.loopRange;
    if (!range) return 0;
    const cycleSeconds = (range.endSeconds - range.startSeconds) / this.speed;
    return this.loopCycleIteration + Math.max(0, Math.floor((audioTime - this.loopCycleAudioStart) / cycleSeconds));
  }

  private loopVoiceId(noteId: string, iteration: number): string {
    return `${noteId}\u0000loop:${this.loopVoiceEpoch}:${iteration}`;
  }

  private firstEventAfter(songTime: number): number {
    if (!this.plan) return 0;
    const events = this.plan.events;
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (events[middle]!.timeSeconds <= songTime) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Prefetches output samples (e.g. SoundFont) around a target time for interactive modes like Play Along. */
  public prefetchWindowAt(timeSeconds: number, horizonSeconds = 6): void {
    if (this.disposed || !this.plan || (!this.output.prepareWindow && !this.output.prepareWindows)) return;
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume().catch(() => {});
    }
    const plan = this.plan;
    const output = this.output;
    if (this.loopRange) {
      const range = this.loopRange;
      const start = Math.max(range.startSeconds, Math.min(range.endSeconds, timeSeconds));
      const end = Math.min(range.endSeconds, start + Math.max(0.5, Math.min(4, horizonSeconds)));
      if (end > start) {
        void this.prepareOutputWindows([
          ...this.loopPreparationWindows(this.getCurrentTime()),
          { startSeconds: start, endSeconds: Math.max(start, end) },
        ]).catch(() => {});
      }
      return;
    }
    const start = Math.max(0, timeSeconds);
    const end = Math.min(this.durationSeconds, Math.max(start + 0.5, start + horizonSeconds));
    if (end <= start) return;
    if (!this.outputWindowReady(start, end)) {
      void this.prepareOutputWindow(start, end)
        .then(() => {
          output.warmInteractiveWindow?.(plan, start, end);
        })
        .catch(() => {});
    } else {
      output.warmInteractiveWindow?.(plan, start, end);
    }
  }

  private prepareOutputWindow(start: number, end: number): Promise<void> {
    const output = this.output;
    const plan = this.plan;
    if (!plan || !output.prepareWindow) return Promise.resolve();
    end = Math.min(this.durationSeconds, end);
    const windows = [{ startSeconds: start, endSeconds: end }];
    const current = this.samplePreparation;
    if (current && current.output === output && current.plan === plan && this.windowsCoveredBy(windows, current.windows)) {
      return current.promise;
    }
    current?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => output.prepareWindow!(plan, start, end, controller.signal));
    const pending = { output, plan, windows, controller, promise };
    this.samplePreparation = pending;
    void promise.finally(() => {
      if (this.samplePreparation === pending) this.samplePreparation = null;
    }).catch(() => { /* The awaiting playback or prefetch owns error reporting. */ });
    return promise;
  }

  private prepareOutputWindows(windows: Array<{ startSeconds: number; endSeconds: number }>): Promise<void> {
    const output = this.output;
    const plan = this.plan;
    if (!plan || (!output.prepareWindows && !output.prepareWindow)) return Promise.resolve();
    const bounded = windows.map((window) => ({
      startSeconds: Math.max(0, window.startSeconds),
      endSeconds: Math.min(this.durationSeconds, window.endSeconds),
    })).filter((window) => window.endSeconds > window.startSeconds)
      .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
    if (bounded.length === 0) return Promise.resolve();
    if (output.isWindowsPrepared?.(plan, bounded) ||
        (!output.isWindowsPrepared && bounded.every((window) => this.outputWindowReady(window.startSeconds, window.endSeconds)))) {
      return Promise.resolve();
    }
    const current = this.samplePreparation;
    if (current && current.output === output && current.plan === plan && this.windowsCoveredBy(bounded, current.windows)) {
      return current.promise;
    }
    current?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => {
      if (output.prepareWindows) return output.prepareWindows(plan, bounded, controller.signal);
      return bounded.reduce<Promise<void>>((pending, window) => pending.then(() =>
        output.prepareWindow!(plan, window.startSeconds, window.endSeconds, controller.signal)), Promise.resolve());
    });
    const pending = { output, plan, windows: bounded, controller, promise };
    this.samplePreparation = pending;
    void promise.finally(() => {
      if (this.samplePreparation === pending) this.samplePreparation = null;
    }).catch(() => { /* The awaiting playback or prefetch owns error reporting. */ });
    return promise;
  }

  private windowsCoveredBy(
    requested: readonly { startSeconds: number; endSeconds: number }[],
    prepared: readonly { startSeconds: number; endSeconds: number }[],
  ): boolean {
    return requested.every((window) => prepared.some((candidate) =>
      window.startSeconds >= candidate.startSeconds && window.endSeconds <= candidate.endSeconds));
  }

  /**
   * Lookahead scheduler tick running every ~25ms.
   * Schedules events in [audioNow, audioNow + scheduleAheadSeconds].
   */
  private tickScheduler(): void {
    if (this.state !== "playing" || !this.plan) {
      return;
    }

    if (this.loopRange) {
      this.tickLoopScheduler();
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
          {
            const alias = this.loopAliases.get(event.noteId);
            this.output.noteOff(alias?.noteId ?? event.noteId, alias?.pitch, clampedAudioTime);
            this.loopAliases.delete(event.noteId);
          }
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

  private tickLoopScheduler(): void {
    const range = this.loopRange;
    const plan = this.plan;
    if (this.state !== "playing" || !range || !plan) return;

    const now = this.audioContext.currentTime;
    const horizon = now + this.scheduleAheadSeconds;
    const span = range.endSeconds - range.startSeconds;
    const cycleAudioSeconds = span / this.speed;
    const actualIteration = this.currentLoopIteration(now);
    while (this.loopLastObservedIteration < actualIteration) {
      this.loopLastObservedIteration += 1;
      this.nextSamplePrefetchTime = range.startSeconds;
      for (const listener of this.loopListeners) listener(range.startSeconds);
    }

    if (!this.loopOutputWindowReady()) {
      this.pause();
      void this.play().catch(() => { /* play reports the preparation failure. */ });
      return;
    }

    if ((this.output.prepareWindows || this.output.prepareWindow) && !this.samplePreparation &&
        this.getCurrentTime() >= this.nextSamplePrefetchTime) {
      const expectedOutput = this.output;
      const expectedPlan = this.plan;
      const generation = this.playRequestGeneration;
      const position = this.getCurrentTime();
      this.nextSamplePrefetchTime = position + 0.5;
      void this.prepareOutputWindows(this.loopPreparationWindows(position)).catch((error: unknown) => {
        if (generation === this.playRequestGeneration && this.output === expectedOutput && this.plan === expectedPlan) {
          this.handlePlaybackError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    const events = plan.events;
    try {
      while (true) {
        const iteration = this.loopScheduledIteration;
        const cycleStartAudio = this.loopCycleAudioStart + (iteration - this.loopCycleIteration) * cycleAudioSeconds;
        const boundaryAudio = cycleStartAudio + cycleAudioSeconds;

        while (this.loopNextEventIndex < events.length) {
          const event = events[this.loopNextEventIndex]!;
          if (event.timeSeconds >= range.endSeconds) break;
          const eventAudio = cycleStartAudio + (event.timeSeconds - range.startSeconds) / this.speed;
          if (eventAudio > horizon) break;

          const scheduledTime = Math.max(now, eventAudio);
          switch (event.type) {
            case "press": {
              const loopNoteId = this.loopVoiceId(event.noteId, iteration);
              this.output.noteOn(loopNoteId, event.pitch, event.velocity, scheduledTime);
              break;
            }
            case "release": {
              const loopNoteId = this.loopVoiceId(event.noteId, iteration);
              this.output.noteOff(loopNoteId, undefined, scheduledTime);
              break;
            }
            case "pedal":
              this.output.pedal(event.controller, event.value, scheduledTime);
              break;
          }
          this.loopNextEventIndex += 1;
        }

        if (boundaryAudio > horizon) break;
        const boundaryTime = Math.max(now, boundaryAudio);
        this.scheduleLoopBoundary(iteration, boundaryTime);
        this.loopScheduledIteration += 1;
        this.loopNextEventIndex = this.firstEventAfter(range.startSeconds);
      }
    } catch (error) {
      this.handlePlaybackError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Unlike a linear song, a loop never enters the duration tail or ends.
    this.emitTime();
  }

  private scheduleLoopBoundary(iteration: number, audioTime: number): void {
    const range = this.loopRange;
    const plan = this.plan;
    if (!range || !plan) return;

    const endState = derivePerformanceStateAt({
      ...plan,
      events: plan.events.filter((event) => event.timeSeconds < range.endSeconds),
    }, range.endSeconds);
    const startState = derivePerformanceStateAt(plan, range.startSeconds);

    for (const voice of endState.voices) {
      this.output.noteOff(this.loopVoiceId(voice.noteId, iteration), voice.pitch, audioTime);
    }
    this.output.pedal(64, 0, audioTime);
    this.output.pedal(66, 0, audioTime);
    this.output.pedal(67, 0, audioTime);

    let soft = false;
    const setSoft = (enabled: boolean) => {
      if (soft === enabled) return;
      soft = enabled;
      this.output.pedal(67, enabled ? 127 : 0, audioTime);
    };
    const nextIteration = iteration + 1;
    const noteOn = (voice: (typeof startState.voices)[number]) => {
      setSoft(voice.softPedalAtPress);
      this.output.noteOn(this.loopVoiceId(voice.noteId, nextIteration), voice.pitch, voice.velocity, audioTime);
    };

    for (const voice of startState.voices) {
      if (voice.heldBySostenuto) noteOn(voice);
    }
    if (startState.pedals.sostenuto) this.output.pedal(66, 127, audioTime);
    for (const voice of startState.voices) {
      if (!voice.heldBySostenuto) noteOn(voice);
    }
    for (const voice of startState.voices) {
      if (voice.keyState === "up" && !voice.sustainedBySustain) {
        this.output.noteOff(this.loopVoiceId(voice.noteId, nextIteration), voice.pitch, audioTime);
      }
    }
    if (startState.pedals.sustain) this.output.pedal(64, 127, audioTime);
    for (const voice of startState.voices) {
      if (voice.keyState === "up" && voice.sustainedBySustain) {
        this.output.noteOff(this.loopVoiceId(voice.noteId, nextIteration), voice.pitch, audioTime);
      }
    }
    setSoft(startState.pedals.soft);
    void this.syncedAudio?.seekAt(range.startSeconds, this.speed, audioTime).catch((error: unknown) => {
      this.handlePlaybackError(error instanceof Error ? error : new Error(String(error)));
    });
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
    if (this.loopRange) {
      const iteration = this.currentLoopIteration(this.audioContext.currentTime);
      for (const voice of state.voices) voice.noteId = this.loopVoiceId(voice.noteId, iteration);
    }
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
    this.loopListeners.clear();
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
