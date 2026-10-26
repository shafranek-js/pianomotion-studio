import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { transferWebxrSkinToAnatomicalSurface } from "./testingHandSkin";

function surface(points: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(
    Array.from({ length: points.length }, (_, index) => index % 3 === 1 ? 1 : 0), 3,
  ));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(
    Array.from({ length: points.length / 3 }, (_, index) => [index / 8, 0]).flat(), 2,
  ));
  return geometry;
}

describe("Testing hand: WebXR bone field on anatomical appearance", () => {
  it("preserves the realistic surface and maps to normalized WebXR skin weights", () => {
    const reference = surface([
      0, 0, 0,
      0.18, 0, 0,
      1, 0, 0,
      1.18, 0, 0,
    ]);
    reference.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4));
    reference.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4));

    const anatomical = surface([
      0.04, 0.05, 0.02,
      0.12, 0.08, 0.01,
      1.04, 0.05, 0.02,
      1.12, 0.08, 0.01,
    ]);
    const result = transferWebxrSkinToAnatomicalSurface(anatomical, reference, 2);
    expect(result).not.toBe(anatomical);
    expect(result.getAttribute("uv").array).toEqual(anatomical.getAttribute("uv").array);
    expect(result.getAttribute("position").array).toEqual(anatomical.getAttribute("position").array);
    expect(result.getAttribute("skinIndex").array).toBeInstanceOf(Uint16Array);
    const weights = result.getAttribute("skinWeight");
    const indices = result.getAttribute("skinIndex");
    for (let vertex = 0; vertex < weights.count; vertex++) {
      let sum = 0;
      for (let slot = 0; slot < 4; slot++) {
        sum += weights.getComponent(vertex, slot);
        expect(indices.getComponent(vertex, slot)).toBeGreaterThanOrEqual(0);
        expect(indices.getComponent(vertex, slot)).toBeLessThan(2);
      }
      expect(sum).toBeCloseTo(1, 5);
    }
    expect(indices.getX(0)).toBe(0);
    expect(indices.getX(3)).toBe(1);
    expect(result.userData.testingWebxrSkinTransfer).toBe(true);
    result.dispose();
    anatomical.dispose();
    reference.dispose();
  });

  it("keeps a labelled index fingertip from taking the adjacent middle-finger bones", () => {
    const source = surface([
      0, 0, 0,
      0.1, 0, 0,
    ]);
    source.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
      0, 0, 0, 0,
      1, 0, 0, 0,
    ], 4));
    source.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4));
    const target = surface([0.06, 0, 0]);
    target.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    target.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));

    const baseline = transferWebxrSkinToAnatomicalSurface(target, source, 2);
    const constrained = transferWebxrSkinToAnatomicalSurface(target, source, 2, {
      anatomicalBoneNames: ["index-finger-phalanx-distal", "middle-finger-phalanx-distal"],
      webxrBoneNames: ["index-finger-phalanx-distal", "middle-finger-phalanx-distal"],
    });
    expect(baseline.getAttribute("skinIndex").getX(0)).toBe(1);
    expect(constrained.getAttribute("skinIndex").getX(0)).toBe(0);
    expect(constrained.userData.testingFingerAware).toBe(true);
    baseline.dispose();
    constrained.dispose();
    target.dispose();
    source.dispose();
  });

  it("fades adjacent-finger influence continuously across the native webbing threshold", () => {
    const reference = surface([0, 0, 0, 0.1, 0, 0]);
    reference.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4));
    reference.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4));
    const anatomy = surface([0.06, 0, 0, 0.06, 0, 0]);
    anatomy.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0], 4));
    anatomy.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
      0.81, 0.19, 0, 0, 0.82, 0.18, 0, 0,
    ], 4));
    const result = transferWebxrSkinToAnatomicalSurface(anatomy, reference, 2, {
      anatomicalBoneNames: ["index-finger-phalanx-distal", "middle-finger-phalanx-distal"],
      webxrBoneNames: ["index-finger-phalanx-distal", "middle-finger-phalanx-distal"],
    });
    const foreign = (vertex: number) => {
      let sum = 0;
      const indices = result.getAttribute("skinIndex");
      const weights = result.getAttribute("skinWeight");
      for (let slot = 0; slot < 4; slot++) {
        if (indices.getComponent(vertex, slot) === 1) sum += weights.getComponent(vertex, slot);
      }
      return sum;
    };
    expect(foreign(0)).toBeGreaterThanOrEqual(foreign(1));
    expect(foreign(0)).toBeLessThan(0.12);
    expect(foreign(1)).toBeLessThan(1e-6);
    result.dispose();
    anatomy.dispose();
    reference.dispose();
  });

  it("rejects missing skinning and non-finite anatomy rather than silently corrupting it", () => {
    const source = surface([0, 0, 0]);
    const target = surface([0, 0, 0]);
    expect(() => transferWebxrSkinToAnatomicalSurface(target, source, 2)).toThrow("complete WebXR");
    source.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    source.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    const bad = surface([Number.NaN, 0, 0]);
    expect(() => transferWebxrSkinToAnatomicalSurface(bad, source, 2)).toThrow("non-finite");
    bad.dispose();
    target.dispose();
    source.dispose();
  });
});
