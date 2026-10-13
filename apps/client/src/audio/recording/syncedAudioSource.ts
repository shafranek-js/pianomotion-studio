import type { DecodedAudioRecording } from "./audioDecoder.ts";

/**
 * Synchronized audio playback source driven by Web Audio clock.
 * Timing formula matches desktop audio_sync.py:
 * audioTime = recordingOffsetSeconds + (songTime / speed)
 */
export class SyncedAudioSource {
  public recordingOffsetSeconds = 0;
  public volume = 1.0;
  public muted = false;

  private recording: DecodedAudioRecording | null = null;
  private audioContext: AudioContext | null = null;
  private destinationNode: AudioNode | null = null;
  private gainNode: GainNode | null = null;
  private activeSourceNode: AudioBufferSourceNode | null = null;
  private isAudioPlaying = false;
  private lastSongTime = 0;
  private lastSpeed = 1.0;

  constructor(initialOffsetSeconds = 0, initialVolume = 1.0) {
    this.recordingOffsetSeconds = initialOffsetSeconds;
    this.volume = Math.max(0, Math.min(1, initialVolume));
  }

  /**
   * Attaches a decoded recording to an AudioContext and destination node.
   */
  public attach(
    recording: DecodedAudioRecording,
    audioContext: AudioContext,
    destinationNode: AudioNode,
  ): void {
    if (this.isAudioPlaying) {
      this.pause();
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    this.recording = recording;
    this.audioContext = audioContext;
    this.destinationNode = destinationNode;

    this.gainNode = audioContext.createGain();
    const effectiveGain = this.muted ? 0 : this.volume;
    this.gainNode.gain.setValueAtTime(effectiveGain, audioContext.currentTime);
    this.gainNode.connect(destinationNode);
  }

  /**
   * Computes the playback position in the recording for a given song time and playback speed.
   * Timing formula: audioTime = recordingOffsetSeconds + (songTime / speed)
   */
  public calculateAudioTime(songTime: number, speed: number): number {
    const s = Math.max(1e-6, speed);
    return this.recordingOffsetSeconds + songTime / s;
  }

  /**
   * Starts or resumes synchronized audio playback at songTime and speed.
   */
  public play(songTime: number, speed: number): void {
    this.lastSongTime = songTime;
    this.lastSpeed = speed;

    this.stopActiveSource();

    if (!this.recording || !this.audioContext || !this.gainNode) {
      this.isAudioPlaying = false;
      return;
    }

    const audioTime = this.calculateAudioTime(songTime, speed);

    // If already past the end of the recording, nothing to play
    if (audioTime >= this.recording.durationSeconds) {
      this.isAudioPlaying = false;
      return;
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = this.recording.buffer;
    source.connect(this.gainNode);

    source.onended = () => {
      if (this.activeSourceNode === source) {
        this.activeSourceNode = null;
        this.isAudioPlaying = false;
      }
    };

    this.activeSourceNode = source;
    this.isAudioPlaying = true;

    const ctxNow = this.audioContext.currentTime;

    if (audioTime >= 0) {
      // Audio begins immediately at the computed offset
      const remainingSeconds = this.recording.durationSeconds - audioTime;
      source.start(ctxNow, audioTime, remainingSeconds);
    } else {
      // audioTime < 0 means recording starts in the future when song reaches the recording offset
      const startDelaySeconds = -audioTime;
      source.start(ctxNow + startDelaySeconds, 0, this.recording.durationSeconds);
    }
  }

  /**
   * Pauses audio playback and cancels active buffer source.
   */
  public pause(): void {
    this.isAudioPlaying = false;
    this.stopActiveSource();
  }

  /**
   * Seeks to a specific transport position. If playing, instantly re-anchors playback.
   */
  public seek(songTime: number, speed: number): void {
    this.lastSongTime = songTime;
    this.lastSpeed = speed;

    if (this.isAudioPlaying) {
      this.play(songTime, speed);
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
   * Sets recording volume [0, 1].
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

  /**
   * Internal helper to safely stop and disconnect active source node.
   */
  private stopActiveSource(): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.stop();
      } catch {
        // Node may already be stopped or ended
      }
      try {
        this.activeSourceNode.disconnect();
      } catch {
        // Safe ignore
      }
      this.activeSourceNode = null;
    }
  }

  /**
   * Disposes the synchronized audio source and releases all Web Audio nodes.
   */
  public dispose(): void {
    this.pause();

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
  }
}
