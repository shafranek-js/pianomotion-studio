import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { PianistProfile } from "@handthesia/contracts";

const measuredBaselineId = "handthesia.builtin.rigged-hands-measured-baseline";

async function exportDraft(page: Page, dialog: Locator): Promise<PianistProfile> {
  await dialog.getByRole("tab", { name: /Import \/ Export/i }).click();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /Export as/i }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  const profile = JSON.parse(await readFile(path!, "utf8")) as PianistProfile;
  await dialog.getByRole("tab", { name: /Anatomy/i }).click();
  return profile;
}

test("fresh pianist settings use the measured baseline and Duplicate preserves editable, durable anatomy", async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  // Playwright provides a fresh, isolated context. Keep the empty landing page:
  // opening pianist settings needs neither a melody nor a WebGL renderer.
  await page.goto("/?empty=true");
  const openPianist = page.getByRole("button", { name: "Open pianist settings", exact: true });
  await openPianist.click();
  const dialog = page.getByRole("dialog", { name: "Pianist settings", exact: true });
  const select = dialog.locator("#active-profile-select");
  const save = dialog.getByRole("button", { name: "Save & Apply", exact: true });
  const reset = dialog.getByRole("button", { name: "Reset", exact: true });
  const thumb = dialog.getByRole("slider", {
    name: "Thumb proximal phalanx (Thumb Proximal Phalanx)", exact: true,
  });
  await expect(select).toHaveValue(measuredBaselineId);
  await expect(select.locator("option:checked")).toHaveText("Rigged hands — measured baseline (Built-in)");
  await expect(dialog.getByTestId("rigged-hand-profile-calibration-note")).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

  // Search every settings tab, including content mounted only on demand.
  for (const tabName of [/Anatomy/i, /Motion/i, /Import \/ Export/i]) {
    await dialog.getByRole("tab", { name: tabName }).click();
    await expect(dialog).not.toContainText(/Testing2|Source measurements/i);
    await expect(dialog.getByTestId("create-rigged-hand-profile")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Create.*Rigged|Create.*Testing2|rig editor/i })).toHaveCount(0);
  }
  const baseline = await exportDraft(page, dialog);
  const baselineThumb = await thumb.inputValue();
  await thumb.press("ArrowRight");
  await expect(thumb).not.toHaveValue(baselineThumb);
  await expect(save).toBeDisabled();
  await reset.click();
  await expect(thumb).toHaveValue(baselineThumb);
  expect((await exportDraft(page, dialog)).anatomy).toEqual(baseline.anatomy);

  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(select).not.toHaveValue(measuredBaselineId);
  await expect(save).toBeEnabled();
  const copyId = await select.inputValue();
  const copied = await exportDraft(page, dialog);
  expect(copied.profileId).toBe(copyId);
  expect(copied.anatomy).toEqual(baseline.anatomy);
  expect(copied.behavior).toEqual(baseline.behavior);

  await thumb.press("ArrowRight");
  const savedThumb = await thumb.inputValue();
  await save.click();
  await expect(dialog.getByRole("status")).toContainText("Profile saved & applied!");
  const saved = await exportDraft(page, dialog);
  expect(saved.anatomy.pp1).toBeCloseTo(Number(savedThumb), 3);
  expect(saved.anatomy.pp1).not.toBe(baseline.anatomy.pp1);
  expect(saved.revision).toBeGreaterThan(copied.revision);

  // Reset discards a new draft and restores this copy's saved anatomy, rather
  // than replacing it with Default or with the measured built-in.
  await thumb.press("ArrowRight");
  await expect(thumb).not.toHaveValue(savedThumb);
  await reset.click();
  await expect(thumb).toHaveValue(savedThumb);
  expect((await exportDraft(page, dialog)).anatomy).toEqual(saved.anatomy);

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await openPianist.click();
  await expect(select).toHaveValue(copyId);
  await expect(thumb).toHaveValue(savedThumb);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  // Only reload the test-owned context; this verifies durable active selection.
  await page.reload();
  await openPianist.click();
  await expect(select).toHaveValue(copyId);
  expect((await exportDraft(page, dialog)).anatomy).toEqual(saved.anatomy);

  await select.selectOption(measuredBaselineId);
  await expect(save).toBeDisabled();
  expect((await exportDraft(page, dialog)).anatomy).toEqual(baseline.anatomy);
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
