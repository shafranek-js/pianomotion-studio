import { describe, expect, it } from "vitest";
import { collectRiggedPoseEditTimepoints, findRiggedPoseEditTimepointIndex } from "./riggedPoseEditNavigation";

describe("rigged pose edit navigation", () => {
  it("sorts and deduplicates only times that exist in the MotionPlan or live buffer", () => {
    const result = collectRiggedPoseEditTimepoints([1, 0, 2.0000004], [1.0000002, 3, 1.0000002, Number.NaN]);

    expect(result.map(point => point.displayedTransportTimeSeconds)).toEqual([0, 1, 1.0000002, 2.0000004, 3]);
    expect(result.every(point => point.kind === "sampled" && point.sourcePoseTimeSeconds === point.displayedTransportTimeSeconds)).toBe(true);
  });

  it("keeps the displayed lead-in time separate from the held first pose source time", () => {
    const result = collectRiggedPoseEditTimepoints([0, 0.5], [0.25], {
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: 0,
    });

    expect(result[0]).toEqual({
      id: "lead-in:-2.00000000000000:0.00000000000000",
      kind: "lead-in-held",
      displayedTransportTimeSeconds: -2,
      sourcePoseTimeSeconds: 0,
    });
    expect(result.map(point => point.displayedTransportTimeSeconds)).toEqual([-2, 0, 0.25, 0.5]);
    expect(findRiggedPoseEditTimepointIndex(result, -2)).toBe(0);
  });

  it("does not create a lead-in entry without verified source timing", () => {
    expect(collectRiggedPoseEditTimepoints([0], [], null).map(point => point.kind)).toEqual(["sampled"]);
  });
});
