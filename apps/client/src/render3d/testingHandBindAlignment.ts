import * as THREE from "three";

/** Snapshot of two independent GLB rest rigs, before the anatomical rig
 * is released by Testing. Positions share model/object coordinates (inches).
 * "Native joint" is a source rig BONE ORIGIN, NOT a manually annotated
 * knuckle or a validated anatomical rotation center.
 */
const MM_PER_INCH = 25.4;
const INCH_PER_METER = 39.37007874015748;
const DIGIT_NAMES = ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"] as const;

export interface TestingBindBoneMeta {
  bindPositionM: THREE.Vector3;
  bindRootInWrist: THREE.Vector3;
  bindQuaternion: THREE.Quaternion;
}
export interface TestingBindRigView {
  bonesByName: ReadonlyMap<string, TestingBindBoneMeta>;
  skinnedMesh: Pick<THREE.SkinnedMesh, "geometry">;
  contactSupportVertexIndicesByFinger?: readonly (readonly number[])[];
}
export interface TestingBindJointPair {
  name: string;
  finger: string;
  nativeRestIn: [number, number, number];
  webxrRestIn: [number, number, number];
  nativeWristLocalIn: [number, number, number];
  webxrWristLocalIn: [number, number, number];
  /** Unregistered model-coordinate distance. Includes source wrist offset. */
  rawOffsetMm: number;
  /** Wrist-relative bone-origin displacement. NOT surface/knuckle error. */
  wristLocalOffsetMm: number;
  /** Source versus WebXR bone-axis quaternion deviation, degrees. */
  bindAxisDifferenceDegrees: number;
}
export interface TestingBindSegmentPair {
  name: string;
  startName: string;
  endName: string;
  nativeLengthMm: number;
  webxrLengthMm: number;
  differenceMm: number;
  ratioNativeToWebxr: number;
}
export interface TestingBindPadSample {
  finger: number;
  prefix: string;
  vertexIds: number[];
  /** Centroid of preselected palmar terminal vertices on original GLB. */
  nativePadCentroidIn: [number, number, number];
  webxrTipOriginIn: [number, number, number];
  /** Diagnostic only: tip bone origin is not the palmar contact point. */
  centroidToWebxrTipMm: number;
}
export interface TestingBindAlignmentSnapshot {
  coordinateFrame: "source-glb-object-inches-plus-wrist-local";
  method: "source-rig-origins-not-annotated-surface-knuckles";
  side: "left" | "right";
  joints: TestingBindJointPair[];
  segments: TestingBindSegmentPair[];
  pads: TestingBindPadSample[];
  jointOffsetMeanMm: number;
  jointOffsetP95Mm: number;
  jointOffsetMaxMm: number;
  wristLocalMeanMm: number;
  wristLocalP95Mm: number;
  wristLocalMaxMm: number;
  missingNativeBoneNames: string[];
}
const tuple = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
const rank95 = (values: number[]): number =>
  values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
const max = (values: number[]): number => values.length ? Math.max(...values) : 0;

export function measureTestingBindAlignment(
  side: "left" | "right",
  anatomical: TestingBindRigView,
  webxr: TestingBindRigView,
): TestingBindAlignmentSnapshot {
  const nativeWrist = anatomical.bonesByName.get("wrist");
  const driverWrist = webxr.bonesByName.get("wrist");
  if (!nativeWrist || !driverWrist) throw new Error("Both bind rigs require a wrist.");
  const nativeOrigins = anatomical.bonesByName;
  const driverOrigins = webxr.bonesByName;
  const joints: TestingBindJointPair[] = [];
  const missingNativeBoneNames: string[] = [];
  for (const [name, webxrBone] of driverOrigins) {
    if (name === "wrist") continue;
    const nativeBone = nativeOrigins.get(name);
    if (!nativeBone) {
      missingNativeBoneNames.push(name);
      continue;
    }
    const nativeRest = nativeBone.bindPositionM.clone().multiplyScalar(INCH_PER_METER);
    const webxrRest = webxrBone.bindPositionM.clone().multiplyScalar(INCH_PER_METER);
    const finger = DIGIT_NAMES.find(digit => name.startsWith(digit + "-")) ?? "other";
    const orientationDot = Math.min(1, Math.abs(nativeBone.bindQuaternion.dot(webxrBone.bindQuaternion)));
    joints.push({
      name, finger,
      nativeRestIn: tuple(nativeRest),
      webxrRestIn: tuple(webxrRest),
      nativeWristLocalIn: tuple(nativeBone.bindRootInWrist),
      webxrWristLocalIn: tuple(webxrBone.bindRootInWrist),
      rawOffsetMm: nativeRest.distanceTo(webxrRest) * MM_PER_INCH,
      wristLocalOffsetMm: nativeBone.bindRootInWrist.distanceTo(webxrBone.bindRootInWrist) * MM_PER_INCH,
      bindAxisDifferenceDegrees: 2 * Math.acos(orientationDot) * 180 / Math.PI,
    });
  }

  const segments: TestingBindSegmentPair[] = [];
  const chains: string[][] = [
    ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
    ...DIGIT_NAMES.slice(1).map(prefix => [
      prefix + "-metacarpal",
      prefix + "-phalanx-proximal",
      prefix + "-phalanx-intermediate",
      prefix + "-phalanx-distal",
      prefix + "-tip",
    ]),
  ];
  for (const chain of chains) {
    for (let i = 0; i + 1 < chain.length; i++) {
      const startName = chain[i]!, endName = chain[i + 1]!;
      const na = nativeOrigins.get(startName), nb = nativeOrigins.get(endName);
      const wa = driverOrigins.get(startName), wb = driverOrigins.get(endName);
      if (!na || !nb || !wa || !wb) continue;
      const nativeLengthMm = na.bindPositionM.distanceTo(nb.bindPositionM) * 1000;
      const webxrLengthMm = wa.bindPositionM.distanceTo(wb.bindPositionM) * 1000;
      segments.push({
        name: startName + "→" + endName,
        startName, endName,
        nativeLengthMm, webxrLengthMm,
        differenceMm: nativeLengthMm - webxrLengthMm,
        ratioNativeToWebxr: webxrLengthMm > 1e-8 ? nativeLengthMm / webxrLengthMm : 0,
      });
    }
  }

  const original = anatomical.skinnedMesh.geometry.getAttribute("position");
  if (!original || original.itemSize !== 3) throw new Error("Native pad sampling requires an XYZ position buffer.");
  const pads: TestingBindPadSample[] = [];
  for (let finger = 1; finger <= 5; finger++) {
    const vertexIds = anatomical.contactSupportVertexIndicesByFinger?.[finger] ?? [];
    const prefix = DIGIT_NAMES[finger - 1]!;
    const webxrTip = driverOrigins.get(prefix + "-tip");
    if (!vertexIds.length || !webxrTip) continue;
    const centroid = new THREE.Vector3();
    for (const idx of vertexIds) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= original.count) {
        throw new Error("Invalid native palmar pad vertex index.");
      }
      centroid.add(new THREE.Vector3().fromBufferAttribute(original, idx));
    }
    centroid.divideScalar(vertexIds.length);
    const tip = webxrTip.bindPositionM.clone().multiplyScalar(INCH_PER_METER);
    pads.push({
      finger, prefix, vertexIds: [...vertexIds],
      nativePadCentroidIn: tuple(centroid),
      webxrTipOriginIn: tuple(tip),
      centroidToWebxrTipMm: centroid.distanceTo(tip) * MM_PER_INCH,
    });
  }
  const rawDistances = joints.map(j => j.rawOffsetMm);
  const wristDistances = joints.map(j => j.wristLocalOffsetMm);
  return {
    coordinateFrame: "source-glb-object-inches-plus-wrist-local",
    method: "source-rig-origins-not-annotated-surface-knuckles",
    side, joints, segments, pads,
    jointOffsetMeanMm: mean(rawDistances),
    jointOffsetP95Mm: rank95(rawDistances),
    jointOffsetMaxMm: max(rawDistances),
    wristLocalMeanMm: mean(wristDistances),
    wristLocalP95Mm: rank95(wristDistances),
    wristLocalMaxMm: max(wristDistances),
    missingNativeBoneNames,
  };
}
