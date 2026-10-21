import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeMidi, exportFingeredMidi, _engine_version } from "../src/index.ts";
import { _smf_tracks, _write_vlq, save_fingered_midi_bytes } from "../src/midiLoader.ts";

const fixturesDir = resolve(__dirname, "../../../tests/fixtures");

function loadMidi(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(fixturesDir, "midi", filename)));
}

/** 0x01 text meta events, in file order, for the exported bytes. */
function markerEvents(bytes: Uint8Array): Array<{ tick: number; text: string }> {
  const markers: Array<{ tick: number; text: string }> = [];
  const [, , tracks] = _smf_tracks(bytes);
  for (const events of tracks.values()) {
    for (const [tick, kind, payload] of events) {
      if (kind !== "meta") continue;
      const [type, data] = payload as [number, Uint8Array];
      if (type === 0x01) markers.push({ tick, text: new TextDecoder().decode(data) });
    }
  }
  return markers;
}

/** Note-on tick:pitch pairs; hand channels are allowed to change. */
function noteOns(bytes: Uint8Array): string[] {
  const ons: string[] = [];
  const [, , tracks] = _smf_tracks(bytes);
  for (const events of tracks.values()) {
    for (const [tick, kind, payload] of events) {
      if (kind !== "midi") continue;
      const message = payload as Uint8Array;
      if ((message[0]! & 0xf0) === 0x90 && message[2]! > 0) ons.push(`${tick}:${message[1]}`);
    }
  }
  return ons;
}

/** One track: tempo, two note-ons on the same pitch/tick, one higher note. */
function buildBucketMidi(): Uint8Array {
  const track: number[] = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  track.push(0x00, 0x90, 60, 100);
  track.push(0x00, 0x90, 60, 100);
  track.push(0x00, 0x90, 64, 100);
  track.push(..._write_vlq(480), 0x80, 60, 0);
  track.push(0x00, 0x80, 60, 0);
  track.push(0x00, 0x80, 64, 0);
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

describe("ENG-2/ENG-3 marked note accounting and diagnostics", () => {
  it("counts all 22 source notes, writes 22 markers and keeps the bytes stable", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const initial = analyzeMidi(midiBytes, {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "req-markers",
      engineVersion: _engine_version(),
      sampleDense: true,
    });
    expect(initial.document.notes).toHaveLength(22);

    const exported = exportFingeredMidi(midiBytes, initial.document, initial.fingeringPlan);
    expect(exported.markedCount).toBe(22);
    expect(exported.diagnostics).toEqual([]);

    const markers = markerEvents(exported.exportedBytes);
    expect(markers).toHaveLength(22);
    expect(markers.every((marker) => /^[LR][1-5g]$/.test(marker.text))).toBe(true);
    // The valid export must stay byte-identical to the post-ENG-2 output.
    expect(createHash("sha256").update(exported.exportedBytes).digest("hex"))
      .toBe("7e64b9b851ca934a8f9c857edbfa2d66b8d6da33d932dfbc3fec38390a8dee48");
    // The musical events are unchanged; only the hand channel and the new
    // fingering markers are allowed to differ.
    expect(noteOns(exported.exportedBytes)).toEqual(noteOns(midiBytes));
  });

  it("reports the shifted document note by noteId and still marks the other 21", () => {
    const midiBytes = loadMidi("tracked-right-hand.mid");
    const initial = analyzeMidi(midiBytes, {
      fixtureId: "tracked-right-hand",
      projectId: "test-proj",
      revision: 0,
      requestId: "req-markers-shifted",
      engineVersion: _engine_version(),
      sampleDense: true,
    });
    const document = JSON.parse(JSON.stringify(initial.document)) as typeof initial.document;
    const shifted = document.notes[0]!;
    shifted.startSeconds += 0.02;
    shifted.endSeconds += 0.02;

    const exported = exportFingeredMidi(midiBytes, document, initial.fingeringPlan);

    expect(exported.markedCount).toBe(21);
    expect(markerEvents(exported.exportedBytes)).toHaveLength(21);
    expect(exported.diagnostics).toHaveLength(1);
    expect(exported.diagnostics[0]).toMatchObject({
      code: "unmatched-document-note",
      noteId: shifted.noteId,
    });
    expect(noteOns(exported.exportedBytes)).toHaveLength(noteOns(midiBytes).length);
  });

  it("counts unique marked notes when several notes share one bucket", () => {
    const notes = [
      { pitch: 60, start: 0, hand: "R", finger: 1, noteId: "doc-60-right" },
      { pitch: 60, start: 0, hand: "L", finger: 2, noteId: "doc-60-left" },
      { pitch: 64, start: 0, hand: "R", finger: 3, noteId: "doc-64" },
    ];
    const fingers = new Map<object, number>([
      [notes[0]!, 1],
      [notes[1]!, 2],
      [notes[2]!, 3],
    ]);

    const [bytes, markedCount, diagnostics] = save_fingered_midi_bytes(buildBucketMidi(), notes, fingers);

    // The first two note-ons resolve to the same bucket entry, so only two
    // distinct notes are marked (60 and 64) even though three markers are
    // written. Counting bucket indexes would report one; counting marker
    // events would report three.
    expect(markedCount).toBe(2);
    expect(markerEvents(bytes)).toHaveLength(3);
    expect(noteOns(bytes)).toEqual(["0:60", "0:60", "0:64"]);
    // The second note in the bucket is never returned by the source lookup, so
    // it is reported by its stable document noteId.
    expect(diagnostics).toEqual([{
      code: "unmatched-document-note",
      noteId: "doc-60-left",
      message: "Document note doc-60-left has no matching note-on in the source MIDI and was not marked.",
    }]);
  });
});
