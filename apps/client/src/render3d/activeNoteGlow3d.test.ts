import type { Note, PerformancePlan } from "@handthesia/contracts";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Keyboard3DView } from "./keyboard3dView";
import { FallingNotes3DView } from "./fallingNotes3dView";
import {
  ActiveNoteGlow3D,
  getActiveNoteGlowEnvelope,
  getActiveNoteGlowRearZ,
} from "./activeNoteGlow3d";

describe("active note glow", () => {
  it("follows shifted PerformancePlan timings and resets deterministically on seek or an empty plan", () => {
    const keyboard = new Keyboard3DView();
    const view = new FallingNotes3DView(keyboard);
    const notes: Note[] = [
      {
        noteId: "shifted-note",
        trackId: "t0",
        pitch: 60,
        startSeconds: 0.1,
        endSeconds: 2.0,
        velocity: 90,
        hand: "right",
        finger: 1,
        glissando: false,
      },
    ];
    const plan = {
      kind: "performance" as const,
      fingeringPlanId: "test-plan",
      events: [
        { type: "press" as const, noteId: "shifted-note", pitch: 60, timeSeconds: 0.5 },
        { type: "release" as const, noteId: "shifted-note", timeSeconds: 0.8 },
      ],
    } as unknown as PerformancePlan;

    try {
      view.setNotes(notes);
      view.setPerformancePlan(plan, notes);

      view.update(0.2);
      expect(view.getGlowSnapshot()).toEqual({ count: 0, noteIds: [] });
      view.update(0.5);
      expect(view.getGlowSnapshot()).toEqual({ count: 0, noteIds: [] });

      view.update(0.55);
      expect(view.getGlowSnapshot()).toEqual({ count: 1, noteIds: ["shifted-note"] });
      view.update(0.9);
      expect(view.getGlowSnapshot()).toEqual({ count: 0, noteIds: [] });

      // A backward seek reconstructs the same glow from transport time alone.
      view.update(0.55);
      expect(view.getGlowSnapshot()).toEqual({ count: 1, noteIds: ["shifted-note"] });

      view.setPerformancePlan({
        kind: "performance",
        fingeringPlanId: "empty-plan",
        events: [],
      } as unknown as PerformancePlan, notes);
      view.update(0.55);
      expect(view.getRenderedNoteTimings()).toHaveLength(0);
      expect(view.getGlowSnapshot()).toEqual({ count: 0, noteIds: [] });
    } finally {
      view.dispose();
      keyboard.dispose();
    }
  });

  it("uses a bounded attack and release and clips the trailing halo to its lane", () => {
    expect(getActiveNoteGlowEnvelope(1, 2, 0.99)).toBe(0);
    expect(getActiveNoteGlowEnvelope(1, 2, 1)).toBe(0);
    expect(getActiveNoteGlowEnvelope(1, 2, 1.045)).toBe(1);
    expect(getActiveNoteGlowEnvelope(1, 2, 1.5)).toBe(1);
    expect(getActiveNoteGlowEnvelope(1, 2, 1.99)).toBeGreaterThan(0);
    expect(getActiveNoteGlowEnvelope(1, 2, 2)).toBe(0);
    expect(getActiveNoteGlowEnvelope(1, 1, 1)).toBe(0);

    const rear = getActiveNoteGlowRearZ(-20, { rearZ: -8, strikeZ: -4 });
    expect(rear).toBe(-8);
    expect(getActiveNoteGlowRearZ(Number.NaN, { rearZ: -8, strikeZ: -4 })).toBeNull();
  });

  it("keeps a long halo flat and spans its requested world-Z interval", () => {
    const glow = new ActiveNoteGlow3D();
    const frontZ = -4;
    const rearZ = -20;
    const y = -0.005;
    const haloWidth = 0.6;

    try {
      glow.addNote("long-halo", 1.25, y, frontZ, rearZ, haloWidth, 0.5, 4, 1, true);
      glow.finishFrame();

      const instanceMatrix = new THREE.Matrix4();
      glow.mesh.getMatrixAt(0, instanceMatrix);
      const worldCorners = [
        new THREE.Vector3(-0.5, 0, -0.5),
        new THREE.Vector3(-0.5, 0, 0.5),
        new THREE.Vector3(0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, 0.5),
      ].map((corner) => corner.applyMatrix4(instanceMatrix));
      const bounds = new THREE.Box3().setFromPoints(worldCorners);

      expect(bounds.min.z).toBeCloseTo(rearZ);
      expect(bounds.max.z).toBeCloseTo(frontZ);
      expect(bounds.min.y).toBeCloseTo(y);
      expect(bounds.max.y).toBeCloseTo(y);
      expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(haloWidth);
    } finally {
      glow.mesh.geometry.dispose();
      (glow.mesh.material as THREE.Material).dispose();
    }
  });
});
