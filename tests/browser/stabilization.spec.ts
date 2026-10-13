import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { M1AnalyzeMidiResultSchema, ProjectPackageSchema } from "@handthesia/contracts";

async function loadSong(page: Page) {
  await page.goto("/");
  await expect(page.locator("#analyze-button")).toBeEnabled();
  await page.locator("#fixture-select").selectOption("tracked-right-hand");
  await page.locator("#analyze-button").click();
  await expect(page.locator(".player-card")).toBeVisible({timeout: 45_000});
  await page.waitForFunction(() => window.__playerSnapshot && !window.__playerSnapshot.pending);
}

async function settled(page: Page, minimumRevision: number) {
  await page.waitForFunction(revision => {
    const snapshot = window.__playerSnapshot;
    return snapshot && !snapshot.pending && snapshot.result.revision >= revision;
  }, minimumRevision, {timeout: 60_000});
  const snapshot = await page.evaluate(() => window.__playerSnapshot!);
  const result = M1AnalyzeMidiResultSchema.parse(snapshot.result);
  expect(result.performancePlan?.fingeringPlanId).toBe(result.fingeringPlan?.planId);
  expect(result.motionPlan?.performancePlanId).toBe(result.performancePlan?.planId);
  return snapshot;
}

test("editor selection leaves playback alone; edits preserve IDs, history and exported markers", async ({page}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const externalRequests: string[] = [];
  page.on("request", request => {if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:4173/")) externalRequests.push(request.url());});
  let workers = 0;
  page.on("worker", () => workers++);
  await loadSong(page);
  const initial = await settled(page, 0);
  const originalIds = initial.result.document!.notes.map(note => note.noteId);
  await page.locator("#tab-btn-editor").click();
  const canvas = page.locator('[data-testid="piano-roll-viewport"] canvas');
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  const workerCount = workers;
  await page.waitForTimeout(650); // Exceeds the real replan debounce: selection must produce no job.
  expect(workers).toBe(workerCount);
  expect((await settled(page, 0)).result.revision).toBe(initial.result.revision);
  const toolbar = page.locator(".fingering-toolbar");
  await toolbar.getByRole("button", {name: "Finger 4", exact: true}).click();
  const edited = await settled(page, initial.result.revision + 1);
  expect(edited.result.document!.notes.map(note => note.noteId)).toEqual(originalIds);
  const pin = edited.result.document!.notes.find(note => note.finger === 4);
  expect(pin).toBeDefined();
  const undo = toolbar.getByRole("button", {name: /Undo/i});
  await expect(undo).toBeEnabled();
  await page.locator("#player-play-button").click();
  await expect(page.locator("#player-play-button")).toContainText("Pause");
  // Without selecting again, the same selected note and history must survive the returned plan.
  await toolbar.getByRole("button", {name: "Finger 3", exact: true}).click();
  const second = await settled(page, edited.result.revision + 1);
  await expect(page.locator("#player-play-button")).toContainText("Pause");
  expect(Number(await page.locator("#player-seek-slider").inputValue())).toBeGreaterThan(-2);
  await page.locator("#player-play-button").click();
  const pausedTime = Number(await page.locator("#player-seek-slider").inputValue());
  expect(second.result.document!.notes.find(note => note.noteId === pin!.noteId)?.finger).toBe(3);
  await undo.click();
  const undone = await settled(page, second.result.revision + 1);
  expect(undone.result.document!.notes.find(note => note.noteId === pin!.noteId)?.finger).toBe(4);
  expect(Math.abs(Number(await page.locator("#player-seek-slider").inputValue()) - pausedTime)).toBeLessThan(0.1);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#player-export-midi-button").click();
  const download = await downloadPromise;
  const file = await download.path();
  expect(file).not.toBeNull();
  await page.locator("#midi-file").setInputFiles(file!);
  await page.locator("#analyze-button").click();
  await expect(page.locator(".player-card")).toBeVisible({timeout: 45_000});
  const imported = await page.evaluate(() => window.__m1LastResult!);
  const reimportedPin = imported.document!.notes.find(note => note.pitch === pin!.pitch && Math.abs(note.startSeconds - pin!.startSeconds) < 0.001);
  expect(reimportedPin?.finger).toBe(4);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("latest profile and equal geometry reach live plans, package bytes and reload recovery", async ({page}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await loadSong(page);
  const initial = await settled(page, 0);
  await page.locator("#profile-modal-btn").click();
  await page.locator("#active-profile-select").selectOption("virtuoso");
  await page.locator("#active-profile-select").selectOption("small-hands");
  await page.locator('[aria-labelledby="profile-modal-title"]').getByRole("button", {name: "Close", exact: true}).click();
  await page.locator("#player-keystyle-select").selectOption("equal");
  const applied = await settled(page, initial.result.revision + 2);
  expect(applied.result.profile.profileId).toBe("small-hands");
  expect(applied.result.fingeringPlan!.profileId).toBe("small-hands");
  expect(applied.keyStyle).toBe("equal");
  expect(applied.result.document!.notes.map(note => note.noteId)).toEqual(initial.result.document!.notes.map(note => note.noteId));
  expect(applied.result.motionPlan).not.toEqual(initial.result.motionPlan);
  const packageDownload = page.waitForEvent("download");
  await page.locator("#player-export-json-button").click();
  const downloaded = await packageDownload;
  const packagePath = await downloaded.path();
  const json = JSON.parse(await readFile(packagePath!, "utf8"));
  const pkg = ProjectPackageSchema.parse(json);
  expect(pkg.profiles.some(profile => profile.profileId === "small-hands")).toBe(true);
  const resource = pkg.resources.find(resource => resource.resourceId === pkg.document.sourceMidiResourceId)!;
  expect(resource).toBeDefined();
  const encoded = json.resourcePayloads[resource.path];
  const bytes = Buffer.from(encoded, "base64");
  expect(bytes.byteLength).toBe(resource.byteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(resource.sha256);
  expect(json.fingeringPlan.profileId).toBe("small-hands");
  await page.locator("#tab-btn-split").click();
  await expect(page.locator("#tab-btn-split")).toHaveClass(/is-active/);
  expect(await page.evaluate(() => window.__playerSnapshot?.viewMode)).toBe("split");
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db", 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const snapshot = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = db.transaction("session", "readonly").objectStore("session").get("current_session");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    return {revision: (snapshot?.result as {revision?: number} | undefined)?.revision, viewMode: snapshot?.viewMode, plansState: snapshot?.plansState};
  }), {timeout: 15_000}).toEqual({revision: applied.result.revision, viewMode: "split", plansState: "valid"});
  await page.reload();
  await expect(page.locator(".player-card")).toBeVisible({timeout: 45_000});
  await expect(page.getByTestId("session-restore-notice")).toContainText("restored");
  const recovered = await settled(page, applied.result.revision);
  expect(recovered.result.document).toEqual(applied.result.document);
  expect(recovered.result.fingeringPlan).toEqual(applied.result.fingeringPlan);
  await expect(page.locator("#profile-modal-btn")).toContainText(/Small/i);
  await expect(page.locator("#player-keystyle-select")).toHaveValue("equal");
  await expect(page.locator("#tab-btn-split")).toHaveClass(/is-active/);
  expect(errors).toEqual([]);
});

test("reload recovers an autosaved pending edit and recalculates instead of applying stale plans", async ({page}) => {
  test.setTimeout(90_000);
  await loadSong(page);
  const initial = await settled(page, 0);
  // Delay the real manifest response to keep the new calculation in flight during autosave.
  const manifestRoute = "**/python-core/source_manifest.json";
  await page.route(manifestRoute, async route => {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await route.continue().catch(() => undefined); // The old request may be aborted by navigation.
  });
  await page.locator("#tab-btn-editor").click();
  await page.locator('[data-testid="piano-roll-viewport"] canvas').focus();
  await page.keyboard.press("ArrowRight");
  await page.locator(".fingering-toolbar").getByRole("button", {name: "Finger 4", exact: true}).click();
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const q = indexedDB.open("handthesia_db", 2); q.onsuccess = () => resolve(q.result);
    });
    const record = await new Promise<{plansState?: string; draftFingeringPlan?: {inputRevision: number}}>(resolve => {
      const q = db.transaction("session").objectStore("session").get("current_session"); q.onsuccess = () => resolve(q.result);
    });
    db.close();
    return {state: record?.plansState, revision: record?.draftFingeringPlan?.inputRevision};
  }), {timeout: 10_000}).toEqual({state: "recompute-required", revision: initial.result.revision + 1});
  const pending = await page.evaluate(() => window.__playerSnapshot!.draftPlan);
  const pin = pending.assignments.find(assignment => assignment.fingerMode === "manual" && assignment.finger === 4)!;
  expect(pin).toBeDefined();
  await page.unroute(manifestRoute);
  await page.reload();
  await expect(page.getByTestId("session-restore-notice")).toContainText("recalculating", {timeout: 30_000});
  const recovered = await settled(page, pending.inputRevision);
  expect(recovered.result.document!.notes.find(note => note.noteId === pin.noteId)?.finger).toBe(4);
  expect(recovered.result.fingeringPlan!.assignments.find(assignment => assignment.noteId === pin.noteId)?.finger).toBe(4);
});
