import { expect, test, type Page } from "@playwright/test";
import { exportStudioPackage, loadStudioSong, saveStudioProject, settledStudio } from "./studio-helpers";

async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Built-in melodies…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function waitForOpenedMelody(page: Page, timeout = 90_000) {
  await page.waitForFunction(() => Boolean(document.querySelector("#piano-canvas-container canvas")) || Boolean(window.__m1LastError), undefined, { timeout });
  const error = await page.evaluate(() => window.__m1LastError);
  expect(error?.slice(0, 1500) ?? null).toBeNull();
  await expect(page.locator("#piano-canvas-container canvas")).toBeVisible();
}

test("built-in melody opens, plays, edits, saves and restores with exact source identities", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Browse built-in melodies", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(163);
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("BRAHMS");
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("catalog-desktop.png") });
  await dialog.getByRole("button", { name: "Open Brahms' Lullaby", exact: true }).click();
  await waitForOpenedMelody(page);
  const initial = await settledStudio(page, 0);
  expect(initial.result.rawBaseline.fixtureId).toMatch(/^builtin-[a-f0-9]{64}$/);
  const sourceIds = initial.result.document!.notes.map(note => note.noteId);
  await expect(page.getByText("Brahms' Lullaby", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.getByRole("slider", { name: "Seek position" }).inputValue().then(Number), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Fingering", exact: true }).click();
  const canvas = page.locator("#piano-canvas-container canvas");
  await canvas.focus();
  await canvas.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.__playerSnapshot?.editorSelectedNoteIds?.length ?? 0)).toBeGreaterThan(0);
  const selectedId = await page.evaluate(() => window.__playerSnapshot!.editorSelectedNoteIds![0]!);
  await canvas.press("3");
  const edited = await settledStudio(page, 1);
  expect(edited.draftPlan.assignments.find(assignment => assignment.noteId === selectedId)).toMatchObject({ finger: 3, fingerMode: "manual" });

  const secondDialog = await openLibrary(page);
  await secondDialog.getByRole("searchbox", { name: "Search melodies" }).fill("A Tisket");
  await secondDialog.getByRole("button", { name: "Open A Tisket, A Tasket", exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: "Unsaved changes", exact: true });
  await expect(guard).toBeVisible({ timeout: 90_000 });
  expect(await page.evaluate(() => window.__playerSnapshot!.result.projectId)).toBe(initial.result.projectId);
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await saveStudioProject(page);
  await page.reload();
  await expect(page.locator("#piano-canvas-container canvas")).toBeVisible({ timeout: 90_000 });
  const restored = await settledStudio(page, edited.result.revision);
  expect(restored.result.document!.notes.map(note => note.noteId)).toEqual(sourceIds);
  expect(restored.draftPlan.assignments.find(assignment => assignment.noteId === selectedId)).toMatchObject({ finger: 3, fingerMode: "manual" });
  expect(restored.result.resource.sha256).toBe(initial.result.resource.sha256);
  const packagePath = await exportStudioPackage(page);
  const fresh = await browser.newContext();
  try {
    const importedPage = await fresh.newPage();
    await importedPage.goto(new URL("/", page.url()).href);
    await expect(importedPage.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
    await importedPage.locator("#project-file").setInputFiles(packagePath);
    await waitForOpenedMelody(importedPage);
    const imported = await settledStudio(importedPage, edited.result.revision);
    expect(imported.result.document!.notes.map(note => note.noteId)).toEqual(sourceIds);
    expect(imported.result.resource.sha256).toBe(initial.result.resource.sha256);
    expect(imported.draftPlan.assignments.find(assignment => assignment.noteId === selectedId)).toMatchObject({ finger: 3, fingerMode: "manual" });
  } finally { await fresh.close(); }
  expect(errors).toEqual([]);
});

test("mobile catalog handles search, Escape, retry and damaged assets without replacing the open project", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await loadStudioSong(page);
  const projectId = await page.evaluate(() => window.__playerSnapshot!.result.projectId);
  let manifestRequests = 0;
  await page.route("**/builtin-melodies/manifest.json", route => {
    manifestRequests += 1;
    return manifestRequests === 1 ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue();
  });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const trigger = page.getByRole("button", { name: "Built-in melodies", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("Could not load built-in melodies");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(163);
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("no-such-melody-xyz");
  await expect(dialog).toContainText("No melodies match");
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("scales");
  await page.screenshot({ path: testInfo.outputPath("catalog-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("A la Claire Fontaine");
  await page.route("**/builtin-melodies/files/*.mid", route => route.fulfill({ status: 200, body: "damaged" }));
  await dialog.getByRole("button", { name: "Open A la Claire Fontaine", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".studio-status-message")).toContainText("was not opened");
  expect(await page.evaluate(() => window.__playerSnapshot!.result.projectId)).toBe(projectId);
  expect(await page.evaluate(() => window.__playerSnapshot!.scene!.keyCount)).toBe(88);
});

test("the largest built-in MIDI opens through the real analysis Worker", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.goto("/?empty=true");
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 30_000 });
  const dialog = await openLibrary(page);
  await dialog.getByRole("searchbox", { name: "Search melodies" }).fill("Megalovania");
  const start = Date.now();
  await dialog.getByRole("button", { name: "Open Megalovania", exact: true }).click();
  await waitForOpenedMelody(page, 180_000);
  const snapshot = await settledStudio(page, 0);
  expect(snapshot.result.document!.notes.length).toBeGreaterThan(1000);
  const analysisElapsedMs = Date.now() - start;
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.getByRole("slider", { name: "Seek position" }).inputValue().then(Number), { timeout: 45_000 }).toBeGreaterThan(5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  expect(await page.evaluate(() => window.__playerSnapshot!.scene!.keyCount)).toBe(88);
  await testInfo.attach("largest-built-in-analysis", { contentType: "application/json", body: JSON.stringify({ elapsedMs: analysisElapsedMs, notes: snapshot.result.document!.notes.length, duration: snapshot.result.document!.durationSeconds, playedBeyondSeconds: 5 }) });
});
