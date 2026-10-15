import type { DecodedAudioRecording } from "./audioDecoder.ts";
import { createSignalsmithStretchNode } from "../signalsmithStretch.ts";

export interface OfflineTimeStretchOptions {
  recording: DecodedAudioRecording;
  startTimeSeconds: number;
  offsetSeconds: number;
  speed: number;
  durationSeconds: number;
  sampleRate: number;
  cancelSignal?: AbortSignal;
}

/** The live and offline paths use this same recording-position map. */
export function mapSongTimeToRecordingPosition(songTimeSeconds: number, offsetSeconds: number): number {
  return songTimeSeconds + offsetSeconds;
}

export function makeChannelsAtSampleRate(buffer: AudioBuffer, targetRate: number): Float32Array[] {
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const targetLength = Math.max(1, Math.round((buffer.length * targetRate) / buffer.sampleRate));
  const channels: Float32Array[] = [];

  for (let channel = 0; channel < channelCount; channel++) {
    const input = buffer.getChannelData(channel);
    if (targetRate === buffer.sampleRate) {
      channels.push(input.slice());
      continue;
    }

    const output = new Float32Array(targetLength);
    const ratio = buffer.sampleRate / targetRate;
    for (let i = 0; i < targetLength; i++) {
      const sourcePosition = i * ratio;
      const leftIndex = Math.min(input.length - 1, Math.floor(sourcePosition));
      const rightIndex = Math.min(input.length - 1, leftIndex + 1);
      const blend = sourcePosition - leftIndex;
      output[i] = input[leftIndex]! + (input[rightIndex]! - input[leftIndex]!) * blend;
    }
    channels.push(output);
  }

  if (channels.length === 1) channels.push(channels[0]!.slice());
  return channels;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Offline audio rendering aborted");
}

/**
 * Renders an external recording through the same Signalsmith WASM AudioWorklet
 * used by live playback. `schedule.output` is the target output clock; the
 * processor accounts for its own latency, so callers must not add it again.
 */
export async function renderRecordingWithSignalsmith(
  options: OfflineTimeStretchOptions,
): Promise<AudioBuffer> {
  const {
    recording,
    startTimeSeconds,
    offsetSeconds,
    speed,
    durationSeconds,
    sampleRate,
    cancelSignal,
  } = options;
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 2) {
    throw new RangeError("Playback speed must be between 0.25x and 2x.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Rendered audio duration must be positive.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("Rendered audio sample rate must be positive.");
  }
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("Pitch-preserving offline rendering requires OfflineAudioContext support.");
  }
  throwIfAborted(cancelSignal);

  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const context = new OfflineAudioContext(2, frameCount, sampleRate);
  const stretch = await createSignalsmithStretchNode(context);
  let connected = false;

  try {
    const inputChannels = makeChannelsAtSampleRate(recording.buffer, sampleRate);
    await stretch.dropBuffers();
    await stretch.addBuffers(inputChannels);
    stretch.connect(context.destination);
    connected = true;

    const recordingPosition = mapSongTimeToRecordingPosition(startTimeSeconds, offsetSeconds);
    if (recordingPosition < recording.durationSeconds) {
      const outputStart = Math.max(0, -recordingPosition / speed);
      const inputStart = Math.max(0, recordingPosition);
      await stretch.schedule({ output: 0, active: false });
      await stretch.schedule({
        output: outputStart,
        input: inputStart,
        rate: speed,
        semitones: 0,
        active: true,
      });
    } else {
      await stretch.schedule({ output: 0, active: false });
    }

    throwIfAborted(cancelSignal);
    const rendered = await context.startRendering();
    throwIfAborted(cancelSignal);
    return rendered;
  } finally {
    if (connected) {
      try {
        stretch.disconnect();
      } catch {
        // The OfflineAudioContext owns this graph until rendering completes.
      }
    }
  }
}
