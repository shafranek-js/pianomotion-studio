import { describe, expect, it } from "vitest";
import { _dedupe_serialized_motion_poses } from "../src/api.ts";

const pose = {
  transportTimeSeconds: 1.25,
  hand: "right",
  wristPose: { positionPx: [10, 20], headingRadians: 0.1 },
};

describe("ENG-14c motion pose collision policy", () => {
  it("drops identical poses that serialize to the same hand/time", () => {
    expect(_dedupe_serialized_motion_poses([pose, { ...pose }])).toHaveLength(1);
  });

  it("rejects distinct poses that collide after timestamp serialization", () => {
    const distinct = { ...pose, wristPose: { positionPx: [11, 20], headingRadians: 0.1 } };
    expect(() => _dedupe_serialized_motion_poses([pose, distinct])).toThrow(
      /distinct motion poses collide/,
    );
  });
});
