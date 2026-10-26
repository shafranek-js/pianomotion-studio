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
});
