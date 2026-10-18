import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSyntheticStereoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticStereoSf2";
import { expectStudioCanvas, loadStudioSong, openStudioInspector, saveStudioProject } from "./studio-helpers";

async function observeBrowserMemory(browser: Browser) {
  const samples: Array<{ elapsedMs: number; privateBytes: number }> = [];
  const errors: string[] = [];
  const started = Date.now();
  const cdp = await browser.newBrowserCDPSession();
  let running = false;
  let pending: Promise<void> = Promise.resolve();
  const sample = async () => {
    if (running || process.platform !== "win32") return;
    running = true;
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const ids = processInfo.map(item => item.id).filter(id => Number.isSafeInteger(id) && id > 0);
      if (!ids.length) throw new Error("No browser process IDs available");
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id @(${ids.join(",")}) -ErrorAction SilentlyContinue | Measure-Object -Property PrivateMemorySize64 -Sum).Sum`,
      ], { windowsHide: true });
      const privateBytes = Number(stdout.trim());
      if (!Number.isFinite(privateBytes)) throw new Error("Invalid private-memory measurement");
      samples.push({ elapsedMs: Date.now() - started, privateBytes });
    } catch (error) { errors.push(String(error)); }
    finally { running = false; }
  };
  await sample();
  const interval = setInterval(() => { if (!running) pending = sample(); }, 2000);
  return async () => {
    clearInterval(interval);
    await pending;
    await sample();
    await cdp.detach();
    return { platform: process.platform, intervalMs: 2000, samples, errors,
      observedPeakPrivateBytes: Math.max(0, ...samples.map(item => item.privateBytes)) };
  };
}

/** A real sparse PCM file: only two small regions are referenced by this preset. */
async function createLargeBank(filePath: string, byteLength: number) {
  const bytes = Buffer.from(createSyntheticStereoSf2());
  const extra = byteLength - bytes.length;
  if (extra < 0 || extra % 2) throw new Error("Invalid large fixture length");
  let sampleEnd = 0;
  for (let offset = 12; offset + 12 < bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "LIST" && bytes.toString("ascii", offset + 8, offset + 12) === "sdta") {
      bytes.writeUInt32LE(length + extra, offset + 4);
      for (let child = offset + 12; child + 8 < offset + 8 + length;) {
        const size = bytes.readUInt32LE(child + 4);
        if (bytes.toString("ascii", child, child + 4) === "smpl") {
          bytes.writeUInt32LE(size + extra, child + 4);
          sampleEnd = child + 8 + size;
          break;
        }
        child += 8 + size + size % 2;
      }
      break;
    }
    offset += 8 + length + length % 2;
  }
  if (!sampleEnd) throw new Error("Fixture PCM chunk missing");
  bytes.writeUInt32LE(byteLength - 8, 4);
  const file = await open(filePath, "w");
  try {
    await file.write(bytes.subarray(0, sampleEnd), 0, sampleEnd, 0);
    await file.write(bytes.subarray(sampleEnd), 0, bytes.length - sampleEnd, sampleEnd + extra);
    await file.truncate(byteLength);
  } finally { await file.close(); }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

for (const mib of [128, 512, 1024]) {
  test(`real ${mib} MiB PCM bank hashes, commits, reopens and decodes only referenced stereo samples`, async ({ page, browser }, testInfo) => {
    await mkdir("test-results/soundfont-inputs", { recursive: true });
    const path = resolve(`test-results/soundfont-inputs/stereo-${mib}.sf2`);
    const byteLength = mib * 1024 * 1024;
    const expectedHash = await createLargeBank(path, byteLength);
    await page.goto("/?empty=true");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file"; input.id = "large-sf2-test-input";
      document.body.append(input);
    });
    await page.locator("#large-sf2-test-input").setInputFiles(path);
    const started = Date.now();
    const finishMemory = await observeBrowserMemory(browser);
    try {
    const stored = await page.evaluate(async () => {
      const file = (document.querySelector("#large-sf2-test-input") as HTMLInputElement).files![0]!;
      const { saveSoundFontAsset } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
      const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
      let largestSliceRead = 0;
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        largestSliceRead = Math.max(largestSliceRead, this.size);
        return original.call(this);
      };
      try {
        const sf = await parseSf2Async(file);
        const meta = await saveSoundFontAsset(file.name, file);
        return {
          id: meta.id, size: meta.byteLength, blobBacked: sf.sampleSource?.blob instanceof Blob,
          materializedPcm: sf.rawSampleData?.byteLength ?? 0, largestMainThreadRead: largestSliceRead,
        };
      } finally { Blob.prototype.arrayBuffer = original; }
    });
    expect(stored).toEqual({ id: expectedHash, size: byteLength, blobBacked: true, materializedPcm: 0, largestMainThreadRead: 0 });
    await page.reload();
    const restored = await page.evaluate(async (id) => {
      const { loadSoundFontAsset, listSoundFontAssets } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
      const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
      const { SoundFontSynth } = await import("/src/audio/soundfont/soundfontSynth.ts");
      const { getSoundFontSampleProviderStats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
      const asset = await loadSoundFontAsset(id);
      if (!asset) throw new Error("Committed SoundFont missing after reload");
      const sf = await parseSf2Async(asset.data);
      const context = new OfflineAudioContext(2, 22050, 22050);
      const synth = new SoundFontSynth({ audioContext: context });
      try {
        synth.loadSoundFont(sf);
        await synth.prepareNotes([{ pitch: 69, velocity: 100 }]);
        synth.noteOn(69, 100, "probe", 0);
        synth.noteOff("probe", undefined, 0.5);
        const audio = await context.startRendering();
        const rms = [0, 1].map(channel => Math.sqrt(audio.getChannelData(channel).reduce((sum, value) => sum + value * value, 0) / audio.length));
        return { id: asset.id, size: asset.data.size, blobs: asset.data instanceof Blob, listed: (await listSoundFontAssets()).length, rms, stats: getSoundFontSampleProviderStats() };
      } finally { synth.dispose(); }
    }, expectedHash);
    expect(restored.id).toBe(expectedHash);
    expect(restored.size).toBe(byteLength);
    expect(restored.blobs).toBe(true);
    expect(restored.listed).toBe(1);
    expect(restored.rms[0]).toBeGreaterThan(0.005);
    expect(restored.rms[1]).toBeGreaterThan(0.005);
    expect(restored.stats.decodedBytes + restored.stats.preparingBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(restored.stats.decodedBytes).toBeLessThan(1024 * 1024);
    await testInfo.attach("large-bank-result", { contentType: "application/json", body: JSON.stringify({ mib, elapsedMs: Date.now() - started, stored, restored }, null, 2) });
    } finally {
      const memory = await finishMemory();
      await testInfo.attach("browser-private-memory-samples", { contentType: "application/json", body: JSON.stringify(memory, null, 2) });
    }
  });
}

test("rejects more than 1 GiB before reading the source", async ({ page }) => {
  await mkdir("test-results/soundfont-inputs", { recursive: true });
  const path = resolve("test-results/soundfont-inputs/oversized.sf2");
  const file = await open(path, "w");
  try { await file.truncate(1024 * 1024 * 1024 + 1); } finally { await file.close(); }
  await page.goto("/?empty=true");
  await page.evaluate(() => {
    const input = document.createElement("input"); input.type = "file"; input.id = "oversized-sf2-test-input";
    document.body.append(input);
  });
  await page.locator("#oversized-sf2-test-input").setInputFiles(path);
  const result = await page.evaluate(async () => {
    const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
    const { saveSoundFontAsset } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
    const blob = (document.querySelector("#oversized-sf2-test-input") as HTMLInputElement).files![0]!;
    let reads = 0;
    Object.defineProperty(blob, "slice", { value: () => { reads++; throw new Error("Oversized source was read"); } });
    const errors: string[] = [];
    for (const operation of [() => parseSf2Async(blob), () => saveSoundFontAsset("too-large.sf2", blob)]) {
      try { await operation(); } catch (error) { errors.push(String(error)); }
    }
    return { reads, errors };
  });
  expect(result.reads).toBe(0);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.every(error => /1024 MiB|1 GiB|limit/i.test(error))).toBe(true);
});

test("user-provided Nice Steinway stereo bank activates, plays and restores without changing source bytes", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const path = process.env.PIANOMOTION_TEST_SF2 ?? resolve("soundfonts/Nice-Steinway-Lite-v3.0.sf2");
  test.skip(!existsSync(path), "User bank is private local material; set PIANOMOTION_TEST_SF2 for this manual-bank acceptance.");
  const sourceHash = createHash("sha256");
  for await (const chunk of createReadStream(path)) sourceHash.update(chunk);
  const expectedHash = sourceHash.digest("hex");
  await loadStudioSong(page);
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await page.locator("#settings-sound-output").selectOption("soundfont");
  await page.locator('input[type="file"][accept=".sf2,.sf3"]').setInputFiles(path);
  await expect(page.locator("#settings-soundfont-select")).toHaveValue(expectedHash, { timeout: 90_000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await saveStudioProject(page);
  await page.reload();
  await expectStudioCanvas(page, 90_000);
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 90_000 });
  const result = await page.evaluate(async id => {
    const { loadSoundFontAsset } = await import("/src/audio/soundfont/soundfontAssetStore.ts");
    const { parseSf2Async } = await import("/src/audio/soundfont/sf2Parser.ts");
    const { SoundFontSynth } = await import("/src/audio/soundfont/soundfontSynth.ts");
    const { getSoundFontSampleProviderStats } = await import("/src/audio/soundfont/soundfontSampleProvider.ts");
    const asset = await loadSoundFontAsset(id); if (!asset) throw new Error("User bank missing");
    const sf = await parseSf2Async(asset.data);
    if (sf.sampleSource) sf.sampleSource.assetId = id;
    const context = new OfflineAudioContext(2, 44_100, 44_100);
    const synth = new SoundFontSynth({ audioContext: context });
    try {
      synth.loadSoundFont(sf);
      await synth.prepareNotes([{ pitch: 69, velocity: 100 }]);
      synth.noteOn(69, 100, "real-bank-probe", 0);
      synth.noteOff("real-bank-probe", undefined, 0.7);
      const audio = await context.startRendering();
      const left = audio.getChannelData(0); const right = audio.getChannelData(1);
      let l2 = 0; let r2 = 0; let difference = 0;
      for (let i = 0; i < audio.length; i++) { l2 += left[i]! ** 2; r2 += right[i]! ** 2; difference += (left[i]! - right[i]!) ** 2; }
      return { id, byteLength: asset.data.size, leftSamples: sf.samples.filter(sample => sample.sampleType === 4).length,
        rightSamples: sf.samples.filter(sample => sample.sampleType === 2).length,
        rms: [Math.sqrt(l2 / audio.length), Math.sqrt(r2 / audio.length)], differenceRms: Math.sqrt(difference / audio.length), stats: getSoundFontSampleProviderStats() };
    } finally { synth.dispose(); }
  }, expectedHash);
  expect(result.leftSamples).toBeGreaterThan(0);
  expect(result.rightSamples).toBe(result.leftSamples);
  expect(result.rms[0]).toBeGreaterThan(0.001);
  expect(result.rms[1]).toBeGreaterThan(0.001);
  expect(result.differenceRms).toBeGreaterThan(0.001);
  expect(result.stats.decodedBytes + result.stats.preparingBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  expect(pageErrors).toEqual([]);
  await testInfo.attach("user-bank-result", { contentType: "application/json", body: JSON.stringify(result, null, 2) });
});
