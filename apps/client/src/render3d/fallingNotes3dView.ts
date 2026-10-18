import type { Note, PerformancePlan } from "@handthesia/contracts";
import * as THREE from "three";
import { KEYBOARD_WIDTH_IN } from "./handRigBuilder";
import {
  ACTIVE_NOTE_GLOW_SIDE_SPREAD_IN,
  ActiveNoteGlow3D,
  getActiveNoteGlowEnvelope,
  getActiveNoteGlowRearZ,
  MAX_ACTIVE_NOTE_GLOW_INSTANCES,
} from "./activeNoteGlow3d";
import {
  clipGrandPianoNoteDepth,
  createGrandPianoInteriorShape,
  getGrandPianoLaneBounds,
  GRAND_PIANO_HIGHWAY_LENGTH_IN,
  type GrandPianoLaneBounds,
} from "./grandPianoFootprint";
import {
  disposeOwnedThreeResources,
  type Keyboard3DView,
  WHITE_KEY_LEN_IN,
} from "./keyboard3dView";

const MAX_VISIBLE_NOTES = MAX_ACTIVE_NOTE_GLOW_INSTANCES;
const HIGHWAY_LENGTH_IN = GRAND_PIANO_HIGHWAY_LENGTH_IN;
const DEFAULT_INCHES_PER_SECOND = 5.5;

/** A start-sorted interval index for score notes queried on every rendered frame. */
export class NoteTimeIndex {
  private notes: Note[] = [];
  private prefixMaxEndSeconds: number[] = [];

  public setNotes(notes: readonly Note[]): void {
    this.notes = [...notes].sort((a, b) => a.startSeconds - b.startSeconds);
    this.prefixMaxEndSeconds = [];
    let maxEnd = Number.NEGATIVE_INFINITY;
    for (const note of this.notes) {
      maxEnd = Math.max(maxEnd, note.endSeconds);
      this.prefixMaxEndSeconds.push(maxEnd);
    }
  }

  public forEachOverlapping(
    startSeconds: number,
    endSeconds: number,
    visit: (note: Note) => void,
  ): void {
    let low = 0;
    let high = this.prefixMaxEndSeconds.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.prefixMaxEndSeconds[mid]! >= startSeconds) high = mid;
      else low = mid + 1;
    }

    for (let i = low; i < this.notes.length; i += 1) {
      const note = this.notes[i]!;
      if (note.startSeconds > endSeconds) break;
      if (note.endSeconds >= startSeconds) visit(note);
    }
  }
}

export class FallingNotes3DView {
  public readonly group = new THREE.Group();
  private readonly noteIndex = new NoteTimeIndex();
  private inchesPerSecond = DEFAULT_INCHES_PER_SECOND;
  public readonly instancedMesh: THREE.InstancedMesh;
  private readonly noteMaterial: THREE.MeshPhysicalMaterial;
  private readonly activeNoteGlow: ActiveNoteGlow3D;
  private readonly dummy = new THREE.Object3D();
  private readonly colorTmp = new THREE.Color();
  private readonly laneBoundsByPitch = new Map<number, ReturnType<typeof getGrandPianoLaneBounds>>();
  private readonly activeGlowLaneByPitch = new Map<
    number,
    { bounds: GrandPianoLaneBounds; width: number }
  >();

  public constructor(private readonly keyboard3D: Keyboard3DView) {
    this.buildHighwayDeck();
    for (const [pitch, keyEntry] of keyboard3D.keysByPitch) {
      const noteWidth = keyEntry.isBlack ? keyEntry.width * 0.88 : keyEntry.width * 0.82;
      this.laneBoundsByPitch.set(
        pitch,
        getGrandPianoLaneBounds(keyEntry.centerX, noteWidth),
      );

      let haloWidth = noteWidth + ACTIVE_NOTE_GLOW_SIDE_SPREAD_IN * 2;
      let haloBounds = getGrandPianoLaneBounds(keyEntry.centerX, haloWidth);
      while (!haloBounds && haloWidth > noteWidth) {
        haloWidth = Math.max(noteWidth, haloWidth - 0.02);
        haloBounds = getGrandPianoLaneBounds(keyEntry.centerX, haloWidth);
      }
      if (haloBounds) this.activeGlowLaneByPitch.set(pitch, { bounds: haloBounds, width: haloWidth });
    }

    const boxGeo = new THREE.BoxGeometry(1, 0.24, 1);
    boxGeo.translate(0, 0.12, 0);

    // Encompassing highway bounds so shadow/lighting and spatial queries cover the full range
    const highwayCenter = new THREE.Vector3(0, 1, -WHITE_KEY_LEN_IN - HIGHWAY_LENGTH_IN * 0.5);
    const highwayRadius = Math.hypot(KEYBOARD_WIDTH_IN * 0.5, HIGHWAY_LENGTH_IN * 0.5, 2);
    boxGeo.boundingSphere = new THREE.Sphere(highwayCenter, highwayRadius);
    boxGeo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-KEYBOARD_WIDTH_IN * 0.5 - 2, 0, -WHITE_KEY_LEN_IN - HIGHWAY_LENGTH_IN - 2),
      new THREE.Vector3(KEYBOARD_WIDTH_IN * 0.5 + 2, 3, -WHITE_KEY_LEN_IN + 2),
    );

    this.noteMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0.08,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    });

    this.instancedMesh = new THREE.InstancedMesh(boxGeo, this.noteMaterial, MAX_VISIBLE_NOTES);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.castShadow = true;
    this.instancedMesh.receiveShadow = true;
    // Notes are dynamically placed across the highway by CPU time-window queries.
    // Setting frustumCulled to false prevents Three.js from culling all notes when the local origin (0,0,0) leaves the camera frustum.
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.count = 0;
    this.group.add(this.instancedMesh);

    this.activeNoteGlow = new ActiveNoteGlow3D();
    this.group.add(this.activeNoteGlow.mesh);
  }

  private buildHighwayDeck(): void {
    const deckGeo = new THREE.ShapeGeometry(createGrandPianoInteriorShape());
    deckGeo.rotateX(-Math.PI * 0.5);
    const deckMat = new THREE.MeshPhysicalMaterial({
      color: 0x090b10,
      roughness: 0.76,
      metalness: 0.02,
      clearcoat: 0.06,
      clearcoatRoughness: 0.78,
      envMapIntensity: 0.3,
      transparent: true,
      opacity: 0.88,
    });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.name = "grand-piano-highway-deck";
    deck.position.set(0, -0.015, 0);
    deck.receiveShadow = true;
    deck.frustumCulled = false;
    this.group.add(deck);
  }

  private sourceNotes: Note[] = [];
  private performancePlan: PerformancePlan | null = null;
  private renderedNotes: Note[] = [];

  public setNotes(notes: Note[]): void {
    this.sourceNotes = [...notes];
    this.rebuildRenderedNotes();
  }

  public setPerformancePlan(plan: PerformancePlan | null, sourceNotes?: Note[]): void {
    if (sourceNotes) this.sourceNotes = [...sourceNotes];
    this.performancePlan = plan;
    this.rebuildRenderedNotes();
  }

  public getRenderedNoteTimings(): readonly Note[] {
    return this.renderedNotes;
  }

  public getGlowSnapshot(): { count: number; noteIds: readonly string[] } {
    return this.activeNoteGlow.getSnapshot();
  }

  private rebuildRenderedNotes(): void {
    const sourceById = new Map(this.sourceNotes.map((note) => [note.noteId, note]));
    if (!this.performancePlan) {
      this.renderedNotes = [...this.sourceNotes];
      this.noteIndex.setNotes(this.renderedNotes);
      return;
    }

    const presses = new Map<string, Extract<PerformancePlan["events"][number], { type: "press" }>>();
    const releases = new Map<string, number>();
    for (const event of this.performancePlan.events) {
      if (event.type === "press") presses.set(event.noteId, event);
      else if (event.type === "release") releases.set(event.noteId, event.timeSeconds);
    }

    this.renderedNotes = [];
    for (const [noteId, press] of presses) {
      const endSeconds = releases.get(noteId);
      if (endSeconds === undefined || endSeconds <= press.timeSeconds) continue;
      const sourceNote = sourceById.get(noteId) ?? null;
      this.renderedNotes.push({
        noteId,
        trackId: sourceNote?.trackId ?? "t0",
        pitch: press.pitch,
        velocity: press.velocity ?? sourceNote?.velocity ?? 90,
        startSeconds: press.timeSeconds,
        endSeconds,
        hand: sourceNote?.hand ?? (press.pitch < 60 ? "left" : "right"),
        finger: sourceNote?.finger ?? null,
        glissando: sourceNote?.glissando ?? false,
      });
    }
    this.noteIndex.setNotes(this.renderedNotes);
  }

  public setPixelsPerSecond(pps: number): void {
    // Scale 2D pixelsPerSecond (~200) into 3D inchesPerSecond (~5.5)
    this.inchesPerSecond = Math.max(2.0, (pps / 200) * DEFAULT_INCHES_PER_SECOND);
  }

  public update(currentTime: number): void {
    const strikeZ = -WHITE_KEY_LEN_IN;
    const maxTimeAhead = HIGHWAY_LENGTH_IN / this.inchesPerSecond;
    let instanceIdx = 0;
    this.activeNoteGlow.beginFrame();

    this.noteIndex.forEachOverlapping(currentTime, currentTime + maxTimeAhead, (note) => {
      if (instanceIdx >= MAX_VISIBLE_NOTES) return;
      const endSeconds = note.endSeconds;
      const keyEntry = this.keyboard3D.keysByPitch.get(note.pitch);
      const laneBounds = this.laneBoundsByPitch.get(note.pitch);
      if (!keyEntry || !laneBounds) return;

      const clampedStart = Math.max(currentTime, note.startSeconds);
      const clampedEnd = Math.min(currentTime + maxTimeAhead, endSeconds);
      const lenIn = Math.max(0.14, (clampedEnd - clampedStart) * this.inchesPerSecond);
      const distAheadIn = (clampedStart - currentTime) * this.inchesPerSecond;
      const frontZ = strikeZ - distAheadIn;
      const clippedDepth = clipGrandPianoNoteDepth(frontZ, lenIn, laneBounds);
      if (!clippedDepth) return;
      const width = keyEntry.isBlack ? keyEntry.width * 0.88 : keyEntry.width * 0.82;
      const yBase = keyEntry.isBlack ? 0.16 : 0.02;

      this.dummy.position.set(
        keyEntry.centerX,
        yBase,
        (clippedDepth.frontZ + clippedDepth.rearZ) * 0.5,
      );
      this.dummy.scale.set(width, keyEntry.isBlack ? 1.15 : 1.0, clippedDepth.length);
      this.dummy.updateMatrix();
      this.instancedMesh.setMatrixAt(instanceIdx, this.dummy.matrix);

      const isActive = note.startSeconds <= currentTime && endSeconds > currentTime;
      const isLeft = note.hand === "left";
      const glowEnvelope = getActiveNoteGlowEnvelope(
        note.startSeconds,
        endSeconds,
        currentTime,
      );
      if (isLeft) {
        this.colorTmp.setHex(isActive ? 0x60a5fa : 0x3b82f6);
      } else {
        this.colorTmp.setHex(isActive ? 0x34d399 : 0x10b981);
      }
      this.instancedMesh.setColorAt(instanceIdx, this.colorTmp);

      const glowLane = this.activeGlowLaneByPitch.get(note.pitch);
      if (glowEnvelope > 0 && glowLane) {
        const glowRearZ = getActiveNoteGlowRearZ(clippedDepth.rearZ, glowLane.bounds);
        if (glowRearZ !== null) {
          this.activeNoteGlow.addNote(
            note.noteId,
            keyEntry.centerX,
            -0.005,
            clippedDepth.frontZ,
            glowRearZ,
            glowLane.width,
            width,
            clippedDepth.length,
            glowEnvelope,
            isLeft,
          );
        }
      }
      instanceIdx++;
    });

    this.activeNoteGlow.finishFrame();
    this.instancedMesh.count = instanceIdx;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  public dispose(): void {
    disposeOwnedThreeResources(this.group);
  }
}
