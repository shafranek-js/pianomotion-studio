import { expect, test } from "@playwright/test";
import { loadStudioSong } from "./studio-helpers";
import { installOpfsSavePicker, openVideoExportModal } from "./media-export-helpers";

test("video export preflight shows format support for the selected size, frame rate, and audio", async ({ page }) => {
  await installOpfsSavePicker(page);
  await loadStudioSong(page);
  await openVideoExportModal(page);

  await expect(page.locator("#export-resolution-select")).toHaveValue("1080p");
  await expect(page.locator("#export-fps-select")).toHaveValue("30");
  await expect(page.locator("#export-audio-checkbox")).toBeChecked();
  await expect(page.locator("#export-format-capability")).toContainText("1920 × 1080 at 30 FPS");

  const mp4Supported = !(await page.locator('#export-format-select option[value="mp4"]').isDisabled());
  const webmSupported = !(await page.locator('#export-format-select option[value="webm"]').isDisabled());
  expect(mp4Supported || webmSupported).toBe(true);
  await expect(page.locator("#export-format-select")).toHaveValue(mp4Supported ? "mp4" : "webm");
  await expect(page.locator("#start-export-btn")).toBeEnabled();

  await page.locator("#export-fps-select").selectOption("60");
  await expect(page.locator("#export-format-capability")).toContainText("1920 × 1080 at 60 FPS", { timeout: 90_000 });
  const supportedAtSixty = await page.locator("#export-format-select option:not([disabled])").evaluateAll((items) =>
    items.map((item) => (item as HTMLOptionElement).value),
  );
  if (supportedAtSixty.length > 0) await expect(page.locator("#start-export-btn")).toBeEnabled();
  else await expect(page.locator("#start-export-btn")).toBeDisabled();
});

test("closing the video dialog with Escape restores focus and leaves export unopened", async ({ page }) => {
  await installOpfsSavePicker(page);
  await loadStudioSong(page);
  await openVideoExportModal(page);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Export Performance Video/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeFocused();
  const state = await page.evaluate(() => (window as Window & {
    __mediaExportOpfsState?: { names: string[] };
  }).__mediaExportOpfsState);
  expect(state?.names ?? []).toEqual([]);
});
