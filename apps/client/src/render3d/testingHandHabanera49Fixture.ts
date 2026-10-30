import type { MotionPose } from "@handthesia/contracts";

type JointKind = MotionPose["joints"][number]["kind"];
type BoneKind = MotionPose["bones"][number]["kind"];
type JointTuple = readonly [JointKind, number, number, number];
type BoneTuple = readonly [BoneKind, number, number, number, number, number, number];

function point(x: number, y: number, z: number): [number, number, number] {
  return [x, y, z];
}

// Captured at transport time 49s from scratch/testing-hand-49-final-stages.json
// and scratch/testing-hand-swing-0.json. The snapshots are rounded to 0.001.
// Their sourceMotionPose is identical; the first run retained a -0.072in pad
// gap, while the rigid-swing run reached +0.011in on this right ring finger.
const joints: readonly JointTuple[] = [
  ["knuckle", 23.757, -1.106, 1.373],
  ["knuckle", 23.706, 0.517, 1.824],
  ["knuckle", 23.681, 1.293, 1.245],
  ["tip", 23.672, 1.576, 0.542],
  ["knuckle", 24.592, -1.036, 1.448],
  ["knuckle", 24.597, 0.813, 1.867],
  ["knuckle", 24.599, 1.64, 1.086],
  ["tip", 24.6, 1.82, 0.307],
  ["knuckle", 25.375, -1.231, 1.373],
  ["knuckle", 25.458, 0.482, 0.939],
  ["knuckle", 25.5, 1.331, 0.248],
  ["tip", 25.522, 1.8, -0.4],
  ["knuckle", 26.09, -1.577, 1.221],
  ["knuckle", 26.295, -0.347, 1.834],
  ["knuckle", 26.402, 0.3, 1.453],
  ["tip", 26.454, 0.609, 0.809],
  ["knuckle", 24.007, -3.946, 0.8],
  ["knuckle", 23.118, -2.177, 0.82],
  ["knuckle", 22.789, -0.84, 0.634],
  ["tip", 22.739, 0.301, 0.338],
  ["wrist", 23.995, -4.485, 1.036],
  ["wrist", 25.7, -4.492, 1.036],
];

const bones: readonly BoneTuple[] = [
  ["forearm", 23.995, -4.485, 1.036, 25.146, -16.43, 1.204],
  ["forearm", 25.7, -4.492, 1.036, 26.851, -16.437, 1.204],
  ["carpal", 23.995, -4.485, 1.036, 24.007, -3.946, 0.8],
  ["carpal", 24.007, -3.946, 0.8, 24.378, -3.847, 1.204],
  ["carpal", 24.378, -3.847, 1.204, 24.749, -3.814, 1.238],
  ["carpal", 24.749, -3.814, 1.238, 25.153, -3.883, 1.204],
  ["carpal", 25.153, -3.883, 1.204, 25.49, -4.02, 1.137],
  ["carpal", 25.49, -4.02, 1.137, 25.7, -4.492, 1.036],
  ["carpal", 23.995, -4.485, 1.036, 25.7, -4.492, 1.036],
  ["metacarpal", 24.378, -3.847, 1.204, 23.757, -1.106, 1.373],
  ["proximal", 23.757, -1.106, 1.373, 23.706, 0.517, 1.824],
  ["middle", 23.706, 0.517, 1.824, 23.681, 1.293, 1.245],
  ["distal", 23.681, 1.293, 1.245, 23.672, 1.576, 0.542],
  ["metacarpal", 24.749, -3.814, 1.238, 24.592, -1.036, 1.448],
  ["proximal", 24.592, -1.036, 1.448, 24.597, 0.813, 1.867],
  ["middle", 24.597, 0.813, 1.867, 24.599, 1.64, 1.086],
  ["distal", 24.599, 1.64, 1.086, 24.6, 1.82, 0.307],
  ["metacarpal", 25.153, -3.883, 1.204, 25.375, -1.231, 1.373],
  ["proximal", 25.375, -1.231, 1.373, 25.458, 0.482, 0.939],
  ["middle", 25.458, 0.482, 0.939, 25.5, 1.331, 0.248],
  ["distal", 25.5, 1.331, 0.248, 25.522, 1.8, -0.4],
  ["metacarpal", 25.49, -4.02, 1.137, 26.09, -1.577, 1.221],
  ["proximal", 26.09, -1.577, 1.221, 26.295, -0.347, 1.834],
  ["middle", 26.295, -0.347, 1.834, 26.402, 0.3, 1.453],
  ["distal", 26.402, 0.3, 1.453, 26.454, 0.609, 0.809],
  ["metacarpal", 24.007, -3.946, 0.8, 23.118, -2.177, 0.82],
  ["proximal", 23.118, -2.177, 0.82, 22.789, -0.84, 0.634],
  ["distal", 22.789, -0.84, 0.634, 22.739, 0.301, 0.338],
];

export const HABANERA_49_RIGHT_SOURCE_POSE: MotionPose = {
  hand: "right",
  transportTimeSeconds: 49,
  layerOrder: 0,
  joints: joints.map(([kind, x, y, z]) => ({ kind, point: point(x, y, z) })),
  bones: bones.map(([kind, ax, ay, az, bx, by, bz]) => ({
    kind,
    a: point(ax, ay, az),
    b: point(bx, by, bz),
  })),
};

export const HABANERA_49_RING_CONTACT = {
  finger: 4,
  pitch: 67,
  sourceStartSeconds: 48.6,
  keyCenterX: 1.393,
  keyMinX: 0.947,
  keyMaxX: 1.839,
  keyMinZ: -5.262,
  keyMaxZ: -0.008,
  previousCorrectedGapInches: -0.072,
  rigidSwingMinimumGapInches: 0.011,
} as const;
