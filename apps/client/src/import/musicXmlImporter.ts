import { isZipBytes } from "./scoreFormat";
import { midiLoader } from "@handthesia/engine-ts";
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

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const DYNAMICS_TO_VELOCITY: Record<string, number> = {
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
  sf: 112,
  sfz: 116,
  sffz: 122,
  fp: 96,
  rfz: 110,
};

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
};

interface PartMeta {
  id: string;
  name: string;
  program: number;
  isPercussion: boolean;
  handHint?: CanonicalHandHint;
}

function inferHandFromText(text: string): CanonicalHandHint | undefined {
  const lower = text.toLowerCase();
  if (
    lower.includes("right hand") ||
    lower === "rh" ||
    lower.includes("treble") ||
    lower.includes("mano destra") ||
    lower.includes("main droite") ||
    lower.includes("rechte hand")
  ) {
    return "right";
  }
  if (
    lower.includes("left hand") ||
    lower === "lh" ||
    lower.includes("bass") ||
    lower.includes("mano sinistra") ||
    lower.includes("main gauche") ||
    lower.includes("linke hand")
  ) {
    return "left";
  }
  return undefined;
}

/**
 * Extracts raw MusicXML text from either uncompressed XML bytes or a compressed `.mxl` / `.mlx` ZIP buffer.
 */
export function extractMusicXmlText(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isZipBytes(bytes)) {
    return decodeXmlBytes(bytes);
  }

  const entries = unzipArchiveEntries(bytes);
  const entryNames = Object.keys(entries);

  // 1. Check META-INF/container.xml for rootfile full-path
  const containerKey = entryNames.find(
    (k) => k.replace(/\\/g, "/").toLowerCase() === "meta-inf/container.xml",
  );
  if (containerKey && entries[containerKey]) {
    try {
      const containerXml = decodeXmlBytes(entries[containerKey]!);
      const containerRoot = parseXmlDocument(containerXml);
      const rootfile = containerRoot.findFirst("rootfile");
      const fullPath = rootfile?.getAttribute("full-path")?.replace(/\\/g, "/");
      if (fullPath) {
        const matchedKey = entryNames.find(
          (k) =>
            k.replace(/\\/g, "/") === fullPath ||
            k.replace(/\\/g, "/").toLowerCase() === fullPath.toLowerCase(),
        );
        if (matchedKey && entries[matchedKey]) {
          return decodeXmlBytes(entries[matchedKey]!);
        }
      }
    } catch {
      // Fall through to heuristic search
    }
  }

  // 2. Fallback: find first .musicxml or .xml outside META-INF/
  const candidateKey = entryNames.find((k) => {
    const norm = k.replace(/\\/g, "/").toLowerCase();
    if (norm.startsWith("meta-inf/") || norm.startsWith("__macosx/")) {
      return false;
    }
    return norm.endsWith(".musicxml") || norm.endsWith(".xml");
  });

  if (!candidateKey || !entries[candidateKey]) {
    throw new Error(
      "Compressed MusicXML archive (.mxl/.mlx) does not contain a valid .musicxml or .xml score entry.",
    );
  }

  return decodeXmlBytes(entries[candidateKey]!);
}

/**
 * Expands repeat barlines (`forward` / `backward`) and alternate endings (`<ending>`)
 * into an ordered sequence of measure indices.
 */
function expandRepeatMeasureIndices(measures: XmlNode[]): number[] {
  if (measures.length === 0) return [];

  interface MeasureRepeatInfo {
    forwardRepeat: boolean;
    backwardRepeatCount: number;
    endingNumbers: Set<number> | null;
    endingStopOrDiscontinue: boolean;
  }

  const infos: MeasureRepeatInfo[] = measures.map((m) => {
    let forwardRepeat = false;
    let backwardRepeatCount = 0;
    let endingNumbers: Set<number> | null = null;
    let endingStopOrDiscontinue = false;

    for (const barline of m.childrenNamed("barline")) {
      const repeat = barline.child("repeat");
      if (repeat) {
        const dir = repeat.getAttribute("direction")?.toLowerCase();
        if (dir === "forward") {
          forwardRepeat = true;
        } else if (dir === "backward") {
          const timesAttr = Number.parseInt(
            repeat.getAttribute("times") ?? "2",
            10,
          );
          backwardRepeatCount =
            Number.isFinite(timesAttr) && timesAttr >= 2 ? timesAttr : 2;
        }
      }
      const ending = barline.child("ending");
      if (ending) {
        const typeAttr = ending.getAttribute("type")?.toLowerCase();
        const numAttr = ending.getAttribute("number") ?? "";
        const nums = numAttr
          .split(/[,\s]+/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1);
        if (typeAttr === "start" && nums.length > 0) {
          endingNumbers = new Set(nums);
        }
        if (typeAttr === "stop" || typeAttr === "discontinue") {
          endingStopOrDiscontinue = true;
        }
      }
    }

    return {
      forwardRepeat,
      backwardRepeatCount,
      endingNumbers,
      endingStopOrDiscontinue,
    };
  });

  const sequence: number[] = [];
  const maxSteps = Math.max(measures.length * 6, 512);
  let idx = 0;
  let repeatStartIdx = 0;
  let currentPass = 1;
  let activeEndingNumbers: Set<number> | null = null;
  const backwardVisits = new Map<number, number>();

  while (idx < measures.length && sequence.length < maxSteps) {
    const info = infos[idx]!;

    if (info.forwardRepeat) {
      if (repeatStartIdx !== idx) {
        repeatStartIdx = idx;
        currentPass = 1;
        activeEndingNumbers = null;
      }
    }

    if (info.endingNumbers !== null) {
      activeEndingNumbers = info.endingNumbers;
    }

    // If we are inside a numbered ending bracket that doesn't match `currentPass`, skip this measure
    if (activeEndingNumbers !== null && !activeEndingNumbers.has(currentPass)) {
      if (info.endingStopOrDiscontinue) {
        activeEndingNumbers = null;
      }
      idx++;
      continue;
    }

    sequence.push(idx);

    if (info.backwardRepeatCount > 0) {
      const visits = (backwardVisits.get(idx) ?? 0) + 1;
      backwardVisits.set(idx, visits);
      if (visits < info.backwardRepeatCount) {
        currentPass = visits + 1;
        activeEndingNumbers = null;
        idx = repeatStartIdx;
        continue;
      } else {
        // Completed repeat loop
        currentPass = 1;
        activeEndingNumbers = null;
      }
    } else if (info.endingStopOrDiscontinue) {
      activeEndingNumbers = null;
    }

    idx++;
  }

  return sequence.length > 0 ? sequence : measures.map((_, i) => i);
}

function parseFingerNumber(text: string | null): 1 | 2 | 3 | 4 | 5 | undefined {
  if (!text) return undefined;
  const match = /[1-5]/.exec(text.trim());
  if (!match) return undefined;
  const num = Number.parseInt(match[0], 10);
  return num >= 1 && num <= 5 ? (num as 1 | 2 | 3 | 4 | 5) : undefined;
}

/**
 * Parses a MusicXML string into a CanonicalScore structure ready for SMF encoding.
 */
export function parseMusicXmlToCanonicalScore(xmlText: string): CanonicalScore {
  const root = parseXmlDocument(xmlText);
  const ppq = DEFAULT_SCORE_PPQ;

  if (
    root.localName !== "score-partwise" &&
    root.localName !== "score-timewise"
  ) {
    throw new Error(
      `Unsupported XML root element <${root.tagName}>. Expected MusicXML <score-partwise> or <score-timewise>.`,
    );
  }

  // Extract title
  const workTitle = root.findFirst("work")?.textOf("work-title");
  const movementTitle = root.textOf("movement-title");
  const creditWords = root
    .childrenNamed("credit")
    .find((c) => c.textOf("credit-type") === "title")
    ?.textOf("credit-words");
  const title =
    (workTitle || movementTitle || creditWords || "").trim() || undefined;

  // Parse <part-list> metadata
  const partMetaMap = new Map<string, PartMeta>();
  const partList = root.child("part-list");
  if (partList) {
    for (const scorePart of partList.childrenNamed("score-part")) {
      const id = scorePart.getAttribute("id") ?? "";
      const name =
        scorePart.textOf("part-name") ||
        scorePart.textOf("instrument-name") ||
        id ||
        "Piano";
      const midiInstrument = scorePart.findFirst("midi-instrument");
      const rawChannel = Number.parseInt(
        midiInstrument?.textOf("midi-channel") ?? "1",
        10,
      );
      const rawProgram = Number.parseInt(
        midiInstrument?.textOf("midi-program") ?? "1",
        10,
      );
      const unpitched = scorePart.findFirst("midi-unpitched") !== undefined;
      const isPercussion =
        rawChannel === 10 ||
        unpitched ||
        /\b(drum|percussion|timpani|cymbal|snare)\b/i.test(name);
      const program =
        Number.isFinite(rawProgram) && rawProgram >= 1 && rawProgram <= 128
          ? rawProgram - 1
          : 0;
      partMetaMap.set(id, {
        id,
        name,
        program,
        isPercussion,
        handHint: inferHandFromText(name),
      });
    }
  }

  // Normalize partwise vs timewise into map of partId -> Measure XmlNode[]
  const partMeasures = new Map<string, XmlNode[]>();
  const partOrder: string[] = [];

  if (root.localName === "score-partwise") {
    for (const part of root.childrenNamed("part")) {
      const id = part.getAttribute("id") ?? `part_${partOrder.length + 1}`;
      partOrder.push(id);
      partMeasures.set(id, part.childrenNamed("measure"));
    }
  } else {
    // score-timewise: <measure><part id="...">...</part></measure>
    const timewiseMeasures = root.childrenNamed("measure");
    for (const twMeasure of timewiseMeasures) {
      for (const part of twMeasure.childrenNamed("part")) {
        const id = part.getAttribute("id") ?? "P1";
        if (!partMeasures.has(id)) {
          partOrder.push(id);
          partMeasures.set(id, []);
        }
        partMeasures.get(id)!.push(part);
      }
    }
  }

  if (partOrder.length === 0) {
    throw new Error("MusicXML document contains no <part> elements.");
  }

  // Filter out percussion parts if non-percussion parts exist
  const nonPercussionParts = partOrder.filter(
    (id) => !partMetaMap.get(id)?.isPercussion,
  );
  const selectedPartIds =
    nonPercussionParts.length > 0 ? nonPercussionParts : partOrder;

  const primaryMeasures = partMeasures.get(selectedPartIds[0]!) ?? [];
  const measureSequence = expandRepeatMeasureIndices(primaryMeasures);

  const tempos: CanonicalTempoEvent[] = [];
  const timeSignatures: CanonicalTimeSignatureEvent[] = [];
  const keySignatures: CanonicalKeySignatureEvent[] = [];
  const pedals: CanonicalPedalEvent[] = [];

  const rightHandNotes: CanonicalScoreNote[] = [];
  const leftHandNotes: CanonicalScoreNote[] = [];
  const unassignedPartTracks = new Map<string, CanonicalScoreNote[]>();

  selectedPartIds.forEach((partId, partIdx) => {
    const measures = partMeasures.get(partId) ?? [];
    const meta = partMetaMap.get(partId) ?? {
      id: partId,
      name: `Part ${partIdx + 1}`,
      program: 0,
      isPercussion: false,
    };
    const isPianoPart = midiLoader.is_piano_track(meta);

    let divisions = 1;
    let stavesCount = 1;
    let timeBeats = 4;
    let timeBeatType = 4;
    let transposeSemitones = 0;
    let currentVelocity = 80;
    let measureStartTick = 0;

    // Open ties keyed by `${staff}:${voice}:${pitch}`
    const openTies = new Map<string, CanonicalScoreNote>();

    const toTicks = (xmlDur: number): number =>
      Math.max(1, Math.round((xmlDur * ppq) / Math.max(1, divisions)));

    for (let seqIdx = 0; seqIdx < measureSequence.length; seqIdx++) {
      const mIdx = measureSequence[seqIdx]!;
      const measure = measures[mIdx];
      if (!measure) continue;

      let cursorTick = measureStartTick;
      let maxTickInMeasure = measureStartTick;
      const lastNoteOnsetByVoiceStaff = new Map<string, number>();

      for (const child of measure.children) {
        const tag = child.localName;

        if (tag === "attributes") {
          const divText = child.textOf("divisions");
          if (divText) {
            const parsedDiv = Number.parseFloat(divText);
            if (Number.isFinite(parsedDiv) && parsedDiv > 0) {
              divisions = parsedDiv;
            }
          }

          const stavesText = child.textOf("staves");
          if (stavesText) {
            const parsedStaves = Number.parseInt(stavesText, 10);
            if (Number.isFinite(parsedStaves) && parsedStaves >= 1) {
              stavesCount = parsedStaves;
            }
          }

          const timeNode = child.child("time");
          if (timeNode) {
            const beats = Number.parseInt(timeNode.textOf("beats") ?? "", 10);
            const beatType = Number.parseInt(
              timeNode.textOf("beat-type") ?? "",
              10,
            );
            if (
              Number.isFinite(beats) &&
              beats >= 1 &&
              Number.isFinite(beatType) &&
              beatType >= 1
            ) {
              timeBeats = beats;
              timeBeatType = beatType;
              if (partIdx === 0) {
                timeSignatures.push({
                  tick: measureStartTick,
                  numerator: beats,
                  denominator: beatType,
                });
              }
            }
          }

          const keyNode = child.child("key");
          if (keyNode && partIdx === 0) {
            const fifths = Number.parseInt(keyNode.textOf("fifths") ?? "0", 10);
            const modeText = keyNode.textOf("mode")?.toLowerCase();
            if (Number.isFinite(fifths)) {
              keySignatures.push({
                tick: measureStartTick,
                fifths,
                mode: modeText === "minor" ? "minor" : "major",
              });
            }
          }

          const transposeNode = child.child("transpose");
          if (transposeNode) {
            const chrom = Number.parseInt(
              transposeNode.textOf("chromatic") ?? "0",
              10,
            );
            const oct = Number.parseInt(
              transposeNode.textOf("octave-change") ?? "0",
              10,
            );
            transposeSemitones =
              (Number.isFinite(chrom) ? chrom : 0) +
              (Number.isFinite(oct) ? oct * 12 : 0);
          }
          continue;
        }

        if (tag === "backup") {
          const dur = Number.parseFloat(child.textOf("duration") ?? "0");
          if (Number.isFinite(dur) && dur > 0) {
            cursorTick = Math.max(measureStartTick, cursorTick - toTicks(dur));
          }
          continue;
        }

        if (tag === "forward") {
          const dur = Number.parseFloat(child.textOf("duration") ?? "0");
          if (Number.isFinite(dur) && dur > 0) {
            cursorTick += toTicks(dur);
            if (cursorTick > maxTickInMeasure) maxTickInMeasure = cursorTick;
          }
          continue;
        }

        if (tag === "sound" || tag === "direction") {
          const soundNode =
            tag === "sound" ? child : child.findFirst("sound");
          if (soundNode) {
            const tempoAttr = Number.parseFloat(
              soundNode.getAttribute("tempo") ?? "",
            );
            if (Number.isFinite(tempoAttr) && tempoAttr > 0 && partIdx === 0) {
              tempos.push({ tick: cursorTick, bpm: tempoAttr });
            }
            const dynAttr = Number.parseFloat(
              soundNode.getAttribute("dynamics") ?? "",
            );
            if (Number.isFinite(dynAttr) && dynAttr > 0) {
              // MusicXML sound@dynamics is percentage of standard 90 MIDI velocity
              currentVelocity = Math.max(
                1,
                Math.min(127, Math.round((dynAttr / 100) * 90)),
              );
            }
          }

          if (tag === "direction") {
            const metronome = child.findFirst("metronome");
            if (metronome && partIdx === 0) {
              const beatUnit =
                metronome.textOf("beat-unit")?.toLowerCase() ?? "quarter";
              const perMinute = Number.parseFloat(
                metronome.textOf("per-minute") ?? "",
              );
              const hasDot = metronome.child("beat-unit-dot") !== undefined;
              if (Number.isFinite(perMinute) && perMinute > 0) {
                const unitFactor =
                  (BEAT_UNIT_QUARTERS[beatUnit] ?? 1) * (hasDot ? 1.5 : 1);
                tempos.push({
                  tick: cursorTick,
                  bpm: perMinute * unitFactor,
                });
              }
            }

            const dynamicsNode = child.findFirst("dynamics");
            if (dynamicsNode && dynamicsNode.children.length > 0) {
              const dynTag = dynamicsNode.children[0]!.localName.toLowerCase();
              const mappedVel = DYNAMICS_TO_VELOCITY[dynTag];
              if (mappedVel !== undefined) {
                currentVelocity = mappedVel;
              }
            }

            const pedalNode = child.findFirst("pedal");
            if (pedalNode) {
              const pedalType = pedalNode.getAttribute("type")?.toLowerCase();
              if (pedalType === "start" || pedalType === "sostenuto") {
                pedals.push({ tick: cursorTick, controller: 64, value: 127 });
              } else if (pedalType === "change") {
                pedals.push({
                  tick: Math.max(0, cursorTick - 1),
                  controller: 64,
                  value: 0,
                });
                pedals.push({ tick: cursorTick, controller: 64, value: 127 });
              } else if (pedalType === "stop" || pedalType === "discontinue") {
                pedals.push({ tick: cursorTick, controller: 64, value: 0 });
              }
            }
          }
          continue;
        }

        if (tag === "note") {
          const isGrace = child.child("grace") !== undefined;
          const isChord = child.child("chord") !== undefined;
          const isRest = child.child("rest") !== undefined;
          const voice = child.textOf("voice") ?? "1";
          const staffNum = Number.parseInt(child.textOf("staff") ?? "1", 10);
          const staff = Number.isFinite(staffNum) && staffNum >= 1 ? staffNum : 1;
          if (staff > stavesCount) {
            stavesCount = staff;
          }

          const rawDur = Number.parseFloat(child.textOf("duration") ?? "0");
          const durTicks = isGrace
            ? Math.max(12, Math.round(ppq / 8))
            : rawDur > 0
              ? toTicks(rawDur)
              : Math.round(ppq / 2);

          const voiceStaffKey = `${staff}:${voice}`;
          const onsetTick = isChord
            ? (lastNoteOnsetByVoiceStaff.get(voiceStaffKey) ?? cursorTick)
            : cursorTick;

          if (!isChord && !isGrace) {
            lastNoteOnsetByVoiceStaff.set(voiceStaffKey, onsetTick);
            cursorTick += durTicks;
            if (cursorTick > maxTickInMeasure) maxTickInMeasure = cursorTick;
          }

          if (isRest) continue;

          const pitchNode = child.child("pitch");
          if (!pitchNode) continue;

          const step = (pitchNode.textOf("step") ?? "C").toUpperCase();
          const alter = Number.parseFloat(pitchNode.textOf("alter") ?? "0");
          const octave = Number.parseInt(pitchNode.textOf("octave") ?? "4", 10);
          const semitone = STEP_TO_SEMITONE[step];
          if (semitone === undefined || !Number.isFinite(octave)) continue;

          const midiPitch = Math.max(
            0,
            Math.min(
              127,
              Math.round(
                (octave + 1) * 12 +
                  semitone +
                  (Number.isFinite(alter) ? alter : 0) +
                  transposeSemitones,
              ),
            ),
          );

          // Check ties (<tie type="start|stop"/> and <notations><tied type="start|stop"/></notations>)
          let tieStart = false;
          let tieStop = false;
          for (const tie of child.childrenNamed("tie")) {
            const t = tie.getAttribute("type")?.toLowerCase();
            if (t === "start") tieStart = true;
            if (t === "stop") tieStop = true;
          }
          const notations = child.child("notations");
          if (notations) {
            for (const tied of notations.childrenNamed("tied")) {
              const t = tied.getAttribute("type")?.toLowerCase();
              if (t === "start") tieStart = true;
              if (t === "stop") tieStop = true;
            }
          }

          const tieKey = `${staff}:${voice}:${midiPitch}`;
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

          // Articulations & velocity
          let noteVelocity = currentVelocity;
          let gateRatio = 1.0;
          const articulations = notations?.child("articulations");
          if (articulations) {
            if (articulations.child("staccatissimo")) {
              gateRatio = 0.35;
            } else if (articulations.child("staccato")) {
              gateRatio = 0.5;
            } else if (
              articulations.child("detached-legato") ||
              articulations.child("portato")
            ) {
              gateRatio = 0.75;
            }
            if (articulations.child("strong-accent")) {
              noteVelocity = Math.min(127, noteVelocity + 22);
            } else if (articulations.child("accent")) {
              noteVelocity = Math.min(127, noteVelocity + 14);
            }
          }

          const effectiveDurTicks = tieStart
            ? durTicks
            : Math.max(1, Math.round(durTicks * gateRatio));

          // Fingering (<notations><technical><fingering>)
          const fingeringText =
            notations?.child("technical")?.textOf("fingering") ?? null;
          const finger = parseFingerNumber(fingeringText);
          const glissando =
            notations?.child("glissando") !== undefined ||
            notations?.child("slide") !== undefined;

          // Hand assignment: explicit multi-staff grand staff (staff 1 = right, staff 2 = left) or part hand hint
          const hand: CanonicalHandHint | undefined = !isPianoPart
            ? undefined
            : stavesCount >= 2
              ? staff === 1
                ? "right"
                : "left"
              : meta.handHint;

          const noteObj: CanonicalScoreNote = {
            pitch: midiPitch,
            startTick: onsetTick,
            durationTicks: effectiveDurTicks,
            velocity: noteVelocity,
            hand,
            finger,
            glissando: glissando || undefined,
          };

          if (hand === "right") {
            rightHandNotes.push(noteObj);
          } else if (hand === "left") {
            leftHandNotes.push(noteObj);
          } else {
            if (!unassignedPartTracks.has(partId)) {
              unassignedPartTracks.set(partId, []);
            }
            unassignedPartTracks.get(partId)!.push(noteObj);
          }

          if (tieStart) {
            openTies.set(tieKey, noteObj);
          }
        }
      }

      const nominalMeasureTicks = Math.max(
        1,
        Math.round((timeBeats * 4 * ppq) / Math.max(1, timeBeatType)),
      );
      measureStartTick = Math.max(
        maxTickInMeasure,
        measureStartTick + nominalMeasureTicks,
      );
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

  const hasDedicatedPianoPart = selectedPartIds.some((partId) => {
    const meta = partMetaMap.get(partId);
    return meta ? midiLoader.is_piano_track(meta) : false;
  });
  let nextAccompanimentChannel = 2;

  for (const [partId, notes] of unassignedPartTracks.entries()) {
    if (notes.length === 0) continue;
    const meta = partMetaMap.get(partId);
    const name = (meta?.name || (hasDedicatedPianoPart ? `Accompaniment (${partId})` : "Piano")).trim();

    if (nextAccompanimentChannel === 9) {
      nextAccompanimentChannel = 10;
    }
    const channel = Math.min(15, nextAccompanimentChannel++);

    tracks.push({
      name,
      program: meta?.program ?? 0,
      channel,
      notes,
    });
  }

  if (tracks.length === 0 || tracks.every((t) => t.notes.length === 0)) {
    throw new Error("MusicXML file contains no playable notes.");
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
 * Converts a `.musicxml`, `.xml`, `.mxl`, or `.mlx` buffer into canonical Standard MIDI File bytes.
 */
export function convertMusicXmlBytesToMidi(
  input: ArrayBuffer | Uint8Array,
): { midiBytes: ArrayBuffer; score: CanonicalScore } {
  const xmlText = extractMusicXmlText(input);
  const score = parseMusicXmlToCanonicalScore(xmlText);
  const midiUint8 = writeCanonicalMidiFile(score);
  const copy = new Uint8Array(midiUint8.byteLength);
  copy.set(midiUint8);
  return {
    midiBytes: copy.buffer,
    score,
  };
}
