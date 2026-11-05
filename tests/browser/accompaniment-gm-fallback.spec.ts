import { expect, test } from "@playwright/test";
import { createGmBank } from "./fixtures/syntheticBackingBank";

test("GM backing selects primary, built-in bank, then synth without extra sample reads", async ({ page }, testInfo) => {
  await page.goto("/?empty=true");
  const metrics = await page.evaluate(async bytes => {
    const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
    const { SoundFontAccompanimentSampler } = await import("/src/audio/soundfont/soundfontAccompaniment.ts");
    const { SoundFontSynth } = await import("/src/audio/soundfont/soundfontSynth.ts");
    const { AccompanimentSampler } = await import("/src/audio/accompaniment.ts");
    const { getSoundFontSampleProviderStats: stats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
    const primaryBytes = new Uint8Array(bytes), secondaryBytes = primaryBytes.slice();
    const label = new TextEncoder().encode("Synthetic GM backing");
    const labelOffset = secondaryBytes.findIndex((_, i) => label.every((value, j) => secondaryBytes[i + j] === value));
    if (labelOffset < 0) throw new Error("Fixture INFO label missing.");
    secondaryBytes[labelOffset] = "B".charCodeAt(0);
    const banks = await Promise.all([primaryBytes, secondaryBytes].map(async (data, index) => {
      const parsed = await parseSf2Async(new File([data], `fallback-${index}.sf2`));
      if (parsed.rawSampleData || !parsed.sampleSource) throw new Error("Expected real file-backed PCM banks.");
      parsed.sampleSource.assetId = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
        .map(value => value.toString(16).padStart(2, "0")).join("");
      return parsed;
    }));
    const primary = { ...banks[0]!, presets: banks[0]!.presets.filter(preset => preset.presetNumber !== 42) };
    // Secondary GM40 intentionally uses its own 220 Hz PCM, making precedence audible.
    const secondary = { ...banks[1]!, presets: banks[1]!.presets.map(preset => preset.presetNumber === 40
      ? { ...preset, zones: banks[1]!.presets.find(candidate => candidate.presetNumber === 0)!.zones.map(zone => ({ ...zone })) }
      : preset) };
    const plan = {
      tracks: [40, 42, 48].map(program => ({ id: `track-${program}`, trackIndex: program, name: `GM${program}`, program, noteCount: 1 })),
      notes: [40, 42, 48].map((program, index) => ({ noteId: `note-${program}`, trackId: `track-${program}`, program, pitch: 69, velocity: 110, startSeconds: index * 2, endSeconds: index * 2 + 1 })),
      events: [],
    };
    const sampleRate = 22_050, baseline = stats();
    let bounded = baseline, prepared = baseline;
    let builtinPrograms: number[] = [], synthPrograms: number[] = [];
    let synthReferenceError = Infinity;
    const probes: Array<{ mode: string; rms: number; frequency: number }> = [];
    for (const [program, mode] of [[40, "primary"], [42, "secondary"], [48, "synth"], [40, "mute-primary"], [42, "mute-secondary"], [48, "panic-synth"], [42, "panic-secondary"], [40, "mute-with-piano"]] as const) {
      const context = new OfflineAudioContext(2, sampleRate, sampleRate);
      const sampler = new SoundFontAccompanimentSampler({ soundFont: primary, fallbackSoundFont: secondary,
        audioContext: context as unknown as AudioContext, destinationNode: context.destination, initialVolume: 1 });
      const piano = mode === "mute-with-piano" ? new SoundFontSynth({ audioContext: context, destinationNode: context.destination }) : null;
      try {
        await sampler.prepareWindows(plan, [{ startSeconds: 0, endSeconds: 0.5 }]);
        if (probes.length === 0) bounded = stats();
        await sampler.prepareWindows(plan, [{ startSeconds: 0, endSeconds: 5 }]);
        if (probes.length === 0) prepared = stats();
        if (!sampler.isWindowsPrepared(plan, [{ startSeconds: 0, endSeconds: 5 }])) throw new Error("Chosen routes not prepared.");
        builtinPrograms = sampler.getBuiltinFallbackPrograms(plan);
        synthPrograms = sampler.getFallbackPrograms(plan);
        if (piano) {
          piano.loadSoundFont(primary);
          await piano.prepareNotes([{ pitch: 69, velocity: 110 }]);
          piano.noteOn(69, 110, "piano", 0.1); piano.noteOff("piano", 69, 0.7);
        }
        sampler.noteOn("probe", 69, 110, program, 0.1);
        sampler.noteOff("probe", 0.7);
        if (mode.startsWith("mute")) sampler.setVolume(0);
        if (mode.startsWith("panic")) sampler.allNotesOff();
        const data = (await context.startRendering()).getChannelData(0);
        if (mode === "synth") {
          const referenceContext = new OfflineAudioContext(2, sampleRate, sampleRate);
          const reference = new AccompanimentSampler({ audioContext: referenceContext as unknown as AudioContext,
            destinationNode: referenceContext.destination, initialVolume: 1 });
          try {
            reference.noteOn("reference", 69, 110, 48, 0.1); reference.noteOff("reference", 0.7);
            const expected = (await referenceContext.startRendering()).getChannelData(0);
            synthReferenceError = data.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - expected[index]!)), 0);
          } finally { reference.dispose(); }
        }
        const start = Math.round(0.2 * sampleRate), end = Math.round(0.6 * sampleRate);
        let energy = 0, crossings = 0;
        for (let frame = start; frame < end; frame++) {
          energy += data[frame]! ** 2;
          if (data[frame]! <= 0 && data[frame + 1]! > 0) crossings++;
        }
        probes.push({ mode, rms: Math.sqrt(energy / (end - start)), frequency: crossings / ((end - start) / sampleRate) });
      } finally { sampler.dispose(); piano?.dispose(); }
    }
    return { probes, baseline, bounded, prepared, cleanup: stats(), builtinPrograms, synthPrograms, synthReferenceError,
      distinctAssets: primary.sampleSource!.assetId !== secondary.sampleSource!.assetId,
      preservedSources: primary.sampleSource === banks[0]!.sampleSource && secondary.sampleSource === banks[1]!.sampleSource && primary.samples === banks[0]!.samples && secondary.samples === banks[1]!.samples };
  }, Array.from(createGmBank()));
  await testInfo.attach("three-tier-native-audio", { contentType: "application/json", body: JSON.stringify(metrics, null, 2) });
  expect(metrics.distinctAssets).toBe(true);
  expect(metrics.preservedSources).toBe(true);
  expect(metrics.builtinPrograms).toEqual([42]);
  expect(metrics.synthPrograms).toEqual([48]);
  for (const [index, frequency] of [[0, 660], [1, 990], [7, 220]]) {
    expect(metrics.probes[index!]!.rms).toBeGreaterThan(0.005);
    expect(metrics.probes[index!]!.frequency).toBeCloseTo(frequency!, -1);
  }
  expect(metrics.probes[2]!.rms).toBeGreaterThan(0.005);
  expect(metrics.synthReferenceError).toBeLessThan(1e-8);
  for (const index of [3, 4, 5, 6]) expect(metrics.probes[index]!.rms).toBeLessThan(1e-8);
  expect(metrics.bounded.reads - metrics.baseline.reads).toBe(1);
  expect(metrics.prepared.reads - metrics.baseline.reads).toBe(2);
  expect(metrics.prepared.cachedSamples - metrics.baseline.cachedSamples).toBe(2);
  expect(metrics.prepared.decodedBytes + metrics.prepared.preparingBytes).toBeLessThanOrEqual(metrics.prepared.budgetBytes);
  expect(metrics.cleanup.pinnedBytes).toBe(metrics.baseline.pinnedBytes);
  expect(metrics.cleanup.preparingBytes).toBe(metrics.baseline.preparingBytes);
});
