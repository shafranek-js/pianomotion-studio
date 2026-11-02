import { isZipBytes } from "./scoreFormat";
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
import {
  decodeXmlBytes,
  parseXmlDocument,
  unzipArchiveEntries,
  type XmlNode,
} from "./xmlDom";

const MSCX_DURATION_QUARTERS: Record<string, number> = {
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
  "128th": 0.03125,
  "256th": 0.015625,
};

const MSCX_DYNAMIC_VELOCITY: Record<string, number> = {
  pppppp: 10,
  ppppp: 14,
  pppp: 18,
  ppp: 28,
  pp: 40,
  p: 54,
  mp: 68,
  mf: 80,
  f: 94,
  ff: 108,
  fff: 120,
  ffff: 126,
  fffff: 127,
  ffffff: 127,
  fp: 96,
  sf: 112,
  sfz: 116,
  sff: 120,
  sffz: 122,
  rfz: 110,
  rf: 108,
};

const GRACE_TAGS = new Set([
  "appoggiatura",
  "acciaccatura",
  "grace4",
  "grace8",
  "grace8after",
  "grace16",
  "grace16after",
  "grace32",
  "grace32after",
]);

/**
 * Extracts the uncompressed `.mscx` XML string from a `.mscz` ZIP archive (or raw `.mscx` XML bytes).
 */
export function extractMscxXmlText(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isZipBytes(bytes)) {
    return decodeXmlBytes(bytes);
  }

  const entries = unzipArchiveEntries(bytes);
  const entryNames = Object.keys(entries);
  const mscxKey = entryNames.find((name) =>
    name.replace(/\\/g, "/").toLowerCase().endsWith(".mscx"),
  );

  if (!mscxKey || !entries[mscxKey]) {
    throw new Error(
      "MuseScore archive (.mscz) does not contain a valid .mscx score file.",
    );
  }

  return decodeXmlBytes(entries[mscxKey]!);
}

function parseFractionToQuarters(fractionText: string | null): number | null {
  if (!fractionText) return null;
  const parts = fractionText.trim().split("/");
  if (parts.length !== 2) return null;
  const num = Number.parseFloat(parts[0]!);
  const den = Number.parseFloat(parts[1]!);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return (num / den) * 4;
}

function parseFingerNumber(text: string | null): 1 | 2 | 3 | 4 | 5 | undefined {
  if (!text) return undefined;
  const match = /[1-5]/.exec(text.trim());
  if (!match) return undefined;
  const num = Number.parseInt(match[0], 10);
  return num >= 1 && num <= 5 ? (num as 1 | 2 | 3 | 4 | 5) : undefined;
}

function expandMscxMeasureSequence(measures: XmlNode[]): number[] {
  if (measures.length === 0) return [];

  interface MscxRepeatInfo {
    startRepeat: boolean;
    endRepeatCount: number;
    voltaEndings: Set<number> | null;
    voltaSpanMeasures: number;
  }

  const infos: MscxRepeatInfo[] = measures.map((m) => {
    const startRepeat = m.child("startRepeat") !== undefined;
    const endRepeatText = m.textOf("endRepeat");
    const endRepeatParsed = endRepeatText
      ? Number.parseInt(endRepeatText, 10)
      : 0;
    const endRepeatCount =
      Number.isFinite(endRepeatParsed) && endRepeatParsed >= 2
        ? endRepeatParsed
        : endRepeatText !== null
          ? 2
          : 0;

    let voltaEndings: Set<number> | null = null;
    let voltaSpanMeasures = 1;

    for (const spanner of m.findAll("Spanner")) {
      const typeAttr = spanner.getAttribute("type")?.toLowerCase();
      if (typeAttr !== "volta") continue;
      if (spanner.child("prev") !== undefined) continue;
      const voltaNode = spanner.child("Volta");
      const endingsText = voltaNode?.textOf("endings") ?? "";
      const nums = endingsText
        .split(/[,\s]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 1);
      if (nums.length > 0) {
        voltaEndings = new Set(nums);
      }
      const nextLocMeasures = Number.parseInt(
        spanner.child("next")?.child("location")?.textOf("measures") ?? "1",
        10,
      );
      if (Number.isFinite(nextLocMeasures) && nextLocMeasures >= 1) {
        voltaSpanMeasures = nextLocMeasures;
      }
    }

    return { startRepeat, endRepeatCount, voltaEndings, voltaSpanMeasures };
  });

  // Propagate multi-measure volta spans
  const activeVoltaByMeasure: (Set<number> | null)[] = new Array(
    measures.length,
  ).fill(null);
  for (let i = 0; i < infos.length; i++) {
    const v = infos[i]!.voltaEndings;
    if (v) {
      const span = infos[i]!.voltaSpanMeasures;
      for (let k = 0; k < span && i + k < infos.length; k++) {
        activeVoltaByMeasure[i + k] = v;
      }
    }
  }

  const sequence: number[] = [];
  const maxSteps = Math.max(measures.length * 6, 512);
  let idx = 0;
  let repeatStartIdx = 0;
  let currentPass = 1;
  const backwardVisits = new Map<number, number>();

  while (idx < measures.length && sequence.length < maxSteps) {
    const info = infos[idx]!;
    if (info.startRepeat && repeatStartIdx !== idx) {
      repeatStartIdx = idx;
      currentPass = 1;
    }

    const volta = activeVoltaByMeasure[idx];
    if (volta !== null && volta !== undefined && !volta.has(currentPass)) {
      idx++;
      continue;
    }

    sequence.push(idx);

    if (info.endRepeatCount > 0) {
      const visits = (backwardVisits.get(idx) ?? 0) + 1;
      backwardVisits.set(idx, visits);
      if (visits < info.endRepeatCount) {
        currentPass = visits + 1;
        idx = repeatStartIdx;
        continue;
      } else {
        currentPass = 1;
      }
    }

    idx++;
  }

  return sequence.length > 0 ? sequence : measures.map((_, i) => i);
}

/**
 * Parses a MuseScore 3 / 4 `.mscx` XML string into a CanonicalScore structure.
 */
export function parseMscxToCanonicalScore(xmlText: string): CanonicalScore {
  const root = parseXmlDocument(xmlText);
  const scoreNode =
    root.localName === "Score" ? root : (root.findFirst("Score") ?? root);

  const ppq = DEFAULT_SCORE_PPQ;

  // 1. Extract Title
  let title: string | undefined;
  for (const meta of scoreNode.childrenNamed("metaTag")) {
    if (meta.getAttribute("name") === "workTitle" && meta.text.trim()) {
      title = meta.text.trim();
      break;
    }
  }
  if (!title) {
    for (const vbox of scoreNode.findAll("VBox")) {
      for (const txt of vbox.childrenNamed("Text")) {
        const style = txt.textOf("style")?.toLowerCase();
        if (style === "title" && txt.textOf("text")) {
          title = txt.textOf("text")!;
          break;
        }
      }
      if (title) break;
    }
  }

  // 2. Map Staff IDs to Parts and Hand Hints
  interface StaffMeta {
    staffId: string;
    partName: string;
    isPercussion: boolean;
    hand?: CanonicalHandHint;
  }

  const staffMetaMap = new Map<string, StaffMeta>();
  for (const part of scoreNode.childrenNamed("Part")) {
    const partStaves = part.childrenNamed("Staff");
    const instrument = part.child("Instrument");
    const partName =
      part.textOf("trackName") ||
      instrument?.textOf("longName") ||
      instrument?.textOf("trackName") ||
      "Piano";
    const useDrumset =
      instrument?.textOf("useDrumset") === "1" ||
      instrument?.child("Drum") !== undefined ||
      /\b(drum|percussion)\b/i.test(partName);

    partStaves.forEach((stNode, idx) => {
      const id = stNode.getAttribute("id") ?? String(idx + 1);
      let hand: CanonicalHandHint | undefined;
      if (partStaves.length >= 2) {
        hand = idx === 0 ? "right" : "left";
      }
      staffMetaMap.set(id, {
        staffId: id,
        partName,
        isPercussion: useDrumset,
        hand,
      });
    });
  }

  // 3. Collect actual body <Staff id="..."> nodes that contain <Measure> elements
  const bodyStaves = scoreNode
    .childrenNamed("Staff")
    .filter((st) => st.childrenNamed("Measure").length > 0);

  if (bodyStaves.length === 0) {
    throw new Error("MuseScore file (.mscz) contains no staff measures.");
  }

  // Filter out percussion staves if melodic staves exist
  const nonPercussionStaves = bodyStaves.filter((st) => {
    const id = st.getAttribute("id") ?? "1";
    return !staffMetaMap.get(id)?.isPercussion;
  });
  const selectedStaves =
    nonPercussionStaves.length > 0 ? nonPercussionStaves : bodyStaves;

  // If there are exactly 2 staves and no explicit Part mapping set their hands, assign Staff 1 = right, Staff 2 = left
  const assignTwoStaffHands = selectedStaves.length === 2;

  const primaryMeasures = selectedStaves[0]!.childrenNamed("Measure");
  const measureSequence = expandMscxMeasureSequence(primaryMeasures);

  const tempos: CanonicalTempoEvent[] = [];
  const timeSignatures: CanonicalTimeSignatureEvent[] = [];
  const keySignatures: CanonicalKeySignatureEvent[] = [];
  const pedals: CanonicalPedalEvent[] = [];

  const rightHandNotes: CanonicalScoreNote[] = [];
  const leftHandNotes: CanonicalScoreNote[] = [];
  const unassignedStaffNotes = new Map<string, CanonicalScoreNote[]>();

  // First pass across primary staff to build exact measure start ticks and time signatures
  const measureNominalTicks: number[] = [];
  let runningNominalBeats = 4;
  let runningNominalBeatType = 4;
  for (let mIdx = 0; mIdx < primaryMeasures.length; mIdx++) {
    const m = primaryMeasures[mIdx]!;
    const tsNode = m.findFirst("TimeSig");
    if (tsNode) {
      const sigN = Number.parseInt(tsNode.textOf("sigN") ?? "", 10);
      const sigD = Number.parseInt(tsNode.textOf("sigD") ?? "", 10);
      if (
        Number.isFinite(sigN) &&
        sigN >= 1 &&
        Number.isFinite(sigD) &&
        sigD >= 1
      ) {
        runningNominalBeats = sigN;
        runningNominalBeatType = sigD;
      }
    }
    const lenQuarters = parseFractionToQuarters(m.getAttribute("len"));
    const quarters =
      lenQuarters ?? (runningNominalBeats * 4) / runningNominalBeatType;
    measureNominalTicks.push(Math.max(1, Math.round(quarters * ppq)));
  }

  selectedStaves.forEach((staffNode, staffIdx) => {
    const staffId = staffNode.getAttribute("id") ?? String(staffIdx + 1);
    const meta = staffMetaMap.get(staffId);
    const hand: CanonicalHandHint | undefined =
      meta?.hand ??
      (assignTwoStaffHands ? (staffIdx === 0 ? "right" : "left") : undefined);

    const measures = staffNode.childrenNamed("Measure");
    let currentVelocity = 80;
    let measureStartTick = 0;

    // Open ties keyed by `${voiceIdx}:${pitch}`
    const openTies = new Map<string, CanonicalScoreNote>();

    for (let seqIdx = 0; seqIdx < measureSequence.length; seqIdx++) {
      const mIdx = measureSequence[seqIdx]!;
      const measure = measures[mIdx];
      const nominalTicks =
        measureNominalTicks[mIdx] ?? Math.round(4 * ppq);

      if (!measure) {
        measureStartTick += nominalTicks;
        continue;
      }

      // Check voices inside <Measure>: either explicit <voice> children or the <Measure> itself
      const voiceNodes = measure.childrenNamed("voice");
      const voicesToProcess = voiceNodes.length > 0 ? voiceNodes : [measure];

      // Pre-collect Tuplet definitions inside the measure by id
      const tupletRatiosById = new Map<string, number>();
      for (const tup of measure.findAll("Tuplet")) {
        const tupId = tup.getAttribute("id");
        const normal = Number.parseFloat(tup.textOf("normalNotes") ?? "");
        const actual = Number.parseFloat(tup.textOf("actualNotes") ?? "");
        if (
          tupId &&
          Number.isFinite(normal) &&
          normal > 0 &&
          Number.isFinite(actual) &&
          actual > 0
        ) {
          tupletRatiosById.set(tupId, normal / actual);
        }
      }

      let maxMeasureEndTick = measureStartTick + nominalTicks;

      voicesToProcess.forEach((voiceNode, voiceIdx) => {
        let cursorTick = measureStartTick;
        let activeTupletRatio = 1.0;
        let activeTupletRemainingChords = 0;

        for (const el of voiceNode.children) {
          const tag = el.localName;

          if (tag === "TimeSig" && staffIdx === 0 && voiceIdx === 0) {
            const sigN = Number.parseInt(el.textOf("sigN") ?? "", 10);
            const sigD = Number.parseInt(el.textOf("sigD") ?? "", 10);
            if (
              Number.isFinite(sigN) &&
              sigN >= 1 &&
              Number.isFinite(sigD) &&
              sigD >= 1
            ) {
              timeSignatures.push({
                tick: measureStartTick,
                numerator: sigN,
                denominator: sigD,
              });
            }
            continue;
          }

          if (tag === "KeySig" && staffIdx === 0 && voiceIdx === 0) {
            const acc = Number.parseInt(
              el.textOf("accidental") ?? el.textOf("concertKey") ?? "0",
              10,
            );
            if (Number.isFinite(acc)) {
              keySignatures.push({
                tick: measureStartTick,
                fifths: Math.max(-7, Math.min(7, acc)),
                mode: "major",
              });
            }
            continue;
          }

          if (tag === "Tempo") {
            const rawTempo = Number.parseFloat(el.textOf("tempo") ?? "");
            if (Number.isFinite(rawTempo) && rawTempo > 0) {
              // MuseScore stores <tempo> in beats per second (e.g. 2.0 = 120 BPM)
              const bpm = rawTempo <= 10 ? rawTempo * 60 : rawTempo;
              tempos.push({ tick: cursorTick, bpm });
            }
            continue;
          }

          if (tag === "Dynamic") {
            const velText = el.textOf("velocity");
            const subtype = el.textOf("subtype")?.toLowerCase() ?? "";
            const parsedVel = velText ? Number.parseInt(velText, 10) : NaN;
            if (
              Number.isFinite(parsedVel) &&
              parsedVel >= 1 &&
              parsedVel <= 127
            ) {
              currentVelocity = parsedVel;
            } else if (MSCX_DYNAMIC_VELOCITY[subtype] !== undefined) {
              currentVelocity = MSCX_DYNAMIC_VELOCITY[subtype]!;
            }
            continue;
          }

          if (tag === "Spanner") {
            const spannerType = el.getAttribute("type")?.toLowerCase();
            if (spannerType === "pedal") {
              const isEnd = el.child("prev") !== undefined;
              pedals.push({
                tick: cursorTick,
                controller: 64,
                value: isEnd ? 0 : 127,
              });
              const nextLoc = el.child("next")?.child("location");
              if (!isEnd && nextLoc) {
                const mOffset = Number.parseInt(
                  nextLoc.textOf("measures") ?? "0",
                  10,
                );
                const fracQuarters =
                  parseFractionToQuarters(nextLoc.textOf("fractions")) ?? 0;
                const stopTick =
                  cursorTick +
                  (Number.isFinite(mOffset) ? mOffset * nominalTicks : 0) +
                  Math.round(fracQuarters * ppq);
                if (stopTick > cursorTick) {
                  pedals.push({
                    tick: stopTick,
                    controller: 64,
                    value: 0,
                  });
                }
              }
            }
            continue;
          }

          if (tag === "location" || tag === "move") {
            const fracQuarters = parseFractionToQuarters(
              el.textOf("fractions") ?? el.text,
            );
            if (fracQuarters !== null) {
              cursorTick = Math.max(
                measureStartTick,
                cursorTick + Math.round(fracQuarters * ppq),
              );
            }
            continue;
          }

          if (tag === "Tuplet") {
            const normal = Number.parseFloat(el.textOf("normalNotes") ?? "");
            const actual = Number.parseFloat(el.textOf("actualNotes") ?? "");
            if (
              Number.isFinite(normal) &&
              normal > 0 &&
              Number.isFinite(actual) &&
              actual > 0
            ) {
              activeTupletRatio = normal / actual;
              activeTupletRemainingChords = Math.round(actual);
            }
            continue;
          }

          if (tag === "endTuplet") {
            activeTupletRatio = 1.0;
            activeTupletRemainingChords = 0;
            continue;
          }

          if (tag === "Rest" || tag === "Chord") {
            const isGrace = el.children.some((c) => GRACE_TAGS.has(c.localName));
            const durationType = el.textOf("durationType") ?? "quarter";
            const dots = Number.parseInt(el.textOf("dots") ?? "0", 10);
            const explicitFraction = parseFractionToQuarters(
              el.textOf("duration"),
            );

            let baseQuarters: number;
            if (durationType === "measure") {
              baseQuarters =
                explicitFraction ?? nominalTicks / ppq;
            } else {
              baseQuarters =
                MSCX_DURATION_QUARTERS[durationType] ??
                explicitFraction ??
                1;
              if (Number.isFinite(dots) && dots > 0) {
                let dotFactor = 1;
                let add = 0.5;
                for (let d = 0; d < dots; d++) {
                  dotFactor += add;
                  add *= 0.5;
                }
                baseQuarters *= dotFactor;
              }
            }

            // Apply Tuplet ratio if referenced or active
            let tupletRatio = activeTupletRatio;
            const tupletRef = el.textOf("Tuplet");
            if (tupletRef && tupletRatiosById.has(tupletRef)) {
              tupletRatio = tupletRatiosById.get(tupletRef)!;
            }
            const inlineTuplet = el.child("Tuplet");
            if (inlineTuplet) {
              const normal = Number.parseFloat(
                inlineTuplet.textOf("normalNotes") ?? "",
              );
              const actual = Number.parseFloat(
                inlineTuplet.textOf("actualNotes") ?? "",
              );
              if (
                Number.isFinite(normal) &&
                normal > 0 &&
                Number.isFinite(actual) &&
                actual > 0
              ) {
                tupletRatio = normal / actual;
              }
            }

            const durTicks = isGrace
              ? Math.max(12, Math.round(ppq / 8))
              : Math.max(1, Math.round(baseQuarters * tupletRatio * ppq));

            const onsetTick = cursorTick;
            if (!isGrace) {
              cursorTick += durTicks;
              if (cursorTick > maxMeasureEndTick) {
                maxMeasureEndTick = cursorTick;
              }
              if (activeTupletRemainingChords > 0) {
                activeTupletRemainingChords--;
                if (activeTupletRemainingChords === 0) {
                  activeTupletRatio = 1.0;
                }
              }
            }

            if (tag === "Rest") continue;

            // Articulations on <Chord>
            let gateRatio = 1.0;
            let chordVelBoost = 0;
            for (const artic of el.childrenNamed("Articulation")) {
              const sub = (artic.textOf("subtype") ?? "").toLowerCase();
              if (sub.includes("staccatissimo")) {
                gateRatio = 0.35;
              } else if (sub.includes("staccato")) {
                gateRatio = 0.5;
              } else if (sub.includes("portato") || sub.includes("mezzo")) {
                gateRatio = 0.75;
              }
              if (sub.includes("marcato") || sub.includes("sforzato")) {
                chordVelBoost = Math.max(chordVelBoost, 20);
              } else if (sub.includes("accent")) {
                chordVelBoost = Math.max(chordVelBoost, 12);
              }
            }

            for (const noteNode of el.childrenNamed("Note")) {
              const pitchVal = Number.parseInt(
                noteNode.textOf("pitch") ?? "",
                10,
              );
              if (!Number.isFinite(pitchVal) || pitchVal < 0 || pitchVal > 127) {
                continue;
              }

              // Check ties (MuseScore 3 <Tie/> & <endSpanner/>, and MuseScore 4 <Spanner type="Tie">)
              let tieStart = noteNode.child("Tie") !== undefined;
              let tieStop = noteNode.child("endSpanner") !== undefined;

              for (const sp of noteNode.childrenNamed("Spanner")) {
                if (sp.getAttribute("type")?.toLowerCase() === "tie") {
                  if (sp.child("next") !== undefined) tieStart = true;
                  if (sp.child("prev") !== undefined) tieStop = true;
                }
              }

              const tieKey = `${voiceIdx}:${pitchVal}`;
              if (tieStop && openTies.has(tieKey)) {
                const prevNote = openTies.get(tieKey)!;
                const newEndTick = onsetTick + durTicks;
                prevNote.durationTicks = Math.max(
                  prevNote.durationTicks + durTicks,
                  newEndTick - prevNote.startTick,
                );
                if (!tieStart) {
                  openTies.delete(tieKey);
                }
                continue;
              }

              const fingerText =
                noteNode.child("Fingering")?.textOf("text") ?? null;
              const finger = parseFingerNumber(fingerText);
              const noteVelOffset = Number.parseInt(
                noteNode.textOf("veloOffset") ?? "0",
                10,
              );
              const finalVelocity = Math.max(
                1,
                Math.min(
                  127,
                  currentVelocity +
                    chordVelBoost +
                    (Number.isFinite(noteVelOffset) ? noteVelOffset : 0),
                ),
              );

              const effectiveDur = tieStart
                ? durTicks
                : Math.max(1, Math.round(durTicks * gateRatio));

              const noteObj: CanonicalScoreNote = {
                pitch: pitchVal,
                startTick: onsetTick,
                durationTicks: effectiveDur,
                velocity: finalVelocity,
                hand,
                finger,
              };

              if (hand === "right") {
                rightHandNotes.push(noteObj);
              } else if (hand === "left") {
                leftHandNotes.push(noteObj);
              } else {
                if (!unassignedStaffNotes.has(staffId)) {
                  unassignedStaffNotes.set(staffId, []);
                }
                unassignedStaffNotes.get(staffId)!.push(noteObj);
              }

              if (tieStart) {
                openTies.set(tieKey, noteObj);
              }
            }
          }
        }
      });

      measureStartTick = maxMeasureEndTick;
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
  for (const [staffId, notes] of unassignedStaffNotes.entries()) {
    if (notes.length === 0) continue;
    const meta = staffMetaMap.get(staffId);
    tracks.push({
      name: meta?.partName || `Staff ${staffId}`,
      program: 0,
      notes,
    });
  }

  if (tracks.length === 0 || tracks.every((t) => t.notes.length === 0)) {
    throw new Error("MuseScore file (.mscz) contains no playable notes.");
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
 * Converts a `.mscz` (or `.mscx`) buffer into canonical Standard MIDI File bytes.
 */
export function convertMsczBytesToMidi(
  input: ArrayBuffer | Uint8Array,
): { midiBytes: ArrayBuffer; score: CanonicalScore } {
  const xmlText = extractMscxXmlText(input);
  const score = parseMscxToCanonicalScore(xmlText);
  const midiUint8 = writeCanonicalMidiFile(score);
  const copy = new Uint8Array(midiUint8.byteLength);
  copy.set(midiUint8);
  return {
    midiBytes: copy.buffer,
    score,
  };
}
