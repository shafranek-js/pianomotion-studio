import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { configureStudioTestOutput, expectStudioCanvas, settledStudio, studioCanvas, studioMidiPath, waitForLoadingToClear } from "./studio-helpers";

type RecoveryProbe = {
  defaultMidiFetchStarted: boolean;
  defaultMidiFetchCompleted?: boolean;
  defaultMidiSignalAborted?: boolean;
  defaultAnalysisRequests?: number;
  defaultSignal?: AbortSignal | null;
  releaseDefaultMidiFetch(): Promise<void>;
  heldWorkerResult: boolean;
  heldWorkerResultData?: unknown;
  heldWorker: Worker | null;
  heldWorkerTerminated: boolean;
  releaseHeldWorkerResult(): void;
};

declare global {
  interface Window {
    __sessionRecoveryProbe?: RecoveryProbe;
  }
}

async function editSelectedNoteToFive(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Fingering", exact: true }).click();
  const canvas = studioCanvas(page, "2d");
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await canvas.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.__playerSnapshot?.editorSelectedNoteIds?.length ?? 0)).toBeGreaterThan(0);
  const noteId = await page.evaluate(() => window.__playerSnapshot!.editorSelectedNoteIds![0]!);
  await canvas.press("5");
  const edited = await settledStudio(page, 1);
  expect(edited.draftPlan.assignments.find(assignment => assignment.noteId === noteId)).toMatchObject({ finger: 5, fingerMode: "manual" });
  return { noteId, edited };
}

test("a delayed default melody cannot replace an imported MIDI after a manual fingering edit", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    let releaseFetch!: () => void;
    let markStarted!: () => void;
    let markFetchCompleted!: () => void;
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetchCompleted = new Promise<void>(resolve => { markFetchCompleted = resolve; });
    const probe = {
      defaultMidiFetchStarted: false,
      defaultMidiFetchCompleted: false,
      defaultMidiSignalAborted: false,
      defaultSignal: undefined as AbortSignal | null | undefined,
      defaultAnalysisRequests: 0,
      releaseDefaultMidiFetch: async () => {
        releaseFetch();
        await fetchCompleted;
        await new Promise(resolve => setTimeout(resolve, 150));
      },
    };
    window.__sessionRecoveryProbe = probe as unknown as RecoveryProbe;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/builtin-melodies\/files\/[a-f0-9]+\.mid(?:\?|$)/i.test(url) && !probe.defaultMidiFetchStarted) {
        probe.defaultMidiFetchStarted = true;
        probe.defaultSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        markStarted();
        await fetchGate;
        const response = await nativeFetch(input, { ...init, signal: null });
        await response.clone().arrayBuffer();
        probe.defaultMidiSignalAborted = probe.defaultSignal?.aborted ?? false;
        probe.defaultMidiFetchCompleted = true;
        markFetchCompleted();
        return response;
      }
      return nativeFetch(input, init);
    }) as typeof window.fetch;
    const nativePostMessage = Worker.prototype.postMessage as unknown as (this: Worker, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => void;
    function trackedPostMessage(this: Worker, message: unknown, transfer: Transferable[]): void;
    function trackedPostMessage(this: Worker, message: unknown, options?: StructuredSerializeOptions): void;
    function trackedPostMessage(this: Worker, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
      const request = message as { type?: unknown; options?: { fixtureId?: unknown } } | null;
      if (request?.type === "analyze-midi" && typeof request.options?.fixtureId === "string" && request.options.fixtureId.startsWith("builtin-")) {
        probe.defaultAnalysisRequests += 1;
      }
      if (Array.isArray(transferOrOptions)) nativePostMessage.call(this, message, transferOrOptions);
      else if (transferOrOptions) nativePostMessage.call(this, message, transferOrOptions);
      else nativePostMessage.call(this, message);
    }
    Worker.prototype.postMessage = trackedPostMessage;
    Object.assign(probe, { waitForDefaultMidiFetch: () => started });
  });

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__sessionRecoveryProbe?.defaultMidiFetchStarted), undefined, { timeout: 90_000 });
  // The start-up loading score now covers the workspace while the held default
  // fetch is pending, so the welcome controls are deliberately unreachable here.
  // The file input still accepts the replacement MIDI directly.
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);
  await waitForLoadingToClear(page);
  const opened = await settledStudio(page, 0);
  const { noteId, edited } = await editSelectedNoteToFive(page);
  const projectId = edited.result.projectId;
  const revision = edited.result.revision;

  const defaultSignalAborted = await page.evaluate(() => {
    const probe = window.__sessionRecoveryProbe!;
    return probe.defaultSignal?.aborted ?? false;
  });
  expect(defaultSignalAborted).toBe(true);
  await page.evaluate(() => { void window.__sessionRecoveryProbe!.releaseDefaultMidiFetch(); });
  await page.waitForFunction(() => Boolean(window.__sessionRecoveryProbe?.defaultMidiFetchCompleted), undefined, { timeout: 30_000 });
  const defaultAnalysisRequests = await page.evaluate(() => window.__sessionRecoveryProbe!.defaultAnalysisRequests);
  expect(defaultAnalysisRequests).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__playerSnapshot?.result.projectId)).toBe(projectId);
  const afterDefaultLoad = await page.evaluate(() => window.__playerSnapshot!);
  expect(afterDefaultLoad.result.revision).toBe(revision);
  expect(afterDefaultLoad.draftPlan.assignments.find(assignment => assignment.noteId === noteId)).toMatchObject({ finger: 5, fingerMode: "manual" });
  expect(afterDefaultLoad.result.resource.sha256).toBe(opened.result.resource.sha256);
});

test("an explicit open supersedes a saved-session restore even after its real Worker finishes", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?empty=true");
  await waitForLoadingToClear(page);
  await configureStudioTestOutput(page);
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);
  await waitForLoadingToClear(page);
  const seeded = await settledStudio(page, 0);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save project", exact: true }).click();
  await expect(page.locator('.studio-save-state[data-kind="saved"]')).toBeVisible();

  await page.addInitScript(() => {
    const probe = {
      heldWorkerResult: false,
      heldWorker: null as Worker | null,
      heldWorkerResultData: undefined as unknown,
      heldWorkerTerminated: false,
      releaseHeldWorkerResult: () => {
        const worker = probe.heldWorker;
        if (!worker || probe.heldWorkerResultData === undefined) return;
        worker.dispatchEvent(new MessageEvent("message", { data: probe.heldWorkerResultData }));
      },
    };
    window.__sessionRecoveryProbe = probe as unknown as RecoveryProbe;

    const NativeWorker = window.Worker;
    class RecoveryWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (!/midi-analysis(?:-ts)?\.worker/i.test(String(scriptURL))) return;
        this.addEventListener("message", event => {
          const data = (event as MessageEvent<unknown>).data as { type?: unknown } | null;
          if (probe.heldWorkerResult || data?.type !== "analysis-result") return;
          probe.heldWorkerResult = true;
          probe.heldWorker = this;
          probe.heldWorkerResultData = data;
          event.stopImmediatePropagation();
        });
      }

      override terminate(): void {
        if (probe.heldWorker === this) probe.heldWorkerTerminated = true;
        super.terminate();
      }
    }
    window.Worker = RecoveryWorker;
  });

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__sessionRecoveryProbe?.heldWorkerResult), undefined, { timeout: 90_000 });
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  await expectStudioCanvas(page);
  const opened = await settledStudio(page, 0);
  expect(opened.result.projectId).not.toBe(seeded.result.projectId);
  await expect.poll(() => page.evaluate(() => window.__sessionRecoveryProbe!.heldWorkerTerminated)).toBe(true);

  await page.evaluate(() => window.__sessionRecoveryProbe!.releaseHeldWorkerResult());
  await expect.poll(() => page.evaluate(() => window.__playerSnapshot?.result.projectId)).toBe(opened.result.projectId);
  expect((await page.evaluate(() => window.__playerSnapshot!)).result.revision).toBe(opened.result.revision);
});

test("explicit Save restores a named MIDI, camera, view mode, and manual fingering intent", async ({ page }) => {
  test.setTimeout(240_000);
  const bytes = await readFile(studioMidiPath);
  await page.goto("/?empty=true");
  await waitForLoadingToClear(page);
  await configureStudioTestOutput(page);
  await page.locator("#midi-file").setInputFiles({ name: "Named Etude.mid", mimeType: "audio/midi", buffer: bytes });
  await expectStudioCanvas(page);
  await waitForLoadingToClear(page);
  const imported = await settledStudio(page, 0);
  const { noteId, edited } = await editSelectedNoteToFive(page);

  await page.getByRole("button", { name: "Performance", exact: true }).click();
  await page.getByTestId("studio-3d-view-toggle").click();
  await page.getByTestId("studio-header-camera-hud").getByRole("button", { name: /Overhead/ }).click();
  await page.getByRole("button", { name: "Play along", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play along", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save project", exact: true }).click();
  await expect(page.locator('.studio-save-state[data-kind="saved"]')).toBeVisible();

  const savedRecovery = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("handthesia_db", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ projectName: string; viewMode: string; sceneView: { dimension: string; cameraPreset: string }; draftFingeringPlan: { assignments: Array<{ noteId: string; finger: number; fingerMode?: string }> } }>((resolve, reject) => {
        const request = db.transaction("session", "readonly").objectStore("session").get("current_session");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  expect(savedRecovery).toMatchObject({
    projectName: "Named Etude.mid",
    viewMode: "play_along",
    sceneView: { dimension: "3d", cameraPreset: "overhead" },
  });
  expect(savedRecovery.draftFingeringPlan.assignments.find(assignment => assignment.noteId === noteId)).toMatchObject({ finger: 5, fingerMode: "manual" });

  await page.reload();
  await expectStudioCanvas(page);
  await waitForLoadingToClear(page);
  const restored = await settledStudio(page, edited.result.revision);
  expect(restored.result.resource.sha256).toBe(imported.result.resource.sha256);
  expect(restored.draftPlan.assignments.find(assignment => assignment.noteId === noteId)).toMatchObject({ finger: 5, fingerMode: "manual" });
  expect(restored.viewMode).toBe("play_along");
  await expect(page.locator(".studio-project-name")).toContainText("Named Etude.mid");
  await expect(studioCanvas(page, "3d")).toBeVisible();
  await expect(page.getByTestId("studio-header-camera-hud").getByRole("button", { name: /Overhead/ })).toHaveAttribute("aria-pressed", "true");
});
