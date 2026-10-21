import { describe, expect, it } from "vitest";
import { M1AnalyzeMidiRequestSchema, validateM1AnalyzeMidiResultForRequest, type PerformanceEvent } from "@handthesia/contracts";
import { _write_vlq } from "../src/midiLoader.ts";
import { analyzeMidi, _engine_version } from "../src/index.ts";

/** One track: tempo, then a 0.5 s note for every requested pitch. */
function buildMidi(pitches: readonly number[]): Uint8Array {
  const track: number[] = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  for (const pitch of pitches) {
    track.push(0x00, 0x90, pitch, 100);
    track.push(..._write_vlq(480), 0x80, pitch, 0);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0];
  const length = track.length;
  return new Uint8Array([
    ...header,
    0x4d, 0x54, 0x72, 0x6b,
    (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff,
    ...track,
  ]);
}

const pitches = [0, 10, 120, 127] as const;
const midiBytes = buildMidi(pitches);
const options = {
  fixtureId: "raw-source-pitch",
  projectId: "raw-source-pitch-proj",
  revision: 0,
  requestId: "raw-source-pitch-request",
  engineVersion: _engine_version(),
  sampleDense: true,
};

function request() {
  return M1AnalyzeMidiRequestSchema.parse({
    type: "analyze-midi",
    requestId: options.requestId,
    projectId: options.projectId,
    revision: options.revision,
    engineVersion: options.engineVersion,
    midiBytes: midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength),
    options: { fixtureId: options.fixtureId, sampleDense: true },
  });
}

function analyzedResult() {
  return {
    ...analyzeMidi(midiBytes, options),
    type: "analysis-result" as const,
  };
}

describe("ENG-6 raw source pitch range", () => {
  it("accepts raw MIDI pitches 0..127 and keeps normalized notes in 21..108", () => {
    const validated = validateM1AnalyzeMidiResultForRequest(request(), analyzedResult());

    expect(validated.status).toBe("loaded");
    const rawPitches = validated.rawBaseline.sourceNotes.map((note) => note.pitch).sort((a, b) => a - b);
    expect(rawPitches).toEqual([0, 10, 120, 127]);

    const normalized = validated.document!.notes;
    expect(normalized.every((note) => note.pitch >= 21 && note.pitch <= 108)).toBe(true);

    // A normalized note keeps the raw source noteId(s) that produced it, and
    // every exact/merged identity mapping points at the returned note.
    const normalizedById = new Map(normalized.map((note) => [note.noteId, note]));
    for (const mapping of validated.rawBaseline.identityMappings) {
      if (mapping.normalizedNoteId === null) continue;
      const note = normalizedById.get(mapping.normalizedNoteId);
      expect(note).toBeDefined();
      expect(note!.sourceNoteIds ?? []).toContain(mapping.noteId);
    }
  });

  it("rejects raw pitches outside 0..127 and non-integers", () => {
    for (const pitch of [-1, 128, 10.5]) {
      const result = analyzedResult();
      result.rawBaseline.sourceNotes[0]!.pitch = pitch;
      expect(() => validateM1AnalyzeMidiResultForRequest(request(), result)).toThrow();
    }
  });

  it("still rejects normalized and performance pitches outside 21..108", () => {
    const normalized = analyzedResult();
    normalized.document!.notes[0]!.pitch = 0;
    expect(() => validateM1AnalyzeMidiResultForRequest(request(), normalized)).toThrow();

    const performance = analyzedResult();
    const press = performance.performancePlan!.events.find(
      (event: PerformanceEvent) => event.type === "press",
    ) as Extract<PerformanceEvent, { type: "press" }> | undefined;
    expect(press).toBeDefined();
    press!.pitch = 127;
    expect(() => validateM1AnalyzeMidiResultForRequest(request(), performance)).toThrow();
  });
});
