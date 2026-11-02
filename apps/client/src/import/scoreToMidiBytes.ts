export const DEFAULT_SCORE_PPQ = 480;
export const DEFAULT_TEMPO_BPM = 120;

export type CanonicalHandHint = "right" | "left";

export interface CanonicalScoreNote {
  /** MIDI pitch 0..127 */
  pitch: number;
  /** Onset in ticks (at score.ppq) */
  startTick: number;
  /** Duration in ticks (>= 1) */
  durationTicks: number;
  /** MIDI velocity 1..127 */
  velocity?: number;
  /** Optional hand assignment ("right" | "left") */
  hand?: CanonicalHandHint;
  /** Optional finger number 1..5 */
  finger?: 1 | 2 | 3 | 4 | 5;
  /** Optional glissando flag */
  glissando?: boolean;
}

export interface CanonicalTempoEvent {
  tick: number;
  bpm: number;
}

export interface CanonicalTimeSignatureEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface CanonicalKeySignatureEvent {
  tick: number;
  /** -7 (7 flats) to +7 (7 sharps) */
  fifths: number;
  mode?: "major" | "minor";
}

export interface CanonicalPedalEvent {
  tick: number;
  /** 64 = sustain, 66 = sostenuto, 67 = soft */
  controller?: 64 | 66 | 67;
  /** 0..127 (>= 64 is depressed, < 64 is released) */
  value: number;
}

export interface CanonicalScoreTrack {
  name: string;
  hand?: CanonicalHandHint;
  /** MIDI program 0..127 (defaults to 0 Acoustic Grand Piano) */
  program?: number;
  /** MIDI channel 0..15 (defaults to 0 or 1, skipping percussion channel 9) */
  channel?: number;
  notes: CanonicalScoreNote[];
  pedals?: CanonicalPedalEvent[];
}

export interface CanonicalScore {
  title?: string;
  ppq?: number;
  tempos?: CanonicalTempoEvent[];
  timeSignatures?: CanonicalTimeSignatureEvent[];
  keySignatures?: CanonicalKeySignatureEvent[];
  tracks: CanonicalScoreTrack[];
  pedals?: CanonicalPedalEvent[];
}

function encodeVlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeUint16BE(target: number[], value: number): void {
  target.push((value >>> 8) & 0xff, value & 0xff);
}

function writeUint32BE(target: number[], value: number): void {
  target.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

interface RawScheduledEvent {
  tick: number;
  order: number;
  pitchSort: number;
  /** One or more MIDI messages that must be emitted atomically at `tick` (e.g. marker + NoteOn) */
  messages: number[][];
}

function buildMarkerString(
  hand: CanonicalHandHint | undefined,
  finger: number | undefined,
  glissando: boolean | undefined,
): string | null {
  const h = hand === "right" ? "R" : hand === "left" ? "L" : null;
  if (glissando && h) {
    return `${h}g`;
  }
  const f =
    typeof finger === "number" && finger >= 1 && finger <= 5
      ? Math.round(finger)
      : null;
  if (h && f) {
    return `${h}${f}`;
  }
  if (f) {
    return `F${f}`;
  }
  if (h) {
    return h;
  }
  return null;
}

function buildTrackChunk(events: RawScheduledEvent[]): Uint8Array {
  const sorted = [...events].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.order !== b.order) return a.order - b.order;
    return a.pitchSort - b.pitchSort;
  });

  const body: number[] = [];
  let currentTick = 0;

  for (const ev of sorted) {
    const targetTick = Math.max(currentTick, Math.round(ev.tick));
    let delta = targetTick - currentTick;
    currentTick = targetTick;

    for (const msg of ev.messages) {
      body.push(...encodeVlq(delta), ...msg);
      delta = 0;
    }
  }

  // End of Track meta event
  body.push(0x00, 0xff, 0x2f, 0x00);

  const chunk: number[] = [0x4d, 0x54, 0x72, 0x6b]; // "MTrk"
  writeUint32BE(chunk, body.length);
  for (let i = 0; i < body.length; i++) {
    chunk.push(body[i]!);
  }
  return new Uint8Array(chunk);
}

/**
 * Resolves overlapping same-pitch notes within a track so that a Note-Off
 * from an earlier note never prematurely silences a re-struck note of the same pitch.
 */
function normalizeTrackNotes(notes: CanonicalScoreNote[]): CanonicalScoreNote[] {
  const valid = notes
    .filter(
      (n) =>
        Number.isFinite(n.pitch) &&
        Number.isFinite(n.startTick) &&
        Number.isFinite(n.durationTicks) &&
        n.durationTicks > 0,
    )
    .map((n) => ({
      ...n,
      pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
      startTick: Math.max(0, Math.round(n.startTick)),
      durationTicks: Math.max(1, Math.round(n.durationTicks)),
      velocity: Math.max(1, Math.min(127, Math.round(n.velocity ?? 80))),
    }))
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

  // Group by pitch to trim overlapping durations
  const byPitch = new Map<number, CanonicalScoreNote[]>();
  for (const note of valid) {
    const group = byPitch.get(note.pitch);
    if (group) {
      group.push(note);
    } else {
      byPitch.set(note.pitch, [note]);
    }
  }

  for (const group of byPitch.values()) {
    for (let i = 0; i < group.length - 1; i++) {
      const current = group[i]!;
      const next = group[i + 1]!;
      if (next.startTick <= current.startTick) {
        // Exact duplicate onset on same pitch & track: merge metadata and drop duplicate
        current.durationTicks = Math.max(
          current.durationTicks,
          next.durationTicks,
        );
        current.velocity = Math.max(current.velocity ?? 80, next.velocity ?? 80);
        current.finger = current.finger ?? next.finger;
        current.hand = current.hand ?? next.hand;
        group.splice(i + 1, 1);
        i--;
        continue;
      }
      const currentEnd = current.startTick + current.durationTicks;
      if (currentEnd > next.startTick) {
        current.durationTicks = Math.max(1, next.startTick - current.startTick);
      }
    }
  }

  const flattened: CanonicalScoreNote[] = [];
  for (const group of byPitch.values()) {
    flattened.push(...group);
  }
  return flattened.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
}

/**
 * Encodes a CanonicalScore into a deterministic Standard MIDI File (Format 1) Uint8Array.
 */
export function writeCanonicalMidiFile(score: CanonicalScore): Uint8Array {
  const ppq = Math.max(24, Math.round(score.ppq ?? DEFAULT_SCORE_PPQ));

  // 1. Build Track 0 (Conductor track: title, tempos, time signatures, key signatures)
  const conductorEvents: RawScheduledEvent[] = [];

  if (score.title && score.title.trim().length > 0) {
    const titleBytes = encodeUtf8(score.title.trim());
    conductorEvents.push({
      tick: 0,
      order: 0,
      pitchSort: 0,
      messages: [[0xff, 0x03, ...encodeVlq(titleBytes.length), ...titleBytes]],
    });
  }

  const tempos = [...(score.tempos ?? [])]
    .filter((t) => Number.isFinite(t.tick) && Number.isFinite(t.bpm) && t.bpm > 0)
    .sort((a, b) => a.tick - b.tick);

  if (tempos.length === 0 || tempos[0]!.tick > 0) {
    tempos.unshift({ tick: 0, bpm: DEFAULT_TEMPO_BPM });
  }

  let lastTempoTick = -1;
  let lastTempoUs = -1;
  for (const tempo of tempos) {
    const tick = Math.max(0, Math.round(tempo.tick));
    const clampedBpm = Math.max(10, Math.min(400, tempo.bpm));
    const mpqn = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / clampedBpm)));
    if (tick === lastTempoTick && mpqn === lastTempoUs) continue;
    lastTempoTick = tick;
    lastTempoUs = mpqn;
    conductorEvents.push({
      tick,
      order: 1,
      pitchSort: 0,
      messages: [
        [
          0xff,
          0x51,
          0x03,
          (mpqn >>> 16) & 0xff,
          (mpqn >>> 8) & 0xff,
          mpqn & 0xff,
        ],
      ],
    });
  }

  const timeSignatures = [...(score.timeSignatures ?? [])]
    .filter(
      (ts) =>
        Number.isFinite(ts.tick) &&
        ts.numerator >= 1 &&
        ts.denominator >= 1,
    )
    .sort((a, b) => a.tick - b.tick);

  if (timeSignatures.length === 0 || timeSignatures[0]!.tick > 0) {
    timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  for (const ts of timeSignatures) {
    const tick = Math.max(0, Math.round(ts.tick));
    const num = Math.max(1, Math.min(255, Math.round(ts.numerator)));
    const denomPow = Math.max(
      0,
      Math.min(7, Math.round(Math.log2(ts.denominator))),
    );
    conductorEvents.push({
      tick,
      order: 2,
      pitchSort: 0,
      messages: [[0xff, 0x58, 0x04, num, denomPow, 24, 8]],
    });
  }

  for (const ks of score.keySignatures ?? []) {
    const tick = Math.max(0, Math.round(ks.tick));
    const fifths = Math.max(-7, Math.min(7, Math.round(ks.fifths)));
    const sfByte = fifths < 0 ? (256 + fifths) & 0xff : fifths & 0xff;
    const modeByte = ks.mode === "minor" ? 1 : 0;
    conductorEvents.push({
      tick,
      order: 3,
      pitchSort: 0,
      messages: [[0xff, 0x59, 0x02, sfByte, modeByte]],
    });
  }

  const trackChunks: Uint8Array[] = [buildTrackChunk(conductorEvents)];

  // 2. Build Playable Tracks
  const nonEmptyTracks = score.tracks.filter(
    (t) => t.notes.length > 0 || (t.pedals && t.pedals.length > 0),
  );

  nonEmptyTracks.forEach((track, idx) => {
    const events: RawScheduledEvent[] = [];
    const channel =
      typeof track.channel === "number"
        ? Math.max(0, Math.min(15, track.channel === 9 ? 0 : track.channel))
        : idx >= 9
          ? (idx + 1) % 16
          : idx % 16;

    const resolvedName =
      track.name?.trim() ||
      (track.hand === "right"
        ? "Right Hand"
        : track.hand === "left"
          ? "Left Hand"
          : `Piano Track ${idx + 1}`);

    const nameBytes = encodeUtf8(resolvedName);
    events.push({
      tick: 0,
      order: 0,
      pitchSort: 0,
      messages: [[0xff, 0x03, ...encodeVlq(nameBytes.length), ...nameBytes]],
    });

    // Program change (default 0 = Acoustic Grand Piano so sanitize_instruments keeps it)
    const program = Math.max(0, Math.min(127, Math.round(track.program ?? 0)));
    events.push({
      tick: 0,
      order: 1,
      pitchSort: 0,
      messages: [[0xc0 | channel, program]],
    });

    // Pedals (attach global score.pedals to the first playable track if not already on a track)
    const pedals = [
      ...(track.pedals ?? []),
      ...(idx === 0 ? (score.pedals ?? []) : []),
    ];
    for (const pedal of pedals) {
      const tick = Math.max(0, Math.round(pedal.tick));
      const controller = pedal.controller ?? 64;
      const value = Math.max(0, Math.min(127, Math.round(pedal.value)));
      events.push({
        tick,
        order: 3,
        pitchSort: controller,
        messages: [[0xb0 | channel, controller, value]],
      });
    }

    const normalizedNotes = normalizeTrackNotes(track.notes);
    for (const note of normalizedNotes) {
      const startTick = note.startTick;
      const endTick = note.startTick + note.durationTicks;
      const pitch = note.pitch;
      const velocity = note.velocity ?? 80;
      const effectiveHand = note.hand ?? track.hand;
      const marker = buildMarkerString(
        effectiveHand,
        note.finger,
        note.glissando,
      );

      const onsetMessages: number[][] = [];
      if (marker) {
        const markerBytes = encodeUtf8(marker);
        onsetMessages.push([
          0xff,
          0x01,
          ...encodeVlq(markerBytes.length),
          ...markerBytes,
        ]);
      }
      onsetMessages.push([0x90 | channel, pitch, velocity]);

      // Note On (order 4, after Note Off at order 2 and Pedals at order 3)
      events.push({
        tick: startTick,
        order: 4,
        pitchSort: pitch,
        messages: onsetMessages,
      });

      // Note Off (order 2, before any Note On at the same tick)
      events.push({
        tick: endTick,
        order: 2,
        pitchSort: pitch,
        messages: [[0x80 | channel, pitch, 0]],
      });
    }

    trackChunks.push(buildTrackChunk(events));
  });

  // 3. Assemble MThd + all MTrk chunks
  const header: number[] = [
    0x4d,
    0x54,
    0x68,
    0x64, // "MThd"
    0x00,
    0x00,
    0x00,
    0x06, // header length = 6
  ];
  writeUint16BE(header, 1); // Format 1
  writeUint16BE(header, trackChunks.length);
  writeUint16BE(header, ppq);

  const totalLength =
    header.length + trackChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const output = new Uint8Array(totalLength);
  output.set(header, 0);
  let offset = header.length;
  for (const chunk of trackChunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
