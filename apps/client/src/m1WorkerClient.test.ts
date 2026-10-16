import { afterEach, describe, expect, it, vi } from "vitest";
import { createM1AnalysisWorker, getM1AnalysisWorkerEngine, postM1SampleMotionRequest } from "./m1WorkerClient";
import { VideoExportAnalysisWorker } from "./export/videoExportAnalysisWorker";
import { diagnosticJournal } from "./diagnostics/eventLog";

afterEach(() => vi.unstubAllGlobals());

describe("calculation Worker ownership", () => {
  it("correlates request, response, coverage and Worker failures without pose payloads", () => {
    class WorkerProbe extends EventTarget { postMessage() {} }
    vi.stubGlobal("Worker", WorkerProbe);
    diagnosticJournal.clear();
    const worker = createM1AnalysisWorker("typescript");
    const request = { type: "sample-motion" as const, requestId: "log-request", projectId: "log-project", revision: 4,
      engineVersion: "a".repeat(64), startTimeSeconds: 8.75, endTimeSeconds: 12.75, maxPoses: 200 };
    postM1SampleMotionRequest(worker, request);
    worker.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "sample-motion-result", poses: ["large"],
      truncated: false, coverage: { right: { isComplete: true, coveredStartTimeSeconds: 8.75, coveredEndTimeSeconds: 12.95, poseCount: 69 } } } }));
    worker.dispatchEvent(new MessageEvent("message", { data: { ...request, type: "worker-error",
      error: { code: "TEST_FAILURE", message: "diagnostic proof", retryable: false } } }));
    const events = diagnosticJournal.snapshot();
    expect(events.map(e => e.event)).toEqual(["worker.created", "worker.request", "worker.response", "worker.response"]);
    expect(events[1]!.details).toMatchObject({ requestId: "log-request", revision: 4, engine: "typescript", startTimeSeconds: 8.75 });
    expect(events[2]!.details).toMatchObject({ requestId: "log-request", poseCount: 1, coverage: { right: { isComplete: true } } });
    expect(events[2]!.details).not.toHaveProperty("poses");
    expect(events[3]).toMatchObject({ level: "error", details: { error: { code: "TEST_FAILURE" } } });
  });
  it("keeps the runtime identity of each created Worker", () => {
    class WorkerProbe { constructor(public url: URL) {} }
    vi.stubGlobal("Worker", WorkerProbe);
    const python = createM1AnalysisWorker("python");
    const native = createM1AnalysisWorker("typescript");
    expect(getM1AnalysisWorkerEngine(python)).toBe("python");
    expect(getM1AnalysisWorkerEngine(native)).toBe("typescript");
    expect((native as unknown as WorkerProbe).url.pathname).toContain("midi-analysis-ts.worker.ts");
    expect((python as unknown as WorkerProbe).url.pathname).toContain("midi-analysis.worker.ts");
  });
  it("pins export to the snapshot engine rather than a later preference", () => {
    const urls: string[] = [];
    class WorkerProbe {
      constructor(url: URL) { urls.push(url.pathname); }
      terminate() {}
    }
    vi.stubGlobal("Worker", WorkerProbe);
    const native = new VideoExportAnalysisWorker("typescript");
    const python = new VideoExportAnalysisWorker("python");
    expect(urls[0]).toContain("midi-analysis-ts.worker.ts");
    expect(urls[1]).toContain("midi-analysis.worker.ts");
    native.dispose();
    python.dispose();
  });
});
