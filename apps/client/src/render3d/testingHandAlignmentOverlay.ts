import * as THREE from "three";
import type { TestingBindAlignmentSnapshot } from "./testingHandBindAlignment";

/**
 * Testing ONLY: superimposes GLB-native bone origins (amber), WebXR bone
 * origins (cyan), and native palmar fingertip samples (green).
 *
 * Each corresponding native marker is parented to its WebXR bone using
 * the inverse bind matrix. Both endpoints therefore follow the SAME
 * actual WebXR rotation in every pose: their separation reveals rest-frame
 * registration error, not a fictitious independent anatomical animation.
 *
 * Deliberately never changes a pose, mesh, skin weight or source GLB.
 */
export class TestingHandAlignmentOverlay {
  private readonly geometry = new THREE.SphereGeometry(0.075, 8, 6);
  private readonly nativeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb24a, depthTest: false, depthWrite: false,
  });
  private readonly webxrMaterial = new THREE.MeshBasicMaterial({
    color: 0x3ce6ff, depthTest: false, depthWrite: false,
  });
  private readonly padMaterial = new THREE.MeshBasicMaterial({
    color: 0x62f38b, depthTest: false, depthWrite: false,
  });
  private readonly connectorMaterial = new THREE.LineBasicMaterial({
    color: 0xffe7a6, depthTest: false, depthWrite: false,
    transparent: true, opacity: 0.8,
  });
  private readonly boneMarkers: THREE.Object3D[] = [];
  private readonly connectors: THREE.Line[] = [];
  private readonly padGroup = new THREE.Group();
  private readonly padMarkers: Array<{
    vertexIds: readonly number[];
    mesh: THREE.Mesh;
  }> = [];
  private disposed = false;
  public readonly nativeJointCount: number;
  public readonly padCount: number;

  constructor(
    private readonly parent: THREE.Group,
    private readonly skinnedMesh: THREE.SkinnedMesh,
    bonesByName: ReadonlyMap<string, { bone: THREE.Bone }>,
    report: TestingBindAlignmentSnapshot,
  ) {
    const skeleton = skinnedMesh.skeleton;
    const scratchBone = new THREE.Vector3();
    for (const joint of report.joints) {
      const bone = bonesByName.get(joint.name)?.bone;
      if (!bone) continue;
      const index = skeleton.bones.indexOf(bone);
      if (index < 0) continue;

      const inverse = skeleton.boneInverses[index]!;
      const nativeLocal = new THREE.Vector3(...joint.nativeRestIn).applyMatrix4(inverse);
      const webxrLocal = new THREE.Vector3(...joint.webxrRestIn).applyMatrix4(inverse);

      const native = new THREE.Mesh(this.geometry, this.nativeMaterial);
      native.name = "Testing alignment native " + joint.name;
      native.position.copy(nativeLocal);
      native.renderOrder = 200;
      bone.add(native);
      this.boneMarkers.push(native);

      const webxr = new THREE.Mesh(this.geometry, this.webxrMaterial);
      webxr.name = "Testing alignment WebXR " + joint.name;
      webxr.position.copy(webxrLocal);
      webxr.renderOrder = 201;
      bone.add(webxr);
      this.boneMarkers.push(webxr);

      const connector = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([webxrLocal, nativeLocal]),
        this.connectorMaterial,
      );
      connector.name = "Testing alignment offset " + joint.name;
      connector.renderOrder = 199;
      bone.add(connector);
      this.connectors.push(connector);
    }
    scratchBone.set(0, 0, 0); // shared scratch remains deterministic across loads

    for (const pad of report.pads) {
      const marker = new THREE.Mesh(this.geometry, this.padMaterial);
      marker.name = "Testing alignment pad " + pad.prefix;
      marker.renderOrder = 202;
      this.padGroup.add(marker);
      this.padMarkers.push({ vertexIds: pad.vertexIds, mesh: marker });
    }
    this.padGroup.name = "Testing alignment palmar pads";
    this.parent.add(this.padGroup);
    this.nativeJointCount = this.boneMarkers.length / 2;
    this.padCount = this.padMarkers.length;
    this.update();
  }

  /** Current deformed palmar-pad centroid, never a bone-tip approximation. */
  public update(): void {
    if (this.disposed) return;
    this.parent.updateMatrixWorld(true);
    this.skinnedMesh.skeleton.update();
    const localFromWorld = this.parent.matrixWorld.clone().invert();
    const position = this.skinnedMesh.geometry.getAttribute("position");
    const vertex = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    for (const pad of this.padMarkers) {
      centroid.set(0, 0, 0);
      for (const id of pad.vertexIds) {
        vertex.fromBufferAttribute(position, id);
        this.skinnedMesh.applyBoneTransform(id, vertex);
        vertex.applyMatrix4(this.skinnedMesh.matrixWorld).applyMatrix4(localFromWorld);
        centroid.add(vertex);
      }
      if (pad.vertexIds.length) centroid.divideScalar(pad.vertexIds.length);
      pad.mesh.position.copy(centroid);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const obj of this.boneMarkers) obj.removeFromParent();
    for (const connector of this.connectors) {
      connector.removeFromParent();
      connector.geometry.dispose();
    }
    this.padGroup.removeFromParent();
    this.padGroup.clear();
    this.geometry.dispose();
    this.nativeMaterial.dispose();
    this.webxrMaterial.dispose();
    this.padMaterial.dispose();
    this.connectorMaterial.dispose();
  }
}
