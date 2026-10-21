/**
 * midiLoader.ts - Pure TypeScript Standard MIDI File (SMF) parser, sanitizer,
 * and PrettyMIDI-compatible loader with zero external dependencies.
 *
 * Ported 1-to-1 from python-core/handthesia_core/midi_loader.py.
 */

import { bisectLeft, bisectRight, rounded } from "./pythonCompat.ts";
import * as progress from "./progress.ts";
import { split_hands } from "./handSplit.ts";
import { objId } from "./figures.ts";
import type { Pianist } from "./pianist.ts";

export const LOWEST_PIANO_KEY = 21; // A0
export const HIGHEST_PIANO_KEY = 108; // C8
export const MIDDLE_C = 60;

export const LEFT = "L";
export const RIGHT = "R";

export const SUSTAIN = 64;
export const SOSTENUTO = 66;
export const SOFT = 67;
export const PEDALS = [SUSTAIN, SOSTENUTO, SOFT] as const;

const _BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const _NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export function isBlackKey(pitch: number): boolean {
  return _BLACK_PITCH_CLASSES.has(((pitch % 12) + 12) % 12);
}

export const is_black_key = isBlackKey;

export function noteName(pitch: number): string {
  const pc = ((pitch % 12) + 12) % 12;
  const oct = Math.floor(pitch / 12) - 1;
  return `${_NOTE_NAMES[pc]}${oct}`;
}

export const note_name = noteName;

export { objId };
export const pyId = objId;

export interface SourceEventLocator {
  midiTrackIndex: number;
  channel: number;
  noteOnOrdinal: number;
  noteOffOrdinal: number;
}

export class Note {
  readonly pitch: number;
  readonly start: number;
  readonly end: number;
  readonly velocity: number;
  readonly track: number;
  readonly hand: string | null;
  readonly finger: number | null;
  readonly gliss: boolean;
  readonly source_ids: readonly string[];
  readonly source_events: readonly SourceEventLocator[];

  constructor(
    pitch: number,
    start: number,
    end: number,
    velocity: number,
    track: number,
    hand: string | null,
    finger: number | null = null,
    gliss = false,
    source_ids: readonly string[] = [],
    source_events: readonly SourceEventLocator[] = [],
  ) {
    this.pitch = pitch;
    this.start = start;
    this.end = end;
    this.velocity = velocity;
    this.track = track;
    this.hand = hand;
    this.finger = finger;
    this.gliss = gliss;
    this.source_ids = source_ids;
    this.source_events = source_events;
    Object.freeze(this);
  }

  get duration(): number {
    return this.end - this.start;
  }

  get is_black(): boolean {
    return isBlackKey(this.pitch);
  }

  get name(): string {
    return noteName(this.pitch);
  }
}

export class TrackInfo {
  readonly index: number;
  readonly name: string;
  readonly program: number;
  readonly note_count: number;
  readonly hand: string | null;

  constructor(index: number, name: string, program: number, note_count: number, hand: string | null) {
    this.index = index;
    this.name = name;
    this.program = program;
    this.note_count = note_count;
    this.hand = hand;
    Object.freeze(this);
  }
}

export function pedal_switches(
  controls: readonly (readonly [number, number, number])[],
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const state: Record<number, number> = {};
  for (const [t, c, v] of controls) {
    const on = v >= 64 ? 127 : 0;
    if ((state[c] ?? 0) !== on) {
      state[c] = on;
      out.push([t, c, on]);
    }
  }
  return out;
}

export class MidiSong {
  readonly notes: Note[];
  readonly raw_controls: Array<[number, number, number]>;
  readonly controls: Array<[number, number, number]>;
  private readonly _control_times: number[];
  readonly tracks: TrackInfo[];
  readonly duration: number;
  readonly bar_times: number[];
  readonly beat_times: number[];
  readonly path: string | null;
  readonly title: string;
  cleanup: string[];
  private readonly _starts: number[];
  private readonly _max_duration: number;

  constructor(
    notes: readonly Note[],
    tracks: readonly TrackInfo[],
    duration: number,
    bar_times: readonly number[],
    beat_times: readonly number[],
    path: string | null = null,
    controls: readonly (readonly [number, number, number])[] = [],
  ) {
    this.notes = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    this.raw_controls = [...controls.map(([t, c, v]) => [t, c, v] as [number, number, number])]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.controls = pedal_switches(this.raw_controls);
    this._control_times = this.controls.map((c) => c[0]);
    this.tracks = [...tracks];
    this.duration = duration;
    this.bar_times = [...bar_times];
    this.beat_times = [...beat_times];
    this.path = path;
    this.title = path ? String(path) : "Untitled";
    this.cleanup = [];
    this._starts = this.notes.map((n) => n.start);
    this._max_duration = this.notes.reduce((max, n) => Math.max(max, n.duration), 0.0);
  }

  get length(): number {
    return this.notes.length;
  }

  notes_between(t0: number, t1: number): Note[] {
    const lo = bisectLeft(this._starts, t0 - this._max_duration);
    const hi = bisectLeft(this._starts, t1);
    return this.notes.slice(lo, hi).filter((n) => n.end > t0);
  }

  active_notes(t: number): Note[] {
    const lo = bisectLeft(this._starts, t - this._max_duration);
    const hi = bisectRight(this._starts, t);
    return this.notes.slice(lo, hi).filter((n) => n.end > t);
  }

  controls_between(t0: number, t1: number): Array<[number, number, number]> {
    const lo = bisectRight(this._control_times, t0);
    const hi = bisectRight(this._control_times, t1);
    return this.controls.slice(lo, hi);
  }

  control_state(t: number): Record<number, number> {
    const state: Record<number, number> = { [SUSTAIN]: 0, [SOSTENUTO]: 0, [SOFT]: 0 };
    const limit = bisectRight(this._control_times, t);
    for (let i = 0; i < limit; i += 1) {
      const [, c, v] = this.controls[i]!;
      state[c] = v;
    }
    return state;
  }

  sustain_at(t: number): boolean {
    return (this.control_state(t)[SUSTAIN] ?? 0) >= 64;
  }

  pitch_range(): [number, number] {
    if (this.notes.length === 0) {
      return [LOWEST_PIANO_KEY, HIGHEST_PIANO_KEY];
    }
    let minP = Infinity;
    let maxP = -Infinity;
    for (const n of this.notes) {
      if (n.pitch < minP) minP = n.pitch;
      if (n.pitch > maxP) maxP = n.pitch;
    }
    return [minP, maxP];
  }
}

export function _hand_from_name(name: string): string | null {
  const n = name.toLowerCase().replaceAll("-", " ").replaceAll("_", " ");
  const words = n.split(/\s+/);
  if (n.includes("right") || words.includes("rh") || words.includes("r") || n.includes("treble")) {
    return RIGHT;
  }
  if (n.includes("left") || words.includes("lh") || words.includes("l") || n.includes("bass")) {
    return LEFT;
  }
  return null;
}

export function _fit_to_piano(pitch: number): number {
  let p = pitch;
  while (p < LOWEST_PIANO_KEY) {
    p += 12;
  }
  while (p > HIGHEST_PIANO_KEY) {
    p -= 12;
  }
  return p;
}

export function _vlq(d: Uint8Array, i: number): [number, number] {
  let n = 0;
  let idx = i;
  while (true) {
    if (idx >= d.length) throw new Error("unexpected end of file reading VLQ");
    const b = d[idx]!;
    idx += 1;
    n = (n << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      return [n, idx];
    }
  }
}

export function _write_vlq(n: number): Uint8Array {
  if (n < 0) throw new Error("negative VLQ");
  const out: number[] = [n & 0x7f];
  let v = n >>> 7;
  while (v > 0) {
    out.push(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  return new Uint8Array(out.reverse());
}

export function _marker(data: Uint8Array): [string | null, number | "g"] | [string, null] | null {
  if (data.length === 2) {
    const c0 = String.fromCharCode(data[0]!);
    const c1 = String.fromCharCode(data[1]!);
    if ((c0 === "F" || c0 === "R" || c0 === "L") && "12345".includes(c1)) {
      return [c0 === "F" ? null : c0, parseInt(c1, 10)];
    }
    if ((c0 === "R" || c0 === "L") && c1 === "g") {
      return [c0, "g"];
    }
  }
  if (data.length === 1) {
    const c0 = String.fromCharCode(data[0]!);
    if (c0 === "R" || c0 === "L") {
      return [c0, null];
    }
  }
  return null;
}

export function _chunks(d: Uint8Array): [Uint8Array, Array<[string, Uint8Array]>] {
  if (d.length < 14) {
    throw new Error("not a standard MIDI file: too short");
  }
  const tag = String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!);
  if (tag !== "MThd") {
    throw new Error("not a standard MIDI file");
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const hl = view.getUint32(4, false);
  if (hl < 6 || 8 + hl > d.length) {
    throw new Error("invalid MIDI header length");
  }
  const header = d.slice(8, 8 + hl);
  let i = 8 + hl;
  const out: Array<[string, Uint8Array]> = [];
  while (i + 8 <= d.length) {
    const chunkType = String.fromCharCode(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!);
    const chunkLen = view.getUint32(i + 4, false);
    if (i + 8 + chunkLen > d.length) {
      throw new Error("truncated MIDI chunk body");
    }
    const chunkBody = d.slice(i + 8, i + 8 + chunkLen);
    out.push([chunkType, chunkBody]);
    i += 8 + chunkLen;
  }
  if (i !== d.length) {
    throw new Error("truncated MIDI chunk header");
  }
  return [header, out];
}

export type DecodedRawEvent =
  | [number, "meta", [number, Uint8Array]]
  | [number, "sysex", Uint8Array]
  | [number, "midi", Uint8Array];

export function _events(td: Uint8Array): DecodedRawEvent[] {
  const out: DecodedRawEvent[] = [];
  let j = 0;
  let t = 0;
  let run: number | null = null;
  while (j < td.length) {
    const [dt, nextJ] = _vlq(td, j);
    t += dt;
    j = nextJ;
    if (j >= td.length) throw new Error("truncated MIDI event after delta time");
    const b = td[j]!;
    if (b === 0xff) {
      if (j + 1 >= td.length) throw new Error("truncated MIDI meta event type");
      const typ = td[j + 1]!;
      const [ln, k] = _vlq(td, j + 2);
      if (k + ln > td.length) throw new Error("truncated MIDI meta event payload");
      out.push([t, "meta", [typ, td.slice(k, k + ln)]]);
      j = k + ln;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) {
      const [ln, k] = _vlq(td, j + 1);
      if (k + ln > td.length) throw new Error("truncated MIDI system-exclusive payload");
      out.push([t, "sysex", td.slice(j, k + ln)]);
      j = k + ln;
      continue;
    }
    if ((b & 0x80) !== 0) {
      run = b;
      j += 1;
    }
    if (run === null) {
      throw new Error("MIDI data without a status byte");
    }
    const n = (run & 0xf0) === 0xc0 || (run & 0xf0) === 0xd0 ? 1 : 2;
    if (j + n > td.length) throw new Error("truncated MIDI channel message");
    const p = new Uint8Array(1 + n);
    p[0] = run;
    p.set(td.subarray(j, j + n), 1);
    out.push([t, "midi", p]);
    j += n;
  }
  return out;
}

export function _encode(events: readonly DecodedRawEvent[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let last = 0;
  for (const [t, kind, p] of events) {
    chunks.push(_write_vlq(t - last));
    last = t;
    if (kind === "meta") {
      const [typ, data] = p as [number, Uint8Array];
      chunks.push(new Uint8Array([0xff, typ]));
      chunks.push(_write_vlq(data.length));
      chunks.push(data);
    } else {
      chunks.push(p as Uint8Array);
    }
  }
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function _smf_tracks(
  source: Uint8Array,
): [Uint8Array, Array<[string, Uint8Array]>, Map<number, DecodedRawEvent[]>] {
  function decode(
    data: Uint8Array,
  ): [Uint8Array, Array<[string, Uint8Array]>, Map<number, DecodedRawEvent[]>] {
    const [header, chunks] = _chunks(data);
    const tracksMap = new Map<number, DecodedRawEvent[]>();
    for (let i = 0; i < chunks.length; i += 1) {
      const [typ, td] = chunks[i]!;
      if (typ === "MTrk") {
        tracksMap.set(i, _events(td));
      }
    }
    return [header, chunks, tracksMap];
  }

  try {
    return decode(source);
  } catch {
    const [clean] = repair_smf(source);
    return decode(clean);
  }
}

export function read_markers(source: Uint8Array): Map<string, [string | null, number | "g"] | [string, null]> {
  const out = new Map<string, [string | null, number | "g"] | [string, null]>();
  try {
    const [, , tracks] = _smf_tracks(source);
    for (const events of tracks.values()) {
      let pending: [string | null, number | "g"] | [string, null] | null = null;
      for (const [t, kind, p] of events) {
        if (kind === "meta") {
          const [typ, data] = p as [number, Uint8Array];
          if (typ === 0x01) {
            pending = _marker(data) || pending;
          }
          continue;
        }
        if (kind === "midi") {
          const m = p as Uint8Array;
          if ((m[0]! & 0xf0) === 0x90 && m[2]! > 0) {
            if (pending) {
              out.set(`${t}:${m[1]}`, pending);
            }
            pending = null;
          }
        }
      }
    }
  } catch {
    return new Map();
  }
  return out;
}

export function _tempo_map(
  header: Uint8Array,
  tracks: Map<number, DecodedRawEvent[]>,
): (tick: number) => number {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const division = view.getInt16(4, false);
  if (division < 0) {
    const fps = -((division >> 8) & 0xff);
    const tpf = division & 0xff;
    return (tick: number) => tick / (fps * tpf);
  }

  const tempos: Array<[number, number]> = [[0, 500000]];
  const minTrackIdx = tracks.size > 0 ? Math.min(...tracks.keys()) : -1;
  const first = minTrackIdx >= 0 ? tracks.get(minTrackIdx)! : [];
  for (const [t, kind, p] of first) {
    if (kind === "meta") {
      const [typ, data] = p as [number, Uint8Array];
      if (typ === 0x51 && data.length >= 3) {
        const us = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
        if (t === 0) {
          tempos[0] = [0, us];
        } else if (us !== tempos[tempos.length - 1]![1]) {
          tempos.push([t, us]);
        }
      }
    }
  }

  const starts: number[] = [];
  const secs: number[] = [];
  let s = 0.0;
  for (let i = 0; i < tempos.length; i += 1) {
    const [t, us] = tempos[i]!;
    if (i > 0) {
      s += ((t - tempos[i - 1]![0]) * tempos[i - 1]![1]) / 1e6 / division;
    }
    starts.push(t);
    secs.push(s);
  }

  return (tick: number): number => {
    const i = bisectRight(starts, tick) - 1;
    const idx = Math.max(0, i);
    return secs[idx]! + ((tick - starts[idx]!) * tempos[idx]![1]) / 1e6 / division;
  };
}

export type ExportMidiDiagnostic = {
  code: "unmatched-document-note";
  noteId: string;
  message: string;
};

export function save_fingered_midi_bytes(
  sourceBytes: Uint8Array,
  notes: readonly (Note | Record<string, unknown>)[],
  fingers: ReadonlyMap<object | number, number | string | null> | Record<number, number | string | null>,
  noteIds?: ReadonlyMap<object, string>,
): [Uint8Array, number, ExportMidiDiagnostic[]] {
  const getFinger = (key: object | number): number | string | null => {
    if (fingers instanceof Map) {
      if (typeof key === "number") return fingers.get(key) ?? null;
      return (fingers as Map<object, number | string | null>).get(key) ?? null;
    }
    if (typeof key === "number" || typeof key === "string") {
      return (fingers as Record<number, number | string | null>)[key as number] ?? null;
    }
    return null;
  };

  const [header, chunks, tracks] = _smf_tracks(sourceBytes);
  const toSec = _tempo_map(header, tracks);

  const index = new Map<string, Array<Note | Record<string, unknown>>>();
  for (const n of notes) {
    const pitch = (typeof (n as Note).pitch === "number" ? (n as Note).pitch : Number((n as Record<string, unknown>).pitch)) || 0;
    const rawStart = (typeof (n as Note).start === "number" ? (n as Note).start : Number((n as Record<string, unknown>).start || (n as Record<string, unknown>).startSeconds)) || 0;
    const key = `${pitch}:${Math.round(rawStart * 1000)}`;
    const list = index.get(key) ?? [];
    list.push(n);
    index.set(key, list);
  }

  function findNote(pitch: number, t: number): Note | Record<string, unknown> | null {
    const p = _fit_to_piano(pitch);
    const ms = Math.round(t * 1000);
    const deltas = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];
    for (const d of deltas) {
      const got = index.get(`${p}:${ms + d}`);
      if (got && got.length > 0) return got[0]!;
    }
    return null;
  }

  const piano = new Set<number>();
  const other = new Set<number>();
  for (const trackEvents of tracks.values()) {
    for (const [t, kind, p] of trackEvents) {
      if (kind === "midi") {
        const m = p as Uint8Array;
        if ((m[0]! & 0xf0) === 0x90 && m[2]! > 0) {
          const ch = m[0]! & 0x0f;
          if (findNote(m[1]!, toSec(t)) !== null) {
            piano.add(ch);
          } else {
            other.add(ch);
          }
        }
      }
    }
  }

  const rh_ch = piano.size > 0 ? Math.min(...piano) : 0;
  let lh_ch = rh_ch;
  for (let c = 0; c < 16; c += 1) {
    if (!other.has(c) && c !== rh_ch && c !== 9) {
      lh_ch = c;
      break;
    }
  }

  const hand_ch: Record<string, number> = {
    [RIGHT]: rh_ch,
    [LEFT]: lh_ch,
    right: rh_ch,
    left: lh_ch,
  };

  const marked = new Set<object>();
  const outChunks: Uint8Array[] = [];
  const headChunk = new Uint8Array(8 + header.length);
  headChunk.set([0x4d, 0x54, 0x68, 0x64], 0); // 'MThd'
  new DataView(headChunk.buffer, headChunk.byteOffset, headChunk.byteLength).setUint32(4, header.length, false);
  headChunk.set(header, 8);
  outChunks.push(headChunk);

  for (let i = 0; i < chunks.length; i += 1) {
    const [typ, td] = chunks[i]!;
    if (typ !== "MTrk") {
      const c = new Uint8Array(8 + td.length);
      for (let k = 0; k < 4; k += 1) c[k] = typ.charCodeAt(k);
      new DataView(c.buffer, c.byteOffset, c.byteLength).setUint32(4, td.length, false);
      c.set(td, 8);
      outChunks.push(c);
      continue;
    }

    const trackEvents = tracks.get(i) ?? [];
    const newEvents: DecodedRawEvent[] = [];
    const sounding = new Map<string, number[]>(); // `${fileCh}:${pitch}` -> [handCh, ...]

    for (const ev of trackEvents) {
      const [t, kind, p] = ev;
      if (kind === "meta") {
        const [metaTyp, metaData] = p as [number, Uint8Array];
        if (metaTyp === 0x01 && _marker(metaData)) {
          continue; // old fingering replaced
        }
      }
      if (kind === "midi") {
        const m = p as Uint8Array;
        const st = m[0]! & 0xf0;
        const ch = m[0]! & 0x0f;
        if (st === 0x90 && m[2]! > 0) {
          const n = findNote(m[1]!, toSec(t));
          if (n !== null) {
            let f = getFinger(n as object);
            if (f == null) {
              f = (n as Note).finger ?? (n as Record<string, unknown>)["finger"] as number | string | null;
            }
            const nGliss = Boolean((n as Note).gliss ?? (n as Record<string, unknown>)["gliss"] ?? (n as Record<string, unknown>)["glissando"]);
            const isGliss = f === "g" || nGliss;
            const hand = String((n as Note).hand ?? (n as Record<string, unknown>)["hand"] ?? "R");
            const handChar = hand === LEFT || hand === "L" || hand === "left" ? "L" : "R";

            let text: string;
            if (isGliss) {
              text = `${handChar}g`;
            } else if (f !== null && [1, 2, 3, 4, 5, "1", "2", "3", "4", "5"].includes(f as number)) {
              text = `${handChar}${f}`;
            } else {
              text = handChar;
            }

            const textBytes = new Uint8Array(Array.from(text).map((c) => c.charCodeAt(0)));
            newEvents.push([t, "meta", [0x01, textBytes]]);
            marked.add(n as object);

            const hc = hand_ch[hand] ?? ch;
            const sKey = `${ch}:${m[1]!}`;
            const stack = sounding.get(sKey) ?? [];
            stack.push(hc);
            sounding.set(sKey, stack);

            const modMsg = new Uint8Array(m);
            modMsg[0] = st | hc;
            newEvents.push([t, kind, modMsg]);
            continue;
          }
        } else if (st === 0x80 || st === 0x90) {
          const sKey = `${ch}:${m[1]!}`;
          const stack = sounding.get(sKey);
          if (stack && stack.length > 0) {
            const hc = stack.shift()!;
            const modMsg = new Uint8Array(m);
            modMsg[0] = st | hc;
            newEvents.push([t, kind, modMsg]);
            continue;
          }
        } else if (piano.has(ch) && [0xa0, 0xb0, 0xc0, 0xd0, 0xe0].includes(st)) {
          const uniqueHandChannels = Array.from(new Set([rh_ch, lh_ch])).sort((a, b) => a - b);
          for (const hc of uniqueHandChannels) {
            const modMsg = new Uint8Array(m);
            modMsg[0] = st | hc;
            newEvents.push([t, kind, modMsg]);
          }
          continue;
        }
      }
      newEvents.push(ev);
    }

    const encodedTrack = _encode(newEvents);
    const trackChunk = new Uint8Array(8 + encodedTrack.length);
    trackChunk.set([0x4d, 0x54, 0x72, 0x6b], 0); // 'MTrk'
    new DataView(trackChunk.buffer, trackChunk.byteOffset, trackChunk.byteLength).setUint32(4, encodedTrack.length, false);
    trackChunk.set(encodedTrack, 8);
    outChunks.push(trackChunk);
  }

  const totalLen = outChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of outChunks) {
    result.set(c, offset);
    offset += c.length;
  }
  const diagnostics: ExportMidiDiagnostic[] = [];
  const reported = new Set<string>();
  for (const note of notes) {
    if (marked.has(note as object)) continue;
    const mappedNoteId = noteIds?.get(note as object);
    const noteId = mappedNoteId ?? (note as { noteId?: unknown }).noteId;
    if (typeof noteId !== "string" || noteId.length === 0 || reported.has(noteId)) continue;
    reported.add(noteId);
    diagnostics.push({
      code: "unmatched-document-note",
      noteId,
      message: `Document note ${noteId} has no matching note-on in the source MIDI and was not marked.`,
    });
  }
  return [result, marked.size, diagnostics];
}

const PIANO_PROGRAMS = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const _PIANO_WORDS = [
  "piano", "klavier", "pianoforte", "solo", "keyboard", "clavier", "cembalo",
  "harpsichord", "right hand", "left hand", "rh", "lh", "pf", "pno",
];
const _OTHER_WORDS = [
  "violin", "violini", "viola", "viole", "cello", "violoncell", "contrabass", "double bass",
  "bass", "flute", "flaut", "oboe", "oboi", "clarinet", "clarinett", "bassoon", "fagott",
  "horn", "corni", "corno", "trumpet", "tromba", "trombe", "trombone", "tuba", "timpani",
  "timp", "drum", "percussion", "strings", "string", "choir", "voice", "vocal", "soprano",
  "alto", "tenor", "guitar", "harp", "organ", "orchestra", "tutti", "ensemble",
];
export const SAME_ONSET_T = 0.005;

function _words(name: string): string[] {
  return (name || "").toLowerCase().match(/[a-z]+/g) ?? [];
}

export function is_piano_track(inst: { name: string; program: number }): boolean {
  const words = _words(inst.name);
  const text = words.join(" ");
  const named_piano = _PIANO_WORDS.some((w) => words.includes(w) || (w.includes(" ") && text.includes(w)));
  const named_other = _OTHER_WORDS.some((o) =>
    o.includes(" ") ? text.includes(o) : words.some((word) => word.startsWith(o))
  );
  if (named_piano) return true;
  return PIANO_PROGRAMS.has(inst.program) && !named_other;
}

export function _vlq_read(data: Uint8Array, i: number): [number, number] {
  let v = 0;
  let idx = i;
  for (let k = 0; k < 4; k += 1) {
    if (idx >= data.length) throw new RangeError("unexpected end reading VLQ");
    const b = data[idx]!;
    idx += 1;
    v = (v << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [v, idx];
  }
  return [v, idx];
}

const _DATA_LEN: Record<number, number> = {
  0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2,
};

export function repair_smf(data: Uint8Array): [Uint8Array, number] {
  let slice = data;
  if (
    slice.length < 4 ||
    slice[0] !== 0x4d || slice[1] !== 0x54 || slice[2] !== 0x68 || slice[3] !== 0x64
  ) {
    let j = -1;
    for (let k = 0; k <= slice.length - 4; k += 1) {
      if (slice[k] === 0x4d && slice[k + 1] === 0x54 && slice[k + 2] === 0x68 && slice[k + 3] === 0x64) {
        j = k;
        break;
      }
    }
    if (j < 0) {
      throw new Error("not a MIDI file");
    }
    slice = slice.subarray(j);
  }

  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  const hlen = view.getUint32(4, false);
  const fmt = view.getUint16(8, false);
  const division = view.getUint16(12, false);

  let i = 8 + hlen;
  const tracks: Uint8Array[] = [];
  let fixed = 0;

  while (i + 8 <= slice.length) {
    const cid = String.fromCharCode(slice[i]!, slice[i + 1]!, slice[i + 2]!, slice[i + 3]!);
    const clen = view.getUint32(i + 4, false);
    const body = slice.subarray(i + 8, i + 8 + clen);
    i += 8 + clen;
    if (cid !== "MTrk") continue;

    const outPieces: Uint8Array[] = [];
    let j = 0;
    let carry = 0;
    let status: number | null = null;

    while (j < body.length) {
      try {
        const [delta, nextJ] = _vlq_read(body, j);
        j = nextJ;
        if (j >= body.length) break;
        const b = body[j]!;
        if (b === 0xff) {
          if (j + 1 >= body.length) break;
          const mtype = body[j + 1]!;
          const [mlen, k] = _vlq_read(body, j + 2);
          const payload = body.subarray(k, k + mlen);
          j = k + mlen;

          const ok =
            (mtype >= 0x01 && mtype <= 0x07) ||
            mtype === 0x03 ||
            (mtype === 0x51 && mlen === 3 && ((payload[0]! << 16) | (payload[1]! << 8) | payload[2]!) > 0) ||
            (mtype === 0x58 && mlen === 4 && payload[0]! > 0 && payload[1]! <= 6) ||
            (mtype === 0x59 && mlen === 2 && payload[0]! >= -7 && payload[0]! <= 7 && (payload[1] === 0 || payload[1] === 1));

          if (mtype === 0x2f) break;

          if (ok && payload.length === mlen) {
            outPieces.push(_write_vlq(delta + carry));
            outPieces.push(new Uint8Array([0xff, mtype]));
            outPieces.push(_write_vlq(mlen));
            outPieces.push(payload);
            carry = 0;
          } else {
            carry += delta;
            fixed += 1;
          }
          continue;
        }
        if (b === 0xf0 || b === 0xf7) {
          const [slen, k] = _vlq_read(body, j + 1);
          j = k + slen;
          carry += delta;
          fixed += 1;
          continue;
        }
        if ((b & 0x80) !== 0) {
          status = b;
          j += 1;
        }
        if (status === null || status >= 0xf0) {
          throw new RangeError("no status");
        }
        const n = _DATA_LEN[status >> 4] ?? 2;
        if (j + n > body.length) {
          throw new RangeError("truncated body");
        }
        const vals = Array.from(body.subarray(j, j + n));
        j += n;
        for (let idx = 0; idx < vals.length; idx += 1) {
          if (vals[idx]! > 127) {
            vals[idx] = Math.min(vals[idx]!, 127);
            fixed += 1;
          }
        }
        outPieces.push(_write_vlq(delta + carry));
        outPieces.push(new Uint8Array([status, ...vals]));
        carry = 0;
      } catch {
        fixed += 1;
        break;
      }
    }

    outPieces.push(new Uint8Array([0x00, 0xff, 0x2f, 0x00]));
    const totalTrackLen = outPieces.reduce((sum, p) => sum + p.length, 0);
    const trackBytes = new Uint8Array(totalTrackLen);
    let trackOff = 0;
    for (const p of outPieces) {
      trackBytes.set(p, trackOff);
      trackOff += p.length;
    }
    tracks.push(trackBytes);
  }

  if (tracks.length === 0) {
    throw new Error("no tracks");
  }

  const head = new Uint8Array(14);
  head.set([0x4d, 0x54, 0x68, 0x64], 0);
  const headView = new DataView(head.buffer);
  headView.setUint32(4, 6, false);
  headView.setUint16(8, tracks.length > 1 ? 1 : fmt, false);
  headView.setUint16(10, tracks.length, false);
  headView.setUint16(12, division, false);

  const finalPieces: Uint8Array[] = [head];
  for (const t of tracks) {
    const chunkHeader = new Uint8Array(8);
    chunkHeader.set([0x4d, 0x54, 0x72, 0x6b], 0);
    new DataView(chunkHeader.buffer).setUint32(4, t.length, false);
    finalPieces.push(chunkHeader, t);
  }

  const finalLen = finalPieces.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(finalLen);
  let off = 0;
  for (const p of finalPieces) {
    out.set(p, off);
    off += p.length;
  }
  return [out, fixed];
}

export class PrettyMidiNote {
  velocity: number;
  pitch: number;
  start: number;
  end: number;

  constructor(velocity: number, pitch: number, start: number, end: number) {
    this.velocity = velocity;
    this.pitch = pitch;
    this.start = start;
    this.end = end;
  }
}

export class PrettyMidiControlChange {
  number: number;
  value: number;
  time: number;

  constructor(number: number, value: number, time: number) {
    this.number = number;
    this.value = value;
    this.time = time;
  }
}

export class PrettyMidiPitchBend {
  pitch: number;
  time: number;

  constructor(pitch: number, time: number) {
    this.pitch = pitch;
    this.time = time;
  }
}

export class PrettyMidiInstrument {
  program: number;
  is_drum: boolean;
  name: string;
  notes: PrettyMidiNote[];
  control_changes: PrettyMidiControlChange[];
  pitch_bends: PrettyMidiPitchBend[];

  constructor(program: number, is_drum = false, name = "") {
    this.program = program;
    this.is_drum = is_drum;
    this.name = name;
    this.notes = [];
    this.control_changes = [];
    this.pitch_bends = [];
  }
}

export class PrettyMIDI {
  resolution: number;
  instruments: PrettyMidiInstrument[];
  private _tick_scales: Array<[number, number]>;
  private _starts: number[];
  private _secs: number[];

  constructor(data: Uint8Array) {
    if (data.length < 14) {
      const err = new Error();
      err.name = "EOFError";
      throw err;
    }
    const tag = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
    if (tag !== "MThd") {
      const err = new Error("MThd not found. Probably not a MIDI file");
      err.name = "OSError";
      throw err;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const hl = view.getUint32(4, false);
    if (hl < 6) {
      const err = new Error();
      err.name = "EOFError";
      throw err;
    }
    const [, validatedChunks] = _chunks(data);
    for (const [chunkTag, chunkBody] of validatedChunks) {
      if (chunkTag === "MTrk") _events(chunkBody);
    }
    const division = view.getInt16(12, false);
    if (division <= 0) {
      throw new Error("unsupported SMPTE division in PrettyMIDI");
    }
    this.resolution = division;

    let i = 8 + hl;
    const tracks: Array<Array<{ type: string; time: number; [key: string]: unknown }>> = [];
    while (i + 8 <= data.length) {
      const chunkTag = String.fromCharCode(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!);
      const chunkLen = view.getUint32(i + 4, false);
      const chunkBody = data.subarray(i + 8, i + 8 + chunkLen);
      i += 8 + chunkLen;
      if (chunkTag !== "MTrk") continue;

      let j = 0;
      let tick = 0;
      let run: number | null = null;
      const trackEvents: Array<{ type: string; time: number; [key: string]: unknown }> = [];

      while (j < chunkBody.length) {
        let dt = 0;
        let b = 0;
        for (let k = 0; k < 4; k += 1) {
          if (j >= chunkBody.length) {
            const err = new Error();
            err.name = "EOFError";
            throw err;
          }
          b = chunkBody[j]!;
          j += 1;
          dt = (dt << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        tick += dt;
        if (j >= chunkBody.length) break;
        b = chunkBody[j]!;
        if (b === 0xff) {
          if (j + 1 >= chunkBody.length) break;
          const typ = chunkBody[j + 1]!;
          let ln = 0;
          for (let k = 0; k < 4; k += 1) {
            if (j + 2 >= chunkBody.length) break;
            const lb = chunkBody[j + 2]!;
            j += 1;
            ln = (ln << 7) | (lb & 0x7f);
            if ((lb & 0x80) === 0) break;
          }
          j += 2;
          const payload = chunkBody.subarray(j, j + ln);
          j += ln;

          if (typ === 0x03) {
            trackEvents.push({ type: "track_name", time: tick, name: new TextDecoder().decode(payload) });
          } else if (typ === 0x51 && payload.length >= 3) {
            const tempo = (payload[0]! << 16) | (payload[1]! << 8) | payload[2]!;
            trackEvents.push({ type: "set_tempo", time: tick, tempo });
          }
          continue;
        }
        if (b === 0xf0 || b === 0xf7) {
          let ln = 0;
          for (let k = 0; k < 4; k += 1) {
            if (j + 1 >= chunkBody.length) break;
            const lb = chunkBody[j + 1]!;
            j += 1;
            ln = (ln << 7) | (lb & 0x7f);
            if ((lb & 0x80) === 0) break;
          }
          j += 1 + ln;
          continue;
        }
        if ((b & 0x80) !== 0) {
          run = b;
          j += 1;
        }
        if (run === null) {
          throw new Error("MIDI data without a status byte");
        }
        const st = run & 0xf0;
        const ch = run & 0x0f;
        if (st === 0x90) {
          const note = chunkBody[j]!;
          const velocity = chunkBody[j + 1]!;
          j += 2;
          if (velocity > 0) {
            trackEvents.push({ type: "note_on", time: tick, channel: ch, note, velocity });
          } else {
            trackEvents.push({ type: "note_off", time: tick, channel: ch, note, velocity: 0 });
          }
        } else if (st === 0x80) {
          const note = chunkBody[j]!;
          const velocity = chunkBody[j + 1]!;
          j += 2;
          trackEvents.push({ type: "note_off", time: tick, channel: ch, note, velocity });
        } else if (st === 0xb0) {
          const control = chunkBody[j]!;
          const value = chunkBody[j + 1]!;
          j += 2;
          trackEvents.push({ type: "control_change", time: tick, channel: ch, control, value });
        } else if (st === 0xc0) {
          const program = chunkBody[j]!;
          j += 1;
          trackEvents.push({ type: "program_change", time: tick, channel: ch, program });
        } else if (st === 0xe0) {
          const lsb = chunkBody[j]!;
          const msb = chunkBody[j + 1]!;
          j += 2;
          const pitch = ((msb << 7) | lsb) - 8192;
          trackEvents.push({ type: "pitchwheel", time: tick, channel: ch, pitch });
        } else if (st === 0xa0) {
          j += 2;
        } else if (st === 0xd0) {
          j += 1;
        }
      }
      tracks.push(trackEvents);
    }

    this._tick_scales = [[0, 60.0 / (120.0 * this.resolution)]];
    if (tracks.length > 0) {
      for (const ev of tracks[0]!) {
        if (ev.type === "set_tempo") {
          const tempo = ev.tempo as number;
          if (ev.time === 0) {
            const bpm = 6e7 / tempo;
            this._tick_scales = [[0, 60.0 / (bpm * this.resolution)]];
          } else {
            const lastTickScale = this._tick_scales[this._tick_scales.length - 1]![1];
            const bpm = 6e7 / tempo;
            const tickScale = 60.0 / (bpm * this.resolution);
            if (tickScale !== lastTickScale) {
              this._tick_scales.push([ev.time, tickScale]);
            }
          }
        }
      }
    }

    this._starts = [];
    this._secs = [];
    let s = 0;
    for (let idx = 0; idx < this._tick_scales.length; idx += 1) {
      const [t, scale] = this._tick_scales[idx]!;
      if (idx > 0) {
        s += (t - this._tick_scales[idx - 1]![0]) * this._tick_scales[idx - 1]![1];
      }
      this._starts.push(t);
      this._secs.push(s);
    }

    this.instruments = [];
    const instrumentMap = new Map<string, PrettyMidiInstrument>();
    const stragglers = new Map<string, PrettyMidiInstrument>();
    const trackNameMap = new Map<number, string>();

    const getInstrument = (program: number, channel: number, trackIdx: number, createNew: boolean): PrettyMidiInstrument => {
      const key = `${program}:${channel}:${trackIdx}`;
      const existing = instrumentMap.get(key);
      if (existing) return existing;
      const stragglerKey = `${channel}:${trackIdx}`;
      if (!createNew && stragglers.has(stragglerKey)) {
        return stragglers.get(stragglerKey)!;
      }
      if (createNew) {
        const isDrum = channel === 9;
        const instName = trackNameMap.get(trackIdx) ?? "";
        const inst = new PrettyMidiInstrument(program, isDrum, instName);
        if (stragglers.has(stragglerKey)) {
          const str = stragglers.get(stragglerKey)!;
          inst.control_changes = str.control_changes;
          inst.pitch_bends = str.pitch_bends;
        }
        instrumentMap.set(key, inst);
        this.instruments.push(inst);
        return inst;
      }
      const instName = trackNameMap.get(trackIdx) ?? "";
      const inst = new PrettyMidiInstrument(program, channel === 9, instName);
      stragglers.set(stragglerKey, inst);
      return inst;
    };

    for (let trackIdx = 0; trackIdx < tracks.length; trackIdx += 1) {
      const track = tracks[trackIdx]!;
      const lastNoteOn = new Map<string, Array<[number, number]>>();
      const currentInstrument = new Array<number>(16).fill(0);

      for (const event of track) {
        if (event.type === "track_name") {
          trackNameMap.set(trackIdx, event.name as string);
        } else if (event.type === "program_change") {
          currentInstrument[event.channel as number] = event.program as number;
        } else if (event.type === "note_on" && (event.velocity as number) > 0) {
          const noteKey = `${event.channel}:${event.note}`;
          const list = lastNoteOn.get(noteKey) ?? [];
          list.push([event.time, event.velocity as number]);
          lastNoteOn.set(noteKey, list);
        } else if (event.type === "note_off" || (event.type === "note_on" && (event.velocity as number) === 0)) {
          const noteKey = `${event.channel}:${event.note}`;
          const openNotes = lastNoteOn.get(noteKey);
          if (openNotes && openNotes.length > 0) {
            const endTick = event.time;
            const notesToClose = openNotes.filter(([startTick]) => startTick !== endTick);
            const notesToKeep = openNotes.filter(([startTick]) => startTick === endTick);

            for (const [startTick, velocity] of notesToClose) {
              const startTime = this.tick_to_time(startTick);
              const endTime = this.tick_to_time(endTick);
              const pmNote = new PrettyMidiNote(velocity, event.note as number, startTime, endTime);
              const program = currentInstrument[event.channel as number] ?? 0;
              const inst = getInstrument(program, event.channel as number, trackIdx, true);
              inst.notes.push(pmNote);
            }

            if (notesToClose.length > 0 && notesToKeep.length > 0) {
              lastNoteOn.set(noteKey, notesToKeep);
            } else if (notesToClose.length > 0) {
              lastNoteOn.delete(noteKey);
            }
          }
        } else if (event.type === "pitchwheel") {
          const bend = new PrettyMidiPitchBend(event.pitch as number, this.tick_to_time(event.time));
          const program = currentInstrument[event.channel as number] ?? 0;
          const inst = getInstrument(program, event.channel as number, trackIdx, false);
          inst.pitch_bends.push(bend);
        } else if (event.type === "control_change") {
          const cc = new PrettyMidiControlChange(event.control as number, event.value as number, this.tick_to_time(event.time));
          const program = currentInstrument[event.channel as number] ?? 0;
          const inst = getInstrument(program, event.channel as number, trackIdx, false);
          inst.control_changes.push(cc);
        }
      }
    }
  }

  tick_to_time(tick: number): number {
    const idx = bisectRight(this._starts, tick) - 1;
    const i = Math.max(0, idx);
    return this._secs[i]! + (tick - this._starts[i]!) * this._tick_scales[i]![1];
  }

  get_tempo_changes(): [number[], number[]] {
    const times: number[] = [];
    const tempi: number[] = [];
    for (const [tick, tickScale] of this._tick_scales) {
      times.push(this.tick_to_time(tick));
      tempi.push(60.0 / (tickScale * this.resolution));
    }
    return [times, tempi];
  }

  get_downbeats(): number[] {
    return [];
  }

  get_beats(): number[] {
    return [];
  }
}

export function read_midi(source: Uint8Array): [PrettyMIDI, string[]] {
  try {
    return [new PrettyMIDI(source), []];
  } catch (first) {
    try {
      const [clean, fixed] = repair_smf(source);
      const pm = new PrettyMIDI(clean);
      return [pm, [`repaired the file after: ${first} (${fixed} event(s) dropped or fixed)`]];
    } catch {
      throw first;
    }
  }
}

export function sanitize_instruments(
  pm: PrettyMIDI,
  include_drums = false,
): [Array<[number, PrettyMidiInstrument]>, string[]] {
  const report: string[] = [];
  let insts: Array<[number, PrettyMidiInstrument]> = [];
  for (let i = 0; i < pm.instruments.length; i += 1) {
    const inst = pm.instruments[i]!;
    if (inst.notes.length > 0) {
      insts.push([i, inst]);
    }
  }

  if (!include_drums) {
    const drums = insts.filter(([, inst]) => inst.is_drum);
    if (drums.length > 0) {
      report.push(`dropped ${drums.length} percussion track(s)`);
    }
    insts = insts.filter(([, inst]) => !inst.is_drum);
  }

  const piano = insts.filter(([, inst]) => is_piano_track(inst));
  if (piano.length > 0 && piano.length < insts.length) {
    const others = insts.filter(([, inst]) => !piano.some((p) => p[1] === inst)).map(([i, inst]) => inst.name || `track ${i}`);
    const suffix = piano.length > 1 ? "s" : "";
    const pianoNames = piano.map(([i, inst]) => inst.name || `track ${i}`).join(", ");
    const otherNames = others.slice(0, 8).join(", ") + (others.length > 8 ? ", ..." : "");
    report.push(`kept the piano part${suffix} (${pianoNames}), dropped ${others.length} other instrument track(s): ${otherNames}`);
    insts = piano;
  }
  return [insts, report];
}

export function sanitize_notes(notes: readonly Note[], min_duration = 0.05): [Note[], string[]] {
  const report: string[] = [];
  const ok = notes.filter((n) => Number.isFinite(n.start) && Number.isFinite(n.end) && n.end >= n.start);
  if (ok.length < notes.length) {
    report.push(`dropped ${notes.length - ok.length} note(s) with impossible times`);
  }

  let t0 = 0.0;
  if (ok.length > 0) {
    t0 = Math.min(...ok.map((n) => n.start));
  }
  let shiftedNotes = ok;
  if (t0 < 0) {
    shiftedNotes = ok.map(
      (n) => new Note(n.pitch, n.start - t0, n.end - t0, n.velocity, n.track, n.hand, n.finger, n.gliss, n.source_ids, n.source_events),
    );
    report.push(`shifted everything ${(-t0).toFixed(3)} s later (the file started before 0)`);
  }

  let fixed = 0;
  const clamped: Note[] = [];
  for (const n of shiftedNotes) {
    const v = Math.min(127, Math.max(1, Math.trunc(n.velocity)));
    const p = _fit_to_piano(Math.trunc(n.pitch));
    const end = Math.max(n.end, n.start + min_duration);
    if (v !== n.velocity || p !== n.pitch || end !== n.end) {
      if (v !== n.velocity || p !== n.pitch) fixed += 1;
      clamped.push(new Note(p, n.start, end, v, n.track, n.hand, n.finger, n.gliss, n.source_ids, n.source_events));
    } else {
      clamped.push(n);
    }
  }
  if (fixed > 0) {
    report.push(`brought ${fixed} velocit(ies) / pitch(es) into range`);
  }

  const byPitch = new Map<number, Note[]>();
  const sortedClamped = [...clamped].sort((a, b) => a.pitch - b.pitch || a.start - b.start || b.end - a.end);
  for (const n of sortedClamped) {
    const list = byPitch.get(n.pitch) ?? [];
    list.push(n);
    byPitch.set(n.pitch, list);
  }

  const result: Note[] = [];
  let dup = 0;
  let cut = 0;

  for (const ns of byPitch.values()) {
    const kept: Note[] = [];
    for (const n of ns) {
      if (kept.length > 0 && Math.abs(n.start - kept[kept.length - 1]!.start) <= SAME_ONSET_T) {
        dup += 1;
        const prior = kept[kept.length - 1]!;
        const aliases = Array.from(new Set([...prior.source_ids, ...n.source_ids]));
        const events: SourceEventLocator[] = [...prior.source_events];
        for (const e of n.source_events) {
          if (!events.some((ex) => ex.midiTrackIndex === e.midiTrackIndex && ex.channel === e.channel && ex.noteOnOrdinal === e.noteOnOrdinal)) {
            events.push(e);
          }
        }
        kept[kept.length - 1] = new Note(
          prior.pitch,
          prior.start,
          Math.max(prior.end, n.end),
          prior.velocity,
          prior.track,
          prior.hand,
          prior.finger,
          prior.gliss,
          aliases,
          events,
        );
        continue;
      }
      if (kept.length > 0 && n.start < kept[kept.length - 1]!.end) {
        const prior = kept[kept.length - 1]!;
        kept[kept.length - 1] = new Note(
          prior.pitch,
          prior.start,
          Math.max(prior.start + 1e-3, n.start),
          prior.velocity,
          prior.track,
          prior.hand,
          prior.finger,
          prior.gliss,
          prior.source_ids,
          prior.source_events,
        );
        cut += 1;
      }
      kept.push(n);
    }
    result.push(...kept);
  }

  if (dup > 0) report.push(`merged ${dup} doubled note(s)`);
  if (cut > 0) report.push(`ended ${cut} note(s) where their key is struck again`);
  return [result, report];
}

export function load_midi(
  path: Uint8Array,
  options?: {
    include_drums?: boolean;
    split_pitch?: number;
    min_duration?: number;
    fixture_id?: string | null;
    source_event_map?: Map<string, SourceEventLocator> | Record<string, SourceEventLocator> | null;
    pianist_context?: Pianist | null;
    decoded?: [PrettyMIDI, string[]] | null;
  },
): MidiSong {
  const include_drums = options?.include_drums ?? false;
  const split_pitch = options?.split_pitch ?? MIDDLE_C;
  const min_duration = options?.min_duration ?? 0.05;
  const fixture_id = options?.fixture_id ?? "Untitled";
  const source_event_map = options?.source_event_map ?? null;
  const pianist_context = options?.pianist_context ?? null;

  const [pm, initialReport] = options?.decoded ?? read_midi(path);
  const report = [...initialReport];

  const [instruments, rInst] = sanitize_instruments(pm, include_drums);
  report.push(...rInst);

  const track_hand = new Map<number, string | null>();
  for (const [i, inst] of instruments) {
    track_hand.set(i, _hand_from_name(inst.name));
  }
  const all_named = Array.from(track_hand.values()).every((h) => h !== null);
  if (!all_named) {
    for (const [i] of instruments) track_hand.set(i, null);
    if (instruments.length === 2) {
      const [ia, a] = instruments[0]!;
      const [ib, b] = instruments[1]!;
      const mean_a = a.notes.reduce((sum, n) => sum + n.pitch, 0) / Math.max(1, a.notes.length);
      const mean_b = b.notes.reduce((sum, n) => sum + n.pitch, 0) / Math.max(1, b.notes.length);
      if (Math.abs(mean_a - mean_b) >= 7) {
        if (mean_a >= mean_b) {
          track_hand.set(ia, RIGHT);
          track_hand.set(ib, LEFT);
        } else {
          track_hand.set(ia, LEFT);
          track_hand.set(ib, RIGHT);
        }
      }
    }
  }

  let marks = new Map<string, [string | null, number | "g"] | [string, null]>();
  try {
    for (const [key, hf] of read_markers(path)) {
      const [tStr, pStr] = key.split(":");
      const t = parseFloat(tStr!);
      const p = parseInt(pStr!, 10);
      marks.set(`${rounded(pm.tick_to_time(t), 4)}:${p}`, hf);
    }
  } catch {
    marks = new Map();
  }

  let rawNotes: Note[] = [];
  const tracks: TrackInfo[] = [];
  const marked = new Set<string>();

  for (const [i, inst] of instruments) {
    for (let noteIndex = 0; noteIndex < inst.notes.length; noteIndex += 1) {
      const n = inst.notes[noteIndex]!;
      const markKey = `${rounded(n.start, 4)}:${n.pitch}`;
      const mark = marks.get(markKey);
      const mark_hand = mark ? mark[0] : null;
      const finger = mark && typeof mark[1] === "number" ? mark[1] : null;
      const gl = mark ? mark[1] === "g" : false;

      if (mark_hand) {
        marked.add(`${n.start}:${_fit_to_piano(n.pitch)}`);
      }

      const sourceId = fixture_id ? `${fixture_id}/instrument-${i}/note-${String(noteIndex).padStart(6, "0")}` : null;
      const eventKey = `${i}:${noteIndex}`;
      let sourceEvent: SourceEventLocator | undefined;
      if (source_event_map) {
        if (source_event_map instanceof Map) {
          sourceEvent = source_event_map.get(eventKey);
        } else {
          sourceEvent = (source_event_map as Record<string, SourceEventLocator>)[eventKey];
        }
      }

      rawNotes.push(
        new Note(
          Math.trunc(n.pitch),
          n.start,
          n.end,
          Math.trunc(n.velocity),
          i,
          mark_hand || track_hand.get(i) || null,
          gl ? null : finger,
          gl,
          sourceId ? [sourceId] : [],
          sourceEvent ? [sourceEvent] : [],
        ),
      );
    }
    tracks.push(new TrackInfo(i, inst.name || `Track ${i}`, inst.program, inst.notes.length, track_hand.get(i) ?? null));
  }

  const [sanitizedNotes, rNotes] = sanitize_notes(rawNotes, min_duration);
  report.push(...rNotes);
  rawNotes = sanitizedNotes;

  const loose = rawNotes.filter((n) => !marked.has(`${n.start}:${n.pitch}`));
  if (loose.length > 0) {
    const preferMap = new Map<number, string>();
    for (const n of loose) {
      if (n.hand) preferMap.set(objId(n), n.hand);
    }
    const handAssignments = split_hands(loose, pianist_context, preferMap);
    let moved = 0;
    for (const n of loose) {
      if (n.hand && handAssignments.has(objId(n)) && handAssignments.get(objId(n)) !== n.hand) {
        moved += 1;
      }
    }
    if (moved > 0) {
      report.push(`gave ${moved} note(s) to the other hand than their track's, which couldn't keep up`);
    }
    rawNotes = rawNotes.map((n) => {
      const assigned = handAssignments.get(objId(n));
      if (assigned && assigned !== n.hand) {
        return new Note(n.pitch, n.start, n.end, n.velocity, n.track, assigned, n.finger, n.gliss, n.source_ids, n.source_events);
      }
      return n;
    });
  }

  const controls: Array<[number, number, number]> = [];
  for (const inst of pm.instruments) {
    if (inst.is_drum) continue;
    for (const cc of inst.control_changes) {
      if (PEDALS.includes(cc.number as 64 | 66 | 67)) {
        controls.push([cc.time, cc.number, cc.value]);
      }
    }
  }

  const duration = rawNotes.reduce((max, n) => Math.max(max, n.end), 0.0);
  const song = new MidiSong(rawNotes, tracks, duration, [], [], fixture_id, controls);
  song.cleanup = report;
  return song;
}

export const loadMidi = load_midi;
export const load_song = load_midi;
