import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Box3, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.lengthComputable = Boolean(init.lengthComputable);
      this.loaded = Number(init.loaded ?? 0);
      this.total = Number(init.total ?? 0);
    }
  };
}

function glbArrayBuffer(file) {
  const bytes = fs.readFileSync(file);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function readGlbJson(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error(`${file} is not a GLB 2 file.`);
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file} does not begin with a JSON GLB chunk.`);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
}

function boxJSON(box) {
  const min = box.min.toArray();
  const max = box.max.toArray();
  const size = box.getSize(new Vector3()).toArray();
  return {
    minMeters: min.map((v) => +v.toFixed(9)),
    maxMeters: max.map((v) => +v.toFixed(9)),
    sizeMeters: size.map((v) => +v.toFixed(9)),
    diagonalMeters: +new Vector3(...size).length().toFixed(9),
  };
}

function scaleComparison(sourceBounds, runtimeBounds) {
  if (!sourceBounds || !runtimeBounds) return null;
  const sourceSorted = [...sourceBounds.size].sort((a, b) => a - b);
  const runtimeSorted = [...runtimeBounds.sizeMeters].sort((a, b) => a - b);
  const sortedAxisDelta = sourceSorted.map((value, index) => Math.abs(value - runtimeSorted[index]));
  const sourceDiagonal = sourceBounds.diagonalMeters;
  const runtimeDiagonal = runtimeBounds.diagonalMeters;
  return {
    sourceAabbSizeMeters: sourceBounds.size.map((v) => +v.toFixed(9)),
    runtimeSkinnedAabbSizeMeters: runtimeBounds.sizeMeters,
    sourceSortedExtentMeters: sourceSorted.map((v) => +v.toFixed(9)),
    runtimeSortedExtentMeters: runtimeSorted.map((v) => +v.toFixed(9)),
    maxSortedExtentDifferenceMeters: +Math.max(...sortedAxisDelta).toFixed(9),
    sourceAabbDiagonalMeters: sourceDiagonal,
    runtimeSkinnedAabbDiagonalMeters: runtimeDiagonal,
    runtimeToSourceDiagonalRatio: +(runtimeDiagonal / sourceDiagonal).toFixed(9),
  };
}

function runtimeBounds(skinnedMesh, position) {
  const box = new Box3().makeEmpty();
  const p = new Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    skinnedMesh.applyBoneTransform(i, p);
    skinnedMesh.localToWorld(p);
    box.expandByPoint(p);
  }
  return box;
}

function restBindMetrics(skinnedMesh, skinIndex, skinWeight) {
  let maxWeightSumError = 0;
  const boneRestMatrixErrors = [];
  let verticesOverFourInfluences = 0;
  let verticesZeroInfluence = 0;
  let verticesWithInvalidJoint = 0;
  let maxJointIndex = 0;
  const verticesByJoint = new Array(skinnedMesh.skeleton.bones.length).fill(0);
  for (let i = 0; i < skinWeight.count; i++) {
    let weightSum = 0;
    let influenceCount = 0;
    for (let j = 0; j < skinWeight.itemSize; j++) {
      const weight = skinWeight.getComponent(i, j);
      const joint = skinIndex.getComponent(i, j);
      maxJointIndex = Math.max(maxJointIndex, joint);
      weightSum += weight;
      if (weight > 1e-8) {
        influenceCount++;
        if (joint >= skinnedMesh.skeleton.bones.length) verticesWithInvalidJoint++;
        else verticesByJoint[joint]++;
      }
    }
    maxWeightSumError = Math.max(maxWeightSumError, Math.abs(weightSum - 1));
    if (influenceCount > 4) verticesOverFourInfluences++;
    if (influenceCount === 0) verticesZeroInfluence++;
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < skinnedMesh.skeleton.bones.length; i++) {
    const bone = skinnedMesh.skeleton.bones[i];
    const matrix = bone.matrixWorld.clone().multiply(skinnedMesh.skeleton.boneInverses[i]);
    const maxAbsIdentityError = Math.max(...matrix.elements.map((v, j) => Math.abs(v - identity[j])));
    boneRestMatrixErrors.push({ bone: bone.name, maxAbsIdentityError: +maxAbsIdentityError.toFixed(9), matrix: matrix.elements.map((v) => +v.toFixed(6)) });
  }
  return {
    maxWeightSumError: +maxWeightSumError.toFixed(9),
    verticesOverFourInfluences,
    verticesZeroInfluence,
    verticesWithInvalidJoint,
    maxJointIndex,
    maxBoneRestMatrixIdentityError: Math.max(...boneRestMatrixErrors.map((x) => x.maxAbsIdentityError)),
    largestBoneRestMatrixErrors: [...boneRestMatrixErrors].sort((a, b) => b.maxAbsIdentityError - a.maxAbsIdentityError).slice(0, 3),
    skeletonJointCount: skinnedMesh.skeleton.bones.length,
    verticesWithWeightPerJoint: Object.fromEntries(skinnedMesh.skeleton.bones.map((bone, i) => [bone.name, verticesByJoint[i]])),
  };
}

function compareSourceRestReference(reference, outputDirectory, skinnedMesh, position) {
  if (!reference) return null;
  const file = path.resolve(outputDirectory, reference.filename);
  const bytes = fs.readFileSync(file);
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const count = Math.floor(bytes.byteLength / 12);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const runtime = new Vector3();
  const errors = [];
  if (bytes.byteLength % 12 !== 0 || count !== position.count) {
    return { filename: reference.filename, sourceVertexCount: count, runtimeVertexCount: position.count, sourceSha256Matches: expectedHash === reference.sha256, perVertexIndexComparison: false, passed: false };
  }
  for (let i = 0; i < count; i++) {
    runtime.fromBufferAttribute(position, i);
    skinnedMesh.applyBoneTransform(i, runtime);
    skinnedMesh.localToWorld(runtime);
    const x = view.getFloat32(i * 12, true);
    const y = view.getFloat32(i * 12 + 4, true);
    const z = view.getFloat32(i * 12 + 8, true);
    errors.push(runtime.distanceTo(new Vector3(x, y, z)));
  }
  const ordered = [...errors].sort((a, b) => a - b);
  const p95 = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] ?? 0;
  const maxError = errors.reduce((max, value) => Math.max(max, value), 0);
  return {
    filename: reference.filename,
    sourceSha256Matches: expectedHash === reference.sha256,
    sourceVertexCount: count,
    runtimeVertexCount: position.count,
    perVertexIndexComparison: true,
    maxErrorSceneMeters: +maxError.toFixed(9),
    p95ErrorSceneMeters: +p95.toFixed(9),
    meanErrorSceneMeters: +(errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length)).toFixed(9),
    verticesWithin0_0001SceneMeters: errors.filter((value) => value <= 0.0001).length,
    passed: expectedHash === reference.sha256 && maxError <= 0.0001,
  };
}

function motionProbe(skinnedMesh, position, skinIndex, skinWeight, boneName) {
  const skeleton = skinnedMesh.skeleton;
  const boneIndex = skeleton.bones.findIndex((bone) => bone.name === boneName);
  if (boneIndex < 0) return { tested: false, reason: `Bone ${boneName} not found` };
  const affected = [];
  for (let i = 0; i < position.count; i++) {
    let weight = 0;
    for (let j = 0; j < skinWeight.itemSize; j++) {
      if (skinIndex.getComponent(i, j) === boneIndex) weight += skinWeight.getComponent(i, j);
    }
    if (weight > 1e-8) affected.push(i);
  }
  const original = skeleton.bones[boneIndex].quaternion.clone();
  skeleton.bones[boneIndex].updateWorldMatrix(true, true);
  skinnedMesh.updateWorldMatrix(true, false);
  skeleton.update();
  const base = new Map();
  const p = new Vector3();
  for (const i of affected) {
    p.fromBufferAttribute(position, i);
    skinnedMesh.applyBoneTransform(i, p);
    skinnedMesh.localToWorld(p);
    base.set(i, p.clone());
  }
  let best = { axis: null, maxAffectedDisplacementMeters: 0 };
  for (const [axisName, axis] of [['x', new Vector3(1, 0, 0)], ['y', new Vector3(0, 1, 0)], ['z', new Vector3(0, 0, 1)]]) {
    skeleton.bones[boneIndex].quaternion.copy(original).multiply(new Quaternion().setFromAxisAngle(axis, 0.1));
    skeleton.bones[boneIndex].updateWorldMatrix(true, true);
    skinnedMesh.updateWorldMatrix(true, false);
    skeleton.update();
    let max = 0;
    for (const i of affected) {
      p.fromBufferAttribute(position, i);
      skinnedMesh.applyBoneTransform(i, p);
      skinnedMesh.localToWorld(p);
      max = Math.max(max, p.distanceTo(base.get(i)));
    }
    if (max > best.maxAffectedDisplacementMeters) best = { axis: axisName, maxAffectedDisplacementMeters: +max.toFixed(9) };
  }
  skeleton.bones[boneIndex].quaternion.copy(original);
  skeleton.bones[boneIndex].updateWorldMatrix(true, true);
  skinnedMesh.updateWorldMatrix(true, false);
  skeleton.update();
  let restoreDrift = 0;
  for (const i of affected) {
    p.fromBufferAttribute(position, i);
    skinnedMesh.applyBoneTransform(i, p);
    skinnedMesh.localToWorld(p);
    restoreDrift = Math.max(restoreDrift, p.distanceTo(base.get(i)));
  }
  return {
    tested: true,
    bone: boneName,
    affectedVertexCount: affected.length,
    testRotationRadians: 0.1,
    bestAxis: best.axis,
    maxAffectedDisplacementMeters: best.maxAffectedDisplacementMeters,
    restoreWorldDriftMeters: +restoreDrift.toFixed(9),
  };
}

async function validateFile(file, manifest) {
  const absolute = path.resolve(file);
  const bytes = fs.readFileSync(absolute);
  const glbJson = readGlbJson(absolute);
  const primitiveAttributeNames = (glbJson.meshes ?? []).flatMap((mesh) => mesh.primitives.flatMap((primitive) => Object.keys(primitive.attributes ?? {})));
  const uniquePrimitiveAttributeNames = [...new Set(primitiveAttributeNames)].sort();
  const gltfSkinJointCount = glbJson.skins?.[0]?.joints?.length ?? null;
  const animationCount = glbJson.animations?.length ?? 0;
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(glbArrayBuffer(absolute), '', resolve, reject);
  });
  gltf.scene.updateMatrixWorld(true);
  const skinnedMeshes = [];
  gltf.scene.traverse((object) => { if (object.isSkinnedMesh) skinnedMeshes.push(object); });
  const meshes = [];
  for (const skinnedMesh of skinnedMeshes) {
    skinnedMesh.updateMatrixWorld(true);
    skinnedMesh.skeleton.update();
    const position = skinnedMesh.geometry.getAttribute('position');
    const skinIndex = skinnedMesh.geometry.getAttribute('skinIndex');
    const skinWeight = skinnedMesh.geometry.getAttribute('skinWeight');
    const index = skinnedMesh.geometry.index;
    const restMetrics = restBindMetrics(skinnedMesh, skinIndex, skinWeight);
    const runtimeBox = runtimeBounds(skinnedMesh, position);
    const probeBone = skinnedMesh.skeleton.bones.find((bone) => bone.name.endsWith('_index_proximal'));
    const probe = probeBone ? motionProbe(skinnedMesh, position, skinIndex, skinWeight, probeBone.name) : { tested: false, reason: 'No mapped index proximal bone' };
    const geometryBox = new Box3().setFromBufferAttribute(position);
    meshes.push({
      meshName: skinnedMesh.name,
      vertices: position.count,
      triangles: index ? index.count / 3 : Math.floor(position.count / 3),
      primitiveIndexCount: index?.count ?? null,
      geometryBoundsLocal: boxJSON(geometryBox),
      runtimeRestBoundsWorld: boxJSON(runtimeBox),
      skinAttributeItems: { joints: skinIndex?.itemSize ?? null, weights: skinWeight?.itemSize ?? null },
      boneNames: skinnedMesh.skeleton.bones.map((bone) => bone.name),
      roundTrip: restMetrics,
      articulationProbe: probe,
    });
  }
  const manifestRow = manifest?.outputs?.find((row) => row.filename === path.basename(absolute));
  const sourceBounds = manifestRow?.sourceEvaluatedGeometry?.aabbWorld ?? null;
  const scale = meshes.length === 1 ? scaleComparison(sourceBounds, meshes[0].runtimeRestBoundsWorld) : null;
  const sourceSurface = meshes.length === 1 ? compareSourceRestReference(manifestRow?.sourceEvaluatedGeometry?.aabbWorld?.restReference, path.dirname(absolute), skinnedMeshes[0], skinnedMeshes[0].geometry.getAttribute('position')) : null;
  const checks = {
    oneSkinnedMesh: skinnedMeshes.length === 1,
    skinAttributesPresent: meshes.every((m) => m.skinAttributeItems.joints === 4 && m.skinAttributeItems.weights === 4),
    allWeightsNormalized: meshes.every((m) => m.roundTrip.maxWeightSumError < 1e-5),
    noInvalidJointIndices: meshes.every((m) => m.roundTrip.verticesWithInvalidJoint === 0 && m.roundTrip.maxJointIndex < m.roundTrip.skeletonJointCount),
    fourOrFewerInfluences: meshes.every((m) => m.roundTrip.verticesOverFourInfluences === 0),
    glbHasExactlyOneFourJointWeightSet: uniquePrimitiveAttributeNames.includes('JOINTS_0') && uniquePrimitiveAttributeNames.includes('WEIGHTS_0') && !uniquePrimitiveAttributeNames.includes('JOINTS_1') && !uniquePrimitiveAttributeNames.includes('WEIGHTS_1'),
    gltfSkinJointCountMatchesRuntime: meshes.length === 1 && gltfSkinJointCount === meshes[0].roundTrip.skeletonJointCount,
    noAnimationsExported: animationCount === 0,
    noUnweightedVertices: meshes.every((m) => m.roundTrip.verticesZeroInfluence === 0),
    restBoneMatricesNearIdentity: meshes.every((m) => m.roundTrip.maxBoneRestMatrixIdentityError < 1e-4),
    sourceRestSurfaceMatchesByVertexWithin0_1mmSourceUnits: Boolean(sourceSurface?.passed),
    articulationChangesWeightedVertices: meshes.every((m) => m.articulationProbe.tested && m.articulationProbe.maxAffectedDisplacementMeters > 1e-6),
    articulationRestores: meshes.every((m) => m.articulationProbe.restoreWorldDriftMeters < 1e-6),
    scalePreservedWithin0_1Percent: Boolean(scale && Math.abs(scale.runtimeToSourceDiagonalRatio - 1) < 0.001),
    sortedScaleAxesWithin0_1mm: Boolean(scale && scale.maxSortedExtentDifferenceMeters < 0.0001),
  };
  const rootBounds = new Box3().setFromObject(gltf.scene);
  const report = {
    file: path.basename(absolute),
    absolutePath: absolute,
    bytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    gltfSceneName: gltf.scene.name,
    gltfSkinJointCount,
    gltfAnimationCount: animationCount,
    gltfPrimitiveAttributes: uniquePrimitiveAttributeNames,
    runtimeBoundsScene: boxJSON(rootBounds),
    scaleComparison: scale,
    sourceRestSurfaceComparison: sourceSurface,
    skinnedMeshCount: skinnedMeshes.length,
    meshes,
    checks,
    passed: Object.values(checks).every(Boolean),
    errors: [],
  };
  if (!report.passed) report.errors = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return report;
}

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('Usage: node validate_runtime.mjs <file.glb> [file.glb ...]');
const manifestPath = path.resolve(path.dirname(files[0]), 'candidate-manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const reports = [];
for (const file of files) {
  reports.push(await validateFile(file, manifest));
  const current = reports.at(-1);
  console.log(`${current.passed ? 'PASS' : 'FAIL'} ${current.file}: ${current.bytes} bytes; ${current.meshes[0]?.vertices ?? 0} verts / ${current.meshes[0]?.triangles ?? 0} tris; source REST vertex max ${current.sourceRestSurfaceComparison?.maxErrorSceneMeters ?? 'n/a'}; scale ${current.scaleComparison?.runtimeToSourceDiagonalRatio ?? 'n/a'}`);
}
const outputPath = path.resolve(path.dirname(files[0]), 'runtime-roundtrip.json');
fs.writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, runtime: 'three.js GLTFLoader', version: '0.186.1', reports }, null, 2)}\n`, 'utf8');
console.log(`RUNTIME_REPORT=${outputPath}`);
if (reports.some((report) => !report.passed)) process.exitCode = 1;
