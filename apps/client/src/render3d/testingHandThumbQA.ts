import * as THREE from "three";

/**
 * Side-by-side deformation QA against FIXED anatomical source triangles.
 *
 * Candidate skin weights cannot be used to decide which triangles belong
 * to the thumb: that changes the denominator and makes A/B comparisons
 * misleading. Select the triangle IDs solely from the source GLB's native
 * bone labels and original vertex weights.
 */
export interface TestingThumbRegionMetrics {
  inspectedTriangles: number;
  collapsedBelowQuarter: number;
  expandedAboveDouble: number;
  peakAreaSeverity: number;
  areaRatioP05: number;
  areaRatioP95: number;
  maxEdgeStretch: number;
}

const thumbName = (name: string) => name.startsWith("thumb-");

function triangleArea(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return new THREE.Vector3().subVectors(b, a)
    .cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5;
}
function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) * fraction)]!;
}

export function measureTestingFixedThumbRegion(
  mesh: THREE.SkinnedMesh,
  anatomical: THREE.BufferGeometry,
  nativeBoneNames: readonly string[],
): TestingThumbRegionMetrics {
  const sourcePos = anatomical.getAttribute("position");
  const sourceIndex = anatomical.getIndex();
  const nativeIndex = anatomical.getAttribute("skinIndex");
  const nativeWeight = anatomical.getAttribute("skinWeight");
  const posedPos = mesh.geometry.getAttribute("position");
  const posedIndex = mesh.geometry.getIndex();
  if (!sourcePos || !sourceIndex || !nativeIndex || !nativeWeight ||
      !posedPos || !posedIndex || sourcePos.count !== posedPos.count ||
      sourceIndex.count !== posedIndex.count ||
      nativeIndex.count !== sourcePos.count ||
      nativeWeight.count !== sourcePos.count ||
      nativeIndex.itemSize !== 4 || nativeWeight.itemSize !== 4) {
    throw new Error("Testing thumb QA requires matching indexed native and candidate geometries.");
  }

  const anatomyThumb = new Float32Array(sourcePos.count);
  const original: THREE.Vector3[] = [];
  const skinned: THREE.Vector3[] = [];
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  for (let i = 0; i < sourcePos.count; i++) {
    const native = new THREE.Vector3().fromBufferAttribute(sourcePos, i);
    const candidate = new THREE.Vector3().fromBufferAttribute(posedPos, i);
    if (native.distanceTo(candidate) > 1e-5) {
      throw new Error("Testing thumb A/B changed original anatomical POSITION.");
    }
    for (let slot = 0; slot < 4; slot++) {
      const index = nativeIndex.getComponent(i, slot);
      const weight = nativeWeight.getComponent(i, slot);
      if (!Number.isInteger(index) || index < 0 || index >= nativeBoneNames.length ||
          !Number.isFinite(weight) || weight < 0) {
        throw new Error("Invalid native thumb segmentation influence.");
      }
      if (thumbName(nativeBoneNames[index]!)) anatomyThumb[i] = anatomyThumb[i]! + weight;
    }
    original.push(native);
    const warped = mesh.applyBoneTransform(i, candidate);
    if (![warped.x, warped.y, warped.z].every(Number.isFinite)) {
      throw new Error("Non-finite candidate thumb deformation.");
    }
    skinned.push(warped);
  }

  const areas: number[] = [];
  let collapsed = 0, expanded = 0, peak = 1, maxEdgeStretch = 1;
  for (let offset = 0; offset < sourceIndex.count; offset += 3) {
    const ids = [sourceIndex.getX(offset), sourceIndex.getX(offset + 1),
      sourceIndex.getX(offset + 2)] as const;
    for (let corner = 0; corner < 3; corner++) {
      if (ids[corner] !== posedIndex.getX(offset + corner)) {
        throw new Error("Testing thumb A/B changed source triangle topology.");
      }
    }
    // Majority vote on native anatomy, fixed independently of candidate weights.
    const count = ids.filter(i => anatomyThumb[i]! >= 0.55).length;
    if (count < 2) continue;
    const [a, b, c] = ids;
    const startArea = triangleArea(original[a!]!, original[b!]!, original[c!]!);
    if (startArea < 1e-7) continue;
    const areaRatio = triangleArea(skinned[a!]!, skinned[b!]!, skinned[c!]!) / startArea;
    if (!Number.isFinite(areaRatio)) throw new Error("Non-finite Testing thumb area ratio.");
    areas.push(areaRatio);
    if (areaRatio < 0.25) collapsed++;
    if (areaRatio > 2) expanded++;
    peak = Math.max(peak, areaRatio, 1 / Math.max(areaRatio, 1e-12));
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const rest = original[x]!.distanceTo(original[y]!);
      if (rest > 1e-5) {
        maxEdgeStretch = Math.max(maxEdgeStretch,
          skinned[x]!.distanceTo(skinned[y]!) / rest);
      }
    }
  }
  if (areas.length === 0) throw new Error("Testing thumb QA found no anatomical thumb triangles.");
  return {
    inspectedTriangles: areas.length,
    collapsedBelowQuarter: collapsed,
    expandedAboveDouble: expanded,
    peakAreaSeverity: peak,
    areaRatioP05: percentile(areas, 0.05),
    areaRatioP95: percentile(areas, 0.95),
    maxEdgeStretch,
  };
}
