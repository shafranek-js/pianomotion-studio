import { TRANSPORT_LEAD_IN_SECONDS, type PerformancePlan } from "@handthesia/contracts";
import {
  getAudioContext,
  getMasterVolume,
  setMasterVolume,
} from "./audioContext.ts";
import { PianoSampler } from "./sampler.ts";
import type { PedalState, RestoredPianoVoice } from "./sampler.ts";
import type { SyncedAudioSource } from "./recording/syncedAudioSource.ts";

export type TransportState = "idle" | "playing" | "paused";

export interface TransportOptions {
  audioContext?: AudioContext;
  sampler?: PianoSampler;
  leadInSeconds?: number;
  scheduleAheadSeconds?: number;
  scheduleIntervalMs?: number;
}

const DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.1; // 100ms lookahead
const DEFAULT_SCHEDULE_INTERVAL_MS = 25; // 25ms polling tick
const MIN_SPEED = 0.25;
const MAX_SPEED = 2.0;

type PlaybackVoiceState = RestoredPianoVoice;

interface PlaybackState {
  voices: PlaybackVoiceState[];
  pedals: PedalState;
}

function derivePlaybackState(plan: PerformancePlan | null, songTime: number): PlaybackState {
  const pedals: PedalState = { sustain: false, sostenuto: false, soft: false };
  const voices = new Map<string, PlaybackVoiceState>();
  if (!plan) return { voices: [], pedals };

  for (const event of plan.events) {
    if (event.timeSeconds > songTime) break;
    if (event.type === "press") {
      voices.set(event.noteId, {
        noteId: event.noteId,
        pitch: event.pitch,
        velocity: event.velocity,
        keyState: "down",
        heldBySostenuto: false,
        sustainedBySustain: false,
        softPedalAtPress: pedals.soft,
      });
      continue;
    }

    if (event.type === "release") {
      const voice = voices.get(event.noteId);
      if (!voice) continue;
      voice.keyState = "up";
      if (pedals.sustain) {
        voice.sustainedBySustain = true;
      } else if (!(voice.heldBySostenuto && pedals.sostenuto)) {
        voices.delete(event.noteId);
      }
      continue;
    }

    const engaged = event.value >= 64;
    if (event.controller === 64) {
      const wasEngaged = pedals.sustain;
      pedals.sustain = engaged;
      if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (voice.keyState !== "up") continue;
          if (voice.heldBySostenuto && pedals.sostenuto) continue;
          voice.sustainedBySustain = false;
          voices.delete(noteId);
        }
      }
    } else if (event.controller === 66) {
      const wasEngaged = pedals.sostenuto;
      pedals.sostenuto = engaged;
      if (!wasEngaged && engaged) {
        for (const voice of voices.values()) {
          if (voice.keyState === "down") voice.heldBySostenuto = true;
        }
      } else if (wasEngaged && !engaged) {
        for (const [noteId, voice] of voices) {
          if (!voice.heldBySostenuto) continue;
          voice.heldBySostenuto = false;
          if (voice.keyState !== "up") continue;
          if (pedals.sustain) voice.sustainedBySustain = true;
          else voices.delete(noteId);
        }
      }
    } else {
      pedals.soft = engaged;
    }
  }

  return { voices: [...voices.values()], pedals };
}

/**
 * Transport controller driven by AudioContext clock.
 * Implements high-precision lookahead event scheduling (~100ms ahead every 25ms),
 * negative lead-in support (down to -2.0s), and seamless speed/volume/seeking controls.
 */
export class Transport {
  private readonly audioContext: AudioContext;
  private readonly sampler: PianoSampler;
  private readonly ownsSampler: boolean;

  private leadInSeconds: number;
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
  private syncedAudio: SyncedAudioSource | null = null;

  // Listeners
  private readonly timeListeners = new Set<(timeSeconds: number) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();
  private readonly speedListeners = new Set<(speed: number) => void>();
  private readonly endedListeners = new Set<() => void>();

  constructor(options: TransportOptions = {}) {
    this.audioContext = options.audioContext ?? getAudioContext();
    if (options.sampler) {
      this.sampler = options.sampler;
      this.ownsSampler = false;
    } else {
      this.sampler = new PianoSampler({ audioContext: this.audioContext });
      this.ownsSampler = true;
    }

    this.leadInSeconds = options.leadInSeconds ?? TRANSPORT_LEAD_IN_SECONDS;
    this.scheduleAheadSeconds = options.scheduleAheadSeconds ?? DEFAULT_SCHEDULE_AHEAD_SECONDS;
    this.scheduleIntervalMs = options.scheduleIntervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS;

    this.currentTime = -this.leadInSeconds;
    this.songStartTime = -this.leadInSeconds;
  }

  /**
   * Loads a PerformancePlan into the transport.
   * Resets position to -leadInSeconds and clears active playback.
   */
  public loadPlan(plan: PerformancePlan, explicitDurationSeconds?: number): void {
    this.pause();
    this.sampler.silenceAll();

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
    const position = wasPlaying ? this.getCurrentTime() : this.currentTime;

    this.stopScheduler();
    if (!wasPlaying) this.sampler.silenceAll();
    this.plan = plan;
    this.durationSeconds = this.resolveDuration(plan, explicitDurationSeconds);
    this.currentTime = this.clampSongTime(position);
    this.songStartTime = this.currentTime;
    this.audioStartTime = this.audioContext.currentTime;
    this.updateNextEventIndex(this.currentTime);

    if (wasPlaying) {
      this.restorePlaybackStateAt(this.currentTime);
      this.startScheduler();
      this.syncedAudio?.seek(this.currentTime, this.speed);
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
    if (this.state === "playing") {
      return;
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    const now = this.audioContext.currentTime;

    // If song was at the end or idle past duration, restart from lead-in
    if (this.durationSeconds > 0 && this.currentTime >= this.durationSeconds) {
      this.currentTime = -this.leadInSeconds;
    }

    this.songStartTime = this.currentTime;
    this.audioStartTime = now;
    this.updateNextEventIndex(this.currentTime);
    this.restorePlaybackStateAt(this.currentTime);
    this.state = "playing";
    this.startScheduler();

    this.syncedAudio?.play(this.currentTime, this.speed);

    this.emitState();
  }

  /**
   * Pauses playback.
   */
  public pause(): void {
    if (this.state !== "playing") {
      return;
    }

    this.currentTime = this.getCurrentTime();
    this.state = "paused";

    this.stopScheduler();
    this.sampler.silenceAll();
    this.syncedAudio?.pause();

    this.emitState();
    this.emitTime();
  }

  /**
   * Stops playback and resets playhead to start (-leadInSeconds).
   */
  public stop(): void {
    this.stopScheduler();
    this.sampler.silenceAll();
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
    if (!Number.isFinite(timeSeconds)) return;
    const clampedTime = this.clampSongTime(timeSeconds);

    if (this.state === "playing") {
      const now = this.audioContext.currentTime;
      this.songStartTime = clampedTime;
      this.audioStartTime = now;
      this.currentTime = clampedTime;
      this.updateNextEventIndex(clampedTime);
      this.restorePlaybackStateAt(clampedTime);
      this.syncedAudio?.seek(clampedTime, this.speed);
      this.tickScheduler();
    } else {
      this.sampler.silenceAll();
      this.currentTime = clampedTime;
      this.updateNextEventIndex(clampedTime);
      this.restorePedalStateAt(clampedTime);
      this.syncedAudio?.seek(clampedTime, this.speed);
    }

    this.emitTime();
  }

  /**
   * Sets playback speed in range [0.25, 2.0].
   * Seamlessly re-anchors clock to avoid any audio jumps or gaps.
   */
  public setSpeed(speed: number): void {
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

      // Silence any scheduled notes beyond current time and reschedule at new speed
      this.updateNextEventIndex(currentSongTime);
      this.restorePlaybackStateAt(currentSongTime);
      this.syncedAudio?.seek(currentSongTime, clampedSpeed);
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
    this.syncedAudio?.setVolume(volume);
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
    if (this.syncedAudio && this.syncedAudio !== syncedAudio) {
      this.syncedAudio.pause();
    }
    this.syncedAudio = syncedAudio;
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

    // Check if song has completed
    if (this.durationSeconds > 0 && currentSong >= this.durationSeconds) {
      this.pause();
      this.currentTime = this.durationSeconds;
      this.state = "idle";
      this.emitState();
      this.emitTime();
      this.emitEnded();
      return;
    }

    const audioHorizon = now + this.scheduleAheadSeconds;
    const songHorizon = this.songStartTime + (audioHorizon - this.audioStartTime) * this.speed;

    const events = this.plan.events;
    while (this.nextEventIndex < events.length) {
      const event = events[this.nextEventIndex]!;
      if (event.timeSeconds > songHorizon) {
        break;
      }

      // Exact Web Audio time for the event
      const audioTime = this.audioStartTime + (event.timeSeconds - this.songStartTime) / this.speed;
      const clampedAudioTime = Math.max(now, audioTime);

      switch (event.type) {
        case "press":
          this.sampler.noteOn(event.noteId, event.pitch, event.velocity, clampedAudioTime);
          break;
        case "release":
          this.sampler.noteOff(event.noteId, clampedAudioTime);
          break;
        case "pedal":
          this.sampler.pedal(event.controller, event.value, clampedAudioTime);
          break;
      }

      this.nextEventIndex += 1;
    }

    this.emitTime();
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.tickScheduler();
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
    this.sampler.restoreState(derivePlaybackState(this.plan, songTime));
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
    this.sampler.pedal(64, sustain, now);
    this.sampler.pedal(66, sostenuto, now);
    this.sampler.pedal(67, soft, now);
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

  /**
   * Disposes transport and any owned resources.
   */
  public dispose(): void {
    this.pause();
    this.timeListeners.clear();
    this.stateListeners.clear();
    this.speedListeners.clear();
    this.endedListeners.clear();
    if (this.syncedAudio) {
      this.syncedAudio.dispose();
      this.syncedAudio = null;
    }
    if (this.ownsSampler) {
      this.sampler.dispose();
    }
  }
}
