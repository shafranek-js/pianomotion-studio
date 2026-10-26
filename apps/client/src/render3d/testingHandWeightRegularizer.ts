import * as THREE from "three";
import type { TestingAnatomicalTransferOptions } from "./testingHandSkin";

/**
 * Experimental, one-time regularizer for Testing's transferred WebXR weights.
 *
 * Nearest-surface transfer can assign visibly different skin influences to
 * adjacent triangles. A small topology-neighbour smoothing pass reduces these
 * discontinuities while respecting confident anatomical finger boundaries.
 * This module does not mutate the original GLB, pose engine, or source buffer.
 *
 * Do not enable in the renderer until real-pose QA shows lower distortion and
 * equivalent finger isolation for both hands and all LODs.
 */
export function regularizeTestingSkinWeights(
  transferred: THREE.BufferGeometry,
  anatomical: THREE.BufferGeometry,
  options: TestingAnatomicalTransferOptions,
  passes = 2,
  blend = 0.35,
): THREE.BufferGeometry {
  const positions = transferred.getAttribute("position");
  const indices = transferred.getIndex();
  const nativeJoint = anatomical.getAttribute("skinIndex");
  const nativeWeight = anatomical.getAttribute("skinWeight");
  const transferredJoint = transferred.getAttribute("skinIndex");
  const transferredWeight = transferred.getAttribute("skinWeight");

  if (!positions || !indices || !nativeJoint || !nativeWeight || !transferredJoint ||
      !transferredWeight || nativeJoint.count !== positions.count ||
      nativeWeight.count !== positions.count ||
      transferredJoint.count !== positions.count ||
      transferredWeight.count !== positions.count ||
      transferredJoint.itemSize !== 4 || transferredWeight.itemSize !== 4 ||
      nativeJoint.itemSize !== 4 || nativeWeight.itemSize !== 4 ||
      !Number.isInteger(passes) || passes < 1 || passes > 8 ||
      !Number.isFinite(blend) || blend < 0 || blend > 1) {
    throw new Error("Testing skin regularizer needs matched, four-influence indexed meshes.");
  }

  const digit = (name: string): number => {
    if (name.startsWith("thumb-")) return 1;
    if (name.startsWith("index-finger-")) return 2;
    if (name.startsWith("middle-finger-")) return 3;
    if (name.startsWith("ring-finger-")) return 4;
    if (name.startsWith("pinky-finger-")) return 5;
    return 0;
  };
  const nativeDigit = new Uint8Array(positions.count);
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const values = new Float64Array(6);
    for (let slot = 0; slot < 4; slot++) {
      const index = Math.round(nativeJoint.getComponent(vertex, slot));
      const weight = nativeWeight.getComponent(vertex, slot);
      if (weight > 0 && options.anatomicalBoneNames[index]) {
        values[digit(options.anatomicalBoneNames[index]!)] += weight;
      }
    }
    let strongestDigit = 0;
    for (let i = 1; i <= 5; i++) {
      if (values[i]! > values[strongestDigit]!) strongestDigit = i;
    }
    if (strongestDigit !== 0 && values[strongestDigit]! >= 0.82) {
      nativeDigit[vertex] = strongestDigit;
    }
  }

  const neighbors: Set<number>[] = Array.from({ length: positions.count }, () => new Set<number>());
  const link = (a: number, b: number) => {
    if (a < 0 || b < 0 || a >= positions.count || b >= positions.count) {
      throw new Error("Testing geometry contains an invalid triangle index.");
    }
    neighbors[a]!.add(b);
    neighbors[b]!.add(a);
  };
  for (let index = 0; index + 2 < indices.count; index += 3) {
    const a = indices.getX(index);
    const b = indices.getX(index + 1);
    const c = indices.getX(index + 2);
    link(a, b);
    link(b, c);
    link(c, a);
  }

  const source: Array<Map<number, number>> = [];
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const influences = new Map<number, number>();
    for (let slot = 0; slot < 4; slot++) {
      const index = Math.round(transferredJoint.getComponent(vertex, slot));
      const weight = transferredWeight.getComponent(vertex, slot);
      if (weight > 0) influences.set(index, (influences.get(index) ?? 0) + weight);
    }
    source.push(influences);
  }

  let state = source;
  for (let iteration = 0; iteration < passes; iteration++) {
    state = state.map((current, vertex) => {
      const ownDigit = nativeDigit[vertex]!;
      const sameRegion = [...neighbors[vertex]!].filter(neighbor =>
        !(ownDigit > 0 && nativeDigit[neighbor]! > 0 && nativeDigit[neighbor] !== ownDigit));
      if (sameRegion.length === 0) return current;
      const influence = new Map<number, number>();
      const add = (joint: number, value: number) =>
        influence.set(joint, (influence.get(joint) ?? 0) + value);
      for (const [joint, weight] of current) add(joint, weight * (1 - blend));
      const distanceWeights = sameRegion.map(neighbor => {
        const dx = positions.getX(vertex) - positions.getX(neighbor);
        const dy = positions.getY(vertex) - positions.getY(neighbor);
        const dz = positions.getZ(vertex) - positions.getZ(neighbor);
        return 1 / Math.max(1e-4, dx * dx + dy * dy + dz * dz);
      });
      const totalDistance = distanceWeights.reduce((total, w) => total + w, 0);
      for (let i = 0; i < sameRegion.length; i++) {
        const neighbor = sameRegion[i]!;
        const factor = blend * distanceWeights[i]! / totalDistance;
        for (const [joint, weight] of state[neighbor]!) add(joint, weight * factor);
      }
      if (ownDigit > 0) {
        for (const [joint] of influence) {
          const sourceDigit = digit(options.webxrBoneNames[joint] ?? "");
          if (sourceDigit > 0 && sourceDigit !== ownDigit) influence.delete(joint);
        }
      }
      const strongest = [...influence.entries()]
        .filter(([, weight]) => weight > 1e-12)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 4);
      const total = strongest.reduce((sum, [, weight]) => sum + weight, 0);
      if (!(total > 0)) return current;
      return new Map(strongest.map(([joint, weight]) => [joint, weight / total]));
    });
  }

  const joints = new Uint16Array(positions.count * 4);
  const weights = new Float32Array(positions.count * 4);
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let slot = 0;
    for (const [joint, weight] of state[vertex]!) {
      if (slot >= 4) break;
      joints[vertex * 4 + slot] = joint;
      weights[vertex * 4 + slot] = weight;
      slot++;
    }
  }
  const result = transferred.clone();
  result.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  result.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  result.userData.testingTopologyRegularization = { passes, blend };
  return result;
}
