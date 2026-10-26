import { describe, expect, it } from "vitest";
import { _motion_pose } from "../src/api.ts";

type Point = [number, number, number];
type RawBone = [Point, Point, string];

function makeRelaxationTriggerPose(): {
  bones: RawBone[];
  joints: Array<[Point, string]>;
} {
  const bones: RawBone[] = Array.from({ length: 28 }, (_, index) => [
    [index, 0, 0],
    [index, 0, 0],
    index < 2 ? "forearm" : index < 9 ? "carpal" : "metacarpal",
  ]);
  const joints: Array<[Point, string]> = [];

  for (let finger = 2; finger <= 5; finger++) {
    const x = 20 + finger * 2;
    const mcp: Point = [x, 20, 0];
    const pip: Point = [x + 0.6, 20, 0];
    const dip: Point = [x + 0.6, 20.6, 0];
    const tip: Point = [x + 1.2, 20.6, 0.4];
    const index = 9 + (finger - 2) * 4;
    bones[index] = [[x - 1, 19, 0], mcp, "metacarpal"];
    bones[index + 1] = [mcp, pip, "proximal"];
    bones[index + 2] = [pip, dip, "middle"];
    bones[index + 3] = [dip, tip, "distal"];
    joints.push([tip, "tip"], [pip, "knuckle"], [dip, "knuckle"]);
  }

  const thumbTip: Point = [18, 20, 0.4];
  bones[25] = [[17, 19, 0], [17.5, 20, 0], "metacarpal"];
  bones[26] = [[17.5, 20, 0], [18, 20, 0], "proximal"];
  bones[27] = [[18, 20, 0], thumbTip, "distal"];
  joints.push([thumbTip, "tip"]);
  joints.push([[20, 18, 0], "wrist"], [[22, 18, 0], "wrist"]);

  return { bones, joints };
}

describe("MotionPose serialization", () => {
  it("preserves engine finger bones and joints when an idle pose has a raised arched tip", () => {
    const pose = makeRelaxationTriggerPose();
    const before = structuredClone(pose);
    const result = _motion_pose(pose, "right", 1.25, 0, 1);

    expect(result.bones).toEqual(pose.bones.map(([a, b, kind]) => ({ a, b, kind })));
    expect(result.joints).toEqual(pose.joints.map(([point, kind]) => ({ point, kind })));
    expect(pose).toEqual(before);
  });
});
