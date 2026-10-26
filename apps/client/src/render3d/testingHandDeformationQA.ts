import * as THREE from "three";

/**
 * Mesh-level deformation diagnostics for the experimental Testing hand.
 *
 * The WebXR pose parity tests only tell us that bones move identically.
 * This measures the real GPU-skinned geometry's equivalent CPU deformation,
 * so extreme stretching/collapsing around a knuckle cannot hide behind
 * otherwise-correct bone matrices. It does not establish anatomical realism.
 *
 * Units cancel out in every ratio. Geometry indices and authored normals,
 * UVs, triangles and materials are not modified.
 */
export interface TestingHandDeformationMetrics {
  vertices: number;
  inspectedTriangles: number;
  inspectedEdges: number;
  edgeStretchP95: number;
  edgeStretchMax: number;
  edgeCompressionP05: number;
  edgeCompressionMin: number;
  trianglesAreaBelowHalf: number;
  trianglesAreaBelowQuarter: number;
  trianglesAreaAboveDouble: number;
  areaRatioP05: number;
  areaRatioP95: number;
  areaRatioMin: number;
  areaRatioMax: number;
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 1;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)))]!;
}

function length(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.distanceTo(b);
}

function area(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return new THREE.Vector3().subVectors(b, a)
    .cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5;
}

export function measureTestingHandDeformation(mesh: THREE.SkinnedMesh): TestingHandDeformationMetrics {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const indices = geometry.getIndex();
  if (!position || position.itemSize !== 3 || !indices ||
      !geometry.getAttribute("skinIndex") || !geometry.getAttribute("skinWeight")) {
    throw new Error("Testing hand deformation probe needs indexed skinned geometry.");
  }

  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();

  const original: THREE.Vector3[] = [];
  const deformed: THREE.Vector3[] = [];
  for (let index = 0; index < position.count; index++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, index);
    const skinned = mesh.applyBoneTransform(index, point.clone());
    if (![skinned.x, skinned.y, skinned.z].every(Number.isFinite)) {
      throw new Error(`Non-finite skinned Testing hand vertex ${index}.`);
    }
    original.push(point);
    deformed.push(skinned);
  }

  const stretches: number[] = [];
  const compressions: number[] = [];
  const areas: number[] = [];
  let belowHalf = 0;
  let belowQuarter = 0;
  let aboveDouble = 0;
  let triangles = 0;
  for (let offset = 0; offset + 2 < indices.count; offset += 3) {
    const ids = [indices.getX(offset), indices.getX(offset + 1), indices.getX(offset + 2)];
    const [a, b, c] = ids;
    if ([a, b, c].some(id => !Number.isInteger(id) || id < 0 || id >= position.count)) {
      throw new Error("Testing hand has an invalid triangle index.");
    }
    const before = [original[a!]!, original[b!]!, original[c!]!] as const;
    const after = [deformed[a!]!, deformed[b!]!, deformed[c!]!] as const;
    const initialArea = area(...before);
    if (initialArea < 1e-7) continue;
    const ratio = area(...after) / initialArea;
    if (!Number.isFinite(ratio)) throw new Error("Non-finite Testing hand triangle area ratio.");
    areas.push(ratio);
    triangles++;
    if (ratio < 0.5) belowHalf++;
    if (ratio < 0.25) belowQuarter++;
    if (ratio > 2) aboveDouble++;
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      const base = length(before[i], before[j]);
      if (base < 1e-5) continue;
      const deformation = length(after[i], after[j]) / base;
      if (!Number.isFinite(deformation)) throw new Error("Non-finite Testing hand triangle edge ratio.");
      stretches.push(deformation);
      compressions.push(deformation);
    }
  }
  if (triangles === 0 || stretches.length === 0) throw new Error("Testing hand has no measurable surface faces.");

  return {
    vertices: position.count,
    inspectedTriangles: triangles,
    inspectedEdges: stretches.length,
    edgeStretchP95: quantile(stretches, 0.95),
    edgeStretchMax: stretches[stretches.length - 1]!,
    edgeCompressionP05: quantile(compressions, 0.05),
    edgeCompressionMin: compressions[0]!,
    trianglesAreaBelowHalf: belowHalf,
    trianglesAreaBelowQuarter: belowQuarter,
    trianglesAreaAboveDouble: aboveDouble,
    areaRatioP05: quantile(areas, 0.05),
    areaRatioP95: quantile(areas, 0.95),
    areaRatioMin: areas[0]!,
    areaRatioMax: areas[areas.length - 1]!,
  };
}
