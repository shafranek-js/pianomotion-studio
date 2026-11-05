import { expect, test } from "@playwright/test";
import { createGmBank } from "./fixtures/syntheticBackingBank";


test("backing renders selected-bank GM programs, prepares bounded samples, and cancels future voices", async ({ page }, testInfo) => {
  await page.goto("/");
  const metrics = await page.evaluate(async (bytes) => {
    const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
    const { SoundFontAccompanimentSampler } = await import("/src/audio/soundfont/soundfontAccompaniment.ts");
    const { SoundFontSynth } = await import("/src/audio/soundfont/soundfontSynth.ts");
    const { getSoundFontSampleProviderStats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
    const soundFont = await parseSf2Async(new File([new Uint8Array(bytes)], "backing-gm.sf2"));
    if (soundFont.rawSampleData || !soundFont.sampleSource) throw new Error("Fixture must remain file-backed.");
    const baseline = getSoundFontSampleProviderStats();
    const sampleRate = 22_050;
    const probes: Array<{ program: number; mode: string; rms: number; frequency: number }> = [];
    const plan = {
      tracks: [40, 42].map(program => ({ id: `track-${program}`, trackIndex: program, name: `GM ${program}`, program, noteCount: 1 })),
      notes: [40, 42].map((program, index) => ({ noteId: `note-${program}`, trackId: `track-${program}`, program, pitch: 69, velocity: 110, startSeconds: index * 10, endSeconds: index * 10 + 1 })),
      events: [],
    };
    let prepared = baseline;
    let bounded = baseline;
    let fallbackPrograms: number[] = [];
    for (const [program, mode] of [[40, "enabled"], [42, "enabled"], [40, "zero"], [42, "panic"], [48, "fallback"], [40, "zero-with-piano"]] as const) {
      const context = new OfflineAudioContext(2, sampleRate, sampleRate);
      const sampler = new SoundFontAccompanimentSampler({ soundFont, audioContext: context as unknown as AudioContext, destinationNode: context.destination, initialVolume: mode.startsWith("zero") ? 0 : 1 });
      const piano = mode === "zero-with-piano" ? new SoundFontSynth({ audioContext: context, destinationNode: context.destination }) : null;
      try {
        if (piano) { piano.loadSoundFont(soundFont); await piano.prepareNotes([{ pitch: 69, velocity: 110 }]); piano.noteOn(69, 110, "piano", 0.1); piano.noteOff("piano", 69, 0.7); }
        await sampler.prepareWindows(plan, [{ startSeconds: 0, endSeconds: 0.5 }]);
        if (probes.length === 0) bounded = getSoundFontSampleProviderStats();
        await sampler.prepareWindows(plan, [{ startSeconds: 0, endSeconds: 11 }]);
        if (probes.length === 0) prepared = getSoundFontSampleProviderStats();
        if (!sampler.isWindowsPrepared(plan, [{ startSeconds: 0, endSeconds: 11 }])) throw new Error("Preparation not visible synchronously.");
        fallbackPrograms = sampler.getFallbackPrograms({ ...plan, tracks: [...plan.tracks, { id: "missing", trackIndex: 48, name: "Missing", program: 48, noteCount: 1 }], notes: [...plan.notes, { ...plan.notes[0]!, program: 48 }] });
        sampler.noteOn("probe", 69, 110, program, 0.1);
        sampler.noteOff("probe", 0.7);
        if (mode === "panic") sampler.allNotesOff();
        const buffer = await context.startRendering();
        const data = buffer.getChannelData(0);
        const start = Math.round(0.2 * sampleRate), end = Math.round(0.6 * sampleRate);
        let energy = 0, crossings = 0;
        for (let frame = start; frame < end; frame++) {
          energy += data[frame]! ** 2;
          if (data[frame]! <= 0 && data[frame + 1]! > 0) crossings++;
        }
        probes.push({ program, mode, rms: Math.sqrt(energy / (end - start)), frequency: crossings / ((end - start) / sampleRate) });
      } finally { sampler.dispose(); piano?.dispose(); }
    }
    return { probes, baseline, bounded, prepared, fallbackPrograms, cleanup: getSoundFontSampleProviderStats(), fileBacked: Boolean(soundFont.sampleSource), rawPcm: Boolean(soundFont.rawSampleData) };
  }, Array.from(createGmBank()));
  await testInfo.attach("backing-native-audio-metrics", { contentType: "application/json", body: JSON.stringify(metrics, null, 2) });
  expect(metrics.fileBacked).toBe(true);
  expect(metrics.rawPcm).toBe(false);
  for (const [index, frequency] of [[0, 660], [1, 990]]) {
    expect(metrics.probes[index!]!.rms).toBeGreaterThan(0.005);
    expect(metrics.probes[index!]!.frequency).toBeCloseTo(frequency!, -1);
  }
  expect(metrics.probes[2]!.rms).toBeLessThan(1e-8);
  expect(metrics.probes[3]!.rms).toBeLessThan(1e-8);
  expect(metrics.probes[4]!.rms).toBeGreaterThan(0.005);
  expect(metrics.probes[5]!.rms).toBeGreaterThan(0.005);
  expect(metrics.probes[5]!.frequency).toBeCloseTo(220, -1);
  expect(metrics.fallbackPrograms).toEqual([48]);
  expect(metrics.bounded.reads - metrics.baseline.reads).toBe(1);
  expect(metrics.bounded.cachedSamples - metrics.baseline.cachedSamples).toBe(1);
  expect(metrics.prepared.reads - metrics.baseline.reads).toBe(2);
  expect(metrics.prepared.cachedSamples - metrics.baseline.cachedSamples).toBe(2);
  expect(metrics.prepared.decodedBytes + metrics.prepared.preparingBytes).toBeLessThanOrEqual(metrics.prepared.budgetBytes);
  expect(metrics.cleanup.pinnedBytes).toBe(metrics.baseline.pinnedBytes);
  expect(metrics.cleanup.preparingBytes).toBe(metrics.baseline.preparingBytes);
});

test("bundled MuseScore SF3 prepares and renders real bank-zero violin and cello presets", async ({ page }, testInfo) => {
  await page.goto("/");
  const metrics = await page.evaluate(async () => {
    const { BUILTIN_SOUNDFONT_ASSET_PATH } = await import("/src/audio/soundfont/builtinSoundfont.ts");
    const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
    const { SoundFontAccompanimentSampler } = await import("/src/audio/soundfont/soundfontAccompaniment.ts");
    const { getSoundFontSampleProviderStats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
    const response = await fetch(`/${BUILTIN_SOUNDFONT_ASSET_PATH}`);
    if (!response.ok) throw new Error(`Bundled bank unavailable: ${response.status}`);
    const soundFont = await parseSf2Async(await response.blob());
    const sampleRate = 22_050;
    const baseline = getSoundFontSampleProviderStats();
    const probes: Array<{ program: number; preset: string | undefined; rms: number; heldRms: number }> = [];
    const fallbackPrograms: number[] = [];
    for (const program of [40, 42]) {
      // Separate contexts ensure a violin release tail cannot satisfy the cello probe.
      const context = new OfflineAudioContext(2, sampleRate * 2, sampleRate);
      const sampler = new SoundFontAccompanimentSampler({ soundFont, audioContext: context as unknown as AudioContext, destinationNode: context.destination, initialVolume: 1 });
      const note = { noteId: `real-${program}`, trackId: `track-${program}`, program, pitch: program === 40 ? 69 : 48, velocity: 100, startSeconds: 0.1, endSeconds: 1.5 };
      const plan = { tracks: [{ id: note.trackId, trackIndex: 0, name: `GM${program}`, program, noteCount: 1 }], notes: [note], events: [] };
      try {
        await sampler.prepareWindows(plan, [{ startSeconds: 0, endSeconds: 2 }]);
        fallbackPrograms.push(...sampler.getFallbackPrograms(plan));
        sampler.noteOn(note.noteId, note.pitch, note.velocity, note.program, note.startSeconds);
        sampler.noteOff(note.noteId, note.endSeconds);
        const rendered = await context.startRendering();
        const data = rendered.getChannelData(0);
        let energy = 0;
        const start = Math.round(0.2 * sampleRate), end = Math.round(0.5 * sampleRate);
        for (let frame = start; frame < end; frame++) energy += data[frame]! ** 2;
        let heldEnergy = 0;
        const heldStart = Math.round(0.8 * sampleRate), heldEnd = Math.round(1.2 * sampleRate);
        for (let frame = heldStart; frame < heldEnd; frame++) heldEnergy += data[frame]! ** 2;
        probes.push({ program, preset: soundFont.presets.find(preset => preset.bankNumber === 0 && preset.presetNumber === program)?.name, rms: Math.sqrt(energy / (end - start)), heldRms: Math.sqrt(heldEnergy / (heldEnd - heldStart)) });
      } finally { sampler.dispose(); }
    }
    return { probes, fallbackPrograms, baseline, prepared: getSoundFontSampleProviderStats(), sampleCount: soundFont.samples.length };
  });
  await testInfo.attach("bundled-backing-sf3-metrics", { contentType: "application/json", body: JSON.stringify(metrics, null, 2) });
  expect(metrics.fallbackPrograms).toEqual([]);
  expect(metrics.probes[0]!.preset).toMatch(/violin/i);
  expect(metrics.probes[1]!.preset).toMatch(/cello/i);
  for (const probe of metrics.probes) {
    expect(probe.rms).toBeGreaterThan(0.00001);
    expect(probe.heldRms).toBeGreaterThan(0.00001);
  }
  expect(metrics.prepared.reads - metrics.baseline.reads).toBeGreaterThan(0);
  expect(metrics.prepared.reads - metrics.baseline.reads).toBeLessThan(30);
  expect(metrics.prepared.decodedBytes + metrics.prepared.preparingBytes).toBeLessThanOrEqual(metrics.prepared.budgetBytes);
});
