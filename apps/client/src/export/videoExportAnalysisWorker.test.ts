import type { M1ReplanDocumentResult, M1SampleMotionRequest, MotionPose } from "@handthesia/contracts";
import { describe, expect, it } from "vitest";
import { VideoExportMotionProvider } from "./videoExportAnalysisWorker";

const engineVersion = "a".repeat(64);

function pose(time: number): MotionPose {
  return {
    hand: "right",
    transportTimeSeconds: time,
    layerOrder: 0,
    bones: [{ a: [0, 0, 0], b: [1, 0, 0], kind: "forearm" }],
    joints: [{ point: [0, 0, 0], kind: "wrist" }],
  };
}

class SamplingWorker extends EventTarget {
  public readonly requests: M1SampleMotionRequest[] = [];

  public constructor(
    private readonly extraForwardSeconds = 0.2,
    private readonly stepSeconds = 0.25,
    private readonly stallContinuation = false,
  ) { super(); }

  public postMessage(raw: unknown): void {
    const request = raw as M1SampleMotionRequest;
    this.requests.push(request);
    const poses: MotionPose[] = [];
    let truncated = false;
    let continuationTimeSeconds: number | undefined;
    for (let time = request.startTimeSeconds; time <= request.endTimeSeconds + 1e-5; time += this.stepSeconds) {
      if (poses.length >= request.maxPoses) {
        truncated = true;
        continuationTimeSeconds = this.stallContinuation ? request.startTimeSeconds : Number(time.toFixed(4));
        break;
      }
      poses.push(pose(Number(time.toFixed(4))));
    }
    if (!truncated && !poses.some((item) => Math.abs(item.transportTimeSeconds - request.endTimeSeconds) < 1e-4)) {
      poses.push(pose(request.endTimeSeconds));
    }
    if (!truncated && this.extraForwardSeconds > 0) {
      poses.push(pose(Number((request.endTimeSeconds + this.extraForwardSeconds).toFixed(4))));
    }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "sample-motion-result",
        requestId: request.requestId,
        projectId: request.projectId,
        revision: request.revision,
        engineVersion: request.engineVersion,
        startTimeSeconds: request.startTimeSeconds,
        endTimeSeconds: request.endTimeSeconds,
        poses,
        coverage: {
          right: {
            coveredStartTimeSeconds: request.startTimeSeconds,
            coveredEndTimeSeconds: truncated ? poses[poses.length - 1]!.transportTimeSeconds : request.endTimeSeconds,
            isComplete: !truncated,
            poseCount: poses.length - (!truncated && this.extraForwardSeconds > 0 ? 1 : 0),
          },
        },
        truncated,
        ...(continuationTimeSeconds === undefined ? {} : { continuationTimeSeconds }),
      },
    })));
  }

  public terminate(): void {}
}

function replanned(durationSeconds: number): M1ReplanDocumentResult {
  return {
    projectId: "stream-project",
    revision: 2,
    engineVersion,
    document: { durationSeconds },
    fingeringPlan: { assignments: [{ noteId: "note-1", hand: "right" }] },
    performancePlan: { events: [{ type: "press", timeSeconds: 0.5, noteId: "note-1" }] },
  } as unknown as M1ReplanDocumentResult;
}

describe("video export motion provider", () => {
  it("accepts Python's bounded 0.2-second forward strike lookahead and prunes old poses", async () => {
    const worker = new SamplingWorker() as unknown as Worker;
    const provider = new VideoExportMotionProvider(worker, replanned(10), 10, new AbortController().signal);

    const first = await provider.ensureCoverage(0, 1.5);
    expect(first.hasCoverage(0, 1.5)).toBe(true);
    expect(first.poses.at(-1)?.transportTimeSeconds).toBeCloseTo(1.7, 4);

    const later = await provider.ensureCoverage(5, 6.5);
    expect(later.hasCoverage(5, 6.5)).toBe(true);
    expect(later.poses.every((item) => item.transportTimeSeconds >= 4.5 - 1e-4)).toBe(true);
    expect((worker as unknown as SamplingWorker).requests.every((request) =>
      request.endTimeSeconds - request.startTimeSeconds <= 4)).toBe(true);
  });

  it("rejects pose samples beyond the documented forward strike allowance", async () => {
    const worker = new SamplingWorker(0.21) as unknown as Worker;
    const provider = new VideoExportMotionProvider(worker, replanned(2), 2, new AbortController().signal);
    await expect(provider.ensureCoverage(0, 1.5)).rejects.toThrow(/outside its declared window/i);
  });

  it("continues a dense capped window from the exact first omitted sample", async () => {
    const worker = new SamplingWorker(0.2, 0.005) as unknown as Worker;
    const provider = new VideoExportMotionProvider(worker, replanned(2), 2, new AbortController().signal);

    const buffer = await provider.ensureCoverage(0, 1.5);
    const requests = (worker as unknown as SamplingWorker).requests;
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[0]!.startTimeSeconds).toBe(0);
    expect(requests[1]!.startTimeSeconds).toBeGreaterThan(requests[0]!.startTimeSeconds);
    expect(buffer.hasCoverage(0, 1.5)).toBe(true);
  });

  it("continues monotonically through more than eight dense chunks without exceeding 200 poses per request", async () => {
    const worker = new SamplingWorker(0.2, 0.0004) as unknown as Worker;
    const provider = new VideoExportMotionProvider(worker, replanned(2), 2, new AbortController().signal);

    const buffer = await provider.ensureCoverage(0, 1.5);
    const requests = (worker as unknown as SamplingWorker).requests;
    expect(requests.length).toBeGreaterThan(8);
    expect(requests.every((request) => request.maxPoses === 200)).toBe(true);
    expect(requests.every((request, index) => index === 0 || request.startTimeSeconds > requests[index - 1]!.startTimeSeconds)).toBe(true);
    expect(buffer.hasCoverage(0, 1.5)).toBe(true);
  });

  it("fails fast when the Worker reports a stalled dense continuation point", async () => {
    const worker = new SamplingWorker(0.2, 0.0004, true) as unknown as Worker;
    const provider = new VideoExportMotionProvider(worker, replanned(2), 2, new AbortController().signal);
    await expect(provider.ensureCoverage(0, 1.5)).rejects.toThrow(/valid forward continuation/i);
  });
});
