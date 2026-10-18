import * as THREE from "three";
import type { GrandPianoLaneBounds } from "./grandPianoFootprint";

export const MAX_ACTIVE_NOTE_GLOW_INSTANCES = 2048;
export const ACTIVE_NOTE_GLOW_SIDE_SPREAD_IN = 0.18;
export const ACTIVE_NOTE_GLOW_REAR_SPREAD_IN = 0.24;

const ATTACK_SECONDS = 0.045;
const RELEASE_SECONDS = 0.075;
const GLOW_STRENGTH = 0.45;

/** A deterministic, transport-time envelope that is exactly zero outside the note interval. */
export function getActiveNoteGlowEnvelope(
  startSeconds: number,
  endSeconds: number,
  currentTime: number,
): number {
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    !Number.isFinite(currentTime) ||
    endSeconds <= startSeconds ||
    currentTime < startSeconds ||
    currentTime >= endSeconds
  ) {
    return 0;
  }

  const attackProgress = smoothstep01((currentTime - startSeconds) / ATTACK_SECONDS);
  const releaseProgress = smoothstep01((endSeconds - currentTime) / RELEASE_SECONDS);
  return Math.min(attackProgress, releaseProgress);
}

/** Extends only the note tail and keeps the full halo inside its wider piano lane. */
export function getActiveNoteGlowRearZ(
  noteRearZ: number,
  laneBounds: GrandPianoLaneBounds,
): number | null {
  if (!Number.isFinite(noteRearZ)) return null;
  const rearZ = Math.max(noteRearZ - ACTIVE_NOTE_GLOW_REAR_SPREAD_IN, laneBounds.rearZ);
  return rearZ < laneBounds.strikeZ ? rearZ : null;
}

function smoothstep01(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/**
 * A narrow, additive floor halo. The piano note itself occludes the center of
 * the plane, leaving a soft colored edge around the active block.
 */
export class ActiveNoteGlow3D {
  public readonly mesh: THREE.InstancedMesh;

  private readonly dummy = new THREE.Object3D();
  private readonly colorTmp = new THREE.Color();
  private readonly noteWidthRatios = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_ACTIVE_NOTE_GLOW_INSTANCES),
    1,
  );
  private readonly noteDepthRatios = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_ACTIVE_NOTE_GLOW_INSTANCES),
    1,
  );
  private readonly noteIds = new Array<string | undefined>(MAX_ACTIVE_NOTE_GLOW_INSTANCES);
  private count = 0;

  public constructor() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI * 0.5);
    geometry.setAttribute("noteWidthRatio", this.noteWidthRatios);
    geometry.setAttribute("noteDepthRatio", this.noteDepthRatios);

    const material = new THREE.ShaderMaterial({
      uniforms: { glowStrength: { value: GLOW_STRENGTH } },
      vertexShader: `
        attribute float noteWidthRatio;
        attribute float noteDepthRatio;
        varying vec2 vUv;
        varying vec3 vGlowColor;
        varying float vNoteWidthRatio;
        varying float vNoteDepthRatio;

        void main() {
          vUv = uv;
          vGlowColor = instanceColor;
          vNoteWidthRatio = noteWidthRatio;
          vNoteDepthRatio = noteDepthRatio;
          vec4 modelPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec4 viewPosition = viewMatrix * modelPosition;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform float glowStrength;
        varying vec2 vUv;
        varying vec3 vGlowColor;
        varying float vNoteWidthRatio;
        varying float vNoteDepthRatio;

        void main() {
          float sideDistance = max(0.0, abs(vUv.x * 2.0 - 1.0) - vNoteWidthRatio);
          float sideSpread = max(0.001, 1.0 - vNoteWidthRatio);
          float rearDistance = max(0.0, vUv.y - vNoteDepthRatio);
          float rearSpread = max(0.001, 1.0 - vNoteDepthRatio);
          float falloff = 1.0 - smoothstep(0.0, 1.0, length(vec2(
            sideDistance / sideSpread,
            rearDistance / rearSpread
          )));
          float alpha = falloff * glowStrength;
          gl_FragColor = vec4(vGlowColor, alpha);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      MAX_ACTIVE_NOTE_GLOW_INSTANCES,
    );
    this.mesh.name = "active-note-glow";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
    this.mesh.raycast = () => {};
    // Allocate the per-instance color buffer once, before any frame is drawn.
    this.mesh.setColorAt(0, this.colorTmp.setRGB(1, 1, 1));
  }

  public beginFrame(): void {
    this.count = 0;
  }

  public addNote(
    noteId: string,
    centerX: number,
    y: number,
    frontZ: number,
    rearZ: number,
    haloWidth: number,
    noteWidth: number,
    noteLength: number,
    envelope: number,
    isLeft: boolean,
  ): void {
    if (this.count >= MAX_ACTIVE_NOTE_GLOW_INSTANCES || envelope <= 0) return;
    const haloLength = frontZ - rearZ;
    if (
      !Number.isFinite(haloLength) ||
      haloLength <= 0 ||
      !Number.isFinite(haloWidth) ||
      haloWidth <= 0
    ) {
      return;
    }

    const index = this.count;
    this.dummy.position.set(centerX, y, (frontZ + rearZ) * 0.5);
    this.dummy.scale.set(haloWidth, 1, haloLength);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);

    this.colorTmp.setHex(isLeft ? 0x60a5fa : 0x34d399);
    this.colorTmp.multiplyScalar(envelope);
    this.mesh.setColorAt(index, this.colorTmp);
    this.noteWidthRatios.setX(index, Math.min(1, noteWidth / haloWidth));
    this.noteDepthRatios.setX(index, Math.min(1, noteLength / haloLength));
    this.noteIds[index] = noteId;
    this.count += 1;
  }

  public finishFrame(): void {
    this.mesh.count = this.count;
    if (this.count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.noteWidthRatios.needsUpdate = true;
    this.noteDepthRatios.needsUpdate = true;
  }

  public getSnapshot(): { count: number; noteIds: readonly string[] } {
    return {
      count: this.count,
      noteIds: this.noteIds.slice(0, this.count) as string[],
    };
  }
}
