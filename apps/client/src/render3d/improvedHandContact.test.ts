import { describe, expect, it, vi } from "vitest";
import { Keyboard3DView } from "./keyboard3dView";
import {
  IMPROVED_HAND_CONTACT_RELEASE_SECONDS,
  computePenetrationOnlyCorrection,
  populateHandContactTargets,
  type ImprovedHandContactTarget,
} from "./improvedHandContact";

describe("improved hand contact floor", () => {
  it("targets the assigned finger only through the press and 120 ms release tail", () => {
    const sampler = vi.fn(() => 0);
    const targets: ImprovedHandContactTarget[] = [];
    const notes = [
      { pitch: 57, hand: "left" as const, finger: 2, startSeconds: 0.6, endSeconds: 0.9 },
      { pitch: 74, hand: "right" as const, finger: 4, startSeconds: 0.6, endSeconds: 1.1 },
      { pitch: 60, hand: "left" as const, finger: null, startSeconds: 0.6, endSeconds: 1.2 },
    ];

    populateHandContactTargets(notes, "left", 0.75, targets, sampler);
    expect(targets[1]).toMatchObject({ finger: 2, pitch: 57 });
    expect(targets[3]?.pitch).toBeNull();
    expect(targets[4]?.pitch).toBeNull();
    const initialObjects = [...targets];

    populateHandContactTargets(notes, "left", 0.9, targets, sampler);
    expect(targets).toEqual(initialObjects);
    expect(targets[1]?.pitch).toBe(57);

    populateHandContactTargets(
      notes,
      "left",
      0.9 + IMPROVED_HAND_CONTACT_RELEASE_SECONDS,
      targets,
      sampler,
    );
    expect(targets[1]?.pitch).toBeNull();
    expect(targets[3]?.pitch).toBeNull();
  });

  it("raises only penetrating support samples and ignores samples outside the key", () => {
    const points = [
      { x: 0, y: -0.31, z: 0 },
      { x: 1, y: -0.14, z: 0 },
      { x: 2, y: -0.22, z: 0 },
      { x: 3, y: 0.18, z: 0 },
    ];
    const correction = computePenetrationOnlyCorrection(57, points, (_pitch, x) =>
      x === 1 ? null : 0,
    );
    expect(correction).toBeCloseTo(0.31, 8);
    expect(computePenetrationOnlyCorrection(57, [{ x: 0, y: 0.1, z: 0 }], () => 0)).toBe(0);
    expect(computePenetrationOnlyCorrection(57, points, () => null)).toBe(0);
  });

  it("samples transformed white and black key tops and returns null off the key", () => {
    const keyboard = new Keyboard3DView();
    try {
      const white = keyboard.keysByPitch.get(57)!;
      const black = keyboard.keysByPitch.get(58)!;
      white.mesh.geometry.computeBoundingBox();
      black.mesh.geometry.computeBoundingBox();
      const whiteBounds = white.mesh.geometry.boundingBox;
      const blackBounds = black.mesh.geometry.boundingBox;
      expect(whiteBounds).not.toBeNull();
      expect(blackBounds).not.toBeNull();

      const whiteZ = white.pivotGroup.position.z + (whiteBounds!.min.z + whiteBounds!.max.z) * 0.5;
      const blackZ = black.pivotGroup.position.z + (blackBounds!.min.z + blackBounds!.max.z) * 0.5;
      const whiteRestY = keyboard.sampleKeySurfaceYAt(57, white.centerX, whiteZ);
      const blackRestY = keyboard.sampleKeySurfaceYAt(58, black.centerX, blackZ);
      expect(whiteRestY).not.toBeNull();
      expect(blackRestY).not.toBeNull();
      expect(blackRestY!).toBeGreaterThan(whiteRestY! + 0.2);

      keyboard.setActiveKeys([57, 58]);
      const whitePressedY = keyboard.sampleKeySurfaceYAt(57, white.centerX, whiteZ);
      const blackPressedY = keyboard.sampleKeySurfaceYAt(58, black.centerX, blackZ);
      expect(whitePressedY).not.toBeNull();
      expect(blackPressedY).not.toBeNull();
      expect(whitePressedY!).toBeLessThan(whiteRestY! - 0.08);
      expect(blackPressedY!).toBeLessThan(blackRestY! - 0.04);
      expect(keyboard.sampleKeySurfaceYAt(57, white.centerX + white.width * 2, whiteZ)).toBeNull();
    } finally {
      keyboard.dispose();
    }
  });
});
