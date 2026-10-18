import { expect, test } from "@playwright/test";
import { createSyntheticStereoSf2 } from "../../apps/client/src/audio/soundfont/testing/syntheticStereoSf2";
import { expectStudioCanvas, loadStudioSong, openStudioInspector, saveStudioProject } from "./studio-helpers";

test("production offline navigation restores a stereo Blob bank and both new SF2 workers", async ({ page, context }) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => {
    const state = window as Window & { __offlineSf2Starts?: number };
    state.__offlineSf2Starts = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: [number?, number?, number?]) {
      if (this.buffer?.sampleRate === 22_050) state.__offlineSf2Starts!++;
      return Reflect.apply(original, this, args);
    };
  });
  await loadStudioSong(page);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 45_000 }).toBe(true);
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await page.locator("#settings-sound-output").selectOption("soundfont");
  await page.locator('input[type="file"][accept=".sf2,.sf3"]').setInputFiles({
    name: "Offline Stereo.sf2", mimeType: "audio/sf2", buffer: Buffer.from(createSyntheticStereoSf2()),
  });
  await expect(page.getByText('SoundFont "Offline Stereo.sf2" loaded successfully.', {exact:true})).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openStudioInspector(page, "Audio");
  await expect(page.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 45_000 });
  await saveStudioProject(page);
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  try {
    await reopened.goto(process.env.PIANOMOTION_PREVIEW_BASE ?? "/");
    await expectStudioCanvas(reopened, 90_000);
    await openStudioInspector(reopened, "Audio");
    await expect(reopened.getByText("Active output: Local SoundFont", { exact: true })).toBeVisible({ timeout: 45_000 });
    await reopened.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => reopened.evaluate(() =>
      (window as Window & { __offlineSf2Starts?: number }).__offlineSf2Starts ?? 0,
    ), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await reopened.getByRole("button", { name: "Pause", exact: true }).click();
  } finally { await context.setOffline(false); }
});
