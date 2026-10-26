import * as THREE from "three";

/**
 * Builds a rest-space *sampling reference* by retargeting WebXR's skinned bind
 * surface into the anatomical mesh's native bind skeleton. Neither the source
 * WebXR mesh nor the anatomical mesh is modified.
 *
 * The interpolated reference is used only for transferring WebXR skin WEIGHTS;
 * the rendered mesh remains the source anatomical geometry.
 */
export function registerWebxrSamplingSurface(
  webxrGeometry: THREE.BufferGeometry,
  webxrBones: readonly THREE.Bone[],
  anatomicalBones: readonly THREE.Bone[],
  options: { axialScale?: boolean } = {},
): THREE.BufferGeometry {
  const positions = webxrGeometry.getAttribute("position");
  const joints = webxrGeometry.getAttribute("skinIndex");
  const weights = webxrGeometry.getAttribute("skinWeight");
  if (!positions || !joints || !weights || positions.itemSize !== 3 ||
      joints.itemSize !== 4 || weights.itemSize !== 4 ||
      positions.count !== joints.count || positions.count !== weights.count) {
    throw new Error("Registration requires complete WebXR skinned geometry.");
  }
  const anatomicalByName = new Map(anatomicalBones.map(bone => [bone.name, bone]));
  if (anatomicalByName.size !== anatomicalBones.length) {
    throw new Error("Registration requires unique anatomical bone names.");
  }

  const transforms: THREE.Matrix4[] = [];
  for (const bone of webxrBones) {
    const anatomical = anatomicalByName.get(bone.name);
    if (!anatomical) throw new Error(`Missing anatomical registration bone: ${bone.name}`);
    const webxrRotation = bone.quaternion.clone();
    const anatomicalRotation = anatomical.quaternion.clone();
    const frameScale = new THREE.Vector3(1, 1, 1);
    if (options.axialScale) {
      const webxrNext = nextBoneName(bone.name);
      const webxrChild = webxrBones.find(candidate => candidate.name === webxrNext);
      const anatomicalChild = anatomicalByName.get(webxrNext);
      if (webxrChild && anatomicalChild) {
        const webxrLength = bone.position.distanceTo(webxrChild.position);
        const anatomicalLength = anatomical.position.distanceTo(anatomicalChild.position);
        if (webxrLength > 1e-4 && Number.isFinite(anatomicalLength)) {
          frameScale.z = THREE.MathUtils.clamp(anatomicalLength / webxrLength, 0.65, 1.55);
        }
      }
    }
    const fromWebxr = new THREE.Matrix4().compose(
      bone.position, webxrRotation, new THREE.Vector3(1, 1, 1),
    ).invert();
    const intoAnatomy = new THREE.Matrix4().compose(anatomical.position, anatomicalRotation, frameScale);
    transforms.push(intoAnatomy.multiply(fromWebxr));
  }

  const outPositions = new Float32Array(positions.count * 3);
  const point = new THREE.Vector3();
  const mapped = new THREE.Vector3();
  const combined = new THREE.Vector3();
  for (let vertex = 0; vertex < positions.count; vertex++) {
    point.fromBufferAttribute(positions, vertex);
    combined.set(0, 0, 0);
    let total = 0;
    for (let slot = 0; slot < 4; slot++) {
      const joint = Math.round(joints.getComponent(vertex, slot));
      const weight = weights.getComponent(vertex, slot);
      if (!Number.isInteger(joint) || joint < 0 || joint >= transforms.length ||
          !Number.isFinite(weight) || weight < 0) {
        throw new Error("Registration reference has an invalid joint weight.");
      }
      if (weight <= 0) continue;
      mapped.copy(point).applyMatrix4(transforms[joint]!);
      combined.addScaledVector(mapped, weight);
      total += weight;
    }
    if (!(total > 0)) throw new Error("Registration source vertex has zero bone influence.");
    combined.divideScalar(total);
    outPositions.set([combined.x, combined.y, combined.z], vertex * 3);
  }

  const result = webxrGeometry.clone();
  result.setAttribute("position", new THREE.Float32BufferAttribute(outPositions, 3));
  result.userData.testingRegistrationApplied = true;
  return result;
}

function nextBoneName(name: string): string {
  const finger = name.split("-")[0];
  if (name === "wrist") return "middle-finger-metacarpal";
  if (name === "thumb-metacarpal") return "thumb-phalanx-proximal";
  if (name === "thumb-phalanx-proximal") return "thumb-phalanx-distal";
  if (name === "thumb-phalanx-distal") return "thumb-tip";
  if (name.endsWith("-metacarpal")) return name.replace(/-metacarpal$/, "-phalanx-proximal");
  if (name.endsWith("-phalanx-proximal")) return name.replace(/-phalanx-proximal$/, "-phalanx-intermediate");
  if (name.endsWith("-phalanx-intermediate")) return name.replace(/-phalanx-intermediate$/, "-phalanx-distal");
  if (name.endsWith("-phalanx-distal")) return name.replace(/-phalanx-distal$/, "-tip");
  return finger + "-tip";
}
