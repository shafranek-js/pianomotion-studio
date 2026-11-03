/**
 * tonalScalesAndProgressions.ts - Interactive generator of piano scales (15 families x 12 keys x 3 hand modes)
 * and classical chord progressions (18 patterns x 12 keys).
 *
 * Adapted from Mizan (MIT License, ui/src/course/pianoTonal.ts & pianoParts.ts).
 * Scope: Only scales and classical chord progressions (no step-by-step course or repertoire pieces).
 */

export type KeyMode = "major" | "minor";
export type HandVariantSlug = "right-hand" | "left-hand" | "hands-together";
export type FingerNumber = 1 | 2 | 3 | 4 | 5;
export type ProgressionTexture = "held" | "pulse" | "offbeat" | "broken";

export interface TonalNote {
  readonly hand: "left" | "right";
  readonly midi: number;
  readonly startBeat: number;
  readonly beats: number;
  readonly finger: FingerNumber;
  readonly velocity: number;
  readonly spell?: string;
}

export interface TonalPedal {
  readonly controller: 64;
  readonly startBeat: number;
  readonly beats: number;
}

export interface TonalExercise {
  readonly id: string;
  readonly kind: "scale" | "progression";
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly tonic: string;
  readonly pitchClass: number;
  readonly mode: KeyMode;
  readonly familyId?: string;
  readonly handVariant?: HandVariantSlug;
  readonly bpm: number;
  readonly meter: { readonly numerator: number; readonly denominator: number };
  readonly bars: number;
  readonly chords: readonly string[];
  readonly numerals: readonly string[];
  readonly examples?: readonly string[];
  readonly notes: readonly TonalNote[];
  readonly pedals: readonly TonalPedal[];
}

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
const NATURAL = [0, 2, 4, 5, 7, 9, 11] as const;

export const KEY_NAMES: Record<KeyMode, readonly string[]> = {
  major: ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"],
  minor: ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"],
};

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const MODES: Record<"major" | "minor" | "mixolydian" | "dorian" | "harmonic", readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
};

export const pc = (midi: number): number => ((midi % 12) + 12) % 12;

export function pitchOf(name: string): number {
  const base = PITCH[name[0]!] ?? 0;
  let acc = 0;
  for (let i = 1; i < name.length; i++) {
    acc += name[i] === "#" ? 1 : -1;
  }
  return (base + acc + 12) % 12;
}

function onLetter(letter: number, pitch: number): string {
  const name = LETTERS[((letter % 7) + 7) % 7]!;
  const diff = (((pitch - NATURAL[LETTERS.indexOf(name)]!) % 12) + 18) % 12 - 6;
  return name + (diff > 0 ? "#".repeat(diff) : "b".repeat(-diff));
}

export const spell = (tonic: string, degree: number, pitch: number): string =>
  onLetter(LETTERS.indexOf(tonic[0] as (typeof LETTERS)[number]) + degree, pitch);

const slug = (name: string): string =>
  name[0]!.toLowerCase() + (name[1] === "#" ? "-sharp" : name[1] === "b" ? "-flat" : "");

// ---- Chord parsing & voice-leading helpers ----

const CHORD_QUALITY_INTERVALS: Record<string, readonly number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "5": [0, 7, 12],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  "9": [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m7b5: [0, 3, 6, 10],
  dim: [0, 3, 6],
};

export function parseChordSymbol(symbol: string): { root: number; intervals: readonly number[] } {
  const match = /^([A-G])(#|b)?(.*)$/.exec(symbol.trim());
  const intervals = match ? CHORD_QUALITY_INTERVALS[match[3]!] : undefined;
  if (!match || !intervals) {
    throw new Error(`Unknown chord symbol: ${symbol}`);
  }
  const root = (PITCH[match[1]!]! + (match[2] === "#" ? 1 : match[2] === "b" ? 11 : 0)) % 12;
  return { root, intervals };
}

function chordDegrees(intervals: readonly number[]) {
  const third = [3, 4, 5, 2, 7].find((interval) => intervals.includes(interval)) ?? 4;
  const fifth = intervals.includes(7) ? 7 : intervals.includes(6) ? 6 : 7;
  const seventh = intervals.includes(11) ? 11 : 10;
  return { third, fifth, seventh };
}

function rightTones(symbol: string): { root: number; tones: number[]; power: boolean } {
  const { root, intervals } = parseChordSymbol(symbol);
  if (intervals.includes(12)) {
    return { root, tones: [0, 7], power: true };
  }
  const tones = intervals.length > 4 ? intervals.filter((i) => i !== 7) : [...intervals];
  return { root, tones: [...new Set(tones.map((t) => t % 12))], power: false };
}

export function voicings(symbol: string, rich = false): number[][] {
  const { root, tones, power } = rightTones(symbol);
  const classes = tones.map((tone) => (root + tone) % 12);
  const options: number[][] = [];
  for (let bottom = 60; bottom <= 79; bottom++) {
    if (power) {
      const shape =
        pc(bottom) === root % 12
          ? [0, 7, 12]
          : pc(bottom) === (root + 7) % 12
            ? [0, 5, 12]
            : null;
      if (shape && bottom + 12 <= 84) {
        options.push(shape.map((step) => bottom + step));
      }
      continue;
    }
    if (!classes.includes(pc(bottom))) continue;
    const voiced = [bottom];
    for (let pitch = bottom + 1; voiced.length < classes.length; pitch++) {
      if (classes.includes(pc(pitch))) voiced.push(pitch);
    }
    if (rich && voiced.length === 3) voiced.push(bottom + 12);
    if (voiced[voiced.length - 1]! <= 84) options.push(voiced);
  }
  return options;
}

export function chooseVoicing(
  symbol: string,
  rich: boolean,
  previous: readonly number[] | null,
  target: number,
  options = voicings(symbol, rich),
): number[] {
  const sum = (arr: readonly number[]) => arr.reduce((a, b) => a + b, 0);
  const centre = previous && previous.length > 0 ? sum(previous) / previous.length : target - 5;
  const cost = (voiced: readonly number[]) =>
    0.7 * Math.abs(voiced[voiced.length - 1]! - target) +
    0.3 * Math.abs(sum(voiced) / voiced.length - centre);
  return options.reduce((best, option) => (cost(option) < cost(best) ? option : best));
}

export function rightFingers(pitches: readonly number[]): FingerNumber[] {
  if (pitches.length === 4) return [1, 2, 3, 5];
  if (pitches.length === 2) return [1, pitches[1]! - pitches[0]! >= 7 ? 5 : 3];
  return pitches[2]! - pitches[1]! === 5 ? [1, 2, 5] : [1, 3, 5];
}

type LeftDegree = "R" | "3" | "5" | "6" | "7" | "8" | ">";

function leftPitch(symbol: string, degree: Exclude<LeftDegree, ">">): number {
  const { root, intervals } = parseChordSymbol(symbol);
  const { third, fifth, seventh } = chordDegrees(intervals);
  const map: Record<Exclude<LeftDegree, ">">, number> = {
    R: 0,
    "3": third === 7 && intervals.includes(12) ? 12 : third,
    "5": fifth,
    "6": 9,
    "7": seventh,
    "8": 12,
  };
  return 36 + (root % 12) + map[degree];
}

const REACH = {
  thumb: [0, 5, 7, 9, 12] as const,
  other: [0, 4, 6, 8, 8] as const,
};

export function canFollow(
  hand: "right" | "left",
  a: { midi: number; finger: FingerNumber; start: number; end: number },
  b: { midi: number; finger: FingerNumber; start: number },
): boolean {
  const d = b.midi - a.midi;
  if (
    d === 0 ||
    Math.abs(d) > 7 ||
    b.start - a.end >= 0.25 - 1e-9 ||
    a.end - a.start >= 1 - 1e-9
  ) {
    return true;
  }
  const out = hand === "right" ? d : -d;
  const gap = b.finger - a.finger;
  if (out > 0 && b.finger === 1 && (a.finger === 2 || a.finger === 3 || a.finger === 4)) {
    return out <= 5;
  }
  if (out < 0 && a.finger === 1 && (b.finger === 2 || b.finger === 3 || b.finger === 4)) {
    return -out <= 5;
  }
  if (gap === 0 || Math.sign(gap) !== Math.sign(out)) return false;
  const reach = (a.finger === 1 || b.finger === 1 ? REACH.thumb : REACH.other)[Math.abs(gap)]!;
  return Math.abs(out) <= reach && Math.abs(out) >= Math.abs(gap) - 1;
}

type MutableNote = {
  hand: "left" | "right";
  midi: number;
  startBeat: number;
  beats: number;
  finger?: FingerNumber;
  prefer?: FingerNumber;
  velocity: number;
  spell?: string;
};

function fingerLine(hand: "right" | "left", notes: MutableNote[]): void {
  const groups: MutableNote[][] = [];
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0]!.startBeat - note.startBeat) < 1e-9) {
      last.push(note);
    } else {
      groups.push([note]);
    }
  }
  const singles = groups.map((group) => (group.length === 1 ? group[0]! : null));
  type Cell = { cost: number; from: number };
  const table: Cell[][] = [];
  const allFingers: FingerNumber[] = [1, 2, 3, 4, 5];

  singles.forEach((note, index) => {
    const options: FingerNumber[] = !note ? [1] : note.finger ? [note.finger] : allFingers;
    const before = index > 0 ? singles[index - 1]! : null;
    table.push(
      allFingers.map((finger) => {
        if (!options.includes(finger)) return { cost: Infinity, from: -1 };
        const own = note && !note.finger ? Math.abs(finger - (note.prefer ?? finger)) : 0;
        if (index === 0) return { cost: own, from: -1 };
        let best: Cell = { cost: Infinity, from: -1 };
        table[index - 1]!.forEach((cell, previous) => {
          if (cell.cost === Infinity) return;
          const playable =
            !note ||
            !before ||
            canFollow(
              hand,
              {
                midi: before.midi,
                finger: (previous + 1) as FingerNumber,
                start: before.startBeat,
                end: before.startBeat + before.beats,
              },
              { midi: note.midi, finger, start: note.startBeat },
            );
          if (!playable) return;
          const total = cell.cost + own;
          if (total < best.cost) best = { cost: total, from: previous };
        });
        return best;
      }),
    );
  });

  if (table.length === 0) return;
  const lastRow = table[table.length - 1]!;
  let fingerIdx = lastRow.reduce(
    (best, cell, index, all) => (cell.cost < all[best]!.cost ? index : best),
    0,
  );
  if (lastRow[fingerIdx]!.cost === Infinity) {
    for (const note of notes) {
      if (!note.finger) note.finger = note.prefer ?? 1;
      delete note.prefer;
    }
    return;
  }
  for (let index = singles.length - 1; index >= 0; index--) {
    const note = singles[index];
    if (note && !note.finger) note.finger = (fingerIdx + 1) as FingerNumber;
    fingerIdx = table[index]![fingerIdx]!.from;
  }
  for (const note of notes) {
    if (!note.finger) note.finger = note.prefer ?? 1;
    delete note.prefer;
  }
}

// ---- Scales (15 families x 12 tonics x 3 hand modes) ----

export interface ScaleFamilySpec {
  readonly id: string;
  readonly name: string;
  readonly up: readonly number[];
  readonly down?: readonly number[];
  readonly letters: readonly number[];
  readonly third: KeyMode;
  readonly tempo: { readonly start: number; readonly target: number };
  readonly note: string;
}

export const SCALE_FAMILIES: readonly ScaleFamilySpec[] = [
  {
    id: "major",
    name: "Major (Ionian)",
    up: MODES.major,
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "major",
    tempo: { start: 66, target: 116 },
    note: "whole and half steps W W H W W W H",
  },
  {
    id: "minor",
    name: "Natural minor (Aeolian)",
    up: MODES.minor,
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 66, target: 116 },
    note: "the major scale from its sixth: W H W W H W W",
  },
  {
    id: "dorian",
    name: "Dorian",
    up: [0, 2, 3, 5, 7, 9, 10],
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 66, target: 112 },
    note: "minor with a major sixth",
  },
  {
    id: "phrygian",
    name: "Phrygian",
    up: [0, 1, 3, 5, 7, 8, 10],
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 66, target: 112 },
    note: "minor with a flat second",
  },
  {
    id: "lydian",
    name: "Lydian",
    up: [0, 2, 4, 6, 7, 9, 11],
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "major",
    tempo: { start: 66, target: 112 },
    note: "major with a sharp fourth",
  },
  {
    id: "mixolydian",
    name: "Mixolydian",
    up: [0, 2, 4, 5, 7, 9, 10],
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "major",
    tempo: { start: 66, target: 112 },
    note: "major with a flat seventh",
  },
  {
    id: "locrian",
    name: "Locrian",
    up: [0, 1, 3, 5, 6, 8, 10],
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 60, target: 104 },
    note: "a flat second and a flat fifth",
  },
  {
    id: "harmonic-minor",
    name: "Harmonic minor",
    up: MODES.harmonic,
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 60, target: 104 },
    note: "natural minor with the seventh raised: an augmented second between 6th and 7th",
  },
  {
    id: "melodic-minor",
    name: "Melodic minor (classical)",
    up: [0, 2, 3, 5, 7, 9, 11],
    down: MODES.minor,
    letters: [0, 1, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 60, target: 104 },
    note: "going up the sixth and seventh are raised; coming down it is the natural minor",
  },
  {
    id: "major-pentatonic",
    name: "Major pentatonic",
    up: [0, 2, 4, 7, 9],
    letters: [0, 1, 2, 4, 5],
    third: "major",
    tempo: { start: 72, target: 126 },
    note: "the major scale without its fourth and seventh",
  },
  {
    id: "minor-pentatonic",
    name: "Minor pentatonic",
    up: [0, 3, 5, 7, 10],
    letters: [0, 2, 3, 4, 6],
    third: "minor",
    tempo: { start: 72, target: 126 },
    note: "the natural minor without its second and sixth",
  },
  {
    id: "blues",
    name: "Minor blues",
    up: [0, 3, 5, 6, 7, 10],
    letters: [0, 2, 3, 4, 4, 6],
    third: "minor",
    tempo: { start: 72, target: 120 },
    note: "the minor pentatonic with the flat fifth (blue note) added",
  },
  {
    id: "chromatic",
    name: "Chromatic",
    up: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    letters: [],
    third: "major",
    tempo: { start: 60, target: 100 },
    note: "every half step; written in sharps going up and flats coming down",
  },
  {
    id: "whole-tone",
    name: "Whole tone",
    up: [0, 2, 4, 6, 8, 10],
    letters: [0, 1, 2, 3, 4, 5],
    third: "major",
    tempo: { start: 66, target: 112 },
    note: "six whole steps to the octave",
  },
  {
    id: "diminished",
    name: "Diminished (half-whole)",
    up: [0, 1, 3, 4, 6, 7, 9, 10],
    letters: [0, 1, 2, 2, 3, 4, 5, 6],
    third: "minor",
    tempo: { start: 60, target: 100 },
    note: "eight notes alternating half and whole steps, starting with a half step",
  },
];

type ScaleKeyFingering = {
  readonly right: readonly number[];
  readonly top: number;
  readonly left: readonly number[];
  readonly bottom: number;
  readonly start?: number;
};

const C_SHAPE: ScaleKeyFingering = {
  right: [1, 2, 3, 1, 2, 3, 4],
  top: 5,
  left: [1, 4, 3, 2, 1, 3, 2],
  bottom: 5,
};
const B_SHAPE: ScaleKeyFingering = {
  ...C_SHAPE,
  left: [1, 3, 2, 1, 4, 3, 2],
  bottom: 4,
};
const F_SHAPE: ScaleKeyFingering = {
  ...C_SHAPE,
  right: [1, 2, 3, 4, 1, 2, 3],
  top: 4,
};
const FLAT_LEFT = {
  left: [3, 2, 1, 4, 3, 2, 1],
  bottom: 3,
} as const;

export const SCALE_KEY_FINGERING: Record<KeyMode, Record<number, ScaleKeyFingering>> = {
  major: {
    0: C_SHAPE,
    2: C_SHAPE,
    4: C_SHAPE,
    7: C_SHAPE,
    9: C_SHAPE,
    11: B_SHAPE,
    5: F_SHAPE,
    10: { right: [4, 1, 2, 3, 1, 2, 3], top: 4, ...FLAT_LEFT },
    3: { right: [3, 1, 2, 3, 4, 1, 2], top: 3, ...FLAT_LEFT },
    8: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, ...FLAT_LEFT },
    1: { right: [2, 3, 1, 2, 3, 4, 1], top: 2, ...FLAT_LEFT },
    6: { right: [2, 3, 4, 1, 2, 3, 1], top: 2, left: [4, 3, 2, 1, 3, 2, 1], bottom: 4 },
  },
  minor: {
    0: C_SHAPE,
    2: C_SHAPE,
    4: C_SHAPE,
    7: C_SHAPE,
    9: C_SHAPE,
    11: B_SHAPE,
    5: F_SHAPE,
    6: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, left: [4, 3, 2, 1, 3, 2, 1], bottom: 4 },
    1: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, ...FLAT_LEFT },
    8: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, left: [3, 2, 1, 3, 2, 1, 4], bottom: 3 },
    3: { right: [3, 1, 2, 3, 4, 1, 2], top: 3, left: [2, 1, 4, 3, 2, 1, 3], bottom: 2 },
    10: { right: [4, 1, 2, 3, 1, 2, 3], start: 2, top: 4, left: [2, 1, 3, 2, 1, 4, 3], bottom: 2 },
  },
};

const TONIC_CHOICES = [
  ["C"],
  ["C#", "Db"],
  ["D"],
  ["D#", "Eb"],
  ["E"],
  ["F"],
  ["F#", "Gb"],
  ["G"],
  ["G#", "Ab"],
  ["A"],
  ["A#", "Bb"],
  ["B"],
] as const;

const sharpName = (pitch: number): string =>
  ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pitch]!;
const flatName = (pitch: number): string =>
  ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][pitch]!;

function scaleNames(tonic: string, family: ScaleFamilySpec, steps = family.up): string[] {
  const root = pitchOf(tonic);
  if (family.id === "chromatic") {
    return steps.map((step) => (step === 0 ? tonic : sharpName((root + step) % 12)));
  }
  return steps.map((step, index) =>
    onLetter(
      LETTERS.indexOf(tonic[0] as (typeof LETTERS)[number]) + family.letters[index]!,
      (root + step) % 12,
    ),
  );
}

const accidentals = (names: readonly string[]): number =>
  names.reduce((sum, name) => sum + (name.length - 1) * (name.length > 2 ? 10 : 1), 0);

export function scaleTonic(pitch: number, familyId: string): string {
  const family = SCALE_FAMILIES.find((f) => f.id === familyId) ?? SCALE_FAMILIES[0]!;
  if (familyId === "major" || familyId === "minor") {
    return KEY_NAMES[family.third][pitch]!;
  }
  const preferred = KEY_NAMES[family.third][pitch]!;
  return [...TONIC_CHOICES[pitch]!].sort(
    (a, b) =>
      accidentals(scaleNames(a, family)) - accidentals(scaleNames(b, family)) ||
      (a === preferred ? -1 : b === preferred ? 1 : 0),
  )[0]!;
}

export function chromaticFinger(midi: number, hand: "right" | "left"): FingerNumber {
  const key = pc(midi);
  if (key === 1 || key === 3 || key === 6 || key === 8 || key === 10) return 3;
  return (hand === "right" ? [5, 0] : [4, 11]).includes(key) ? 2 : 1;
}

export function solveUp(
  pitches: readonly number[],
  hand: "right" | "left",
  fixedLast?: FingerNumber,
): FingerNumber[] {
  const black = (midi: number) => [1, 3, 6, 8, 10].includes(pc(midi));
  const cost: number[][] = [];
  const from: number[][] = [];

  pitches.forEach((midi, index) => {
    cost.push([]);
    from.push([]);
    for (let finger = 1 as FingerNumber; finger <= 5; finger++) {
      let own = black(midi) && finger === 1 ? 20 : 0;
      const outer = hand === "right" ? 5 : 1;
      const inner = hand === "right" ? 1 : 5;
      if (index === 0) {
        own += finger === inner ? 0 : finger === (hand === "right" ? 2 : 4) ? 1 : 2.5;
      } else if (index === pitches.length - 1) {
        own += fixedLast
          ? finger === fixedLast
            ? 0
            : Infinity
          : finger === outer
            ? 0
            : finger === (hand === "right" ? 4 : 2)
              ? 1
              : 3;
      } else if (finger === outer) {
        own += 4;
      }
      if (index === 0) {
        cost[index]![finger] = own;
        from[index]![finger] = -1;
        continue;
      }
      let best = Infinity;
      let arg = -1;
      for (let previous = 1 as FingerNumber; previous <= 5; previous++) {
        const prior = cost[index - 1]![previous];
        if (prior === Infinity || prior === undefined) continue;
        if (
          !canFollow(
            hand,
            { midi: pitches[index - 1]!, finger: previous, start: 0, end: 0.5 },
            { midi, finger, start: 0.5 },
          )
        ) {
          continue;
        }
        const crossing = (hand === "right" ? finger < previous : finger > previous) ? 1 : 0;
        if (prior + own + crossing < best) {
          best = prior + own + crossing;
          arg = previous;
        }
      }
      cost[index]![finger] = best;
      from[index]![finger] = arg;
    }
  });

  const lastCost = cost[cost.length - 1]!;
  let finger = ([1, 2, 3, 4, 5] as FingerNumber[]).reduce(
    (best, f) => (lastCost[f]! < lastCost[best]! ? f : best),
    1 as FingerNumber,
  );
  if (lastCost[finger] === Infinity) {
    throw new Error(`No playable scale fingering for ${pitches.join(" ")}`);
  }
  const out: FingerNumber[] = [];
  for (let index = pitches.length - 1; index >= 0; index--) {
    out[index] = finger;
    finger = from[index]![finger] as FingerNumber;
  }
  return out;
}

export const HAND_VARIANTS: ReadonlyArray<{
  readonly slug: HandVariantSlug;
  readonly name: string;
  readonly hands: ReadonlyArray<"right" | "left">;
}> = [
  { slug: "right-hand", name: "Right hand", hands: ["right"] },
  { slug: "left-hand", name: "Left hand", hands: ["left"] },
  { slug: "hands-together", name: "Hands together", hands: ["right", "left"] },
];

export function generateScaleExercise(
  pitchClass: number,
  familyId: string,
  handVariant: HandVariantSlug = "hands-together",
  customBpm?: number,
): TonalExercise {
  const pitch = ((pitchClass % 12) + 12) % 12;
  const family = SCALE_FAMILIES.find((f) => f.id === familyId) ?? SCALE_FAMILIES[0]!;
  const variant = HAND_VARIANTS.find((v) => v.slug === handVariant) ?? HAND_VARIANTS[2]!;
  const tonic = scaleTonic(pitch, family.id);
  const octaves = family.id === "chromatic" ? 1 : 2;
  const size = family.up.length;
  const upSteps = Array.from(
    { length: size * octaves + 1 },
    (_, i) => family.up[i % size]! + 12 * Math.floor(i / size),
  );
  const downSource = family.down ?? family.up;
  const downSteps = Array.from(
    { length: size * octaves + 1 },
    (_, i) => downSource[i % size]! + 12 * Math.floor(i / size),
  );
  const upNames = scaleNames(tonic, family);
  const downNames =
    family.id === "chromatic"
      ? family.up.map((step) => (step === 0 ? tonic : flatName((pitch + step) % 12)))
      : scaleNames(tonic, family, downSource);
  const table =
    family.id === "major" || family.id === "minor"
      ? SCALE_KEY_FINGERING[family.third][pitch]
      : null;

  const totalNotesPerHand = upSteps.length * 2 - 1;
  const bars = Math.floor(((totalNotesPerHand - 1) * 0.5) / 4) + 1;
  const notes: TonalNote[] = [];

  for (const hand of variant.hands) {
    const base = (hand === "right" ? 60 : 48) + pitch;
    const up = upSteps.map((step) => base + step);
    const down = downSteps.map((step) => base + step).reverse();
    let upFingers: FingerNumber[];
    let downFingers: FingerNumber[];

    if (table) {
      const fingerForDegree = (degree: number): FingerNumber =>
        (hand === "right"
          ? degree === size * octaves
            ? table.top
            : degree === 0
              ? (table.start ?? table.right[0]!)
              : table.right[degree % 7]!
          : degree === 0
            ? table.bottom
            : table.left[degree % 7]!) as FingerNumber;
      upFingers = up.map((_, degree) => fingerForDegree(degree));
      downFingers = [...upFingers].reverse();
    } else if (family.id === "chromatic") {
      upFingers = up.map((midi, i) =>
        i === 0 && hand === "right" && (pc(midi) === 0 || pc(midi) === 5)
          ? 1
          : chromaticFinger(midi, hand),
      );
      downFingers = down.map((midi, i) =>
        i === down.length - 1 ? upFingers[0]! : chromaticFinger(midi, hand),
      );
    } else {
      upFingers = solveUp(up, hand);
      downFingers = family.down
        ? solveUp([...down].reverse(), hand, upFingers[upFingers.length - 1]).reverse()
        : [...upFingers].reverse();
    }

    const line = [
      ...up.map((midi, i) => ({
        midi,
        finger: upFingers[i]!,
        name: upNames[i % size]!,
      })),
      ...down.slice(1).map((midi, i) => ({
        midi,
        finger: downFingers[i + 1]!,
        name: downNames[(size * octaves - 1 - i) % size]!,
      })),
    ];

    line.forEach(({ midi, finger, name }, i) => {
      notes.push({
        hand,
        midi,
        startBeat: i * 0.5,
        beats: i === line.length - 1 ? bars * 4 - i * 0.5 : 0.5,
        finger,
        velocity: i % 4 ? 0.58 : 0.68,
        spell: name,
      });
    });
  }

  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);

  return {
    id: `piano-scale-${variant.slug}-${slug(tonic)}-${family.id}`,
    kind: "scale",
    title: `${tonic} ${family.name}`,
    subtitle: `${variant.name} · ${octaves === 2 ? "2 octaves" : "1 octave"}`,
    description: `${tonic} ${family.name} (${family.note}) — ${variant.name.toLowerCase()}.`,
    tonic,
    pitchClass: pitch,
    mode: family.third,
    familyId: family.id,
    handVariant: variant.slug,
    bpm: customBpm ?? family.tempo.target,
    meter: { numerator: 4, denominator: 4 },
    bars,
    chords: [],
    numerals: [],
    notes,
    pedals: [],
  };
}

// ---- Classical Chord Progressions (18 patterns x 12 keys) ----

export interface ProgressionPatternSpec {
  readonly slug: string;
  readonly numerals: readonly string[];
  readonly about: string;
  readonly examples?: readonly string[];
  readonly loose?: boolean;
  readonly harmonic?: boolean;
  readonly dominant?: boolean;
  readonly texture: ProgressionTexture;
  readonly blues?: boolean;
  readonly scale?: "dorian";
}

export const PROGRESSION_PATTERNS: Record<KeyMode, readonly ProgressionPatternSpec[]> = {
  major: [
    {
      slug: "I-IV-V-I",
      numerals: ["I", "IV", "V", "I"],
      texture: "pulse",
      about: "Home, subdominant, dominant and home: the foundational classical and popular cadence.",
      examples: ["La Bamba (Ritchie Valens)", "Twist and Shout (The Isley Brothers)"],
    },
    {
      slug: "I-vi-IV-V",
      numerals: ["I", "vi", "IV", "V"],
      texture: "broken",
      about: "The relative minor softens the move away before the dominant pulls home.",
      examples: ["Stand by Me (Ben E. King)", "Every Breath You Take (The Police)"],
    },
    {
      slug: "ii-V-I",
      numerals: ["ii7", "V7", "Imaj7", "Imaj7"],
      texture: "held",
      about: "Seventh chords a fifth apart: the core cadence of jazz standards and classical harmony.",
      examples: ["Autumn Leaves", "Tune Up (Miles Davis)"],
    },
    {
      slug: "I-V-vi-IV",
      numerals: ["I", "V", "vi", "IV"],
      texture: "offbeat",
      about: "Four-chord anthem progression falling to the relative minor.",
      examples: ["Let It Be (The Beatles)", "I'm Yours (Jason Mraz)"],
    },
    {
      slug: "I-vi-ii-V",
      numerals: ["I", "vi", "ii", "V"],
      texture: "pulse",
      about: "Circle of fifths turnaround back home.",
      examples: ["I Got Rhythm (Gershwin)", "Blue Moon (Rodgers and Hart)"],
    },
    {
      slug: "I-bVII-IV-I",
      numerals: ["I", "bVII", "IV", "I"],
      texture: "pulse",
      about: "Mixolydian flat-seventh cadence borrowed from the parallel minor.",
      examples: ["Hey Jude (The Beatles)", "Sweet Child o' Mine (Guns N' Roses)"],
    },
    {
      slug: "I-IV-V-IV",
      numerals: ["I", "IV", "V", "IV"],
      texture: "offbeat",
      about: "The three primary triads rocking back through IV.",
      examples: ["Wild Thing (The Troggs)"],
    },
    {
      slug: "I-iii-IV-V",
      numerals: ["I", "iii", "IV", "V"],
      texture: "held",
      about: "Ascending stepwise bass from I through iii and IV to V.",
      examples: ["Let's Get It On (Marvin Gaye)"],
    },
    {
      slug: "canon",
      numerals: ["I", "V", "vi", "iii", "IV", "I", "IV", "V"],
      texture: "broken",
      about: "Pachelbel's Canon sequence with descending/stepwise bass under eight chords.",
      examples: ["Canon in D (Johann Pachelbel)"],
    },
    {
      slug: "twelve-bar-blues",
      numerals: ["I7", "I7", "I7", "I7", "IV7", "IV7", "I7", "I7", "V7", "IV7", "I7", "V7"],
      dominant: true,
      blues: true,
      texture: "offbeat",
      about: "Twelve-bar blues on dominant seventh chords I7, IV7, and V7.",
      examples: ["Johnny B. Goode (Chuck Berry)", "Hound Dog (Big Mama Thornton)"],
    },
  ],
  minor: [
    {
      slug: "i-iv-v-i",
      numerals: ["i", "iv", "v", "i"],
      texture: "held",
      about: "Natural minor cadence with minor tonic, subdominant, and minor dominant.",
      examples: ["Black Magic Woman (Fleetwood Mac)"],
      loose: true,
    },
    {
      slug: "i-VI-III-VII",
      numerals: ["i", "VI", "III", "VII"],
      texture: "offbeat",
      about: "Minor tonic to submediant, relative major, and subtonic.",
      examples: ["Zombie (The Cranberries)", "Save Tonight (Eagle-Eye Cherry)"],
    },
    {
      slug: "i-iv-VII-III",
      numerals: ["i", "iv", "VII", "III"],
      texture: "pulse",
      about: "Circle progression through the subtonic to the relative major.",
      examples: ["Island in the Sun (Weezer)", "It's My Life (Talk Talk)"],
    },
    {
      slug: "i-iv-V-i-harmonic",
      numerals: ["i", "iv", "V", "i"],
      harmonic: true,
      texture: "broken",
      about: "Classical harmonic minor cadence with raised leading tone in the major V chord.",
      examples: ["Minor Swing (Django Reinhardt)"],
    },
    {
      slug: "i-VII-VI-VII",
      numerals: ["i", "VII", "VI", "VII"],
      texture: "pulse",
      about: "Aeolian pendulum oscillating between i, VII, and VI.",
      examples: ["All Along the Watchtower (Bob Dylan)"],
    },
    {
      slug: "andalusian",
      numerals: ["i", "VII", "VI", "V"],
      harmonic: true,
      texture: "broken",
      about: "Andalusian cadence descending stepwise from i to major V.",
      examples: ["Hit the Road Jack (Ray Charles)"],
    },
    {
      slug: "minor-ii-V-i",
      numerals: ["iiø7", "V7", "i", "i"],
      harmonic: true,
      texture: "held",
      about: "Minor-key jazz/classical cadence with half-diminished iiø7 and dominant V7.",
      examples: ["Autumn Leaves (minor-key phrases)"],
    },
    {
      slug: "dorian-vamp",
      numerals: ["i7", "IV7"],
      scale: "dorian",
      texture: "offbeat",
      about: "Dorian vamp alternating minor seventh tonic i7 and major dominant seventh IV7.",
      examples: ["Oye Como Va (Tito Puente; Santana)"],
    },
  ],
};

const ROMAN_DEGREES = ["i", "ii", "iii", "iv", "v", "vi", "vii"] as const;
const QUALITY_BY_INTERVALS: Record<string, string> = {
  "4,7": "",
  "3,7": "m",
  "3,6": "dim",
  "4,7,11": "maj7",
  "4,7,10": "7",
  "3,7,10": "m7",
  "3,6,10": "m7b5",
};

const scalePitchClasses = (tonic: number, mode: KeyMode | "harmonic" | "dorian"): number[] =>
  MODES[mode].map((step) => (tonic + step) % 12);

export function numeralChord(
  tonic: string,
  mode: KeyMode,
  numeral: string,
  options: { harmonic?: boolean; dominant?: boolean; scale?: "dorian" } = {},
): string {
  const match = /^(b?)(i{1,3}|iv|vi{0,2}|v)(maj7|ø7|7)?$/i.exec(numeral);
  if (!match) throw new Error(`Unknown numeral: ${numeral}`);
  const [, flat, roman, suffix] = match;
  const degree = ROMAN_DEGREES.indexOf(roman!.toLowerCase() as (typeof ROMAN_DEGREES)[number]);
  const from = flat
    ? "minor"
    : (options.scale ?? (mode === "minor" && options.harmonic && degree === 4 ? "harmonic" : mode));
  const scale = scalePitchClasses(pitchOf(tonic), from);
  const tones = [0, 2, 4, ...(suffix ? [6] : [])].map((step) => scale[(degree + step) % 7]!);
  if (options.dominant && suffix === "7" && roman === roman!.toUpperCase()) {
    tones[3] = (tones[0]! + 10) % 12;
  }
  const intervalKey = tones
    .slice(1)
    .map((tone) => (tone - tones[0]! + 12) % 12)
    .join(",");
  const quality = QUALITY_BY_INTERVALS[intervalKey];
  if (quality === undefined) {
    throw new Error(`Invalid chord quality for ${numeral} in ${tonic} ${mode}`);
  }
  return spell(tonic, degree, tones[0]!) + quality;
}

type RightStroke = readonly [start: number, beats: number];
type ArpStroke = readonly [start: number, beats: number, index: number];
type LeftStroke = readonly [
  start: number,
  beats: number,
  degrees: readonly LeftDegree[],
  fingers?: readonly FingerNumber[],
];

const PROGRESSION_RIGHT = {
  K: [[[0, 4]]] as ReadonlyArray<ReadonlyArray<RightStroke>>,
  A: [[[0, 1], [1, 1], [2, 1], [3, 1]]] as ReadonlyArray<ReadonlyArray<RightStroke>>,
  S: [[[0.5, 0.5], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]]] as ReadonlyArray<ReadonlyArray<RightStroke>>,
  B: [[[0, 1.5], [1.5, 0.5], [2, 1.5], [3.5, 0.5]]] as ReadonlyArray<ReadonlyArray<RightStroke>>,
  C: [[[0, 0.75], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]]] as ReadonlyArray<ReadonlyArray<RightStroke>>,
  P: [
    [
      [0, 0.5, 0],
      [0.5, 0.5, 1],
      [1, 0.5, 2],
      [1.5, 0.5, 1],
      [2, 0.5, 0],
      [2.5, 0.5, 1],
      [3, 0.5, 2],
      [3.5, 0.5, 1],
    ],
  ] as ReadonlyArray<ReadonlyArray<ArpStroke>>,
};

const PROGRESSION_LEFT: Record<"b" | "o" | "m" | "t", ReadonlyArray<LeftStroke>> = {
  b: [[0, 4, ["R", "5"], [5, 1]]],
  o: [
    [0, 1, ["R"]],
    [1, 1, ["5"]],
    [2, 1, ["R"]],
    [3, 1, ["5"]],
  ],
  m: [
    [0, 1, ["R"]],
    [1, 1, ["5"]],
    [2, 1, ["8"]],
    [3, 1, ["5"]],
  ],
  t: [
    [0, 1, ["R"]],
    [1, 1, ["5"]],
    [2, 1, ["R"]],
    [3, 1, [">"]],
  ],
};

const TEXTURE_MAP: Record<
  ProgressionTexture,
  { right: string; left: string; pedal: boolean; words: string }
> = {
  held: { right: "KKKK", left: "bbbb", pedal: true, words: "held block chords" },
  pulse: {
    right: "AAAA",
    left: "oooo",
    pedal: false,
    words: "four quarter-note chords over root and fifth",
  },
  offbeat: {
    right: "SSSS",
    left: "mmmm",
    pedal: false,
    words: "off-beat chords over a walking bass",
  },
  broken: { right: "PPPP", left: "bbbb", pedal: true, words: "broken arpeggio chords" },
};

const CONTRAST_TEXTURE: Record<ProgressionTexture, ProgressionTexture> = {
  held: "pulse",
  pulse: "broken",
  offbeat: "held",
  broken: "offbeat",
};

function progressionPlan(
  pattern: ProgressionPatternSpec,
  once: readonly string[],
  overrideTexture?: ProgressionTexture,
) {
  const effectiveTexture = overrideTexture ?? pattern.texture;
  const size = once.length;
  const a = TEXTURE_MAP[effectiveTexture];
  const b = TEXTURE_MAP[CONTRAST_TEXTURE[effectiveTexture]];
  const repeat = (line: string, bars: number) =>
    line.repeat(Math.ceil(bars / line.length)).slice(0, bars);
  const pairs = (list: readonly string[]) =>
    Array.from(
      { length: Math.ceil(list.length / 2) },
      (_, i) => `${list[2 * i]!} ${list[(2 * i + 1) % list.length]!}`,
    );
  const numerals = pattern.numerals;

  if (pattern.blues && !overrideTexture) {
    return {
      chords: [...once, ...once],
      numerals: [...numerals, ...numerals],
      right: `${repeat("C", 12)}${repeat("A", 12)}`,
      left: `${repeat("m", 12)}${repeat("o", 11)}t`,
      pedal: false,
    };
  }
  if (size === 8 || pattern.blues) {
    const barCount = once.length;
    return {
      chords: [...once, ...once],
      numerals: [...numerals, ...numerals],
      right: `${repeat(a.right[0]!, barCount)}${repeat(b.right[0]!, barCount)}`,
      left: `${repeat(a.left[0]!, barCount)}${repeat("m", barCount - 1)}t`,
      pedal: a.pedal,
    };
  }
  const cycle = (bars: number) => Array.from({ length: bars }, (_, i) => once[i % size]!);
  const cycleNumerals = (bars: number) =>
    Array.from({ length: bars }, (_, i) => numerals[i % size]!);
  const fast = pairs(cycle(8));
  const fastNumerals = pairs(cycleNumerals(8));
  return {
    chords: [...cycle(4), ...cycle(4), ...fast, ...cycle(4)],
    numerals: [...cycleNumerals(4), ...cycleNumerals(4), ...fastNumerals, ...cycleNumerals(4)],
    right: `${a.right}${b.right}BBBB${a.right}`,
    left: `${a.left}mmmmoooo${a.left.slice(0, 3)}t`,
    pedal: a.pedal,
  };
}

interface ChordSpanInternal {
  bar: number;
  symbol: string;
  start: number;
  end: number;
}

function buildChordSpans(chords: readonly string[], beatsPerBar: number): ChordSpanInternal[] {
  return chords.flatMap((bar, index) => {
    const parts = bar.split(" ").filter(Boolean);
    const length = beatsPerBar / parts.length;
    return parts.map((symbol, part) => ({
      bar: index,
      symbol,
      start: index * beatsPerBar + part * length,
      end: index * beatsPerBar + (part + 1) * length,
    }));
  });
}

function leftPrefer(offset: number): FingerNumber {
  return offset <= 0 ? 5 : offset <= 2 ? 4 : offset <= 4 ? 3 : offset <= 7 ? 2 : 1;
}

export function generateProgressionExercise(
  pitchClass: number,
  mode: KeyMode,
  patternSlug: string,
  options: { texture?: ProgressionTexture; bpm?: number } = {},
): TonalExercise {
  const pitch = ((pitchClass % 12) + 12) % 12;
  const tonic = KEY_NAMES[mode][pitch]!;
  const modePatterns = PROGRESSION_PATTERNS[mode];
  const pattern =
    modePatterns.find((p) => p.slug.toLowerCase() === patternSlug.toLowerCase()) ??
    modePatterns[0]!;

  const once = pattern.numerals.map((numeral) => numeralChord(tonic, mode, numeral, pattern));
  const plan = progressionPlan(pattern, once, options.texture);
  const beatsPerBar = 4;
  const bars = plan.chords.length;
  const spans = buildChordSpans(plan.chords, beatsPerBar);
  const contour = [72, 74, 76, 74, 76, 77, 79, 74, 74, 76, 77, 79, 76, 74, 72, 71];
  const rightTokens = [...plan.right.replace(/ /g, "")];
  const leftTokens = [...plan.left.replace(/ /g, "")];

  const mutableNotes: MutableNote[] = [];
  const turns: Record<string, number> = {};
  let previousVoicing: number[] | null = null;

  const spanAt = (beat: number): ChordSpanInternal => {
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i]!.start <= beat + 1e-9) return spans[i]!;
    }
    return spans[0]!;
  };

  const addNote = (note: Omit<MutableNote, "velocity"> & { velocity?: number }) => {
    mutableNotes.push({
      velocity:
        note.velocity ??
        (Math.abs(note.startBeat - Math.round(note.startBeat)) < 1e-9 ? 0.68 : 0.58),
      ...note,
    });
  };

  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar;
    const end = beatsPerBar;
    const target = contour[bar % contour.length]!;
    const voiced = new Map<ChordSpanInternal, number[]>();
    const voice = (span: ChordSpanInternal): number[] => {
      if (!voiced.has(span)) {
        previousVoicing = chooseVoicing(span.symbol, false, previousVoicing, target);
        voiced.set(span, previousVoicing);
      }
      return voiced.get(span)!;
    };
    const ownSpans = spans.filter((s) => s.bar === bar && s.start < start + end - 1e-9);
    const clipLen = (at: number, beats: number, span: ChordSpanInternal) =>
      Math.min(beats, end - at, span.end - start - at);

    const rToken = rightTokens[bar]!;
    const turn = (turns[rToken] = (turns[rToken] ?? -1) + 1);
    if (rToken === "P") {
      const cell = PROGRESSION_RIGHT.P[turn % PROGRESSION_RIGHT.P.length]!;
      for (const [at, beats, index] of cell) {
        if (at >= end - 1e-9) continue;
        const span = spanAt(start + at);
        const chord = voice(span);
        const fingers = rightFingers(chord);
        addNote({
          hand: "right",
          midi: chord[index % chord.length]!,
          startBeat: start + at,
          beats: clipLen(at, beats, span),
          prefer: fingers[index % chord.length],
        });
      }
    } else {
      const cells = PROGRESSION_RIGHT[rToken as "K" | "A" | "S" | "B" | "C"]!;
      for (const [at, beats] of cells[turn % cells.length]!) {
        if (at >= end - 1e-9) continue;
        const span = spanAt(start + at);
        const chord = voice(span);
        const fingers = rightFingers(chord);
        chord.forEach((midi, idx) =>
          addNote({
            hand: "right",
            midi,
            startBeat: start + at,
            beats: clipLen(at, beats, span),
            finger: fingers[idx],
          }),
        );
      }
    }

    const lToken = leftTokens[bar] as "b" | "o" | "m" | "t";
    const lCell = PROGRESSION_LEFT[lToken];
    for (const [at, beats, degrees, fingers] of lCell) {
      if (at >= end - 1e-9) continue;
      const span = spanAt(start + at);
      const root = leftPitch(span.symbol, "R");
      degrees.forEach((degree, idx) => {
        const nextSpan = spans[(spans.indexOf(span) + 1) % spans.length]!;
        const midi =
          degree === ">" ? leftPitch(nextSpan.symbol, "R") + 1 : leftPitch(span.symbol, degree);
        const isChord = degrees.length > 1;
        addNote({
          hand: "left",
          midi,
          startBeat: start + at,
          beats: clipLen(at, beats, span),
          finger: isChord ? fingers?.[idx] : undefined,
          prefer: (isChord ? undefined : fingers?.[idx]) ?? leftPrefer(midi - root),
        });
      });
    }

    for (const span of ownSpans) {
      const hasHand = (hand: "right" | "left") =>
        mutableNotes.some(
          (n) => n.hand === hand && n.startBeat >= span.start - 1e-9 && n.startBeat < span.end - 1e-9,
        );
      const beats = Math.min(span.end, start + end) - span.start;
      if (!hasHand("right")) {
        const chord = voice(span);
        const fingers = rightFingers(chord);
        chord.forEach((midi, idx) =>
          addNote({
            hand: "right",
            midi,
            startBeat: span.start,
            beats,
            finger: fingers[idx],
          }),
        );
      }
      if (!hasHand("left")) {
        addNote({
          hand: "left",
          midi: leftPitch(span.symbol, "R"),
          startBeat: span.start,
          beats,
          prefer: 5,
        });
      }
    }
  }

  for (const hand of ["right", "left"] as const) {
    fingerLine(
      hand,
      mutableNotes.filter((n) => n.hand === hand),
    );
  }
  mutableNotes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);

  const notes: TonalNote[] = mutableNotes.map((n) => ({
    hand: n.hand,
    midi: n.midi,
    startBeat: n.startBeat,
    beats: n.beats,
    finger: n.finger ?? 1,
    velocity: n.velocity,
  }));

  const pedals: TonalPedal[] = plan.pedal
    ? spans
        .map((span) => ({
          controller: 64 as const,
          startBeat: span.start + 0.25,
          beats: span.end - span.start - 0.5,
        }))
        .filter((p) => p.beats > 0)
    : [];

  const writtenNumerals = pattern.numerals.join(" – ");
  const writtenChords = [...new Set(once)].join(" – ");
  const titleName = pattern.blues
    ? "12-Bar Blues (I7 – IV7 – V7)"
    : `${writtenNumerals}${pattern.harmonic ? " (Harmonic Minor)" : ""}${pattern.scale ? " (Dorian)" : ""}`;

  return {
    id: `piano-progression-${pattern.slug.toLowerCase()}-${slug(tonic)}-${mode}`,
    kind: "progression",
    title: `${titleName} in ${tonic} ${mode}`,
    subtitle: `${writtenChords} · ${bars} bars`,
    description: pattern.about,
    tonic,
    pitchClass: pitch,
    mode,
    bpm: options.bpm ?? (pattern.blues ? 108 : 96),
    meter: { numerator: 4, denominator: 4 },
    bars,
    chords: plan.chords,
    numerals: plan.numerals.map((n) => n.replace(" ", " – ")),
    ...(pattern.examples ? { examples: pattern.examples } : {}),
    notes,
    pedals,
  };
}
