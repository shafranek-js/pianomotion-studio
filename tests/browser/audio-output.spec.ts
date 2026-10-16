import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createSyntheticMonoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticMonoSf2";
import { loadStudioSong, openStudioInspector, saveStudioProject } from "./studio-helpers";

test("uploads, parses, activates and reloads a real synthetic mono SF2 output", async ({ page }) => {
  test.setTimeout(180_000);
  const sampleBank = createSyntheticMonoSf2();
  const sampleBankBuffer = Buffer.from(sampleBank);
  const expectedHash = createHash("sha256").update(sampleBankBuffer).digest("hex");

  await page.addInitScript(() => {
    const state = window as typeof window & {
      __sf2AudioBufferStarts?: Array<{ sampleRate: number; duration: number; loop: boolean; when: number }>;
    };
    state.__sf2AudioBufferStarts = [];
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: [number?, number?, number?]) {
      if (this.buffer) {
        state.__sf2AudioBufferStarts!.push({
          sampleRate: this.buffer.sampleRate,
          duration: this.buffer.duration,
          loop: this.loop,
          when: args[0] ?? 0,
        });
      }
      return Reflect.apply(originalStart, this, args);
    };
  });

  await loadStudioSong(page);
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await page.locator("#settings-sound-output").selectOption("soundfont");

  const sf2Upload = page.locator('input[type="file"][accept=".sf2,.sf3"]');
  await sf2Upload.setInputFiles({ name: "Synthetic Mono.sf2", mimeType: "audio/sf2", buffer: sampleBankBuffer });
  await expect(page.locator("#settings-soundfont-select")).toHaveValue(expectedHash, { timeout: 45_000 });
  const selectedAssetId = await page.locator("#settings-soundfont-select").inputValue();
  expect(selectedAssetId).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Close" }).click();
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => page.evaluate(() =>
    (window as typeof window & { __sf2AudioBufferStarts?: Array<{ sampleRate: number; loop: boolean }> })
      .__sf2AudioBufferStarts?.filter(start => start.sampleRate === 22_050 && start.loop).length ?? 0,
  ), { timeout: 12_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await sf2Upload.setInputFiles({
    name: "invalid.sf2",
    mimeType: "audio/sf2",
    buffer: Buffer.from("not a RIFF SoundFont bank"),
  });
  await expect(page.getByRole("alert")).toContainText("Invalid SoundFont:");
  await expect(page.locator("#settings-soundfont-select")).toHaveValue(selectedAssetId);
  const beforeReload = await page.evaluate(async () => {
    const [{ initializeSettings, getSettings }, { listSoundFontAssets, loadSoundFontAsset, computeSha256Hex }] = await Promise.all([
      import("/src/settings/settingsStore.ts"),
      import("/src/audio/soundfont/soundfontAssetStore.ts"),
    ]);
    await initializeSettings();
    const id = getSettings().soundfontAssetId;
    const assets = await listSoundFontAssets();
    const asset = id ? await loadSoundFontAsset(id) : null;
    const digest = asset && await computeSha256Hex(asset.data);
    return {
      id,
      assetCount: assets.length,
      byteLength: asset?.data.size ?? 0,
      hash: digest ?? null,
    };
  });
  expect(beforeReload).toEqual({ id: selectedAssetId, assetCount: 1, byteLength: sampleBankBuffer.byteLength, hash: expectedHash });

  await page.getByRole("button", { name: "Close" }).click();
  await saveStudioProject(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "Open preferences", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({ timeout: 90_000 });
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 30_000 });

  const afterReload = await page.evaluate(async () => {
    const [{ initializeSettings, getSettings }, { loadSoundFontAsset }] = await Promise.all([
      import("/src/settings/settingsStore.ts"),
      import("/src/audio/soundfont/soundfontAssetStore.ts"),
    ]);
    await initializeSettings();
    const id = getSettings().soundfontAssetId;
    const asset = id ? await loadSoundFontAsset(id) : null;
    return { id, byteLength: asset?.data.size ?? 0 };
  });
  expect(afterReload).toEqual({ id: selectedAssetId, byteLength: sampleBankBuffer.byteLength });
});
