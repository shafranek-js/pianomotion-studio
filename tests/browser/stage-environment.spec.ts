import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import {
  committedStudioSettings,
  loadStudioSong,
  openStudioInspector,
  settledStudio,
  studioCanvas,
  waitForLoadingToClear,
} from "./studio-helpers";

type StageAppearance = {
  preset: "concert" | "studio";
  brightness: number;
  reflection: number;
  quality: "auto" | "low" | "high";
};

type StageDiagnostics = {
  appearance: StageAppearance;
  radius: number;
  floorY: number;
  reflectionResolution: number;
  reflectionTargetWidth: number;
  reflectionTargetHeight: number;
  reflectionPassEnabled: boolean;
  disposed: boolean;
};

type FloorPixelStats = { samples: number; changedSamples: number; totalChannelDelta: number; maxChannelDelta: number };
type FadeStats = { validPairs: number; averageChannelDelta: number; maxChannelDelta: number };
type DeckStats = { samples: number; changedDeckSamples: number; before: { peak: number; p99: number; bright: number }; after: { peak: number; p99: number; bright: number } };

declare global {
  interface Window {
    __stageEnvironment?: {
      diagnostics(): StageDiagnostics;
      canvasSize(): { width: number; height: number };
      webgl(): { version: string; contextLost: boolean };
      keyCount(): number;
      keyboardBounds(): { x: number; y: number; width: number; height: number; insideViewport: boolean };
      setAppearance(appearance: StageAppearance): StageDiagnostics;
      setView(view: "concert" | "overhead" | "pov" | "side_arch" | "overview" | "room"): void;
      capture(name: string, timeSeconds: number): void;
      compareFloor(first: string, second: string): FloorPixelStats;
      compareFadeEdge(): FadeStats;
      setAtmosphereVisible(visible: boolean): boolean;
      compareScreen(first: string, second: string, region: "sky" | "floor" | "all"): FloorPixelStats;
      glowSnapshot(): { count: number; noteIds: readonly string[] };
      setGlowVisible(visible: boolean): boolean;
      setNoteFixture(kind: "default" | "chord" | "edge"): void;
      setDeckFinish(finish: "legacy" | "current"): void;
      compareDeck(first: string, second: string): DeckStats;
      dispose(): void;
    };
    __stageEnvironmentError?: string;
  }
}

type PlayerSnapshotProbe = {
  result: { projectId: string; revision: number; engineVersion: string };
  pending: boolean;
};

const harnessFile = resolve(process.cwd(), "tests/browser/r3d/stage-environment.html").replaceAll("\\", "/");

test("active 3D notes glow only during their timed intervals and recover after seek", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`/@fs/${harnessFile}`);
  await page.waitForFunction(() => Boolean(window.__stageEnvironment || window.__stageEnvironmentError));
  expect(await page.evaluate(() => window.__stageEnvironmentError ?? null)).toBeNull();
  const canvas = page.locator('#stage-scene-host canvas[aria-label="3D piano keyboard"]');
  await page.evaluate(() => window.__stageEnvironment!.setView("pov"));
  await page.evaluate(() => window.__stageEnvironment!.capture("future-on", 0));
  expect(await page.evaluate(() => window.__stageEnvironment!.glowSnapshot())).toMatchObject({ count: 0, noteIds: [] });
  expect(await page.evaluate(() => window.__stageEnvironment!.setGlowVisible(false))).toBe(true);
  await page.evaluate(() => window.__stageEnvironment!.capture("future-off", 0));
  const future = await page.evaluate(() => window.__stageEnvironment!.compareScreen("future-on", "future-off", "all"));
  expect(future.totalChannelDelta).toBe(0);

  await page.evaluate(() => window.__stageEnvironment!.capture("active-off", 0.7));
  await canvas.screenshot({ path: info.outputPath("active-notes-glow-off.png") });
  await page.evaluate(() => window.__stageEnvironment!.setGlowVisible(true));
  await page.evaluate(() => window.__stageEnvironment!.capture("active-on", 0.7));
  const active = await page.evaluate(() => window.__stageEnvironment!.glowSnapshot());
  expect(active.count).toBe(4);
  expect([...active.noteIds].sort()).toEqual(["stage-bass", "stage-high", "stage-middle", "stage-treble"]);
  const pixels = await page.evaluate(() => window.__stageEnvironment!.compareScreen("active-off", "active-on", "all"));
  expect(pixels.changedSamples, "active hand-colored halos must be visible in the real render").toBeGreaterThan(50);
  await canvas.screenshot({ path: info.outputPath("active-notes-glow-pov.png") });
  await page.evaluate(() => window.__stageEnvironment!.capture("released-on", 3));
  expect(await page.evaluate(() => window.__stageEnvironment!.glowSnapshot())).toMatchObject({ count: 0, noteIds: [] });
  await page.evaluate(() => window.__stageEnvironment!.setGlowVisible(false));
  await page.evaluate(() => window.__stageEnvironment!.capture("released-off", 3));
  const released = await page.evaluate(() => window.__stageEnvironment!.compareScreen("released-on", "released-off", "all"));
  expect(released.totalChannelDelta).toBe(0);
  await page.evaluate(() => window.__stageEnvironment!.setGlowVisible(true));
  await page.evaluate(() => window.__stageEnvironment!.capture("restored", 0.7));
  expect(await page.evaluate(() => window.__stageEnvironment!.glowSnapshot())).toEqual(active);
  const restored = await page.evaluate(() => window.__stageEnvironment!.compareScreen("active-on", "restored", "all"));
  expect(restored.totalChannelDelta, "manual export and seek should reconstruct the same glow").toBe(0);
  await page.evaluate(() => window.__stageEnvironment!.setView("concert"));
  await page.evaluate(() => window.__stageEnvironment!.capture("active-concert", 0.7));
  await canvas.screenshot({ path: info.outputPath("active-notes-glow-concert.png") });
  await page.evaluate(() => window.__stageEnvironment!.setNoteFixture("chord"));
  await page.evaluate(() => window.__stageEnvironment!.capture("active-chord", 0.5));
  expect((await page.evaluate(() => window.__stageEnvironment!.glowSnapshot())).count).toBe(6);
  await canvas.screenshot({ path: info.outputPath("active-notes-glow-chord.png") });
  await page.evaluate(() => window.__stageEnvironment!.setNoteFixture("edge"));
  await page.evaluate(() => window.__stageEnvironment!.capture("active-edge", 0.7));
  expect((await page.evaluate(() => window.__stageEnvironment!.glowSnapshot())).count).toBe(1);
  await canvas.screenshot({ path: info.outputPath("active-notes-glow-edge.png") });
  await info.attach("active-note-glow-evidence", { body: JSON.stringify({ active, future, pixels, released, restored }, null, 2), contentType: "application/json" });
  expect(await page.evaluate(() => window.__stageEnvironment!.keyCount())).toBe(88);
  await page.evaluate(() => window.__stageEnvironment!.dispose());
  expect(errors).toEqual([]);
});

test("note surface has restrained highlights in the pianist and concert cameras", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`/@fs/${harnessFile}`);
  await page.waitForFunction(() => Boolean(window.__stageEnvironment || window.__stageEnvironmentError));
  expect(await page.evaluate(() => window.__stageEnvironmentError ?? null)).toBeNull();
  const canvas = page.locator('#stage-scene-host canvas[aria-label="3D piano keyboard"]');
  for (const view of ["pov", "concert"] as const) {
    await page.evaluate(value => window.__stageEnvironment!.setView(value), view);
    await page.evaluate(() => window.__stageEnvironment!.setDeckFinish("legacy"));
    await page.evaluate(() => window.__stageEnvironment!.capture("deck-before", 0.4));
    await canvas.screenshot({ path: info.outputPath(`deck-${view}-before.png`) });
    await page.evaluate(() => window.__stageEnvironment!.setDeckFinish("current"));
    await page.evaluate(() => window.__stageEnvironment!.capture("deck-after", 0.4));
    await canvas.screenshot({ path: info.outputPath(`deck-${view}-after.png`) });
    const stats = await page.evaluate(() => window.__stageEnvironment!.compareDeck("deck-before", "deck-after"));
    await info.attach(`deck-${view}-luminance`, { body: JSON.stringify(stats, null, 2), contentType: "application/json" });
    expect(stats.samples).toBeGreaterThan(200);
    expect(stats.changedDeckSamples).toBeGreaterThan(200);
    expect(stats.before.p99, "the original bright reflection must be reproduced").toBeGreaterThan(80);
    expect(stats.after.p99, "bright surface reflections should be substantially reduced").toBeLessThan(stats.before.p99 * 0.7);
  }
  expect(await page.evaluate(() => window.__stageEnvironment!.keyCount())).toBe(88);
  await page.evaluate(() => window.__stageEnvironment!.dispose());
  expect(errors).toEqual([]);
});

test("concert atmosphere renders a scattered shaft and soft perimeter without changing the fixed scene", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`/@fs/${harnessFile}`);
  await page.waitForFunction(() => Boolean(window.__stageEnvironment || window.__stageEnvironmentError));
  expect(await page.evaluate(() => window.__stageEnvironmentError ?? null)).toBeNull();
  const canvas = page.locator('#stage-scene-host canvas[aria-label="3D piano keyboard"]');
  const appearance: StageAppearance = { preset: "concert", brightness: 1, reflection: 0, quality: "high" };
  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), appearance);
  await page.evaluate(() => window.__stageEnvironment!.setView("room"));
  expect(await page.evaluate(() => window.__stageEnvironment!.setAtmosphereVisible(false))).toBe(true);
  await page.evaluate(() => window.__stageEnvironment!.capture("atmosphere-off", 0.4));
  await canvas.screenshot({ path: info.outputPath("atmosphere-off.png") });
  await page.evaluate(() => window.__stageEnvironment!.setAtmosphereVisible(true));
  await page.evaluate(() => window.__stageEnvironment!.capture("atmosphere-on", 0.4));
  await canvas.screenshot({ path: info.outputPath("atmosphere-room.png") });
  const sky = await page.evaluate(() => window.__stageEnvironment!.compareScreen("atmosphere-off", "atmosphere-on", "sky"));
  const floor = await page.evaluate(() => window.__stageEnvironment!.compareScreen("atmosphere-off", "atmosphere-on", "floor"));
  await info.attach("atmosphere-pixels", { body: JSON.stringify({ sky, floor }, null, 2), contentType: "application/json" });
  expect(sky.changedSamples, "the shaft must visibly illuminate the space behind the piano").toBeGreaterThan(100);
  expect(floor.changedSamples, "the perimeter must illuminate the lower stage").toBeGreaterThan(100);
  await page.evaluate(() => window.__stageEnvironment!.capture("atmosphere-stationary", 0.4));
  const stationary = await page.evaluate(() => window.__stageEnvironment!.compareScreen("atmosphere-on", "atmosphere-stationary", "sky"));
  expect(stationary.totalChannelDelta, "manual frames must have stable atmospheric lighting").toBe(0);
  await page.evaluate(() => window.__stageEnvironment!.setView("overview"));
  await page.evaluate(() => window.__stageEnvironment!.capture("overview", 0.4));
  const fade = await page.evaluate(() => window.__stageEnvironment!.compareFadeEdge());
  expect(fade.validPairs).toBeGreaterThan(48);
  expect(fade.averageChannelDelta).toBeLessThan(35);
  expect(fade.maxChannelDelta).toBeLessThan(100);
  await canvas.screenshot({ path: info.outputPath("atmosphere-whole-platform.png") });
  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), { ...appearance, reflection: 0.28 });
  await page.evaluate(() => window.__stageEnvironment!.setView("concert"));
  await page.evaluate(() => window.__stageEnvironment!.capture("concert-atmosphere", 0.4));
  await canvas.screenshot({ path: info.outputPath("atmosphere-concert-camera.png") });
  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), { ...appearance, preset: "studio" } as StageAppearance);
  await page.evaluate(() => window.__stageEnvironment!.setView("room"));
  await page.evaluate(() => window.__stageEnvironment!.capture("studio-atmosphere", 0.4));
  await canvas.screenshot({ path: info.outputPath("atmosphere-studio.png") });
  expect(await page.evaluate(() => window.__stageEnvironment!.keyCount())).toBe(88);
  expect(await page.evaluate(() => window.__stageEnvironment!.canvasSize())).toEqual({ width: 1280, height: 800 });
  await info.attach("atmosphere-evidence", { body: JSON.stringify({ sky, floor, stationary, fade }, null, 2), contentType: "application/json" });
  await page.evaluate(() => window.__stageEnvironment!.dispose());
  expect(errors).toEqual([]);
});

test("real 3D stage renders presets, reflection, a soft radial edge, and capped targets", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`/@fs/${harnessFile}`);
  await page.waitForFunction(() => Boolean(window.__stageEnvironment || window.__stageEnvironmentError));
  expect(await page.evaluate(() => window.__stageEnvironmentError ?? null), "the real WebGL scene must initialize").toBeNull();
  const canvas = page.locator('#stage-scene-host canvas[aria-label="3D piano keyboard"]');
  await expect(canvas).toBeVisible();

  const initial = await page.evaluate(() => ({
    diagnostics: window.__stageEnvironment!.diagnostics(),
    size: window.__stageEnvironment!.canvasSize(),
    webgl: window.__stageEnvironment!.webgl(),
    keyCount: window.__stageEnvironment!.keyCount(),
  }));
  expect(initial.webgl.version).toContain("WebGL");
  expect(initial.webgl.contextLost).toBe(false);
  expect(initial.keyCount, "the production keyboard should contain all 88 keys").toBe(88);
  expect(initial.size).toEqual({ width: 1280, height: 800 });
  expect(initial.diagnostics.disposed).toBe(false);

  await page.evaluate(() => window.__stageEnvironment!.setView("overview"));
  const wideKeyboard = await page.evaluate(() => window.__stageEnvironment!.keyboardBounds());
  expect(wideKeyboard.insideViewport, "the wide overview should keep the entire piano in frame").toBe(true);
  expect(wideKeyboard.width).toBeGreaterThan(80);
  expect(wideKeyboard.height).toBeGreaterThan(24);
  await page.evaluate(() => window.__stageEnvironment!.capture("overview", 0.35));
  await page.locator("#stage-scene-host").screenshot({ path: info.outputPath("stage-wide-overview.png") });
  const fade = await page.evaluate(() => window.__stageEnvironment!.compareFadeEdge());
  await info.attach("stage-fade-edge-evidence", { body: JSON.stringify(fade, null, 2), contentType: "application/json" });
  expect(fade.validPairs, "the full stage perimeter should be in the overview camera").toBeGreaterThan(48);
  expect(fade.averageChannelDelta, "the floor should blend into the scene around its perimeter").toBeLessThan(35);
  expect(fade.maxChannelDelta, "the radial boundary should have no abrupt dark or bright jump").toBeLessThan(100);

  await page.evaluate(() => window.__stageEnvironment!.setView("concert"));
  const base: StageAppearance = { preset: "concert", brightness: 1, reflection: 0.8, quality: "low" };
  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), base);
  await page.evaluate(() => window.__stageEnvironment!.capture("concert", 0.25));
  await page.locator("#stage-scene-host").screenshot({ path: info.outputPath("stage-concert-reflections.png") });

  const studio = { ...base, preset: "studio" as const };
  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), studio);
  await page.evaluate(() => window.__stageEnvironment!.capture("studio", 0.25));
  await page.locator("#stage-scene-host").screenshot({ path: info.outputPath("stage-studio-reflections.png") });
  const presetPixels = await page.evaluate(() => window.__stageEnvironment!.compareFloor("concert", "studio"));
  await info.attach("preset-floor-pixels", { body: JSON.stringify(presetPixels), contentType: "application/json" });
  expect(presetPixels.samples).toBeGreaterThan(40);
  expect(presetPixels.changedSamples, "concert and studio presets should change visible floor pixels").toBeGreaterThan(24);

  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), base);
  await page.evaluate(() => window.__stageEnvironment!.capture("brightness-normal", 0.25));
  await page.evaluate(value => window.__stageEnvironment!.setAppearance({ ...value, brightness: 1.45 }), base);
  await page.evaluate(() => window.__stageEnvironment!.capture("brightness-high", 0.25));
  const brightnessPixels = await page.evaluate(() => window.__stageEnvironment!.compareFloor("brightness-normal", "brightness-high"));
  expect(brightnessPixels.changedSamples, "stage brightness should affect floor pixels in the actual render").toBeGreaterThan(24);

  const low = await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), base);
  const high = await page.evaluate(value => window.__stageEnvironment!.setAppearance({ ...value, quality: "high" }), base);
  expect(low.reflectionResolution).toBe(256);
  expect([low.reflectionTargetWidth, low.reflectionTargetHeight]).toEqual([256, 256]);
  expect(high.reflectionResolution).toBe(1024);
  expect([high.reflectionTargetWidth, high.reflectionTargetHeight]).toEqual([1024, 1024]);

  await page.evaluate(() => window.__stageEnvironment!.capture("notes-early", 0.2));
  await page.evaluate(() => window.__stageEnvironment!.capture("notes-unchanged", 0.2));
  const stationaryPixels = await page.evaluate(() => window.__stageEnvironment!.compareFloor("notes-early", "notes-unchanged"));
  expect(stationaryPixels.changedSamples, "identical manual frames must not introduce reflection noise").toBe(0);
  await page.evaluate(() => window.__stageEnvironment!.capture("notes-later", 1.05));
  await page.locator("#stage-scene-host").screenshot({ path: info.outputPath("stage-moving-notes-reflection.png") });
  const movementPixels = await page.evaluate(() => window.__stageEnvironment!.compareFloor("notes-early", "notes-later"));
  // The four thin notes occupy only a few exposed floor samples: the opaque
  // piano hides most of their reflection. Require a deterministic nonzero
  // change rather than pretending that a large floor region must move.
  expect(movementPixels.changedSamples, "moving notes should alter their narrow exposed reflections").toBeGreaterThan(0);
  expect(movementPixels.totalChannelDelta).toBeGreaterThan(100);

  const enabled = await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), { ...base, quality: "high" } as StageAppearance);
  await page.evaluate(() => window.__stageEnvironment!.capture("reflection-enabled", 0.4));
  const disabled = await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), { ...base, reflection: 0, quality: "high" } as StageAppearance);
  await page.evaluate(() => window.__stageEnvironment!.capture("reflection-disabled", 0.4));
  await page.locator("#stage-scene-host").screenshot({ path: info.outputPath("stage-reflection-disabled.png") });
  const reflectionPixels = await page.evaluate(() => window.__stageEnvironment!.compareFloor("reflection-enabled", "reflection-disabled"));
  expect(enabled.reflectionPassEnabled).toBe(true);
  expect(disabled.reflectionPassEnabled, "zero strength should skip the Reflector pass").toBe(false);
  expect(reflectionPixels.samples).toBeGreaterThan(40);
  expect(reflectionPixels.changedSamples, "reflection strength should change the stage region").toBeGreaterThan(24);
  expect(reflectionPixels.totalChannelDelta).toBeGreaterThan(1_000);

  const final = await page.evaluate(() => ({ size: window.__stageEnvironment!.canvasSize(), keyCount: window.__stageEnvironment!.keyCount() }));
  expect(final.size, "quality changes must preserve fixed export dimensions").toEqual({ width: 1280, height: 800 });
  expect(final.keyCount).toBe(88);
  await info.attach("stage-render-evidence", {
    body: JSON.stringify({ initial, fade, presetPixels, brightnessPixels, low, high, stationaryPixels, movementPixels, enabled, disabled, reflectionPixels, final }, null, 2),
    contentType: "application/json",
  });

  await page.evaluate(value => window.__stageEnvironment!.setAppearance(value), { ...base, reflection: 0.28, quality: "high" } as StageAppearance);
  await page.evaluate(() => window.__stageEnvironment!.setView("room"));
  await page.evaluate(() => window.__stageEnvironment!.capture("room", 0.4));
  await canvas.screenshot({ path: info.outputPath("stage-room-concert.png") });

  await page.evaluate(() => window.__stageEnvironment!.dispose());
  expect(pageErrors, "the real stage should not raise page errors").toEqual([]);
  expect(consoleErrors, "the real stage should not log WebGL or shader errors").toEqual([]);
});

test("stage preferences persist through reload without restarting playback or the engine", async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const engineWorkers: string[] = [];
  page.on("worker", worker => {
    const url = worker.url();
    if (url.includes("midi-analysis-ts.worker") || url.includes("midi-analysis.worker")) engineWorkers.push(url);
  });

  const initial = await loadStudioSong(page, { output: "synth" });
  await expect(studioCanvas(page, "3d")).toBeVisible();
  const play = page.locator("#player-play-button");
  const seek = page.getByRole("slider", { name: "Seek position" });
  await play.click();
  await expect(play).toContainText("Pause");
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(-1.5);
  const beforeSettings = Number(await seek.inputValue());
  const initialWorkerCount = engineWorkers.length;
  expect(initialWorkerCount).toBeGreaterThan(0);

  await openStudioInspector(page, "Scene");
  await expect(page.locator("#studio-stage-reflection")).toHaveValue("0.28");
  await expect(page.locator("#studio-stage-reflection")).toHaveAttribute("aria-valuetext", "28%");
  await page.locator("#studio-stage-preset").selectOption("studio");
  const brightness = page.locator("#studio-stage-brightness");
  await brightness.focus();
  await brightness.press("End");
  const reflection = page.locator("#studio-stage-reflection");
  await reflection.focus();
  await reflection.press("End");
  await page.locator("#studio-stage-quality").selectOption("high");

  const expectedAppearance = { preset: "studio", brightness: 1.5, reflection: 1, quality: "high" };
  await expect.poll(async () => (await committedStudioSettings(page)).stageAppearance).toEqual(expectedAppearance);
  await expect(play).toContainText("Pause");
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(beforeSettings);
  const afterSettings = await page.evaluate(() => {
    const snapshot = (window as Window & { __playerSnapshot?: PlayerSnapshotProbe }).__playerSnapshot!;
    return {
      projectId: snapshot.result.projectId,
      revision: snapshot.result.revision,
      engineVersion: snapshot.result.engineVersion,
      pending: snapshot.pending,
    };
  });
  expect(afterSettings).toEqual({
    projectId: initial.result.projectId,
    revision: initial.result.revision,
    engineVersion: initial.result.engineVersion,
    pending: false,
  });
  expect(engineWorkers).toHaveLength(initialWorkerCount);
  await page.screenshot({ path: info.outputPath("stage-settings-live-ui.png") });

  await play.click();
  await expect(play).toContainText("Play");
  await studioCanvas(page, "3d").hover();
  await page.mouse.wheel(0, 700);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath("stage-room-live-ui.png") });
  await page.reload();
  await expect(page.getByTestId("studio-shell")).toHaveAttribute("data-layout-ready", "true", { timeout: 90_000 });
  await waitForLoadingToClear(page);
  await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
  const restored = await settledStudio(page, initial.result.revision);
  await openStudioInspector(page, "Scene");
  await expect(page.locator("#studio-stage-preset")).toHaveValue("studio");
  await expect(page.locator("#studio-stage-brightness")).toHaveValue("1.5");
  await expect(page.locator("#studio-stage-reflection")).toHaveValue("1");
  await expect(page.locator("#studio-stage-quality")).toHaveValue("high");
  expect((await committedStudioSettings(page)).stageAppearance).toEqual(expectedAppearance);
  await page.screenshot({ path: info.outputPath("stage-settings-restored-after-reload.png") });
  expect(restored.result.document?.notes.length).toBeGreaterThan(0);
  expect((await settledStudio(page, restored.result.revision)).pending).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#studio-stage-preset")).toBeVisible();
  await expect(page.locator("#studio-stage-quality")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("stage-settings-mobile.png") });
});
