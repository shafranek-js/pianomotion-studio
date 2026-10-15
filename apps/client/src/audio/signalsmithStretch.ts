import SignalsmithStretch, { type StretchNode } from "./vendor/signalsmith-stretch-1.3.2/SignalsmithStretch.mjs";

export type { StretchNode };

export async function createSignalsmithStretchNode(
  audioContext: AudioContext | OfflineAudioContext,
): Promise<StretchNode> {
  if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined") {
    throw new Error("Pitch-preserving playback requires AudioWorklet support.");
  }

  return SignalsmithStretch(audioContext, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}
