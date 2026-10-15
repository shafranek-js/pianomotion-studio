import type { M1SampleMotionRequest, M1SampleMotionResult, MotionPose } from "@handthesia/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionBuffer } from "../render/motionBuffer";
import {
  MotionStreamCapacityError,
  MotionStreamController,
  type MotionStreamIdentity,
} from "./motionStreamController";

const identity: MotionStreamIdentity = {
  projectId: "stream-project",
  revision: 3,
  engineVersion: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

class TestWorker extends EventTarget {
  public readonly requests: M1SampleMotionRequest[] = [];

  public postMessage(value: unknown): void {
    this.requests.push(value as M1SampleMotionRequest);
  }
}

function emit(worker: TestWorker, data: unknown): void {
  const event = new Event("message");
  Object.defineProperty(event, "data", { value: data });
  worker.dispatchEvent(event);
}

function emitError(worker: TestWorker, message: string): void {
  const event = new Event("error");
  Object.defineProperty(event, "message", { value: message });
  worker.dispatchEvent(event);
}

function resultFor(
  request: M1SampleMotionRequest,
  overrides: Partial<M1SampleMotionResult> = {},
): M1SampleMotionResult {
  return {
    type: "sample-motion-result",
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    engineVersion: request.engineVersion,
    startTimeSeconds: request.startTimeSeconds,
    endTimeSeconds: request.endTimeSeconds,
    poses: [],
    coverage: {},
    truncated: false,
    ...overrides,
  };
}

function densePoses(start: number, count: number): MotionPose[] {
  return Array.from({ length: count }, (_, index) => ({
    hand: "right",
    transportTimeSeconds: Number((start + index / 100).toFixed(2)),
    layerOrder: 0,
    bones: [{ a: [0, 0, 0], b: [0, 0, 0], kind: "forearm" }],
    joints: [{ point: [0, 0, 0], kind: "wrist" }],
  }));
}

function makeController(
  worker: TestWorker,
  overrides: Partial<ConstructorParameters<typeof MotionStreamController>[0]> = {},
) {
  let requestCounter = 0;
  const errors: Array<{ error: Error; flight: unknown; retryable: boolean }> = [];
  const results: Array<{ result: M1SampleMotionResult; epoch: number; requestId: string }> = [];
  const controller = new MotionStreamController({
    worker: worker as unknown as Worker,
    identity,
    requestIdFactory: () => `motion-${++requestCounter}`,
    onResult: (result, flight) => {
      results.push({ result, epoch: flight.seekEpoch, requestId: flight.request.requestId });
      return false;
    },
    onError: (error, flight, retryable) => errors.push({ error, flight, retryable }),
    ...overrides,
  });
  return { controller, errors, results };
}

afterEach(() => vi.useRealTimers());

describe("MotionStreamController", () => {
  it("keeps one in-flight request, coalesces contained demand, and dispatches a later range after terminal cleanup", () => {
    const worker = new TestWorker();
    const { controller, results } = makeController(worker);

    expect(controller.requestWindow(0, 4)).toBe(true);
    expect(controller.inFlightRequest?.request.startTimeSeconds).toBe(0);
    expect(controller.requestWindow(1, 3)).toBe(false);
    expect(controller.requestWindow(6, 8)).toBe(false);
    expect(worker.requests).toHaveLength(1);

    emit(worker, resultFor(worker.requests[0]!));
    expect(results).toHaveLength(1);
    expect(controller.inFlightRequest?.request.startTimeSeconds).toBe(6);
    expect(worker.requests).toHaveLength(2);
    emit(worker, resultFor(worker.requests[1]!));
    expect(controller.inFlightRequest).toBeNull();
    controller.dispose();
  });

  it("automatically follows a forward continuation without the old 0.5 second range threshold", () => {
    const worker = new TestWorker();
    let callbackCount = 0;
    const { controller } = makeController(worker, {
      onResult: (result) => {
        callbackCount += 1;
        return result.truncated === true;
      },
    });

    controller.requestWindow(0, 4, 200);
    emit(worker, resultFor(worker.requests[0]!, {
      endTimeSeconds: 0.25,
      truncated: true,
      continuationTimeSeconds: 0.25,
    }));
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.startTimeSeconds).toBe(0.25);
    expect(worker.requests[1]!.endTimeSeconds).toBe(4);

    emit(worker, resultFor(worker.requests[1]!, { endTimeSeconds: 4, truncated: false }));
    expect(callbackCount).toBe(2);
    expect(controller.inFlightRequest).toBeNull();
    controller.dispose();
  });

  it("streams full 200-pose continuation chunks through verified coverage across a short bridge", () => {
    const worker = new TestWorker();
    const buffer = new MotionBuffer({ expectedHands: ["right"] });
    const errors: Error[] = [];
    const controller = new MotionStreamController({
      worker: worker as unknown as Worker,
      identity,
      requestIdFactory: (() => {
        let requestCounter = 0;
        return () => `dense-${++requestCounter}`;
      })(),
      onResult: (result, flight) => {
        buffer.addSampleMotionResult(result);
        return !buffer.hasCoverage(flight.demandStartTimeSeconds, flight.demandEndTimeSeconds);
      },
      onError: error => errors.push(error),
    });

    expect(controller.requestWindow(0, 3.99, 200)).toBe(true);
    const firstRequest = worker.requests[0]!;
    const firstPoses = densePoses(0, 200);
    emit(worker, resultFor(firstRequest, {
      endTimeSeconds: 3.99,
      poses: firstPoses,
      coverage: {
        right: { coveredStartTimeSeconds: 0, coveredEndTimeSeconds: 1.99, isComplete: false, poseCount: firstPoses.length },
      },
      truncated: true,
      continuationTimeSeconds: 2,
    }));

    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.startTimeSeconds).toBe(2);
    const secondPoses = densePoses(2, 200);
    emit(worker, resultFor(worker.requests[1]!, {
      poses: secondPoses,
      coverage: {
        right: { coveredStartTimeSeconds: 2, coveredEndTimeSeconds: 3.99, isComplete: true, poseCount: secondPoses.length },
      },
    }));

    expect(buffer.hasCoverage(0, 3.99)).toBe(true);
    expect(buffer.getHandCoverageIntervals("right")).toEqual([{ start: 0, end: 3.99 }]);
    expect(errors).toEqual([]);
    expect(worker.requests).toHaveLength(2);
    expect(controller.inFlightRequest).toBeNull();
    controller.dispose();
  });

  it("returns a typed capacity error and blocks an unchanged no-progress retry", () => {
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker, {
      onResult: () => true,
    });

    controller.requestWindow(0, 4, 1);
    emit(worker, resultFor(worker.requests[0]!, {
      truncated: true,
      continuationTimeSeconds: 0,
    }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(MotionStreamCapacityError);
    expect(worker.requests).toHaveLength(1);
    expect(controller.requestWindow(0, 4, 1)).toBe(false);
    controller.dispose();
  });

  it("cleans up a matching worker error and exposes retryable backoff instead of spinning", () => {
    vi.useFakeTimers();
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker, { retryCooldownMs: 1_000 });

    controller.requestWindow(0, 4);
    const request = worker.requests[0]!;
    emit(worker, {
      type: "worker-error",
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      engineVersion: request.engineVersion,
      stage: "compute",
      error: { code: "WORKER_BUSY", message: "busy", retryable: true },
    });
    expect(controller.inFlightRequest).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.retryable).toBe(true);
    expect(controller.requestWindow(0, 4)).toBe(false);
    expect(worker.requests).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(controller.requestWindow(0, 4)).toBe(true);
    expect(worker.requests).toHaveLength(2);
    controller.dispose();
  });

  it("cleans up a matching cancelled terminal and reports a typed retryable error", () => {
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker);
    controller.requestWindow(0, 4);
    const request = worker.requests[0]!;

    emit(worker, {
      type: "cancelled",
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      engineVersion: request.engineVersion,
      stage: "compute",
      reason: "superseded by a worker job",
    });

    expect(controller.inFlightRequest).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatchObject({ code: "MOTION_REQUEST_CANCELLED", retryable: true });
    expect(errors[0]!.error.message).toMatch(/cancelled.*superseded/i);
    controller.dispose();
  });

  it("drains a stale cancelled terminal without surfacing an error before the new epoch", () => {
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker);
    controller.requestWindow(0, 4);
    const oldRequest = worker.requests[0]!;

    controller.reset({ ...identity, revision: identity.revision + 1 }, 5);
    expect(controller.requestWindow(8, 12)).toBe(false);
    emit(worker, {
      type: "cancelled",
      requestId: oldRequest.requestId,
      projectId: oldRequest.projectId,
      revision: oldRequest.revision,
      engineVersion: oldRequest.engineVersion,
      stage: "compute",
      reason: "stale request",
    });

    expect(errors).toHaveLength(0);
    expect(controller.inFlightRequest?.seekEpoch).toBe(5);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.revision).toBe(identity.revision + 1);
    controller.dispose();
  });

  it("discards the old seek result but drains it before sending the new epoch", () => {
    const worker = new TestWorker();
    const { controller, results } = makeController(worker);
    controller.requestWindow(0, 4);
    const oldRequest = worker.requests[0]!;

    controller.reset({ ...identity, revision: identity.revision + 1 }, 7);
    expect(controller.requestWindow(12, 16)).toBe(false);
    expect(worker.requests).toHaveLength(1);

    emit(worker, resultFor(oldRequest));
    expect(results).toHaveLength(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.revision).toBe(identity.revision + 1);
    emit(worker, resultFor(worker.requests[1]!));
    expect(results).toEqual([{ result: expect.objectContaining({ startTimeSeconds: 12 }), epoch: 7, requestId: worker.requests[1]!.requestId }]);
    controller.dispose();
  });

  it("cancels callbacks while draining the worker request before dispatching replacement demand", () => {
    const worker = new TestWorker();
    const { controller, results } = makeController(worker);
    controller.requestWindow(0, 4);
    const canceledRequest = worker.requests[0]!;

    controller.cancel();
    expect(controller.requestWindow(8, 12)).toBe(false);
    emit(worker, resultFor(canceledRequest));

    expect(results).toHaveLength(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.startTimeSeconds).toBe(8);
    emit(worker, resultFor(worker.requests[1]!));
    expect(results).toHaveLength(1);
    controller.dispose();
  });

  it("clears the flight on timeout and reports a retryable error", () => {
    vi.useFakeTimers();
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker, { timeoutMs: 10 });
    controller.requestWindow(0, 4);

    vi.advanceTimersByTime(10);
    expect(controller.inFlightRequest).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.retryable).toBe(true);
    expect(errors[0]!.error.message).toMatch(/timeout/i);
    controller.dispose();
  });

  it("does not surface a stale timeout after seek reset and waits before releasing new demand", () => {
    vi.useFakeTimers();
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker, { timeoutMs: 10, retryCooldownMs: 100 });
    controller.requestWindow(0, 4);

    controller.reset({ ...identity, revision: identity.revision + 1 }, 2);
    expect(controller.requestWindow(8, 12)).toBe(false);
    vi.advanceTimersByTime(10);
    expect(errors).toHaveLength(0);
    expect(controller.inFlightRequest).toBeNull();
    expect(worker.requests).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(controller.requestWindow(8, 12)).toBe(true);
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1]!.revision).toBe(identity.revision + 1);
    controller.dispose();
  });

  it("blocks an unchanged demand after a non-retryable worker failure", () => {
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker);
    controller.requestWindow(0, 4);
    const request = worker.requests[0]!;
    emit(worker, {
      type: "worker-error",
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      engineVersion: request.engineVersion,
      stage: "compute",
      error: { code: "INVALID_WINDOW", message: "invalid window", retryable: false },
    });

    expect(errors).toHaveLength(1);
    expect(controller.requestWindow(0, 4)).toBe(false);
    expect(worker.requests).toHaveLength(1);
    controller.dispose();
  });

  it("surfaces a worker crash and removes its timer and active request", () => {
    const worker = new TestWorker();
    const { controller, errors } = makeController(worker);
    controller.requestWindow(0, 4);
    emitError(worker, "worker crashed");

    expect(controller.inFlightRequest).toBeNull();
    expect(errors[0]!.error.message).toBe("worker crashed");
    expect(errors[0]!.retryable).toBe(true);
    controller.dispose();
  });
});
