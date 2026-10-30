import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { measureTestingThumbControlledTipReach } from "./testingThumbReach";

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("Testing thumb controlled-tip reach measure", () => {
  it("reports the original segment lengths and zero deficit exactly at maximum reach", () => {
    const result = measureTestingThumbControlledTipReach(
      vector(0, 0, 0),
      vector(3, 0, 0),
      vector(3, 4, 0),
      vector(7, 0, 0),
    );

    expect(result).toEqual({
      mcpToIpLength: 3,
      ipToTipLength: 4,
      totalReach: 7,
      distance: 7,
      signedReachDeficit: 0,
      reachDeficit: 0,
      invalid: null,
    });
  });

  it("keeps signed slack below reach and reports only positive excess beyond reach", () => {
    const mcp = vector(0, 0, 0);
    const ip = vector(3, 0, 0);
    const controlledTip = vector(3, 4, 0);

    const insideReach = measureTestingThumbControlledTipReach(mcp, ip, controlledTip, vector(5, 0, 0));
    const outsideReach = measureTestingThumbControlledTipReach(mcp, ip, controlledTip, vector(7.75, 0, 0));

    expect(insideReach.signedReachDeficit).toBe(-2);
    expect(insideReach.reachDeficit).toBe(0);
    expect(outsideReach.signedReachDeficit).toBe(0.75);
    expect(outsideReach.reachDeficit).toBe(0.75);
  });

  it("uses the controlled bone tip endpoint and excludes a skinned pad offset", () => {
    const mcp = vector(0, 0, 0);
    const ip = vector(1, 0, 0);
    const controlledTip = vector(1, 2, 0);
    // A deformed pad could sit elsewhere; it is intentionally not an input to
    // this bone-chain reach measure.
    const skinnedPad = vector(1, 3, 0);

    const result = measureTestingThumbControlledTipReach(mcp, ip, controlledTip, vector(3, 0, 0));

    expect(skinnedPad.distanceTo(controlledTip)).toBe(1);
    expect(result.ipToTipLength).toBe(2);
    expect(result.totalReach).toBe(3);
    expect(result.invalid).toBeNull();
  });

  it("is invariant under mirroring across the hand-side axis", () => {
    const original = [vector(1, 2, 3), vector(2, 4, 3), vector(4, 5, 3), vector(6, 7, 3)];
    const mirrored = original.map((point) => vector(-point.x, point.y, point.z));
    const measure = (points: readonly THREE.Vector3[]) =>
      measureTestingThumbControlledTipReach(points[0]!, points[1]!, points[2]!, points[3]!);

    expect(measure(mirrored)).toEqual(measure(original));
  });

  it("marks either zero-length source segment invalid while retaining finite diagnostics", () => {
    const degenerateMcpToIp = measureTestingThumbControlledTipReach(
      vector(0, 0, 0), vector(0, 0, 0), vector(0, 2, 0), vector(0, 3, 0),
    );
    const degenerateIpToTip = measureTestingThumbControlledTipReach(
      vector(0, 0, 0), vector(0, 2, 0), vector(0, 2, 0), vector(0, 3, 0),
    );

    expect(degenerateMcpToIp).toMatchObject({ mcpToIpLength: 0, ipToTipLength: 2, invalid: "degenerate-segment" });
    expect(degenerateIpToTip).toMatchObject({ mcpToIpLength: 2, ipToTipLength: 0, invalid: "degenerate-segment" });
  });

  it("marks non-finite input or overflowed measurements invalid without returning NaN values", () => {
    const nonFiniteInput = measureTestingThumbControlledTipReach(
      vector(0, 0, 0), vector(1, 0, 0), vector(1, 1, 0), vector(Number.POSITIVE_INFINITY, 0, 0),
    );
    const overflowedMeasurement = measureTestingThumbControlledTipReach(
      vector(Number.MAX_VALUE, 0, 0), vector(-Number.MAX_VALUE, 0, 0), vector(-Number.MAX_VALUE, 1, 0),
      vector(Number.MAX_VALUE, 1, 0),
    );

    expect(nonFiniteInput).toEqual({
      mcpToIpLength: null,
      ipToTipLength: null,
      totalReach: null,
      distance: null,
      signedReachDeficit: null,
      reachDeficit: null,
      invalid: "non-finite",
    });
    expect(overflowedMeasurement.invalid).toBe("non-finite");
    expect(Object.values(overflowedMeasurement).filter((value) => typeof value === "number")).toEqual([]);
  });

  it("does not mutate any input point", () => {
    const points = [vector(2, -1, 3), vector(3, 1, 3), vector(5, 2, 4), vector(8, 2, 4)];
    const snapshots = points.map((point) => point.toArray());

    measureTestingThumbControlledTipReach(points[0]!, points[1]!, points[2]!, points[3]!);

    expect(points.map((point) => point.toArray())).toEqual(snapshots);
  });
});
