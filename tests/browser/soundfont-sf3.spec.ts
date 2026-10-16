import { expect, test } from "@playwright/test";
import { loadStudioSong, openStudioInspector } from "./studio-helpers";
import { demuxMedia, installOpfsSavePicker, openVideoExportModal, inspectNativePlayback, readOpfsOutput } from "./media-export-helpers";

test("included SF3 piano plays without upload and exports audible WAV, MP4 and WebM", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installOpfsSavePicker(page);
  const studio = await loadStudioSong(page);
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await expect(page.locator("#settings-sound-output")).toHaveValue("soundfont");
  const selectedBank = page.locator("#settings-soundfont-select");
  await expect(selectedBank.locator("option:checked")).toContainText("MuseScore General v0.2 (included · default)");
  await expect(selectedBank.locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: MuseScore General v0.2", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", {name:"Play", exact:true}).click();
  await expect.poll(async () => Number(await page.locator("#player-seek-slider").inputValue()), { timeout: 30_000 }).toBeGreaterThan(0.25);
  await page.getByRole("button", {name:"Pause", exact:true}).click();

  const wav = await page.evaluate(async () => {
    const [{loadBuiltinSoundFont}, {parseSf2Async}, {renderOfflineAudio}, {getSoundFontSampleProviderStats}] = await Promise.all([
      import("/src/audio/soundfont/builtinSoundfont.ts"),
      import("/src/audio/soundfont/sf2Parser.ts"),
      import("/src/export/offlineAudioRenderer.ts"),
      import("/src/audio/soundfont/soundfontSampleProvider.ts"),
    ]);
    const asset = await loadBuiltinSoundFont();
    const sf = await parseSf2Async(asset.data);
    if (sf.sampleSource) sf.sampleSource.assetId = asset.id;
    const snapshot = window.__playerSnapshot!;
    const rendered = await renderOfflineAudio({
      document: snapshot.result.document!, performancePlan: snapshot.result.performancePlan!,
      soundFont: sf, speed: 1, volume: 0.8, startTime: -2,
      durationSeconds: snapshot.result.document!.durationSeconds + 3.5, sampleRate: 44_100,
    });
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await rendered.wavBlob!.arrayBuffer());
      const rms = Array.from({length:audio.numberOfChannels}, (_, channel) => {
        const samples = audio.getChannelData(channel);
        return Math.sqrt(samples.reduce((sum, x) => sum + x*x, 0) / samples.length);
      });
      return { header:sf.header, materializedWholeBank:Boolean(sf.rawSampleData), compressedSamples:sf.samples.filter(s => s.compressed).length,
        rms, duration:audio.duration, stats:getSoundFontSampleProviderStats() };
    } finally { await context.close(); }
  });
  expect(wav.header.versionMajor).toBe(3);
  expect(wav.compressedSamples).toBeGreaterThan(1000);
  expect(wav.materializedWholeBank).toBe(false);
  expect(Math.min(...wav.rms)).toBeGreaterThan(0.0001);
  expect(wav.stats.decodedBytes + wav.stats.preparingBytes).toBeLessThanOrEqual(wav.stats.budgetBytes);

  const firstPress = studio.result.performancePlan?.events.find(event => event.type === "press");
  if (!firstPress) throw new Error("Fixture has no press event");
  const mediaResults: unknown[] = [];
  let outputIndex = 0;
  for (const format of ["mp4", "webm"] as const) {
    await openVideoExportModal(page, "720p");
    await expect(page.locator(`#export-format-select option[value="${format}"]`)).toBeEnabled({timeout:30_000});
    await page.locator("#export-format-select").selectOption(format);
    await page.locator("#export-audio-source-select").selectOption("soundfont");
    await page.locator("#start-export-btn").click();
    await expect(page.locator("#export-status-text")).toContainText(/Export completed successfully|Export failed|Export canceled/, {timeout:240_000});
    await expect(page.locator("#export-status-text")).toContainText("Export completed successfully");
    const output = await readOpfsOutput(page, outputIndex++);
    const media = await demuxMedia(output.bytes);
    expect(media.audioPackets.length).toBeGreaterThan(10);
    const native = await inspectNativePlayback(page, output.name, format, output.bytes, firstPress.timeSeconds);
    expect(native.audioRms).toBeGreaterThan(0.00001);
    expect(native.width).toBe(1280);
    expect(native.height).toBe(720);
    expect(native.pixelDifferenceCount).toBeGreaterThan(0);
    mediaResults.push({format, duration:media.durationSeconds, nativeRms:native.audioRms});
    await page.locator("#export-close-btn").click();
  }
  expect(errors).toEqual([]);
  await testInfo.attach("sf3-default-wav-video", {contentType:"application/json", body:JSON.stringify({wav,mediaResults},null,2)});
});
