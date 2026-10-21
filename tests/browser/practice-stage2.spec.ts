import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { ProjectPackageSchema } from "@handthesia/contracts";
import {
  expectStudioCanvas,
  exportStudioPackage,
  loadStudioSong,
  saveStudioProject,
  settledStudio,
  studioMidiPath,
} from "./studio-helpers";

const alternateMidiPath = fileURLToPath(new URL("../fixtures/midi/tracked-demo-song.mid", import.meta.url));

type LoopRange = { start: number; end: number; eventCount: number };

function pressTimes(snapshot: Awaited<ReturnType<typeof settledStudio>>): number[] {
  return (snapshot.result.performancePlan?.events ?? [])
    .filter((event) => event.type === "press")
    .map((event) => event.timeSeconds)
    .filter((time) => Number.isFinite(time) && time >= 0);
}

/** Select a centisecond-editable range from this fixture's real planned note onsets. */
function chooseLoopRange(snapshot: Awaited<ReturnType<typeof settledStudio>>): LoopRange {
  const duration = snapshot.result.document?.durationSeconds ?? 0;
  const rawTimes = pressTimes(snapshot);
  const roundedTimes = [...new Set(rawTimes.map((time) => Math.round(time * 100) / 100))].sort((a, b) => a - b);

  for (let index = 1; index + 4 < roundedTimes.length; index += 1) {
    // Align points to the transport's 50 ms seek step while keeping A at or
    // before actual note onsets and B before the selected exclusive onset.
    const start = Math.max(0, Math.floor(roundedTimes[index]! * 20) / 20);
    const end = Math.floor(roundedTimes[index + 4]! * 20) / 20;
    const eventCount = rawTimes.filter((time) => time >= start && time < end).length;
    if (end - start >= 0.1 - 1e-9 && end <= duration && eventCount >= 3) {
      return { start, end, eventCount };
    }
  }

  throw new Error(`Fixture has no usable loop range: duration=${duration}, pressTimes=${JSON.stringify(rawTimes.slice(0, 24))}`);
}

function chooseNoStepRange(snapshot: Awaited<ReturnType<typeof settledStudio>>): LoopRange {
  const duration = snapshot.result.document?.durationSeconds ?? 0;
  const rawTimes = [...new Set(pressTimes(snapshot))].sort((a, b) => a - b);
  for (let index = 0; index + 1 < rawTimes.length; index += 1) {
    const left = rawTimes[index]!;
    const right = rawTimes[index + 1]!;
    if (right - left < 0.24) continue;
    const start = Math.round((left + 0.04) * 100) / 100;
    const end = Math.round((right - 0.04) * 100) / 100;
    const eventCount = rawTimes.filter((time) => time >= start && time < end).length;
    if (end - start >= 0.1 - 1e-9 && end <= duration && eventCount === 0) {
      return { start, end, eventCount };
    }
  }
  throw new Error(`Fixture has no 0.1s gap without note onsets: ${JSON.stringify(rawTimes.slice(0, 30))}`);
}

async function playerSnapshot(page: Page) {
  return page.evaluate(() => {
    const snapshot = window.__playerSnapshot;
    if (!snapshot) throw new Error("The real PianoPlayer snapshot is unavailable.");
    return {
      result: snapshot.result,
      practiceState: snapshot.practiceState,
      currentTimeSeconds: snapshot.currentTimeSeconds,
      viewMode: snapshot.viewMode,
    };
  });
}

async function waitForStablePausedTime(page: Page): Promise<number> {
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  let previousTime: number | undefined;
  let settledTime: number | undefined;
  await expect.poll(async () => {
    const currentTime = (await playerSnapshot(page)).currentTimeSeconds;
    const isStable = currentTime !== undefined && Number.isFinite(currentTime) && previousTime !== undefined && Math.abs(currentTime - previousTime) <= 0.005;
    previousTime = currentTime;
    if (isStable) settledTime = currentTime;
    return isStable;
  }, { timeout: 5_000, intervals: [100] }).toBe(true);
  return settledTime!;
}

async function sessionPracticeState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open the project database."));
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction("session", "readonly").objectStore("session").get("current_session");
        request.onsuccess = () => resolve(request.result?.practiceState ?? null);
        request.onerror = () => reject(request.error ?? new Error("Could not read the session practice state."));
      });
    } finally {
      db.close();
    }
  });
}

async function seekWithTransportSlider(page: Page, timeSeconds: number) {
  const slider = page.getByRole("slider", { name: "Seek position", exact: true });
  await expect(slider).toBeVisible();
  // HTML range inputs are not fillable. Set through the native value setter,
  // then dispatch the real input event so StudioTransport's onChange runs.
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Native range value setter is unavailable.");
    setter.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, timeSeconds);
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds).toBeCloseTo(timeSeconds, 1);
}

async function practicePanel(page: Page) {
  const trigger = page.getByRole("button", { name: "Practice", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  if (await trigger.getAttribute("aria-pressed") !== "true") await trigger.click();
  const panel = page.getByTestId("practice-panel");
  await expect(panel).toBeVisible();
  return { trigger, panel };
}

async function setLoopRangeFromPlayhead(page: Page, panel: Locator, range: LoopRange) {
  await seekWithTransportSlider(page, range.start);
  await panel.getByRole("button", { name: "Set A to current time", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.startSeconds).toBeCloseTo(range.start, 2);

  await seekWithTransportSlider(page, range.end);
  await panel.getByRole("button", { name: "Set B to current time", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.endSeconds).toBeCloseTo(range.end, 2);
}

async function captureLoopWraps(page: Page, range: LoopRange, targetWraps: number, timeoutMs: number) {
  const startedAt = Date.now();
  let previous: number | null = null;
  let wraps = 0;
  const samples: Array<{ elapsedMs: number; currentTimeSeconds: number }> = [];
  const wrapElapsedMs: number[] = [];
  while (Date.now() - startedAt < timeoutMs && wraps < targetWraps) {
    const currentTimeSeconds = (await playerSnapshot(page)).currentTimeSeconds;
    if (typeof currentTimeSeconds === "number" && Number.isFinite(currentTimeSeconds)) {
      const elapsedMs = Date.now() - startedAt;
      samples.push({ elapsedMs, currentTimeSeconds });
      if (previous !== null && currentTimeSeconds < previous - 0.2) {
        wraps += 1;
        wrapElapsedMs.push(elapsedMs);
      }
      previous = currentTimeSeconds;
    }
    await page.waitForTimeout(50);
  }
  return {
    range,
    targetWraps,
    wraps,
    durationMs: Date.now() - startedAt,
    wrapElapsedMs,
    samples,
  };
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

test("Practice A–B repeat wraps real synth playback, validates bounds, pauses, stops, and continues when disabled", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const initial = await loadStudioSong(page, { output: "synth", dimension: "2d" });
  const range = chooseLoopRange(initial);
  const { panel } = await practicePanel(page);
  await expect(panel.getByRole("button", { name: "Pin Practice panel", exact: true })).toBeVisible();
  await setLoopRangeFromPlayhead(page, panel, range);

  const loopInputA = panel.getByRole("spinbutton", { name: "Loop start (seconds)", exact: true });
  const beforeInvalidEdit = (await playerSnapshot(page)).practiceState?.loop;
  await loopInputA.fill(range.end.toFixed(2));
  await loopInputA.press("Enter");
  await expect(panel.getByRole("status")).toContainText("A must come before B");
  expect((await playerSnapshot(page)).practiceState?.loop).toEqual(beforeInvalidEdit);
  await loopInputA.press("Escape");

  const repeat = panel.getByRole("checkbox", { name: "Repeat A–B", exact: true });
  await repeat.check();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.enabled).toBe(true);

  const screenshotPath = testInfo.outputPath("practice-desktop-loop.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("practice-desktop-loop", { path: screenshotPath, contentType: "image/png" });

  const loopMeasurements: Array<Record<string, unknown>> = [];
  const speed = page.getByRole("combobox", { name: "Speed", exact: true });
  await speed.selectOption("2");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const fast = await captureLoopWraps(page, range, 3, 20_000);
  loopMeasurements.push({ speed: 2, ...fast });
  await attachJson(testInfo, "practice-loop-measurements.json", loopMeasurements);
  expect(fast.wraps, `2× loop did not wrap three times: ${JSON.stringify(fast)}`).toBeGreaterThanOrEqual(3);
  expect(fast.samples.every((sample) => sample.currentTimeSeconds >= range.start - 0.05 && sample.currentTimeSeconds < range.end + 0.05)).toBe(true);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const pausedAt = await waitForStablePausedTime(page);
  await page.waitForTimeout(180);
  expect((await playerSnapshot(page)).currentTimeSeconds).toBeCloseTo(pausedAt, 2);

  await speed.selectOption("0.5");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const slow = await captureLoopWraps(page, range, 1, 12_000);
  loopMeasurements.push({ speed: 0.5, ...slow });
  await attachJson(testInfo, "practice-loop-measurements.json", loopMeasurements);
  expect(slow.wraps, `0.5× loop did not wrap: ${JSON.stringify(slow)}`).toBeGreaterThanOrEqual(1);

  await repeat.uncheck();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.enabled).toBe(false);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await seekWithTransportSlider(page, range.start);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? 0, { timeout: 8_000 }).toBeGreaterThan(range.end + 0.2);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const ordinaryPausedAt = await waitForStablePausedTime(page);
  await page.waitForTimeout(160);
  expect((await playerSnapshot(page)).currentTimeSeconds).toBeCloseTo(ordinaryPausedAt, 2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? 1).toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

test("Practice bookmarks survive save/reload and package import, while another MIDI starts without foreign data", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const initial = await loadStudioSong(page, { output: "synth", dimension: "2d" });
  const range = chooseLoopRange(initial);
  const sourceHash = initial.result.resource.sha256;
  const [sourceMidiBytes, alternateMidiBytes] = await Promise.all([
    readFile(studioMidiPath),
    readFile(alternateMidiPath),
  ]);
  expect(sourceMidiBytes.equals(alternateMidiBytes)).toBe(false);
  const revision = initial.result.revision;
  const performancePlanId = initial.result.performancePlan?.planId;
  const initialMusicalNotes = initial.result.document!.notes.map((note) => ({
    noteId: note.noteId,
    trackId: note.trackId,
    pitch: note.pitch,
    velocity: note.velocity,
    startSeconds: note.startSeconds,
    endSeconds: note.endSeconds,
    hand: note.hand,
    finger: note.finger,
    glissando: note.glissando,
    sourceNoteIds: note.sourceNoteIds,
    sourceEvent: note.sourceEvent,
  }));
  const { panel } = await practicePanel(page);

  await seekWithTransportSlider(page, range.start + 0.05);
  const bookmarkName = panel.getByRole("textbox", { name: "Bookmark name", exact: true });
  await bookmarkName.fill("Opening");
  await panel.getByRole("button", { name: "Add bookmark", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.bookmarks.length).toBe(1);

  const outsideTime = Math.min(initial.result.document!.durationSeconds, range.end + 0.4);
  await seekWithTransportSlider(page, outsideTime);
  await bookmarkName.fill("Temporary verse");
  await panel.getByRole("button", { name: "Add bookmark", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.bookmarks.length).toBe(2);

  const temporaryRow = panel.getByRole("listitem").filter({ hasText: "Temporary verse" });
  await temporaryRow.getByRole("button", { name: "Rename bookmark: Temporary verse", exact: true }).click();
  const renameInput = panel.getByRole("textbox", { name: "Rename bookmark", exact: true });
  await renameInput.fill("Verse");
  await renameInput.press("Enter");
  await expect(panel.getByRole("listitem").filter({ hasText: "Verse" })).toBeVisible();

  const openingRow = panel.getByRole("listitem").filter({ hasText: "Opening" });
  await openingRow.getByRole("button", { name: /^Go to bookmark: Opening/ }).click();
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? -1).toBeCloseTo(range.start + 0.05, 1);
  await panel.getByRole("listitem").filter({ hasText: "Verse" })
    .getByRole("button", { name: "Delete bookmark: Verse", exact: true }).click();
  await expect(panel.getByRole("listitem").filter({ hasText: "Verse" })).toHaveCount(0);

  await setLoopRangeFromPlayhead(page, panel, range);
  await panel.getByRole("checkbox", { name: "Repeat A–B", exact: true }).check();
  let finalPracticeState = (await playerSnapshot(page)).practiceState!;
  expect(finalPracticeState.loop).toEqual({ enabled: true, startSeconds: range.start, endSeconds: range.end });
  expect(finalPracticeState.bookmarks).toHaveLength(1);
  expect(finalPracticeState.sourceMidiSha256).toBe(sourceHash);

  const afterMetadataEdits = await playerSnapshot(page);
  expect(afterMetadataEdits.result.revision).toBe(revision);
  expect(afterMetadataEdits.result.performancePlan?.planId).toBe(performancePlanId);

  await saveStudioProject(page);
  await page.reload();
  await expectStudioCanvas(page, 90_000);
  const restored = await settledStudio(page, revision);
  expect(restored.practiceState).toEqual(finalPracticeState);
  expect(restored.result.projectId).toBe(initial.result.projectId);
  expect(restored.result.revision).toBe(revision);
  expect(restored.result.document?.projectId).toBe(initial.result.document?.projectId);
  expect(restored.result.document?.revision).toBe(initial.result.document?.revision);
  expect(restored.result.resource.sha256).toBe(sourceHash);
  expect(restored.result.document?.notes.map((note) => ({
    noteId: note.noteId,
    trackId: note.trackId,
    pitch: note.pitch,
    velocity: note.velocity,
    startSeconds: note.startSeconds,
    endSeconds: note.endSeconds,
    hand: note.hand,
    finger: note.finger,
    glissando: note.glissando,
    sourceNoteIds: note.sourceNoteIds,
    sourceEvent: note.sourceEvent,
  }))).toEqual(initialMusicalNotes);

  const restoredOpeningRow = panel.getByRole("listitem").filter({ hasText: "Opening" });
  await restoredOpeningRow.getByRole("button", { name: "Rename bookmark: Opening", exact: true }).click();
  const renameAfterReload = panel.getByRole("textbox", { name: "Rename bookmark", exact: true });
  await renameAfterReload.fill("Opening after reload");
  await renameAfterReload.press("Enter");
  await expect(panel.getByRole("listitem").filter({ hasText: "Opening after reload" })).toBeVisible();
  finalPracticeState = (await playerSnapshot(page)).practiceState!;
  await expect.poll(() => sessionPracticeState(page), { timeout: 15_000 }).toEqual(finalPracticeState);

  await page.reload();
  await expectStudioCanvas(page, 90_000);
  const recoveredAfterPracticeAutosave = await settledStudio(page, revision);
  expect(recoveredAfterPracticeAutosave.practiceState).toEqual(finalPracticeState);
  expect(recoveredAfterPracticeAutosave.result.projectId).toBe(initial.result.projectId);
  expect(recoveredAfterPracticeAutosave.result.revision).toBe(revision);

  const packagePath = await exportStudioPackage(page);
  const projectPackage = ProjectPackageSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
  expect(projectPackage.practiceState).toEqual(finalPracticeState);
  const sourceResource = projectPackage.resources.find((resource) =>
    resource.resourceId === projectPackage.document.sourceMidiResourceId);
  expect(sourceResource?.sha256).toBe(sourceHash);
  expect(projectPackage.practiceState?.sourceMidiSha256).toBe(sourceResource?.sha256);

  const freshContext = await browser.newContext();
  try {
    const importedPage = await freshContext.newPage();
    await importedPage.goto(new URL("/?empty=true", page.url()).href);
    await expect(importedPage.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
    await importedPage.locator("#project-file").setInputFiles(packagePath);
    await expectStudioCanvas(importedPage, 90_000);
    const imported = await settledStudio(importedPage, revision);
    expect(imported.practiceState).toEqual(finalPracticeState);
    expect(imported.practiceState?.sourceMidiSha256).toBe(imported.result.resource.sha256);

    await saveStudioProject(importedPage);
    await importedPage.locator("#midi-file").setInputFiles(alternateMidiPath);
    await expect.poll(async () => (await playerSnapshot(importedPage)).result.resource.sha256, { timeout: 90_000 })
      .not.toBe(sourceHash);
    const otherSong = await settledStudio(importedPage, 0);
    expect(otherSong.result.resource.sha256).not.toBe(sourceHash);
    expect(otherSong.practiceState?.bookmarks).toEqual([]);
    expect(otherSong.practiceState?.loop).toBeNull();
    expect(otherSong.practiceState?.sourceMidiSha256).toBe(otherSong.result.resource.sha256);
  } finally {
    await freshContext.close();
  }
});

test("Play Along restricts manual steps to A–B and an outside bookmark disables repeat before jumping; mobile text input leaves steps untouched", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = await loadStudioSong(page, { output: "synth", dimension: "2d" });
  const range = chooseLoopRange(initial);
  const outsideCandidate = pressTimes(initial)
    .map((time) => Math.ceil(time * 20) / 20)
    .find((time) => time >= range.end - 1e-9 && time <= initial.result.document!.durationSeconds);
  const outsideTime = outsideCandidate ?? initial.result.document!.durationSeconds;
  expect(outsideTime).toBeGreaterThanOrEqual(range.end);
  const { trigger, panel } = await practicePanel(page);

  await setLoopRangeFromPlayhead(page, panel, range);
  await seekWithTransportSlider(page, outsideTime);
  const bookmarkName = "Beyond B";
  await panel.getByRole("textbox", { name: "Bookmark name", exact: true }).fill(bookmarkName);
  await panel.getByRole("button", { name: "Add bookmark", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.bookmarks.length).toBe(1);
  await panel.getByRole("checkbox", { name: "Repeat A–B", exact: true }).check();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.enabled).toBe(true);

  await panel.getByRole("button", { name: "Play-along", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).viewMode).toBe("play_along");
  const controls = page.getByLabel("Play along practice controls");
  await expect(controls).toBeVisible();
  const stepCounter = controls.getByText(/Step \d+ of \d+/);
  await expect(stepCounter).toBeVisible();

  const firstStepTime = (await playerSnapshot(page)).currentTimeSeconds!;
  expect(firstStepTime).toBeGreaterThanOrEqual(range.start - 0.02);
  expect(firstStepTime).toBeLessThan(range.end);
  await controls.getByRole("button", { name: "Restart from beginning", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? -1).toBeCloseTo(firstStepTime, 2);

  const playAlongTimes = [firstStepTime];
  let manualWrapDetected = false;
  const nextStep = controls.getByRole("button", { name: "Next step", exact: true });
  for (let index = 0; index < 12 && !manualWrapDetected; index += 1) {
    const previousTime = (await playerSnapshot(page)).currentTimeSeconds!;
    await nextStep.click();
    await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? -1, { timeout: 5_000 })
      .not.toBe(previousTime);
    const nextTime = (await playerSnapshot(page)).currentTimeSeconds!;
    playAlongTimes.push(nextTime);
    expect(nextTime).toBeGreaterThanOrEqual(range.start - 0.02);
    expect(nextTime).toBeLessThan(range.end);
    manualWrapDetected = Math.abs(nextTime - firstStepTime) <= 0.015;
  }
  await attachJson(testInfo, "practice-play-along-step-times.json", { range, playAlongTimes, manualWrapDetected });
  expect(manualWrapDetected, `Manual next did not wrap within loop: ${JSON.stringify(playAlongTimes)}`).toBe(true);

  const bookmarkRow = panel.getByRole("listitem").filter({ hasText: bookmarkName });
  await bookmarkRow.getByRole("button", { name: /^Go to bookmark: Beyond B/ }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.enabled).toBe(false);
  const afterOutsideJump = await playerSnapshot(page);
  expect(afterOutsideJump.practiceState?.loop).toMatchObject({ startSeconds: range.start, endSeconds: range.end, enabled: false });
  expect(afterOutsideJump.currentTimeSeconds).toBeGreaterThanOrEqual(range.end - 0.02);

  const noStepRange = chooseNoStepRange(initial);
  const startInput = panel.getByRole("spinbutton", { name: "Loop start (seconds)", exact: true });
  const endInput = panel.getByRole("spinbutton", { name: "Loop end (seconds)", exact: true });
  if (noStepRange.start >= range.start) {
    await endInput.fill(noStepRange.end.toFixed(2));
    await endInput.press("Enter");
    await startInput.fill(noStepRange.start.toFixed(2));
    await startInput.press("Enter");
  } else {
    await startInput.fill(noStepRange.start.toFixed(2));
    await startInput.press("Enter");
    await endInput.fill(noStepRange.end.toFixed(2));
    await endInput.press("Enter");
  }
  await expect(startInput).toBeEnabled();
  await expect(endInput).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Reset repeat points", exact: true })).toBeEnabled();
  await expect(panel.getByRole("checkbox", { name: "Repeat A–B", exact: true })).toBeDisabled();
  await expect(panel).toContainText("This project has no playable steps for repeat.");
  await panel.getByRole("button", { name: "Reset repeat points", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop).toBeNull();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(panel).toBeVisible();
  const sheetBounds = await panel.boundingBox();
  const sheetTitle = page.getByRole("heading", { name: "Practice", exact: true });
  const titleBounds = await sheetTitle.boundingBox();
  expect(sheetBounds).not.toBeNull();
  expect(titleBounds).not.toBeNull();
  expect(titleBounds!.y).toBeGreaterThanOrEqual(sheetBounds!.y + 1);
  expect(titleBounds!.y + titleBounds!.height).toBeLessThanOrEqual(sheetBounds!.y + sheetBounds!.height - 1);
  const mobileScreenshot = testInfo.outputPath("practice-mobile-390.png");
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  await testInfo.attach("practice-mobile-390", { path: mobileScreenshot, contentType: "image/png" });
  await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const stepTextBeforeTyping = await stepCounter.textContent();
  const beforeTyping = await playerSnapshot(page);
  const mobileNameInput = panel.getByRole("textbox", { name: "Bookmark name", exact: true });
  await mobileNameInput.fill("text");
  await mobileNameInput.press("a");
  await mobileNameInput.press("Space");
  await mobileNameInput.press("s");
  const afterTyping = await playerSnapshot(page);
  expect(afterTyping.result.revision).toBe(beforeTyping.result.revision);
  expect(afterTyping.result.performancePlan?.planId).toBe(beforeTyping.result.performancePlan?.planId);
  expect(afterTyping.currentTimeSeconds).toBeCloseTo(beforeTyping.currentTimeSeconds!, 2);
  await expect(stepCounter).toHaveText(stepTextBeforeTyping!);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("default MuseScore SoundFont playback repeats a note-backed A–B window without hanging at the output boundary", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const initial = await loadStudioSong(page, { output: "soundfont", dimension: "2d" });
  const settings = await page.evaluate(async () => {
    const { getSettings } = await import("/src/settings/settingsStore.ts");
    const { BUILTIN_SOUNDFONT_ID } = await import("/src/audio/soundfont/builtinSoundfont.ts");
    return { settings: getSettings(), builtinId: BUILTIN_SOUNDFONT_ID };
  });
  expect(settings.settings.soundOutput).toBe("soundfont");
  expect(settings.settings.soundfontAssetId).toBe(settings.builtinId);

  const duration = initial.result.document?.durationSeconds ?? 0;
  const times = pressTimes(initial);
  const start = 0.25;
  const end = 6.25;
  expect(duration).toBeGreaterThan(end);
  expect(times.filter((time) => time >= start && time < end).length).toBeGreaterThanOrEqual(2);
  const range = { start, end, eventCount: times.filter((time) => time >= start && time < end).length };
  const initialPlayhead = (await playerSnapshot(page)).currentTimeSeconds!;
  expect(initialPlayhead).toBeLessThan(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? initialPlayhead, { timeout: 10_000 })
    .toBeGreaterThan(initialPlayhead + 0.2);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await playerSnapshot(page)).currentTimeSeconds ?? 1).toBeLessThanOrEqual(0);

  const { panel } = await practicePanel(page);
  const startInput = panel.getByRole("spinbutton", { name: "Loop start (seconds)", exact: true });
  const endInput = panel.getByRole("spinbutton", { name: "Loop end (seconds)", exact: true });
  await startInput.fill(start.toFixed(2));
  await startInput.press("Enter");
  await endInput.fill(end.toFixed(2));
  await endInput.press("Enter");
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.endSeconds).toBe(end);
  await panel.getByRole("checkbox", { name: "Repeat A–B", exact: true }).check();
  await expect.poll(async () => (await playerSnapshot(page)).practiceState?.loop?.enabled).toBe(true);
  await page.getByRole("combobox", { name: "Speed", exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30_000 });
  const measurement = await captureLoopWraps(page, range, 2, 35_000);
  await attachJson(testInfo, "practice-soundfont-loop-measurements.json", measurement);
  expect(measurement.wraps, `Default SoundFont did not complete two wraps: ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(2);
  expect(pageErrors).toEqual([]);
});
