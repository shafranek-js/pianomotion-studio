import { getMasterGain } from "../audioContext.ts";
import { SoundFontPerformanceOutput } from "../output/performanceOutput.ts";
import { SoundFontSynth } from "./soundfontSynth.ts";
import type { Sf2SoundFont } from "./types.ts";

export interface PrepareSoundFontPerformanceOutputOptions {
  audioContext: AudioContext;
  destinationNode?: AudioNode;
  presetIndex?: number;
  maxPolyphony?: number;
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
  if (!soundFont.rawSampleData?.length || !preset?.zones.some((zone) => soundFont.samples[zone.sampleIndex])) {
    throw new Error("This SoundFont has no playable sample zones.");
  }
  const synth = new SoundFontSynth({
    audioContext: options.audioContext,
    destinationNode: options.destinationNode ?? getMasterGain(),
    maxPolyphony: options.maxPolyphony,
  });
  try {
    synth.loadSoundFont(soundFont, options.presetIndex ?? 0);
    await Promise.resolve();
    return new SoundFontPerformanceOutput(synth);
  } catch (error) {
    synth.dispose();
    throw error;
  }
}
