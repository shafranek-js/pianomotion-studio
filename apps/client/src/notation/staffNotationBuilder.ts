export type StaffQuantizationMode =
  | "auto"
  | "eighth"
  | "sixteenth"
  | "thirty-second"
  | "triplets";

export type ResolvedStaffQuantization = Exclude<StaffQuantizationMode, "auto">;

export type StaffDurationType =
  | "whole"
  | "half"
  | "quarter"
  | "eighth"
  | "16th"
  | "32nd";

export type StaffAccidental = "sharp" | "flat" | "natural" | null;

export interface StaffInputNote {
  readonly noteId: string;
  readonly pitch: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly hand: "left" | "right";
  readonly finger: number | null;
}

export interface StaffFingeringOverride {
  readonly noteId: string;
  readonly hand: "left" | "right";
  readonly finger: number | null;
}

export interface StaffKeyInfo {
  readonly tonic: string;
  readonly mode: "major" | "minor";
}

export interface StaffNoteHead {
  readonly noteId: string;
  readonly midi: number;
  readonly step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  readonly alter: -1 | 0 | 1;
  readonly octave: number;
  /** Diatonic step index where C4 (Middle C) = 28 (octave * 7 + stepIndex). */
  readonly diatonicIndex: number;
  /**
   * Staff step offset relative to the bottom line of its staff:
   * - Treble bottom line is E4 (diatonicIndex = 30) -> 0 = E4, 1 = F4, 2 = G4, ..., 8 = F5, -2 = C4 (middle C ledger line).
   * - Bass bottom line is G2 (diatonicIndex = 18) -> 0 = G2, 1 = A2, 2 = B2, ..., 8 = A3, 10 = C4 (middle C ledger line).
   */
  readonly staffStepOffset: number;
  readonly accidental: StaffAccidental;
  readonly hand: "left" | "right";
  readonly finger: number | null;
  readonly label: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface StaffVoiceEvent {
  readonly id: string;
  readonly staff: "treble" | "bass";
  readonly isRest: boolean;
  readonly isMeasureRest: boolean;
  readonly startUnit: number;
  readonly durationUnits: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationType: StaffDurationType;
  readonly dots: number;
  readonly isTriplet: boolean;
  readonly tieStart: boolean;
  readonly tieStop: boolean;
  readonly notes: readonly StaffNoteHead[];
}

export interface StaffMeasure {
  readonly index: number;
  readonly number: number;
  readonly startUnit: number;
  readonly endUnit: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly trebleEvents: readonly StaffVoiceEvent[];
  readonly bassEvents: readonly StaffVoiceEvent[];
}

export interface StaffNotationModel {
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly beatType: number;
  readonly fifths: number;
  readonly keyLabel: string;
  readonly resolvedQuantization: ResolvedStaffQuantization;
  readonly totalUnits: number;
  readonly durationSeconds: number;
  readonly measures: readonly StaffMeasure[];
}

export const STAFF_NOTATION_DIVISIONS = 24;

export const STAFF_QUANTIZATION_OPTIONS: readonly {
  readonly label: string;
  readonly value: StaffQuantizationMode;
}[] = [
  { label: "Auto", value: "auto" },
  { label: "1/8", value: "eighth" },
  { label: "1/16", value: "sixteenth" },
  { label: "1/32", value: "thirty-second" },
  { label: "Triplets", value: "triplets" },
];

interface DurationDefinition {
  readonly dots: number;
  readonly duration: number;
  readonly isTriplet: boolean;
  readonly type: StaffDurationType;
}

const BINARY_DURATIONS: readonly DurationDefinition[] = [
  { dots: 0, duration: 96, isTriplet: false, type: "whole" },
  { dots: 1, duration: 72, isTriplet: false, type: "half" },
  { dots: 0, duration: 48, isTriplet: false, type: "half" },
  { dots: 1, duration: 36, isTriplet: false, type: "quarter" },
  { dots: 0, duration: 24, isTriplet: false, type: "quarter" },
  { dots: 1, duration: 18, isTriplet: false, type: "eighth" },
  { dots: 0, duration: 12, isTriplet: false, type: "eighth" },
  { dots: 1, duration: 9, isTriplet: false, type: "16th" },
  { dots: 0, duration: 6, isTriplet: false, type: "16th" },
  { dots: 0, duration: 3, isTriplet: false, type: "32nd" },
];

const TRIPLET_DURATIONS: readonly DurationDefinition[] = [
  { dots: 0, duration: 16, isTriplet: true, type: "quarter" },
  { dots: 0, duration: 8, isTriplet: true, type: "eighth" },
  { dots: 0, duration: 4, isTriplet: true, type: "16th" },
  { dots: 0, duration: 2, isTriplet: true, type: "32nd" },
];

const MODE_RANK: Record<ResolvedStaffQuantization, number> = {
  eighth: 0,
  sixteenth: 1,
  triplets: 2,
  "thirty-second": 3,
};

const BINARY_STEP_BY_MODE: Record<Exclude<ResolvedStaffQuantization, "triplets">, number> = {
  eighth: 12,
  sixteenth: 6,
  "thirty-second": 3,
};

const STEP_INDEX: Record<"C" | "D" | "E" | "F" | "G" | "A" | "B", number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const SHARP_SPELLINGS: readonly { step: "C" | "D" | "E" | "F" | "G" | "A" | "B"; alter: -1 | 0 | 1 }[] = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 },
];

const FLAT_SPELLINGS: readonly { step: "C" | "D" | "E" | "F" | "G" | "A" | "B"; alter: -1 | 0 | 1 }[] = [
  { step: "C", alter: 0 },
  { step: "D", alter: -1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "G", alter: -1 },
  { step: "G", alter: 0 },
  { step: "A", alter: -1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 },
];

const SHARP_ORDER: readonly ("F" | "C" | "G" | "D" | "A" | "E" | "B")[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: readonly ("B" | "E" | "A" | "D" | "G" | "C" | "F")[] = ["B", "E", "A", "D", "G", "C", "F"];

const MAJOR_FIFTHS: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  "F#": 6,
  Gb: -6,
  F: -1,
  Bb: -2,
  "A#": -2,
  Eb: -3,
  "D#": -3,
  Ab: -4,
  "G#": -4,
  Db: -5,
  "C#": -5,
};

const MINOR_FIFTHS: Record<string, number> = {
  A: 0,
  E: 1,
  B: 2,
  "F#": 3,
  Gb: 3,
  "C#": 4,
  Db: 4,
  "G#": 5,
  Ab: -4,
  "D#": 6,
  Eb: -6,
  D: -1,
  G: -2,
  C: -3,
  F: -4,
  Bb: -5,
  "A#": -5,
};

export function resolveKeySignatureFifths(key?: StaffKeyInfo | null): number {
  if (!key) return 0;
  const table = key.mode === "minor" ? MINOR_FIFTHS : MAJOR_FIFTHS;
  return table[key.tonic] ?? 0;
}

export function getKeySignatureStepAlters(fifths: number): ReadonlyMap<string, -1 | 0 | 1> {
  const map = new Map<string, -1 | 0 | 1>([
    ["C", 0],
    ["D", 0],
    ["E", 0],
    ["F", 0],
    ["G", 0],
    ["A", 0],
    ["B", 0],
  ]);
  if (fifths > 0) {
    for (let i = 0; i < Math.min(7, fifths); i += 1) {
      map.set(SHARP_ORDER[i], 1);
    }
  } else if (fifths < 0) {
    for (let i = 0; i < Math.min(7, -fifths); i += 1) {
      map.set(FLAT_ORDER[i], -1);
    }
  }
  return map;
}

export function spellMidiPitch(
  midi: number,
  fifths: number,
  staff: "treble" | "bass",
): {
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  alter: -1 | 0 | 1;
  octave: number;
  diatonicIndex: number;
  staffStepOffset: number;
  label: string;
} {
  const clamped = Math.max(21, Math.min(108, Math.round(midi)));
  const pc = ((clamped % 12) + 12) % 12;
  const octave = Math.floor(clamped / 12) - 1;
  const entry = (fifths < 0 ? FLAT_SPELLINGS : SHARP_SPELLINGS)[pc];
  const diatonicIndex = octave * 7 + STEP_INDEX[entry.step];
  // Treble bottom line = E4 (4 * 7 + 2 = 30); Bass bottom line = G2 (2 * 7 + 4 = 18)
  const baseDiatonic = staff === "treble" ? 30 : 18;
  const staffStepOffset = diatonicIndex - baseDiatonic;
  const accChar = entry.alter === 1 ? "♯" : entry.alter === -1 ? "♭" : "";
  return {
    step: entry.step,
    alter: entry.alter,
    octave,
    diatonicIndex,
    staffStepOffset,
    label: `${entry.step}${accChar}${octave}`,
  };
}

function getMinimumStep(mode: ResolvedStaffQuantization): number {
  return mode === "triplets" ? 2 : BINARY_STEP_BY_MODE[mode];
}

function snapToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function snapUnit(value: number, mode: ResolvedStaffQuantization): number {
  if (mode !== "triplets") return snapToStep(value, BINARY_STEP_BY_MODE[mode]);
  const candidates = [6, 8].flatMap((step) => {
    const lower = Math.floor(value / step) * step;
    return [lower, lower + step];
  });
  return candidates.reduce((best, candidate) => {
    const bestDistance = Math.abs(best - value);
    const distance = Math.abs(candidate - value);
    return distance < bestDistance || (distance === bestDistance && candidate < best)
      ? candidate
      : best;
  }, candidates[0]);
}

function getPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

function getDurationDefinitions(allowTriplets: boolean): readonly DurationDefinition[] {
  return [...BINARY_DURATIONS, ...(allowTriplets ? TRIPLET_DURATIONS : [])]
    .sort((a, b) => b.duration - a.duration);
}

function decomposeDuration(durationUnits: number, allowTriplets: boolean): DurationDefinition[] {
  const definitions = getDurationDefinitions(allowTriplets);
  const result: DurationDefinition[] = [];
  let remaining = Math.max(1, Math.round(durationUnits));

  while (remaining > 0) {
    const definition = definitions.find((candidate) => candidate.duration <= remaining);
    if (!definition) {
      result.push({ dots: 0, duration: remaining, isTriplet: false, type: "32nd" });
      break;
    }
    result.push(definition);
    remaining -= definition.duration;
  }
  return result;
}

interface QuantizedStaffNote {
  readonly noteId: string;
  readonly pitch: number;
  readonly hand: "left" | "right";
  readonly finger: number | null;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly startUnit: number;
  readonly endUnit: number;
}

interface QuantizationCandidate {
  readonly mode: ResolvedStaffQuantization;
  readonly notes: readonly QuantizedStaffNote[];
  readonly meanError: number;
  readonly percentile95Error: number;
  readonly symbolCount: number;
}

function buildQuantizationCandidate(
  notes: readonly StaffInputNote[],
  unitsPerSecond: number,
  mode: ResolvedStaffQuantization,
): QuantizationCandidate {
  const minStep = getMinimumStep(mode);
  const errors: number[] = [];

  // Cluster near-simultaneous chord onsets within ~25ms
  const sorted = [...notes].sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
  const clusteredStartSec = new Map<string, number>();
  let anchorSec: number | null = null;
  for (const n of sorted) {
    if (anchorSec === null || n.startSeconds - anchorSec > 0.028) {
      anchorSec = n.startSeconds;
    }
    clusteredStartSec.set(n.noteId, anchorSec);
  }

  const quantized = sorted.map((note): QuantizedStaffNote => {
    const rawStart = (clusteredStartSec.get(note.noteId) ?? note.startSeconds) * unitsPerSecond;
    const rawEnd = note.endSeconds * unitsPerSecond;
    const startUnit = Math.max(0, snapUnit(rawStart, mode));
    const endUnit = Math.max(startUnit + minStep, snapUnit(rawEnd, mode));
    errors.push(
      Math.abs(startUnit - rawStart) / STAFF_NOTATION_DIVISIONS,
      Math.abs(endUnit - rawEnd) / STAFF_NOTATION_DIVISIONS,
    );
    return {
      noteId: note.noteId,
      pitch: note.pitch,
      hand: note.hand,
      finger: note.finger,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      startUnit,
      endUnit,
    };
  });

  const definitions = quantized.flatMap((n) =>
    decomposeDuration(n.endUnit - n.startUnit, mode === "triplets"),
  );
  const tieCount = Math.max(0, definitions.length - quantized.length);
  const tupletCount = definitions.filter((d) => d.isTriplet).length;

  return {
    mode,
    notes: quantized,
    meanError: errors.reduce((s, e) => s + e, 0) / Math.max(1, errors.length),
    percentile95Error: getPercentile(errors, 0.95),
    symbolCount: definitions.length + tieCount + tupletCount,
  };
}

export function selectStaffQuantization(
  notes: readonly StaffInputNote[],
  unitsPerSecond: number,
  requestedMode: StaffQuantizationMode,
): QuantizationCandidate {
  const modes: ResolvedStaffQuantization[] =
    requestedMode === "auto"
      ? ["eighth", "sixteenth", "thirty-second", "triplets"]
      : [requestedMode];
  const candidates = modes.map((m) => buildQuantizationCandidate(notes, unitsPerSecond, m));
  const acceptable = candidates.filter((c) => c.percentile95Error <= 0.04);
  const pool = acceptable.length > 0 ? acceptable : candidates;
  return [...pool].sort((a, b) => {
    if (acceptable.length === 0 && Math.abs(a.meanError - b.meanError) > 1e-6) {
      return a.meanError - b.meanError;
    }
    return a.symbolCount - b.symbolCount || MODE_RANK[a.mode] - MODE_RANK[b.mode];
  })[0];
}

interface StaffCluster {
  readonly startUnit: number;
  endUnit: number;
  readonly notes: readonly QuantizedStaffNote[];
}

function buildStaffMeasureEvents(
  staff: "treble" | "bass",
  staffNotes: readonly QuantizedStaffNote[],
  measureIndex: number,
  measureStartUnit: number,
  measureEndUnit: number,
  allowTriplets: boolean,
  fifths: number,
  secondsPerUnit: number,
): StaffVoiceEvent[] {
  // Group notes starting at the same quantized unit into chords
  const byStart = new Map<number, QuantizedStaffNote[]>();
  for (const n of staffNotes) {
    if (n.endUnit <= measureStartUnit || n.startUnit >= measureEndUnit) continue;
    const list = byStart.get(n.startUnit) ?? [];
    list.push(n);
    byStart.set(n.startUnit, list);
  }

  const clusters: StaffCluster[] = [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startUnit, grouped]) => ({
      startUnit,
      endUnit: Math.max(...grouped.map((g) => g.endUnit)),
      notes: [...grouped].sort((a, b) => a.pitch - b.pitch),
    }));

  // Trim overlapping clusters within the same staff so a single clean monophonic/chordal stream is engraved per staff
  for (let i = 0; i < clusters.length - 1; i += 1) {
    if (clusters[i].endUnit > clusters[i + 1].startUnit) {
      clusters[i].endUnit = clusters[i + 1].startUnit;
    }
  }

  // Track accidental state within this measure per (step, octave)
  const defaultAlters = getKeySignatureStepAlters(fifths);
  const activeAlters = new Map<string, -1 | 0 | 1>();
  const resolveAccidental = (step: string, octave: number, alter: -1 | 0 | 1): StaffAccidental => {
    const key = `${step}${octave}`;
    const current = activeAlters.get(key) ?? defaultAlters.get(step) ?? 0;
    if (alter === current) return null;
    activeAlters.set(key, alter);
    if (alter === 1) return "sharp";
    if (alter === -1) return "flat";
    return "natural";
  };

  interface RawNoteSegment {
    readonly startUnit: number;
    readonly duration: DurationDefinition;
    readonly tieStart: boolean;
    readonly tieStop: boolean;
    readonly sourceNotes: readonly QuantizedStaffNote[];
  }

  const segments: RawNoteSegment[] = [];
  for (const cluster of clusters) {
    const segStart = Math.max(cluster.startUnit, measureStartUnit);
    const segEnd = Math.min(cluster.endUnit, measureEndUnit);
    if (segEnd <= segStart) continue;
    const defs = decomposeDuration(segEnd - segStart, allowTriplets);
    let cursor = segStart;
    defs.forEach((def, idx) => {
      segments.push({
        startUnit: cursor,
        duration: def,
        tieStart: segEnd < cluster.endUnit || idx < defs.length - 1,
        tieStop: segStart > cluster.startUnit || idx > 0,
        sourceNotes: cluster.notes,
      });
      cursor += def.duration;
    });
  }

  if (segments.length === 0) {
    const durUnits = measureEndUnit - measureStartUnit;
    return [
      {
        id: `${staff}-m${measureIndex}-rest-0`,
        staff,
        isRest: true,
        isMeasureRest: true,
        startUnit: measureStartUnit,
        durationUnits: durUnits,
        startSeconds: measureStartUnit * secondsPerUnit,
        endSeconds: measureEndUnit * secondsPerUnit,
        durationType: "whole",
        dots: 0,
        isTriplet: false,
        tieStart: false,
        tieStop: false,
        notes: [],
      },
    ];
  }

  const events: StaffVoiceEvent[] = [];
  let cursor = measureStartUnit;
  let eventSerial = 0;

  const pushRestRange = (fromUnit: number, toUnit: number) => {
    let restCursor = fromUnit;
    for (const def of decomposeDuration(toUnit - fromUnit, allowTriplets)) {
      events.push({
        id: `${staff}-m${measureIndex}-e${eventSerial++}`,
        staff,
        isRest: true,
        isMeasureRest: false,
        startUnit: restCursor,
        durationUnits: def.duration,
        startSeconds: restCursor * secondsPerUnit,
        endSeconds: (restCursor + def.duration) * secondsPerUnit,
        durationType: def.type,
        dots: def.dots,
        isTriplet: def.isTriplet,
        tieStart: false,
        tieStop: false,
        notes: [],
      });
      restCursor += def.duration;
    }
  };

  for (const seg of segments) {
    if (seg.startUnit > cursor) {
      pushRestRange(cursor, seg.startUnit);
    }
    const segStartSec = seg.startUnit * secondsPerUnit;
    const segEndSec = (seg.startUnit + seg.duration.duration) * secondsPerUnit;
    const heads: StaffNoteHead[] = seg.sourceNotes.map((src) => {
      const spelled = spellMidiPitch(src.pitch, fifths, staff);
      const accidental = seg.tieStop
        ? null
        : resolveAccidental(spelled.step, spelled.octave, spelled.alter);
      return {
        noteId: src.noteId,
        midi: src.pitch,
        step: spelled.step,
        alter: spelled.alter,
        octave: spelled.octave,
        diatonicIndex: spelled.diatonicIndex,
        staffStepOffset: spelled.staffStepOffset,
        accidental,
        hand: src.hand,
        finger: src.finger,
        label: spelled.label,
        startSeconds: src.startSeconds,
        endSeconds: src.endSeconds,
      };
    });

    events.push({
      id: `${staff}-m${measureIndex}-e${eventSerial++}`,
      staff,
      isRest: false,
      isMeasureRest: false,
      startUnit: seg.startUnit,
      durationUnits: seg.duration.duration,
      startSeconds: segStartSec,
      endSeconds: segEndSec,
      durationType: seg.duration.type,
      dots: seg.duration.dots,
      isTriplet: seg.duration.isTriplet,
      tieStart: seg.tieStart,
      tieStop: seg.tieStop,
      notes: heads,
    });
    cursor = seg.startUnit + seg.duration.duration;
  }

  if (cursor < measureEndUnit) {
    pushRestRange(cursor, measureEndUnit);
  }

  return events;
}

export interface BuildStaffNotationOptions {
  readonly bpm?: number;
  readonly beatsPerBar?: number;
  readonly beatType?: number;
  readonly key?: StaffKeyInfo | null;
  readonly quantizationMode?: StaffQuantizationMode;
  readonly fingeringAssignments?: readonly StaffFingeringOverride[] | null;
}

export function buildStaffNotation(
  notes: readonly StaffInputNote[],
  options: BuildStaffNotationOptions = {},
): StaffNotationModel {
  const bpm = Math.max(20, Math.min(300, options.bpm ?? 120));
  const beatsPerBar = Math.max(1, Math.min(12, options.beatsPerBar ?? 4));
  const beatType = options.beatType ?? 4;
  const fifths = resolveKeySignatureFifths(options.key);
  const keyLabel = options.key ? `${options.key.tonic} ${options.key.mode}` : "C major";
  const requestedMode = options.quantizationMode ?? "auto";

  const overrideMap = new Map<string, StaffFingeringOverride>();
  if (options.fingeringAssignments) {
    for (const a of options.fingeringAssignments) {
      overrideMap.set(a.noteId, a);
    }
  }

  const effectiveNotes: StaffInputNote[] = notes.map((n) => {
    const ov = overrideMap.get(n.noteId);
    if (!ov) return n;
    return {
      ...n,
      hand: ov.hand,
      finger: ov.finger ?? n.finger,
    };
  });

  const quarterSeconds = 60 / bpm;
  const unitsPerSecond = STAFF_NOTATION_DIVISIONS / quarterSeconds;
  const secondsPerUnit = 1 / unitsPerSecond;
  const measureUnits = Math.max(
    STAFF_NOTATION_DIVISIONS,
    Math.round((beatsPerBar * STAFF_NOTATION_DIVISIONS * 4) / beatType),
  );

  if (effectiveNotes.length === 0) {
    return {
      bpm,
      beatsPerBar,
      beatType,
      fifths,
      keyLabel,
      resolvedQuantization: requestedMode === "auto" ? "sixteenth" : requestedMode,
      totalUnits: measureUnits,
      durationSeconds: measureUnits * secondsPerUnit,
      measures: [],
    };
  }

  const candidate = selectStaffQuantization(effectiveNotes, unitsPerSecond, requestedMode);
  const allowTriplets = candidate.mode === "triplets";
  const maxEndUnit = Math.max(
    measureUnits,
    ...candidate.notes.map((n) => n.endUnit),
  );
  const totalMeasures = Math.max(1, Math.ceil(maxEndUnit / measureUnits));

  const trebleNotes = candidate.notes.filter((n) => n.hand === "right");
  const bassNotes = candidate.notes.filter((n) => n.hand === "left");

  const measures: StaffMeasure[] = [];
  for (let m = 0; m < totalMeasures; m += 1) {
    const startUnit = m * measureUnits;
    const endUnit = startUnit + measureUnits;
    measures.push({
      index: m,
      number: m + 1,
      startUnit,
      endUnit,
      startSeconds: startUnit * secondsPerUnit,
      endSeconds: endUnit * secondsPerUnit,
      trebleEvents: buildStaffMeasureEvents(
        "treble",
        trebleNotes,
        m,
        startUnit,
        endUnit,
        allowTriplets,
        fifths,
        secondsPerUnit,
      ),
      bassEvents: buildStaffMeasureEvents(
        "bass",
        bassNotes,
        m,
        startUnit,
        endUnit,
        allowTriplets,
        fifths,
        secondsPerUnit,
      ),
    });
  }

  const totalUnits = totalMeasures * measureUnits;
  return {
    bpm,
    beatsPerBar,
    beatType,
    fifths,
    keyLabel,
    resolvedQuantization: candidate.mode,
    totalUnits,
    durationSeconds: totalUnits * secondsPerUnit,
    measures,
  };
}

export interface SerializeStaffMusicXmlOptions {
  readonly title?: string;
  readonly showFingers?: boolean;
  readonly showNoteNames?: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderVoiceEventMusicXml(
  ev: StaffVoiceEvent,
  staffNumber: 1 | 2,
  voiceNumber: 1 | 2,
  options: SerializeStaffMusicXmlOptions,
): string {
  const showFingers = options.showFingers ?? true;
  const showNoteNames = options.showNoteNames ?? false;

  const buildNoteXml = (head: StaffNoteHead | null, isChord: boolean): string => {
    const parts: string[] = ["      <note>"];
    if (isChord) {
      parts.push("        <chord/>");
    }
    if (head === null) {
      if (ev.isMeasureRest) {
        parts.push('        <rest measure="yes"/>');
      } else {
        parts.push("        <rest/>");
      }
    } else {
      parts.push("        <pitch>");
      parts.push(`          <step>${head.step}</step>`);
      if (head.alter !== 0) {
        parts.push(`          <alter>${head.alter}</alter>`);
      }
      parts.push(`          <octave>${head.octave}</octave>`);
      parts.push("        </pitch>");
    }

    parts.push(`        <duration>${ev.durationUnits}</duration>`);
    if (ev.tieStop && head !== null) {
      parts.push('        <tie type="stop"/>');
    }
    if (ev.tieStart && head !== null) {
      parts.push('        <tie type="start"/>');
    }
    parts.push(`        <voice>${voiceNumber}</voice>`);
    parts.push(`        <type>${ev.durationType}</type>`);
    for (let d = 0; d < ev.dots; d += 1) {
      parts.push("        <dot/>");
    }
    if (head !== null && head.accidental) {
      parts.push(`        <accidental>${head.accidental}</accidental>`);
    }
    if (ev.isTriplet) {
      parts.push("        <time-modification>");
      parts.push("          <actual-notes>3</actual-notes>");
      parts.push("          <normal-notes>2</normal-notes>");
      parts.push(`          <normal-type>${ev.durationType}</normal-type>`);
      parts.push("        </time-modification>");
    }
    parts.push(`        <staff>${staffNumber}</staff>`);

    const labelParts: string[] = [];
    if (showFingers && head && head.finger !== null && !ev.tieStop) {
      labelParts.push(String(head.finger));
    }
    if (showNoteNames && head && !ev.tieStop) {
      labelParts.push(head.label);
    }
    const labelText = labelParts.join("·");
    const hasTies = head !== null && (ev.tieStart || ev.tieStop);

    if (hasTies || labelText) {
      parts.push("        <notations>");
      if (ev.tieStop && head !== null) {
        parts.push('          <tied type="stop"/>');
      }
      if (ev.tieStart && head !== null) {
        parts.push('          <tied type="start"/>');
      }
      if (labelText && !isChord) {
        parts.push("          <technical>");
        parts.push(`            <fingering>${escapeXml(labelText)}</fingering>`);
        parts.push("          </technical>");
      }
      parts.push("        </notations>");
    }

    parts.push("      </note>");
    return parts.join("\n");
  };

  if (ev.isRest || ev.notes.length === 0) {
    return buildNoteXml(null, false);
  }
  return ev.notes.map((head, idx) => buildNoteXml(head, idx > 0)).join("\n");
}

/**
 * Generates standard MusicXML 4.0 (2-staff Piano Grand Staff) from `StaffNotationModel`
 * for engraving with `OpenSheetMusicDisplay` (OSMD), ported from `MelodicaTrainer`'s `midiNotation.ts`.
 */
export function serializeStaffMusicXml(
  model: StaffNotationModel,
  options: SerializeStaffMusicXmlOptions = {},
): string {
  const title = escapeXml(options.title ?? "Piano Score");
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<score-partwise version="4.0">',
    "  <work>",
    `    <work-title>${title}</work-title>`,
    "  </work>",
    "  <part-list>",
    '    <score-part id="P1">',
    "      <part-name>Piano</part-name>",
    "    </score-part>",
    "  </part-list>",
    '  <part id="P1">',
  ];

  model.measures.forEach((measure, idx) => {
    lines.push(`    <measure number="${measure.number}">`);
    if (idx === 0) {
      lines.push("      <attributes>");
      lines.push(`        <divisions>${STAFF_NOTATION_DIVISIONS}</divisions>`);
      lines.push("        <key>");
      lines.push(`          <fifths>${model.fifths}</fifths>`);
      lines.push("        </key>");
      lines.push("        <time>");
      lines.push(`          <beats>${model.beatsPerBar}</beats>`);
      lines.push(`          <beat-type>${model.beatType}</beat-type>`);
      lines.push("        </time>");
      lines.push("        <staves>2</staves>");
      lines.push('        <clef number="1">');
      lines.push("          <sign>G</sign>");
      lines.push("          <line>2</line>");
      lines.push("        </clef>");
      lines.push('        <clef number="2">');
      lines.push("          <sign>F</sign>");
      lines.push("          <line>4</line>");
      lines.push("        </clef>");
      lines.push("      </attributes>");
    }

    for (const ev of measure.trebleEvents) {
      lines.push(renderVoiceEventMusicXml(ev, 1, 1, options));
    }

    const measureUnits = measure.endUnit - measure.startUnit;
    lines.push("      <backup>");
    lines.push(`        <duration>${measureUnits}</duration>`);
    lines.push("      </backup>");

    for (const ev of measure.bassEvents) {
      lines.push(renderVoiceEventMusicXml(ev, 2, 2, options));
    }

    lines.push("    </measure>");
  });

  lines.push("  </part>");
  lines.push("</score-partwise>");
  return lines.join("\n");
}

