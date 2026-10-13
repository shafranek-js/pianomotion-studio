import type {
  MotionPose,
  M1SampleMotionResult,
} from "@handthesia/contracts";
import { LOWEST_PIANO_KEY, type KeyboardLayout, type KeyRect } from "./keyboardView";
import { getFingerTipsByFinger } from "./skins";

export interface MotionBufferOptions {
  windowAheadSeconds?: number;
  windowBehindSeconds?: number;
}

export interface MotionBufferRange {
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

  public constructor(options?: MotionBufferOptions) {
    if (options?.windowAheadSeconds !== undefined) {
      this.windowAheadSeconds = options.windowAheadSeconds;
    }
    if (options?.windowBehindSeconds !== undefined) {
      this.windowBehindSeconds = options.windowBehindSeconds;
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
    this.updateBufferedRange();
  }

  public addSampleMotionResult(result: M1SampleMotionResult, currentTime?: number): void {
    this.addPoses(result.poses, currentTime);
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

  public needsMorePoses(currentTime: number): boolean {
    this.currentTime = currentTime;
    if (this.bufferedRange === null) {
      return true;
    }
    return currentTime + 1.5 > this.bufferedRange.end;
  }

  public getMissingWindow(currentTime: number): { start: number; end: number } {
    this.currentTime = currentTime;
    const targetEnd = currentTime + this.windowAheadSeconds;
    if (this.bufferedRange === null || this.bufferedRange.end < currentTime) {
      return {
        start: currentTime,
        end: targetEnd,
      };
    }
    const start = this.bufferedRange.end;
    const end = targetEnd > start ? targetEnd : start + this.windowAheadSeconds;
    return { start, end };
  }

  public prune(currentTime: number): void {
    this.currentTime = currentTime;
    this.pruneOlderThan(currentTime - this.windowBehindSeconds);
    this.rebuildHandPoses();
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
  }

  public setBufferedRange(range: MotionBufferRange | null): void {
    this.bufferedRange = range;
  }

  private pruneOlderThan(cutoffTime: number): void {
    if (this.poses.length === 0) return;
    this.poses = this.poses.filter((p) => p.transportTimeSeconds >= cutoffTime - 1e-6);
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
