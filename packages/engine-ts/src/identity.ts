/**
 * identity.ts - Raw SMF event observation and conservative decoded-note mapping.
 *
 * Ported 1-to-1 from python-core/handthesia_core/identity.py.
 */

import { rounded } from "./pythonCompat.ts";
import type { PrettyMIDI } from "./midiLoader.ts";

export interface SourceNoteRecord {
  noteId: string;
  sourceInstrument: number;
  sourceOrdinal: number;
  pitch: number;
  start: number;
  end: number;
  velocity: number;
  sourceEvent?: SourceEventRecord;
}

export interface SourceEventRecord {
  midiTrackIndex: number;
  channel: number;
  noteOnOrdinal: number;
  noteOffOrdinal: number;
}

export interface SourcePedalRecord {
  track: number;
  tick: number;
  time: number;
  controller: number;
  value: number;
}

export interface SourceParseError {
  phase: string;
  type: string;
  message: string;
}

export interface ObservedSource {
  sourceNotes: SourceNoteRecord[];
  sourcePedals: SourcePedalRecord[];
  eventBySourceId: Record<string, SourceEventRecord>;
  ambiguousSourceIds: string[];
  rawEventCount: number;
  sourceParseErrors: SourceParseError[];
}

interface RawNoteRecord {
  midiTrackIndex: number;
  channel: number;
  noteOnOrdinal: number;
  pitch: number;
  velocity: number;
  startTick: number;
  ambiguous: boolean;
  noteOffOrdinal?: number;
  endTick?: number;
  start?: number;
  end?: number;
}

function _readVlqStrict(bytes: Uint8Array, startOffset: number): [number, number] {
  let value = 0;
  let offset = startOffset;
  for (let step = 0; step < 4; step += 1) {
    if (offset >= bytes.length) {
      const err = new Error("unexpected end of file");
      err.name = "EOFError";
      throw err;
    }
    const byte = bytes[offset++]!;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return [value, offset];
    }
  }
  const err = new Error("invalid variable-length quantity in MIDI stream");
  err.name = "ValueError";
  throw err;
}

interface StrictParsedEvent {
  kind: "meta" | "sysex" | "midi";
  status: number;
  channel: number;
  type: string;
  note?: number;
  velocity?: number;
  control?: number;
  value?: number;
  rawBytes: Uint8Array;
}

function _parseSmfStrict(data: Uint8Array): {
  tracks: StrictParsedEvent[][];
  rawEventCount: number;
} {
  if (data.length < 14) {
    const err = new Error("data too short for SMF header");
    err.name = data.length === 0 ? "EOFError" : "ValueError";
    throw err;
  }

  const tag = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
  if (tag !== "MThd") {
    const err = new Error("not a standard MIDI file");
    err.name = "OSError";
    throw err;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLen = view.getUint32(4, false);
  if (headerLen < 6 || 8 + headerLen > data.length) {
    const err = new Error("invalid SMF header length");
    err.name = "ValueError";
    throw err;
  }

  const numTracks = view.getUint16(10, false);
  let offset = 8 + headerLen;

  const tracks: StrictParsedEvent[][] = [];
  let totalRawEvents = 0;

  for (let tIdx = 0; tIdx < numTracks; tIdx += 1) {
    if (offset + 8 > data.length) {
      const err = new Error("unexpected end of file before track header");
      err.name = "EOFError";
      throw err;
    }

    const chunkTag = String.fromCharCode(
      data[offset]!,
      data[offset + 1]!,
      data[offset + 2]!,
      data[offset + 3]!,
    );
    const chunkLen = view.getUint32(offset + 4, false);
    offset += 8;

    if (offset + chunkLen > data.length) {
      const err = new Error("unexpected end of file in track body");
      err.name = "EOFError";
      throw err;
    }

    if (chunkTag !== "MTrk") {
      // Non-MTrk chunk: skip
      offset += chunkLen;
      continue;
    }

    const trackBody = data.subarray(offset, offset + chunkLen);
    offset += chunkLen;

    const events: StrictParsedEvent[] = [];
    let j = 0;
    let runningStatus: number | null = null;

    while (j < trackBody.length) {
      const [, nextJ] = _readVlqStrict(trackBody, j);
      j = nextJ;
      if (j >= trackBody.length) break;

      const firstByte = trackBody[j]!;
      if (firstByte === 0xff) {
        // Meta event
        if (j + 1 >= trackBody.length) {
          const err = new Error("truncated meta event");
          err.name = "EOFError";
          throw err;
        }
        const metaType = trackBody[j + 1]!;
        const [metaLen, dataStart] = _readVlqStrict(trackBody, j + 2);
        if (dataStart + metaLen > trackBody.length) {
          const err = new Error("unexpected end of meta event data");
          err.name = "EOFError";
          throw err;
        }
        events.push({
          kind: "meta",
          status: 0xff,
          channel: -1,
          type: "meta",
          rawBytes: trackBody.subarray(j, dataStart + metaLen),
        });
        j = dataStart + metaLen;
        runningStatus = null;
        continue;
      }

      if (firstByte === 0xf0 || firstByte === 0xf7) {
        // SysEx
        const [sysexLen, dataStart] = _readVlqStrict(trackBody, j + 1);
        if (dataStart + sysexLen > trackBody.length) {
          const err = new Error("unexpected end of sysex data");
          err.name = "EOFError";
          throw err;
        }
        events.push({
          kind: "sysex",
          status: firstByte,
          channel: -1,
          type: "sysex",
          rawBytes: trackBody.subarray(j, dataStart + sysexLen),
        });
        j = dataStart + sysexLen;
        runningStatus = null;
        continue;
      }

      let status = firstByte;
      if ((status & 0x80) !== 0) {
        runningStatus = status;
        j += 1;
      } else {
        if (runningStatus === null) {
          const err = new Error("MIDI data without a status byte");
          err.name = "ValueError";
          throw err;
        }
        status = runningStatus;
      }

      const statusNibble = status & 0xf0;
      const channel = status & 0x0f;
      const dataLen = statusNibble === 0xc0 || statusNibble === 0xd0 ? 1 : 2;
      if (j + dataLen > trackBody.length) {
        const err = new Error("unexpected end of MIDI message data");
        err.name = "EOFError";
        throw err;
      }

      const d1 = trackBody[j]!;
      const d2 = dataLen === 2 ? trackBody[j + 1]! : 0;
      j += dataLen;

      let type = "other";
      if (statusNibble === 0x80) type = "note_off";
      else if (statusNibble === 0x90) type = d2 === 0 ? "note_off" : "note_on";
      else if (statusNibble === 0xb0) type = "control_change";

      events.push({
        kind: "midi",
        status,
        channel,
        type,
        note: d1,
        velocity: d2,
        control: d1,
        value: d2,
        rawBytes: new Uint8Array([status, d1, ...(dataLen === 2 ? [d2] : [])]),
      });
    }

    tracks.push(events);
    totalRawEvents += events.length;
  }

  return { tracks, rawEventCount: totalRawEvents };
}

/**
 * Inventory decoded notes and raw events, mapping only unique matches.
 *
 * Event ordinals count mido's parsed messages (including meta messages) in
 * each original SMF track. Overlapping same-channel/same-pitch note pairs
 * are intentionally left unmapped because pairing their raw events would
 * otherwise require guessing.
 */
export function observe_source(
  data: Uint8Array,
  pm: PrettyMIDI | null,
  fixture_id: string,
): ObservedSource {
  const sourceNotes: SourceNoteRecord[] = [];
  const instruments = pm ? pm.instruments : [];
  for (let instrumentIndex = 0; instrumentIndex < instruments.length; instrumentIndex += 1) {
    const instrument = instruments[instrumentIndex]!;
    for (let noteIndex = 0; noteIndex < instrument.notes.length; noteIndex += 1) {
      const note = instrument.notes[noteIndex]!;
      sourceNotes.push({
        noteId: `${fixture_id}/instrument-${instrumentIndex}/note-${String(noteIndex).padStart(6, "0")}`,
        sourceInstrument: instrumentIndex,
        sourceOrdinal: noteIndex,
        pitch: Math.floor(note.pitch),
        start: rounded(note.start),
        end: rounded(note.end),
        velocity: Math.floor(note.velocity),
      });
    }
  }

  const rawNotes: RawNoteRecord[] = [];
  const sourcePedals: SourcePedalRecord[] = [];

  let parsedSmf: { tracks: StrictParsedEvent[][]; rawEventCount: number };
  try {
    parsedSmf = _parseSmfStrict(data);
  } catch (exc: unknown) {
    const error = exc as { name?: string; message?: string };
    return {
      sourceNotes,
      sourcePedals: [],
      eventBySourceId: {},
      ambiguousSourceIds: [],
      rawEventCount: 0,
      sourceParseErrors: [
        {
          phase: "mido source inventory",
          type: error.name || "Error",
          message: error.message || "",
        },
      ],
    };
  }

  const tracks = parsedSmf.tracks;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const track = tracks[trackIndex]!;
    let tick = 0;
    const active = new Map<string, RawNoteRecord[]>();

    for (let eventOrdinal = 0; eventOrdinal < track.length; eventOrdinal += 1) {
      const message = track[eventOrdinal]!;
      // Note: for strict SMF parsing, delta time was read into tick position
      // Let's ensure tick is accumulated
      // In _parseSmfStrict, let's keep track of tick for each event
    }
  }

  // To be completely accurate with ticks, let's track delta times directly
  return _observeWithParsedTracks(data, pm, fixture_id, sourceNotes);
}

function _observeWithParsedTracks(
  data: Uint8Array,
  pm: PrettyMIDI | null,
  fixture_id: string,
  sourceNotes: SourceNoteRecord[],
): ObservedSource {
  const rawNotes: RawNoteRecord[] = [];
  const sourcePedals: SourcePedalRecord[] = [];

  let parsed: {
    tracks: Array<Array<{
      deltaTick: number;
      kind: string;
      statusNibble: number;
      channel: number;
      type: string;
      note: number;
      velocity: number;
      control: number;
      value: number;
    }>>;
    rawEventCount: number;
  };

  try {
    if (data.length < 14) {
      const err = new Error("data too short for SMF header");
      err.name = data.length === 0 ? "EOFError" : "ValueError";
      throw err;
    }

    const tag = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
    if (tag !== "MThd") {
      const err = new Error("not a standard MIDI file");
      err.name = "OSError";
      throw err;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerLen = view.getUint32(4, false);
    if (headerLen < 6 || 8 + headerLen > data.length) {
      const err = new Error("invalid SMF header length");
      err.name = "ValueError";
      throw err;
    }

    const numTracks = view.getUint16(10, false);
    let offset = 8 + headerLen;

    const tracks: Array<Array<{
      deltaTick: number;
      kind: string;
      statusNibble: number;
      channel: number;
      type: string;
      note: number;
      velocity: number;
      control: number;
      value: number;
    }>> = [];
    let totalRawEvents = 0;

    for (let tIdx = 0; tIdx < numTracks; tIdx += 1) {
      if (offset + 8 > data.length) {
        const err = new Error("unexpected end of file before track header");
        err.name = "EOFError";
        throw err;
      }

      const chunkTag = String.fromCharCode(
        data[offset]!,
        data[offset + 1]!,
        data[offset + 2]!,
        data[offset + 3]!,
      );
      const chunkLen = view.getUint32(offset + 4, false);
      offset += 8;

      if (offset + chunkLen > data.length) {
        const err = new Error("unexpected end of file in track body");
        err.name = "EOFError";
        throw err;
      }

      if (chunkTag !== "MTrk") {
        offset += chunkLen;
        continue;
      }

      const trackBody = data.subarray(offset, offset + chunkLen);
      offset += chunkLen;

      const trackEvents: Array<{
        deltaTick: number;
        kind: string;
        statusNibble: number;
        channel: number;
        type: string;
        note: number;
        velocity: number;
        control: number;
        value: number;
      }> = [];

      let j = 0;
      let runningStatus: number | null = null;

      while (j < trackBody.length) {
        const [deltaTick, nextJ] = _readVlqStrict(trackBody, j);
        j = nextJ;
        if (j >= trackBody.length) break;

        const firstByte = trackBody[j]!;
        if (firstByte === 0xff) {
          if (j + 1 >= trackBody.length) {
            const err = new Error("truncated meta event");
            err.name = "EOFError";
            throw err;
          }
          const [metaLen, dataStart] = _readVlqStrict(trackBody, j + 2);
          if (dataStart + metaLen > trackBody.length) {
            const err = new Error("unexpected end of meta event data");
            err.name = "EOFError";
            throw err;
          }
          trackEvents.push({
            deltaTick,
            kind: "meta",
            statusNibble: 0xff,
            channel: -1,
            type: "meta",
            note: 0,
            velocity: 0,
            control: 0,
            value: 0,
          });
          j = dataStart + metaLen;
          runningStatus = null;
          continue;
        }

        if (firstByte === 0xf0 || firstByte === 0xf7) {
          const [sysexLen, dataStart] = _readVlqStrict(trackBody, j + 1);
          if (dataStart + sysexLen > trackBody.length) {
            const err = new Error("unexpected end of sysex data");
            err.name = "EOFError";
            throw err;
          }
          trackEvents.push({
            deltaTick,
            kind: "sysex",
            statusNibble: firstByte,
            channel: -1,
            type: "sysex",
            note: 0,
            velocity: 0,
            control: 0,
            value: 0,
          });
          j = dataStart + sysexLen;
          runningStatus = null;
          continue;
        }

        let status = firstByte;
        if ((status & 0x80) !== 0) {
          runningStatus = status;
          j += 1;
        } else {
          if (runningStatus === null) {
            const err = new Error("MIDI data without a status byte");
            err.name = "ValueError";
            throw err;
          }
          status = runningStatus;
        }

        const statusNibble = status & 0xf0;
        const channel = status & 0x0f;
        const dataLen = statusNibble === 0xc0 || statusNibble === 0xd0 ? 1 : 2;
        if (j + dataLen > trackBody.length) {
          const err = new Error("unexpected end of MIDI message data");
          err.name = "EOFError";
          throw err;
        }

        const d1 = trackBody[j]!;
        const d2 = dataLen === 2 ? trackBody[j + 1]! : 0;
        j += dataLen;

        let type = "other";
        if (statusNibble === 0x80) type = "note_off";
        else if (statusNibble === 0x90) type = d2 === 0 ? "note_off" : "note_on";
        else if (statusNibble === 0xb0) type = "control_change";

        trackEvents.push({
          deltaTick,
          kind: "midi",
          statusNibble,
          channel,
          type,
          note: d1,
          velocity: d2,
          control: d1,
          value: d2,
        });
      }

      tracks.push(trackEvents);
      totalRawEvents += trackEvents.length;
    }

    parsed = { tracks, rawEventCount: totalRawEvents };
  } catch (exc: unknown) {
    const error = exc as { name?: string; message?: string };
    return {
      sourceNotes,
      sourcePedals: [],
      eventBySourceId: {},
      ambiguousSourceIds: [],
      rawEventCount: 0,
      sourceParseErrors: [
        {
          phase: "mido source inventory",
          type: error.name || "Error",
          message: error.message || "",
        },
      ],
    };
  }

  for (let trackIndex = 0; trackIndex < parsed.tracks.length; trackIndex += 1) {
    const track = parsed.tracks[trackIndex]!;
    let tick = 0;
    const active = new Map<string, RawNoteRecord[]>();

    for (let eventOrdinal = 0; eventOrdinal < track.length; eventOrdinal += 1) {
      const message = track[eventOrdinal]!;
      tick += message.deltaTick;

      if (
        pm !== null &&
        message.type === "control_change" &&
        (message.control === 64 || message.control === 66 || message.control === 67)
      ) {
        sourcePedals.push({
          track: trackIndex,
          tick,
          time: rounded(pm.tick_to_time(tick)),
          controller: message.control,
          value: message.value,
        });
      }

      const key = `${message.channel}:${message.note}`;

      if (message.type === "note_on" && message.velocity > 0) {
        const activeList = active.get(key) ?? [];
        const isAmbiguous = activeList.length > 0;
        const record: RawNoteRecord = {
          midiTrackIndex: trackIndex,
          channel: message.channel,
          noteOnOrdinal: eventOrdinal,
          pitch: message.note,
          velocity: message.velocity,
          startTick: tick,
          ambiguous: isAmbiguous,
        };
        if (isAmbiguous) {
          for (const prior of activeList) {
            prior.ambiguous = true;
          }
        }
        activeList.push(record);
        active.set(key, activeList);
      } else if (
        message.type === "note_off" ||
        (message.type === "note_on" && message.velocity === 0)
      ) {
        const activeList = active.get(key) ?? [];
        if (activeList.length === 0) {
          continue;
        }
        const record = activeList.shift()!;
        record.noteOffOrdinal = eventOrdinal;
        record.endTick = tick;
        if (pm !== null) {
          record.start = rounded(pm.tick_to_time(record.startTick));
          record.end = rounded(pm.tick_to_time(tick));
          rawNotes.push(record);
        }
      }
    }
  }

  const rawBySignature = new Map<string, RawNoteRecord[]>();
  const ambiguousPitchVelocities = new Set<string>();

  for (const item of rawNotes) {
    if (item.ambiguous) {
      ambiguousPitchVelocities.add(`${item.pitch}:${item.velocity}`);
    }
    const signature = `${item.pitch}:${item.velocity}:${item.start!.toFixed(5)}:${item.end!.toFixed(5)}`;
    const list = rawBySignature.get(signature) ?? [];
    list.push(item);
    rawBySignature.set(signature, list);
  }

  const eventBySourceId: Record<string, SourceEventRecord> = {};
  const ambiguousSourceIds = new Set<string>();

  const decodedBySignature = new Map<string, SourceNoteRecord[]>();
  for (const item of sourceNotes) {
    const signature = `${item.pitch}:${item.velocity}:${item.start.toFixed(5)}:${item.end.toFixed(5)}`;
    const list = decodedBySignature.get(signature) ?? [];
    list.push(item);
    decodedBySignature.set(signature, list);
  }

  for (const item of sourceNotes) {
    const signature = `${item.pitch}:${item.velocity}:${item.start.toFixed(5)}:${item.end.toFixed(5)}`;
    const candidates = rawBySignature.get(signature) ?? [];
    const decodedCount = decodedBySignature.get(signature)?.length ?? 0;

    if (decodedCount === 1 && candidates.length === 1 && !candidates[0]!.ambiguous) {
      const raw = candidates[0]!;
      eventBySourceId[item.noteId] = {
        midiTrackIndex: raw.midiTrackIndex,
        channel: raw.channel,
        noteOnOrdinal: raw.noteOnOrdinal,
        noteOffOrdinal: raw.noteOffOrdinal!,
      };
    } else if (
      candidates.length > 0 ||
      decodedCount > 1 ||
      ambiguousPitchVelocities.has(`${item.pitch}:${item.velocity}`)
    ) {
      ambiguousSourceIds.add(item.noteId);
    }
  }

  for (const item of sourceNotes) {
    const raw = eventBySourceId[item.noteId];
    if (raw) {
      item.sourceEvent = { ...raw };
    }
  }

  return {
    sourceNotes,
    sourcePedals: sourcePedals.sort((a, b) => a.time - b.time || a.track - b.track || a.tick - b.tick),
    eventBySourceId,
    ambiguousSourceIds: Array.from(ambiguousSourceIds).sort(),
    rawEventCount: parsed.rawEventCount,
    sourceParseErrors: [],
  };
}
