import type { MotionPose } from "@handthesia/contracts";
import type { Graphics } from "pixi.js";
import { LOWEST_PIANO_KEY, type KeyboardLayout } from "../keyboardView";
import {
  depthScale,
  FINGER_W_IN,
  SEG_TAPER,
  type SkinSettings,
} from "./types";

export interface ScreenPoint {
  x: number;
  y: number;
  zIn: number;
}

export interface FingerSegment {
  a: ScreenPoint;
  b: ScreenPoint;
  radius: number;
  length: number;
  u: { x: number; y: number };
  n: { x: number; y: number };
}

export interface HandGeometry {
  hand: "left" | "right";
  layerOrder: number;
  wristR: ScreenPoint;
  wristU: ScreenPoint;
  wristCenter: ScreenPoint;
  wristWidth: number;
  armEnd: ScreenPoint;
  armUnit: { x: number; y: number };
  chains: Record<number, ScreenPoint[]>;
  radius: Record<number, FingerSegment[]>;
  palm: Array<[number, number]>;
  web: Array<[number, number]>;
  webEdge: Array<[number, number]>;
  palmZIn: number;
  outlineWidth: number;
}

export function unitVector(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

/** 2D convex hull via monotone chain */
export function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return [...pts];
  const sorted = [...pts]
    .map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as [number, number])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const unique: Array<[number, number]> = [];
  for (const p of sorted) {
    if (
      unique.length === 0 ||
      unique[unique.length - 1]![0] !== p[0] ||
      unique[unique.length - 1]![1] !== p[1]
    ) {
      unique.push(p);
    }
  }
  if (unique.length < 3) return unique;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Array<[number, number]> = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Chaikin curve subdivision algorithm */
export function chaikin(pts: Array<[number, number]>, iterations = 2): Array<[number, number]> {
  if (pts.length < 3) return [...pts];
  let curr = pts;
  for (let iter = 0; iter < iterations; iter++) {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < curr.length; i++) {
      const a = curr[i]!;
      const b = curr[(i + 1) % curr.length]!;
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    curr = out;
  }
  return curr;
}

/** Inflate convex polygon outwards from its centroid by d pixels */
export function inflate(pts: Array<[number, number]>, d: number): Array<[number, number]> {
  if (pts.length === 0) return [];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;

  return pts.map(([x, y]) => {
    const u = unitVector(x - cx, y - cy);
    return [x + u.x * d, y + u.y * d];
  });
}

/** Draw capsule between points a and b with radius r */
export function drawCapsule(
  g: Graphics,
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: number,
  color: number,
  alpha = 1,
): void {
  drawTaperedCapsule(g, a, b, r, r, color, alpha);
}

/** Draw tapered capsule between points a and b with radius r1 at a and r2 at b */
export function drawTaperedCapsule(
  g: Graphics,
  a: { x: number; y: number },
  b: { x: number; y: number },
  r1: number,
  r2: number,
  color: number,
  alpha = 1,
): void {
  const safeR1 = Math.max(0.5, r1);
  const safeR2 = Math.max(0.5, r2);
  const u = unitVector(b.x - a.x, b.y - a.y);
  const nx = -u.y;
  const ny = u.x;

  g.poly([
    a.x + nx * safeR1, a.y + ny * safeR1,
    b.x + nx * safeR2, b.y + ny * safeR2,
    b.x - nx * safeR2, b.y - ny * safeR2,
    a.x - nx * safeR1, a.y - ny * safeR1,
  ]).fill({ color, alpha });

  g.circle(a.x, a.y, safeR1).fill({ color, alpha });
  g.circle(b.x, b.y, safeR2).fill({ color, alpha });
}

/** Draw oriented rectangle centered at center, long side along u */
export function drawBand(
  g: Graphics,
  center: { x: number; y: number },
  u: { x: number; y: number },
  halfLength: number,
  halfWidth: number,
  color: number,
  alpha = 1,
): void {
  const nx = -u.y;
  const ny = u.x;
  const pts = [
    center.x - u.x * halfLength - nx * halfWidth, center.y - u.y * halfLength - ny * halfWidth,
    center.x + u.x * halfLength - nx * halfWidth, center.y + u.y * halfLength - ny * halfWidth,
    center.x + u.x * halfLength + nx * halfWidth, center.y + u.y * halfLength + ny * halfWidth,
    center.x - u.x * halfLength + nx * halfWidth, center.y - u.y * halfLength + ny * halfWidth,
  ];
  g.poly(pts).fill({ color, alpha });
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

type MotionBone = MotionPose["bones"][number];
const DIGIT_ORDER = [2, 3, 4, 5, 1] as const;

function getDistalBonesByFinger(pose: MotionPose): Map<number, MotionBone> {
  const tips = pose.joints.filter((joint) => joint.kind === "tip");
  const distals = pose.bones.filter((bone) => bone.kind === "distal");
  if (tips.length !== DIGIT_ORDER.length || distals.length !== DIGIT_ORDER.length) return new Map();

  // The DTO retains the hand skeleton's digit-group order: index through
  // little finger, then thumb. Match each ordered distal endpoint to its
  // corresponding tip; never infer identity from horizontal position.
  const result = new Map<number, MotionBone>();
  for (const [index, finger] of DIGIT_ORDER.entries()) {
    const distal = distals[index]!;
    if (dist3(distal.b, tips[index]!.point) >= 0.05) return new Map();
    result.set(finger, distal);
  }
  return result;
}

function findUniqueConnectedBone(
  pose: MotionPose,
  kind: MotionBone["kind"],
  point: [number, number, number],
): MotionBone | null {
  const matches = pose.bones.filter((bone) =>
    bone.kind === kind && (dist3(bone.a, point) < 0.05 || dist3(bone.b, point) < 0.05),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function otherEnd(bone: MotionBone | null, point: [number, number, number]): [number, number, number] | null {
  if (!bone) return null;
  if (dist3(bone.b, point) < 0.05) return bone.a;
  if (dist3(bone.a, point) < 0.05) return bone.b;
  return null;
}

/**
 * Maps canonical fingertips from the five ordered distal bones. Incomplete or
 * inconsistently ordered skeletons deliberately produce no labels.
 */
export function getFingerTipsByFinger(
  pose: MotionPose,
): Map<number, [number, number, number]> {
  return new Map([...getDistalBonesByFinger(pose)].map(([finger, bone]) => [finger, bone.b]));
}

/**
 * Reconstructs anatomical hand structures and screen geometry from MotionPose
 */
export function buildHandGeometry(
  pose: MotionPose,
  keyboardLayout: KeyboardLayout,
  skinSettings: SkinSettings,
): HandGeometry {
  const key21 = keyboardLayout.getKeyRect(LOWEST_PIANO_KEY);
  const keyboardLeft = key21 ? key21.x : keyboardLayout.rect.x;
  const keyboardBottom = keyboardLayout.rect.y + keyboardLayout.rect.height;
  const ppi = keyboardLayout.ppi > 0 ? keyboardLayout.ppi : 50;
  const isLeft = pose.hand === "left";
  const fw = skinSettings.finger_width;
  const outlineWidth = Math.max(1.0, skinSettings.outline * 0.035 * ppi);

  const toScreen = (pt: [number, number, number]): ScreenPoint => ({
    x: keyboardLeft + pt[0] * ppi,
    y: keyboardBottom - pt[1] * ppi,
    zIn: pt[2],
  });

  // 1. Identify Wrist
  const wristJoints = pose.joints.filter((j) => j.kind === "wrist");
  let wr: ScreenPoint;
  let wu: ScreenPoint;

  if (wristJoints.length >= 2) {
    const w0 = toScreen(wristJoints[0]!.point);
    const w1 = toScreen(wristJoints[1]!.point);
    // Radial side (wr) has larger X for left hand, smaller X for right hand
    if (isLeft) {
      if (w0.x >= w1.x) {
        wr = w0;
        wu = w1;
      } else {
        wr = w1;
        wu = w0;
      }
    } else {
      if (w0.x <= w1.x) {
        wr = w0;
        wu = w1;
      } else {
        wr = w1;
        wu = w0;
      }
    }
  } else if (pose.bones.length > 0) {
    // Fallback: estimate from bones
    const firstBone = pose.bones[0]!;
    wr = toScreen(firstBone.a);
    wu = { x: wr.x + (isLeft ? -15 : 15), y: wr.y, zIn: wr.zIn };
  } else {
    wr = { x: keyboardLeft + (isLeft ? 200 : 400), y: keyboardBottom - 50, zIn: 0.5 };
    wu = { x: wr.x + (isLeft ? -20 : 20), y: wr.y, zIn: 0.5 };
  }

  const wristCenter: ScreenPoint = {
    x: (wr.x + wu.x) / 2,
    y: (wr.y + wu.y) / 2,
    zIn: (wr.zIn + wu.zIn) / 2,
  };
  const wristWidth = Math.max(10, Math.hypot(wu.x - wr.x, wu.y - wr.y));
  // Keep all fallback interpolation in the same keyboard-local inch space as
  // MotionPose. Mixing a local bone point with this screen-space center makes
  // the reconstructed segment grow by roughly the canvas' pixel offset.
  const wristCenterLocal: [number, number, number] = [
    (wristCenter.x - keyboardLeft) / ppi,
    (keyboardBottom - wristCenter.y) / ppi,
    wristCenter.zIn,
  ];
  const radialWristLocal: [number, number, number] = [
    (wr.x - keyboardLeft) / ppi,
    (keyboardBottom - wr.y) / ppi,
    wr.zIn,
  ];

  // 2. Forearm / armEnd
  const forearmBones = pose.bones.filter((b) => b.kind === "forearm");
  let armEnd: ScreenPoint;
  if (forearmBones.length > 0) {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const fb of forearmBones) {
      const p = toScreen(fb.b);
      sumX += p.x;
      sumY += p.y;
      sumZ += p.zIn;
    }
    armEnd = {
      x: sumX / forearmBones.length,
      y: sumY / forearmBones.length,
      zIn: sumZ / forearmBones.length,
    };
  } else {
    // Default forearm points down (south on screen)
    armEnd = {
      x: wristCenter.x,
      y: wristCenter.y + 7.0 * ppi,
      zIn: wristCenter.zIn + 0.4,
    };
  }

  const armUnit = unitVector(armEnd.x - wristCenter.x, armEnd.y - wristCenter.y);

  // 3. Tip Joints & Anatomical Finger Assignment
  const distalByFinger = getDistalBonesByFinger(pose);

  // 4. Chains Extraction
  const chains: Record<number, ScreenPoint[]> = {};
  const radius: Record<number, FingerSegment[]> = {};

  for (let f = 1; f <= 5; f++) {
    const distalBone = distalByFinger.get(f);
    if (!distalBone) continue;

    // Bone direction is proximal-to-distal in MotionPose; its distal endpoint
    // is the fingertip and remains authoritative even when tips overlap.
    const bTip = distalBone.b;
    const aDip = distalBone.a;

    if (f === 1) {
        // Thumb: proximal -> metacarpal
        const aMcp = otherEnd(findUniqueConnectedBone(pose, "proximal", aDip), aDip)
          ?? [(aDip[0] + wristCenterLocal[0]) / 2, (aDip[1] + wristCenterLocal[1]) / 2, aDip[2]];
        const aCmc = otherEnd(findUniqueConnectedBone(pose, "metacarpal", aMcp), aMcp) ?? radialWristLocal;

        chains[1] = [toScreen(aCmc), toScreen(aMcp), toScreen(aDip), toScreen(bTip)];
      } else {
        // Fingers 2..5: middle -> proximal -> metacarpal
        const aPip = otherEnd(findUniqueConnectedBone(pose, "middle", aDip), aDip)
          ?? [(aDip[0] + wristCenterLocal[0]) / 2, (aDip[1] + wristCenterLocal[1]) / 2, aDip[2]];
        const aMcp = otherEnd(findUniqueConnectedBone(pose, "proximal", aPip), aPip)
          ?? [(aPip[0] + wristCenterLocal[0]) / 2, (aPip[1] + wristCenterLocal[1]) / 2, aPip[2]];
        const aBase = otherEnd(findUniqueConnectedBone(pose, "metacarpal", aMcp), aMcp) ?? wristCenterLocal;

        chains[f] = [toScreen(aBase), toScreen(aMcp), toScreen(aPip), toScreen(aDip), toScreen(bTip)];
    }

    // 5. Build Finger Segments & Radii
    const c = chains[f]!;
    const segs: FingerSegment[] = [];
    const baseW = (FINGER_W_IN[f] ?? 0.70) * fw * ppi / 2;

    if (f === 1) {
      // Thumb: 3 segments (cmc->mcp, mcp->ip, ip->tip)
      const rs = [baseW * 1.22, baseW * 1.0, baseW * 0.9];
      for (let i = 0; i < Math.min(3, c.length - 1); i++) {
        const a = c[i]!;
        const b = c[i + 1]!;
        const midZ = (a.zIn + b.zIn) / 2;
        const rad = rs[i]! * depthScale(midZ);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const u = unitVector(dx, dy);
        segs.push({
          a,
          b,
          radius: rad,
          length: len,
          u,
          n: { x: -u.y, y: u.x },
        });
      }
    } else {
      // Fingers 2..5: segments outside palm are 1->2 (prox), 2->3 (mid), 3->4 (dist)
      const rs = SEG_TAPER.map((t) => baseW * t);
      const startIndex = c.length >= 5 ? 1 : 0;
      for (let i = startIndex; i < c.length - 1; i++) {
        const a = c[i]!;
        const b = c[i + 1]!;
        const midZ = (a.zIn + b.zIn) / 2;
        const segIdx = Math.min(2, i - startIndex);
        const rad = rs[segIdx]! * depthScale(midZ);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const u = unitVector(dx, dy);
        segs.push({
          a,
          b,
          radius: rad,
          length: len,
          u,
          n: { x: -u.y, y: u.x },
        });
      }
    }
    radius[f] = segs;
  }

  // 6. Palm Polygon
  const palmPts: ScreenPoint[] = [wr, wu];
  if (chains[1] && chains[1][0]) palmPts.push(chains[1][0]);
  for (let f = 2; f <= 5; f++) {
    if (chains[f]) {
      if (chains[f]![1]) palmPts.push(chains[f]![1]!);
      if (chains[f]![0]) palmPts.push(chains[f]![0]!);
    }
  }

  const palmZIn = palmPts.reduce((acc, p) => acc + p.zIn, 0) / Math.max(1, palmPts.length);

  const flatPalm: Array<[number, number]> = palmPts.map((p) => [p.x, p.y]);
  for (let f = 2; f <= 5; f++) {
    const c = chains[f];
    const segs = radius[f];
    if (c && c.length >= 2 && segs && segs.length > 0) {
      const base = c[0]!;
      const mcp = c[1]!;
      const u = unitVector(mcp.x - base.x, mcp.y - base.y);
      const n = { x: -u.y, y: u.x };
      const r = segs[0]!.radius * (f === 2 || f === 5 ? 1.12 : 1.0);
      flatPalm.push([mcp.x + n.x * r, mcp.y + n.y * r]);
      flatPalm.push([mcp.x - n.x * r, mcp.y - n.y * r]);
      if (f === 2 || f === 5) {
        for (const t of [0.35, 0.7]) {
          const qx = mcp.x + (base.x - mcp.x) * t;
          const qy = mcp.y + (base.y - mcp.y) * t;
          flatPalm.push([qx + n.x * r * 0.9, qy + n.y * r * 0.9]);
          flatPalm.push([qx - n.x * r * 0.9, qy - n.y * r * 0.9]);
        }
      }
    }
  }

  const hull = convexHull(flatPalm);
  const palm = hull.length >= 3 ? chaikin(inflate(hull, 0.08 * fw * ppi), 2) : hull;

  // 7. Thenar Web (Thumb to Index)
  let web: Array<[number, number]> = [];
  let webEdge: Array<[number, number]> = [];

  if (chains[1] && chains[2] && chains[1].length >= 3 && chains[2].length >= 2 && radius[1] && radius[2]) {
    const th = chains[1];
    const ix = chains[2];
    const cmc = th[0]!;
    const tMcp = th[1]!;
    const tIp = th[2]!;
    const base2 = ix[0]!;
    const mcp2 = ix[1]!;
    const rT = radius[1][1]?.radius ?? 8;
    const rI = radius[2][0]?.radius ?? 8;

    // Index side
    const uIx = unitVector(mcp2.x - base2.x, mcp2.y - base2.y);
    let nIx = { x: -uIx.y, y: uIx.x };
    if ((cmc.x - mcp2.x) * nIx.x + (cmc.y - mcp2.y) * nIx.y < 0) {
      nIx = { x: -nIx.x, y: -nIx.y };
    }
    const kOut = { x: mcp2.x + nIx.x * rI * 0.9, y: mcp2.y + nIx.y * rI * 0.9 };
    const kMid = {
      x: mcp2.x + (base2.x - mcp2.x) * 0.45 + nIx.x * rI * 0.8,
      y: mcp2.y + (base2.y - mcp2.y) * 0.45 + nIx.y * rI * 0.8,
    };

    // Thumb side
    const aTh = {
      x: tMcp.x + (tIp.x - tMcp.x) * 0.35,
      y: tMcp.y + (tIp.y - tMcp.y) * 0.35,
    };
    const uTh = unitVector(tIp.x - tMcp.x, tIp.y - tMcp.y);
    let mTh = { x: -uTh.y, y: uTh.x };
    if ((mcp2.x - aTh.x) * mTh.x + (mcp2.y - aTh.y) * mTh.y < 0) {
      mTh = { x: -mTh.x, y: -mTh.y };
    }
    const tAtt = { x: aTh.x + mTh.x * rT * 0.7, y: aTh.y + mTh.y * rT * 0.7 };
    const tRoot = { x: tMcp.x + mTh.x * rT * 0.8, y: tMcp.y + mTh.y * rT * 0.8 };

    // Curve sagging towards wrist center
    const span = Math.hypot(kOut.x - tAtt.x, kOut.y - tAtt.y);
    let reach = 0;
    for (let i = 0; i < th.length - 1; i++) {
      reach += Math.hypot(th[i + 1]!.x - th[i]!.x, th[i + 1]!.y - th[i]!.y);
    }
    const spread = Math.min(1.0, span / Math.max(1e-6, 0.55 * reach));
    const mid = { x: (tAtt.x + kOut.x) / 2, y: (tAtt.y + kOut.y) / 2 };
    const sag = span * (0.32 - 0.2 * spread);
    const d = unitVector(wristCenter.x - mid.x, wristCenter.y - mid.y);
    const ctrl = { x: mid.x + d.x * sag * 2, y: mid.y + d.y * sag * 2 };

    const edge: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const oneMinusT = 1 - t;
      const ex = oneMinusT * oneMinusT * tAtt.x + 2 * oneMinusT * t * ctrl.x + t * t * kOut.x;
      const ey = oneMinusT * oneMinusT * tAtt.y + 2 * oneMinusT * t * ctrl.y + t * t * kOut.y;
      edge.push([ex, ey]);
    }
    webEdge = edge;
    web = [[cmc.x, cmc.y], [tRoot.x, tRoot.y], ...edge, [kMid.x, kMid.y], [base2.x, base2.y]];
  }

  return {
    hand: pose.hand,
    layerOrder: pose.layerOrder,
    wristR: wr,
    wristU: wu,
    wristCenter,
    wristWidth,
    armEnd,
    armUnit,
    chains,
    radius,
    palm,
    web,
    webEdge,
    palmZIn,
    outlineWidth,
  };
}
