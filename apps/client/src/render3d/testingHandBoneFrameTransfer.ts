import * as THREE from "three";
import { transferWebxrSkinToAnatomicalSurface, type TestingAnatomicalTransferOptions } from "./testingHandSkin";

/**
 * Offline-only experiment. Transfer anatomical queries into the rest-local
 * frames of *corresponding* WebXR bones before sampling WebXR skin influences.
 *
 * Anatomical and WebXR bind meshes can be globally aligned while PIP/DIP bone
 * centers/axes are still centimeters apart. Nearest-world-vertex skin weights
 * can then grab the wrong phalanx even with the correct finger label.
 *
 * This uses the native anatomical mesh's original skin weights only to
 * establish bone-frame correspondence for sampling; the final deformation
 * rig remains WebXR. It never changes source GLBs, the musical motion engine
 * or visible Testing until objective and visual QA approve it.
 */
export interface TestingBoneFrameMappingStats {
  vertexCount: number;
  transformedVertexCount: number;
  meanDisplacementInches: number;
  p95DisplacementInches: number;
  maxDisplacementInches: number;
  /** Only present in experimental thumb-axial sampling mode. */
  thumbAxialRatios?: Readonly<Record<string, number>>;
  thumbAxialStrength?: number;
}

/** Distal joint anchors for the thumb. The reference and native GLBs are
 * independent bind rigs; ratios apply ONLY to temporary weight queries. */
const THUMB_CHILDREN: Readonly<Record<string, string>> = {
  "thumb-metacarpal": "thumb-phalanx-proximal",
  "thumb-phalanx-proximal": "thumb-phalanx-distal",
  "thumb-phalanx-distal": "thumb-tip",
};

export interface TestingBoneFrameTransferOptions {
  /** Experimental only. Never deform the original source mesh with this scale. */
  thumbAxialScale?: boolean;
  /** 0..1 partial segment correction for measured A/B research. Overrides boolean. */
  thumbAxialStrength?: number;
}

export function mapAnatomicalSurfaceToWebxrBindFrames(
  anatomical: THREE.BufferGeometry,
  nativeBones: readonly THREE.Bone[],
  referenceBones: readonly THREE.Bone[],
  options: TestingBoneFrameTransferOptions = {},
): { geometry: THREE.BufferGeometry; stats: TestingBoneFrameMappingStats } {
  const position = anatomical.getAttribute("position");
  const skinIndex = anatomical.getAttribute("skinIndex");
  const skinWeight = anatomical.getAttribute("skinWeight");
  if (!position || !skinIndex || !skinWeight ||
      position.itemSize !== 3 || skinIndex.itemSize !== 4 ||
      skinWeight.itemSize !== 4 || skinIndex.count !== position.count ||
      skinWeight.count !== position.count) {
    throw new Error("Bone-frame registration requires valid anatomical skin attributes.");
  }
  const references = new Map<string, THREE.Bone>();
  for (const bone of referenceBones) {
    if (!bone.name || references.has(bone.name)) throw new Error("WebXR bone names must be unique.");
    references.set(bone.name, bone);
  }
  const nativeByName = new Map(nativeBones.map(bone => [bone.name, bone]));
  if (nativeByName.size !== nativeBones.length) {
    throw new Error("Native anatomical bone names must be unique.");
  }
  const thumbAxialRatios: Record<string, number> = {};
  const thumbAxialStrength = options.thumbAxialStrength ?? (options.thumbAxialScale ? 1 : 0);
  if (!Number.isFinite(thumbAxialStrength) || thumbAxialStrength < 0 || thumbAxialStrength > 1) {
    throw new Error("Thumb axial calibration strength must be between 0 and 1.");
  }
  const transforms = nativeBones.map(bone => {
    const counterpart = references.get(bone.name);
    if (!counterpart) throw new Error(`No matching WebXR bone for anatomical ${bone.name}.`);
    // Bone geometry is rest-pose world-inch space; the 25 bones are stored
    // as independent children in the existing application loader.
    bone.updateWorldMatrix(true, false);
    counterpart.updateWorldMatrix(true, false);
    const inverseNative = bone.matrixWorld.clone().invert();
    const axial = new THREE.Matrix4();
    const childName = thumbAxialStrength > 0 ? THUMB_CHILDREN[bone.name] : undefined;
    if (childName) {
      const nativeChild = nativeByName.get(childName);
      const referenceChild = references.get(childName);
      if (!nativeChild || !referenceChild) {
        throw new Error(`Missing thumb bind-segment endpoint for ${bone.name}.`);
      }
      nativeChild.updateWorldMatrix(true, false);
      referenceChild.updateWorldMatrix(true, false);
      const nativeLength = bone.getWorldPosition(new THREE.Vector3())
        .distanceTo(nativeChild.getWorldPosition(new THREE.Vector3()));
      const referenceLength = counterpart.getWorldPosition(new THREE.Vector3())
        .distanceTo(referenceChild.getWorldPosition(new THREE.Vector3()));
      if (!Number.isFinite(nativeLength) || !Number.isFinite(referenceLength) ||
          nativeLength < 1e-6 || referenceLength < 1e-6) {
        throw new Error(`Invalid thumb bind-segment length for ${bone.name}.`);
      }
      const ratio = referenceLength / nativeLength;
      // Do NOT silently clamp a bad registration: report and reject it.
      if (ratio < 0.45 || ratio > 1.8) {
        throw new Error(`Implausible thumb axial ratio for ${bone.name}: ${ratio}.`);
      }
      const appliedRatio = 1 + thumbAxialStrength * (ratio - 1);
      thumbAxialRatios[bone.name] = appliedRatio;
      // Bone-local -Z points along the native segment. Scale the location
      // used to SAMPLE weights, never the output POSITION/normal/UV attributes.
      axial.makeScale(1, 1, appliedRatio);
    }
    return counterpart.matrixWorld.clone().multiply(axial).multiply(inverseNative);
  });

  const original = new THREE.Vector3();
  const transferred = new THREE.Vector3();
  const sample = new THREE.Vector3();
  const out = new Float32Array(position.count * 3);
  const movement: number[] = [];
  let transformedVertexCount = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    original.fromBufferAttribute(position, vertex);
    if (![original.x, original.y, original.z].every(Number.isFinite)) {
      throw new Error("Anatomical registration encountered non-finite rest position.");
    }
    transferred.set(0, 0, 0);
    let sum = 0;
    for (let slot = 0; slot < 4; slot++) {
      const bone = Math.round(skinIndex.getComponent(vertex, slot));
      const weight = skinWeight.getComponent(vertex, slot);
      if (!Number.isInteger(bone) || bone < 0 || bone >= transforms.length ||
          !Number.isFinite(weight) || weight < 0) {
        throw new Error("Anatomical registration encountered invalid bone influence.");
      }
      if (weight === 0) continue;
      sample.copy(original).applyMatrix4(transforms[bone]!);
      transferred.addScaledVector(sample, weight);
      sum += weight;
    }
    if (!(sum > 0)) throw new Error("Anatomical registration has a vertex without bone influences.");
    transferred.divideScalar(sum);
    movement.push(original.distanceTo(transferred));
    if (movement[movement.length - 1]! > 1e-6) transformedVertexCount++;
    out.set([transferred.x, transferred.y, transferred.z], vertex * 3);
  }

  movement.sort((a, b) => a - b);
  const geometry = anatomical.clone();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  const stats = {
    vertexCount: position.count,
    transformedVertexCount,
    meanDisplacementInches: movement.reduce((s, n) => s + n, 0) / movement.length,
    p95DisplacementInches: movement[Math.floor(0.95 * (movement.length - 1))]!,
    maxDisplacementInches: movement[movement.length - 1]!,
    ...(thumbAxialStrength > 0 ? { thumbAxialRatios, thumbAxialStrength } : {}),
  };
  geometry.userData.testingBoneFrameMapping = stats;
  return { geometry, stats };
}

/**
 * Returns the ORIGINAL realistic surface with *only* transferred WebXR weights.
 * Query points are mapped into WebXR rest-bone coordinates temporarily.
 * This guarantees the source geometry/UVs/normals/index are not overwritten.
 */
export function transferTestingWeightsInBoneFrames(
  anatomical: THREE.BufferGeometry,
  reference: THREE.BufferGeometry,
  nativeBones: readonly THREE.Bone[],
  referenceBones: readonly THREE.Bone[],
  options: TestingAnatomicalTransferOptions,
  registrationOptions: TestingBoneFrameTransferOptions = {},
): THREE.BufferGeometry {
  const mapped = mapAnatomicalSurfaceToWebxrBindFrames(
    anatomical, nativeBones, referenceBones, registrationOptions,
  );
  try {
    const skinnedQuery = transferWebxrSkinToAnatomicalSurface(
      mapped.geometry, reference, referenceBones.length, options,
    );
    try {
      const output = anatomical.clone();
      output.setAttribute("skinIndex", skinnedQuery.getAttribute("skinIndex").clone());
      output.setAttribute("skinWeight", skinnedQuery.getAttribute("skinWeight").clone());
      output.userData.testingWebxrSkinTransfer = true;
      output.userData.testingBoneFrameTransfer = true;
      output.userData.testingTransferStats = skinnedQuery.userData.testingTransferStats;
      output.userData.testingBoneFrameMapping = mapped.stats;
      return output;
    } finally {
      skinnedQuery.dispose();
    }
  } finally {
    mapped.geometry.dispose();
  }
}
