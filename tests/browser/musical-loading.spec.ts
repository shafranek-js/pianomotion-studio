import { expect, test } from "@playwright/test";
import { configureStudioTestOutput, expectStudioCanvas, studioMidiPath } from "./studio-helpers";

test("status bar and release details display the current application version", async ({page}) => {
  await page.goto("/?empty=true");
  const release = page.locator(".studio-release-disclosure summary");
  await expect(release).toContainText("v0.1.0-dev.23");
  await expect(release).toHaveAttribute("aria-label", /Release details, version 0\.1\.0-dev\.23/);
  await release.click();
  await expect(page.getByRole("region", {name: "Release details"})).toContainText("0.1.0-dev.23");
});

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
  // The default SoundFont performs a separate asynchronous load. Use the
  // built-in synth to test MIDI readiness without conflating those lifecycles.
  await configureStudioTestOutput(page);
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);
  await expect(page.getByTestId("musical-loading")).toHaveCount(0, {timeout: 30000});
  await expect(page.getByRole("button", {name: "Play", exact: true})).toBeEnabled();
});

test("an unfinished SoundFont cannot leave a disabled Play button without the loader", async ({page}) => {
  test.setTimeout(120_000);
  let releaseSoundFont: () => void = () => {};
  const waitForRelease = new Promise<void>(resolve => { releaseSoundFont = resolve; });
  await page.route("**/soundfonts/musescore-general/*.sf3", async route => {
    await waitForRelease;
    await route.fulfill({ status: 503, contentType: "text/plain", body: "Simulated audio asset failure" });
  });
  await page.goto("/?empty=true");
  const loader = page.getByTestId("musical-loading");
  await expect(loader).toHaveCount(0, {timeout: 25000});
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);

  const play = page.getByRole("button", {name: "Play", exact: true});
  try {
    // The source/Worker is already finished, but audio preparation is intentionally
    // held back. The musical loader must remain, with no invented percentage.
    await expect(play).toBeDisabled({timeout: 30_000});
    await expect(loader).toBeVisible({timeout: 30_000});
    await expect(loader).toHaveAttribute("data-phase", "audio", {timeout: 30_000});
    await expect(loader).toHaveAttribute("data-mode", "prominent");
    await expect(loader.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", /.+/);
  } finally {
    releaseSoundFont();
  }

  // Even a failed selected SoundFont releases playback to the built-in synth;
  // failure should be reported, and the loader must never get stuck.
  await expect(play).toBeEnabled({timeout: 45_000});
  await expect(loader).toHaveCount(0, {timeout: 15_000});
  await expect(page.getByTestId("studio-status")).toContainText(/SoundFont was not activated/i);
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
