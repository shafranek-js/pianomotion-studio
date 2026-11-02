import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { analyze_midi, _engine_version } from "../src/api.ts";
import { DEFAULT_ANATOMY, handSpanInches, type Pianist } from "../src/pianist.ts";
import { _fit_spans, SPAN_FREE, SPAN_HELD_MAX, SPAN_MAX } from "../src/handSplit.ts";

function pianistWith(anatomy: Record<string, number>): Pianist {
  return { anatomy } as unknown as Pianist;
}

afterEach(() => {
  _fit_spans(null);
});

describe("hand split span scaling", () => {
  it("scales the spans by the hand model ratio, like Python hand_span_inches", () => {
    const scaled = Object.fromEntries(
      Object.entries(DEFAULT_ANATOMY).map(([bone, length]) => [bone, length * 1.2]),
    );
    const expected = handSpanInches(scaled) / handSpanInches(null);
    expect(expected).toBeGreaterThan(1.05);
    expect(expected).toBeLessThan(1.3);

    _fit_spans(pianistWith(scaled));

    expect(SPAN_FREE).toBeCloseTo(12 * expected, 6);
    expect(SPAN_MAX).toBeCloseTo(16 * expected, 6);
    expect(SPAN_HELD_MAX).toBeCloseTo(19 * expected, 6);
  });

  it("ignores the legacy hand_span key that Python never read", () => {
    // The old TS port looked for a "hand_span" anatomy field that is absent
    // from DEFAULT_ANATOMY, so this anatomy used to leave the spans unchanged.
    _fit_spans(pianistWith({ ...DEFAULT_ANATOMY, hand_span: 12 }));

    expect(SPAN_FREE).toBe(12);
    expect(SPAN_MAX).toBe(16);
    expect(SPAN_HELD_MAX).toBe(19);
  });

  it("merges narrow single-hand clusters (Autumn 0:25) into one hand and assigns non-colliding thumb fingering at 0:41", () => {
    const buf = readFileSync(
      new URL("../../../apps/client/public/builtin-melodies/files/3c01d3ce38a4f62d48bc0e20c3075fbc65ac71c348c1efcbdd6b1ca21852a420.mid", import.meta.url),
    );
    const res = analyze_midi(new Uint8Array(buf), {
      fixtureId: "autumn",
      projectId: "autumn",
      revision: 1,
      requestId: "req-autumn",
      engineVersion: _engine_version(),
      sampleDense: false,
    });
    type AssignmentDto = { noteId: string; hand: string; finger: number };
    type NoteDto = { noteId: string; startSeconds: number; endSeconds: number; pitch: number };
    const asg = new Map<string, AssignmentDto>(
      (res.fingeringPlan.assignments as AssignmentDto[]).map((a) => [a.noteId, a]),
    );
    const allNotes = res.document.notes as NoteDto[];
    const notes25 = allNotes.filter((n) => n.startSeconds >= 25.1 && n.endSeconds <= 28.85);
    expect(notes25.length).toBeGreaterThan(10);
    for (const n of notes25) {
      const a = asg.get(n.noteId)!;
      expect(a.hand).toBe("right");
      if (n.pitch === 53) expect(a.finger).toBe(1);
    }

    const leftF4Notes = allNotes.filter(
      (n) => n.startSeconds >= 40.7 && n.startSeconds <= 48.1 && n.pitch === 65,
    );
    expect(leftF4Notes.length).toBeGreaterThanOrEqual(4);
    for (const n of leftF4Notes) {
      const a = asg.get(n.noteId)!;
      expect(a.hand).toBe("left");
      expect(a.finger).toBe(1);
    }
  }, 15_000);

  it("transfers intruding middle-register inner-voice chord notes (A3, G#3) to the right hand in Himn Ukrainy around 0:37", () => {
    const buf = readFileSync(
      new URL("../../../apps/client/public/builtin-melodies/files/79dfc481b36c35f6ab4e479606f77a419f93baffe5dda7709d20915ca8b2a27d.mid", import.meta.url),
    );
    const res = analyze_midi(new Uint8Array(buf), {
      fixtureId: "himn-ukrainy",
      projectId: "himn-ukrainy",
      revision: 1,
      requestId: "req-himn",
      engineVersion: _engine_version(),
      sampleDense: false,
    });
    type AssignmentDto = { noteId: string; hand: string; finger: number };
    type NoteDto = { noteId: string; startSeconds: number; endSeconds: number; pitch: number };
    const asg = new Map<string, AssignmentDto>(
      (res.fingeringPlan.assignments as AssignmentDto[]).map((a) => [a.noteId, a]),
    );
    const allNotes = res.document.notes as NoteDto[];

    // At 36.00..44.96s (around 0:37), the inner harmony notes A3 (57) and G#3 (56) sit right under the RH melody
    // and must be played by the right hand (thumb=1), while the lower bass notes (D3=50, E3=52, F3=53) stay in the left hand.
    const innerHarmonyNotes = allNotes.filter(
      (n) => n.startSeconds >= 35.9 && n.startSeconds <= 44.6 && (n.pitch === 56 || n.pitch === 57),
    );
    expect(innerHarmonyNotes.length).toBeGreaterThanOrEqual(6);
    for (const n of innerHarmonyNotes) {
      const a = asg.get(n.noteId)!;
      expect(a.hand).toBe("right");
      expect(a.finger).toBeLessThanOrEqual(2);
    }

    const bassNotes = allNotes.filter(
      (n) => n.startSeconds >= 35.9 && n.startSeconds <= 44.6 && n.pitch <= 53,
    );
    expect(bassNotes.length).toBeGreaterThanOrEqual(8);
    for (const n of bassNotes) {
      const a = asg.get(n.noteId)!;
      expect(a.hand).toBe("left");
    }
  }, 15_000);
});
