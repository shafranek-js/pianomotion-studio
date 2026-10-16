import { getMasterGain } from "../audioContext.ts";
import { SoundFontPerformanceOutput } from "../output/performanceOutput.ts";
import { SoundFontSynth } from "./soundfontSynth.ts";
import type { Sf2SoundFont } from "./types.ts";
import type { PerformancePlan } from "@handthesia/contracts";

export interface PrepareSoundFontPerformanceOutputOptions {
  audioContext: AudioContext;
  destinationNode?: AudioNode;
  presetIndex?: number;
  maxPolyphony?: number;
  plan?: PerformancePlan;
  startSeconds?: number;
  initialNotes?: readonly { pitch: number; velocity: number }[];
  signal?: AbortSignal;
}

/**
 * Builds an isolated SoundFont output candidate. Callers can leave the currently
 * active output untouched until this promise resolves, then hand the candidate
 * to Transport.setOutput().
 */
export async function prepareSoundFontPerformanceOutput(
  soundFont: Sf2SoundFont,
  options: PrepareSoundFontPerformanceOutputOptions,
): Promise<SoundFontPerformanceOutput> {
  const preset = soundFont.presets[options.presetIndex ?? 0] ?? soundFont.presets[0];
  if ((!soundFont.sampleSource && !soundFont.rawSampleData?.length) || !preset?.zones.some((zone) => soundFont.samples[zone.sampleIndex])) {
    throw new Error("This SoundFont has no playable sample zones.");
  }
  if (options.signal?.aborted) throw new DOMException("SoundFont output preparation was cancelled.", "AbortError");
  const synth = new SoundFontSynth({
    audioContext: options.audioContext,
    destinationNode: options.destinationNode ?? getMasterGain(),
    maxPolyphony: options.maxPolyphony,
  });
  try {
    synth.loadSoundFont(soundFont, options.presetIndex ?? 0);
    const output = new SoundFontPerformanceOutput(synth);
    if (options.plan) {
      const startSeconds = Math.max(0, options.startSeconds ?? 0);
      await output.prepareWindow(options.plan, startSeconds, startSeconds + 4, options.signal);
    } else if (options.initialNotes) {
      await synth.prepareNotes(options.initialNotes, options.signal);
    }
    if (options.signal?.aborted) throw new DOMException("SoundFont output preparation was cancelled.", "AbortError");
    return output;
  } catch (error) {
    synth.dispose();
    throw error;
  }
}
