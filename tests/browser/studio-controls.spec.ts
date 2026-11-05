import { expect, test, type Page } from "@playwright/test";
import { loadStudioSong, openStudioInspector, studioCanvas } from "./studio-helpers";

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});

async function loadPerformance(page: Page) {
  await loadStudioSong(page, { output: "synth" });
  await page.getByRole("button", { name: "2D", exact: true }).click();
  await expect(studioCanvas(page, "2d")).toBeVisible();
  await page.locator("#player-speed-select").selectOption("0.25");
}

async function expectPlaying(page: Page, playing: boolean) {
  await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", playing ? "Pause" : "Play");
}

test("rail owns Export, pianist profile and Preferences with reachable dialogs", async ({ page }, testInfo) => {
  await loadPerformance(page);
  const rail = page.getByTestId("studio-tool-rail");
  const header = page.getByTestId("studio-header");
  for (const name of ["Export", "Open pianist settings", "Open preferences"]) {
    await expect(header.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
  }
  const exportButton = rail.getByRole("button", { name: "Export", exact: true });
  await exportButton.click();
  await expect(page.getByRole("menuitem", { name: "Project package (.json)", exact: true })).toBeEnabled();
  const desktopMenu = await page.getByRole("menu", { name: "Export", exact: true }).boundingBox();
  const desktopRail = await rail.boundingBox();
  expect(desktopMenu).not.toBeNull();
  expect(desktopMenu!.x).toBeGreaterThanOrEqual(desktopRail!.x + desktopRail!.width);
  expect(desktopMenu!.x + desktopMenu!.width).toBeLessThanOrEqual(1440);
  expect(desktopMenu!.y).toBeGreaterThanOrEqual(0);
  expect(desktopMenu!.y + desktopMenu!.height).toBeLessThanOrEqual(900);
  console.log("Desktop rail geometry", await rail.getByRole("button").evaluateAll(buttons => buttons.map(button => ({
    name: button.getAttribute("aria-label"), x: button.getBoundingClientRect().x, y: button.getBoundingClientRect().y,
    width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
  }))));
  if (process.env.CONTROLS_SCREENSHOTS === "1") await page.screenshot({ path: testInfo.outputPath("controls-desktop-export.png"), timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(exportButton).toBeFocused();
  const pianist = rail.getByRole("button", { name: "Open pianist settings", exact: true });
  await pianist.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(pianist).toBeFocused();
  const preferences = rail.getByRole("button", { name: "Open preferences", exact: true });
  await preferences.click();
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preferences).toBeFocused();
  await page.setViewportSize({ width: 390, height: 520 });
  for (const button of [exportButton, pianist, preferences]) {
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
    await button.click({ trial: true });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await exportButton.scrollIntoViewIfNeeded();
  await exportButton.click();
  await expect(page.getByRole("menuitem", { name: "Project package (.json)", exact: true })).toBeInViewport();
  const mobileMenu = await page.getByRole("menu", { name: "Export", exact: true }).boundingBox();
  expect(mobileMenu!.x).toBeGreaterThanOrEqual(0);
  expect(mobileMenu!.x + mobileMenu!.width).toBeLessThanOrEqual(390);
  expect(mobileMenu!.y).toBeGreaterThanOrEqual(0);
  expect(mobileMenu!.y + mobileMenu!.height).toBeLessThanOrEqual(520);
  console.log("Mobile export geometry", mobileMenu);
  if (process.env.CONTROLS_SCREENSHOTS === "1") await page.screenshot({ path: testInfo.outputPath("controls-mobile-export.png"), timeout: 15_000 });
});

test("Space and Enter toggle transport in Focus and respect dialogs, controls and Play Along", async ({ page }) => {
  await loadPerformance(page);
  const canvas = studioCanvas(page, "2d");
  await canvas.focus();
  await page.keyboard.press("Space");
  await expectPlaying(page, true);
  await page.keyboard.press("Enter");
  await expectPlaying(page, false);
  await page.getByRole("button", { name: "Count-in", exact: true }).click();
  await canvas.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".studio-transport-controls__count-in-beat")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator(".studio-transport-controls__count-in-beat")).toHaveCount(0);
  await expectPlaying(page, false);
  await page.getByRole("button", { name: "Count-in", exact: true }).click();
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expect(page.locator(".studio-transport")).toBeHidden();
  await expect(page.getByTestId("studio-workspace-focus-target")).toBeFocused();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.press(key);
    await expectPlaying(page, true);
    await page.keyboard.press(key);
    await expectPlaying(page, false);
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
  await dialog.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await expectPlaying(page, false);
  await dialog.locator('input[type="range"]').first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await expectPlaying(page, false);
  await page.keyboard.press("Escape");
  // Native button activation must happen once, without the global shortcut.
  await page.locator("#player-play-button").focus();
  await page.keyboard.press("Enter");
  await expectPlaying(page, true);
  await page.keyboard.press("Space");
  await expectPlaying(page, false);
  await page.getByRole("button", { name: "Play along", exact: true }).click();
  const practice = page.getByLabel("Play along practice controls");
  await expect(practice).toContainText(/Step 1 of/);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await page.keyboard.press("Space");
  await expect(practice).toContainText(/Step 2 of/);
});

test("connected MIDI note-on starts playback without pausing it", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as Window & { __controlsMidi?: { requests: number; emit: (status: number, velocity: number) => void } };
    const input = {
      id: "controls-input", name: "Controls keyboard", manufacturer: "Test", state: "connected", type: "input",
      onmidimessage: null as ((event: { data: Uint8Array; timeStamp: number }) => void) | null,
    };
    const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null });
    state.__controlsMidi = {
      requests: 0,
      emit: (status, velocity) => input.onmidimessage?.({ data: new Uint8Array([status, 60, velocity]), timeStamp: performance.now() }),
    };
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: async () => { state.__controlsMidi!.requests++; return access; },
    });
  });
  const emit = async (status: number, velocity: number) => page.evaluate(([s, v]) => {
    (window as Window & { __controlsMidi?: { emit: (status: number, velocity: number) => void } }).__controlsMidi!.emit(s!, v!);
  }, [status, velocity]);
  await loadPerformance(page);
  expect(await page.evaluate(() => (window as Window & { __controlsMidi?: { requests: number } }).__controlsMidi!.requests)).toBe(0);
  await openStudioInspector(page, "Audio");
  await page.getByRole("button", { name: "Connect MIDI", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "MIDI input device", exact: true })).toContainText("Controls keyboard");
  await page.keyboard.press("Escape");
  await emit(0x80, 0);
  await emit(0x90, 0);
  await expectPlaying(page, false);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await emit(0x90, 100);
  await expectPlaying(page, true);
  await emit(0x90, 100);
  await emit(0x80, 0);
  await expectPlaying(page, true);
  await page.keyboard.press("Space");
  await expectPlaying(page, false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  await emit(0x90, 100);
  await expectPlaying(page, false);
});
