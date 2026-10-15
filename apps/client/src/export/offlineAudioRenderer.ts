import type { PerformancePlan, SongDocument } from "@handthesia/contracts";
import type { DecodedAudioRecording } from "../audio";
import { derivePerformanceStateAt, extractPerformanceNotes } from "../audio/performancePlan.ts";
import { renderRecordingWithSignalsmith } from "../audio/recording/timeStretch.ts";
import { SoundFontSynth } from "../audio/soundfont/soundfontSynth.ts";
import type { Sf2SoundFont } from "../audio/soundfont/types.ts";
import { audioBufferToWavBlob, encodeAudioBufferToWav, type AudioBufferLike } from "./wavEncoder";

export const AUDIO_RATE = 44100;
export const NORMALIZE_PEAK = 0.89; // -1 dBFS
export const NORMALIZE_GAIN_MAX = 16.0;
const OFFLINE_SF2_ABORT_CHECK_SECONDS = 0.5;

export interface OfflineAudioRenderOptions {
  document: SongDocument;
  performancePlan?: PerformancePlan | null;
  soundFont?: Sf2SoundFont | null;
  audioRecording?: DecodedAudioRecording | null;
  audioOffset?: number; // seconds where MIDI 0 falls in recording
  speed: number;
  startTime: number; // leadInSeconds (e.g. -2.0)
  durationSeconds: number;
  sampleRate?: number;
  volume?: number;
  /** Skip WAV byte and Blob materialization when a caller consumes the AudioBuffer directly. */
  createWav?: boolean;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface OfflineAudioRenderResult {
  audioBuffer: AudioBufferLike;
  wavBlob?: Blob;
  wavBytes?: Uint8Array;
}

export interface OfflineAudioRenderResultWithWav extends OfflineAudioRenderResult {
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
  if (Math.abs(speed - 1) > 1e-9) {
    throw new Error("Direct recording slices support 1x only; use pitch-preserving offline rendering for other speeds.");
  }
  const rate = recording.buffer.sampleRate || recording.sampleRate || AUDIO_RATE;
  const totalFrames = Math.max(1, Math.round(durationSeconds * rate));
  const numChannels = Math.max(1, Math.min(2, recording.numberOfChannels || recording.buffer.numberOfChannels));
  const outBuffer = new MemoryAudioBuffer(numChannels, totalFrames, rate);

  const startFrame = Math.round((audioOffset + startTime) * rate);
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

interface SoundingNote {
  pitch: number;
  velocity: number;
  strikeAudioTime: number;
  damperAudioTime: number;
}

function applyMasterVolume(buffer: AudioBufferLike, volume: number): void {
  const gain = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) data[i] = data[i]! * gain;
  }
}

async function renderSoundFontPlan(options: OfflineAudioRenderOptions, sampleRate: number): Promise<AudioBufferLike> {
  const { soundFont, performancePlan, startTime, durationSeconds, speed } = options;
  if (!soundFont) return synthesizeNotesToBuffer(
    options.document,
    performancePlan,
    startTime,
    speed,
    durationSeconds,
    sampleRate,
    options.volume ?? 0.8,
  );
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("SoundFont video rendering requires OfflineAudioContext support.");
  }

  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const context = new OfflineAudioContext(2, frameCount, sampleRate);
  const synth = new SoundFontSynth({ audioContext: context, destinationNode: context.destination });
  synth.loadSoundFont(soundFont);
  const initialState = derivePerformanceStateAt(performancePlan, startTime);
  synth.restoreState(initialState);

  const endSongTime = startTime + durationSeconds * speed;
  const scheduledEvents = (performancePlan?.events ?? [])
    .filter((event) => event.timeSeconds > startTime && event.timeSeconds < endSongTime)
    .map((event) => ({ event, audioTime: (event.timeSeconds - startTime) / speed }))
    .filter(({ audioTime }) => audioTime >= 0 && audioTime < durationSeconds);
  let eventIndex = 0;
  const scheduleThrough = (horizon: number) => {
    while (eventIndex < scheduledEvents.length && scheduledEvents[eventIndex]!.audioTime <= horizon) {
      const { event, audioTime } = scheduledEvents[eventIndex]!;
      if (event.type === "press") synth.noteOn(event.pitch, event.velocity, event.noteId, audioTime);
      else if (event.type === "release") synth.noteOff(event.noteId, undefined, audioTime);
      else synth.pedalChange(event.controller, event.value, audioTime);
      eventIndex++;
    }
  };
  const lookahead = 0.1;
  let rendering: Promise<AudioBuffer> | null = null;
  let rendered: AudioBuffer;
  try {
    const queueNextSuspend = (): Promise<void> | null => {
      const earliestSuspend = context.currentTime + 0.001;
      const nextEventTime = scheduledEvents[eventIndex]?.audioTime ?? Number.POSITIVE_INFINITY;
      const nextEventBoundary = Number.isFinite(nextEventTime)
        ? Math.max(earliestSuspend, nextEventTime - 0.01)
        : Number.POSITIVE_INFINITY;
      const abortCheckBoundary = context.currentTime + OFFLINE_SF2_ABORT_CHECK_SECONDS;
      const suspendAt = Math.min(durationSeconds, nextEventBoundary, abortCheckBoundary);
      return suspendAt > context.currentTime && suspendAt < durationSeconds
        ? context.suspend(suspendAt)
        : null;
    };

    scheduleThrough(Math.min(durationSeconds, lookahead));
    // Queue bounded suspensions before starting an OfflineAudioContext. They
    // let us observe cancellation even when a plan has no events to schedule.
    let pendingSuspend = queueNextSuspend();
    rendering = context.startRendering();
    while (pendingSuspend) {
      await pendingSuspend;
      if (options.cancelSignal?.aborted) {
        throw new Error("Offline audio rendering aborted");
      }
      scheduleThrough(Math.min(durationSeconds, context.currentTime + lookahead));
      // Register the next suspension while the context is still suspended,
      // then resume so offline rendering advances to the requested boundary.
      pendingSuspend = queueNextSuspend();
      if (context.state === "suspended") await context.resume();
    }
    if (eventIndex < scheduledEvents.length) scheduleThrough(durationSeconds);
    if (context.state === "suspended") await context.resume();
    rendered = await rendering;
  } finally {
    try {
      synth.dispose();
    } finally {
      if (rendering) {
        // OfflineAudioContext has no close/cancel method. If an error or abort
        // interrupts scheduling, silence the synth, let the context settle,
        // and observe its promise instead of leaving rendering work detached.
        if (context.state === "suspended") {
          try {
            await context.resume();
          } catch {
            // Keep the original render or cancellation error.
          }
        }
        await rendering.catch(() => undefined);
      }
    }
  }
  normalizeAudioBuffer(rendered);
  applyMasterVolume(rendered, options.volume ?? 0.8);
  return rendered;
}

/**
 * Synthesizes note events into an AudioBuffer using PerformancePlan events as primary source.
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

  void document;
  const exportedSongEnd = startTime + durationSeconds * speed;
  const notesToRender: SoundingNote[] = extractPerformanceNotes(
    performancePlan,
    exportedSongEnd,
  ).map((note) => ({
    pitch: note.pitch,
    velocity: note.softPedalAtPress ? Math.max(1, Math.round(note.velocity * 0.75)) : note.velocity,
    strikeAudioTime: (note.pressTimeSeconds - startTime) / speed,
    damperAudioTime: (note.releaseTimeSeconds - startTime) / speed,
  }));

  if (notesToRender.length === 0) {
    return buffer;
  }

  for (const note of notesToRender) {
    const strikeAudioTime = note.strikeAudioTime;
    const damperAudioTime = note.damperAudioTime;
    const noteDuration = Math.max(0, damperAudioTime - strikeAudioTime);

    if (strikeAudioTime >= durationSeconds || damperAudioTime <= 0) {
      continue;
    }

    const startSample = Math.max(0, Math.ceil(strikeAudioTime * sampleRate));
    const endSample = Math.min(totalFrames, Math.ceil((strikeAudioTime + noteDuration + 0.6) * sampleRate));
    if (endSample <= startSample) continue;

    const pitch = note.pitch;
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    const vel = Math.max(1, Math.min(127, note.velocity)) / 127;
    const peakAmp = Math.pow(vel, 1.8) * 0.25;

    // Stereo panning based on pitch (A0 on left, C8 on right)
    const pan = Math.max(-0.8, Math.min(0.8, (pitch - 64) / 44));
    const leftGain = (1 - pan) * 0.5;
    const rightGain = (1 + pan) * 0.5;

    const decayTime = Math.min(noteDuration * 1.5, 3.5);
    const decayRate = 3.0 / decayTime;

    for (let s = startSample; s < endSample; s++) {
      const t = s / sampleRate - strikeAudioTime;
      const attack = t < 0.005 ? t / 0.005 : 1.0;
      let damping = 1.0;
      if (t > noteDuration) {
        damping = Math.exp(-20.0 * (t - noteDuration));
      }
      const env = attack * Math.exp(-decayRate * t) * damping;

      const osc1 = Math.sin(2 * Math.PI * freq * t);
      const osc2 = 0.5 * Math.sin(2 * Math.PI * freq * 2 * t);
      const osc3 = 0.25 * Math.sin(2 * Math.PI * freq * 3 * t);
      const sample = (osc1 + osc2 + osc3) * env * peakAmp;

      left[s]! += sample * leftGain;
      right[s]! += sample * rightGain;
    }
  }

  // Normalize first, then apply master volume so changing volume changes the WAV.
  normalizeAudioBuffer(buffer);
  applyMasterVolume(buffer, volume);

  return buffer;
}

/**
 * Main entry point for offline audio rendering.
 */
export function renderOfflineAudio(
  options: OfflineAudioRenderOptions & { createWav: false },
): Promise<OfflineAudioRenderResult>;
export function renderOfflineAudio(
  options: OfflineAudioRenderOptions & { createWav?: true },
): Promise<OfflineAudioRenderResultWithWav>;
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
    const rendered = await renderRecordingWithSignalsmith({
      recording: options.audioRecording,
      startTimeSeconds: options.startTime,
      offsetSeconds: options.audioOffset ?? 0,
      speed: options.speed,
      durationSeconds: options.durationSeconds,
      sampleRate,
      cancelSignal: options.cancelSignal,
    });
    audioBuffer = rendered;
    normalizeAudioBuffer(audioBuffer);
    applyMasterVolume(audioBuffer, options.volume ?? 0.8);
  } else {
    audioBuffer = await renderSoundFontPlan(options, sampleRate);
  }

  if (options.cancelSignal?.aborted) {
    throw new Error("Offline audio rendering aborted");
  }

  options.onProgress?.(0.8);

  const wavBytes = options.createWav === false ? undefined : encodeAudioBufferToWav(audioBuffer);
  const wavBlob = options.createWav === false ? undefined : audioBufferToWavBlob(audioBuffer);

  options.onProgress?.(1.0);

  const result: OfflineAudioRenderResult = {
    audioBuffer,
  };
  if (wavBytes && wavBlob) {
    return { ...result, wavBytes, wavBlob };
  }
  return result;
}
