import * as THREE from "three";

/**
 * glTF stores morph target positions as DELTAS in metres relative to POSITION.
 * Our piano scene stores positions in inches, so morph deltas require exactly
 * the same unit conversion as the original hand positions.
 *
 * The current shipped GLBs have no morphs. Future Blender correctives must
 * use the stable pmcorr_{finger}_{joint}_{angle} naming contract.
 */
const METERS_TO_INCHES = 39.37007874015748;
const CORRECTIVE_NAME = /^pmcorr_(?:thumb_(?:cmc|mcp|ip)|(?:index|middle|ring|pinky)_(?:mcp|pip|dip)|wrist_flex)_(?:030|060|090)$/;

export interface TestingHandGltfMorph {
  name: string;
  positionDeltaMeters: Float32Array;
  normalDelta?: Float32Array;
}

/** Called at GLB load time; remains inert for existing non-morphed meshes. */
export function attachTestingHandMorphTargets(
  geometry: THREE.BufferGeometry,
  targets: readonly TestingHandGltfMorph[],
): void {
  if (targets.length === 0) return;
  const original = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!original || !normals || original.itemSize !== 3 || normals.itemSize !== 3 ||
      normals.count !== original.count || targets.length > 48) {
    throw new Error("Testing pose morph import requires complete original hand geometry.");
  }
  if (geometry.morphAttributes.position?.length) {
    throw new Error("Testing hand geometry already contains position morph targets.");
  }

  const seen = new Set<string>();
  const positionTargets: THREE.Float32BufferAttribute[] = [];
  const normalTargets: THREE.Float32BufferAttribute[] = [];
  let actualDisplacements = 0;
  for (const morph of targets) {
    if (!CORRECTIVE_NAME.test(morph.name) || seen.has(morph.name)) {
      throw new Error(`Invalid or duplicate Testing morph target: ${morph.name}`);
    }
    seen.add(morph.name);
    if (morph.positionDeltaMeters.length !== original.count * 3 ||
        (morph.normalDelta && morph.normalDelta.length !== original.count * 3)) {
      throw new Error(`Testing morph ${morph.name} has mismatched vertex count.`);
    }
    const positions = new Float32Array(original.count * 3);
    const normalArray = new Float32Array(original.count * 3);
    for (let i = 0; i < positions.length; i++) {
      const delta = morph.positionDeltaMeters[i]!;
      const normalDelta = morph.normalDelta?.[i] ?? 0;
      if (!Number.isFinite(delta) || !Number.isFinite(normalDelta)) {
        throw new Error(`Testing morph ${morph.name} has non-finite deltas.`);
      }
      positions[i] = delta * METERS_TO_INCHES;
      normalArray[i] = normalDelta;
      if (Math.abs(delta) > 1e-7) actualDisplacements++;
    }
    const attr = new THREE.Float32BufferAttribute(positions, 3);
    attr.name = morph.name;
    const normalAttr = new THREE.Float32BufferAttribute(normalArray, 3);
    normalAttr.name = morph.name;
    positionTargets.push(attr);
    normalTargets.push(normalAttr);
  }
  // Current Blender preparation produces ZERO deltas. They are scaffolding
  // and cannot be mistaken for a finished anatomical corrective asset.
  if (actualDisplacements === 0) {
    throw new Error("All Testing hand morphs are empty/unsculpted.");
  }
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = positionTargets;
  geometry.morphAttributes.normal = normalTargets;
  geometry.userData.testingPoseMorphTargets = [...seen];
}
