import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  mapAnatomicalSurfaceToWebxrBindFrames,
  transferTestingWeightsInBoneFrames,
} from "./testingHandBoneFrameTransfer";

function makeBone(name: string, x: number): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.set(x, 0, 0);
  bone.updateMatrixWorld(true);
  return bone;
}

function sourceMesh(pointX: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    pointX, 0, 0, pointX + 0.12, 0, 0, pointX, 0.12, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
  ], 4));
  return geometry;
}

describe("Testing hand bone-frame anatomical registration", () => {
  it("compensates native/rest-joint offset and preserves final realistic surface", () => {
    const native = makeBone("index-finger-phalanx-proximal", 1);
    const webxr = makeBone("index-finger-phalanx-proximal", 2);
    const anatomical = sourceMesh(1);
    const driver = sourceMesh(2);
    const registered = mapAnatomicalSurfaceToWebxrBindFrames(anatomical, [native], [webxr]);
    const shifted = registered.geometry.getAttribute("position");
    expect(shifted.getX(0)).toBeCloseTo(2, 6);
    expect(shifted.getX(1)).toBeCloseTo(2.12, 6);
    expect(registered.stats.transformedVertexCount).toBe(3);
    expect(registered.stats.meanDisplacementInches).toBeCloseTo(1, 6);

    const transferred = transferTestingWeightsInBoneFrames(
      anatomical, driver, [native], [webxr], {
        anatomicalBoneNames: [native.name], webxrBoneNames: [webxr.name],
      },
    );
    expect(transferred.getAttribute("position").array)
      .toEqual(anatomical.getAttribute("position").array);
    expect(transferred.getAttribute("uv").array).toEqual(anatomical.getAttribute("uv").array);
    expect(transferred.getIndex()!.array).toEqual(anatomical.getIndex()!.array);
    expect(transferred.getAttribute("skinWeight").getX(0)).toBeCloseTo(1);
    expect(transferred.userData.testingBoneFrameTransfer).toBe(true);
    transferred.dispose();
    registered.geometry.dispose();
    anatomical.dispose();
    driver.dispose();
  });

  it("rejects unmapped bone names rather than stealing another finger's weights", () => {
    const anatomical = sourceMesh(1);
    expect(() => mapAnatomicalSurfaceToWebxrBindFrames(
      anatomical,
      [makeBone("thumb-phalanx-distal", 1)],
      [makeBone("index-finger-phalanx-distal", 2)],
    )).toThrow("No matching WebXR bone");
    anatomical.dispose();
  });
  it("calibrates thumb query coordinates against segment length WITHOUT changing the realistic mesh", () => {
    const names = [
      "thumb-metacarpal", "thumb-phalanx-proximal",
      "thumb-phalanx-distal", "thumb-tip",
    ];
    const native = [0, -1, -3, -4].map((z, index) => {
      const bone = new THREE.Bone();
      bone.name = names[index]!;
      bone.position.set(0, 0, z);
      bone.updateMatrixWorld(true);
      return bone;
    });
    const driver = [0, -0.6, -2.96, -4.29].map((z, index) => {
      const bone = new THREE.Bone();
      bone.name = names[index]!;
      bone.position.set(0, 0, z);
      bone.updateMatrixWorld(true);
      return bone;
    });
    const anatomy = sourceMesh(0);
    anatomy.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, -0.5, 0.1, 0, -2, 0, 0, -3.5,
    ], 3));
    anatomy.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
      0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0,
    ], 4));

    const baseline = mapAnatomicalSurfaceToWebxrBindFrames(anatomy, native, driver);
    const calibrated = mapAnatomicalSurfaceToWebxrBindFrames(
      anatomy, native, driver, { thumbAxialScale: true },
    );
    const half = mapAnatomicalSurfaceToWebxrBindFrames(
      anatomy, native, driver, { thumbAxialStrength: 0.5 },
    );
    expect(half.geometry.getAttribute("position").getZ(0)).toBeCloseTo(-0.4, 6);
    expect(half.stats.thumbAxialStrength).toBe(0.5);
    expect(half.stats.thumbAxialRatios?.["thumb-metacarpal"]).toBeCloseTo(0.8, 6);
    const c = calibrated.geometry.getAttribute("position");
    expect(c.getZ(0)).toBeCloseTo(-0.3, 6);
    expect(c.getZ(1)).toBeCloseTo(-1.78, 6);
    expect(c.getZ(2)).toBeCloseTo(-3.625, 6);
    expect(baseline.geometry.getAttribute("position").getZ(0)).toBeCloseTo(-0.5, 6);
    expect(anatomy.getAttribute("position").getZ(0)).toBeCloseTo(-0.5, 6);
    expect(calibrated.stats.thumbAxialRatios?.["thumb-metacarpal"]).toBeCloseTo(0.6, 6);
    expect(calibrated.stats.thumbAxialRatios?.["thumb-phalanx-proximal"]).toBeCloseTo(1.18, 6);
    expect(calibrated.stats.thumbAxialRatios?.["thumb-phalanx-distal"]).toBeCloseTo(1.33, 6);
    baseline.geometry.dispose();
    half.geometry.dispose();
    calibrated.geometry.dispose();
    anatomy.dispose();
  });

  it("refuses degenerate anatomical thumb reference segments", () => {
    const anatomical = sourceMesh(0);
    const first = makeBone("thumb-metacarpal", 0);
    const second = makeBone("thumb-phalanx-proximal", 0);
    const webxrRoot = makeBone("thumb-metacarpal", 0);
    const webxrNext = makeBone("thumb-phalanx-proximal", 1);
    expect(() => mapAnatomicalSurfaceToWebxrBindFrames(
      anatomical, [first, second], [webxrRoot, webxrNext], { thumbAxialScale: true },
    )).toThrow("Invalid thumb bind-segment length");
    expect(() => mapAnatomicalSurfaceToWebxrBindFrames(
      anatomical, [first, second], [webxrRoot, webxrNext], { thumbAxialStrength: 1.1 },
    )).toThrow("strength must be between 0 and 1");
    expect(() => mapAnatomicalSurfaceToWebxrBindFrames(
      anatomical, [first, second], [webxrRoot, webxrNext], { thumbAxialStrength: Number.NaN },
    )).toThrow("strength must be between 0 and 1");
    anatomical.dispose();
  });

});
