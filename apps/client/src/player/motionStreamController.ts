import {
  M1EngineMessageSchema,
  type M1EngineMessage,
  type M1SampleMotionRequest,
  type M1SampleMotionResult,
} from "@handthesia/contracts";
import { postM1SampleMotionRequest } from "../m1WorkerClient";
import { recordDiagnostic } from "../diagnostics/eventLog";

export interface MotionStreamIdentity {
  projectId: string;
  revision: number;
  engineVersion: string;
}

export interface MotionStreamFlight {
  request: M1SampleMotionRequest;
  seekEpoch: number;
  /** Local generation used to discard results after cancel/reset. */
  generation: number;
  startedAt: number;
  /** The caller's full requested end, before the per-request five-second limit. */
  demandStartTimeSeconds: number;
  demandEndTimeSeconds: number;
}

export interface MotionStreamControllerOptions {
  worker: Worker;
  identity: MotionStreamIdentity;
  seekEpoch?: number;
  timeoutMs?: number;
  retryCooldownMs?: number;
  requestIdFactory?: () => string;
  /** Return true while the original requested interval still needs coverage. */
  onResult: (result: M1SampleMotionResult, flight: MotionStreamFlight) => boolean;
  onError: (error: MotionStreamError, flight: MotionStreamFlight | null, retryable: boolean) => void;
  onProgress?: (message: string, flight: MotionStreamFlight) => void;
}

const MAX_WINDOW_SECONDS = 5;
const DEFAULT_MAX_POSES = 200;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_COOLDOWN_MS = 1_500;
const TIME_EPSILON = 1e-4;
const ENDPOINT_CONTINUATION_OVERLAP_SECONDS = 0.001;

export class MotionStreamError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MotionStreamError";
  }
}

export class MotionStreamCapacityError extends MotionStreamError {
  public constructor(message: string) {
    super(message, "MOTION_WINDOW_CAPACITY", false);
    this.name = "MotionStreamCapacityError";
  }
}

interface MotionStreamDemand {
  startTimeSeconds: number;
  demandStartTimeSeconds: number;
  endTimeSeconds: number;
  maxPoses: number;
  seekEpoch: number;
  generation: number;
}

/** Owns one bounded motion request on a shared analysis Worker. */
export class MotionStreamController {
  private readonly worker: Worker;
  private readonly timeoutMs: number;
  private readonly retryCooldownMs: number;
  private readonly requestIdFactory: () => string;
  private readonly onResult: MotionStreamControllerOptions["onResult"];
  private readonly onError: MotionStreamControllerOptions["onError"];
  private readonly onProgress?: MotionStreamControllerOptions["onProgress"];
  private identity: MotionStreamIdentity;
  private seekEpoch: number;
  private generation = 0;
  private inFlight: MotionStreamFlight | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private queuedDemand: MotionStreamDemand | null = null;
  private blockedDemand: string | null = null;
  private retryAfter = 0;
  private disposed = false;

  public constructor(options: MotionStreamControllerOptions) {
    this.worker = options.worker;
    this.identity = { ...options.identity };
    this.seekEpoch = options.seekEpoch ?? 0;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    this.requestIdFactory = options.requestIdFactory ?? (() => `motion-${crypto.randomUUID()}`);
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.onProgress = options.onProgress;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  public get inFlightRequest(): MotionStreamFlight | null {
    return this.inFlight;
  }

  /** Requests a range, coalescing only while a Worker request is already active. */
  public requestWindow(startTimeSeconds: number, endTimeSeconds: number, maxPoses = DEFAULT_MAX_POSES): boolean {
    if (this.disposed) return false;
    if (!Number.isFinite(startTimeSeconds) || startTimeSeconds < 0 ||
        !Number.isFinite(endTimeSeconds) || endTimeSeconds <= startTimeSeconds) {
      throw new RangeError("Motion window must have finite nonnegative start and a later end.");
    }
    if (!Number.isInteger(maxPoses) || maxPoses < 1 || maxPoses > 500) {
      throw new RangeError("maxPoses must be an integer from 1 through 500.");
    }

    const demand: MotionStreamDemand = {
      startTimeSeconds,
      demandStartTimeSeconds: startTimeSeconds,
      endTimeSeconds,
      maxPoses,
      seekEpoch: this.seekEpoch,
      generation: this.generation,
    };
    const demandKey = this.demandKey(demand);
    if (this.blockedDemand === demandKey) return false;
    if (this.blockedDemand !== null) this.blockedDemand = null;
    if (this.inFlight) {
      if (!this.inFlightCoversDemand(demand)) this.queuedDemand = demand;
      return false;
    }
    if (Date.now() < this.retryAfter) {
      this.queuedDemand = demand;
      return false;
    }
    this.queuedDemand = null;
    this.dispatch(demand);
    return true;
  }

  /** Invalidate all pending output for a source revision or seek epoch change. */
  public reset(identity: MotionStreamIdentity, seekEpoch: number): void {
    if (this.disposed) return;
    recordDiagnostic("motion.reset", { ...identity, seekEpoch });
    this.identity = { ...identity };
    this.seekEpoch = seekEpoch;
    this.generation += 1;
    this.queuedDemand = null;
    this.blockedDemand = null;
    this.retryAfter = 0;
  }

  /** Abandon the current logical request while allowing its Worker terminal to drain. */
  public cancel(): void {
    if (this.disposed) return;
    recordDiagnostic("motion.cancelled", { ...this.identity, seekEpoch: this.seekEpoch, generation: this.generation });
    this.generation += 1;
    this.queuedDemand = null;
    this.blockedDemand = null;
    this.retryAfter = 0;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.queuedDemand = null;
    this.finishFlight();
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const flight = this.inFlight;
    if (!flight) return;
    let message: M1EngineMessage;
    try {
      message = M1EngineMessageSchema.parse(event.data);
    } catch (error) {
      if (this.messageRequestId(event.data) === flight.request.requestId) {
        if (this.isCurrent(flight)) {
          this.block(flight);
          this.fail(new MotionStreamError(this.errorText(error), "MOTION_RESPONSE_INVALID", false), false);
        } else {
          this.finishFlight();
          this.dispatchQueued();
        }
      }
      return;
    }
    if (!this.matchesFlight(message, flight)) return;

    if (message.type === "progress") {
      if (this.isCurrent(flight)) this.onProgress?.(message.message ?? message.stage, flight);
      return;
    }
    if (message.type === "worker-error") {
      if (!this.isCurrent(flight)) {
        this.finishFlight();
        this.dispatchQueued();
        return;
      }
      this.fail(new MotionStreamError(message.error.message, message.error.code, message.error.retryable), message.error.retryable);
      return;
    }
    if (message.type === "cancelled") {
      if (!this.isCurrent(flight)) {
        this.finishFlight();
        this.dispatchQueued();
        return;
      }
      const detail = message.reason ? `: ${message.reason}` : ".";
      this.fail(new MotionStreamError(
        `Motion Worker cancelled the requested window${detail}`,
        "MOTION_REQUEST_CANCELLED",
        true,
      ), true);
      return;
    }
    if (message.type !== "sample-motion-result") return;

    const current = this.isCurrent(flight);
    this.finishFlight();
    if (current) {
      try {
        const stillUncovered = this.onResult(message, flight);
        if (stillUncovered && !this.inFlight) this.continueOrReport(message, flight);
      } catch (error) {
        this.reportError(new MotionStreamError(this.errorText(error), "MOTION_RESULT_HANDLER_FAILED", false), flight, false);
        this.dispatchQueued();
        return;
      }
    }
    this.dispatchQueued();
  };

  private readonly handleWorkerError = (event: Event): void => {
    const flight = this.inFlight;
    if (!flight) return;
    if (!this.isCurrent(flight)) {
      this.retryAfter = Date.now() + this.retryCooldownMs;
      this.finishFlight();
      this.dispatchQueued();
      return;
    }
    const message = "message" in event && typeof event.message === "string" && event.message
      ? event.message
      : "Motion Worker stopped unexpectedly.";
    this.fail(new MotionStreamError(message, "MOTION_WORKER_CRASHED", true), true);
  };

  private readonly handleMessageError = (): void => {
    const flight = this.inFlight;
    if (!flight) return;
    if (!this.isCurrent(flight)) {
      this.retryAfter = Date.now() + this.retryCooldownMs;
      this.finishFlight();
      this.dispatchQueued();
      return;
    }
    this.fail(new MotionStreamError("Motion Worker response could not be decoded.", "MOTION_MESSAGE_DECODE_FAILED", true), true);
  };

  private dispatch(demand: MotionStreamDemand, startOverride?: number): void {
    if (this.disposed || demand.generation !== this.generation || demand.seekEpoch !== this.seekEpoch) return;
    const startTimeSeconds = startOverride ?? demand.startTimeSeconds;
    const endTimeSeconds = Math.min(demand.endTimeSeconds, startTimeSeconds + MAX_WINDOW_SECONDS);
    if (endTimeSeconds <= startTimeSeconds + TIME_EPSILON) {
      this.reportError(new MotionStreamCapacityError("Motion continuation did not advance the covered time range."), null, false);
      return;
    }
    const request: M1SampleMotionRequest = {
      type: "sample-motion",
      requestId: this.requestIdFactory(),
      ...this.identity,
      startTimeSeconds,
      endTimeSeconds,
      maxPoses: demand.maxPoses,
    };
    const flight: MotionStreamFlight = {
      request,
      seekEpoch: demand.seekEpoch,
      generation: demand.generation,
      startedAt: Date.now(),
      demandEndTimeSeconds: demand.endTimeSeconds,
      demandStartTimeSeconds: demand.demandStartTimeSeconds,
    };
    this.inFlight = flight;
    this.timeout = setTimeout(() => {
      if (this.inFlight !== flight) return;
      this.retryAfter = Date.now() + this.retryCooldownMs;
      if (!this.isCurrent(flight)) {
        this.finishFlight();
        this.dispatchQueued();
        return;
      }
      this.fail(new MotionStreamError("Motion Worker did not finish the requested window before timeout. Retry after the Worker settles.", "MOTION_REQUEST_TIMEOUT", true), true);
    }, this.timeoutMs);
    try {
      postM1SampleMotionRequest(this.worker, request);
    } catch (error) {
      this.fail(new MotionStreamError(this.errorText(error), "MOTION_REQUEST_REJECTED", false), false);
    }
  }

  private continueOrReport(result: M1SampleMotionResult, flight: MotionStreamFlight): void {
    if (result.truncated === true && result.continuationTimeSeconds === undefined) {
      this.block(flight);
      this.reportError(new MotionStreamCapacityError("Motion response was truncated without a continuation point."), flight, false);
      return;
    }
    const nextStart = result.continuationTimeSeconds ?? result.endTimeSeconds;
    const requiresContinuation = result.truncated === true || result.endTimeSeconds < flight.demandEndTimeSeconds - TIME_EPSILON;
    if (!requiresContinuation) {
      this.block(flight);
      this.reportError(new MotionStreamError("Motion Worker returned an incomplete window without a continuation point.", "MOTION_COVERAGE_INCOMPLETE", false), flight, false);
      return;
    }
    if (!Number.isFinite(nextStart) || nextStart <= flight.request.startTimeSeconds + TIME_EPSILON ||
        nextStart > flight.demandEndTimeSeconds + TIME_EPSILON) {
      this.block(flight);
      this.reportError(new MotionStreamCapacityError("Motion window capacity was reached before coverage advanced."), flight, false);
      return;
    }
    const resumesAtEndpoint = nextStart >= flight.demandEndTimeSeconds - TIME_EPSILON;
    const continuationStart = resumesAtEndpoint
      ? Math.max(0, flight.demandEndTimeSeconds - ENDPOINT_CONTINUATION_OVERLAP_SECONDS)
      : nextStart;
    if (resumesAtEndpoint && continuationStart <= flight.request.startTimeSeconds + TIME_EPSILON) {
      this.block(flight);
      this.reportError(new MotionStreamCapacityError("Motion window capacity was reached before the final endpoint could be sampled."), flight, false);
      return;
    }
    const demand: MotionStreamDemand = {
      startTimeSeconds: continuationStart,
      demandStartTimeSeconds: flight.demandStartTimeSeconds,
      endTimeSeconds: flight.demandEndTimeSeconds,
      maxPoses: flight.request.maxPoses,
      seekEpoch: flight.seekEpoch,
      generation: flight.generation,
    };
    this.dispatch(demand, continuationStart);
  }

  private fail(error: MotionStreamError, retryable: boolean): void {
    const flight = this.inFlight;
    this.finishFlight();
    if (retryable) this.retryAfter = Math.max(this.retryAfter, Date.now() + this.retryCooldownMs);
    else if (flight && this.isCurrent(flight)) this.block(flight);
    this.reportError(error, flight, retryable);
    // Keep the latest demand available for a future explicit polling tick, but
    // do not schedule a timer that can spin against a busy Worker.
    this.dispatchQueued();
  }

  private reportError(error: MotionStreamError, flight: MotionStreamFlight | null, retryable: boolean): void {
    recordDiagnostic("motion.error", { ...this.identity, requestId: flight?.request.requestId,
      seekEpoch: flight?.seekEpoch, generation: flight?.generation, retryable, code: error.code, error,
      startTimeSeconds: flight?.request.startTimeSeconds, endTimeSeconds: flight?.request.endTimeSeconds,
      demandStartTimeSeconds: flight?.demandStartTimeSeconds, demandEndTimeSeconds: flight?.demandEndTimeSeconds }, "error");
    if (!this.disposed) this.onError(error, flight, retryable);
  }

  private finishFlight(): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    this.inFlight = null;
  }

  private dispatchQueued(): void {
    if (this.disposed || this.inFlight || !this.queuedDemand || Date.now() < this.retryAfter) return;
    const demand = this.queuedDemand;
    this.queuedDemand = null;
    this.dispatch(demand);
  }

  private inFlightCoversDemand(demand: MotionStreamDemand): boolean {
    const active = this.inFlight;
    return active !== null && active.generation === demand.generation && active.seekEpoch === demand.seekEpoch &&
      active.demandStartTimeSeconds <= demand.startTimeSeconds + TIME_EPSILON &&
      active.demandEndTimeSeconds >= demand.endTimeSeconds - TIME_EPSILON;
  }

  private block(flight: MotionStreamFlight): void {
    this.blockedDemand = this.demandKey({
      startTimeSeconds: flight.demandStartTimeSeconds,
      demandStartTimeSeconds: flight.demandStartTimeSeconds,
      endTimeSeconds: flight.demandEndTimeSeconds,
      maxPoses: flight.request.maxPoses,
      seekEpoch: flight.seekEpoch,
      generation: flight.generation,
    });
    this.queuedDemand = null;
  }

  private demandKey(demand: MotionStreamDemand): string {
    return `${demand.seekEpoch}:${demand.generation}:${demand.demandStartTimeSeconds}:${demand.endTimeSeconds}:${demand.maxPoses}`;
  }

  private isCurrent(flight: MotionStreamFlight): boolean {
    return !this.disposed && flight.generation === this.generation && flight.seekEpoch === this.seekEpoch &&
      this.sameIdentity(this.identity, flight.request);
  }

  private matchesFlight(message: M1EngineMessage, flight: MotionStreamFlight): boolean {
    return message.requestId === flight.request.requestId && message.projectId === flight.request.projectId &&
      message.revision === flight.request.revision && message.engineVersion === flight.request.engineVersion;
  }

  private sameIdentity(left: MotionStreamIdentity, right: MotionStreamIdentity): boolean {
    return left.projectId === right.projectId && left.revision === right.revision && left.engineVersion === right.engineVersion;
  }

  private messageRequestId(data: unknown): string | null {
    if (typeof data !== "object" || data === null || !("requestId" in data)) return null;
    return typeof data.requestId === "string" ? data.requestId : null;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
