import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { transferAnatomicalWeightsToWebxrSkeleton } from "./testingHandSemanticWeights";

function makeGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 0.1, 0, 0,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    0, 1, 0, 0, 1, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    0.75, 0.25, 0, 0, 1, 0, 0, 0,
  ], 4));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0], 2));
  return geometry;
}
function bone(name: string): THREE.Bone {
  const result = new THREE.Bone();
  result.name = name;
  return result;
}

describe("Testing hand anatomical/native bone semantic mapping", () => {
  it("preserves original per-phalange gradients under arbitrary matching bone reordering", () => {
    const native = makeGeometry();
    const mapped = transferAnatomicalWeightsToWebxrSkeleton(
      native,
      [bone("index-finger-phalanx-proximal"), bone("index-finger-phalanx-intermediate")],
      [bone("index-finger-phalanx-intermediate"), bone("index-finger-phalanx-proximal")],
    );
    expect(mapped.getAttribute("position").array).toEqual(native.getAttribute("position").array);
    expect(mapped.getAttribute("uv").array).toEqual(native.getAttribute("uv").array);
    expect(mapped.getAttribute("skinIndex").getX(0)).toBe(1);
    expect(mapped.getAttribute("skinIndex").getY(0)).toBe(0);
    expect(mapped.getAttribute("skinWeight").getX(0)).toBeCloseTo(0.75);
    expect(mapped.getAttribute("skinWeight").getY(0)).toBeCloseTo(0.25);
    expect(mapped.getAttribute("skinIndex").getX(1)).toBe(0);
    expect(mapped.userData.testingSemanticWeightTransfer.namedBones).toBe(2);
    mapped.dispose();
    native.dispose();
  });

  it("rejects missing joints and nonfinite or missing native vertex weights", () => {
    const native = makeGeometry();
    expect(() => transferAnatomicalWeightsToWebxrSkeleton(
      native, [bone("thumb-tip"), bone("thumb-phalanx-distal")], [bone("thumb-tip")],
    )).toThrow("Missing WebXR correspondence");
    native.getAttribute("skinWeight").setX(0, Number.NaN);
    expect(() => transferAnatomicalWeightsToWebxrSkeleton(
      native, [bone("thumb-tip"), bone("thumb-phalanx-distal")],
      [bone("thumb-phalanx-distal"), bone("thumb-tip")],
    )).toThrow("invalid source influence");
    native.dispose();
  });
});
