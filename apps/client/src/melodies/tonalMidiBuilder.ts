/**
 * tonalMidiBuilder.ts - Standard MIDI File (Format 1) serializer for TonalExercise
 * (scales and classical chord progressions).
 *
 * Writes separate Right Hand and Left Hand tracks with tempo, time signature,
 * CC64 sustain pedal events, and per-note Hand-thesia text markers (`R1..R5`, `L1..L5`)
 * immediately preceding each Note-On so `midiLoader.ts` preserves exact hands and fingerings.
 */

import type { TonalExercise, TonalNote, TonalPedal } from "./tonalScalesAndProgressions";

const PPQ = 480;

function writeVlq(value: number): number[] {
  const v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  let rem = v >>> 7;
  while (rem > 0) {
    bytes.push(0x80 | (rem & 0x7f));
    rem >>>= 7;
  }
  return bytes.reverse();
}

function encodeAscii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(text.charCodeAt(i) & 0x7f);
  }
  return out;
}

interface RawTrackEvent {
  readonly tick: number;
  readonly order: number;
  readonly bytes: readonly number[];
}

function buildTrackChunk(events: readonly RawTrackEvent[]): Uint8Array {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let lastTick = 0;
  for (const ev of sorted) {
    const dt = Math.max(0, ev.tick - lastTick);
    lastTick = ev.tick;
    body.push(...writeVlq(dt), ...ev.bytes);
  }
  // End of Track meta event
  body.push(0x00, 0xff, 0x2f, 0x00);

  const chunk = new Uint8Array(8 + body.length);
  chunk.set([0x4d, 0x54, 0x72, 0x6b], 0); // "MTrk"
  const view = new DataView(chunk.buffer);
  view.setUint32(4, body.length, false);
  chunk.set(body, 8);
  return chunk;
}

function buildHandTrack(
  trackName: string,
  channel: number,
  notes: readonly TonalNote[],
  pedals: readonly TonalPedal[],
): Uint8Array {
  const events: RawTrackEvent[] = [];
  const nameBytes = encodeAscii(trackName);
  events.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x03, ...writeVlq(nameBytes.length), ...nameBytes],
  });
  // Program Change: Acoustic Grand Piano (program 0)
  events.push({
    tick: 0,
    order: 1,
    bytes: [0xc0 | (channel & 0x0f), 0x00],
  });

  for (const pedal of pedals) {
    const onTick = Math.max(0, Math.round(pedal.startBeat * PPQ));
    const offTick = Math.max(onTick + 1, Math.round((pedal.startBeat + pedal.beats) * PPQ));
    events.push({
      tick: onTick,
      order: 10,
      bytes: [0xb0 | (channel & 0x0f), pedal.controller & 0x7f, 127],
    });
    events.push({
      tick: offTick,
      order: 5,
      bytes: [0xb0 | (channel & 0x0f), pedal.controller & 0x7f, 0],
    });
  }

  notes.forEach((note, idx) => {
    const startTick = Math.max(0, Math.round(note.startBeat * PPQ));
    const durationTicks = Math.max(12, Math.round(note.beats * PPQ));
    const endTick = startTick + durationTicks;
    const pitch = Math.max(21, Math.min(108, Math.round(note.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
    const markerCode = `${note.hand === "left" ? "L" : "R"}${note.finger}`;
    const markerBytes = encodeAscii(markerCode);

    // Emit text marker (0xFF 0x01) immediately before Note-On with consecutive order numbers
    // so read_markers pairs each marker with its Note-On even in multi-note chords.
    const pairOrder = 20 + (idx % 1000) * 2;
    events.push({
      tick: startTick,
      order: pairOrder,
      bytes: [0xff, 0x01, ...writeVlq(markerBytes.length), ...markerBytes],
    });
    events.push({
      tick: startTick,
      order: pairOrder + 1,
      bytes: [0x90 | (channel & 0x0f), pitch, vel],
    });
    events.push({
      tick: endTick,
      order: 2,
      bytes: [0x80 | (channel & 0x0f), pitch, 0],
    });
  });

  return buildTrackChunk(events);
}

/**
 * Build a complete Standard MIDI File (`ArrayBuffer`) from a `TonalExercise`.
 */
export function buildTonalExerciseMidi(exercise: TonalExercise): ArrayBuffer {
  const bpm = Math.max(20, Math.min(300, exercise.bpm || 100));
  const mpqn = Math.round(60_000_000 / bpm);
  const numerator = exercise.meter.numerator || 4;
  const denominatorPow = Math.max(0, Math.round(Math.log2(exercise.meter.denominator || 4)));

  const titleBytes = encodeAscii(exercise.title);
  const conductorEvents: RawTrackEvent[] = [
    {
      tick: 0,
      order: 0,
      bytes: [0xff, 0x03, ...writeVlq(titleBytes.length), ...titleBytes],
    },
    {
      tick: 0,
      order: 1,
      bytes: [0xff, 0x58, 0x04, numerator & 0xff, denominatorPow & 0xff, 24, 8],
    },
    {
      tick: 0,
      order: 2,
      bytes: [0xff, 0x51, 0x03, (mpqn >>> 16) & 0xff, (mpqn >>> 8) & 0xff, mpqn & 0xff],
    },
  ];

  const rightNotes = exercise.notes.filter((n) => n.hand === "right");
  const leftNotes = exercise.notes.filter((n) => n.hand === "left");

  const trackChunks: Uint8Array[] = [buildTrackChunk(conductorEvents)];
  if (rightNotes.length > 0) {
    trackChunks.push(buildHandTrack("Right Hand", 0, rightNotes, exercise.pedals));
  }
  if (leftNotes.length > 0) {
    trackChunks.push(
      buildHandTrack(
        "Left Hand",
        1,
        leftNotes,
        rightNotes.length === 0 ? exercise.pedals : [],
      ),
    );
  }

  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64], 0); // "MThd"
  const hView = new DataView(header.buffer);
  hView.setUint32(4, 6, false);
  hView.setUint16(8, 1, false); // Format 1
  hView.setUint16(10, trackChunks.length, false);
  hView.setUint16(12, PPQ, false);

  const totalByteLength =
    header.byteLength + trackChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(totalByteLength);
  out.set(header, 0);
  let offset = header.byteLength;
  for (const chunk of trackChunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
