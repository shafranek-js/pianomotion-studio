import packageInfo from "../../package.json";
import { applicationBuildId } from "../pwa/urls";
import type { PianistProfile } from "../profiles";
import { DEFAULT_ANATOMY, DEFAULT_BEHAVIOR } from "../profiles/types";

/** A bounded copy of the profile that produced the current analysis. */
export function snapshotTestingPianistProfile(profile: PianistProfile | null | undefined) {
  if (!profile) return null;
  return {
    profileId: profile.profileId,
    revision: profile.revision,
    anatomy: Object.fromEntries(Object.keys(DEFAULT_ANATOMY)
      .filter(key => typeof profile.anatomy[key] === "number")
      .map(key => [key, profile.anatomy[key]])),
    behavior: Object.fromEntries(Object.keys(DEFAULT_BEHAVIOR)
      .filter(key => typeof profile.behavior[key] === "number")
      .map(key => [key, profile.behavior[key]])),
    // Profile skin is an extensible record. Capture only the recognized width
    // value, not arbitrary imported metadata, and do not imply that the 3D
    // renderer necessarily uses this profile field.
    profileSkinFingerWidth: typeof profile.skin.finger_width === "number" && Number.isFinite(profile.skin.finger_width)
      ? profile.skin.finger_width : null,
  };
}

export const TESTING_HAND_CAPTURE_SAMPLE_INTERVAL_MS = 250;
export const TESTING_HAND_CAPTURE_MAX_RECORDS = 360;
export const TESTING_HAND_CAPTURE_MAX_BYTES = 850_000;
export const TESTING_HAND_CAPTURE_ENDPOINT = "/__testing-hand-diagnostics";
export const RIGGED_EXPERIMENTAL_HAND_CAPTURE_ENDPOINT = "/__rigged-experimental-hand-diagnostics";
const TESTING_HAND_CAPTURE_FORMAT_SEMANTICS = {
  captureModel: "payload.captureModel and record.captureModel identify the immutable hand model selected when this opt-in capture started; schemaVersion 1 remains append-compatible with earlier Testing logs",
  riggedExperimentalFrameSchemaVersion: 2,
  riggedExperimentalFingerBoneOrder: [
    "thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b",
    "index_metacarpal", "index_proximal", "index_intermediate", "index_distal",
    "middle_metacarpal", "middle_proximal", "middle_intermediate", "middle_distal",
    "ring_metacarpal", "ring_proximal", "ring_intermediate", "ring_distal",
    "little_metacarpal", "little_proximal", "little_intermediate", "little_distal",
  ],
  riggedExperimentalBoneOrderV2: [
    "thumb_segment0_cmc-to-mcp", "thumb_segment1_mcp-to-ip", "thumb_distal-segment-a", "thumb_distal-segment-b",
    "index_metacarpal", "index_proximal", "index_intermediate", "index_distal",
    "middle_metacarpal", "middle_proximal", "middle_intermediate", "middle_distal",
    "ring_metacarpal", "ring_proximal", "ring_intermediate", "ring_distal",
    "little_metacarpal", "little_proximal", "little_intermediate", "little_distal",
    "forearm", "palm",
  ],
  riggedExperimentalFingerBoneWorldRows: "Legacy frame schema v1: [boneId, worldX, worldY, worldZ, quaternionX, quaternionY, quaternionZ, quaternionW]; IDs 0-19 use riggedExperimentalFingerBoneOrder; positions are rendered Three.js world coordinates in inches",
  riggedExperimentalBoneWorldRowsV2: "Frame schema v2 field boneWorldTransformRows: [boneId, worldX, worldY, worldZ, quaternionX, quaternionY, quaternionZ, quaternionW]; IDs 0-19 retain the v1 finger order, ID 20 is the GLB forearm bone, ID 21 is the GLB palm root/wrist anchor (the asset has no separate wrist bone); positions and unit quaternions are world-space Three.js transforms in inches and XYZW order",
  riggedExperimentalFixedSkinSampleRows: "[fingerId, sampleId, sourceVertexId, terminalBoneWeight, worldX, worldY, worldZ]; finger IDs are 1 thumb through 5 little; fixed source vertices are chosen from bind-pose terminal-bone-weighted skin near the distal axis; they are surface samples, not validated palmar pads or contact points",
  riggedExperimentalTargetRows: "targets contain one row per finger; inactive entries say no-active-note; active entries include pitch, note start, actual key mesh bounds and [sampleId, sourceVertexId, sampledKeyTopY, sampledVertexY-minus-keyTopY] rows; these sparse vertical references are not collision tests",
  riggedExperimentalTargets: "target status is unavailable when note/key targets are not passed into the Rigged Experimental update path",
  riggedExperimentalCollision: "collision status is not-computed; post-skin point samples do not establish contact or absence of mesh intersection",
  displayedTransportTime: "displayedTransportTimeSeconds is the requested scene transport time; sourceMotionPose.transportTimeSeconds is the timestamp carried by the sampled pose and can differ during clamping or fallback",
  riggedExperimentalAssetIdentity: "sourceAssetSha256 hashes the actual GLB bytes loaded by the browser; runtime source-file hashes are not embedded in this frame",
  riggedExperimentalDuplicateSummary: "riggedExperimentalDuplicateSummary counts only Rigged Experimental periodic samples skipped because every semantic pose, transport, configuration, profile, GLB, target and skinned-surface value matched; intervals span the last retained frame through the last skipped frame, and `closedBy` says changed-frame, forced-frame, stop, or open-segment-snapshot",
  numericPrecision: "positions, rotations, dimensions and bend values rounded to 0.001 units/degrees",
  sourcePoseCoordinateFrame: "keyboard-local-inches-v1",
  sourceJointRows: "[kind, x, y, z]",
  sourceBoneRows: "[kind, ax, ay, az, bx, by, bz]",
  reconstructedLandmarkOrder: "0 wrist; 1-4 thumb CMC/MCP/IP/tip; 5-8 index MCP/PIP/DIP/tip; 9-12 middle; 13-16 ring; 17-20 little",
  reconstructedLandmarkSource: "renderer hand-group coordinates derived from MotionPose before Testing key contact correction",
  unsignedJointBends: "inter-segment angles in degrees; descriptive only, no flexion sign, reference range, or pass/fail threshold",
  afterContactLandmarks: "renderer hand-group coordinates from the final contact frames after Testing key contact correction; inactive frames retain the pre-contact chain",
  afterContactUnsignedJointBends: "inter-segment angles from afterContactLandmarks in degrees; unsigned, not anatomical joint limits",
  rendererNodeLabelAnatomy: "Testing GLB node names are exposed for debugging and have not been independently verified as anatomical joint labels",
  rendererTransformRows: "rendererRig.nodeLabels[i] names the 10-value rendererRig.transforms[i] row: position XYZ, quaternion XYZW, scale XYZ",
  rendererNodeLabels: "rendererRig.nodeLabels is emitted when labels change for that hand; otherwise use the most recent labels matching rendererRig.labelsRevision",
  coverageIntervals: "sampling.coverage.intervals is emitted when coverage changes for that hand; otherwise use the most recent intervals matching coverage.revision",
  rendererTransformSpace: "bone-local position, quaternion XYZW and scale after the render update; not world-space deformed surface points",
  preContactBoneScale: "For each driven bone before contact IK: measured MotionPose-derived segment length divided by bind length, the ratio actually applied after renderer limits, and bind length in inches. Bone scaling is not a measurement of visible skin length or anatomical correctness.",
  pianistProfileAtCaptureStart: "The applied analysis profile ID, revision, anatomy, behavior and profile skin finger width captured at recording start only. Compare its ID and revision with each frame's motionPlanIdentity before attributing profile values to that frame. Later profile values are not captured; profile skin width is not necessarily applied by the 3D renderer.",
  motionPlanIdentity: "Identity of the scene motion plan at the observed frame; null means unavailable. It identifies the profile used to plan the pose and does not itself contain the profile values.",
  keyContactMeasurement: "after-render-update, after any enabled contact correction; deformed skinned support vertices sampled against the pitch-specific piano-scene key surface",
  keyContactPadVertexSelection: "lowest support vertex with a valid pitch-specific key surface; ties use distance to the rendered distal tip",
  testingThumbReach: "opt-in thumb IK iteration trace in unrounded inches. The goal is exactly the value passed to the solver: local tip plus a world-space delta. This is a physically consistent local frame only when physicalFrameCompatible is true; reachability is necessary only and does not guarantee joint angles or skin contact. Neither controlledTip nor targetControlledTip is a skinned pad point.",
  noteBoundaryEvents: "Scheduled note start/end crossed during forward playback; the snapshot is the next observed rendered pose, not an exact event-time pose. Backward and >1 second jumps emit a timeline-discontinuity marker and reset the cursor without inventing note events.",
  supportFootprintStatus: "Axis-aligned key bounds compared with sampled support vertices only; outside does not prove the entire finger is off the key.",
  bindAlignment: "Source GLB bind bone origins, not validated anatomical joint centres; emitted once per hand and loaded LOD.",
} as const;

export interface TestingHandDiagnosticRecord {
  capturedAt: string;
  elapsedMs: number;
  hand: "left" | "right";
  [key: string]: unknown;
}

export interface TestingHandCapturePayload {
  schemaVersion: 1;
  captureModel: "testing" | "rigged-experimental";
  captureId: string;
  appVersion: string;
  buildId: string;
  formatSemantics: typeof TESTING_HAND_CAPTURE_FORMAT_SEMANTICS;
  startedAt: string;
  stoppedAt: string;
  sampleIntervalMs: number;
  maxRecords: number;
  maxBytes: number;
  configuration: Record<string, unknown>;
  provenanceAtStart?: Record<string, unknown> | null;
  configurationTimeline: Array<{ revision: number; recordedAt: string; elapsedMs: number; settings: Record<string, unknown> }>;
  configurationTimelineTruncated: boolean;
  truncated: boolean;
  throttledSamples: number;
  riggedExperimentalDuplicateSummary?: {
    schemaVersion: 1;
    duplicateSampleCount: number;
    intervals: Array<{
      intervalId: number;
      hand: "left" | "right";
      startElapsedMs: number;
      endElapsedMs: number;
      durationMs: number;
      duplicateCount: number;
      closedBy: "changed-frame" | "forced-frame" | "stop" | "open-segment-snapshot";
    }>;
    intervalsTruncated: boolean;
  };
  records: TestingHandDiagnosticRecord[];
  segmentIndex?: number;
  segmentFinal?: boolean;
}

export interface TestingHandCaptureStatus {
  active: boolean;
  captureModel: "testing" | "rigged-experimental" | null;
  startedAt: string | null;
  recordCount: number;
  maxRecords: number;
  maxBytes: number;
  truncated: boolean;
  throttledSamples: number;
  duplicateSamples: number;
}

type RiggedDuplicateInterval = NonNullable<TestingHandCapturePayload["riggedExperimentalDuplicateSummary"]>["intervals"][number];
const MAX_RIGGED_DUPLICATE_INTERVALS = 360;
const RIGGED_VOLATILE_SIGNATURE_KEYS = new Set([
  "capturedAt", "elapsedMs", "sampleReason", "samplingCounter", "samplingCounters", "sampleCounter", "sampleCounters",
  "sampleIndex", "sampleSequence", "sampledFrameIndex", "frameCounter", "frameCounters", "frameIndex", "frameSequence",
]);

function canonicalizeRiggedSignatureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRiggedSignatureValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !RIGGED_VOLATILE_SIGNATURE_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalizeRiggedSignatureValue(nested)]));
}

function riggedSemanticSignature(sample: Record<string, unknown>, configurationRevision: number): string | null {
  try {
    return JSON.stringify({ configurationRevision, sample: canonicalizeRiggedSignatureValue(sample) });
  } catch {
    return null;
  }
}

export interface TestingHandDiagnosticContext {
  displayedTransportTimeSeconds?: number;
  samplingSource: "motion-buffer" | "motion-plan-array" | "motion-plan-fallback";
  motionPlanIdentity?: {
    planId: string;
    inputRevision: number;
    profileId: string;
    profileRevision: number;
    engineVersion: string;
  } | null;
  handModel: {
    requestedModel: string;
    loadedModel: string;
    requestedLod: number | null;
    loadedLod: number | null;
    state: string;
    error: string | null;
  };
  poseSampling: {
    requestedTransportTimeSeconds: number;
    sampleMode: "clamped-first" | "clamped-last" | "exact" | "interpolated" | "lower-frame" | "unknown";
    sourcePoseTimeStartSeconds: number | null;
    sourcePoseTimeEndSeconds: number | null;
    sourceTimestampMs: null;
    freshness: "held-before-coverage" | "held-after-coverage" | "current-timeline-sample" | "unknown";
  };
  coverage: {
    source: "verified-motion-buffer" | "static-motion-plan-no-coverage-metadata";
    intervals: { start: number; end: number }[] | null;
    requestedTimeCovered: boolean | null;
    continuousCoverageEndSeconds: number | null;
  };
  noteBoundaryEvents?: TestingHandNoteBoundary[];
}

export type TestingThumbReachCaptureStatus = "disabled" | "no-active-thumb-note" | "unavailable" | "recorded";

export type TestingThumbReachIterationStatus =
  | "goal-unavailable"
  | "solver-unavailable"
  | "candidate-accepted"
  | "candidate-rejected";

/** Mutable per-frame collector passed only while an opted-in sample is recorded. */
export interface TestingThumbReachCollector {
  enabled: boolean;
  status: TestingThumbReachCaptureStatus;
  unavailableReason: string | null;
  units: "inches";
  coordinateFrame: "solver-local-plus-world-delta-inches-v1";
  /** True only when the group world transform has identity rotation and scale. */
  physicalFrameCompatible: boolean;
  targetRole: "desired-controlled-bone-tip-not-skinned-pad";
  reachabilityMeaning: "necessary-condition-only";
  iterations: TestingThumbReachIteration[];
}

export interface TestingThumbReachIteration {
  finger: 1;
  pitch: number;
  /** One-based pass through the contact IK loop. */
  iteration: number;
  status: TestingThumbReachIterationStatus;
  reason: string | null;
  /** Controlled endpoint and the exact goal passed to the solver, in inches. */
  controlledTip: [number, number, number] | null;
  targetControlledTip: [number, number, number] | null;
  mcpToIpLength: number | null;
  ipToTipLength: number | null;
  totalReach: number | null;
  distance: number | null;
  signedReachDeficit: number | null;
  reachDeficit: number | null;
  invalid: "degenerate-segment" | "non-finite" | null;
}

export type TestingHandNoteBoundary = {
  kind: "note-start" | "note-end";
  finger: number;
  pitch: number;
  scheduledTimeSeconds: number;
  observedFrameTimeSeconds: number;
} | {
  kind: "timeline-discontinuity";
  previousFrameTimeSeconds: number;
  observedFrameTimeSeconds: number;
  cause: "backward" | "forward-gap-over-one-second";
};
export interface TestingHandBoundaryNote {
  hand: "left" | "right" | null;
  finger: number | null;
  pitch: number;
  startSeconds: number;
  endSeconds: number;
}

const isDevelopment = import.meta.env.DEV;

/** In-memory, opt-in Testing-hand trace. It has no persistence until Stop is pressed. */
export class TestingHandCapture {
  private capture: {
    captureId: string;
    captureModel: "testing" | "rigged-experimental";
    startedAt: string;
    startedMonotonicMs: number;
    lastSampleMonotonicMs: Partial<Record<"left" | "right", number>>;
    lastRendererNodeLabels: Partial<Record<"left" | "right", string>>;
    rendererNodeLabelsRevision: Partial<Record<"left" | "right", number>>;
    lastCoverageIntervals: Partial<Record<"left" | "right", string>>;
    coverageRevision: Partial<Record<"left" | "right", number>>;
    lastNoteTime: Partial<Record<"left" | "right", number>>;
    seenBindAlignments: Set<string>;
    segmentIndex: number;
    configuration: Record<string, unknown>;
    provenanceAtStart: Record<string, unknown> | null;
    configurationTimeline: Array<{ revision: number; recordedAt: string; elapsedMs: number; settings: Record<string, unknown> }>;
    configurationTimelineTruncated: boolean;
    records: TestingHandDiagnosticRecord[];
    bytes: number;
    truncated: boolean;
    throttledSamples: number;
    lastRiggedSignature: Partial<Record<"left" | "right", string>>;
    lastRiggedUniqueElapsedMs: Partial<Record<"left" | "right", number>>;
    pendingRiggedDuplicateIntervals: Partial<Record<"left" | "right", RiggedDuplicateInterval>>;
    riggedDuplicateIntervals: RiggedDuplicateInterval[];
    riggedDuplicateIntervalsTruncated: boolean;
    riggedDuplicateSampleCount: number;
    nextRiggedDuplicateIntervalId: number;
  } | null = null;

  public constructor(
    private readonly now = () => ({ wall: Date.now(), monotonic: performance.now() }),
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly maxRecords = TESTING_HAND_CAPTURE_MAX_RECORDS,
    private readonly maxBytes = TESTING_HAND_CAPTURE_MAX_BYTES,
    private readonly intervalMs = TESTING_HAND_CAPTURE_SAMPLE_INTERVAL_MS,
    private readonly version = packageInfo.version,
    private readonly buildId = applicationBuildId(),
    private readonly onSegment?: (segment: TestingHandCapturePayload) => void,
  ) {}

  public start(configuration: Record<string, unknown> = {}, provenanceAtStart: Record<string, unknown> | null = null): TestingHandCaptureStatus {
    if (!isDevelopment) return this.status();
    const time = this.now();
    const captureModel = configuration.handModel === "rigged-experimental" ? "rigged-experimental" : "testing";
    this.capture = {
      captureId: this.createId(),
      captureModel,
      startedAt: new Date(time.wall).toISOString(),
      startedMonotonicMs: time.monotonic,
      lastSampleMonotonicMs: {},
      lastRendererNodeLabels: {},
      rendererNodeLabelsRevision: {},
      lastCoverageIntervals: {},
      coverageRevision: {},
      lastNoteTime: {},
      seenBindAlignments: new Set(),
      segmentIndex: 0,
      configuration,
      provenanceAtStart,
      configurationTimeline: [{ revision: 0, recordedAt: new Date(time.wall).toISOString(), elapsedMs: 0, settings: configuration }],
      configurationTimelineTruncated: false,
      records: [],
      bytes: 0,
      truncated: false,
      throttledSamples: 0,
      lastRiggedSignature: {},
      lastRiggedUniqueElapsedMs: {},
      pendingRiggedDuplicateIntervals: {},
      riggedDuplicateIntervals: [],
      riggedDuplicateIntervalsTruncated: false,
      riggedDuplicateSampleCount: 0,
      nextRiggedDuplicateIntervalId: 0,
    };
    return this.status();
  }

  public record(hand: "left" | "right", sample: Record<string, unknown>, force = false): boolean {
    const capture = this.capture;
    if (!isDevelopment || !capture || capture.truncated) return false;
    this.ensureRiggedCaptureState(capture);
    const time = this.now();
    const previous = capture.lastSampleMonotonicMs[hand];
    if (!force && previous !== undefined && time.monotonic - previous < this.intervalMs) {
      capture.throttledSamples += 1;
      return false;
    }
    const elapsedMs = Math.max(0, Math.round(time.monotonic - capture.startedMonotonicMs));
    const configurationRevision = capture.configurationTimeline.length - 1;
    const riggedSignature = capture.captureModel === "rigged-experimental"
      ? riggedSemanticSignature(sample, configurationRevision)
      : null;
    if (capture.captureModel === "rigged-experimental" && !force && riggedSignature !== null &&
      riggedSignature === capture.lastRiggedSignature[hand]) {
      capture.riggedDuplicateSampleCount += 1;
      const pending = capture.pendingRiggedDuplicateIntervals[hand];
      if (pending) {
        pending.endElapsedMs = elapsedMs;
        pending.durationMs = Math.max(0, pending.endElapsedMs - pending.startElapsedMs);
        pending.duplicateCount += 1;
      } else {
        capture.pendingRiggedDuplicateIntervals[hand] = {
          intervalId: capture.nextRiggedDuplicateIntervalId++,
          hand,
          startElapsedMs: capture.lastRiggedUniqueElapsedMs[hand] ?? elapsedMs,
          endElapsedMs: elapsedMs,
          durationMs: Math.max(0, elapsedMs - (capture.lastRiggedUniqueElapsedMs[hand] ?? elapsedMs)),
          duplicateCount: 1,
          closedBy: "open-segment-snapshot",
        };
      }
      // Use attempted samples for the cadence so a paused frame is checked only
      // at the configured interval instead of every render tick.
      capture.lastSampleMonotonicMs[hand] = time.monotonic;
      return false;
    }
    if (capture.captureModel === "rigged-experimental") {
      this.closePendingRiggedDuplicateInterval(hand, force ? "forced-frame" : "changed-frame", capture);
    }
    if (capture.records.length >= this.maxRecords) {
      capture.truncated = true;
      return false;
    }

    const compactSample = this.omitRepeatedMetadata(hand, sample, capture);
    const record: TestingHandDiagnosticRecord = {
      ...compactSample,
      capturedAt: new Date(time.wall).toISOString(),
      elapsedMs,
      hand,
      captureModel: capture.captureModel,
      configurationRevision,
    };
    let encoded: string;
    try { encoded = JSON.stringify(record); }
    catch { return false; }
    const bytes = new TextEncoder().encode(encoded).byteLength + 1;
    if (bytes > this.maxBytes - capture.bytes) {
      capture.truncated = true;
      return false;
    }
    capture.records.push(record);
    capture.bytes += bytes;
    capture.lastSampleMonotonicMs[hand] = time.monotonic;
    if (capture.captureModel === "rigged-experimental") {
      if (riggedSignature === null) delete capture.lastRiggedSignature[hand];
      else capture.lastRiggedSignature[hand] = riggedSignature;
      capture.lastRiggedUniqueElapsedMs[hand] = elapsedMs;
    }
    if (this.onSegment && (capture.records.length >= Math.max(1, Math.floor(this.maxRecords * 0.6)) || capture.bytes >= Math.floor(this.maxBytes * 0.6))) {
      const segment = this.takeSegment(false);
      if (segment) this.onSegment(segment);
    }
    return true;
  }

  private closePendingRiggedDuplicateInterval(
    hand: "left" | "right",
    closedBy: RiggedDuplicateInterval["closedBy"],
    capture: NonNullable<TestingHandCapture["capture"]>,
  ): void {
    const pending = capture.pendingRiggedDuplicateIntervals[hand];
    if (!pending) return;
    pending.closedBy = closedBy;
    if (capture.riggedDuplicateIntervals.length < MAX_RIGGED_DUPLICATE_INTERVALS) {
      capture.riggedDuplicateIntervals.push(pending);
    } else {
      capture.riggedDuplicateIntervalsTruncated = true;
    }
    delete capture.pendingRiggedDuplicateIntervals[hand];
  }

  /** Migrates an in-flight dev capture if Vite replaces this module via HMR. */
  private ensureRiggedCaptureState(capture: NonNullable<TestingHandCapture["capture"]>): void {
    if (capture.captureModel !== "rigged-experimental") return;
    capture.lastRiggedSignature ??= {};
    capture.lastRiggedUniqueElapsedMs ??= {};
    capture.pendingRiggedDuplicateIntervals ??= {};
    capture.riggedDuplicateIntervals ??= [];
    capture.riggedDuplicateIntervalsTruncated ??= false;
    capture.riggedDuplicateSampleCount ??= 0;
    capture.nextRiggedDuplicateIntervalId ??= capture.riggedDuplicateIntervals.length;
  }

  private omitRepeatedMetadata(
    hand: "left" | "right",
    sample: Record<string, unknown>,
    capture: NonNullable<TestingHandCapture["capture"]>,
  ): Record<string, unknown> {
    const result = { ...sample };
    const sampling = sample.sampling;
    if (sampling && typeof sampling === "object" && !Array.isArray(sampling)) {
      const samplingCopy = { ...(sampling as Record<string, unknown>) };
      const coverage = samplingCopy.coverage;
      if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
        const coverageCopy = { ...(coverage as Record<string, unknown>) };
        if (Array.isArray(coverageCopy.intervals)) {
          const signature = JSON.stringify(coverageCopy.intervals);
          if (signature !== capture.lastCoverageIntervals[hand]) {
            capture.lastCoverageIntervals[hand] = signature;
            capture.coverageRevision[hand] = (capture.coverageRevision[hand] ?? -1) + 1;
          } else delete coverageCopy.intervals;
          coverageCopy.revision = capture.coverageRevision[hand];
        }
        samplingCopy.coverage = coverageCopy;
      }
      result.sampling = samplingCopy;
    }
    const rendererRig = sample.rendererRig;
    if (rendererRig && typeof rendererRig === "object" && !Array.isArray(rendererRig)) {
      const rigCopy = { ...(rendererRig as Record<string, unknown>) };
      if (Array.isArray(rigCopy.nodeLabels)) {
        const signature = JSON.stringify(rigCopy.nodeLabels);
        if (signature !== capture.lastRendererNodeLabels[hand]) {
          capture.lastRendererNodeLabels[hand] = signature;
          capture.rendererNodeLabelsRevision[hand] = (capture.rendererNodeLabelsRevision[hand] ?? -1) + 1;
        } else delete rigCopy.nodeLabels;
        rigCopy.labelsRevision = capture.rendererNodeLabelsRevision[hand];
      }
      result.rendererRig = rigCopy;
    }
    const alignment = sample.bindAlignment;
    if (alignment && typeof alignment === "object" && !Array.isArray(alignment)) {
      const metadata = alignment as Record<string, unknown>;
      const key = `${hand}:${String(metadata.lod)}`;
      if (capture.seenBindAlignments.has(key)) delete result.bindAlignment;
      else capture.seenBindAlignments.add(key);
    }
    return result;
  }

  public shouldRecord(hand: "left" | "right", force = false): boolean {
    const capture = this.capture;
    if (!isDevelopment || !capture || capture.truncated) return false;
    if (force) return true;
    const previous = capture.lastSampleMonotonicMs[hand];
    if (previous === undefined || this.now().monotonic - previous >= this.intervalMs) return true;
    capture.throttledSamples += 1;
    return false;
  }

  public markTruncated(): void {
    if (this.capture) this.capture.truncated = true;
  }

  /** Detect boundaries crossed by playback. Large jumps/seeks reset the cursor;
   * the observed pose is the next rendered frame, never an invented exact pose. */
  public observeNoteBoundaries(hand: "left" | "right", notes: readonly TestingHandBoundaryNote[], time: number): TestingHandNoteBoundary[] {
    const capture = this.capture;
    if (!isDevelopment || !capture || capture.truncated || !Number.isFinite(time)) return [];
    const previous = capture.lastNoteTime[hand];
    capture.lastNoteTime[hand] = time;
    if (previous === undefined || time === previous) return [];
    if (time < previous || time - previous > 1) return [{
      kind: "timeline-discontinuity", previousFrameTimeSeconds: previous, observedFrameTimeSeconds: time,
      cause: time < previous ? "backward" : "forward-gap-over-one-second",
    }];
    const events: TestingHandNoteBoundary[] = [];
    for (const note of notes) {
      if (note.hand !== hand || note.finger === null || !Number.isInteger(note.finger) || note.finger < 1 || note.finger > 5) continue;
      for (const [kind, boundary] of [["note-start", note.startSeconds], ["note-end", note.endSeconds]] as const) {
        if (Number.isFinite(boundary) && boundary > previous && boundary <= time) {
          events.push({ kind, finger: note.finger, pitch: note.pitch, scheduledTimeSeconds: boundary, observedFrameTimeSeconds: time });
        }
      }
    }
    return events.sort((a, b) => {
      if (a.kind === "timeline-discontinuity" || b.kind === "timeline-discontinuity") return 0;
      return a.scheduledTimeSeconds - b.scheduledTimeSeconds;
    });
  }

  public updateConfiguration(settings: Record<string, unknown>): void {
    const capture = this.capture;
    if (!isDevelopment || !capture || capture.configurationTimelineTruncated) return;
    const current = capture.configurationTimeline.at(-1)?.settings;
    if (JSON.stringify(current) === JSON.stringify(settings)) return;
    if (capture.configurationTimeline.length >= 100) {
      capture.configurationTimelineTruncated = true;
      capture.truncated = true;
      return;
    }
    const time = this.now();
    capture.configurationTimeline.push({
      revision: capture.configurationTimeline.length,
      recordedAt: new Date(time.wall).toISOString(),
      elapsedMs: Math.max(0, Math.round(time.monotonic - capture.startedMonotonicMs)),
      settings,
    });
  }

  private takeSegment(final: boolean): TestingHandCapturePayload | null {
    const capture = this.capture;
    if (!capture) return null;
    this.ensureRiggedCaptureState(capture);
    if (capture.captureModel === "rigged-experimental" && final) {
      this.closePendingRiggedDuplicateInterval("left", "stop", capture);
      this.closePendingRiggedDuplicateInterval("right", "stop", capture);
    }
    const stoppedAt = new Date(this.now().wall).toISOString();
    const payload: TestingHandCapturePayload = {
      schemaVersion: 1,
      captureModel: capture.captureModel,
      captureId: capture.captureId,
      appVersion: this.version,
      buildId: this.buildId,
      formatSemantics: TESTING_HAND_CAPTURE_FORMAT_SEMANTICS,
      startedAt: capture.startedAt,
      stoppedAt,
      sampleIntervalMs: this.intervalMs,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      configuration: capture.configuration,
      provenanceAtStart: capture.provenanceAtStart,
      configurationTimeline: [...capture.configurationTimeline],
      configurationTimelineTruncated: capture.configurationTimelineTruncated,
      truncated: capture.truncated,
      throttledSamples: capture.throttledSamples,
      ...(capture.captureModel === "rigged-experimental" ? {
        riggedExperimentalDuplicateSummary: {
          schemaVersion: 1 as const,
          duplicateSampleCount: capture.riggedDuplicateSampleCount,
          intervals: [
            ...capture.riggedDuplicateIntervals,
            ...Object.values(capture.pendingRiggedDuplicateIntervals).filter((interval): interval is RiggedDuplicateInterval => interval !== undefined),
          ].slice(0, MAX_RIGGED_DUPLICATE_INTERVALS).map(interval => ({ ...interval })),
          intervalsTruncated: capture.riggedDuplicateIntervalsTruncated || capture.riggedDuplicateIntervals.length + Object.keys(capture.pendingRiggedDuplicateIntervals).length > MAX_RIGGED_DUPLICATE_INTERVALS,
        },
      } : {}),
      records: capture.records,
      segmentIndex: capture.segmentIndex++,
      segmentFinal: final,
    };
    capture.records = [];
    capture.bytes = 0;
    capture.lastRendererNodeLabels = {};
    capture.rendererNodeLabelsRevision = {};
    capture.lastCoverageIntervals = {};
    capture.coverageRevision = {};
    capture.seenBindAlignments.clear();
    return payload;
  }

  public stop(): TestingHandCapturePayload | null {
    const payload = this.takeSegment(true);
    this.capture = null;
    return payload;
  }

  public status(): TestingHandCaptureStatus {
    return {
      active: this.capture !== null,
      captureModel: this.capture?.captureModel ?? null,
      startedAt: this.capture?.startedAt ?? null,
      recordCount: this.capture?.records.length ?? 0,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      truncated: this.capture?.truncated ?? false,
      throttledSamples: this.capture?.throttledSamples ?? 0,
      duplicateSamples: this.capture?.riggedDuplicateSampleCount ?? 0,
    };
  }

  public isActiveFor(model: "testing" | "rigged-experimental"): boolean {
    return this.capture?.captureModel === model;
  }
}

const MAX_UNSAVED_SEGMENTS = 3;
const TESTING_HAND_CAPTURE_RUNTIME_STATE_KEY = Symbol.for("handthesia.pianomotion-studio.testing-hand-capture.runtime.v1");
interface TestingHandCaptureRuntimeState {
  capture: TestingHandCapture | null;
  unsavedSegments: TestingHandCapturePayload[];
  segmentError: string | null;
  savedSegmentCount: number;
  activeSegmentSave: Promise<unknown> | null;
  unsubscribeCaptureSettings: (() => void) | null;
}
const runtimeRegistry = globalThis as unknown as { [key: symbol]: unknown };
const captureRuntime = (runtimeRegistry[TESTING_HAND_CAPTURE_RUNTIME_STATE_KEY] ??= {
  capture: null,
  unsavedSegments: [],
  segmentError: null,
  savedSegmentCount: 0,
  activeSegmentSave: null,
  unsubscribeCaptureSettings: null,
}) as TestingHandCaptureRuntimeState;
// Keep these references stable across HMR module instances. A scene created
// before an edit and a refreshed diagnostics panel must still address one
// capture and one ordered save queue.
captureRuntime.unsavedSegments ??= [];
captureRuntime.segmentError ??= null;
captureRuntime.savedSegmentCount ??= 0;
captureRuntime.activeSegmentSave ??= null;
captureRuntime.unsubscribeCaptureSettings ??= null;
const unsavedSegments = captureRuntime.unsavedSegments;

export const testingHandCapture = captureRuntime.capture ??= new TestingHandCapture(undefined, undefined, undefined, undefined, undefined, undefined, undefined, segment => {
  captureRuntime.unsavedSegments.push(segment);
  void flushTestingHandSegments().catch(() => undefined);
});
if (Object.getPrototypeOf(testingHandCapture) !== TestingHandCapture.prototype) {
  Object.setPrototypeOf(testingHandCapture, TestingHandCapture.prototype);
}

export function testingHandSegmentStatus() {
  return { pending: unsavedSegments.length, saved: captureRuntime.savedSegmentCount, error: captureRuntime.segmentError };
}

/** Saves pending segments in order; failed parts remain in memory for retry. */
export async function flushTestingHandSegments(): Promise<void> {
  if (captureRuntime.activeSegmentSave) {
    await captureRuntime.activeSegmentSave;
    if (unsavedSegments.length) await flushTestingHandSegments();
    return;
  }
  captureRuntime.activeSegmentSave = (async () => {
    while (unsavedSegments.length) {
      try {
        await saveTestingHandCapture(unsavedSegments[0]!);
        unsavedSegments.shift();
        captureRuntime.savedSegmentCount++;
        captureRuntime.segmentError = null;
      } catch (error) {
        captureRuntime.segmentError = error instanceof Error ? error.message : "Could not save local diagnostic segment.";
        throw error;
      }
    }
  })();
  try { await captureRuntime.activeSegmentSave; } finally { captureRuntime.activeSegmentSave = null; }
}

export async function saveFinalTestingHandSegment(payload: TestingHandCapturePayload): Promise<void> {
  if (!unsavedSegments.some(segment => segment.captureId === payload.captureId && segment.segmentIndex === payload.segmentIndex)) unsavedSegments.push(payload);
  await flushTestingHandSegments();
}

export function isTestingHandCaptureActive(): boolean {
  return isHandFrameCaptureActiveFor("testing");
}

export function isHandFrameCaptureActiveFor(model: "testing" | "rigged-experimental"): boolean {
  return isDevelopment && testingHandCapture.isActiveFor(model);
}

export function startTestingHandCapture(configuration: Record<string, unknown> = {}, provenanceAtStart: Record<string, unknown> | null = null): TestingHandCaptureStatus {
  if (unsavedSegments.length) return testingHandCapture.status();
  captureRuntime.savedSegmentCount = 0;
  captureRuntime.segmentError = null;
  return testingHandCapture.start(configuration, provenanceAtStart);
}

/** Snapshot the local checkout before recording; unavailable is never treated as clean. */
export async function readTestingHandProvenance(): Promise<Record<string, unknown> | null> {
  if (!isDevelopment) return null;
  try {
    const response = await fetch(new URL(`${TESTING_HAND_CAPTURE_ENDPOINT}/provenance`, window.location.origin), {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const result = await response.json() as { provenance?: unknown };
    return result.provenance && typeof result.provenance === "object" && !Array.isArray(result.provenance)
      ? result.provenance as Record<string, unknown> : null;
  } catch { return null; }
}

export function recordTestingHandSample(hand: "left" | "right", sample: Record<string, unknown>, force = false): boolean {
  if (!isHandFrameCaptureActiveFor("testing")) return false;
  if (unsavedSegments.length >= MAX_UNSAVED_SEGMENTS) {
    testingHandCapture.markTruncated();
    return false;
  }
  return testingHandCapture.record(hand, sample, force);
}

export function shouldRecordTestingHandSample(hand: "left" | "right", force = false): boolean {
  if (!isHandFrameCaptureActiveFor("testing")) return false;
  return testingHandCapture.shouldRecord(hand, force);
}

export function recordHandFrameSample(
  model: "testing" | "rigged-experimental",
  hand: "left" | "right",
  sample: Record<string, unknown>,
  force = false,
): boolean {
  if (!isHandFrameCaptureActiveFor(model)) return false;
  if (unsavedSegments.length >= MAX_UNSAVED_SEGMENTS) {
    testingHandCapture.markTruncated();
    return false;
  }
  return testingHandCapture.record(hand, sample, force);
}

export function shouldRecordHandFrameSample(model: "testing" | "rigged-experimental", hand: "left" | "right", force = false): boolean {
  if (!isHandFrameCaptureActiveFor(model)) return false;
  return testingHandCapture.shouldRecord(hand, force);
}

export function observeTestingHandNoteBoundaries(hand: "left" | "right", notes: readonly TestingHandBoundaryNote[], time: number): TestingHandNoteBoundary[] {
  return testingHandCapture.observeNoteBoundaries(hand, notes, time);
}

export function observeHandFrameNoteBoundaries(hand: "left" | "right", notes: readonly TestingHandBoundaryNote[], time: number): TestingHandNoteBoundary[] {
  return testingHandCapture.observeNoteBoundaries(hand, notes, time);
}

export function updateTestingHandCaptureConfiguration(settings: Record<string, unknown>): void {
  testingHandCapture.updateConfiguration(settings);
}

/** Remains active even if the diagnostics panel is closed while recording. */
export function setTestingHandCaptureSettingsSubscription(unsubscribe: () => void): void {
  captureRuntime.unsubscribeCaptureSettings?.();
  if (testingHandCapture.status().active) captureRuntime.unsubscribeCaptureSettings = unsubscribe;
  else { unsubscribe(); captureRuntime.unsubscribeCaptureSettings = null; }
}

export function stopTestingHandCapture(): TestingHandCapturePayload | null {
  captureRuntime.unsubscribeCaptureSettings?.();
  captureRuntime.unsubscribeCaptureSettings = null;
  return testingHandCapture.stop();
}

export async function saveTestingHandCapture(payload: TestingHandCapturePayload): Promise<{
  savedTo: string;
  format: "pretty" | "compact";
  fileCount: number;
  maxFiles: number;
  totalBytes: number;
  maxTotalBytes: number;
}> {
  if (!isDevelopment) throw new Error("Hand frame diagnostics can only be saved by the local development server.");
  const endpoint = payload.captureModel === "rigged-experimental"
    ? RIGGED_EXPERIMENTAL_HAND_CAPTURE_ENDPOINT
    : TESTING_HAND_CAPTURE_ENDPOINT;
  const response = await fetch(new URL(endpoint, window.location.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof result.message === "string" ? result.message : `Local hand diagnostic endpoint returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  if (typeof result.savedTo !== "string" || (result.format !== "pretty" && result.format !== "compact") ||
      !Number.isSafeInteger(result.fileCount) ||
      !Number.isSafeInteger(result.maxFiles) || !Number.isSafeInteger(result.totalBytes) ||
      !Number.isSafeInteger(result.maxTotalBytes)) {
    throw new Error("The local diagnostic endpoint returned an invalid save confirmation.");
  }
  return {
    savedTo: result.savedTo,
    format: result.format,
    fileCount: result.fileCount as number,
    maxFiles: result.maxFiles as number,
    totalBytes: result.totalBytes as number,
    maxTotalBytes: result.maxTotalBytes as number,
  };
}
