import {
  M1SampleMotionResultSchema,
  validateM1ReplanDocumentResultForRequest,
  type M1ReplanDocumentRequest,
  type M1ReplanDocumentResult,
  type M1SampleMotionResult,
} from "@handthesia/contracts";
import { MotionBuffer, type MotionRequiredAnchor } from "../render/motionBuffer";
import { createM1AnalysisWorker, postM1ReplanDocumentRequest, postM1SampleMotionRequest } from "../m1WorkerClient";
import { runWorkerJob } from "../player/workerJob";
import type { FrozenVideoExportSnapshot } from "./videoExportSnapshot";

const MAX_SAMPLE_WINDOW_SECONDS = 4;
const MAX_SAMPLE_POSES = 200;
const FORWARD_STRIKE_LOOKAHEAD_SECONDS = 0.2;
const MAX_POSE_GAP_SECONDS = 0.25;
const COVERAGE_EPSILON = 1e-4;
const MAX_SAMPLE_REQUESTS = 10_000;

function eventAnchors(result: M1ReplanDocumentResult): MotionRequiredAnchor[] {
  const handByNoteId = new Map(result.fingeringPlan!.assignments.map((assignment) => [assignment.noteId, assignment.hand]));
  return result.performancePlan!.events.flatMap((event) => {
    if (event.type === "pedal") return [];
    const hand = handByNoteId.get(event.noteId);
    return hand === "left" || hand === "right" ? [{ hand, timeSeconds: event.timeSeconds }] : [];
  });
}

function assertSampleIdentity(result: M1SampleMotionResult, request: {
  requestId: string;
  projectId: string;
  revision: number;
  engineVersion: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
}): void {
  if (result.requestId !== request.requestId || result.projectId !== request.projectId ||
      result.revision !== request.revision || result.engineVersion !== request.engineVersion) {
    throw new Error("Motion sampling returned a different project or engine identity.");
  }
  if (Math.abs(result.startTimeSeconds - request.startTimeSeconds) > COVERAGE_EPSILON ||
      result.endTimeSeconds < request.startTimeSeconds - COVERAGE_EPSILON ||
      result.endTimeSeconds > request.endTimeSeconds + COVERAGE_EPSILON) {
    throw new Error("Motion sampling returned an invalid time window.");
  }
  if (result.poses.length > MAX_SAMPLE_POSES) {
    throw new Error(`Motion sampling exceeded the ${MAX_SAMPLE_POSES}-pose window limit.`);
  }
  for (const pose of result.poses) {
    if (pose.transportTimeSeconds < request.startTimeSeconds - COVERAGE_EPSILON ||
        pose.transportTimeSeconds > request.endTimeSeconds + FORWARD_STRIKE_LOOKAHEAD_SECONDS + COVERAGE_EPSILON) {
      throw new Error("Motion sampling returned a pose outside its declared window.");
    }
  }
}

/** Samples a bounded window in front of the current frame and prunes old poses as playback advances. */
export class VideoExportMotionProvider {
  public readonly buffer: MotionBuffer;
  private readonly expectedHands: Array<"left" | "right">;
  private requestCount = 0;
  private retryStartSeconds: number | null = null;

  public constructor(
    private readonly worker: Worker,
    private readonly replanned: M1ReplanDocumentResult,
    private readonly durationSeconds: number,
    private readonly signal: AbortSignal,
    private readonly onProgress?: (message: string) => void,
  ) {
    const anchors = eventAnchors(replanned);
    const expectedHands = [...new Set(anchors.map((anchor) => anchor.hand))];
    this.expectedHands = expectedHands;
    this.buffer = new MotionBuffer({
      expectedHands,
      requiredAnchors: anchors,
      windowBehindSeconds: 0.5,
      windowAheadSeconds: 1.5,
    });
  }

  public async ensureCoverage(
    songTimeSeconds: number,
    lookaheadEndSeconds = songTimeSeconds + 1.5,
  ): Promise<MotionBuffer> {
    const start = Math.max(0, Math.min(this.durationSeconds, songTimeSeconds));
    const end = Math.max(start, Math.min(this.durationSeconds, lookaheadEndSeconds));
    this.buffer.prune(start);
    if (end <= start || this.expectedHands.length === 0) return this.buffer;

    while (!this.buffer.hasCoverage(start, end)) {
      if (this.signal.aborted) throw new DOMException("Video export canceled", "AbortError");
      this.requestCount += 1;
      if (this.requestCount > MAX_SAMPLE_REQUESTS) {
        throw new Error("Motion sampling exceeded the request safety limit.");
      }

      const missing = this.buffer.getMissingWindow(start);
      let requestStart = Math.max(0, Math.min(start, missing.start));
      if (this.retryStartSeconds !== null) {
        // The Python continuation is the first omitted sample, so retry from
        // that exact time rather than reopening the same dense prefix.
        requestStart = Math.max(0, this.retryStartSeconds);
        this.retryStartSeconds = null;
      }
      const requestEnd = Math.min(end, requestStart + MAX_SAMPLE_WINDOW_SECONDS);
      if (requestEnd <= requestStart + COVERAGE_EPSILON) {
        throw new Error("Motion sampling could not find a forward coverage window.");
      }
      const request = {
        type: "sample-motion" as const,
        requestId: crypto.randomUUID(),
        projectId: this.replanned.projectId,
        revision: this.replanned.revision,
        engineVersion: this.replanned.engineVersion,
        startTimeSeconds: requestStart,
        endTimeSeconds: requestEnd,
        maxPoses: MAX_SAMPLE_POSES,
      };
      const result = await runWorkerJob<M1SampleMotionResult>(
        request,
        (worker) => postM1SampleMotionRequest(worker, request),
        (message) => {
          if (message.type !== "sample-motion-result") return undefined;
          const parsed = M1SampleMotionResultSchema.parse(message);
          assertSampleIdentity(parsed, request);
          return parsed;
        },
        this.signal,
        this.onProgress,
        { worker: this.worker, terminateOnComplete: false },
      );
      if (!result.coverage) throw new Error("Motion sampling did not report per-hand coverage.");
      for (const hand of this.expectedHands) {
        const coverage = result.coverage[hand];
        if (!coverage || coverage.poseCount === 0 || coverage.coveredStartTimeSeconds > requestStart + COVERAGE_EPSILON) {
          throw new Error(`Motion sampling did not cover the ${hand} hand at ${requestStart.toFixed(2)} seconds.`);
        }
        if (!result.truncated && coverage.coveredEndTimeSeconds < requestEnd - COVERAGE_EPSILON) {
          throw new Error(`Motion sampling has incomplete ${hand}-hand coverage through ${requestEnd.toFixed(2)} seconds.`);
        }
      }
      const bridgedCoverage = { ...result, coverage: { ...result.coverage } };
      for (const hand of this.expectedHands) {
        const coverage = bridgedCoverage.coverage?.[hand];
        const firstPose = result.poses.find((pose) => pose.hand === hand);
        if (!coverage || !firstPose) continue;
        const previous = this.buffer.getHandCoverageIntervals(hand)
          .filter((interval) => interval.end <= coverage.coveredStartTimeSeconds + COVERAGE_EPSILON)
          .at(-1);
        if (previous && firstPose.transportTimeSeconds - previous.end <= MAX_POSE_GAP_SECONDS + COVERAGE_EPSILON) {
          bridgedCoverage.coverage![hand] = {
            ...coverage,
            coveredStartTimeSeconds: Math.min(coverage.coveredStartTimeSeconds, previous.end),
          };
        }
      }
      this.buffer.addSampleMotionResult(bridgedCoverage, start);

      if (this.buffer.hasCoverage(start, end)) return this.buffer;
      if (result.truncated === true) {
        const continuation = result.continuationTimeSeconds;
        if (continuation === undefined || !Number.isFinite(continuation) ||
            continuation <= requestStart + COVERAGE_EPSILON ||
            continuation > requestEnd + FORWARD_STRIKE_LOOKAHEAD_SECONDS + COVERAGE_EPSILON) {
          throw new Error("Motion sampling was truncated without a valid forward continuation point.");
        }
        // continuationTimeSeconds identifies the first omitted sample. Starting
        // there lets the Worker move forward through a dense same-window cap.
        this.retryStartSeconds = continuation;
      } else {
        throw new Error("Motion sampling ended before the requested frame lookahead was covered.");
      }
    }
    return this.buffer;
  }
}

/** Owns a dedicated Pyodide Worker for one export; it never touches the live player Worker. */
export class VideoExportAnalysisWorker {
  private readonly worker: Worker;
  private disposed = false;

  public constructor() {
    this.worker = createM1AnalysisWorker();
  }

  public async replan(
    snapshot: FrozenVideoExportSnapshot,
    signal: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<M1ReplanDocumentResult> {
    this.assertActive();
    const identity = snapshot.sourceIdentity;
    const request: M1ReplanDocumentRequest = {
      type: "replan-document",
      requestId: crypto.randomUUID(),
      projectId: identity.projectId,
      revision: identity.revision,
      engineVersion: identity.engineVersion,
      midiBytes: identity.originalMidiBytes,
      document: snapshot.document,
      fingeringPlan: identity.fingeringPlan,
      profile: snapshot.profile,
      resource: identity.resource,
      rawBaseline: identity.rawBaseline,
      options: {
        fixtureId: identity.sourceContext.fixtureId,
        keyStyle: identity.sourceContext.keyStyle,
      },
    };
    return runWorkerJob(
      request,
      (worker) => postM1ReplanDocumentRequest(worker, request),
      (message) => message.type === "replan-document-result"
        ? validateM1ReplanDocumentResultForRequest(request, message)
        : undefined,
      signal,
      onProgress,
      { worker: this.worker, terminateOnComplete: false },
    );
  }

  public createMotionProvider(
    replanned: M1ReplanDocumentResult,
    signal: AbortSignal,
    onProgress?: (message: string) => void,
  ): VideoExportMotionProvider {
    this.assertActive();
    return new VideoExportMotionProvider(
      this.worker,
      replanned,
      replanned.document!.durationSeconds,
      signal,
      onProgress,
    );
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Video export analysis Worker has been disposed.");
  }
}
