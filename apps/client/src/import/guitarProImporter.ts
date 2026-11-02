import {
  DEFAULT_SCORE_PPQ,
  writeCanonicalMidiFile,
  type CanonicalHandHint,
  type CanonicalKeySignatureEvent,
  type CanonicalPedalEvent,
  type CanonicalScore,
  type CanonicalScoreNote,
  type CanonicalScoreTrack,
  type CanonicalTempoEvent,
  type CanonicalTimeSignatureEvent,
} from "./scoreToMidiBytes";

const ALPHATAB_MIDI_TICKS_PER_QUARTER = 960;

/**
 * Maps AlphaTab DynamicValue enum (or numeric value) to MIDI velocity (1..127).
 */
function dynamicValueToVelocity(dyn: unknown): number {
  if (typeof dyn !== "number") return 80;
  // AlphaTab DynamicValue: PPP=0, PP=1, P=2, MP=3, MF=4, F=5, FF=6, FFF=7,
  // PPPP=8, PPPPP=9, PPPPPP=10, FFFF=11, FFFFF=12, FFFFFF=13, SF=14, SFP=15, SFPP=16, FP=17, RF=18, RFZ=19, SFZ=20, SFFZ=21, FZ=22
  switch (dyn) {
    case 0:
      return 28; // PPP
    case 1:
      return 40; // PP
    case 2:
      return 54; // P
    case 3:
      return 68; // MP
    case 4:
      return 80; // MF
    case 5:
      return 94; // F
    case 6:
      return 108; // FF
    case 7:
      return 120; // FFF
    case 8:
    case 9:
    case 10:
      return 18; // PPPP..PPPPPP
    case 11:
    case 12:
    case 13:
      return 126; // FFFF..FFFFFF
    case 14:
    case 19:
    case 20:
    case 21:
    case 22:
      return 114; // SF / SFZ / FZ
    default:
      return 80;
  }
}

/**
 * Converts an AlphaTab beat Duration + dots + tuplet into ticks at `ppq`.
 */
function computeBeatDurationTicks(
  beat: {
    playbackDuration?: number;
    duration?: number;
    dots?: number;
    hasTuplet?: boolean;
    tupletNumerator?: number;
    tupletDenominator?: number;
  },
  ppq: number,
): number {
  if (
    typeof beat.playbackDuration === "number" &&
    Number.isFinite(beat.playbackDuration) &&
    beat.playbackDuration > 0
  ) {
    return Math.max(
      1,
      Math.round((beat.playbackDuration * ppq) / ALPHATAB_MIDI_TICKS_PER_QUARTER),
    );
  }

  const dur = beat.duration ?? 4;
  let quarters: number;
  if (dur > 0) {
    quarters = 4 / dur;
  } else if (dur === -2) {
    quarters = 8; // DoubleWhole / Breve
  } else if (dur === -4) {
    quarters = 16; // QuadrupleWhole / Long
  } else {
    quarters = 1;
  }

  const dots = beat.dots ?? 0;
  if (dots === 1) {
    quarters *= 1.5;
  } else if (dots >= 2) {
    quarters *= 1.75;
  }

  const tupNum = beat.tupletNumerator ?? 0;
  const tupDen = beat.tupletDenominator ?? 0;
  if (tupNum > 0 && tupDen > 0 && tupNum !== tupDen) {
    quarters *= tupDen / tupNum;
  }

  return Math.max(1, Math.round(quarters * ppq));
}

function expandMasterBarSequence(
  masterBars: Array<{
    isRepeatStart?: boolean;
    repeatCount?: number;
    alternateEndings?: number;
  }>,
): number[] {
  if (masterBars.length === 0) return [];

  const sequence: number[] = [];
  const maxSteps = Math.max(masterBars.length * 6, 512);
  let idx = 0;
  let repeatStartIdx = 0;
  let currentPass = 1; // 1-based pass number
  const backwardVisits = new Map<number, number>();

  while (idx < masterBars.length && sequence.length < maxSteps) {
    const mb = masterBars[idx]!;
    if (mb.isRepeatStart && repeatStartIdx !== idx) {
      repeatStartIdx = idx;
      currentPass = 1;
    }

    const altMask = mb.alternateEndings ?? 0;
    if (altMask > 0) {
      const passBit = 1 << (currentPass - 1);
      if ((altMask & passBit) === 0) {
        idx++;
        continue;
      }
    }

    sequence.push(idx);

    const repeatCount = mb.repeatCount ?? 0;
    if (repeatCount > 0) {
      // In AlphaTab, repeatCount is total play count (>= 2) or 1 additional repeat
      const totalPasses = repeatCount >= 2 ? repeatCount : 2;
      const visits = (backwardVisits.get(idx) ?? 0) + 1;
      backwardVisits.set(idx, visits);
      if (visits < totalPasses) {
        currentPass = visits + 1;
        idx = repeatStartIdx;
        continue;
      } else {
        currentPass = 1;
      }
    }

    idx++;
  }

  return sequence.length > 0 ? sequence : masterBars.map((_, i) => i);
}

function mapAlphaTabFinger(
  fingerVal: unknown,
): 1 | 2 | 3 | 4 | 5 | undefined {
  if (typeof fingerVal !== "number") return undefined;
  const rounded = Math.round(fingerVal);
  return rounded >= 1 && rounded <= 5
    ? (rounded as 1 | 2 | 3 | 4 | 5)
    : undefined;
}

export interface GuitarProImportOptions {
  /** Optional explicit 0-based track indices to include */
  trackIndices?: number[];
}

/**
 * Lazily loads `@coderline/alphatab` and parses a Guitar Pro file (`.gtp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`, `.gp`)
 * into a CanonicalScore structure preserving polyphonic voices, grand-staff piano staves, repeats, and tempo map.
 */
export async function parseGuitarProBytesToCanonicalScore(
  input: ArrayBuffer | Uint8Array,
  options?: GuitarProImportOptions,
): Promise<CanonicalScore> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const alphaTab = await import("@coderline/alphatab");

  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(
    bytes,
    settings,
  );

  const ppq = DEFAULT_SCORE_PPQ;
  const title = (score.title || "").trim() || undefined;
  const initialBpm =
    typeof score.tempo === "number" && score.tempo > 0 ? score.tempo : 120;

  const masterBars = score.masterBars ?? [];
  if (masterBars.length === 0) {
    throw new Error("Guitar Pro file contains no bars.");
  }

  const barSequence = expandMasterBarSequence(masterBars);

  const tempos: CanonicalTempoEvent[] = [{ tick: 0, bpm: initialBpm }];
  const timeSignatures: CanonicalTimeSignatureEvent[] = [];
  const keySignatures: CanonicalKeySignatureEvent[] = [];
  const pedals: CanonicalPedalEvent[] = [];

  // Precalculate bar start ticks and global conductor events along the expanded bar sequence
  const barStartTicks: number[] = [];
  const barNominalTicks: number[] = [];
  let runningTick = 0;
  let lastTsNum = -1;
  let lastTsDen = -1;
  let lastKeyFifths: number | null = null;

  for (let seqIdx = 0; seqIdx < barSequence.length; seqIdx++) {
    const mbIdx = barSequence[seqIdx]!;
    const mb = masterBars[mbIdx]!;
    const tsNum =
      typeof mb.timeSignatureNumerator === "number" &&
      mb.timeSignatureNumerator >= 1
        ? mb.timeSignatureNumerator
        : 4;
    const tsDen =
      typeof mb.timeSignatureDenominator === "number" &&
      mb.timeSignatureDenominator >= 1
        ? mb.timeSignatureDenominator
        : 4;

    if (tsNum !== lastTsNum || tsDen !== lastTsDen) {
      timeSignatures.push({
        tick: runningTick,
        numerator: tsNum,
        denominator: tsDen,
      });
      lastTsNum = tsNum;
      lastTsDen = tsDen;
    }

    const keyFifths =
      typeof mb.keySignature === "number" ? mb.keySignature : 0;
    if (keyFifths !== lastKeyFifths) {
      const isMinor = Number(mb.keySignatureType) === 1;
      keySignatures.push({
        tick: runningTick,
        fifths: Math.max(-7, Math.min(7, keyFifths)),
        mode: isMinor ? "minor" : "major",
      });
      lastKeyFifths = keyFifths;
    }

    const nominalTicks = Math.max(
      1,
      Math.round(((tsNum * 4) / tsDen) * ppq),
    );

    // Tempo automations inside the MasterBar
    const automations = mb.tempoAutomations ?? [];
    for (const auto of automations) {
      const bpm = Number(auto.value);
      const ratio = Number(auto.ratioPosition ?? 0);
      if (Number.isFinite(bpm) && bpm > 0) {
        const autoTick =
          runningTick +
          Math.max(
            0,
            Math.min(nominalTicks - 1, Math.round(ratio * nominalTicks)),
          );
        tempos.push({ tick: autoTick, bpm });
      }
    }

    barStartTicks.push(runningTick);
    barNominalTicks.push(nominalTicks);
    runningTick += nominalTicks;
  }

  // Select playable tracks (filtering out percussion tracks unless only percussion exists)
  const allTracks = score.tracks ?? [];
  const nonPercussionTracks = allTracks.filter((tr, idx) => {
    if (
      options?.trackIndices &&
      options.trackIndices.length > 0 &&
      !options.trackIndices.includes(idx)
    ) {
      return false;
    }
    const isPerc =
      tr.playbackInfo?.primaryChannel === 9 ||
      tr. playbackInfo?.secondaryChannel === 9 ||
      (tr.staves ?? []).some((s) => Boolean(s.isPercussion));
    return !isPerc;
  });

  const selectedTracks =
    nonPercussionTracks.length > 0 ? nonPercussionTracks : allTracks;

  const rightHandNotes: CanonicalScoreNote[] = [];
  const leftHandNotes: CanonicalScoreNote[] = [];
  const trackOutputList: CanonicalScoreTrack[] = [];

  selectedTracks.forEach((track, trackIdx) => {
    const staves = track.staves ?? [];
    const isTwoStaffTrack = staves.length >= 2;
    const trackName = (track.name || `Track ${trackIdx + 1}`).trim();
    const singleStaffNotes: CanonicalScoreNote[] = [];

    staves.forEach((staff, staffIdx) => {
      const hand: CanonicalHandHint | undefined = isTwoStaffTrack
        ? staffIdx === 0
          ? "right"
          : "left"
        : undefined;

      const bars = staff.bars ?? [];
      // Open ties keyed by `${voiceIdx}:${pitch}`
      const openTies = new Map<string, CanonicalScoreNote>();

      for (let seqIdx = 0; seqIdx < barSequence.length; seqIdx++) {
        const mbIdx = barSequence[seqIdx]!;
        const bar = bars[mbIdx];
        if (!bar) continue;

        const barStart = barStartTicks[seqIdx]!;
        const voices = bar.voices ?? [];

        voices.forEach((voice, voiceIdx) => {
          if (!voice || voice.isEmpty) return;
          const beats = voice.beats ?? [];
          let cursorTick = barStart;

          for (const beat of beats) {
            if (!beat) continue;

            // GraceType.None is 0 in AlphaTab
            const isGrace =
              typeof beat.graceType === "number" && beat.graceType !== 0;
            const durTicks = isGrace
              ? Math.max(12, Math.round(ppq / 8))
              : computeBeatDurationTicks(beat, ppq);

            const onsetTick = cursorTick;
            if (!isGrace) {
              cursorTick += durTicks;
            }

            if (beat.isRest) continue;

            const baseVel = dynamicValueToVelocity(beat.dynamics);
            const notes = beat.notes ?? [];

            for (const note of notes) {
              if (!note || !note.isVisible) continue;

              const rawPitch =
                typeof note.realValue === "number" && note.realValue > 0
                  ? note.realValue
                  : typeof note.realValueWithoutHarmonic === "number"
                    ? note.realValueWithoutHarmonic
                    : -1;
              if (rawPitch < 0 || rawPitch > 127) continue;

              const pitch = Math.round(rawPitch);
              const tieKey = `${voiceIdx}:${pitch}`;

              if (note.isTieDestination && openTies.has(tieKey)) {
                const prevNote = openTies.get(tieKey)!;
                const newEnd = onsetTick + durTicks;
                prevNote.durationTicks = Math.max(
                  prevNote.durationTicks + durTicks,
                  newEnd - prevNote.startTick,
                );
                if (!note.isTieOrigin) {
                  openTies.delete(tieKey);
                }
                continue;
              }

              let gateRatio = 1.0;
              if (note.isStaccato) {
                gateRatio = 0.5;
              } else if (note.isPalmMute || beat.isPalmMute) {
                gateRatio = 0.65;
              } else if (note.isLetRing || beat.isLetRing) {
                gateRatio = 1.15;
              }

              let velocity = baseVel;
              if (Number(note.accentuated) === 2) {
                velocity = Math.min(127, velocity + 20); // Heavy accent
              } else if (Number(note.accentuated) === 1) {
                velocity = Math.min(127, velocity + 12); // Normal accent
              } else if (note.isGhost) {
                velocity = Math.max(16, velocity - 22);
              }

              const effectiveDur = note.isTieOrigin
                ? durTicks
                : Math.max(1, Math.round(durTicks * gateRatio));

              const finger =
                mapAlphaTabFinger(note.leftHandFinger) ??
                mapAlphaTabFinger(note.rightHandFinger);

              const noteObj: CanonicalScoreNote = {
                pitch,
                startTick: onsetTick,
                durationTicks: effectiveDur,
                velocity,
                hand,
                finger,
                glissando:
                  (typeof note.slideOutType === "number" &&
                    note.slideOutType !== 0) ||
                  undefined,
              };

              if (hand === "right") {
                rightHandNotes.push(noteObj);
              } else if (hand === "left") {
                leftHandNotes.push(noteObj);
              } else {
                singleStaffNotes.push(noteObj);
              }

              if (note.isTieOrigin) {
                openTies.set(tieKey, noteObj);
              }
            }
          }
        });
      }
    });

    if (singleStaffNotes.length > 0) {
      trackOutputList.push({
        name: trackName,
        // Use program 0 (Acoustic Grand Piano) so PianoMotion's sanitize_instruments keeps all transcoded tracks
        program: 0,
        notes: singleStaffNotes,
      });
    }
  });

  const tracks: CanonicalScoreTrack[] = [];
  if (rightHandNotes.length > 0) {
    tracks.push({
      name: "Right Hand",
      hand: "right",
      program: 0,
      channel: 0,
      notes: rightHandNotes,
    });
  }
  if (leftHandNotes.length > 0) {
    tracks.push({
      name: "Left Hand",
      hand: "left",
      program: 0,
      channel: 1,
      notes: leftHandNotes,
    });
  }
  tracks.push(...trackOutputList);

  if (tracks.length === 0 || tracks.every((t) => t.notes.length === 0)) {
    throw new Error("Guitar Pro file contains no playable notes.");
  }

  return {
    title,
    ppq,
    tempos,
    timeSignatures,
    keySignatures,
    pedals,
    tracks,
  };
}

/**
 * Converts a Guitar Pro file (`.gtp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`, `.gp`) buffer into canonical SMF MIDI bytes.
 */
export async function convertGuitarProBytesToMidi(
  input: ArrayBuffer | Uint8Array,
  options?: GuitarProImportOptions,
): Promise<{ midiBytes: ArrayBuffer; score: CanonicalScore }> {
  const score = await parseGuitarProBytesToCanonicalScore(input, options);
  const midiUint8 = writeCanonicalMidiFile(score);
  const copy = new Uint8Array(midiUint8.byteLength);
  copy.set(midiUint8);
  return {
    midiBytes: copy.buffer,
    score,
  };
}
