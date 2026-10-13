import type { PerformancePlan, SongDocument } from "@handthesia/contracts";
import type { DecodedAudioRecording } from "../audio";
import { audioBufferToWavBlob, encodeAudioBufferToWav, type AudioBufferLike } from "./wavEncoder";

export const AUDIO_RATE = 44100;
export const NORMALIZE_PEAK = 0.89; // -1 dBFS
export const NORMALIZE_GAIN_MAX = 16.0;

export interface OfflineAudioRenderOptions {
  document: SongDocument;
  performancePlan?: PerformancePlan | null;
  audioRecording?: DecodedAudioRecording | null;
  audioOffset?: number; // seconds where MIDI 0 falls in recording
  speed: number;
  startTime: number; // leadInSeconds (e.g. -2.0)
  durationSeconds: number;
  sampleRate?: number;
  volume?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface OfflineAudioRenderResult {
  audioBuffer: AudioBufferLike;
  wavBlob: Blob;
  wavBytes: Uint8Array;
}

/**
 * Lightweight in-memory AudioBuffer implementation that works in both Browser and Node/Vitest environments.
 */
export class MemoryAudioBuffer implements AudioBufferLike {
  public readonly numberOfChannels: number;
  public readonly sampleRate: number;
  public readonly length: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = Math.max(1, numberOfChannels);
    this.length = Math.max(1, length);
    this.sampleRate = sampleRate;
    this.channels = [];
    for (let c = 0; c < this.numberOfChannels; c++) {
      this.channels.push(new Float32Array(this.length));
    }
  }

  public getChannelData(channel: number): Float32Array {
    if (channel < 0 || channel >= this.numberOfChannels) {
      throw new Error(`Channel index out of bounds: ${channel}`);
    }
    return this.channels[channel]!;
  }
}

/**
 * Normalizes float audio buffer samples in-place up to NORMALIZE_GAIN_MAX (16.0x) targeting NORMALIZE_PEAK (0.89).
 */
export function normalizeAudioBuffer(buffer: AudioBufferLike): number {
  let peak = 0;
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;

  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(data[i]!);
      if (abs > peak) peak = abs;
    }
  }

  if (peak > 1e-6) {
    const gain = Math.min(NORMALIZE_GAIN_MAX, NORMALIZE_PEAK / peak);
    for (let ch = 0; ch < numChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = data[i]! * gain;
      }
    }
    return gain;
  }

  return 1.0;
}

/**
 * Slices a recorded audio buffer for timeline synchronization:
 *   t_audio = audioOffset + (t_song / speed)
 * Fills silence where recording hasn't begun or has ended.
 */
export function sliceRecordingAudio(
  recording: DecodedAudioRecording,
  startTime: number,
  speed: number,
  durationSeconds: number,
  audioOffset = 0,
): AudioBufferLike {
  const rate = recording.sampleRate || AUDIO_RATE;
  const totalFrames = Math.max(1, Math.round(durationSeconds * rate));
  const numChannels = Math.max(1, Math.min(2, recording.numberOfChannels || recording.buffer.numberOfChannels));
  const outBuffer = new MemoryAudioBuffer(numChannels, totalFrames, rate);

  const startFrame = Math.round((audioOffset + startTime / speed) * rate);
  const srcLen = recording.buffer.length;

  const lo = Math.max(0, startFrame);
  const hi = Math.min(srcLen, startFrame + totalFrames);

  if (hi > lo) {
    const destOffset = lo - startFrame;
    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = recording.buffer.getChannelData(ch % recording.buffer.numberOfChannels);
      const destData = outBuffer.getChannelData(ch);
      destData.set(srcData.subarray(lo, hi), destOffset);
    }
  }

  return outBuffer;
}

/**
 * Synthesizes note events into an AudioBuffer using standard piano harmonic envelope formulas.
 */
export function synthesizeNotesToBuffer(
  document: SongDocument,
  performancePlan: PerformancePlan | null | undefined,
  startTime: number,
  speed: number,
  durationSeconds: number,
  sampleRate = AUDIO_RATE,
  volume = 0.8,
): AudioBufferLike {
  const totalFrames = Math.max(1, Math.round(durationSeconds * sampleRate));
  const buffer = new MemoryAudioBuffer(2, totalFrames, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Collect notes to render
  const notes = document.notes;
  if (!notes || notes.length === 0) {
    return buffer;
  }

  for (const note of notes) {
    const noteStart = note.startSeconds;
    const noteEnd = note.endSeconds;
    // Export audio timeline: t_audio = (noteStart - startTime) / speed
    const strikeAudioTime = (noteStart - startTime) / speed;
    const releaseAudioTime = (noteEnd - startTime) / speed;
    const noteDuration = Math.max(0.05, releaseAudioTime - strikeAudioTime);

    if (strikeAudioTime >= durationSeconds || releaseAudioTime <= 0) {
      continue;
    }

    const startSample = Math.max(0, Math.round(strikeAudioTime * sampleRate));
    const endSample = Math.min(totalFrames, Math.round((strikeAudioTime + noteDuration + 0.5) * sampleRate));
    if (endSample <= startSample) continue;

    const pitch = note.pitch;
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    const vel = Math.max(1, Math.min(127, note.velocity)) / 127;
    const peakAmp = Math.pow(vel, 1.8) * 0.25 * volume;

    // Stereo panning based on pitch (A0 on left, C8 on right)
    const pan = Math.max(-0.8, Math.min(0.8, (pitch - 64) / 44));
    const leftGain = (1 - pan) * 0.5;
    const rightGain = (1 + pan) * 0.5;

    const decayTime = Math.min(noteDuration * 1.5, 3.0);
    const decayRate = 3.0 / decayTime;

    for (let s = startSample; s < endSample; s++) {
      const t = (s - startSample) / sampleRate;
      // Exponential decay envelope with attack
      const attack = t < 0.005 ? t / 0.005 : 1.0;
      const env = attack * Math.exp(-decayRate * t);
      // Harmonic partials (fundamental + 2nd + 3rd harmonic)
      const osc1 = Math.sin(2 * Math.PI * freq * t);
      const osc2 = 0.5 * Math.sin(2 * Math.PI * freq * 2 * t);
      const osc3 = 0.25 * Math.sin(2 * Math.PI * freq * 3 * t);
      const sample = (osc1 + osc2 + osc3) * env * peakAmp;

      left[s]! += sample * leftGain;
      right[s]! += sample * rightGain;
    }
  }

  // Peak normalization
  normalizeAudioBuffer(buffer);

  return buffer;
}

/**
 * Main entry point for offline audio rendering.
 */
export async function renderOfflineAudio(
  options: OfflineAudioRenderOptions,
): Promise<OfflineAudioRenderResult> {
  const sampleRate = options.sampleRate || AUDIO_RATE;
  let audioBuffer: AudioBufferLike;

  if (options.cancelSignal?.aborted) {
    throw new Error("Offline audio rendering aborted");
  }

  options.onProgress?.(0.1);

  if (options.audioRecording) {
    audioBuffer = sliceRecordingAudio(
      options.audioRecording,
      options.startTime,
      options.speed,
      options.durationSeconds,
      options.audioOffset ?? 0,
    );
  } else {
    audioBuffer = synthesizeNotesToBuffer(
      options.document,
      options.performancePlan,
      options.startTime,
      options.speed,
      options.durationSeconds,
      sampleRate,
      options.volume ?? 0.8,
    );
  }

  if (options.cancelSignal?.aborted) {
    throw new Error("Offline audio rendering aborted");
  }

  options.onProgress?.(0.8);

  const wavBytes = encodeAudioBufferToWav(audioBuffer);
  const wavBlob = audioBufferToWavBlob(audioBuffer);

  options.onProgress?.(1.0);

  return {
    audioBuffer,
    wavBlob,
    wavBytes,
  };
}
