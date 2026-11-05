import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadStudioSong, openStudioInspector, studioCanvas } from "./studio-helpers";

const evidence = resolve("scratch/studio-focus-20261105");

async function stableLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function capture(page: Page, name: string) {
  if (process.env.FOCUS_SKIP_SCREENSHOTS === "1") return;
  await mkdir(evidence, { recursive: true });
  await stableLayout(page);
  await page.screenshot({ path: resolve(evidence, name), timeout: 60_000 });
}

async function identity(page: Page) {
  return page.evaluate(() => {
    const snapshot = window.__playerSnapshot!;
    return { result: snapshot.result, draft: snapshot.draftPlan, view: snapshot.viewMode };
  });
}

async function time(page: Page) {
  return page.evaluate(() => window.__playerSnapshot!.currentTimeSeconds!);
}

async function expectFocus(page: Page) {
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "on");
  await stableLayout(page);
  for (const selector of [
    '[data-testid="studio-header"]', '[data-testid="studio-tool-rail"]',
    '.studio-transport', '[data-testid="studio-status"]',
    '[data-testid="projects-panel"]', '[data-testid="inspector-panel"]', '[data-testid="practice-panel"]',
    '[data-testid="studio-camera-hud"]', '[data-testid="studio-header-camera-hud"]',
    '[data-testid="studio-top-ribbons"]', '.studio-workspace-layout__waveform',
  ]) await expect(page.locator(selector)).toBeHidden();
  const bounds = await page.getByTestId("studio-workspace-focus-target").boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(Math.abs(bounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds!.width - viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(bounds!.height - viewport.height)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Keyboard navigation must never land in the hidden chrome or its panels.
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(
      '.studio-header, .studio-tool-rail, .studio-transport, .studio-statusbar, .studio-panel, [role="dialog"]',
    )))).toBe(false);
  }
}

test("Focus preserves the song and playback, restores pinned tools, and simplifies the rail", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await loadStudioSong(page, { output: "synth" });
  // Behavioral checks use 2D; opt into the expensive software-WebGL visual pass.
  const visual3d = process.env.FOCUS_VISUAL_3D === "1";
  if (!visual3d) await page.getByRole("button", { name: "2D", exact: true }).click();
  const canvas = studioCanvas(page, visual3d ? "3d" : "2d");
  await expect(canvas).toBeVisible();
  await canvas.evaluate(element => element.setAttribute("data-focus-identity", "persistent-3d"));
  const rail = page.getByTestId("studio-tool-rail");
  await expect(rail.getByRole("button", { name: "Open melody file...", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Open audio recording settings", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "File", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Open melody file...", exact: true }).click();
  expect((await chooser).isMultiple()).toBe(false);
  await openStudioInspector(page, "Audio");
  await expect(page.getByRole("tab", { name: "Audio", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Pin Inspector panel", exact: true }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByTestId("practice-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unpin Practice panel", exact: true })).toBeVisible();
  const initial = await identity(page);
  const cameraPreset = page.locator('[aria-label="3D camera presets"] button[aria-pressed="true"]').first();
  const camera = await cameraPreset.count() ? await cameraPreset.textContent() : null;
  await page.locator("#player-speed-select").selectOption("0.25");
  for (const name of ["Chords", "Staff"]) {
    const toggle = page.getByRole("button", { name, exact: true });
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  }
  await expect(page.getByTestId("studio-top-ribbons")).toBeVisible();
  await capture(page, "desktop-before.png");
  await page.locator("#player-play-button").click();
  await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", "Pause");
  const before = await time(page);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  }
  await expectFocus(page);
  await expect.poll(() => time(page)).toBeGreaterThan(before + 0.05);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.locator("#player-play-button")).toBeVisible();
  await page.locator("#player-play-button").click();
  await expect(page.locator("#player-play-button")).toHaveAttribute("aria-label", "Play");
  expect(await time(page)).toBeGreaterThan(before + 0.05);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "on");
  await capture(page, "desktop-focus.png");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
  await expect(page.getByTestId("practice-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unpin Practice panel", exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute("data-focus-identity", "persistent-3d");
  await expect(page.getByTestId("studio-top-ribbons")).toBeVisible();
  for (const name of ["Chords", "Staff"]) await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await identity(page)).toEqual(initial);
  if (camera !== null) expect(await cameraPreset.textContent()).toBe(camera);
  await capture(page, "desktop-after.png");
  await openStudioInspector(page, "Audio");
  const inspectorHandle = await page.getByTestId("inspector-panel").elementHandle();
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  if (await page.evaluate(() => document.fullscreenEnabled)) await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  expect(await inspectorHandle!.evaluate(element => element === document.querySelector('[data-testid="inspector-panel"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
  expect(await inspectorHandle!.evaluate(element => element === document.querySelector('[data-testid="inspector-panel"]'))).toBe(true);
  await expect(page.getByRole("tab", { name: "Audio", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Unpin Inspector panel", exact: true })).toBeVisible();
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole("button", { name: "Focus mode", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
  }
  expect(await identity(page)).toEqual(initial);
  await page.getByRole("button", { name: "Play along", exact: true }).click();
  const practice = page.getByLabel("Play along practice controls");
  await expect(practice).toContainText(/Step 1 of/);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expect(page.getByTestId("studio-workspace-focus-target")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(practice).toContainText(/Step 2 of/);
  await page.keyboard.press("Escape");
  await expect(practice).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("touch Focus", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("respects an existing fullscreen session and follows its native exit", async ({ page }) => {
    await page.goto("/?empty=true");
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
    test.skip(!await page.evaluate(() => document.fullscreenEnabled), "Fullscreen API unavailable");
    // A real click supplies user activation for an externally owned session.
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("button", { name: "Focus mode", exact: true }).click();
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "on");
    await page.getByRole("button", { name: "Exit focus", exact: true }).click();
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
    expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
    await page.getByRole("button", { name: "Focus mode", exact: true }).click();
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
    await expect(page.getByTestId("studio-header")).toBeVisible();
  });
  test("offers a reachable exit and reload never traps a saved Focus session", async ({ page }) => {
    test.setTimeout(180_000);
    await loadStudioSong(page, { output: "synth" });
    await page.getByRole("button", { name: "Focus mode", exact: true }).click();
    await expectFocus(page);
    const exit = page.getByRole("button", { name: "Exit focus", exact: true });
    await expect(exit).toBeInViewport();
    await exit.click({ trial: true });
    await capture(page, "mobile-focus.png");
    await exit.click();
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
    await expect(page.getByTestId("studio-header")).toBeVisible();
    await page.getByRole("button", { name: "Focus mode", exact: true }).click();
    // Wait for the actual saved setting, rather than guessing the debounce delay.
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("handthesia_db");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<boolean>(resolve => {
          const request = db.transaction("settings", "readonly").objectStore("settings").get("studio.layout.v1");
          request.onsuccess = () => resolve(request.result?.value?.focusMode === true);
        });
      } finally { db.close(); }
    })).toBe(true);
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "on");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(exit).toBeInViewport();
    await exit.click();
    await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
    await expect(page.getByTestId("studio-tool-rail")).toBeVisible();
  });
});

test("a rejected fullscreen request leaves an escapable in-tab Focus session", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"));
  });
  await page.goto("/?empty=true");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("button", { name: "Pin Inspector panel", exact: true }).click();
  const inspector = await page.getByTestId("inspector-panel").elementHandle();
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await expectFocus(page);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  for (const width of [1280, 800, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await stableLayout(page);
    expect(await inspector!.evaluate(element => element === document.querySelector('[data-testid="inspector-panel"]'))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-focus-mode", "off");
  await expect(page.getByTestId("studio-header")).toBeVisible();
});
