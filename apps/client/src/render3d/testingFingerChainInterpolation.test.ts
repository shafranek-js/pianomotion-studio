import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { interpolateTestingFingerChainFixedLength } from "./testingFingerChainInterpolation";

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const coordinates = (points: readonly THREE.Vector3[]) => points.map((point) => point.toArray());
const segmentLengths = (points: readonly THREE.Vector3[]) =>
  points.slice(1).map((point, index) => point.distanceTo(points[index]!));

function mirrored(points: readonly THREE.Vector3[], side: 1 | -1): THREE.Vector3[] {
  return points.map((point) => vector(point.x * side, point.y, point.z));
}

function expectLengthsClose(points: readonly THREE.Vector3[], expected: readonly number[]): void {
  const lengths = segmentLengths(points);
  expect(lengths).toHaveLength(expected.length);
  lengths.forEach((length, index) => expect(length).toBeCloseTo(expected[index]!, 10));
}

describe("fixed-length Testing IK finger-chain interpolation", () => {
  it.each([1, -1] as const)("interpolates three-point chains with fixed MCP and lengths on side %i", (side) => {
    const source = mirrored([
      vector(0, 0, 0),
      vector(2, 0, 0),
      vector(2, 1, 0),
    ], side);
    const solution = mirrored([
      vector(0, 0, 0),
      vector(0, 2, 0),
      vector(-1, 2, 0),
    ], side);
    const sourceBefore = coordinates(source);
    const solutionBefore = coordinates(solution);

    const start = interpolateTestingFingerChainFixedLength(source, solution, 0);
    const end = interpolateTestingFingerChainFixedLength(source, solution, 1);
    const middle = interpolateTestingFingerChainFixedLength(source, solution, 0.5);

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    expect(middle.ok).toBe(true);
    if (!start.ok || !end.ok || !middle.ok) return;

    expect(coordinates(start.points)).toEqual(sourceBefore);
    expect(coordinates(end.points)).toEqual(solutionBefore);
    expect(middle.points[0]!.toArray()).toEqual(source[0]!.toArray());
    expectLengthsClose(middle.points, [2, 1]);
    expect(coordinates(source)).toEqual(sourceBefore);
    expect(coordinates(solution)).toEqual(solutionBefore);
  });

  it.each([1, -1] as const)("interpolates four-point chains with fixed MCP and each source length on side %i", (side) => {
    const source = mirrored([
      vector(0, 0, 0),
      vector(1, 0, 0),
      vector(1, 2, 0),
      vector(1, 2, 0.5),
    ], side);
    const solution = mirrored([
      vector(0, 0, 0),
      vector(0, 1, 0),
      vector(0, 1, 2),
      vector(0.5, 1, 2),
    ], side);

    const start = interpolateTestingFingerChainFixedLength(source, solution, 0);
    const end = interpolateTestingFingerChainFixedLength(source, solution, 1);
    const middle = interpolateTestingFingerChainFixedLength(source, solution, 0.5);

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    expect(middle.ok).toBe(true);
    if (!start.ok || !end.ok || !middle.ok) return;

    expect(coordinates(start.points)).toEqual(coordinates(source));
    expect(coordinates(end.points)).toEqual(coordinates(solution));
    expect(middle.points[0]!.toArray()).toEqual(source[0]!.toArray());
    expectLengthsClose(middle.points, [1, 2, 0.5]);
  });

  it("keeps source lengths when the IK solution has different segment lengths", () => {
    const source = [vector(0, 0, 0), vector(2, 0, 0), vector(2, 1, 0)];
    const solution = [vector(9, 8, 7), vector(9, 12, 7), vector(6, 12, 7)];

    const result = interpolateTestingFingerChainFixedLength(source, solution, 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectLengthsClose(result.points, [2, 1]);
    expect(result.points[0]!.toArray()).toEqual(source[0]!.toArray());
    expect(result.points[1]!.toArray()).not.toEqual(solution[1]!.toArray());
  });

  it("rejects an antiparallel segment explicitly, including at an endpoint", () => {
    const source = [vector(0, 0, 0), vector(1, 0, 0), vector(1, 1, 0)];
    const opposite = [vector(0, 0, 0), vector(-1, 0, 0), vector(-1, 1, 0)];

    expect(interpolateTestingFingerChainFixedLength(source, opposite, 0.5)).toEqual({
      ok: false,
      reason: "antiparallel-direction",
    });
    expect(interpolateTestingFingerChainFixedLength(source, opposite, 1)).toEqual({
      ok: false,
      reason: "antiparallel-direction",
    });
  });

  it("returns no candidate for degenerate or non-finite chains", () => {
    const valid = [vector(0, 0, 0), vector(1, 0, 0), vector(1, 1, 0)];
    const degenerate = [vector(0, 0, 0), vector(1, 0, 0), vector(1, 0, 0)];
    const nonFinite = [vector(0, 0, 0), vector(Number.NaN, 0, 0), vector(1, 1, 0)];

    expect(interpolateTestingFingerChainFixedLength(degenerate, valid, 0.5)).toEqual({
      ok: false,
      reason: "degenerate-segment",
    });
    expect(interpolateTestingFingerChainFixedLength(valid, degenerate, 0.5)).toEqual({
      ok: false,
      reason: "degenerate-segment",
    });
    expect(interpolateTestingFingerChainFixedLength(nonFinite, valid, 0.5)).toEqual({
      ok: false,
      reason: "non-finite",
    });
    expect(interpolateTestingFingerChainFixedLength(valid, nonFinite, 0.5)).toEqual({
      ok: false,
      reason: "non-finite",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01])(
    "does not produce a candidate for invalid fraction %s",
    (fraction) => {
      const source = [vector(0, 0, 0), vector(1, 0, 0), vector(1, 1, 0)];
      const solution = [vector(0, 0, 0), vector(0, 1, 0), vector(-1, 1, 0)];
      expect(interpolateTestingFingerChainFixedLength(source, solution, fraction)).toEqual({
        ok: false,
        reason: "invalid-fraction",
      });
    },
  );

  it("rejects point-count mismatches and chains shorter than a finger chain", () => {
    expect(interpolateTestingFingerChainFixedLength([vector(0, 0, 0), vector(1, 0, 0)], [
      vector(0, 0, 0), vector(0, 1, 0),
    ], 0.5)).toEqual({ ok: false, reason: "point-count" });
    expect(interpolateTestingFingerChainFixedLength([
      vector(0, 0, 0), vector(1, 0, 0), vector(1, 1, 0),
    ], [vector(0, 0, 0), vector(0, 1, 0)], 0.5)).toEqual({ ok: false, reason: "point-count" });
  });
});
