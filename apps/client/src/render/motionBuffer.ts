import type {
  InitialMotionWindow,
  MotionPose,
  M1SampleMotionResult,
} from "@handthesia/contracts";
import { LOWEST_PIANO_KEY, type KeyboardLayout, type KeyRect } from "./keyboardView";
import { getFingerTipsByFinger } from "./skins";

export interface MotionBufferOptions {
  windowAheadSeconds?: number;
  windowBehindSeconds?: number;
  expectedHands?: readonly MotionHand[];
  requiredAnchors?: readonly MotionRequiredAnchor[];
}

export type MotionHand = "left" | "right";

export interface MotionRequiredAnchor {
  hand: MotionHand;
  timeSeconds: number;
  toleranceSeconds?: number;
}

export const MAX_POSE_GAP_SECONDS = 0.25;

export interface MotionBufferRange {
  start: number;
  end: number;
}

export interface HandCoverageInterval {
  start: number;
  end: number;
}

export function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ];
}

export function lerpPose(p0: MotionPose, p1: MotionPose, alpha: number): MotionPose {
  if (p0.bones.length !== p1.bones.length || p0.joints.length !== p1.joints.length) {
    return alpha < 0.5 ? p0 : p1;
  }

  const bones = p0.bones.map((bone, i) => {
    const other = p1.bones[i]!;
    return {
      a: lerp3(bone.a, other.a, alpha),
      b: lerp3(bone.b, other.b, alpha),
      kind: bone.kind,
      boneId: bone.boneId,
    };
  });

  const joints = p0.joints.map((joint, i) => {
    const other = p1.joints[i]!;
    return {
      point: lerp3(joint.point, other.point, alpha),
      kind: joint.kind,
    };
  });

  return {
    hand: p0.hand,
    transportTimeSeconds:
      p0.transportTimeSeconds +
      (p1.transportTimeSeconds - p0.transportTimeSeconds) * alpha,
    layerOrder: alpha < 0.5 ? p0.layerOrder : p1.layerOrder,
    bones,
    joints,
  };
}

export interface TouchContactVerification {
  inContact: boolean;
  fingerTip: [number, number, number] | null;
  zInches: number | null;
  zContact: boolean;
  xInBounds: boolean;
  keyRect?: KeyRect;
  tipScreenX?: number;
  reason?: string;
}

const DIGIT_ORDER = [2, 3, 4, 5, 1] as const;

export function getDistalTipPosition(
  pose: MotionPose,
  finger: number,
): [number, number, number] | null {
  const tips = getFingerTipsByFinger(pose);
  const found = tips.get(finger);
  if (found) return found;

  const distals = pose.bones.filter((b) => b.kind === "distal");
  const idx = DIGIT_ORDER.indexOf(finger as (typeof DIGIT_ORDER)[number]);
  if (idx !== -1 && idx < distals.length) {
    return distals[idx]!.b;
  }
  return null;
}

export function verifyTouchContact(
  pose: MotionPose,
  finger: number,
  pitch: number,
  keyboardLayout: KeyboardLayout,
  zTolerance = 0.1,
): TouchContactVerification {
  const tip = getDistalTipPosition(pose, finger);
  if (!tip) {
    return {
      inContact: false,
      fingerTip: null,
      zInches: null,
      zContact: false,
      xInBounds: false,
      reason: `Finger ${finger} distal tip not found in pose`,
    };
  }

  const keyRect = keyboardLayout.getKeyRect(pitch);
  if (!keyRect) {
    return {
      inContact: false,
      fingerTip: tip,
      zInches: tip[2],
      zContact: tip[2] <= zTolerance,
      xInBounds: false,
      reason: `Pitch ${pitch} not found in keyboard layout`,
    };
  }

  const key21 = keyboardLayout.getKeyRect(LOWEST_PIANO_KEY);
  const keyboardLeft = key21 ? key21.x : keyboardLayout.rect.x;
  const ppi = keyboardLayout.ppi > 0 ? keyboardLayout.ppi : 50;

  const tipScreenX = keyboardLeft + tip[0] * ppi;
  const xInBounds = tipScreenX >= keyRect.x && tipScreenX <= keyRect.x + keyRect.width;
  const zContact = tip[2] <= zTolerance;
  const inContact = xInBounds && zContact;

  return {
    inContact,
    fingerTip: tip,
    zInches: tip[2],
    zContact,
    xInBounds,
    keyRect,
    tipScreenX,
    reason: inContact
      ? undefined
      : !zContact && !xInBounds
        ? `Z height (${tip[2].toFixed(3)}in > ${zTolerance}in) and X (${tipScreenX.toFixed(1)}px outside [${keyRect.x}, ${keyRect.x + keyRect.width}]) failed`
        : !zContact
          ? `Z height (${tip[2].toFixed(3)}in > ${zTolerance}in) failed`
          : `X position (${tipScreenX.toFixed(1)}px outside key bounds [${keyRect.x}, ${keyRect.x + keyRect.width}]) failed`,
  };
}

export class MotionBuffer {
  public bufferedRange: MotionBufferRange | null = null;
  public poses: MotionPose[] = [];
  public windowAheadSeconds = 4.0;
  public windowBehindSeconds = 1.0;
  public currentTime = 0;

  private leftPoses: MotionPose[] = [];
  private rightPoses: MotionPose[] = [];
  private expectedHands: MotionHand[] | null = null;
  private requiredAnchors: MotionRequiredAnchor[] = [];
  private declaredCoverage: Record<MotionHand, HandCoverageInterval[]> = { left: [], right: [] };
  private verifiedCoverage: Record<MotionHand, HandCoverageInterval[]> = { left: [], right: [] };

  public constructor(options?: MotionBufferOptions) {
    if (options?.windowAheadSeconds !== undefined) {
      this.windowAheadSeconds = options.windowAheadSeconds;
    }
    if (options?.windowBehindSeconds !== undefined) {
      this.windowBehindSeconds = options.windowBehindSeconds;
    }
    if (options?.expectedHands !== undefined) {
      this.setExpectedHands(options.expectedHands);
    }
    if (options?.requiredAnchors !== undefined) {
      this.setRequiredAnchors(options.requiredAnchors);
    }
  }

  public addPoses(newPoses: MotionPose[], currentTime?: number): void {
    if (currentTime !== undefined) {
      this.currentTime = currentTime;
    }

    if (newPoses.length === 0 && this.poses.length === 0) {
      this.bufferedRange = null;
      return;
    }

    const combined = this.poses.concat(newPoses);

    // Sort by time, then left hand before right hand
    combined.sort((a, b) => {
      const dt = a.transportTimeSeconds - b.transportTimeSeconds;
      if (Math.abs(dt) > 1e-6) return dt;
      return a.hand === b.hand ? 0 : a.hand === "left" ? -1 : 1;
    });

    // Deduplicate identical time + hand
    const deduped: MotionPose[] = [];
    for (const pose of combined) {
      if (deduped.length > 0) {
        const prev = deduped[deduped.length - 1]!;
        if (
          Math.abs(prev.transportTimeSeconds - pose.transportTimeSeconds) < 1e-6 &&
          prev.hand === pose.hand
        ) {
          deduped[deduped.length - 1] = pose;
          continue;
        }
      }
      deduped.push(pose);
    }
    this.poses = deduped;

    // Prune poses older than currentTime - windowBehindSeconds
    this.pruneOlderThan(this.currentTime - this.windowBehindSeconds);

    this.rebuildHandPoses();
    this.rebuildVerifiedCoverage();
    this.updateBufferedRange();
  }

  public addSampleMotionResult(result: M1SampleMotionResult, currentTime?: number): void {
    this.addPoses(result.poses, currentTime);
    this.addCoverageMetadata(result.coverage);
  }

  public addInitialMotionWindow(window: InitialMotionWindow, currentTime?: number): void {
    this.addPoses(window.poses, currentTime);
    this.addCoverageMetadata(window.coverage);
  }

  public setExpectedHands(hands: readonly MotionHand[]): void {
    const expected = [...new Set(hands)];
    this.expectedHands = expected.length > 0 ? expected : null;
  }

  public setRequiredAnchors(anchors: readonly MotionRequiredAnchor[]): void {
    this.requiredAnchors = anchors
      .filter((anchor) => Number.isFinite(anchor.timeSeconds) && anchor.timeSeconds >= 0)
      .map((anchor) => ({ ...anchor }))
      .sort((a, b) => a.timeSeconds - b.timeSeconds || a.hand.localeCompare(b.hand));
  }

  public samplePose(time: number, hand: "left" | "right"): MotionPose | null {
    this.currentTime = time;
    const poses = hand === "left" ? this.leftPoses : this.rightPoses;
    if (poses.length === 0) return null;

    const first = poses[0]!;
    const last = poses[poses.length - 1]!;

    if (time < first.transportTimeSeconds - 1e-4 || time > last.transportTimeSeconds + 1e-4) {
      return null;
    }

    if (time <= first.transportTimeSeconds) return first;
    if (time >= last.transportTimeSeconds) return last;

    let lo = 0;
    let hi = poses.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (poses[mid]!.transportTimeSeconds <= time) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const i0 = Math.max(0, lo - 1);
    const i1 = Math.min(poses.length - 1, lo);
    const p0 = poses[i0]!;
    const p1 = poses[i1]!;

    if (i0 === i1) return p0;

    const dt = p1.transportTimeSeconds - p0.transportTimeSeconds;
    if (dt <= 1e-6) return p0;

    const alpha = Math.max(0, Math.min(1, (time - p0.transportTimeSeconds) / dt));
    return lerpPose(p0, p1, alpha);
  }

  /**
   * Samples hand pose with boundary clamping:
   * - If time <= first pose time, returns the initial pose (poised/ready-to-play posture).
   * - If time >= last pose time, returns the final pose (post-release posture).
   * - Inside the window, returns the linearly interpolated pose.
   * This ensures hands remain visible in ready posture before playback starts and during lead-in count-down.
   */
  public samplePoseClamped(time: number, hand: "left" | "right"): MotionPose | null {
    const poses = hand === "left" ? this.leftPoses : this.rightPoses;
    if (poses.length === 0) return null;
    const first = poses[0]!;
    if (time <= first.transportTimeSeconds) return first;
    const last = poses[poses.length - 1]!;
    if (time >= last.transportTimeSeconds) return last;
    return this.samplePose(time, hand);
  }

  public getFirstPose(hand: "left" | "right"): MotionPose | null {
    const poses = hand === "left" ? this.leftPoses : this.rightPoses;
    return poses[0] ?? null;
  }

  public getLastPose(hand: "left" | "right"): MotionPose | null {
    const poses = hand === "left" ? this.leftPoses : this.rightPoses;
    return poses[poses.length - 1] ?? null;
  }

  public getHandCoverageIntervals(hand: "left" | "right"): HandCoverageInterval[] {
    return this.verifiedCoverage[hand].map((interval) => ({ ...interval }));
  }

  public isHandCovered(hand: "left" | "right", start: number, end: number): boolean {
    if (end <= start) return true;
    const intervals = this.getHandCoverageIntervals(hand);
    return intervals.some((int) => int.start <= start + 1e-4 && int.end >= end - 1e-4);
  }

  public getHandContinuousCoverageUntil(hand: "left" | "right", currentTime: number): number | null {
    const intervals = this.getHandCoverageIntervals(hand);
    const covering = intervals.find((int) => int.start <= currentTime + 1e-4 && int.end >= currentTime - 1e-4);
    return covering ? covering.end : null;
  }

  public getActiveHands(): ("left" | "right")[] {
    if (this.expectedHands !== null) return [...this.expectedHands];
    const hands: ("left" | "right")[] = [];
    if (this.declaredCoverage.left.length > 0 || this.leftPoses.length > 0) hands.push("left");
    if (this.declaredCoverage.right.length > 0 || this.rightPoses.length > 0) hands.push("right");
    return hands.length > 0 ? hands : ["right"];
  }

  public hasCoverage(start: number, end: number): boolean {
    const active = this.getActiveHands();
    if (!active.every((hand) => this.isHandCovered(hand, start, end))) return false;
    let index = this.firstAnchorAtOrAfter(start - 1e-4);
    while (index < this.requiredAnchors.length) {
      const anchor = this.requiredAnchors[index]!;
      if (anchor.timeSeconds > end + 1e-4) break;
      if (!this.hasPoseAtAnchor(anchor)) return false;
      index += 1;
    }
    return true;
  }

  public needsMorePoses(currentTime: number): boolean {
    this.currentTime = currentTime;
    if (this.poses.length === 0) {
      return true;
    }
    const targetEnd = currentTime + 1.5;
    // A10: All active hands must have continuous coverage without gaps > 250ms
    return !this.hasCoverage(currentTime, targetEnd);
  }

  public getMissingWindow(currentTime: number): { start: number; end: number } {
    this.currentTime = currentTime;
    const targetEnd = currentTime + this.windowAheadSeconds;
    if (this.poses.length === 0) {
      return {
        start: currentTime,
        end: targetEnd,
      };
    }
    const active = this.getActiveHands();

    let minContinuousEnd: number | null = null;
    let coverageMissingAtCurrentTime = false;
    for (const hand of active) {
      const until = this.getHandContinuousCoverageUntil(hand, currentTime);
      if (until === null || until < currentTime - 1e-4) {
        coverageMissingAtCurrentTime = true;
        break;
      }
      minContinuousEnd = minContinuousEnd === null ? until : Math.min(minContinuousEnd, until);
    }

    // Select the earliest unresolved point across continuous per-hand coverage
    // and explicit event anchors. A later anchor must not make the caller skip
    // an earlier gap in the interpolation stream.
    let firstMissingTime = coverageMissingAtCurrentTime
      ? currentTime
      : Math.min(targetEnd, minContinuousEnd ?? currentTime);
    let anchorIndex = this.firstAnchorAtOrAfter(currentTime - 1e-4);
    while (anchorIndex < this.requiredAnchors.length) {
      const anchor = this.requiredAnchors[anchorIndex]!;
      if (anchor.timeSeconds > targetEnd + 1e-4) break;
      if (!this.hasPoseAtAnchor(anchor)) {
        firstMissingTime = Math.min(firstMissingTime, anchor.timeSeconds);
        break;
      }
      anchorIndex += 1;
    }

    // Keep the request end anchored to the configured horizon. The overlap is
    // only on the start, so a rolling 24s lookahead can still be fetched in
    // bounded chunks by its caller without silently growing each chunk.
    const hasPriorPoses = this.poses.some((p) => p.transportTimeSeconds <= currentTime + 1e-4);
    const start = firstMissingTime <= currentTime + 1e-4
      ? hasPriorPoses ? Math.max(0, currentTime - MAX_POSE_GAP_SECONDS) : currentTime
      : Math.max(0, firstMissingTime - MAX_POSE_GAP_SECONDS);
    return { start, end: targetEnd };
  }

  public prune(currentTime: number): void {
    this.currentTime = currentTime;
    this.pruneOlderThan(currentTime - this.windowBehindSeconds);
    this.rebuildHandPoses();
    this.rebuildVerifiedCoverage();
    this.updateBufferedRange();
  }

  public invalidate(): void {
    this.clear();
  }

  public clear(): void {
    this.poses = [];
    this.leftPoses = [];
    this.rightPoses = [];
    this.bufferedRange = null;
    this.declaredCoverage = { left: [], right: [] };
    this.verifiedCoverage = { left: [], right: [] };
  }

  public setBufferedRange(range: MotionBufferRange | null): void {
    this.bufferedRange = range;
  }

  private pruneOlderThan(cutoffTime: number): void {
    this.poses = this.poses.filter((p) => p.transportTimeSeconds >= cutoffTime - 1e-6);
    for (const hand of ["left", "right"] as const) {
      this.declaredCoverage[hand] = this.declaredCoverage[hand]
        .filter((interval) => interval.end >= cutoffTime - 1e-6)
        .map((interval) => ({ start: Math.max(interval.start, cutoffTime), end: interval.end }));
    }
  }

  private addCoverageMetadata(coverage: M1SampleMotionResult["coverage"] | InitialMotionWindow["coverage"]): void {
    if (!coverage) return;
    for (const hand of ["left", "right"] as const) {
      const metadata = coverage[hand];
      if (!metadata || metadata.poseCount === 0 || metadata.coveredEndTimeSeconds < metadata.coveredStartTimeSeconds) continue;
      const intervals = this.declaredCoverage[hand];
      intervals.push({ start: metadata.coveredStartTimeSeconds, end: metadata.coveredEndTimeSeconds });
      intervals.sort((a, b) => a.start - b.start || a.end - b.end);
      const merged: HandCoverageInterval[] = [];
      for (const interval of intervals) {
        const previous = merged[merged.length - 1];
        if (previous && interval.start <= previous.end + 1e-4) {
          previous.end = Math.max(previous.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
      this.declaredCoverage[hand] = merged;
    }
    this.rebuildVerifiedCoverage();
  }

  /** Only declare coverage where response metadata and renderable pose runs overlap. */
  private rebuildVerifiedCoverage(): void {
    for (const hand of ["left", "right"] as const) {
      const poses = hand === "left" ? this.leftPoses : this.rightPoses;
      const declared = this.declaredCoverage[hand];
      const verified: HandCoverageInterval[] = [];
      let coverageIndex = 0;

      const hasDeclaredPoseTime = (timeSeconds: number): boolean => {
        while (coverageIndex < declared.length && declared[coverageIndex]!.end < timeSeconds - 1e-4) {
          coverageIndex += 1;
        }
        const interval = declared[coverageIndex];
        return interval !== undefined && interval.start <= timeSeconds + 1e-4 && interval.end >= timeSeconds - 1e-4;
      };

      for (let index = 0; index + 1 < poses.length; index += 1) {
        const start = poses[index]!.transportTimeSeconds;
        const end = poses[index + 1]!.transportTimeSeconds;
        if (end - start > MAX_POSE_GAP_SECONDS + 1e-4) continue;

        // Metadata validates each endpoint, while the adjacent rendered poses
        // prove that interpolation bridges any tiny gap between response chunks.
        // Never bridge a metadata interval's full declared span on sparse poses.
        if (!hasDeclaredPoseTime(start) || !hasDeclaredPoseTime(end)) continue;

        const previous = verified[verified.length - 1];
        if (previous && start <= previous.end + 1e-4) {
          previous.end = Math.max(previous.end, end);
        } else {
          verified.push({ start, end });
        }
      }
      this.verifiedCoverage[hand] = verified;
    }
  }

  private hasPoseAtAnchor(anchor: MotionRequiredAnchor): boolean {
    const poses = anchor.hand === "left" ? this.leftPoses : this.rightPoses;
    const tolerance = Math.max(0, anchor.toleranceSeconds ?? 1e-3);
    const earliest = anchor.timeSeconds - tolerance;
    let low = 0;
    let high = poses.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (poses[middle]!.transportTimeSeconds < earliest) low = middle + 1;
      else high = middle;
    }
    return low < poses.length && poses[low]!.transportTimeSeconds <= anchor.timeSeconds + tolerance;
  }

  private firstAnchorAtOrAfter(timeSeconds: number): number {
    let low = 0;
    let high = this.requiredAnchors.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.requiredAnchors[middle]!.timeSeconds < timeSeconds) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private rebuildHandPoses(): void {
    this.leftPoses = [];
    this.rightPoses = [];
    for (const pose of this.poses) {
      if (pose.hand === "left") {
        this.leftPoses.push(pose);
      } else {
        this.rightPoses.push(pose);
      }
    }
  }

  private updateBufferedRange(): void {
    if (this.poses.length === 0) {
      this.bufferedRange = null;
    } else {
      this.bufferedRange = {
        start: this.poses[0]!.transportTimeSeconds,
        end: this.poses[this.poses.length - 1]!.transportTimeSeconds,
      };
    }
  }
}
