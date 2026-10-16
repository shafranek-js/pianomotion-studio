import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { loadStudioSong, openStudioInspector, saveStudioProject } from "./studio-helpers";

const bankDirectory = resolve(process.env.PIANOMOTION_TEST_SOUNDFONT_DIR ?? "soundfonts");
const bankPaths = existsSync(bankDirectory)
  ? readdirSync(bankDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sf2"))
      .map((entry) => resolve(bankDirectory, entry.name))
      .sort((a, b) => a.localeCompare(b))
  : [];
const sf3Paths = existsSync(bankDirectory)
  ? readdirSync(bankDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sf3"))
      .map((entry) => resolve(bankDirectory, entry.name))
      .sort((a, b) => a.localeCompare(b))
  : [];

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

// A proven malformed, actively referenced pair in this exact read-only fixture.
const invalidSf2Paths = bankPaths.filter((path) => basename(path) === "Fazioli-F308-v2.6.sf2");

for (const path of bankPaths.filter((path) => !invalidSf2Paths.includes(path))) {
  const bankName = basename(path);

  test(`user bank ${bankName} activates, plays, restores and renders low/mid/high probes`, async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const sourceHashBefore = await hashFile(path);

    await loadStudioSong(page);
    await page.getByRole("button", { name: "Open preferences", exact: true }).click();
    await page.locator("#settings-sound-output").selectOption("soundfont");
    await page.locator('input[type="file"][accept=".sf2"]').setInputFiles(path);
    const importResult = await page.waitForFunction((id) => {
      const select = document.querySelector<HTMLSelectElement>("#settings-soundfont-select");
      if (select?.value === id) return "imported";
      const alertText = [...document.querySelectorAll<HTMLElement>('[role="alert"]')]
        .map((element) => element.innerText)
        .join("\n");
      if (/Invalid SoundFont|unsupported|could not be parsed as an SF2/i.test(alertText)) return `rejected: ${alertText}`;
      return false;
    }, sourceHashBefore, { timeout: 120_000 }).then((handle) => handle.jsonValue() as Promise<string>);
    expect(importResult, `SoundFont upload result: ${importResult}`).toBe("imported");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await openStudioInspector(page, "Audio");
    await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Number(await page.locator("#player-seek-slider").inputValue()), { timeout: 30_000 })
      .toBeGreaterThan(0.25);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await saveStudioProject(page);

    await page.reload();
    await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Open preferences", exact: true }).click();
    await expect(page.locator("#settings-soundfont-select")).toHaveValue(sourceHashBefore, { timeout: 90_000 });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openStudioInspector(page, "Audio");
    await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 120_000 });

    const render = await page.evaluate(async (id) => {
      const { loadSoundFontAsset } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
      const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
      const { SoundFontSynth } = await import("/src/audio/soundfont/soundfontSynth.ts");
      const { getSoundFontSampleProviderStats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
      const asset = await loadSoundFontAsset(id);
      if (!asset) throw new Error("Stored user SoundFont is missing after reload.");
      if (asset.id !== id) throw new Error("Stored SoundFont identity changed after reload.");
      const sf = await parseSf2Async(asset.data);
      if (sf.sampleSource) sf.sampleSource.assetId = id;
      const baselineStats = getSoundFontSampleProviderStats();

      const pitches = [36, 60, 84];
      const velocities = [48, 80, 112];
      const probes = pitches.flatMap((pitch) => velocities.map((velocity) => ({ pitch, velocity })));
      const sampleRate = 22_050;
      const context = new OfflineAudioContext(2, sampleRate * 7, sampleRate);
      const synth = new SoundFontSynth({ audioContext: context });
      type RenderMetrics = {
        id: string;
        byteLength: number;
        header: { name: string; versionMajor: number; versionMinor: number; soundEngine?: string };
        preset: { name: string; bankNumber: number; presetNumber: number } | null;
        sampleCount: number;
        monoSampleCount: number;
        leftSampleCount: number;
        rightSampleCount: number;
        usesStereoPair: boolean;
        measuredProbes: Array<{ pitch: number; velocity: number; noteId: string; channelRms: number[] }>;
        pedalProbeRms: number[];
        peak: number;
        nonFiniteSamples: number;
        differenceRms: number;
        heldState: { activeVoices: number; keyDownNotes: Array<{ noteId: string; pitch: number }>; sustain: boolean };
        releasedState: { activeVoices: number; keyDownNotes: Array<{ noteId: string; pitch: number }>; sustain: boolean };
        preparedStats: ReturnType<typeof getSoundFontSampleProviderStats>;
        baselineStats: ReturnType<typeof getSoundFontSampleProviderStats>;
        voicesAfterRender: number;
      };
      let metrics: RenderMetrics | undefined;

      try {
        synth.loadSoundFont(sf);
        await synth.prepareNotes(probes);
        const preparedStats = getSoundFontSampleProviderStats();
        if (preparedStats.decodedBytes + preparedStats.preparingBytes > preparedStats.budgetBytes) {
          throw new Error("Prepared samples exceeded the shared cache budget.");
        }

        const events = probes.map((probe, index) => {
          const start = 0.1 + index * 0.45;
          const noteId = `bank-probe-${index}`;
          synth.noteOn(probe.pitch, probe.velocity, noteId, start);
          synth.noteOff(noteId, undefined, start + 0.34);
          return { ...probe, noteId, start, end: start + 0.34 };
        });

        // Keep one released note alive under sustain, then release the pedal on schedule.
        synth.pedalChange(64, 127, 4.35);
        synth.noteOn(60, 80, "bank-pedal-probe", 4.4);
        synth.noteOff("bank-pedal-probe", undefined, 4.6);
        synth.pedalChange(64, 0, 5.2);

        const atSustainedNote = context.suspend(4.9);
        const afterPedalRelease = context.suspend(5.5);
        const rendering = context.startRendering();
        await atSustainedNote;
        const heldState = {
          activeVoices: synth.getActiveVoiceCount(),
          keyDownNotes: synth.getKeyDownNotes(),
          sustain: synth.getPedalState().sustain,
        };
        await context.resume();
        await afterPedalRelease;
        const releasedState = {
          activeVoices: synth.getActiveVoiceCount(),
          keyDownNotes: synth.getKeyDownNotes(),
          sustain: synth.getPedalState().sustain,
        };
        await context.resume();
        const audio = await rendering;

        const channels = [audio.getChannelData(0), audio.getChannelData(1)];
        const measuredProbes = events.map((event) => {
          const start = Math.floor((event.start + 0.04) * sampleRate);
          const end = Math.floor((event.start + 0.28) * sampleRate);
          const channelRms = channels.map((channel) => {
            let sum = 0;
            for (let frame = start; frame < end; frame++) sum += channel[frame]! ** 2;
            return Math.sqrt(sum / Math.max(1, end - start));
          });
          return { pitch: event.pitch, velocity: event.velocity, noteId: event.noteId, channelRms };
        });
        const pedalStart = Math.floor(4.45 * sampleRate);
        const pedalEnd = Math.floor(4.58 * sampleRate);
        const pedalProbeRms = channels.map((channel) => {
          let sum = 0;
          for (let frame = pedalStart; frame < pedalEnd; frame++) sum += channel[frame]! ** 2;
          return Math.sqrt(sum / Math.max(1, pedalEnd - pedalStart));
        });

        let peak = 0;
        let nonFiniteSamples = 0;
        let stereoDifferenceSum = 0;
        for (let frame = 0; frame < audio.length; frame++) {
          const left = channels[0]![frame]!;
          const right = channels[1]![frame]!;
          if (!Number.isFinite(left) || !Number.isFinite(right)) nonFiniteSamples++;
          peak = Math.max(peak, Math.abs(left), Math.abs(right));
          stereoDifferenceSum += (left - right) ** 2;
        }

        const preset = sf.presets[0];
        const usesStereoPair = Boolean(preset?.zones.some((zone) => {
          if (!probes.some((probe) => probe.pitch >= zone.keyRange[0] && probe.pitch <= zone.keyRange[1] &&
            probe.velocity >= zone.velRange[0] && probe.velocity <= zone.velRange[1])) return false;
          const sampleType = sf.samples[zone.sampleIndex]?.sampleType;
          return sampleType !== undefined && ((sampleType & 0x7fff) === 2 || (sampleType & 0x7fff) === 4);
        }));

        metrics = {
          id: asset.id,
          byteLength: asset.byteLength,
          header: sf.header,
          preset: preset ? { name: preset.name, bankNumber: preset.bankNumber, presetNumber: preset.presetNumber } : null,
          sampleCount: sf.samples.length,
          monoSampleCount: sf.samples.filter((sample) => (sample.sampleType & 0x7fff) === 1).length,
          leftSampleCount: sf.samples.filter((sample) => (sample.sampleType & 0x7fff) === 4).length,
          rightSampleCount: sf.samples.filter((sample) => (sample.sampleType & 0x7fff) === 2).length,
          usesStereoPair,
          measuredProbes,
          pedalProbeRms,
          peak,
          nonFiniteSamples,
          differenceRms: Math.sqrt(stereoDifferenceSum / audio.length),
          heldState,
          releasedState,
          preparedStats,
          baselineStats,
          voicesAfterRender: synth.getActiveVoiceCount(),
        };
      } finally {
        synth.dispose();
      }
      if (!metrics) throw new Error("Offline SoundFont rendering produced no metrics.");
      return { ...metrics, cleanupStats: getSoundFontSampleProviderStats() };
    }, sourceHashBefore);

    const sourceHashAfter = await hashFile(path);
    await testInfo.attach("user-bank-result", {
      contentType: "application/json",
      body: JSON.stringify({ file: bankName, sourceHashBefore, sourceHashAfter, render }, null, 2),
    });
    expect(render.id).toBe(sourceHashBefore);
    expect(render.byteLength).toBeGreaterThan(0);
    expect(render.preset).not.toBeNull();
    expect(render.measuredProbes).toHaveLength(9);
    for (const probe of render.measuredProbes) {
      expect(probe.channelRms[0]).toBeGreaterThan(0.00001);
      expect(probe.channelRms[1]).toBeGreaterThan(0.00001);
    }
    expect(render.pedalProbeRms[0]).toBeGreaterThan(0.00001);
    expect(render.pedalProbeRms[1]).toBeGreaterThan(0.00001);
    expect(render.nonFiniteSamples).toBe(0);
    expect(render.peak).toBeLessThanOrEqual(1.000001);
    if (render.usesStereoPair) expect(render.differenceRms).toBeGreaterThan(0.00001);
    expect(render.heldState.activeVoices).toBeGreaterThan(0);
    expect(render.heldState.keyDownNotes).toEqual([]);
    expect(render.heldState.sustain).toBe(true);
    expect(render.releasedState.keyDownNotes).toEqual([]);
    expect(render.releasedState.sustain).toBe(false);
    expect(render.voicesAfterRender).toBe(0);
    expect(render.cleanupStats.preparingBytes).toBe(0);
    expect(render.cleanupStats.preparingSamples).toBe(0);
    expect(render.cleanupStats.preparingBytes).toBe(render.baselineStats.preparingBytes);
    expect(render.cleanupStats.preparingSamples).toBe(render.baselineStats.preparingSamples);
    expect(render.cleanupStats.pinnedBytes).toBe(render.baselineStats.pinnedBytes);
    expect(render.cleanupStats.decodedBytes).toBeLessThanOrEqual(render.cleanupStats.budgetBytes);
    expect(pageErrors).toEqual([]);

    expect(sourceHashAfter).toBe(sourceHashBefore);
  });
}

if (bankPaths.length === 0) {
  test("user SoundFont banks are unavailable in this checkout", async () => {
    test.skip(true, `No .sf2 files found in ${bankDirectory}; private local banks are skipped in CI.`);
  });
}

for (const path of [...sf3Paths, ...invalidSf2Paths]) {
  const bankName = basename(path);
  const isSf3 = path.toLowerCase().endsWith(".sf3");

  test(`${isSf3 ? "Unsupported SF3" : "Malformed stereo SF2"} ${bankName} is rejected clearly while the current output remains active`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const sourceHashBefore = await hashFile(path);

    if (!isSf3) expect(sourceHashBefore).toBe("bba52410c7ad5736aab67c3b27889819bc9b1c9995e0a22b68bec1071289984b");

    await loadStudioSong(page);
    await openStudioInspector(page, "Audio");
    await expect(page.getByText("Active output: Built-in synthesizer", { exact: true })).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "Open preferences", exact: true }).click();
    await page.locator("#settings-sound-output").selectOption("soundfont");
    await page.locator('input[type="file"][accept=".sf2"]').setInputFiles(path);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(isSf3 ? /SF3.*not supported/i : /C214 XY-R PD f D#6-L.*link reciprocally/i, { timeout: 60_000 });

    const imports = await page.evaluate(async () => {
      const { listSoundFontAssets } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
      return listSoundFontAssets();
    });
    expect(imports.some((asset) => asset.name === bankName)).toBe(false);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openStudioInspector(page, "Audio");
    await expect(page.getByText("Active output: Built-in synthesizer", { exact: true })).toBeVisible({ timeout: 45_000 });
    expect(pageErrors).toEqual([]);

    const sourceHashAfter = await hashFile(path);
    expect(sourceHashAfter).toBe(sourceHashBefore);
    await testInfo.attach("rejected-user-bank-result", {
      contentType: "application/json",
      body: JSON.stringify({ file: bankName, sourceHashBefore, sourceHashAfter, installedAssetCount: imports.length,
        reason: isSf3 ? "unsupported SF3" : "sample 287 links to mono sample 288 without a reciprocal link",
        activeOutputAfterReject: "Built-in synthesizer" }, null, 2),
    });
  });
}

if (sf3Paths.length === 0) {
  test("user SF3 bank is unavailable in this checkout", async () => {
    test.skip(true, `No .sf3 files found in ${bankDirectory}; private local banks are skipped in CI.`);
  });
}
