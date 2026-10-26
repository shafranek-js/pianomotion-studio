import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { attachTestingHandMorphTargets } from "./testingHandMorphTargets";

function mesh(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
  ], 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  geo.setIndex([0, 1, 2]);
  return geo;
}

describe("Testing hand Blender morph import contract", () => {
  it("imports glTF relative deltas in metres as inches without moving neutral realistic mesh", () => {
    const geometry = mesh();
    const original = Array.from(geometry.getAttribute("position").array);
    const delta = new Float32Array([0.001, 0, 0, 0, 0.002, 0, 0, 0, 0.003]);
    attachTestingHandMorphTargets(geometry, [{
      name: "pmcorr_index_mcp_030",
      positionDeltaMeters: delta,
      normalDelta: new Float32Array([0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1]),
    }]);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(original);
    expect(geometry.getAttribute("uv").getX(1)).toBe(1);
    expect(geometry.morphTargetsRelative).toBe(true);
    expect(geometry.morphAttributes.position).toHaveLength(1);
    expect(geometry.morphAttributes.position![0]!.name).toBe("pmcorr_index_mcp_030");
    expect(geometry.morphAttributes.position![0]!.getX(0)).toBeCloseTo(0.03937007874, 5);
    expect(geometry.morphAttributes.position![0]!.getY(1)).toBeCloseTo(0.07874015748, 5);
    const instance = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    instance.updateMorphTargets();
    expect(instance.morphTargetDictionary?.pmcorr_index_mcp_030).toBe(0);
    expect(instance.morphTargetInfluences).toEqual([0]);
    geometry.dispose();
  });

  it("rejects wrong morph names, duplicates, unsculpted deltas, and nonfinite exports", () => {
    const g = mesh();
    const empty = new Float32Array(9);
    const good = { name: "pmcorr_thumb_cmc_060", positionDeltaMeters:
      new Float32Array([0.001, 0, 0, 0, 0, 0, 0, 0, 0]) };
    expect(() => attachTestingHandMorphTargets(g, [
      { name: "unknown_lip_030", positionDeltaMeters: empty },
    ])).toThrow("Invalid or duplicate");
    expect(() => attachTestingHandMorphTargets(g, [
      { name: "pmcorr_thumb_cmc_060", positionDeltaMeters: empty },
    ])).toThrow("empty/unsculpted");
    expect(() => attachTestingHandMorphTargets(g, [good, good])).toThrow("duplicate");
    expect(() => attachTestingHandMorphTargets(g, [{
      name: "pmcorr_index_mcp_090",
      positionDeltaMeters: new Float32Array([0, 0, 0, 0, 0, Infinity, 0, 0, 0]),
    }])).toThrow("non-finite");
    // No morphs is valid for the existing published anatomical GLBs.
    expect(() => attachTestingHandMorphTargets(g, [])).not.toThrow();
    g.dispose();
  });
});
