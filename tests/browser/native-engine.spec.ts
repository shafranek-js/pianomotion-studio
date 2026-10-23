import { expect, test, type Page } from "@playwright/test";
import type { M1AnalyzeMidiResult, MotionPose } from "@handthesia/contracts";
import { expectStudioCanvas, openStudioInspector, settledStudio, studioCanvas, studioMidiPath, waitForLoadingToClear } from "./studio-helpers";
import fs from "node:fs/promises";

type WorkerTraceEntry = {
  direction: "created" | "request" | "response";
  url: string;
  type?: string;
  requestId?: string;
  projectId?: string;
  revision?: number;
  engineVersion?: string;
  status?: string;
  error?: string;
  poses?: MotionPose[];
};

type AcceptanceSnapshot = {
  result: M1AnalyzeMidiResult;
  draftPlan: NonNullable<M1AnalyzeMidiResult["fingeringPlan"]>;
  editorSelectedNoteIds?: string[];
};

const nativeWorkerName = "midi-analysis-ts.worker";
const pythonWorkerName = "midi-analysis.worker";

async function workerTrace(page: Page): Promise<WorkerTraceEntry[]> {
  return page.evaluate(() =>
    ((window as unknown as { __nativeEngineWorkerTrace?: WorkerTraceEntry[] }).__nativeEngineWorkerTrace ?? []),
  );
}

async function waitForWorkerJob(
  page: Page,
  workerName: string,
  requestType: string,
  traceOffset: number,
): Promise<WorkerTraceEntry> {
  await expect.poll(async () => {
    const entries = await workerTrace(page);
    const request = entries.slice(traceOffset).find(entry =>
      entry.direction === "request" && entry.url.includes(workerName) && entry.type === requestType,
    );
    if (!request?.requestId) return null;
    return entries.find(entry =>
      entry.direction === "response" && entry.requestId === request.requestId &&
      (entry.type === "worker-error" || entry.type === responseTypeFor(requestType)),
    ) ?? null;
  }, { timeout: 90_000, intervals: [100, 250, 500] }).not.toBeNull();

  const entries = await workerTrace(page);
  const request = entries.slice(traceOffset).find(entry =>
    entry.direction === "request" && entry.url.includes(workerName) && entry.type === requestType,
  );
  if (!request?.requestId) throw new Error(`No ${requestType} request reached ${workerName}.`);
  const response = entries.find(entry =>
    entry.direction === "response" && entry.requestId === request.requestId &&
    (entry.type === "worker-error" || entry.type === responseTypeFor(requestType)),
  );
  if (!response) throw new Error(`No terminal response for ${requestType} request ${request.requestId}.`);
  expect(response.type, response.error ?? `Worker response for ${requestType}`).toBe(responseTypeFor(requestType));
  return response;
}

function responseTypeFor(requestType: string): string {
  switch (requestType) {
    case "analyze-midi": return "analysis-result";
    case "replan-document": return "replan-document-result";
    case "sample-motion": return "sample-motion-result";
    default: throw new Error(`Unexpected Worker request type: ${requestType}`);
  }
}

async function chooseEngine(page: Page, engine: "python" | "typescript", workerName: string) {
  await openStudioInspector(page, "Diagnostics");
  const selector = page.locator("#studio-calculation-engine");
  await expect(selector).toBeEnabled();
  const traceOffset = (await workerTrace(page)).length;
  await selector.selectOption(engine);
  await expect(selector).toHaveValue(engine);
  const response = await waitForWorkerJob(page, workerName, "replan-document", traceOffset);
  const snapshot = await settledStudio(page, 0);
  return { response, snapshot };
}

async function editFirstNoteAndReplan(page: Page) {
  await page.getByRole("button", { name: "Fingering", exact: true }).click();
  const canvas = studioCanvas(page, "2d");
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await canvas.press("ArrowRight");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __playerSnapshot?: AcceptanceSnapshot }).__playerSnapshot?.editorSelectedNoteIds?.length ?? 0,
  )).toBeGreaterThan(0);

  const selectedNoteId = await page.evaluate(() =>
    (window as unknown as { __playerSnapshot: AcceptanceSnapshot }).__playerSnapshot.editorSelectedNoteIds![0]!,
  );
  const initial = await page.evaluate(() => (window as unknown as { __playerSnapshot: AcceptanceSnapshot }).__playerSnapshot);
  const assignment = initial.draftPlan.assignments.find((item: { noteId: string; finger: number | null }) => item.noteId === selectedNoteId);
  if (!assignment) throw new Error(`Selected note ${selectedNoteId} has no editable fingering assignment.`);
  const finger = assignment.finger === 1 ? 2 : 1;
  const minimumRevision = initial.result.revision + 1;
  const traceOffset = (await workerTrace(page)).length;
  await page.getByRole("button", { name: `Finger ${finger}`, exact: true }).click();

  const response = await waitForWorkerJob(page, nativeWorkerName, "replan-document", traceOffset);
  const edited = await settledStudio(page, minimumRevision);
  expect(edited.result.fingeringPlan!.assignments.find((item: { noteId: string }) => item.noteId === selectedNoteId)).toMatchObject({
    finger,
    fingerMode: "manual",
  });
  return { selectedNoteId, finger, edited, response };
}

function inspectAnatomicalPoses(poses: MotionPose[]) {
  let issueCount = 0;
  const examples: string[] = [];
  const issue = (message: string) => {
    issueCount += 1;
    if (examples.length < 16) examples.push(message);
  };
  if (poses.length === 0) issue("no poses returned");

  for (const [poseIndex, pose] of poses.entries()) {
    const prefix = `pose ${poseIndex} (${pose.hand} @ ${pose.transportTimeSeconds}s)`;
    const kinds = pose.bones.reduce<Record<string, number>>((counts, bone) => {
      counts[bone.kind] = (counts[bone.kind] ?? 0) + 1;
      return counts;
    }, {});
    for (const [kind, expected] of [["metacarpal", 5], ["proximal", 5], ["middle", 4], ["distal", 5]] as const) {
      if (kinds[kind] !== expected) issue(`${prefix}: expected ${expected} ${kind} bones, received ${kinds[kind] ?? 0}`);
    }
    if ((kinds.forearm ?? 0) < 1) issue(`${prefix}: missing forearm geometry`);
    if (pose.joints.filter(joint => joint.kind === "tip").length < 5) issue(`${prefix}: fewer than five fingertip joints`);
    const wristJoints = pose.joints.filter(joint => joint.kind === "wrist");
    if (wristJoints.length < 2) {
      issue(`${prefix}: expected two wrist joints, received ${wristJoints.length}`);
    } else {
      const wristSpan = Math.hypot(
        wristJoints[1]!.point[0] - wristJoints[0]!.point[0],
        wristJoints[1]!.point[1] - wristJoints[0]!.point[1],
        wristJoints[1]!.point[2] - wristJoints[0]!.point[2],
      );
      if (!(wristSpan > 0.25 && wristSpan < 6)) issue(`${prefix}: wrist span ${wristSpan.toFixed(3)}in is outside 0.25..6in`);
    }

    for (const bone of pose.bones) {
      const coordinates = [...bone.a, ...bone.b];
      if (!coordinates.every(Number.isFinite)) issue(`${prefix}: ${bone.kind} has non-finite coordinates`);
      const length = Math.hypot(
        bone.b[0] - bone.a[0],
        bone.b[1] - bone.a[1],
        bone.b[2] - bone.a[2],
      );
      if (!(length > 0.01)) issue(`${prefix}: ${bone.kind} segment collapsed to ${length.toFixed(3)}in`);
      if (["metacarpal", "proximal", "middle", "distal"].includes(bone.kind)) {
        // Finger segments use keyboard-local inches. Four inches is a generous
        // upper bound for the default anatomy and catches NaN-masked zero tips
        // as well as the ~24-inch phalanges seen in the current Chopsticks trace.
        if (length > 4) issue(`${prefix}: ${bone.kind} segment is ${length.toFixed(3)}in, above the 4in anatomical bound`);
      } else {
        // Forearm length is naturally much larger than finger segments.
        if (!(length < 30)) issue(`${prefix}: ${bone.kind} segment is ${length.toFixed(3)}in, above the 30in bound`);
      }
    }
    for (const joint of pose.joints) {
      if (!joint.point.every(Number.isFinite)) issue(`${prefix}: ${joint.kind} joint has non-finite coordinates`);
    }
  }
  return { poseCount: poses.length, issueCount, examples };
}

test("native TypeScript Worker loads, replans, streams real hand poses, and retains Chopsticks and imported MIDI", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  const networkFailures: { url: string; error: string | null }[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const failure = { url: request.url(), error: request.failure()?.errorText ?? null };
    networkFailures.push(failure);
    console.error("Native acceptance request failed:", JSON.stringify(failure));
  });
  await page.setViewportSize({ width: 1920, height: 1080 });

  // This wraps the browser's real Worker constructor and records messages while
  // forwarding every request to the actual module Worker. It does not replace the engine.
  await page.addInitScript(() => {
    type TraceRecord = Record<string, unknown>;
    const target = window as unknown as { __nativeEngineWorkerTrace: TraceRecord[] };
    target.__nativeEngineWorkerTrace = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const workerUrl = String(url);
        if (!workerUrl.includes("midi-analysis")) return;
        const trace = target.__nativeEngineWorkerTrace;
        trace.push({ direction: "created", url: workerUrl });

        const send = this.postMessage.bind(this);
        this.postMessage = ((message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
          const data = message as Record<string, unknown>;
          trace.push({
            direction: "request",
            url: workerUrl,
            type: data.type,
            requestId: data.requestId,
            projectId: data.projectId,
            revision: data.revision,
            engineVersion: data.engineVersion,
          });
          return transfer === undefined ? send(message) : send(message, transfer as Transferable[]);
        }) as typeof this.postMessage;

        this.addEventListener("message", event => {
          const data = event.data as Record<string, unknown>;
          const traceEntry: TraceRecord = {
            direction: "response",
            url: workerUrl,
            type: data.type,
            requestId: data.requestId,
            projectId: data.projectId,
            revision: data.revision,
            engineVersion: data.engineVersion,
            status: data.status,
          };
          if (data.type === "sample-motion-result" && Array.isArray(data.poses)) traceEntry.poses = data.poses;
          if (data.type === "analysis-result") {
            const initialWindow = data.initialMotionWindow as { poses?: unknown } | undefined;
            if (Array.isArray(initialWindow?.poses)) traceEntry.poses = initialWindow.poses;
          }
          if (data.type === "worker-error") {
            traceEntry.error = (data.error as { message?: unknown } | undefined)?.message;
          }
          trace.push(traceEntry);
        });
      }
    };
  });

  await page.goto("/?empty=true");
  await expect(page).toHaveTitle("PianoMotion Studio");
  await waitForLoadingToClear(page);
  await expect(page.getByRole("button", { name: "Play demo song", exact: true })).toBeEnabled({ timeout: 60_000 });

  // Select TypeScript before opening the built-in so the MIDI is analyzed by its real Worker.
  await page.getByRole("button", { name: "Open preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  await expect(preferences).toBeVisible();
  await preferences.locator("#settings-calculation-engine").selectOption("typescript");
  await expect(preferences.locator("#settings-calculation-engine")).toHaveValue("typescript");
  await expect.poll(() => page.evaluate(async () =>
    (await import("/src/settings/settingsStore.ts")).getSettings().calculationEngine,
  )).toBe("typescript");
  await preferences.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Built-in melodies…", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Built-in melodies", exact: true });
  await library.getByRole("searchbox", { name: "Search melodies" }).fill("Chopsticks");
  const nativeAnalyzeOffset = (await workerTrace(page)).length;
  await library.getByRole("button", { name: "Open Chopsticks", exact: true }).click();
  const nativeAnalysis = await waitForWorkerJob(page, nativeWorkerName, "analyze-midi", nativeAnalyzeOffset);
  expect(nativeAnalysis.status).toBe("loaded");
  expect(nativeAnalysis.poses?.length).toBeGreaterThan(0);
  const startupGeometry = inspectAnatomicalPoses(nativeAnalysis.poses!);
  await expectStudioCanvas(page, 90_000);
  const chopsticks = await settledStudio(page, 0);
  await testInfo.attach("native-chopsticks-startup", { contentType: "image/png", body: await page.screenshot({ fullPage: true }) });
  expect(chopsticks.result.rawBaseline.fixtureId).toMatch(/^builtin-[a-f0-9]{64}$/);
  expect(chopsticks.result.document!.notes.length).toBeGreaterThan(0);

  let trace = await workerTrace(page);
  expect(trace.some(entry => entry.direction === "created" && entry.url.includes(nativeWorkerName))).toBe(true);
  expect(trace.some(entry => entry.direction === "request" && entry.url.includes(nativeWorkerName) && entry.type === "analyze-midi")).toBe(true);

  // A real engine round trip verifies that project source identity survives worker replacement.
  const chopsticksIdentity = {
    projectId: chopsticks.result.projectId,
    resourceHash: chopsticks.result.resource.sha256,
    sourceNoteIds: chopsticks.result.rawBaseline.sourceNotes.map((note: { noteId: string }) => note.noteId),
  };
  const edited = await editFirstNoteAndReplan(page);
  const switchedToPython = await chooseEngine(page, "python", pythonWorkerName);
  expect(switchedToPython.response.projectId).toBe(chopsticksIdentity.projectId);
  expect(switchedToPython.snapshot.result.projectId).toBe(chopsticksIdentity.projectId);
  expect(switchedToPython.snapshot.result.resource.sha256).toBe(chopsticksIdentity.resourceHash);
  expect(switchedToPython.response.engineVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(switchedToPython.response.engineVersion).toBe(switchedToPython.snapshot.result.engineVersion);
  expect(switchedToPython.snapshot.result.rawBaseline.sourceNotes.map((note: { noteId: string }) => note.noteId)).toEqual(chopsticksIdentity.sourceNoteIds);
  expect(switchedToPython.snapshot.result.fingeringPlan!.assignments.find((item: { noteId: string }) => item.noteId === edited.selectedNoteId)).toMatchObject({
    finger: edited.finger,
    fingerMode: "manual",
  });

  const switchedToNative = await chooseEngine(page, "typescript", nativeWorkerName);
  expect(switchedToNative.response.projectId).toBe(chopsticksIdentity.projectId);
  expect(switchedToNative.snapshot.result.projectId).toBe(chopsticksIdentity.projectId);
  expect(switchedToNative.snapshot.result.resource.sha256).toBe(chopsticksIdentity.resourceHash);
  expect(switchedToNative.response.engineVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(switchedToNative.response.engineVersion).toBe(switchedToNative.snapshot.result.engineVersion);
  expect(switchedToNative.snapshot.result.rawBaseline.sourceNotes.map((note: { noteId: string }) => note.noteId)).toEqual(chopsticksIdentity.sourceNoteIds);
  expect(switchedToNative.snapshot.result.fingeringPlan!.assignments.find((item: { noteId: string }) => item.noteId === edited.selectedNoteId)).toMatchObject({
    finger: edited.finger,
    fingerMode: "manual",
  });

  const undoOffset = (await workerTrace(page)).length;
  await expect(studioCanvas(page, "2d")).toBeVisible();
  await studioCanvas(page, "2d").focus();
  await page.keyboard.press("Control+z");
  await waitForWorkerJob(page, nativeWorkerName, "replan-document", undoOffset);
  const undone = await settledStudio(page, edited.edited.result.revision + 1);
  expect(undone.result.fingeringPlan!.assignments.find((item: { noteId: string; fingerMode?: string }) => item.noteId === edited.selectedNoteId)?.fingerMode).not.toBe("manual");

  const redoOffset = (await workerTrace(page)).length;
  await expect(studioCanvas(page, "2d")).toBeVisible();
  await studioCanvas(page, "2d").focus();
  await page.keyboard.press("Control+y");
  const redoResponse = await waitForWorkerJob(page, nativeWorkerName, "replan-document", redoOffset);
  const redone = await settledStudio(page, undone.result.revision + 1);
  expect(redoResponse.projectId).toBe(chopsticksIdentity.projectId);
  expect(redone.result.fingeringPlan!.assignments.find((item: { noteId: string }) => item.noteId === edited.selectedNoteId)).toMatchObject({
    finger: edited.finger,
    fingerMode: "manual",
  });

  // Real playback crosses 9 -> 10 seconds. String-sorted timestamps previously
  // produced invalid coverage and the user's incomplete-window calculation error.
  await page.getByRole("button", { name: "Performance", exact: true }).click();
  await page.getByRole("slider", { name: "Seek position", exact: true }).evaluate(element => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "8.75");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.getByRole("slider", { name: "Seek position", exact: true }).inputValue().then(Number),
    { timeout: 45_000 }).toBeGreaterThan(11.25);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Calculation error", { exact: true })).toHaveCount(0);

  // Seeking beyond the bounded initial four-second window forces a true Worker sample request.
  const chopsticksDuration = redone.result.document!.durationSeconds;
  expect(chopsticksDuration).toBeGreaterThan(5);
  const seekTarget = Math.min(chopsticksDuration - 0.5, Math.max(5, chopsticksDuration * 0.75));
  const sampleOffset = (await workerTrace(page)).length;
  await page.getByRole("slider", { name: "Seek position", exact: true }).evaluate((element, targetTime) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(targetTime));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, seekTarget);
  await expect.poll(() => page.getByRole("slider", { name: "Seek position", exact: true }).inputValue().then(Number))
    .toBeGreaterThan(4);
  const sampleResponse = await waitForWorkerJob(page, nativeWorkerName, "sample-motion", sampleOffset);
  expect(sampleResponse.projectId).toBe(chopsticksIdentity.projectId);
  expect(sampleResponse.poses?.length).toBeGreaterThan(0);
  const sampledGeometry = inspectAnatomicalPoses(sampleResponse.poses!);
  await testInfo.attach("native-chopsticks-after-seek", { contentType: "image/png", body: await page.screenshot({ fullPage: true }) });

  // Open the real MIDI file fixture after native replan/seek and verify source bytes and IDs survive another replan.
  const previousProjectId = redone.result.projectId;
  const fileAnalysisOffset = (await workerTrace(page)).length;
  await page.locator("#midi-file").setInputFiles(studioMidiPath);
  const fileAnalysis = await waitForWorkerJob(page, nativeWorkerName, "analyze-midi", fileAnalysisOffset);
  expect(fileAnalysis.status).toBe("loaded");
  const replaceDialog = page.getByRole("alertdialog", { name: "Unsaved changes", exact: true });
  await expect(replaceDialog).toBeVisible({ timeout: 90_000 });
  await replaceDialog.getByRole("button", { name: "Discard and open", exact: true }).click();
  await page.waitForFunction(projectId =>
    (window as unknown as { __playerSnapshot?: AcceptanceSnapshot }).__playerSnapshot?.result.projectId !== projectId,
  previousProjectId, { timeout: 90_000 });
  const fileProject = await settledStudio(page, 0);
  expect(fileProject.result.rawBaseline.fixtureId).toBe("imported-midi");
  const fileIdentity = {
    projectId: fileProject.result.projectId,
    resourceHash: fileProject.result.resource.sha256,
    sourceNoteIds: fileProject.result.rawBaseline.sourceNotes.map((note: { noteId: string }) => note.noteId),
  };
  const fileEdit = await editFirstNoteAndReplan(page);
  expect(fileEdit.response.projectId).toBe(fileIdentity.projectId);
  expect(fileEdit.edited.result.resource.sha256).toBe(fileIdentity.resourceHash);
  expect(fileEdit.edited.result.rawBaseline.sourceNotes.map((note: { noteId: string }) => note.noteId)).toEqual(fileIdentity.sourceNoteIds);

  trace = await workerTrace(page);
  expect(trace.some(entry => entry.direction === "created" && entry.url.includes(nativeWorkerName))).toBe(true);
  expect(trace.some(entry => entry.direction === "created" && entry.url.includes(pythonWorkerName))).toBe(true);
  expect(trace.some(entry => entry.direction === "request" && entry.url.includes(nativeWorkerName) && entry.type === "replan-document")).toBe(true);
  expect(trace.some(entry => entry.direction === "request" && entry.url.includes(nativeWorkerName) && entry.type === "sample-motion")).toBe(true);
  await testInfo.attach("native-engine-browser-evidence", {
    contentType: "application/json",
    body: JSON.stringify({
      workerUrls: [...new Set(trace.filter(entry => entry.direction === "created").map(entry => entry.url))],
      messages: trace.filter(entry => entry.direction !== "created").map(entry => ({
        direction: entry.direction,
        url: entry.url,
        type: entry.type,
        projectId: entry.projectId,
        revision: entry.revision,
        engineVersion: entry.engineVersion,
        status: entry.status,
        error: entry.error,
        poseCount: entry.poses?.length,
      })),
      startupGeometry,
      sampledGeometry,
      pageErrors,
      networkFailures,
    }, null, 2),
  });
  expect(startupGeometry.issueCount, JSON.stringify(startupGeometry)).toBe(0);
  expect(sampledGeometry.issueCount, JSON.stringify(sampledGeometry)).toBe(0);
  expect(pageErrors).toEqual([]);
  await openStudioInspector(page, "Diagnostics");
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download diagnostic log", exact: true }).click();
  const download = await downloadReady;
  const logPath = testInfo.outputPath("native-diagnostic-log.json");
  await download.saveAs(logPath);
  const journal = JSON.parse(await fs.readFile(logPath, "utf8")) as { events: { event: string; details: Record<string, unknown> }[] };
  expect(journal.events.some(entry => entry.event === "worker.request" && entry.details.type === "sample-motion")).toBe(true);
  expect(journal.events.some(entry => entry.event === "worker.response" && entry.details.coverage)).toBe(true);
  expect(journal.events.some(entry => entry.event === "transport.state" && entry.details.state === "playing")).toBe(true);
  expect(journal.events.filter(entry => entry.event === "motion.error")).toEqual([]);
  await testInfo.attach("native-diagnostic-log", { path: logPath, contentType: "application/json" });
});
