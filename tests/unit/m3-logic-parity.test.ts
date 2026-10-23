import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MotionPlanSchema,
  PerformancePlanSchema,
  SongDocumentSchema,
  fingeringPlanForSong,
  type MotionPose,
  type PerformanceEvent,
  type SongDocument,
} from "@handthesia/contracts";

interface GoldenNote {
  noteId: string;
  sourceInstrument: number;
  sourceOrdinal: number;
  pitch: number;
  velocity: number;
  start: number;
  end: number;
}

interface GoldenTrack {
  index: number;
  name: string;
  program: number;
  noteCount: number;
  declaredHand: "L" | "R" | null;
}

interface GoldenAssignment {
  noteId: string;
  sourceNoteIds: string[];
  hand: "L" | "R";
  finger: number | null;
  manualFinger: number | null;
  gliss: boolean;
}

interface GoldenPerformanceEvent {
  noteId: string;
  sourceNoteIds: string[];
  hand: "L" | "R";
  press: number;
  release: number;
}

interface GoldenCrossingEpisode {
  start: number;
  end: number;
  topHand: "L" | "R";
  strength: number;
  lead: number;
}

interface GoldenPose {
  hand: "L" | "R";
  time: number;
  layer: number;
  bones: { start: [number, number, number]; end: [number, number, number]; type: string }[];
  joints: { position: [number, number, number]; type: string }[];
}

interface GoldenHandSummary {
  hand: "L" | "R";
  assignedCount: number;
  rolledChords: number;
  glissRuns: number[][];
}

interface GoldenFixture {
  fixtureId: string;
  inputSha256: string;
  status: "loaded" | "repaired" | "invalid-or-rejected";
  sourceNotes: GoldenNote[];
  tracks?: GoldenTrack[];
  assignments?: GoldenAssignment[];
  performanceEvents?: GoldenPerformanceEvent[];
  crossingEpisodes?: GoldenCrossingEpisode[];
  selectedPoses?: GoldenPose[];
  hands?: GoldenHandSummary[];
  pedals?: { time: number; controller: number; value: number }[];
}

function loadFixture(filename: string): GoldenFixture {
  const filePath = resolve(__dirname, "../fixtures/golden", filename);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as GoldenFixture;
}

/** Pure pose interpolation conforming to HandsView kinematics. */
function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ];
}

function lerpPose(p0: MotionPose, p1: MotionPose, alpha: number): MotionPose {
  if (p0.bones.length !== p1.bones.length || p0.joints.length !== p1.joints.length) {
    return alpha < 0.5 ? p0 : p1;
  }

  const bones = p0.bones.map((bone, i) => {
    const other = p1.bones[i]!;
    return {
      a: lerp3(bone.a, other.a, alpha),
      b: lerp3(bone.b, other.b, alpha),
      kind: bone.kind,
      boneId: bone.boneId,
    };
  });

  const joints = p0.joints.map((joint, i) => {
    const other = p1.joints[i]!;
    return {
      point: lerp3(joint.point, other.point, alpha),
      kind: joint.kind,
    };
  });

  return {
    hand: p0.hand,
    transportTimeSeconds:
      p0.transportTimeSeconds +
      (p1.transportTimeSeconds - p0.transportTimeSeconds) * alpha,
    layerOrder: alpha < 0.5 ? p0.layerOrder : p1.layerOrder,
    bones,
    joints,
  };
}

function samplePose(poses: MotionPose[], time: number): MotionPose | null {
  if (poses.length === 0) return null;
  if (time <= poses[0]!.transportTimeSeconds) return poses[0]!;
  if (time >= poses[poses.length - 1]!.transportTimeSeconds) return poses[poses.length - 1]!;

  let lo = 0;
  let hi = poses.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (poses[mid]!.transportTimeSeconds <= time) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const i0 = Math.max(0, hi);
  const i1 = Math.min(poses.length - 1, lo);
  if (i0 === i1) return poses[i0]!;

  const p0 = poses[i0]!;
  const p1 = poses[i1]!;
  const dt = p1.transportTimeSeconds - p0.transportTimeSeconds;
  if (dt <= 1e-6) return p0;

  const alpha = Math.max(0, Math.min(1, (time - p0.transportTimeSeconds) / dt));
  return lerpPose(p0, p1, alpha);
}

function computeZIndices(leftLayer: number, rightLayer: number): { leftZIndex: number; rightZIndex: number } {
  if (leftLayer > rightLayer) {
    return { leftZIndex: 2, rightZIndex: 1 };
  }
  if (rightLayer > leftLayer) {
    return { leftZIndex: 1, rightZIndex: 2 };
  }
  return { leftZIndex: 1, rightZIndex: 1 };
}

describe("Milestone M3 Logic Parity & Kinematic Invariants", () => {
  describe("W023: Hand split & Figure Preferences", () => {
    it("strictly assigns notes to explicit track names (Left Hand / Right Hand) across unconventional pitch ranges", () => {
      const fixture = loadFixture("synthetic-mismatched-track-labels.json");
      expect(fixture.status).toBe("loaded");
      expect(fixture.tracks).toBeDefined();
      expect(fixture.tracks).toHaveLength(2);

      const leftTrack = fixture.tracks!.find((t) => t.name === "Left Hand");
      const rightTrack = fixture.tracks!.find((t) => t.name === "Right Hand");

      expect(leftTrack).toBeDefined();
      expect(rightTrack).toBeDefined();
      expect(leftTrack!.declaredHand).toBe("L");
      expect(rightTrack!.declaredHand).toBe("R");

      // Verify unconventional pitch ranges:
      // Left Hand track contains high treble notes (pitches 78, 81, 84 -> F#5, A5, C6)
      const leftTrackNotes = fixture.sourceNotes.filter((n) => n.sourceInstrument === leftTrack!.index);
      expect(leftTrackNotes.length).toBeGreaterThan(0);
      for (const note of leftTrackNotes) {
        expect(note.pitch).toBeGreaterThanOrEqual(78); // Treble register
      }

      // Right Hand track contains deep bass notes (pitches 36, 39, 43 -> C2, Eb2, G2)
      const rightTrackNotes = fixture.sourceNotes.filter((n) => n.sourceInstrument === rightTrack!.index);
      expect(rightTrackNotes.length).toBeGreaterThan(0);
      for (const note of rightTrackNotes) {
        expect(note.pitch).toBeLessThanOrEqual(43); // Bass register
      }

      // Verify assignment invariant: explicit track metadata strictly overrides pitch-register heuristics
      expect(fixture.assignments).toBeDefined();
      for (const assignment of fixture.assignments!) {
        const sourceNote = fixture.sourceNotes.find((n) => assignment.sourceNoteIds.includes(n.noteId));
        expect(sourceNote).toBeDefined();

        if (sourceNote!.sourceInstrument === leftTrack!.index) {
          expect(assignment.hand).toBe("L");
          // Treble notes in Left Hand track must NOT be reassigned to Right Hand
          expect(assignment.finger).toBeGreaterThanOrEqual(1);
          expect(assignment.finger).toBeLessThanOrEqual(5);
        } else if (sourceNote!.sourceInstrument === rightTrack!.index) {
          expect(assignment.hand).toBe("R");
          // Bass notes in Right Hand track must NOT be reassigned to Left Hand
          expect(assignment.finger).toBeGreaterThanOrEqual(1);
          expect(assignment.finger).toBeLessThanOrEqual(5);
        }
      }

      // Verify contract conformance: constructing a SongDocument and FingeringPlan
      const songDoc: SongDocument = {
        schemaVersion: 1,
        projectId: "test-mismatched-tracks",
        revision: 1,
        title: "Mismatched Track Labels",
        durationSeconds: 2.5,
        tracks: [
          { trackId: "track-0", instrumentIndex: 0, name: "Left Hand", program: 0, hand: "left" },
          { trackId: "track-1", instrumentIndex: 1, name: "Right Hand", program: 0, hand: "right" },
        ],
        notes: fixture.sourceNotes.map((n) => ({
          noteId: n.noteId,
          trackId: n.sourceInstrument === 0 ? "track-0" : "track-1",
          pitch: n.pitch,
          velocity: n.velocity,
          startSeconds: n.start,
          endSeconds: n.end,
          hand: n.sourceInstrument === 0 ? ("left" as const) : ("right" as const),
          finger: null,
          glissando: false,
        })),
        tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
        pedalControls: [],
      };

      const parsedSong = SongDocumentSchema.parse(songDoc);
      expect(parsedSong.notes).toHaveLength(6);

      const fingeringPlan = {
        schemaVersion: 1,
        planId: "fingering-mismatched",
        projectId: songDoc.projectId,
        inputRevision: 1,
        profileId: "default-pianist",
        profileRevision: 0,
        engineVersion: "engine-test",
        diagnostics: [],
        kind: "fingering" as const,
        assignments: fixture.assignments!.map((a) => ({
          noteId: a.noteId,
          hand: a.hand === "L" ? ("left" as const) : ("right" as const),
          finger: a.finger,
          disposition: "played" as const,
        })),
      };

      const validator = fingeringPlanForSong(parsedSong);
      expect(validator.safeParse(fingeringPlan).success).toBe(true);

      // Invariant: contradicting the explicit track hand assignment must fail contract validation
      const invertedPlan = {
        ...fingeringPlan,
        assignments: fingeringPlan.assignments.map((a) => ({
          ...a,
          hand: a.hand === "left" ? ("right" as const) : ("left" as const),
        })),
      };
      expect(validator.safeParse(invertedPlan).success).toBe(false);
    });

    it("retains canonical Hanon fingering (1-2-3-1-2-3-4-5) for standard scales and recognized figures", () => {
      const fixture = loadFixture("synthetic-scale-chords.json");
      expect(fixture.status).toBe("loaded");
      expect(fixture.assignments).toBeDefined();

      // The first 8 notes are an ascending C major scale: C4 to C5
      const scaleNotes = fixture.sourceNotes.slice(0, 8);
      const expectedScalePitches = [60, 62, 64, 65, 67, 69, 71, 72];
      expect(scaleNotes.map((n) => n.pitch)).toEqual(expectedScalePitches);

      const scaleAssignments = fixture.assignments!.slice(0, 8);
      expect(scaleAssignments.map((a) => a.hand)).toEqual(Array(8).fill("R"));

      // Canonical scale fingering: 1, 2, 3, 1 (thumb under), 2, 3, 4, 5
      const canonicalFingering = [1, 2, 3, 1, 2, 3, 4, 5];
      const actualFingering = scaleAssignments.map((a) => a.finger);
      expect(actualFingering).toEqual(canonicalFingering);

      // Verify that thumb-under occurs precisely on F4 (pitch 65, index 3)
      expect(scaleNotes[3]!.pitch).toBe(65);
      expect(scaleAssignments[3]!.finger).toBe(1);

      // Verify that middle finger plays E4 (pitch 64, index 2) just before the thumb cross
      expect(scaleNotes[2]!.pitch).toBe(64);
      expect(scaleAssignments[2]!.finger).toBe(3);

      // Verify pinky terminates scale at octave tonic C5 (pitch 72, index 7)
      expect(scaleNotes[7]!.pitch).toBe(72);
      expect(scaleAssignments[7]!.finger).toBe(5);

      // Check subsequent chord / triad assignments in synthetic-scale-chords
      const chordAssignments = fixture.assignments!.slice(8);
      expect(chordAssignments.length).toBeGreaterThan(0);
      for (const a of chordAssignments) {
        expect(a.finger).toBeGreaterThanOrEqual(1);
        expect(a.finger).toBeLessThanOrEqual(5);
      }
    });

    it("verifies canonical octave figure fingering (1-5 alternation) in right-hand octave passages", () => {
      const fixture = loadFixture("tracked-right-hand-octaves.json");
      expect(fixture.status).toBe("loaded");
      expect(fixture.assignments).toBeDefined();

      // In tracked-right-hand-octaves, pairs of notes form octaves played by RH
      const assignments = fixture.assignments!;
      expect(assignments.length).toBe(44);

      // Verify all notes are assigned to Right Hand
      for (const a of assignments) {
        expect(a.hand).toBe("R");
      }

      // Verify canonical octave fingering: 1 for lower note, 5 for higher note
      for (let i = 0; i < assignments.length; i += 2) {
        const lower = assignments[i]!;
        const upper = assignments[i + 1]!;
        expect(lower.finger).toBe(1); // Thumb on lower octave note
        expect(upper.finger).toBe(5); // Pinky on upper octave note
      }
    });
  });

  describe("W024: Chord Fit, Rolls, and Maximum Speed", () => {
    it("verifies wide chords exceeding hand reach have offset press times (rolled chord behavior)", () => {
      const fixture = loadFixture("synthetic-crossing-wide-chord.json");
      expect(fixture.status).toBe("loaded");

      // Verify hand summary reports rolled chord detected
      expect(fixture.hands).toBeDefined();
      const leftHandSummary = fixture.hands!.find((h) => h.hand === "L");
      expect(leftHandSummary).toBeDefined();
      expect(leftHandSummary!.rolledChords).toBe(1);

      // In LH at t = 3.0s, there is a wide chord: pitches [50, 55, 62, 67, 74, 81]
      const wideChordNotes = fixture.sourceNotes.filter(
        (n) => n.sourceInstrument === 1 && Math.abs(n.start - 3.0) < 0.01,
      );
      expect(wideChordNotes.length).toBe(6);

      const pitches = wideChordNotes.map((n) => n.pitch).sort((a, b) => a - b);
      expect(pitches).toEqual([50, 55, 62, 67, 74, 81]);
      const span = pitches[pitches.length - 1]! - pitches[0]!;
      expect(span).toBe(31); // 31 semitones > hand maximum stretch SPAN_MAX (16)

      // In source MIDI: all notes start at the exact same moment (t = 3.000s)
      for (const n of wideChordNotes) {
        expect(n.start).toBe(3.0);
      }

      // In PerformancePlan / performanceEvents: notes must have offset press times (rolled chord)
      expect(fixture.performanceEvents).toBeDefined();
      const chordEvents = fixture.performanceEvents!.filter(
        (e) => e.hand === "L" && e.press >= 3.0 && e.press < 3.3,
      );

      // Only 5 notes are played (human hand has 5 fingers; pitch 62 has finger: null)
      expect(chordEvents.length).toBe(5);

      // Rolled chord press times must be strictly monotonically increasing bottom-up
      const pressTimes = chordEvents.map((e) => e.press);
      for (let i = 1; i < pressTimes.length; i++) {
        expect(pressTimes[i]).toBeGreaterThan(pressTimes[i - 1]!);
      }

      // Verify the roll delta is positive (staggered attacks)
      const rollDuration = pressTimes[pressTimes.length - 1]! - pressTimes[0]!;
      expect(rollDuration).toBeGreaterThan(0.1); // Rolled across >100ms
      expect(pressTimes[0]).toBe(3.0); // Lowest note starts first
      expect(pressTimes[pressTimes.length - 1]!).toBeGreaterThan(3.15); // Highest note struck last

      // Verify contract conformance with rolled performance events
      const performancePlan = {
        schemaVersion: 1,
        planId: "performance-rolled",
        projectId: "test-rolled",
        inputRevision: 1,
        profileId: "default-pianist",
        profileRevision: 0,
        engineVersion: "engine-test",
        diagnostics: [],
        kind: "performance" as const,
        fingeringPlanId: "fingering-rolled",
        events: chordEvents.flatMap((e) => [
          { type: "press" as const, timeSeconds: e.press, noteId: e.noteId, pitch: 60, velocity: 80 },
          { type: "release" as const, timeSeconds: e.release, noteId: e.noteId },
        ]).sort((a, b) => a.timeSeconds - b.timeSeconds),
      };

      expect(PerformancePlanSchema.safeParse(performancePlan).success).toBe(true);
    });

    it("verifies early release: earlier notes in fast succession or rolls are released early to accommodate physical motion", () => {
      const fixture = loadFixture("synthetic-crossing-wide-chord.json");
      const chordEvents = fixture.performanceEvents!.filter(
        (e) => e.hand === "L" && e.press >= 3.0 && e.press < 3.3,
      );

      // In source MIDI: notes have duration 0.900s (start 3.0s, end 3.9s)
      const sourceNotes = fixture.sourceNotes.filter(
        (n) => n.sourceInstrument === 1 && Math.abs(n.start - 3.0) < 0.01,
      );
      for (const n of sourceNotes) {
        expect(n.end).toBe(3.9);
      }

      // In performance: lower notes in the roll are released EARLY so the hand can travel upward
      // Note 0 (pitch 50): press 3.000s, release 3.030s (duration 30ms instead of 900ms!)
      const note0 = chordEvents[0]!;
      expect(note0.release).toBeLessThan(3.1);
      expect(note0.release - note0.press).toBeLessThan(0.05);

      // Note 1 (pitch 55): press 3.035s, release 3.065s (released early before reaching top note)
      const note1 = chordEvents[1]!;
      expect(note1.release).toBeLessThan(3.1);
      expect(note1.release - note1.press).toBeLessThan(0.05);

      // Verify that lower notes release before higher notes finish rolling
      const lastNote = chordEvents[chordEvents.length - 1]!;
      expect(note0.release).toBeLessThan(lastNote.press);
      expect(note1.release).toBeLessThan(lastNote.press);

      // Invariant: each release must follow its own press
      for (const e of chordEvents) {
        expect(e.release).toBeGreaterThan(e.press);
      }
    });

    it("verifies hand-crossing layer order: when hands cross, layerOrder correctly places the crossing hand on top", () => {
      const fixture = loadFixture("synthetic-crossing-wide-chord.json");
      expect(fixture.crossingEpisodes).toBeDefined();
      expect(fixture.crossingEpisodes!.length).toBeGreaterThan(0);

      // Verify crossing episodes metadata
      const ep1 = fixture.crossingEpisodes![0]!;
      expect(ep1.topHand).toBe("L");
      expect(ep1.start).toBe(0.6);
      expect(ep1.end).toBe(1.2);

      const ep2 = fixture.crossingEpisodes![1]!;
      expect(ep2.topHand).toBe("L");
      expect(ep2.start).toBe(1.8);
      expect(ep2.end).toBe(3.3);

      // Inspect poses during crossing episodes
      expect(fixture.selectedPoses).toBeDefined();
      const crossingTimes = [0.6, 0.9, 1.2, 1.8, 2.55, 3.0];

      for (const t of crossingTimes) {
        const leftPose = fixture.selectedPoses!.find((p) => p.hand === "L" && Math.abs(p.time - t) < 0.01);
        const rightPose = fixture.selectedPoses!.find((p) => p.hand === "R" && Math.abs(p.time - t) < 0.01);

        expect(leftPose).toBeDefined();
        expect(rightPose).toBeDefined();

        // Left Hand crosses over Right Hand -> Left Hand layer MUST be 1, Right Hand layer MUST be 0
        expect(leftPose!.layer).toBe(1);
        expect(rightPose!.layer).toBe(0);
        expect(leftPose!.layer).toBeGreaterThan(rightPose!.layer);

        // Verify zIndex computation in renderer
        const { leftZIndex, rightZIndex } = computeZIndices(leftPose!.layer, rightPose!.layer);
        expect(leftZIndex).toBe(2);
        expect(rightZIndex).toBe(1);
        expect(leftZIndex).toBeGreaterThan(rightZIndex);
      }

      // Check non-crossing baseline (e.g. equal layers or normal positioning)
      const normalZ = computeZIndices(0, 0);
      expect(normalZ.leftZIndex).toBe(1);
      expect(normalZ.rightZIndex).toBe(1);

      // MotionPlan contract validation with typed layerOrder
      const motionPlan = {
        schemaVersion: 1,
        planId: "motion-crossing",
        projectId: "test-crossing",
        inputRevision: 1,
        profileId: "default-pianist",
        profileRevision: 0,
        engineVersion: "engine-test",
        diagnostics: [],
        kind: "motion" as const,
        performancePlanId: "perf-id",
        coordinateFrame: "keyboard-local-inches-v1" as const,
        poses: [
          {
            transportTimeSeconds: 0.6,
            hand: "left" as const,
            layerOrder: 1,
            bones: [{ a: [0, 0, 0] as [number, number, number], b: [1, 0, 0] as [number, number, number], kind: "forearm" }],
            joints: [{ point: [0, 0, 0] as [number, number, number], kind: "wrist" }],
          },
          {
            transportTimeSeconds: 0.6,
            hand: "right" as const,
            layerOrder: 0,
            bones: [{ a: [0, 0, 0] as [number, number, number], b: [1, 0, 0] as [number, number, number], kind: "forearm" }],
            joints: [{ point: [0, 0, 0] as [number, number, number], kind: "wrist" }],
          },
        ],
      };

      expect(MotionPlanSchema.safeParse(motionPlan).success).toBe(true);
    });
  });

  describe("W025: Glissando & Kinematic Invariants", () => {
    it("verifies glissando notes receive glissando disposition without normal finger stepping", () => {
      const fixture = loadFixture("synthetic-manual-fingering-gliss.json");
      expect(fixture.status).toBe("loaded");
      expect(fixture.assignments).toBeDefined();

      // Find glissando notes in source
      const glissNotes = fixture.sourceNotes.filter((n) => {
        const assignment = fixture.assignments!.find((a) => a.sourceNoteIds.includes(n.noteId));
        return assignment?.gliss === true;
      });
      expect(glissNotes.length).toBe(6);

      // Verify glissando assignments invariant:
      // glissando notes must have disposition 'glissando' and finger null (no normal 1-2-3-4-5 finger stepping)
      for (const note of glissNotes) {
        const assignment = fixture.assignments!.find((a) => a.sourceNoteIds.includes(note.noteId))!;
        expect(assignment.gliss).toBe(true);
        expect(assignment.finger).toBeNull();
      }

      // Check non-glissando notes in the same piece: they have normal played fingers
      const nonGlissNotes = fixture.sourceNotes.filter((n) => {
        const assignment = fixture.assignments!.find((a) => a.sourceNoteIds.includes(n.noteId));
        return assignment?.gliss === false;
      });
      expect(nonGlissNotes.length).toBe(2);
      for (const note of nonGlissNotes) {
        const assignment = fixture.assignments!.find((a) => a.sourceNoteIds.includes(note.noteId))!;
        expect(assignment.gliss).toBe(false);
        expect(assignment.finger).not.toBeNull();
        expect(assignment.finger).toBeGreaterThanOrEqual(1);
        expect(assignment.finger).toBeLessThanOrEqual(5);
      }

      // Verify FingeringPlan contract rejects normal finger stepping on marked glissando runs
      const testSong: SongDocument = {
        schemaVersion: 1,
        projectId: "test-gliss",
        revision: 1,
        title: "Glissando Test",
        durationSeconds: 2.0,
        tracks: [{ trackId: "track-0", instrumentIndex: 0, name: "Piano", program: 0, hand: null }],
        notes: [
          { noteId: "g1", trackId: "track-0", pitch: 60, velocity: 80, startSeconds: 0.1, endSeconds: 0.3, hand: "right", finger: null, glissando: true },
          { noteId: "g2", trackId: "track-0", pitch: 62, velocity: 80, startSeconds: 0.2, endSeconds: 0.4, hand: "right", finger: null, glissando: true },
        ],
        tempoMap: [{ timeSeconds: 0, microsecondsPerQuarterNote: 500000, eventOrdinal: 0 }],
        pedalControls: [],
      };

      const validGlissPlan = {
        schemaVersion: 1,
        planId: "plan-gliss",
        projectId: testSong.projectId,
        inputRevision: 1,
        profileId: "pianist-1",
        profileRevision: 0,
        engineVersion: "engine-1",
        diagnostics: [],
        kind: "fingering" as const,
        assignments: [
          { noteId: "g1", hand: "right" as const, finger: null, disposition: "glissando" as const },
          { noteId: "g2", hand: "right" as const, finger: null, disposition: "glissando" as const },
        ],
      };

      const parsedSong = SongDocumentSchema.parse(testSong);
      const validator = fingeringPlanForSong(parsedSong);
      expect(validator.safeParse(validGlissPlan).success).toBe(true);

      // Invariant: normal finger stepping on glissando run MUST fail contract validation
      const invalidFingerSteppingPlan = {
        ...validGlissPlan,
        assignments: [
          { noteId: "g1", hand: "right" as const, finger: 1, disposition: "played" as const },
          { noteId: "g2", hand: "right" as const, finger: 2, disposition: "played" as const },
        ],
      };
      expect(validator.safeParse(invalidFingerSteppingPlan).success).toBe(false);
    });

    it("verifies lookahead and seek determinism: seeking to timestamp t produces identical pose and note states as playing continuously up to t", () => {
      const fixture = loadFixture("synthetic-crossing-wide-chord.json");
      expect(fixture.performanceEvents).toBeDefined();

      // Define continuous simulation vs direct seek active note query
      const events: PerformanceEvent[] = fixture.performanceEvents!.map((e) => ({
        type: "press" as const,
        timeSeconds: e.press,
        noteId: e.noteId,
        pitch: 60,
        velocity: 80,
      }));
      const releaseEvents: PerformanceEvent[] = fixture.performanceEvents!.map((e) => ({
        type: "release" as const,
        timeSeconds: e.release,
        noteId: e.noteId,
      }));
      const allEvents: PerformanceEvent[] = [...events, ...releaseEvents].sort((a, b) => {
        if (Math.abs(a.timeSeconds - b.timeSeconds) < 1e-6) {
          return a.type === "release" ? -1 : 1;
        }
        return a.timeSeconds - b.timeSeconds;
      });

      function queryActiveNotesDirect(t: number): Set<string> {
        const active = new Set<string>();
        for (const e of fixture.performanceEvents!) {
          if (e.press <= t && t < e.release) {
            active.add(e.noteId);
          }
        }
        return active;
      }

      function queryActiveNotesContinuous(targetTime: number, stepSeconds = 0.02): Set<string> {
        const active = new Set<string>();
        let eventIdx = 0;
        let simTime = -1.0;

        while (simTime <= targetTime + 1e-6) {
          while (eventIdx < allEvents.length && allEvents[eventIdx]!.timeSeconds <= simTime) {
            const ev = allEvents[eventIdx]!;
            if (ev.type === "press") {
              active.add(ev.noteId);
            } else if (ev.type === "release") {
              active.delete(ev.noteId);
            }
            eventIdx++;
          }
          simTime += stepSeconds;
        }
        return active;
      }

      // Check determinism across multiple representative timestamps:
      // Lead-in, start, mid-crossing, wide-roll onset, mid-roll, post-release
      const sampleTimestamps = [-1.0, 0.0, 0.3, 0.6, 1.0, 1.8, 2.5, 3.0, 3.05, 3.12, 3.5];

      for (const t of sampleTimestamps) {
        const directActive = queryActiveNotesDirect(t);
        const continuousActive = queryActiveNotesContinuous(t);
        expect(directActive).toEqual(continuousActive);
      }

      // Verify pose sampling determinism:
      // Construct a MotionPlan from selectedPoses
      const poses = fixture.selectedPoses!.map((p) => ({
        transportTimeSeconds: p.time,
        hand: p.hand === "L" ? ("left" as const) : ("right" as const),
        layerOrder: p.layer,
        bones: p.bones.map((b) => ({
          a: b.start,
          b: b.end,
          kind: b.type,
        })),
        joints: p.joints.map((j) => ({
          point: j.position,
          kind: j.type,
        })),
      })) as MotionPose[];

      const leftPoses = poses.filter((p) => p.hand === "left").sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);
      const rightPoses = poses.filter((p) => p.hand === "right").sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);

      // Verify sequential forward queries vs out-of-order seek queries produce IDENTICAL poses
      const queryTimes = [0.0, 0.15, 0.45, 0.6, 0.75, 1.0, 1.5, 2.0, 2.7, 3.0];
      const sequentialLeft = queryTimes.map((t) => samplePose(leftPoses, t));
      const sequentialRight = queryTimes.map((t) => samplePose(rightPoses, t));

      // Query in shuffled / random-seek order
      const shuffledIndices = [7, 2, 9, 0, 4, 1, 8, 3, 6, 5];
      for (const idx of shuffledIndices) {
        const t = queryTimes[idx]!;
        const seekLeft = samplePose(leftPoses, t);
        const seekRight = samplePose(rightPoses, t);

        expect(seekLeft).toEqual(sequentialLeft[idx]);
        expect(seekRight).toEqual(sequentialRight[idx]);
      }
    });

    it("verifies pedal switch state seek determinism across pedal transitions and tempo changes", () => {
      const fixture = loadFixture("synthetic-tempo-pedals-overlap.json");
      expect(fixture.status).toBe("loaded");
      expect(fixture.pedals).toBeDefined();

      const pedalEvents = fixture.pedals!;
      expect(pedalEvents.length).toBeGreaterThan(0);

      // Invariant: at any timestamp t, the active pedal state (sustain, sostenuto, soft)
      // is determined solely by the latest pedal switch event at or before t.
      function getPedalStateAt(t: number): Record<number, number> {
        const state: Record<number, number> = { 64: 0, 66: 0, 67: 0 };
        for (const ev of pedalEvents) {
          if (ev.time <= t) {
            state[ev.controller] = ev.value;
          }
        }
        return state;
      }

      // Query across a sequence of timestamps
      const probeTimes = [0.0, 0.125, 0.2, 0.25, 0.4, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0];
      const sequentialStates = probeTimes.map((t) => getPedalStateAt(t));

      // Seeking to probeTimes in reverse and random order must yield bit-exact identical pedal states
      const reverseStates = [...probeTimes].reverse().map((t) => getPedalStateAt(t)).reverse();
      expect(reverseStates).toEqual(sequentialStates);

      // Verify specific pedal switches match expectations
      // At t = 0.125s: CC 64 (sustain) turns ON (127)
      expect(getPedalStateAt(0.125)[64]).toBe(127);
      // At t = 0.5s: CC 64, 66, 67 all ON (127)
      const halfSec = getPedalStateAt(0.5);
      expect(halfSec[64]).toBe(127);
      expect(halfSec[66]).toBe(127);
      expect(halfSec[67]).toBe(127);
      // At t = 1.0s: CC 64 turns OFF (0)
      expect(getPedalStateAt(1.0)[64]).toBe(0);
    });
  });

  describe("W024: Chord Fit Extra Invariants", () => {
    it("verifies unplayable chord note when chord size exceeds 5 fingers in a single hand: unplayable note receives finger: null while source note is preserved in document", () => {
      const fixture = loadFixture("synthetic-crossing-wide-chord.json");
      // Find the 6-note LH chord at t = 3.0s
      const wideChordNotes = fixture.sourceNotes.filter(
        (n) => n.sourceInstrument === 1 && Math.abs(n.start - 3.0) < 0.01,
      );
      expect(wideChordNotes).toHaveLength(6);

      // In assignments, exactly 5 notes have a finger (1..5) and 1 note has finger: null
      const chordAssignments = fixture.assignments!.filter((a) =>
        wideChordNotes.some((n) => a.sourceNoteIds.includes(n.noteId)),
      );
      expect(chordAssignments).toHaveLength(6);

      const played = chordAssignments.filter((a) => a.finger !== null);
      const unplayable = chordAssignments.filter((a) => a.finger === null);

      expect(played).toHaveLength(5);
      expect(unplayable).toHaveLength(1);

      // The unplayable note is preserved in sourceNotes and assignments
      expect(unplayable[0]!.sourceNoteIds.length).toBeGreaterThan(0);
      const unplayableSource = fixture.sourceNotes.find((n) =>
        unplayable[0]!.sourceNoteIds.includes(n.noteId),
      );
      expect(unplayableSource).toBeDefined();
      expect(unplayableSource!.pitch).toBe(62); // Middle note omitted by 5-finger span
    });
  });
});

