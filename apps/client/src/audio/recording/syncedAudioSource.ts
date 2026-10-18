import type { DecodedAudioRecording } from "./audioDecoder.ts";
import { makeChannelsAtSampleRate, mapSongTimeToRecordingPosition } from "./timeStretch.ts";
import { createSignalsmithStretchNode, type StretchNode } from "../signalsmithStretch.ts";

export type StretchNodeFactory = (context: AudioContext | OfflineAudioContext) => Promise<StretchNode>;

/**
 * Synchronized audio playback source driven by Web Audio clock.
 * Timing formula:
 * recordingPosition = songTime + recordingOffsetSeconds
 * Uses the locally bundled Signalsmith Stretch 1.3.2 WASM AudioWorklet with
 * semitones = 0. Playback fails visibly when that engine is unavailable.
 */
export class SyncedAudioSource {
  public recordingOffsetSeconds = 0;
  public volume = 1.0;
  public muted = false;

  private recording: DecodedAudioRecording | null = null;
  private audioContext: AudioContext | null = null;
  private destinationNode: AudioNode | null = null;
  private gainNode: GainNode | null = null;
  private stretchNode: StretchNode | null = null;
  private isAudioPlaying = false;
  private lastSongTime = 0;
  private lastSpeed = 1.0;
  private intentGeneration = 0;
  private pendingBaseSchedule: Promise<void> = Promise.resolve();
  private lastError: Error | null = null;
  private errorReported = false;
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(
    initialOffsetSeconds = 0,
    initialVolume = 1.0,
    private readonly stretchNodeFactory: StretchNodeFactory = createSignalsmithStretchNode,
  ) {
    this.recordingOffsetSeconds = initialOffsetSeconds;
    this.volume = Math.max(0, Math.min(1, initialVolume));
  }

  /**
   * Attaches a decoded recording to an AudioContext and destination node.
   * Initializes SignalsmithStretch in buffer mode if AudioWorklet is supported.
   */
  public async attach(
    recording: DecodedAudioRecording,
    audioContext: AudioContext,
    destinationNode: AudioNode,
  ): Promise<void> {
    if (this.isAudioPlaying) {
      this.pause();
    }

    if (this.stretchNode) {
      try {
        this.stretchNode.disconnect();
      } catch {
        // Safe ignore
      }
      this.stretchNode = null;
    }

    if (this.gainNode) {
      this.gainNode?.disconnect();
      this.gainNode = null;
    }

    this.recording = recording;
    this.audioContext = audioContext;
    this.destinationNode = destinationNode;
    this.lastError = null;
    this.errorReported = false;

    this.gainNode = audioContext.createGain();
    const effectiveGain = this.muted ? 0 : this.volume;
    this.gainNode.gain.setValueAtTime(effectiveGain, audioContext.currentTime);
    this.gainNode.connect(destinationNode);

    let stretch: StretchNode;
    try {
      stretch = await this.stretchNodeFactory(audioContext);
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.gainNode.disconnect();
      this.gainNode = null;
      throw this.lastError;
    }
    try {
      const channels = makeChannelsAtSampleRate(recording.buffer, audioContext.sampleRate);
      await stretch.dropBuffers();
      await stretch.addBuffers(channels);
      stretch.connect(this.gainNode);
      this.stretchNode = stretch;
    } catch (error) {
      try {
        stretch.disconnect();
      } catch {
        // Ignore cleanup errors while reporting the preparation failure.
      }
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw this.lastError;
    }
  }

  /**
   * Computes the playback position in the recording for a given song time.
   * Unified timing formula (A14): recordingPosition = songTime + offset
   */
  public calculateAudioTime(songTime: number): number {
    return mapSongTimeToRecordingPosition(songTime, this.recordingOffsetSeconds);
  }

  /**
   * Starts or resumes synchronized audio playback at songTime and speed.
   */
  public play(songTime: number, speed: number): Promise<void> {
    const intentGeneration = ++this.intentGeneration;
    this.lastSongTime = songTime;
    this.lastSpeed = speed;

    if (!this.recording || !this.audioContext || !this.gainNode || !this.stretchNode) {
      this.isAudioPlaying = false;
      if (this.recording && !this.stretchNode) {
        this.reportPlaybackError(new Error("Pitch-preserving playback is not prepared."));
      }
      return Promise.resolve();
    }

    const recordingPosition = this.calculateAudioTime(songTime);
    const duration = this.recording.durationSeconds;

    // If already past the end of the recording, nothing to play (silence)
    if (recordingPosition >= duration) {
      this.isAudioPlaying = false;
      this.pendingBaseSchedule = this.scheduleStretch({ output: this.audioContext.currentTime, active: false }, intentGeneration)
        .then(() => undefined);
      return this.pendingBaseSchedule;
    }

    this.isAudioPlaying = true;
    const ctxNow = this.audioContext.currentTime;

    const outputStart = Math.max(ctxNow, ctxNow + Math.max(0, -recordingPosition / Math.max(1e-6, speed)));
    const inputStart = Math.max(0, recordingPosition);
    this.pendingBaseSchedule = this.scheduleStretch({ output: ctxNow, active: false }, intentGeneration).then((stopped) => {
      if (!stopped || intentGeneration !== this.intentGeneration || !this.isAudioPlaying) return false;
      return this.scheduleStretch({
        output: outputStart,
        input: inputStart,
        rate: speed,
        semitones: 0,
        active: true,
      }, intentGeneration);
    }).then((started) => {
      if (!started && intentGeneration === this.intentGeneration) this.isAudioPlaying = false;
    }).then(() => undefined);
    return this.pendingBaseSchedule;
  }

  /**
   * Pauses audio playback and cancels active buffer source.
   */
  public pause(): void {
    const intentGeneration = ++this.intentGeneration;
    this.isAudioPlaying = false;
    if (this.stretchNode && this.audioContext) {
      void this.scheduleStretch({ output: this.audioContext.currentTime, active: false }, intentGeneration);
    }
  }

  /**
   * Seeks to a specific transport position. If playing, instantly re-anchors playback.
   */
  public seek(songTime: number, speed: number): void {
    this.intentGeneration += 1;
    this.lastSongTime = songTime;
    this.lastSpeed = speed;

    if (this.isAudioPlaying) {
      this.play(songTime, speed);
    }
  }

  /** Appends a future loop-head segment without interrupting the current source. */
  public seekAt(songTime: number, speed: number, outputTime: number): Promise<void> {
    const recording = this.recording;
    const context = this.audioContext;
    const intentGeneration = this.intentGeneration;
    if (!this.isAudioPlaying || !recording || !context || !this.stretchNode ||
        !Number.isFinite(songTime) || !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(outputTime)) {
      return Promise.resolve();
    }

    this.lastSongTime = songTime;
    this.lastSpeed = speed;
    const recordingPosition = this.calculateAudioTime(songTime);
    const startAt = Math.max(context.currentTime, outputTime);
    const pending = this.pendingBaseSchedule.then(async () => {
      if (intentGeneration !== this.intentGeneration || !this.isAudioPlaying) return;
      if (recordingPosition >= recording.durationSeconds) {
        await this.scheduleStretchAtOutput({ active: false }, startAt, intentGeneration);
        return;
      }

      const inputStart = Math.max(0, recordingPosition);
      const activeAt = startAt + Math.max(0, -recordingPosition / speed);
      if (activeAt > startAt) {
        await this.scheduleStretchAtOutput({ active: false }, startAt, intentGeneration);
      }
      if (intentGeneration !== this.intentGeneration || !this.isAudioPlaying) return;
      await this.scheduleStretchAtOutput({
        input: inputStart,
        rate: speed,
        semitones: 0,
        active: true,
      }, activeAt, intentGeneration);
    });
    this.pendingBaseSchedule = pending;
    return pending;
  }

  /**
   * Seamlessly updates playback speed preserving pitch (A15).
   */
  public setSpeed(speed: number, currentSongTime?: number): void {
    const intentGeneration = ++this.intentGeneration;
    this.lastSpeed = speed;
    if (!this.isAudioPlaying || !this.recording || !this.audioContext) {
      return;
    }

    const songTime = currentSongTime ?? this.lastSongTime;
    this.lastSongTime = songTime;
    const recordingPosition = this.calculateAudioTime(songTime);
    const duration = this.recording.durationSeconds;
    const ctxNow = this.audioContext.currentTime;

    if (recordingPosition < 0 || recordingPosition >= duration) {
      this.play(songTime, speed);
      return;
    }

    if (this.stretchNode) {
      void this.scheduleStretch({
        output: ctxNow,
        input: recordingPosition,
        rate: speed,
        semitones: 0,
        active: true,
      }, intentGeneration);
    }
  }

  /**
   * Sets the recording offset in seconds (where song time 0 falls in the recording).
   * If currently playing and position is provided, resyncs audio immediately.
   */
  public setOffset(
    offsetSeconds: number,
    currentSongTime?: number,
    currentSpeed?: number,
  ): void {
    this.recordingOffsetSeconds = offsetSeconds;

    if (this.isAudioPlaying && currentSongTime !== undefined && currentSpeed !== undefined) {
      this.play(currentSongTime, currentSpeed);
    }
  }

  /**
   * Sets recording track trim volume [0, 1].
   */
  public setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.volume = clamped;

    if (this.gainNode && this.audioContext) {
      const effectiveGain = this.muted ? 0 : this.volume;
      this.gainNode.gain.setValueAtTime(effectiveGain, this.audioContext.currentTime);
    }
  }

  /**
   * Mutes or unmutes the recording.
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;

    if (this.gainNode && this.audioContext) {
      const effectiveGain = this.muted ? 0 : this.volume;
      this.gainNode.gain.setValueAtTime(effectiveGain, this.audioContext.currentTime);
    }
  }

  /**
   * Returns current recording offset in seconds.
   */
  public getOffset(): number {
    return this.recordingOffsetSeconds;
  }

  /**
   * Returns current volume [0, 1].
   */
  public getVolume(): number {
    return this.volume;
  }

  /**
   * Returns whether recording is currently muted.
   */
  public isMuted(): boolean {
    return this.muted;
  }

  /**
   * Returns whether recording is currently playing.
   */
  public isPlaying(): boolean {
    return this.isAudioPlaying;
  }

  /**
   * Returns currently attached recording, or null if none.
   */
  public getRecording(): DecodedAudioRecording | null {
    return this.recording;
  }

  public getError(): Error | null {
    return this.lastError;
  }

  /** Called only by the explicit Transport Play action to retry a failed DSP schedule. */
  public clearPlaybackErrorForUserRetry(): void {
    this.lastError = null;
    this.errorReported = false;
  }

  public subscribeError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  public getStretchLatencySeconds(): number {
    return this.stretchNode?.latency() ?? 0;
  }

  private scheduleStretch(
    options: Parameters<StretchNode["schedule"]>[0],
    intentGeneration = this.intentGeneration,
  ): Promise<boolean> {
    const stretchNode = this.stretchNode;
    if (!stretchNode) return Promise.resolve(false);
    return stretchNode.schedule(options).then(
      () => true,
      (error: unknown) => {
        if (intentGeneration === this.intentGeneration) {
          this.reportPlaybackError(error instanceof Error ? error : new Error(String(error)));
        }
        return false;
      },
    );
  }

  private scheduleStretchAtOutput(
    options: Parameters<StretchNode["schedule"]>[0],
    outputTime: number,
    intentGeneration: number,
  ): Promise<boolean> {
    // Signalsmith's bundled worklet uses outputTime to cut/re-anchor its future
    // time map. `output` is retained for the public wrapper/API contract.
    const timestampedOptions = { ...options, output: outputTime, outputTime } as Parameters<StretchNode["schedule"]>[0];
    return this.scheduleStretch(timestampedOptions, intentGeneration);
  }

  private reportPlaybackError(error: Error): void {
    this.intentGeneration += 1;
    this.lastError = error;
    this.isAudioPlaying = false;
    if (this.errorReported) return;
    this.errorReported = true;
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // One observer must not prevent other playback error notifications.
      }
    }
  }

  /**
   * Disposes the synchronized audio source and releases all Web Audio nodes.
   */
  public dispose(): void {
    this.pause();

    if (this.stretchNode) {
      try {
        this.stretchNode.disconnect();
      } catch {
        // Safe ignore
      }
      this.stretchNode = null;
    }

    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        // Safe ignore
      }
      this.gainNode = null;
    }

    this.recording = null;
    this.audioContext = null;
    this.destinationNode = null;
    this.errorListeners.clear();
  }
}
