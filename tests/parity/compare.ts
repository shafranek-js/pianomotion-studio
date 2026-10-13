import type { M1AnalyzeMidiResult } from "@handthesia/contracts";

type HandTag = "L" | "R";
type Vec3 = [number, number, number];
type SourceNote = {
  noteId: string;
  sourceInstrument: number;
  sourceOrdinal: number;
  pitch: number;
  velocity: number;
  start: number;
  end: number;
  sourceEvent?: EventPair;
};
type EventPair = {
  midiTrackIndex: number;
  channel: number;
  noteOnOrdinal: number;
  noteOffOrdinal: number;
};
type NoteRow = {
  noteId: string | null;
  sourceNoteIds: string[];
  pitch: number;
  velocity: number;
  start: number;
  end: number;
  hand: HandTag | "left" | "right";
  manualFinger?: number | null;
  gliss?: boolean;
  finger?: number | null;
  glissando?: boolean;
  startSeconds?: number;
  endSeconds?: number;
  track?: number;
};
type GoldenPose = {
  hand: HandTag;
  time: number;
  layer: number;
  coordinateFrame: { keyboardRect: [number, number, number, number]; pixelsPerInch: number };
  armEnd: Vec3;
  bones: { start: Vec3; end: Vec3; type: string }[];
  joints: { position: Vec3; type: string }[];
  fingerTips: Record<string, Vec3>;
  fingerChains: Record<string, Vec3[]>;
  wristJoints: Vec3[];
  wristPose: { positionPx: [number, number]; headingRadians: number };
};
export type GoldenFixture = {
  fixtureId: string;
  inputSha256: string;
  status: "loaded" | "repaired" | "invalid-or-rejected";
  sourceNotes: SourceNote[];
  desktopNotes?: NoteRow[];
  assignments?: { sourceNoteIds: string[]; hand: HandTag; finger: number | null; manualFinger: number | null; gliss: boolean }[];
  performanceEvents?: { sourceNoteIds: string[]; hand: HandTag; press: number; release: number }[];
  rawPedals?: { time: number; controller: number; value: number }[];
  pedals?: { time: number; controller: number; value: number }[];
  sourcePedals?: { track: number; tick: number; time: number; controller: number; value: number }[];
  selectedPoses?: GoldenPose[];
  tracks?: { index: number; name: string; program: number; noteCount: number; declaredHand: HandTag | null }[];
};

export type ParityDifference = {
  fixtureId: string;
  category: string;
  path: string;
  expected: unknown;
  actual: unknown;
  delta?: number;
  tolerance?: number;
};

export type FixtureParity = {
  fixtureId: string;
  expectedStatus: string;
  actualStatus: string;
  expectedCounts: Record<string, number>;
  actualCounts: Record<string, number>;
  checkedPosePairs: number;
  numericTolerance: { timeSeconds: number; rawCoordinatesInWhiteKeys: number; physicalCoordinatesInWhiteKeys: number };
  differences: ParityDifference[];
};

const TIME_TOLERANCE_SECONDS = 0.001;
const RAW_COORDINATE_TOLERANCE_WHITE_KEYS = 0.01;
const PHYSICAL_COORDINATE_TOLERANCE_WHITE_KEYS = 0.01;
const WHITE_KEY_INCHES = 6.5 / 7;
const WHITE_KEYS_ON_88_KEYBOARD = 52;
const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const rows = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const number = (value: unknown): number => Number(value);
const str = (value: unknown): string => String(value);

function handName(hand: HandTag): "left" | "right" {
  return hand === "L" ? "left" : "right";
}

/** Compare one real Worker result to the immutable M0 observation by decoded source identity. */
export function compareM1ResultToGolden(
  resultValue: M1AnalyzeMidiResult,
  golden: GoldenFixture,
): FixtureParity {
  const result = record(resultValue);
  const raw = record(result.rawBaseline);
  const document = result.document === null ? null : record(result.document);
  const differences: ParityDifference[] = [];
  let checkedPosePairs = 0;
  const fixtureId = golden.fixtureId;
  const add = (category: string, path: string, expected: unknown, actual: unknown) => {
    if (expected !== actual) differences.push({ fixtureId, category, path, expected, actual });
  };
  const near = (category: string, path: string, expected: number, actual: number, tolerance: number) => {
    const delta = Math.abs(expected - actual);
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || delta > tolerance) {
      differences.push({ fixtureId, category, path, expected, actual, delta, tolerance });
    }
  };
  const status = golden.status === "invalid-or-rejected" ? "invalid" : golden.status;
  add("status", "status", status, result.status);
  add("source", "rawBaseline.fixtureId", fixtureId, raw.fixtureId);
  add("source", "rawBaseline.inputSha256", golden.inputSha256, raw.inputSha256);
  add("identity", "rawBaseline.identityMappings.length", golden.sourceNotes.length, rows(raw.identityMappings).length);

  const goldenByOrigin = new Map(golden.sourceNotes.map((item) => [`${item.sourceInstrument}:${item.sourceOrdinal}`, item.noteId]));
  const actualSourceRows = rows<SourceNote>(raw.sourceNotes);
  const actualSourceIdToGolden = new Map<string, string>();
  const actualOriginSet = new Set<string>();
  for (const source of actualSourceRows) {
    const origin = `${source.sourceInstrument}:${source.sourceOrdinal}`;
    const baselineId = goldenByOrigin.get(origin);
    if (!baselineId) {
      differences.push({ fixtureId, category: "identity", path: `sourceNotes[${origin}]`, expected: "known decoded source identity", actual: source.noteId });
      continue;
    }
    if (actualOriginSet.has(origin)) {
      differences.push({ fixtureId, category: "identity", path: `sourceNotes[${origin}]`, expected: "unique instrument/ordinal", actual: "duplicate origin" });
    }
    actualOriginSet.add(origin);
    actualSourceIdToGolden.set(source.noteId, baselineId);
    const expected = golden.sourceNotes.find((item) => item.noteId === baselineId)!;
    add("source", `sourceNotes[${origin}].pitch`, expected.pitch, source.pitch);
    add("source", `sourceNotes[${origin}].velocity`, expected.velocity, source.velocity);
    near("source", `sourceNotes[${origin}].start`, expected.start, source.start, TIME_TOLERANCE_SECONDS);
    near("source", `sourceNotes[${origin}].end`, expected.end, source.end, TIME_TOLERANCE_SECONDS);
  }
  for (const expected of golden.sourceNotes) {
    if (!actualOriginSet.has(`${expected.sourceInstrument}:${expected.sourceOrdinal}`)) {
      differences.push({ fixtureId, category: "identity", path: `sourceNotes[${expected.sourceInstrument}:${expected.sourceOrdinal}]`, expected: expected.noteId, actual: "missing" });
    }
  }

  const mappingRows = rows<Record<string, unknown>>(raw.identityMappings);
  const sourceById = new Map(actualSourceRows.map((source) => [source.noteId, source]));
  for (const [index, mapping] of mappingRows.entries()) {
    const sourceId = str(mapping.noteId);
    const source = sourceById.get(sourceId);
    const rawEvents = rows<EventPair>(mapping.rawEvents);
    add("identity", `identityMappings[${index}].sourceInstrument`, source?.sourceInstrument, mapping.sourceInstrument);
    add("identity", `identityMappings[${index}].sourceOrdinal`, source?.sourceOrdinal, mapping.sourceOrdinal);
    if (mapping.status === "ambiguous" || mapping.status === "decoded-only" || mapping.status === "unmapped") {
      add("identity", `identityMappings[${index}].rawEvents.length`, 0, rawEvents.length);
      if (source?.sourceEvent) add("identity", `sourceNotes[${sourceId}].sourceEvent`, undefined, source.sourceEvent);
    } else if (mapping.status === "exact" || mapping.status === "merged") {
      add("identity", `identityMappings[${index}].rawEvents.length`, 1, rawEvents.length);
      if (!source?.sourceEvent || JSON.stringify(source.sourceEvent) !== JSON.stringify(rawEvents[0])) {
        differences.push({ fixtureId, category: "identity", path: `identityMappings[${index}].rawEvents`, expected: source?.sourceEvent ?? "observed unique raw locator", actual: rawEvents });
      }
    }
  }

  const comparisonResult = status !== "invalid";
  if (comparisonResult && document) {
    const actualDocumentNotes = rows<NoteRow>(document.notes);
    const goldenNotesByKey = indexBySourceSet(golden.desktopNotes, (note) => note.sourceNoteIds, differences, fixtureId, "golden.desktopNotes");
    const actualRawNotes = rows<NoteRow>(raw.desktopNotes).map((note) => ({ ...note, sourceNoteIds: canonicalIds(note.sourceNoteIds, actualSourceIdToGolden, differences, fixtureId, "rawBaseline.desktopNotes") }));
    const actualRawByKey = indexBySourceSet(actualRawNotes, (note) => note.sourceNoteIds, differences, fixtureId, "rawBaseline.desktopNotes");
    compareNoteSets(goldenNotesByKey, actualRawByKey, differences, fixtureId, "rawBaseline.desktopNotes", near, add);

    const actualDocCanonical = actualDocumentNotes.map((note) => ({
      ...note,
      sourceNoteIds: canonicalIds(note.sourceNoteIds ?? [], actualSourceIdToGolden, differences, fixtureId, "document.notes"),
      start: number(note.startSeconds),
      end: number(note.endSeconds),
      hand: note.hand === "left" ? "L" as const : "R" as const,
      manualFinger: note.finger ?? null,
      gliss: note.glissando,
    }));
    const actualDocByKey = indexBySourceSet(actualDocCanonical, (note) => note.sourceNoteIds, differences, fixtureId, "document.notes");
    compareNoteSets(goldenNotesByKey, actualDocByKey, differences, fixtureId, "document.notes", near, add);

    compareAssignments(golden, result.fingeringPlan, actualDocumentNotes, actualSourceIdToGolden, differences, fixtureId, add);
    comparePerformance(golden, result.performancePlan, actualDocumentNotes, actualSourceIdToGolden, differences, fixtureId, near, add);
    comparePedalRows(golden.rawPedals, rows(raw.rawPedals), "rawBaseline.rawPedals", fixtureId, differences, near, add);
    comparePedalRows(golden.pedals, rows(raw.pedals), "rawBaseline.pedals", fixtureId, differences, near, add);
    comparePedalRows(golden.rawPedals, rows(document.pedalControls).map((control) => ({
      time: record(control).timeSeconds,
      controller: record(control).controller,
      value: record(control).value,
    })), "document.pedalControls", fixtureId, differences, near, add);
    compareSourcePedals(golden.sourcePedals, rows(raw.sourcePedals), fixtureId, differences, near, add);
    compareTracks(golden.tracks, rows(raw.tracks), fixtureId, differences, add);

    const rawActualPoses = rows<GoldenPose>(raw.selectedPoses);
    const goldenPoses = golden.selectedPoses;
    const frame = goldenPoses[0]?.coordinateFrame;
    const rawCoordinateTolerance = frame ? frame.keyboardRect[2] / WHITE_KEYS_ON_88_KEYBOARD * RAW_COORDINATE_TOLERANCE_WHITE_KEYS : 0;
    for (const expectedPose of goldenPoses) {
      const key = `${expectedPose.hand}:${expectedPose.time.toFixed(6)}`;
      const actualPose = rawActualPoses.find((pose) => pose.hand === expectedPose.hand && Math.abs(pose.time - expectedPose.time) <= TIME_TOLERANCE_SECONDS);
      if (!actualPose) {
        differences.push({ fixtureId, category: "raw-pose", path: `selectedPoses[${key}]`, expected: "sampled raw pose", actual: "missing" });
        continue;
      }
      checkedPosePairs += 1;
      compareRawPose(expectedPose, actualPose, rawCoordinateTolerance, differences, fixtureId, near, add);
    }
    comparePhysicalMotion(result.motionPlan, rawActualPoses, frame?.keyboardRect, differences, fixtureId, near, add);
  }

  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  return {
    fixtureId,
    expectedStatus: status,
    actualStatus: str(result.status),
    expectedCounts: {
      sourceNotes: golden.sourceNotes?.length ?? 0,
      normalizedNotes: golden.desktopNotes?.length ?? 0,
      assignments: golden.assignments?.length ?? 0,
      performanceEvents: golden.performanceEvents?.length ?? 0,
      rawPedals: golden.rawPedals?.length ?? 0,
      pedals: golden.pedals?.length ?? 0,
      sourcePedals: golden.sourcePedals?.length ?? 0,
      sampledPoses: golden.selectedPoses?.length ?? 0,
    },
    actualCounts: {
      sourceNotes: count(raw.sourceNotes),
      normalizedNotes: count(raw.desktopNotes),
      assignments: count(record(result.fingeringPlan ?? {}).assignments),
      performanceEvents: count(record(result.performancePlan ?? {}).events),
      rawPedals: count(raw.rawPedals),
      pedals: count(raw.pedals),
      sourcePedals: count(raw.sourcePedals),
      sampledPoses: count(raw.selectedPoses),
    },
    checkedPosePairs,
    numericTolerance: {
      timeSeconds: TIME_TOLERANCE_SECONDS,
      rawCoordinatesInWhiteKeys: RAW_COORDINATE_TOLERANCE_WHITE_KEYS,
      physicalCoordinatesInWhiteKeys: PHYSICAL_COORDINATE_TOLERANCE_WHITE_KEYS,
    },
    differences,
  };
}

function canonicalIds(ids: string[], crosswalk: Map<string, string>, differences: ParityDifference[], fixtureId: string, path: string): string[] {
  if (ids.length === 0) {
    differences.push({ fixtureId, category: "identity", path, expected: "explicit sourceNoteIds", actual: [] });
    return [];
  }
  return ids.map((id) => {
    const canonical = crosswalk.get(id);
    if (!canonical) differences.push({ fixtureId, category: "identity", path, expected: "source ID present in decoded identity crosswalk", actual: id });
    return canonical ?? `unmapped:${id}`;
  }).sort();
}

function indexBySourceSet<T extends { sourceNoteIds?: string[] }>(
  values: T[],
  identity: (value: T) => string[],
  differences: ParityDifference[],
  fixtureId: string,
  path: string,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    const ids = identity(value);
    if (ids.length === 0) {
      differences.push({ fixtureId, category: "identity", path, expected: "explicit source aliases", actual: value });
    }
    const key = ids.slice().sort().join("|");
    map.set(key, [...(map.get(key) ?? []), value]);
  }
  return map;
}

function compareNoteSets(
  expected: Map<string, NoteRow[]>,
  actual: Map<string, NoteRow[]>,
  differences: ParityDifference[],
  fixtureId: string,
  path: string,
  near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  const allKeys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of allKeys) {
    const e = expected.get(key) ?? [];
    const a = actual.get(key) ?? [];
    add("notes", `${path}[${key}].count`, e.length, a.length);
    for (let index = 0; index < Math.min(e.length, a.length); index += 1) {
      const expectedNote = e[index]!;
      const actualNote = a[index]!;
      for (const field of ["pitch", "velocity", "hand"] as const) add("notes", `${path}[${key}][${index}].${field}`, expectedNote[field], actualNote[field]);
      near("notes", `${path}[${key}][${index}].start`, expectedNote.start, actualNote.start, TIME_TOLERANCE_SECONDS);
      near("notes", `${path}[${key}][${index}].end`, expectedNote.end, actualNote.end, TIME_TOLERANCE_SECONDS);
      if (expectedNote.manualFinger !== undefined) add("notes", `${path}[${key}][${index}].manualFinger`, expectedNote.manualFinger, actualNote.manualFinger ?? null);
      if (expectedNote.gliss !== undefined) add("notes", `${path}[${key}][${index}].gliss`, expectedNote.gliss, actualNote.gliss ?? actualNote.glissando);
    }
  }
}

function compareAssignments(
  golden: GoldenFixture,
  planValue: unknown,
  documentNotes: NoteRow[],
  crosswalk: Map<string, string>,
  differences: ParityDifference[],
  fixtureId: string,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  const plan = record(planValue);
  const assignmentRows = rows<Record<string, unknown>>(plan.assignments);
  const noteById = new Map(documentNotes.map((note) => [str(note.noteId), note]));
  const actualByKey = new Map<string, Record<string, unknown>[]>();
  for (const assignment of assignmentRows) {
    const note = noteById.get(str(assignment.noteId));
    const key = note ? canonicalIds(note.sourceNoteIds ?? [], crosswalk, differences, fixtureId, "fingeringPlan.assignments") .join("|") : `missing-note:${str(assignment.noteId)}`;
    actualByKey.set(key, [...(actualByKey.get(key) ?? []), assignment]);
  }
  const expectedByKey = new Map<string, GoldenFixture["assignments"]>();
  for (const assignment of golden.assignments) {
    const key = assignment.sourceNoteIds.slice().sort().join("|");
    expectedByKey.set(key, [...(expectedByKey.get(key) ?? []), assignment]);
  }
  for (const key of new Set([...actualByKey.keys(), ...expectedByKey.keys()])) {
    const expected = expectedByKey.get(key) ?? [];
    const actual = actualByKey.get(key) ?? [];
    add("fingering", `assignments[${key}].count`, expected.length, actual.length);
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      const e = expected[index]!;
      const a = actual[index]!;
      const disposition = e.gliss ? "glissando" : e.finger === null ? "unplayable" : "played";
      add("fingering", `assignments[${key}][${index}].hand`, handName(e.hand), a.hand);
      add("fingering", `assignments[${key}][${index}].finger`, e.finger, a.finger);
      add("fingering", `assignments[${key}][${index}].disposition`, disposition, a.disposition);
    }
  }
}

function comparePerformance(
  golden: GoldenFixture,
  planValue: unknown,
  documentNotes: NoteRow[],
  crosswalk: Map<string, string>,
  differences: ParityDifference[],
  fixtureId: string,
  near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  const events = rows<Record<string, unknown>>(record(planValue).events);
  const noteById = new Map(documentNotes.map((note) => [str(note.noteId), note]));
  const pairs = new Map<string, { hand: string; press?: number; release?: number }>();
  for (const event of events) {
    if (event.type === "pedal") continue;
    const noteId = str(event.noteId);
    const note = noteById.get(noteId);
    if (!note) {
      differences.push({ fixtureId, category: "performance", path: `events[${noteId}]`, expected: "normalized note reference", actual: "missing" });
      continue;
    }
    const aliases = canonicalIds(note.sourceNoteIds ?? [], crosswalk, differences, fixtureId, "performancePlan.events").join("|");
    const key = `${aliases}:${str(note.hand)}`;
    const pair = pairs.get(key) ?? { hand: str(note.hand) };
    const eventType = str(event.type);
    const value = number(event.timeSeconds);
    if (eventType === "press") {
      if (pair.press !== undefined) differences.push({ fixtureId, category: "performance", path: `${key}.press`, expected: "one press", actual: "duplicate" });
      pair.press = value;
    } else if (eventType === "release") {
      if (pair.release !== undefined) differences.push({ fixtureId, category: "performance", path: `${key}.release`, expected: "one release", actual: "duplicate" });
      pair.release = value;
    }
    pairs.set(key, pair);
  }
  const expected = new Map<string, GoldenFixture["performanceEvents"]>();
  for (const event of golden.performanceEvents) {
    const key = `${event.sourceNoteIds.slice().sort().join("|")}:${handName(event.hand)}`;
    expected.set(key, [...(expected.get(key) ?? []), event]);
  }
  for (const [key, eventsForKey] of expected) {
    const actual = pairs.get(key);
    add("performance", `events[${key}].count`, eventsForKey.length, actual ? 1 : 0);
    if (eventsForKey.length !== 1 || !actual) continue;
    near("performance", `events[${key}].press`, eventsForKey[0]!.press, actual.press ?? Number.NaN, TIME_TOLERANCE_SECONDS);
    near("performance", `events[${key}].release`, eventsForKey[0]!.release, actual.release ?? Number.NaN, TIME_TOLERANCE_SECONDS);
  }
  for (const key of pairs.keys()) if (!expected.has(key)) add("performance", `events[${key}]`, "golden event", pairs.get(key));
}

function comparePedalRows(
  expected: { time: number; controller: number; value: number }[],
  actualValues: unknown[],
  path: string,
  fixtureId: string,
  differences: ParityDifference[],
  near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  add("pedals", `${path}.length`, expected.length, actualValues.length);
  for (let index = 0; index < Math.min(expected.length, actualValues.length); index += 1) {
    const e = expected[index]!;
    const a = record(actualValues[index]);
    add("pedals", `${path}[${index}].controller`, e.controller, a.controller);
    add("pedals", `${path}[${index}].value`, e.value, a.value);
    near("pedals", `${path}[${index}].time`, e.time, number(a.time ?? a.timeSeconds), TIME_TOLERANCE_SECONDS);
  }
  void differences;
  void fixtureId;
}

function compareSourcePedals(
  expected: GoldenFixture["sourcePedals"], actualValues: unknown[], fixtureId: string,
  differences: ParityDifference[], near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  add("pedals", "sourcePedals.length", expected.length, actualValues.length);
  for (let index = 0; index < Math.min(expected.length, actualValues.length); index += 1) {
    const e = expected[index]!;
    const a = record(actualValues[index]);
    for (const field of ["track", "tick", "controller", "value"] as const) add("pedals", `sourcePedals[${index}].${field}`, e[field], a[field]);
    near("pedals", `sourcePedals[${index}].time`, e.time, number(a.time), TIME_TOLERANCE_SECONDS);
  }
  void differences;
  void fixtureId;
}

function compareTracks(
  expected: GoldenFixture["tracks"], actualValues: unknown[], fixtureId: string,
  differences: ParityDifference[], add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  add("tracks", "tracks.length", expected.length, actualValues.length);
  for (let index = 0; index < Math.min(expected.length, actualValues.length); index += 1) {
    const e = expected[index]!;
    const a = record(actualValues[index]);
    for (const field of ["index", "name", "program", "noteCount", "declaredHand"] as const) add("tracks", `tracks[${index}].${field}`, e[field], a[field]);
  }
  void differences;
  void fixtureId;
}

function compareRawPose(
  expected: GoldenPose, actual: GoldenPose, tolerance: number, differences: ParityDifference[], fixtureId: string,
  near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  add("raw-pose", `selectedPoses[${expected.hand}:${expected.time}].layer`, expected.layer, record(actual).layer);
  near("raw-pose", `selectedPoses[${expected.hand}:${expected.time}].time`, expected.time, number(record(actual).time), TIME_TOLERANCE_SECONDS);
  const actualFrame = record(record(actual).coordinateFrame);
  for (let i = 0; i < 4; i += 1) add("raw-pose", `selectedPoses[${expected.hand}:${expected.time}].keyboardRect[${i}]`, expected.coordinateFrame.keyboardRect[i], rows<number>(actualFrame.keyboardRect)[i]);
  add("raw-pose", `selectedPoses[${expected.hand}:${expected.time}].boneCount`, expected.bones.length, rows(actual.bones).length);
  for (let index = 0; index < Math.min(expected.bones.length, rows(actual.bones).length); index += 1) {
    const e = expected.bones[index]!;
    const a = record(rows(actual.bones)[index]);
    add("raw-pose", `bones[${index}].type`, e.type, a.type);
    compareVector(e.start, rows<number>(a.start) as Vec3, tolerance, `bones[${index}].start`, fixtureId, differences);
    compareVector(e.end, rows<number>(a.end) as Vec3, tolerance, `bones[${index}].end`, fixtureId, differences);
  }
  add("raw-pose", `selectedPoses[${expected.hand}:${expected.time}].jointCount`, expected.joints.length, rows(actual.joints).length);
  for (let index = 0; index < Math.min(expected.joints.length, rows(actual.joints).length); index += 1) {
    const e = expected.joints[index]!;
    const a = record(rows(actual.joints)[index]);
    add("raw-pose", `joints[${index}].type`, e.type, a.type);
    compareVector(e.position, rows<number>(a.position) as Vec3, tolerance, `joints[${index}].position`, fixtureId, differences);
  }
  compareVector(expected.armEnd, rows<number>(record(actual).armEnd) as Vec3, tolerance, "armEnd", fixtureId, differences);
  for (const finger of Object.keys(expected.fingerTips)) {
    compareVector(expected.fingerTips[finger]!, rows<number>(record(actual).fingerTips && record(record(actual).fingerTips)[finger]) as Vec3, tolerance, `fingerTips.${finger}`, fixtureId, differences);
    const expectedChain = expected.fingerChains[finger] ?? [];
    const actualChain = rows<Vec3>(record(record(actual).fingerChains)[finger]);
    add("raw-pose", `fingerChains.${finger}.length`, expectedChain.length, actualChain.length);
    for (let i = 0; i < Math.min(expectedChain.length, actualChain.length); i += 1) compareVector(expectedChain[i]!, actualChain[i]!, tolerance, `fingerChains.${finger}[${i}]`, fixtureId, differences);
  }
  add("raw-pose", "wristJoints.length", expected.wristJoints.length, rows(actual.wristJoints).length);
  for (let i = 0; i < Math.min(expected.wristJoints.length, rows(actual.wristJoints).length); i += 1) compareVector(expected.wristJoints[i]!, rows<number>(rows(actual.wristJoints)[i]) as Vec3, tolerance, `wristJoints[${i}]`, fixtureId, differences);
  const actualWrist = record(actual.wristPose);
  for (let i = 0; i < 2; i += 1) near("raw-pose", `wristPose.positionPx[${i}]`, expected.wristPose.positionPx[i]!, number(rows(actualWrist.positionPx)[i]), tolerance);
  near("raw-pose", "wristPose.headingRadians", expected.wristPose.headingRadians, number(actualWrist.headingRadians), 0.001);
}

function compareVector(expected: Vec3, actual: Vec3, tolerance: number, path: string, fixtureId: string, differences: ParityDifference[]): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = Math.abs(expected[axis]! - number(actual[axis]));
    if (!Number.isFinite(delta) || delta > tolerance) differences.push({ fixtureId, category: "raw-pose", path: `${path}[${axis}]`, expected: expected[axis], actual: actual[axis], delta, tolerance });
  }
}

function comparePhysicalMotion(
  motionPlanValue: unknown,
  rawPoses: GoldenPose[],
  keyboardRect: [number, number, number, number] | undefined,
  differences: ParityDifference[],
  fixtureId: string,
  near: (category: string, path: string, expected: number, actual: number, tolerance: number) => void,
  add: (category: string, path: string, expected: unknown, actual: unknown) => void,
): void {
  const plan = record(motionPlanValue ?? {});
  const motionPoses = rows<Record<string, unknown>>(plan.poses);
  if (rawPoses.length !== motionPoses.length) add("physical-transform", "poseCount", rawPoses.length, motionPoses.length);
  const rectX = keyboardRect?.[0] ?? 0;
  const toleranceInches = WHITE_KEY_INCHES * PHYSICAL_COORDINATE_TOLERANCE_WHITE_KEYS;
  for (const rawPose of rawPoses) {
    const motion = motionPoses.find((pose) => pose.hand === handName(rawPose.hand) && Math.abs(number(pose.transportTimeSeconds) - rawPose.time) <= TIME_TOLERANCE_SECONDS);
    if (!motion) {
      differences.push({ fixtureId, category: "physical-transform", path: `motionPlan[${rawPose.hand}:${rawPose.time}]`, expected: "matching typed pose", actual: "missing" });
      continue;
    }
    add("physical-transform", `motionPlan[${rawPose.hand}:${rawPose.time}].layerOrder`, rawPose.layer, motion.layerOrder);
    const ppi = rawPose.coordinateFrame.pixelsPerInch;
    const convert = (point: Vec3): Vec3 => [
      (point[0] - rectX) / ppi,
      point[1] / ppi,
      point[2] / ppi,
    ];
    const compareConverted = (expectedPoint: Vec3, actualPoint: unknown, path: string) => {
      const actual = rows<number>(actualPoint) as Vec3;
      const physical = convert(expectedPoint);
      for (let axis = 0; axis < 3; axis += 1) near("physical-transform", `${path}[${axis}]`, physical[axis]!, number(actual[axis]), toleranceInches);
    };
    const motionBones = rows<Record<string, unknown>>(motion.bones);
    add("physical-transform", `motionPlan[${rawPose.hand}:${rawPose.time}].boneCount`, rawPose.bones.length, motionBones.length);
    for (let index = 0; index < Math.min(rawPose.bones.length, motionBones.length); index += 1) {
      const rawBone = rawPose.bones[index]!;
      const motionBone = motionBones[index]!;
      add("physical-transform", `bones[${index}].kind`, rawBone.type, motionBone.kind);
      compareConverted(rawBone.start, motionBone.a, `motion.bones[${index}].a`);
      compareConverted(rawBone.end, motionBone.b, `motion.bones[${index}].b`);
    }
    const motionJoints = rows<Record<string, unknown>>(motion.joints);
    add("physical-transform", `motionPlan[${rawPose.hand}:${rawPose.time}].jointCount`, rawPose.joints.length, motionJoints.length);
    for (let index = 0; index < Math.min(rawPose.joints.length, motionJoints.length); index += 1) {
      add("physical-transform", `joints[${index}].kind`, rawPose.joints[index]!.type, motionJoints[index]!.kind);
      compareConverted(rawPose.joints[index]!.position, motionJoints[index]!.point, `motion.joints[${index}].point`);
    }
  }
}
