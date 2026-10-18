import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Note } from "@handthesia/contracts";
import { FallingNotes3DView } from "./fallingNotes3dView";
import { Keyboard3DView, WHITE_KEY_LEN_IN } from "./keyboard3dView";
import {
  clipGrandPianoNoteDepth,
  getGrandPianoLaneBounds,
  GRAND_PIANO_HIGHWAY_LENGTH_IN,
  GRAND_PIANO_INTERIOR_CONTOUR,
  isInsideGrandPianoFootprint,
} from "./grandPianoFootprint";

function getMeshVerticesInWorld(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateMatrixWorld(true);
  const positions = mesh.geometry.getAttribute("position");
  return Array.from({ length: positions.count }, (_, index) =>
    mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, index)),
  );
}

describe("3D grand piano footprint", () => {
  it("uses one curved interior contour for the cavity floor and note deck", () => {
    const keyboard = new Keyboard3DView();
    const notes = new FallingNotes3DView(keyboard);
    const floor = keyboard.group.getObjectByName("grand-piano-cavity-floor") as THREE.Mesh;
    const deck = notes.group.getObjectByName("grand-piano-highway-deck") as THREE.Mesh;
    const rim = keyboard.group.getObjectByName("grand-piano-rim") as THREE.Mesh;

    expect(floor).toBeDefined();
    expect(deck).toBeDefined();
    expect(rim).toBeDefined();
    expect(GRAND_PIANO_INTERIOR_CONTOUR.length).toBeGreaterThan(128);

    const floorPositions = floor.geometry.getAttribute("position");
    const deckPositions = deck.geometry.getAttribute("position");
    expect(deckPositions.count).toBe(floorPositions.count);
    for (let i = 0; i < floorPositions.count; i += 1) {
      expect(deckPositions.getX(i)).toBeCloseTo(floorPositions.getX(i), 6);
      expect(deckPositions.getY(i)).toBeCloseTo(floorPositions.getY(i), 6);
      expect(deckPositions.getZ(i)).toBeCloseTo(floorPositions.getZ(i), 6);
    }

    const deckNormals = deck.geometry.getAttribute("normal");
    for (let i = 0; i < deckNormals.count; i += 1) {
      expect(deckNormals.getY(i)).toBeGreaterThan(0.99);
    }

    const worldVertices = getMeshVerticesInWorld(deck);
    for (const [index, vertex] of worldVertices.entries()) {
      expect(
        isInsideGrandPianoFootprint(vertex.x, vertex.z),
        `deck vertex ${index} at (${vertex.x}, ${vertex.z})`,
      ).toBe(true);
    }

    // The middle of the open cavity and the far tail are covered; the point beyond
    // the right bentside remains outside the shared contour.
    expect(isInsideGrandPianoFootprint(0, -20)).toBe(true);
    expect(isInsideGrandPianoFootprint(-8, -41)).toBe(true);
    expect(isInsideGrandPianoFootprint(25, -20)).toBe(false);
    expect(isInsideGrandPianoFootprint(0, -50)).toBe(false);

    notes.dispose();
    keyboard.dispose();
  });

  it("keeps all 88 full-width note lanes inside the curved rim while clipping their rear ends", () => {
    const keyboard = new Keyboard3DView();
    const strikeZ = -WHITE_KEY_LEN_IN;

    for (const [pitch, key] of keyboard.keysByPitch) {
      const width = key.width * (key.isBlack ? 0.88 : 0.82);
      const lane = getGrandPianoLaneBounds(key.centerX, width);
      expect(lane, `pitch ${pitch} should reach its strike plane`).not.toBeNull();
      expect(lane!.strikeZ).toBeCloseTo(strikeZ, 6);

      const clipped = clipGrandPianoNoteDepth(
        strikeZ,
        GRAND_PIANO_HIGHWAY_LENGTH_IN + 1,
        lane!,
      );
      expect(clipped, `pitch ${pitch} should retain a visible note at strike`).not.toBeNull();
      expect(clipped!.frontZ).toBeCloseTo(strikeZ, 6);
      expect(clipped!.rearZ).toBeCloseTo(lane!.rearZ, 6);
      expect(clipGrandPianoNoteDepth(lane!.rearZ - 0.1, 1, lane!)).toBeNull();

      const left = key.centerX - width * 0.5 + 0.0001;
      const right = key.centerX + width * 0.5 - 0.0001;
      for (let xIndex = 0; xIndex <= 8; xIndex += 1) {
        const x = left + ((right - left) * xIndex) / 8;
        for (let zIndex = 0; zIndex <= 16; zIndex += 1) {
          const z =
            clipped!.rearZ +
            0.0001 +
            ((clipped!.frontZ - clipped!.rearZ - 0.0002) * zIndex) / 16;
          expect(isInsideGrandPianoFootprint(x, z), `pitch ${pitch}, x=${x}, z=${z}`).toBe(true);
        }
      }
    }

    keyboard.dispose();
  });

  it("keeps the C8 strike edge fixed while the far end stops at its curved treble boundary", () => {
    const keyboard = new Keyboard3DView();
    const notes = new FallingNotes3DView(keyboard);
    const pitch = 108;
    const key = keyboard.keysByPitch.get(pitch)!;
    const lane = getGrandPianoLaneBounds(key.centerX, key.width * 0.82)!;
    const c8: Note = {
      noteId: "c8-long",
      trackId: "t0",
      pitch,
      startSeconds: 0,
      endSeconds: 100,
      velocity: 96,
      hand: "right",
      finger: null,
      glissando: false,
    };

    notes.setNotes([c8]);
    notes.update(0);
    expect(notes.instancedMesh.count).toBe(1);

    const matrix = new THREE.Matrix4();
    notes.instancedMesh.getMatrixAt(0, matrix);
    notes.instancedMesh.geometry.computeBoundingBox();
    const box = notes.instancedMesh.geometry.boundingBox!.clone();
    box.applyMatrix4(matrix);
    expect(box.max.z).toBeCloseTo(-WHITE_KEY_LEN_IN, 5);
    expect(box.min.z).toBeCloseTo(lane.rearZ, 5);
    expect(box.max.x).toBeLessThanOrEqual(
      Math.max(...GRAND_PIANO_INTERIOR_CONTOUR.map((point) => point.x)) + 1e-4,
    );
    expect(box.max.x).toBeLessThanOrEqual(key.centerX + key.width * 0.82 * 0.5 + 1e-4);

    notes.dispose();
    keyboard.dispose();
  });
});
