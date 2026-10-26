import * as THREE from "three";

/**
 * Experimental high-detail shell on the proven WebXR deformation rig.
 *
 * The anatomical asset supplies POSITION/NORMAL/UV, while WebXR supplies both
 * the complete bind skeleton and the skinning field. The transfer is performed
 * once on model load, never per animation frame. It avoids reusing the anatomical
 * GLB's estimated, sometimes cross-finger skin weights.
 *
 * This is an approximation; it requires actual posed-image acceptance. In
 * particular, nearest-surface transfer is not a replacement for corrective
 * shapes or manual review of thumb-web and wrist topology.
 */
export interface TestingAnatomicalTransferOptions {
  anatomicalBoneNames: readonly string[];
  webxrBoneNames: readonly string[];
}

function fingerId(name: string): number {
  if (name.startsWith("thumb-")) return 1;
  if (name.startsWith("index-finger-")) return 2;
  if (name.startsWith("middle-finger-")) return 3;
  if (name.startsWith("ring-finger-")) return 4;
  if (name.startsWith("pinky-finger-")) return 5;
  return 0;
}

export function transferWebxrSkinToAnatomicalSurface(
  anatomicalGeometry: THREE.BufferGeometry,
  webxrGeometry: THREE.BufferGeometry,
  jointCount: number,
  options?: TestingAnatomicalTransferOptions,
): THREE.BufferGeometry {
  const target = anatomicalGeometry.getAttribute("position");
  const source = webxrGeometry.getAttribute("position");
  const sourceJoints = webxrGeometry.getAttribute("skinIndex");
  const sourceWeights = webxrGeometry.getAttribute("skinWeight");
  const targetJoints = anatomicalGeometry.getAttribute("skinIndex");
  const targetWeights = anatomicalGeometry.getAttribute("skinWeight");
  if (!target || !source || !sourceJoints || !sourceWeights ||
      target.itemSize !== 3 || source.itemSize !== 3 ||
      sourceJoints.itemSize !== 4 || sourceWeights.itemSize !== 4 ||
      source.count !== sourceJoints.count || source.count !== sourceWeights.count ||
      !Number.isInteger(jointCount) || jointCount < 1 || jointCount > 65535) {
    throw new Error("Testing hand requires complete WebXR skin attributes and valid geometry.");
  }

  if (options && (!targetJoints || !targetWeights || targetJoints.count !== target.count ||
      targetWeights.count !== target.count || targetJoints.itemSize !== 4 ||
      targetWeights.itemSize !== 4 || options.webxrBoneNames.length !== jointCount)) {
    throw new Error("Testing anatomical transfer requires complete native bone labels.");
  }
  const referenceFinger = options ? new Int8Array(source.count) : null;
  if (options && referenceFinger) {
    for (let vertex = 0; vertex < source.count; vertex++) {
      const scores = new Float64Array(6);
      for (let slot = 0; slot < 4; slot++) {
        const index = Math.round(sourceJoints.getComponent(vertex, slot));
        const weight = sourceWeights.getComponent(vertex, slot);
        if (weight > 0 && index >= 0 && index < options.webxrBoneNames.length) {
          scores[fingerId(options.webxrBoneNames[index]!)] += weight;
        }
      }
      let best = 0;
      for (let digit = 1; digit <= 5; digit++) {
        if (scores[digit]! > scores[best]!) best = digit;
      }
      referenceFinger[vertex] = scores[best]! > 0.55 ? best : 0;
    }
  }

  const cellSize = 0.36; // inches; hand geometry is already in world-inch bind space
  const cell = (value: number) => Math.floor(value / cellSize);
  const key = (x: number, y: number, z: number) => [x, y, z].join(":");
  const buckets = new Map<string, number[]>();

  for (let vertex = 0; vertex < source.count; vertex++) {
    const x = source.getX(vertex);
    const y = source.getY(vertex);
    const z = source.getZ(vertex);
    if (![x, y, z].every(Number.isFinite)) throw new Error("WebXR bind mesh has non-finite vertices.");
    const id = key(cell(x), cell(y), cell(z));
    const bucket = buckets.get(id);
    if (bucket) bucket.push(vertex);
    else buckets.set(id, [vertex]);
  }

  const joints = new Uint16Array(target.count * 4);
  const weights = new Float32Array(target.count * 4);
  const nearestDistancesInches = new Float32Array(target.count);
  for (let vertex = 0; vertex < target.count; vertex++) {
    const x = target.getX(vertex);
    const y = target.getY(vertex);
    const z = target.getZ(vertex);
    if (![x, y, z].every(Number.isFinite)) throw new Error("Testing hand bind mesh has non-finite vertices.");

    const cx = cell(x);
    const cy = cell(y);
    const cz = cell(z);
    let anatomicalFinger = 0;
    if (options && targetJoints && targetWeights) {
      const scores = new Float64Array(6);
      for (let slot = 0; slot < 4; slot++) {
        const index = Math.round(targetJoints.getComponent(vertex, slot));
        const weight = targetWeights.getComponent(vertex, slot);
        if (weight > 0 && index >= 0 && index < options.anatomicalBoneNames.length) {
          scores[fingerId(options.anatomicalBoneNames[index]!)] += weight;
        }
      }
      let best = 0;
      for (let digit = 1; digit <= 5; digit++) {
        if (scores[digit]! > scores[best]!) best = digit;
      }
      anatomicalFinger = best > 0 && scores[best]! >= 0.82 ? best : 0;
    }
    const candidates: number[] = [];
    // Include all neighbouring bind-surface samples in at least one full shell,
    // keeping the interpolation continuous across voxel cell boundaries.
    for (let radius = 1; radius <= 8; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (radius > 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue;
            const bucket = buckets.get(key(cx + dx, cy + dy, cz + dz));
            if (bucket) candidates.push(...bucket);
          }
        }
      }
      if (candidates.length >= 12) break;
    }
    if (candidates.length === 0) {
      throw new Error("Testing hand mesh has vertices too far from the WebXR reference rig.");
    }

    const nearest = candidates
      .map((index) => {
        const dx = x - source.getX(index);
        const dy = y - source.getY(index);
        const dz = z - source.getZ(index);
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        const sourceFinger = referenceFinger?.[index] ?? 0;
        const mismatch = anatomicalFinger > 0 && sourceFinger !== anatomicalFinger;
        const penalty = mismatch ? (sourceFinger === 0 ? 0.18 : 0.81) : 0;
        return { index, distanceSquared, score: distanceSquared + penalty };
      });
    const physicalNearest = Math.min(...nearest.map(candidate => candidate.distanceSquared));
    nearest.sort((a, b) => a.score - b.score || a.index - b.index);
    nearest.length = Math.min(nearest.length, 12);
    nearestDistancesInches[vertex] = Math.sqrt(physicalNearest);

    // Interpolate WebXR vertex weights rather than nearest-neighbour copying:
    // weighted interpolation softens visible skin seams and knuckle hinges.
    const influence = new Map<number, number>();
    for (const sample of nearest) {
      const spatialWeight = 1 / Math.pow(sample.score + 0.015, 1.65);
      for (let slot = 0; slot < 4; slot++) {
        const joint = Math.round(sourceJoints.getComponent(sample.index, slot));
        const weight = sourceWeights.getComponent(sample.index, slot);
        if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount ||
            !Number.isFinite(weight) || weight < 0) {
          throw new Error("WebXR skinning has an invalid joint or weight.");
        }
        if (weight > 0) influence.set(joint, (influence.get(joint) ?? 0) + spatialWeight * weight);
      }
    }
    const strongest = [...influence.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const total = strongest.reduce((sum, [, weight]) => sum + weight, 0);
    if (!(total > 0) || !Number.isFinite(total)) {
      throw new Error("Testing hand transfer has no valid skinning influence.");
    }
    for (let slot = 0; slot < strongest.length; slot++) {
      joints[vertex * 4 + slot] = strongest[slot]![0];
      weights[vertex * 4 + slot] = strongest[slot]![1] / total;
    }
  }

  const result = anatomicalGeometry.clone();
  result.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  result.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  result.userData.testingWebxrSkinTransfer = true;
  result.userData.testingFingerAware = Boolean(options);
  const sortedDistances = Array.from(nearestDistancesInches).sort((a, b) => a - b);
  const mean = sortedDistances.reduce((sum, distance) => sum + distance, 0) / sortedDistances.length;
  result.userData.testingTransferStats = {
    vertexCount: target.count,
    nearestWebxrVertexMeanInches: mean,
    nearestWebxrVertexP95Inches: sortedDistances[Math.floor((sortedDistances.length - 1) * 0.95)]!,
    nearestWebxrVertexMaxInches: sortedDistances[sortedDistances.length - 1]!,
    verticesOverHalfInch: sortedDistances.filter(distance => distance > 0.5).length,
  };
  return result;
}
