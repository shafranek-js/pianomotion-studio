import * as THREE from "three";

export const PIANO_CASE_CURVE_SEGMENTS = 64;
export const PIANO_CASE_BEVEL_SEGMENTS = 8;
export const PIANO_CASE_CREASE_ANGLE = Math.PI / 6;

function creasedNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const result = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = result.getAttribute("position");
  const faceCount = positions.count / 3;
  const faceNormals = new Float64Array(faceCount * 3);
  const adjacentFaces = new Map<string, number[]>();

  const positionKey = (vertex: number): string => {
    const x = positions.getX(vertex);
    const y = positions.getY(vertex);
    const z = positions.getZ(vertex);
    return `${x === 0 ? 0 : x},${y === 0 ? 0 : y},${z === 0 ? 0 : z}`;
  };

  for (let face = 0; face < faceCount; face += 1) {
    const first = face * 3;
    const a = new THREE.Vector3().fromBufferAttribute(positions, first);
    const b = new THREE.Vector3().fromBufferAttribute(positions, first + 1);
    const c = new THREE.Vector3().fromBufferAttribute(positions, first + 2);
    const normal = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    if (normal.lengthSq() > 0) normal.normalize();
    faceNormals.set([normal.x, normal.y, normal.z], face * 3);

    for (let corner = 0; corner < 3; corner += 1) {
      const key = positionKey(first + corner);
      const faces = adjacentFaces.get(key);
      if (faces) faces.push(face);
      else adjacentFaces.set(key, [face]);
    }
  }

  const creaseDot = Math.cos(PIANO_CASE_CREASE_ANGLE);
  const normalArray = new Float32Array(positions.count * 3);
  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    const face = Math.floor(vertex / 3);
    const faceOffset = face * 3;
    const nx = faceNormals[faceOffset]!;
    const ny = faceNormals[faceOffset + 1]!;
    const nz = faceNormals[faceOffset + 2]!;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;

    for (const adjacentFace of adjacentFaces.get(positionKey(vertex)) ?? []) {
      const offset = adjacentFace * 3;
      const ox = faceNormals[offset]!;
      const oy = faceNormals[offset + 1]!;
      const oz = faceNormals[offset + 2]!;
      if (nx * ox + ny * oy + nz * oz <= creaseDot) continue;
      sumX += ox;
      sumY += oy;
      sumZ += oz;
    }

    const length = Math.hypot(sumX, sumY, sumZ) || 1;
    normalArray[vertex * 3] = sumX / length;
    normalArray[vertex * 3 + 1] = sumY / length;
    normalArray[vertex * 3 + 2] = sumZ / length;
  }

  result.setAttribute("normal", new THREE.BufferAttribute(normalArray, 3));
  return result;
}

/** Builds a finely sampled piano-case extrusion with smooth curved faces and crisp seams. */
export function createPianoCaseGeometry(
  shape: THREE.Shape,
  options: THREE.ExtrudeGeometryOptions,
): THREE.BufferGeometry {
  const source = new THREE.ExtrudeGeometry(shape, {
    ...options,
    curveSegments: PIANO_CASE_CURVE_SEGMENTS,
    bevelSegments: PIANO_CASE_BEVEL_SEGMENTS,
  });

  try {
    const creased = creasedNormals(source);
    if (creased !== source) source.dispose();
    return creased;
  } catch (error) {
    source.dispose();
    throw error;
  }
}
