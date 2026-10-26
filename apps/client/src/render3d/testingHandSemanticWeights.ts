import * as THREE from "three";

/**
 * Experimental semantic transfer of the anatomical GLB's native skin weights
 * onto the WebXR motion skeleton by matching the 25 *named bones*, not nearby
 * surface vertices. Preserves smooth hand-authored weight gradients and
 * phalanx affinity across each real anatomical joint.
 *
 * Important: this transfers weights only. It does not imply that the two GLBs'
 * rest bone frames match. Do not use in Testing until posed distortion and
 * rendered visual acceptance outperform the current transfer.
 */
export function transferAnatomicalWeightsToWebxrSkeleton(
  anatomicalGeometry: THREE.BufferGeometry,
  anatomicalBones: readonly THREE.Bone[],
  webxrBones: readonly THREE.Bone[],
): THREE.BufferGeometry {
  const positions = anatomicalGeometry.getAttribute("position");
  const originalJoint = anatomicalGeometry.getAttribute("skinIndex");
  const originalWeight = anatomicalGeometry.getAttribute("skinWeight");
  if (!positions || !originalJoint || !originalWeight || positions.itemSize !== 3 ||
      originalJoint.itemSize !== 4 || originalWeight.itemSize !== 4 ||
      originalJoint.count !== positions.count || originalWeight.count !== positions.count) {
    throw new Error("Anatomical semantic weight transfer requires four-weight native skin geometry.");
  }

  const destination = new Map<string, number>();
  for (let bone = 0; bone < webxrBones.length; bone++) {
    const name = webxrBones[bone]!.name;
    if (!name || destination.has(name)) {
      throw new Error("WebXR semantic weight transfer requires unique nonempty bone names.");
    }
    destination.set(name, bone);
  }

  const remap = anatomicalBones.map(bone => {
    const index = destination.get(bone.name);
    if (index === undefined) throw new Error(`Missing WebXR correspondence for anatomical bone ${bone.name}.`);
    return index;
  });
  if (webxrBones.length > 65535) throw new Error("WebXR skeleton has too many bones.");

  const joints = new Uint16Array(positions.count * 4);
  const weights = new Float32Array(positions.count * 4);
  let unnormalizedVertices = 0;
  for (let vertex = 0; vertex < positions.count; vertex++) {
    let total = 0;
    const influences = new Map<number, number>();
    for (let slot = 0; slot < 4; slot++) {
      const oldIndex = originalJoint.getComponent(vertex, slot);
      const weight = originalWeight.getComponent(vertex, slot);
      if (!Number.isInteger(oldIndex) || oldIndex < 0 || oldIndex >= remap.length ||
          !Number.isFinite(weight) || weight < 0) {
        throw new Error("Anatomical semantic weight transfer found invalid source influence.");
      }
      if (weight > 0) {
        const mapped = remap[oldIndex]!;
        influences.set(mapped, (influences.get(mapped) ?? 0) + weight);
        total += weight;
      }
    }
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Anatomical semantic weight transfer found an unweighted vertex.");
    }
    if (Math.abs(total - 1) > 0.0001) unnormalizedVertices++;
    let slot = 0;
    for (const [joint, weight] of [...influences.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4)) {
      joints[vertex * 4 + slot] = joint;
      weights[vertex * 4 + slot] = weight / total;
      slot++;
    }
  }

  const out = anatomicalGeometry.clone();
  out.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  out.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  out.userData.testingSemanticWeightTransfer = {
    vertices: positions.count,
    unnormalizedSourceVertices: unnormalizedVertices,
    namedBones: remap.length,
  };
  return out;
}
