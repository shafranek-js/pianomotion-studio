import type { MotionPose } from "@handthesia/contracts";
import type { Graphics } from "pixi.js";
import { LOWEST_PIANO_KEY, type KeyboardLayout } from "../keyboardView";
import type { HandGeometry } from "./geometry";
import { depthScale, rgbToHex, type SkinSettings } from "./types";

const BONE_WIDTH_IN: Record<string, number> = {
  forearm: 0.16,
  carpal: 0.10,
  metacarpal: 0.14,
  proximal: 0.15,
  middle: 0.13,
  distal: 0.11,
};

const JOINT_RADIUS_IN: Record<string, number> = {
  knuckle: 0.085,
  tip: 0.075,
  wrist: 0.09,
};

function boneWidth(kind: string, zIn: number, ppi: number): number {
  const base = BONE_WIDTH_IN[kind] ?? 0.12;
  return Math.max(2, Math.round(base * ppi * depthScale(zIn)));
}

function jointRadius(kind: string, zIn: number, ppi: number): number {
  const base = JOINT_RADIUS_IN[kind] ?? 0.08;
  return Math.max(2, Math.round(base * ppi * depthScale(zIn)));
}

/**
 * Renders skeleton hand with bone segments, joints, and contrasting halo
 */
export function renderSkeletonSkin(
  graphics: Graphics,
  geom: HandGeometry,
  pose: MotionPose,
  keyboardLayout: KeyboardLayout,
  skinSettings: SkinSettings,
): void {
  const key21 = keyboardLayout.getKeyRect(LOWEST_PIANO_KEY);
  const keyboardLeft = key21 ? key21.x : keyboardLayout.rect.x;
  const keyboardBottom = keyboardLayout.rect.y + keyboardLayout.rect.height;
  const ppi = keyboardLayout.ppi > 0 ? keyboardLayout.ppi : 50;

  const toScreen = (pt: [number, number, number]) => ({
    x: keyboardLeft + pt[0] * ppi,
    y: keyboardBottom - pt[1] * ppi,
    zIn: pt[2],
  });

  const isLeft = pose.hand === "left";
  const accentColor = isLeft ? 0x3b82f6 : 0x10b981; // LH blue, RH green
  const haloColor = 0xd1d5db; // Light contrasting halo for bone readability
  const boneColor = rgbToHex(skinSettings.colors.skeleton.bone);

  // Optional subtle thenar web membrane
  if (skinSettings.details && geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill({ color: boneColor, alpha: 0.18 });
    for (let i = 0; i < geom.webEdge.length - 1; i++) {
      const p = geom.webEdge[i]!;
      const q = geom.webEdge[i + 1]!;
      graphics
        .moveTo(p[0], p[1])
        .lineTo(q[0], q[1])
        .stroke({ width: Math.max(1, 0.018 * ppi), color: boneColor, alpha: 0.45, cap: "round" });
    }
  }

  // 1. Wrist line between wrist joints
  const wristJoints = pose.joints.filter((j) => j.kind === "wrist");
  if (wristJoints.length >= 2) {
    const w0 = toScreen(wristJoints[0]!.point);
    const w1 = toScreen(wristJoints[1]!.point);
    graphics
      .moveTo(w0.x, w0.y)
      .lineTo(w1.x, w1.y)
      .stroke({ width: 3, color: haloColor, cap: "round" });
    graphics
      .moveTo(w0.x, w0.y)
      .lineTo(w1.x, w1.y)
      .stroke({ width: 2, color: boneColor, cap: "round" });
  }

  // 2. Draw Bones
  for (const bone of pose.bones) {
    const pa = toScreen(bone.a);
    const pb = toScreen(bone.b);
    const midZIn = (pa.zIn + pb.zIn) * 0.5;
    const width = boneWidth(bone.kind, midZIn, ppi);

    // Halo outline
    graphics
      .moveTo(pa.x, pa.y)
      .lineTo(pb.x, pb.y)
      .stroke({ width: width + 2, color: haloColor, cap: "round" });

    // Inner bone core
    graphics
      .moveTo(pa.x, pa.y)
      .lineTo(pb.x, pb.y)
      .stroke({ width, color: boneColor, cap: "round" });
  }

  // 3. Draw Joints (knuckles, wrists, tips)
  for (const joint of pose.joints) {
    const p = toScreen(joint.point);
    const radius = jointRadius(joint.kind, p.zIn, ppi);

    // Halo circle
    graphics.circle(p.x, p.y, radius + 1).fill(haloColor);

    // Inner circle
    if (joint.kind === "tip") {
      graphics.circle(p.x, p.y, radius + 1).fill(accentColor);
      graphics.circle(p.x, p.y, Math.max(2, radius - 1)).fill(0xffffff);
    } else {
      graphics.circle(p.x, p.y, radius).fill(boneColor);
    }
  }
}
