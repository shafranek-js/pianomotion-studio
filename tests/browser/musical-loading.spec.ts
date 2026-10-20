import { expect, test } from "@playwright/test";
import { expectStudioCanvas, studioMidiPath } from "./studio-helpers";

test("cold startup has an honest musical staff and an English-only pianist, then clears", async ({page}, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/m1-fixtures/manifest.json*", async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto("/?empty=true");
  const musical = page.getByTestId("musical-loading");
  await expect(musical).toBeVisible();
  await expect(musical).toHaveAttribute("data-mode", "prominent");
  await expect(musical.locator(".musical-loading__staff")).toHaveCount(5);
  await expect(musical.locator(".musical-loading__pianist")).toContainText("fingers");
  const progress = musical.getByRole("progressbar");
  await expect(progress).not.toHaveAttribute("aria-valuenow", /.+/);
  await page.screenshot({path: info.outputPath("musical-loading-startup.png")});
  await expect(page.getByRole("button", {name: "Open MIDI", exact: true})).toBeVisible();
  await expect(musical).toHaveCount(0, {timeout: 25000});
  expect(errors).toEqual([]);
});

test("imported MIDI loads without holding the musical loader over a playable stage", async ({page}) => {
  test.setTimeout(120_000);
  await page.goto("/?empty=true");
  await expect(page.getByTestId("musical-loading")).toHaveCount(0, {timeout: 25000});
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);
  await expect(page.getByTestId("musical-loading")).toHaveCount(0, {timeout: 30000});
  await expect(page.getByRole("button", {name: "Play", exact: true})).toBeEnabled();
});

test("failed startup clears the loading overlay and exposes an error", async ({page}) => {
  await page.route("**/m1-fixtures/manifest.json*", route => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"offline"}',
  }));
  await page.goto("/?empty=true");
  await expect(page.getByTestId("musical-loading")).toHaveCount(0, {timeout: 30000});
  await expect(page.locator(".studio-save-state[data-kind='error']")).toBeVisible();
  await expect(page.getByTestId("studio-status")).toContainText("startup failed");
});
