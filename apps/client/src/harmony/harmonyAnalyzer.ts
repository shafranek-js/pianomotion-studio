/**
 * Real-time harmony & chord timeline analyzer + smooth voice-leading inversions.
 *
 * Adapted from Mizan (MIT License, Copyright (c) 2026 Mizan Contributors):
 * - host/mizan/engine/harmony.py (detect_key, numeral, classify_chord, smooth_chords)
 * - ui/src/workspace/song.ts (invert, slash, smoothInversions)
 * - ui/src/workspace/harmonize.ts (numeral, chordTones)
 */

export interface HarmonyNoteInput {
  pitch: number;
  startSeconds: number;
  endSeconds: number;
  velocity?: number;
}

export interface DetectedKey {
  tonic: string;
  rootPc: number;
  mode: "major" | "minor";
  correlation: number;
}

export type HarmonicRole = "tonic" | "predominant" | "dominant";

export interface HarmonyChordEvent {
  index: number;
  bar: number;
  startBeat: number;
  beats: number;
  startSeconds: number;
  endSeconds: number;
  symbol: string;
  slashSymbol: string;
  numeral: string | null;
  role: HarmonicRole | null;
  tones: number[];
  smoothTones: number[];
  smoothInversion: number;
  toneNames: string[];
  smoothToneNames: string[];
  flats: boolean;
  confidence: number;
}

export interface PieceHarmonyAnalysis {
  key: DetectedKey | null;
  bpm: number;
  beatsPerBar: number;
  totalBars: number;
  chords: HarmonyChordEvent[];
}

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;
const NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

const QUALITIES: Record<string, readonly number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

const KEY_PROFILES: Record<"major" | "minor", readonly number[]> = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

function mod12(n: number): number {
  return ((Math.round(n) % 12) + 12) % 12;
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 1e-9 ? num / den : 0;
}

export function detectKeyFromChroma(chroma: readonly number[]): DetectedKey | null {
  let sum = 0;
  for (const v of chroma) sum += v;
  if (sum < 1e-7) return null;

  const scored: Array<{ score: number; root: number; mode: "major" | "minor" }> = [];
  for (const mode of ["major", "minor"] as const) {
    const profile = KEY_PROFILES[mode];
    for (let root = 0; root < 12; root += 1) {
      const rolled = Array.from({ length: 12 }, (_, i) => profile[mod12(i - root)]);
      const score = pearsonCorrelation(chroma, rolled);
      scored.push({ score, root, mode });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.35) return null;
  return {
    tonic: NAMES[best.root],
    rootPc: best.root,
    mode: best.mode,
    correlation: Number(best.score.toFixed(3)),
  };
}

export function chordRomanNumeral(
  root: number,
  quality: string,
  key: Pick<DetectedKey, "rootPc" | "mode"> | null,
): { numeral: string | null; role: HarmonicRole | null } {
  if (!key) return { numeral: null, role: null };
  const interval = mod12(root - key.rootPc);
  const scale = key.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const romans = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

  if (quality === "7" && interval !== 7) {
    const target = mod12(interval + 5);
    const degree = scale.indexOf(target);
    if (degree >= 0) {
      let targetName: string = romans[degree];
      const minorDegrees = key.mode === "major" ? [1, 2, 5] : [0, 3, 4];
      if (minorDegrees.includes(degree)) targetName = targetName.toLowerCase();
      return { numeral: `V7/${targetName}`, role: "dominant" };
    }
  }

  let degree = scale.indexOf(interval);
  let text: string;
  if (degree >= 0) {
    text = romans[degree];
  } else {
    degree = scale.findIndex((pc) => mod12(pc - interval) === 1);
    if (degree < 0) return { numeral: null, role: null };
    text = `b${romans[degree]}`;
  }

  if ((quality.startsWith("m") && quality !== "maj7") || quality === "dim") {
    text = text.toLowerCase();
  }
  const suffixMap: Record<string, string> = {
    "": "",
    m: "",
    "7": "7",
    m7: "7",
    maj7: "maj7",
    dim: "°",
    sus4: "sus4",
  };
  text += suffixMap[quality] ?? quality;
  const role: HarmonicRole =
    degree === 0 || degree === 2 || degree === 5
      ? "tonic"
      : degree === 1 || degree === 3
        ? "predominant"
        : "dominant";
  return { numeral: text, role };
}

/** Inversion n of a close voicing: the lowest tone moves up an octave n times. */
export function invertChordTones(tones: readonly number[], n: number): number[] {
  if (tones.length === 0) return [];
  let t = [...tones].sort((a, b) => a - b);
  const steps = ((n % t.length) + t.length) % t.length;
  for (let i = 0; i < steps; i += 1) {
    t = [...t.slice(1), t[0] + 12];
  }
  return t[0] > 66 ? t.map((m) => m - 12) : t;
}

/** For each chord, choose the inversion whose tones move least from the previous chord. */
export function smoothChordInversions(chords: readonly { tones: readonly number[] }[]): number[] {
  let prev: number[] | null = null;
  return chords.map((c) => {
    if (!c.tones.length) return 0;
    let best = 0;
    let cost = Infinity;
    for (let n = 0; n < c.tones.length; n += 1) {
      const t = invertChordTones(c.tones, n);
      const d = prev
        ? t.reduce((s, m) => s + Math.min(...prev!.map((p) => Math.abs(p - m))), 0) +
          Math.abs(t[0] - prev[0]) * 0.5
        : n;
      if (d < cost) {
        cost = d;
        best = n;
      }
    }
    prev = invertChordTones(c.tones, best);
    return best;
  });
}

export function notePitchName(midi: number, flats = false): string {
  const pc = mod12(midi);
  return flats ? NAMES[pc] : NAMES_SHARP[pc];
}

export function classifyChordChroma(
  vector: readonly number[],
  energy: number,
  key: DetectedKey | null = null,
  lowestPitchClass: number | null = null,
): {
  symbol: string | null;
  numeral: string | null;
  role: HarmonicRole | null;
  tones: number[];
  flats: boolean;
  confidence: number;
} {
  const empty = { symbol: null, numeral: null, role: null, tones: [] as number[], flats: false, confidence: 0 };
  if (energy < 1e-6) {
    return { ...empty, symbol: "N.C.", confidence: 1.0 };
  }
  const maximum = Math.max(...vector);
  if (maximum < 1e-6) return empty;
  const normalized = vector.map((v) => v / maximum);
  const activeCount = normalized.filter((v) => v > 0.2).length;
  if (activeCount < 2) return empty;

  const candidates: Array<{ score: number; root: number; quality: string }> = [];
  for (let root = 0; root < 12; root += 1) {
    for (const [quality, offsets] of Object.entries(QUALITIES)) {
      const pcs = offsets.map((offset) => mod12(root + offset));
      const inside = pcs.map((pc) => normalized[pc]);
      const outside: number[] = [];
      for (let pc = 0; pc < 12; pc += 1) {
        if (!pcs.includes(pc)) outside.push(normalized[pc]);
      }
      const insideMean = inside.reduce((a, b) => a + b, 0) / inside.length;
      const outsideMean = outside.reduce((a, b) => a + b, 0) / Math.max(1, outside.length);
      const insideMin = Math.min(...inside);
      const bassBonus = lowestPitchClass !== null && lowestPitchClass === root ? 0.08 : 0;
      const triadPreference = offsets.length === 3 ? 0.03 : 0;
      const score = insideMean - outsideMean * 0.8 - (1 - insideMin) * 0.32 + bassBonus + triadPreference;
      candidates.push({ score, root, quality });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  const margin = best.score - (second?.score ?? 0);
  const confidence = Math.max(0, Math.min(1, best.score * 0.7 + margin));
  if (best.score < 0.35) {
    return { ...empty, confidence: Math.min(confidence, 0.34) };
  }

  const flats =
    key !== null
      ? (key.mode === "major"
          ? ["F", "Bb", "Eb", "Ab", "Db", "Gb"].includes(key.tonic)
          : ["D", "G", "C", "F", "Bb", "Eb"].includes(key.tonic))
      : [1, 3, 5, 6, 8, 10].includes(best.root);
  const rootName = flats ? NAMES[best.root] : NAMES_SHARP[best.root];
  const { numeral, role } = chordRomanNumeral(best.root, best.quality, key);
  const baseMidi = best.root > 6 ? 48 + best.root : 60 + best.root;
  const tones = QUALITIES[best.quality].map((offset) => baseMidi + offset);

  return {
    symbol: `${rootName}${best.quality}`,
    numeral,
    role,
    tones,
    flats,
    confidence: Number(confidence.toFixed(3)),
  };
}

export function analyzePieceHarmony(
  notes: readonly HarmonyNoteInput[],
  options?: { bpm?: number; beatsPerBar?: number },
): PieceHarmonyAnalysis {
  const bpm = options?.bpm && options.bpm > 0 ? options.bpm : 120;
  const beatsPerBar = options?.beatsPerBar && options.beatsPerBar > 0 ? options.beatsPerBar : 4;
  if (notes.length === 0) {
    return { key: null, bpm, beatsPerBar, totalBars: 0, chords: [] };
  }

  const beatDuration = 60 / bpm;
  const barDuration = beatDuration * beatsPerBar;
  const maxEndSeconds = Math.max(...notes.map((n) => n.endSeconds), barDuration);
  const totalBars = Math.max(1, Math.ceil(maxEndSeconds / barDuration));

  // Build global pitch-class histogram weighted by duration * velocity
  const globalChroma = new Array<number>(12).fill(0);
  for (const n of notes) {
    const dur = Math.max(0.05, n.endSeconds - n.startSeconds);
    const vel = (n.velocity ?? 80) / 127;
    globalChroma[mod12(n.pitch)] += dur * vel;
  }
  const key = detectKeyFromChroma(globalChroma);

  // Analyze each half-bar (or bar when sparse) and merge identical consecutive chords
  const windowBeats = beatsPerBar >= 4 ? 2 : beatsPerBar;
  const windowDuration = windowBeats * beatDuration;
  const windowCount = Math.max(1, Math.ceil(maxEndSeconds / windowDuration));

  interface RawWindowChord {
    startBeat: number;
    beats: number;
    startSeconds: number;
    endSeconds: number;
    symbol: string;
    numeral: string | null;
    role: HarmonicRole | null;
    tones: number[];
    flats: boolean;
    confidence: number;
  }

  const rawWindows: RawWindowChord[] = [];
  for (let w = 0; w < windowCount; w += 1) {
    const startSeconds = w * windowDuration;
    const endSeconds = (w + 1) * windowDuration;
    const startBeat = w * windowBeats;
    const chroma = new Array<number>(12).fill(0);
    let energy = 0;
    let lowestPitch = Infinity;

    for (const n of notes) {
      const overlap = Math.min(n.endSeconds, endSeconds) - Math.max(n.startSeconds, startSeconds);
      if (overlap <= 0) continue;
      const vel = (n.velocity ?? 80) / 127;
      const attackBonus = n.startSeconds >= startSeconds - 0.02 && n.startSeconds < endSeconds ? 1.25 : 1.0;
      const weight = overlap * vel * attackBonus;
      chroma[mod12(n.pitch)] += weight;
      energy += weight;
      if (n.pitch < lowestPitch) lowestPitch = n.pitch;
    }

    const lowestPc = Number.isFinite(lowestPitch) ? mod12(lowestPitch) : null;
    const classified = classifyChordChroma(chroma, energy, key, lowestPc);
    rawWindows.push({
      startBeat,
      beats: windowBeats,
      startSeconds,
      endSeconds,
      symbol: classified.symbol ?? "N.C.",
      numeral: classified.numeral,
      role: classified.role,
      tones: classified.tones,
      flats: classified.flats,
      confidence: classified.confidence,
    });
  }

  // Smooth isolated 1-window low-confidence flickers between identical neighbors
  for (let i = 1; i < rawWindows.length - 1; i += 1) {
    const prev = rawWindows[i - 1];
    const curr = rawWindows[i];
    const next = rawWindows[i + 1];
    if (
      prev.symbol !== "N.C." &&
      prev.symbol === next.symbol &&
      curr.symbol !== prev.symbol &&
      curr.confidence < 0.55
    ) {
      rawWindows[i] = {
        ...prev,
        startBeat: curr.startBeat,
        beats: curr.beats,
        startSeconds: curr.startSeconds,
        endSeconds: curr.endSeconds,
      };
    }
  }

  // Merge consecutive identical chords within or across windows
  const merged: RawWindowChord[] = [];
  for (const item of rawWindows) {
    const prev = merged[merged.length - 1];
    if (prev && prev.symbol === item.symbol && Math.abs(prev.endSeconds - item.startSeconds) < 1e-4) {
      const totalBeats = prev.beats + item.beats;
      prev.confidence = Number(
        ((prev.confidence * prev.beats + item.confidence * item.beats) / totalBeats).toFixed(3),
      );
      prev.beats = totalBeats;
      prev.endSeconds = item.endSeconds;
    } else {
      merged.push({ ...item });
    }
  }

  const inversions = smoothChordInversions(merged);
  const chords: HarmonyChordEvent[] = merged.map((c, index) => {
    const inv = inversions[index] ?? 0;
    const smoothTones = invertChordTones(c.tones, inv);
    const bassPitch = smoothTones[0];
    const bassName = bassPitch !== undefined ? notePitchName(bassPitch, c.flats) : "";
    const slashSymbol =
      inv > 0 && c.symbol !== "N.C." && bassName
        ? `${c.symbol}/${bassName}`
        : c.symbol;
    return {
      index,
      bar: Math.floor(c.startBeat / beatsPerBar) + 1,
      startBeat: c.startBeat,
      beats: c.beats,
      startSeconds: Number(c.startSeconds.toFixed(4)),
      endSeconds: Number(c.endSeconds.toFixed(4)),
      symbol: c.symbol,
      slashSymbol,
      numeral: c.numeral,
      role: c.role,
      tones: c.tones,
      smoothTones,
      smoothInversion: inv,
      toneNames: c.tones.map((t) => notePitchName(t, c.flats)),
      smoothToneNames: smoothTones.map((t) => notePitchName(t, c.flats)),
      flats: c.flats,
      confidence: c.confidence,
    };
  });

  return {
    key,
    bpm,
    beatsPerBar,
    totalBars,
    chords,
  };
}
