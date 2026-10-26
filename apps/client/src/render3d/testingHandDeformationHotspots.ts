import * as THREE from "three";

/**
 * Locate the worst *actual skinned* triangles by anatomical bone rather than
 * looking only at aggregate deformation statistics. This is an offline QA
 * report for deciding which PIP/DIP/MCP/thumb-carpal areas need corrective
 * shapes. It does not modify poses, morph targets or skinning weights.
 */
export interface TestingHandTriangleHotspot {
  triangle: number;
  dominantBone: string;
  baseArea: number;
  skinnedArea: number;
  areaRatio: number;
  deformationSeverity: number;
  centroidInches: readonly [number, number, number];
  vertexIndices: readonly [number, number, number];
}

export interface TestingHandBoneDistortion {
  bone: string;
  triangles: number;
  flattenedBelowQuarterArea: number;
  stretchedAboveDoubleArea: number;
  worstSeverity: number;
}

export interface TestingHandHotspotReport {
  hand: "left" | "right";
  trianglesInspected: number;
  hotspots: TestingHandTriangleHotspot[];
  bones: TestingHandBoneDistortion[];
}

export function locateTestingHandDeformationHotspots(
  skinnedMesh: THREE.SkinnedMesh,
  hand: "left" | "right",
  topN = 20,
): TestingHandHotspotReport {
  const geometry = skinnedMesh.geometry;
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const weights = geometry.getAttribute("skinWeight");
  const skinIndices = geometry.getAttribute("skinIndex");
  if (!position || !index || !weights || !skinIndices ||
      position.itemSize !== 3 || skinIndices.itemSize !== 4 ||
      weights.itemSize !== 4 || weights.count !== position.count ||
      skinIndices.count !== position.count ||
      !Number.isInteger(topN) || topN < 1 || topN > 100) {
    throw new Error("Testing hotspot analysis requires indexed, four-weight skinned mesh.");
  }
  skinnedMesh.updateMatrixWorld(true);
  skinnedMesh.skeleton.update();

  const raw: THREE.Vector3[] = [];
  const posed: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i);
    const q = skinnedMesh.applyBoneTransform(i, p.clone());
    if (![p.x, p.y, p.z, q.x, q.y, q.z].every(Number.isFinite)) {
      throw new Error("Testing hotspot analysis found non-finite skinned geometry.");
    }
    raw.push(p);
    posed.push(q);
  }

  const triangleArea = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
  const worst: TestingHandTriangleHotspot[] = [];
  const aggregated = new Map<string, TestingHandBoneDistortion>();
  let inspected = 0;

  for (let triangle = 0; triangle * 3 + 2 < index.count; triangle++) {
    const indices = [index.getX(triangle * 3), index.getX(triangle * 3 + 1),
      index.getX(triangle * 3 + 2)] as const;
    if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= position.count)) {
      throw new Error("Testing hotspot analysis found invalid triangle index.");
    }
    const baseArea = triangleArea(raw[indices[0]]!, raw[indices[1]]!, raw[indices[2]]!);
    if (baseArea <= 1e-7) continue;
    const skinnedArea = triangleArea(posed[indices[0]]!, posed[indices[1]]!, posed[indices[2]]!);
    const ratio = skinnedArea / baseArea;
    const severity = Math.max(ratio, 1 / Math.max(ratio, 1e-12));
    if (!Number.isFinite(severity)) throw new Error("Testing hotspot contains invalid area ratio.");

    const boneScores = new Map<number, number>();
    for (const vertex of indices) {
      for (let slot = 0; slot < 4; slot++) {
        const bone = Math.round(skinIndices.getComponent(vertex, slot));
        const weight = weights.getComponent(vertex, slot);
        if (bone < 0 || bone >= skinnedMesh.skeleton.bones.length ||
            !Number.isFinite(weight) || weight < 0) {
          throw new Error("Testing hotspot contains invalid bone influence.");
        }
        boneScores.set(bone, (boneScores.get(bone) ?? 0) + weight);
      }
    }
    const dominant = [...boneScores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (dominant === undefined) continue;
    const boneName = skinnedMesh.skeleton.bones[dominant]!.name || `bone-${dominant}`;

    const row = aggregated.get(boneName) ?? {
      bone: boneName,
      triangles: 0,
      flattenedBelowQuarterArea: 0,
      stretchedAboveDoubleArea: 0,
      worstSeverity: 0,
    };
    row.triangles++;
    if (ratio < 0.25) row.flattenedBelowQuarterArea++;
    if (ratio > 2) row.stretchedAboveDoubleArea++;
    row.worstSeverity = Math.max(row.worstSeverity, severity);
    aggregated.set(boneName, row);

    const centroid = posed[indices[0]]!.clone().add(posed[indices[1]]!)
      .add(posed[indices[2]]!).divideScalar(3);
    worst.push({
      triangle, dominantBone: boneName, baseArea, skinnedArea,
      areaRatio: ratio, deformationSeverity: severity,
      centroidInches: [centroid.x, centroid.y, centroid.z],
      vertexIndices: indices,
    });
    inspected++;
  }
  return {
    hand,
    trianglesInspected: inspected,
    hotspots: worst.sort((a, b) => b.deformationSeverity - a.deformationSeverity
      || a.triangle - b.triangle).slice(0, topN),
    bones: [...aggregated.values()].sort((a, b) =>
      b.flattenedBelowQuarterArea + b.stretchedAboveDoubleArea -
      (a.flattenedBelowQuarterArea + a.stretchedAboveDoubleArea) ||
      a.bone.localeCompare(b.bone)),
  };
}
