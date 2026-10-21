import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const PACKAGE_VERSION = 2 as const;
export const TRANSPORT_LEAD_IN_SECONDS = 2;
const EXPLICIT_GLISSANDO_MAX_GAP_SECONDS = 0.5;

const id = z.string().trim().min(1).max(200);
const finite = z.number().finite();
const sourceTime = finite.min(0);
export const PRACTICE_MIN_LOOP_SECONDS = 0.1;
export const TransportTimeSchema = finite.min(-TRANSPORT_LEAD_IN_SECONDS);
export type TransportTime = z.infer<typeof TransportTimeSchema>;

const object = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    finite,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const M1RawHandSchema = z.enum(["L", "R"]);
const M1RawVector3Schema = z.tuple([finite, finite, finite]);
const M1RawSourceNoteSchema = object({
  noteId: id,
  sourceInstrument: z.number().int().nonnegative(),
  sourceOrdinal: z.number().int().nonnegative(),
  pitch: z.number().int().min(21).max(108),
  velocity: z.number().int().min(1).max(127),
  start: sourceTime,
  end: sourceTime,
  sourceEvent: z.object({
    midiTrackIndex: z.number().int().nonnegative(),
    channel: z.number().int().min(0).max(15),
    noteOnOrdinal: z.number().int().nonnegative(),
    noteOffOrdinal: z.number().int().nonnegative(),
  }).optional(),
}).superRefine((note, ctx) => {
  if (note.end <= note.start) ctx.addIssue({ code: "custom", path: ["end"], message: "must follow start" });
  if (note.sourceEvent && note.sourceEvent.noteOffOrdinal <= note.sourceEvent.noteOnOrdinal) {
    ctx.addIssue({ code: "custom", path: ["sourceEvent", "noteOffOrdinal"], message: "must follow noteOnOrdinal" });
  }
});
const M1RawSourcePedalSchema = object({
  track: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  time: sourceTime,
  controller: z.union([z.literal(64), z.literal(66), z.literal(67)]),
  value: z.number().int().min(0).max(127),
});
const M1RawParseErrorSchema = object({ message: z.string(), phase: id, type: id });
const M1RawMidiEventPairSchema = object({
  midiTrackIndex: z.number().int().nonnegative(),
  channel: z.number().int().min(0).max(15),
  noteOnOrdinal: z.number().int().nonnegative(),
  noteOffOrdinal: z.number().int().nonnegative(),
}).superRefine((pair, ctx) => {
  if (pair.noteOffOrdinal <= pair.noteOnOrdinal) {
    ctx.addIssue({ code: "custom", path: ["noteOffOrdinal"], message: "must follow noteOnOrdinal" });
  }
});
const M1RawIdentityMappingSchema = object({
  noteId: id,
  sourceInstrument: z.number().int().nonnegative(),
  sourceOrdinal: z.number().int().nonnegative(),
  rawEvents: z.array(M1RawMidiEventPairSchema),
  normalizedNoteId: id.nullable(),
  status: z.enum(["exact", "merged", "decoded-only", "unmapped", "ambiguous"]),
}).superRefine((mapping, ctx) => {
  if ((mapping.status === "exact" || mapping.status === "merged") &&
      (mapping.rawEvents.length !== 1 || mapping.normalizedNoteId === null)) {
    ctx.addIssue({ code: "custom", path: ["rawEvents"], message: "exact/merged mappings require one uniquely observed event pair and one normalized note" });
  }
  if ((mapping.status === "decoded-only" || mapping.status === "unmapped" || mapping.status === "ambiguous") && mapping.rawEvents.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["rawEvents"], message: "unlocatable source identity must not claim raw events" });
  }
  if (mapping.status === "unmapped" && mapping.normalizedNoteId !== null) {
    ctx.addIssue({ code: "custom", path: ["normalizedNoteId"], message: "unmapped source identity cannot reference a normalized note" });
  }
  if (mapping.status === "decoded-only" && mapping.normalizedNoteId === null) {
    ctx.addIssue({ code: "custom", path: ["normalizedNoteId"], message: "decoded-only identity must reference its normalized note" });
  }
});
const M1RawDesktopNoteSchema = object({
  noteId: id.nullable(),
  sourceNoteIds: z.array(id),
  track: z.number().int().nonnegative(),
  pitch: z.number().int().min(21).max(108),
  velocity: z.number().int().min(1).max(127),
  start: sourceTime,
  end: sourceTime,
  hand: M1RawHandSchema,
  manualFinger: z.number().int().min(1).max(5).nullable(),
  gliss: z.boolean(),
}).superRefine((note, ctx) => {
  if (note.end <= note.start) ctx.addIssue({ code: "custom", path: ["end"], message: "must follow start" });
});
const M1RawAssignmentSchema = object({
  noteId: id.nullable(),
  sourceNoteIds: z.array(id),
  hand: M1RawHandSchema,
  finger: z.number().int().min(1).max(5).nullable(),
  manualFinger: z.number().int().min(1).max(5).nullable(),
  gliss: z.boolean(),
});
const M1RawPerformanceEventSchema = object({
  noteId: id.nullable(),
  sourceNoteIds: z.array(id),
  hand: M1RawHandSchema,
  press: sourceTime,
  release: sourceTime,
}).superRefine((event, ctx) => {
  if (event.release <= event.press) ctx.addIssue({ code: "custom", path: ["release"], message: "must follow press" });
});
const M1RawPedalSchema = object({
  time: sourceTime,
  controller: z.union([z.literal(64), z.literal(66), z.literal(67)]),
  value: z.number().int().min(0).max(127),
});
const M1RawThresholdedPedalSchema = object({
  time: sourceTime,
  controller: z.union([z.literal(64), z.literal(66), z.literal(67)]),
  value: z.union([z.literal(0), z.literal(127)]),
});
const M1RawFrameSchema = object({
  units: z.literal("screen pixels"),
  keyboardRect: z.tuple([finite, finite, finite.positive(), finite.positive()]),
  origin: z.literal("top-left of keyboardRect"),
  // Historical golden metadata says y-down, while the raw pose depth coordinate increases away from the pianist.
  // Keep the recorded tag intact; ADR-001 defines the physical conversion used for M1 comparisons.
  axes: object({ x: z.string(), y: z.string(), z: z.string() }),
  pixelsPerInch: finite.positive(),
  frontY: finite,
});
const M1RawPoseBoneSchema = object({
  start: M1RawVector3Schema,
  end: M1RawVector3Schema,
  type: z.enum(["forearm", "carpal", "metacarpal", "proximal", "middle", "distal"]),
});
const M1RawPoseJointSchema = object({
  position: M1RawVector3Schema,
  type: z.enum(["knuckle", "tip", "wrist"]),
});
const M1RawFiveFingerVectorsSchema = z.record(z.string().regex(/^[1-5]$/), M1RawVector3Schema);
const M1RawFingerChainsSchema = z.record(z.string().regex(/^[1-5]$/), z.array(M1RawVector3Schema).min(1));
const M1RawSelectedPoseSchema = object({
  hand: M1RawHandSchema,
  time: TransportTimeSchema,
  layer: z.number().int(),
  coordinateFrame: M1RawFrameSchema,
  armEnd: M1RawVector3Schema,
  boneCount: z.number().int().nonnegative(),
  bones: z.array(M1RawPoseBoneSchema).min(1),
  fingerTips: M1RawFiveFingerVectorsSchema,
  fingerChains: M1RawFingerChainsSchema,
  jointCount: z.number().int().nonnegative(),
  joints: z.array(M1RawPoseJointSchema).min(1),
  wristJoints: z.array(M1RawVector3Schema).min(1),
  wristPose: object({ positionPx: z.tuple([finite, finite]), headingRadians: finite }),
}).superRefine((pose, ctx) => {
  if (pose.boneCount !== pose.bones.length) {
    ctx.addIssue({ code: "custom", path: ["boneCount"], message: "must equal the serialized bone count" });
  }
  if (pose.jointCount !== pose.joints.length) {
    ctx.addIssue({ code: "custom", path: ["jointCount"], message: "must equal the serialized joint count" });
  }
});
const M1RawTrackSchema = object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  program: z.number().int().min(0).max(127),
  noteCount: z.number().int().nonnegative(),
  declaredHand: M1RawHandSchema.nullable(),
});
const M1RawHandSummarySchema = object({
  hand: M1RawHandSchema,
  assignedCount: z.number().int().nonnegative(),
  rolledChords: z.number().int().nonnegative(),
  glissRuns: z.array(z.array(sourceTime)),
});
const M1RawCrossingEpisodeSchema = object({
  start: TransportTimeSchema,
  end: TransportTimeSchema,
  topHand: M1RawHandSchema,
  strength: finite,
  lead: finite,
}).superRefine((episode, ctx) => {
  if (episode.end < episode.start) ctx.addIssue({ code: "custom", path: ["end"], message: "must not precede start" });
});
const M1RawIdentityLossSchema = object({ normalizedNoteId: id, sourceNoteIds: z.array(id).min(2) });
const M1RawProvenanceSchema = object({
  profile: z.string().min(1),
  engineVersion: z.string().regex(/^[a-f0-9]{64}$/),
  desktopSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  desktopVersion: id,
  adaptedFiles: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
  keyStyle: z.enum(["realistic", "equal"]),
  rawEventCount: z.number().int().nonnegative(),
});

/** Typed, comparison-only subset of the immutable M0 golden shape plus M1 identity evidence. */
const M1RawBaselineSchema = object({
  fixtureId: id.optional(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["loaded", "repaired", "invalid-or-rejected"]),
  duration: sourceTime.optional(),
  sourceNotes: z.array(M1RawSourceNoteSchema),
  sourcePedals: z.array(M1RawSourcePedalSchema),
  sourceParseErrors: z.array(M1RawParseErrorSchema),
  loadError: object({ message: z.string(), type: id }).optional(),
  desktopNotes: z.array(M1RawDesktopNoteSchema),
  assignments: z.array(M1RawAssignmentSchema),
  performanceEvents: z.array(M1RawPerformanceEventSchema),
  pedals: z.array(M1RawThresholdedPedalSchema),
  rawPedals: z.array(M1RawPedalSchema),
  selectedPoses: z.array(M1RawSelectedPoseSchema),
  cleanup: z.array(z.string()),
  unmappedSourceNoteIds: z.array(id),
  tracks: z.array(M1RawTrackSchema),
  hands: z.array(M1RawHandSummarySchema),
  crossingEpisodes: z.array(M1RawCrossingEpisodeSchema),
  identityLosses: z.array(M1RawIdentityLossSchema),
  identityMappings: z.array(M1RawIdentityMappingSchema),
  sourceNoteIdentitySemantics: z.string().min(1),
  provenance: M1RawProvenanceSchema.optional(),
  goldenTrust: z.string().min(1),
}).superRefine((baseline, ctx) => {
  if (baseline.status === "invalid-or-rejected" && !baseline.loadError) {
    ctx.addIssue({ code: "custom", path: ["loadError"], message: "rejected input must preserve the observed loader error" });
  }
  if (baseline.status !== "invalid-or-rejected" && baseline.loadError) {
    ctx.addIssue({ code: "custom", path: ["loadError"], message: "a returned song must not carry a terminal load error" });
  }
  const sourceIds = new Set<string>();
  for (const [index, note] of baseline.sourceNotes.entries()) {
    if (sourceIds.has(note.noteId)) {
      ctx.addIssue({ code: "custom", path: ["sourceNotes", index, "noteId"], message: "source note IDs must be unique" });
    }
    sourceIds.add(note.noteId);
  }
  const mappedIds = new Set<string>();
  for (const [index, mapping] of baseline.identityMappings.entries()) {
    const source = baseline.sourceNotes.find((note) => note.noteId === mapping.noteId);
    if (!source) {
      ctx.addIssue({ code: "custom", path: ["identityMappings", index, "noteId"], message: "must reference an observed source note" });
    } else if (source.sourceInstrument !== mapping.sourceInstrument || source.sourceOrdinal !== mapping.sourceOrdinal) {
      ctx.addIssue({ code: "custom", path: ["identityMappings", index], message: "must preserve the decoded instrument and note ordinal" });
    }
    if (mappedIds.has(mapping.noteId)) {
      ctx.addIssue({ code: "custom", path: ["identityMappings", index, "noteId"], message: "source identity may be mapped only once" });
    }
    mappedIds.add(mapping.noteId);
  }
  const mappingBySourceId = new Map(baseline.identityMappings.map((mapping) => [mapping.noteId, mapping]));
  for (const [index, source] of baseline.sourceNotes.entries()) {
    const mapping = mappingBySourceId.get(source.noteId);
    if (!mapping) continue;
    const mappedEvent = mapping.rawEvents[0];
    if (source.sourceEvent && (mapping.status === "ambiguous" || mapping.status === "decoded-only" ||
        mapping.status === "unmapped" || !mappedEvent ||
        JSON.stringify(source.sourceEvent) !== JSON.stringify(mappedEvent))) {
      ctx.addIssue({ code: "custom", path: ["sourceNotes", index, "sourceEvent"], message: "must match a unique raw event locator in the corresponding identity mapping" });
    }
    if ((mapping.status === "ambiguous" || mapping.status === "decoded-only" || mapping.status === "unmapped") && source.sourceEvent) {
      ctx.addIssue({ code: "custom", path: ["sourceNotes", index, "sourceEvent"], message: "unlocatable identity status must not expose a sourceEvent" });
    }
  }
  if (baseline.status !== "invalid-or-rejected" && !baseline.provenance) {
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "successful analysis must report the adapted-core provenance" });
  }
});
export type M1RawBaseline = z.infer<typeof M1RawBaselineSchema>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const ResourceDescriptorSchema = object({
  resourceId: id,
  purpose: z.enum(["source-midi", "profile-asset", "project-asset"]),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // A package-relative location. Payload bytes are stored alongside the JSON manifest.
  path: z.string().min(1).refine((value) => {
    const parts = value.replaceAll("\\", "/").split("/");
    return !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
      parts.every((part) => part !== "" && part !== "." && part !== "..");
  }, "must be a safe package-relative path"),
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

export const MidiTrackSchema = object({
  trackId: id,
  // Matches MidiSong.Note.track / TrackInfo.index: the decoded instrument index.
  instrumentIndex: z.number().int().nonnegative(),
  // Raw SMF track/channel are optional because the current desktop loader loses this mapping.
  sourceMidiTrackIndex: z.number().int().nonnegative().optional(),
  channel: z.number().int().min(0).max(15).optional(),
  name: z.string(),
  program: z.number().int().min(0).max(127),
  hand: z.enum(["left", "right"]).nullable(),
});
export type MidiTrack = z.infer<typeof MidiTrackSchema>;

export const NoteSchema = object({
  noteId: id,
  trackId: id,
  pitch: z.number().int().min(21).max(108),
  velocity: z.number().int().min(1).max(127),
  startSeconds: sourceTime,
  endSeconds: sourceTime,
  hand: z.enum(["left", "right"]),
  finger: z.number().int().min(1).max(5).nullable(),
  glissando: z.boolean(),
  // Opaque importer IDs; multiple source notes may normalize to this one note.
  // They are not claims about raw MIDI track/event ordinals.
  sourceNoteIds: z.array(id).min(1).optional(),
  sourceEvent: object({
    midiTrackIndex: z.number().int().nonnegative(),
    channel: z.number().int().min(0).max(15),
    noteOnOrdinal: z.number().int().nonnegative(),
    noteOffOrdinal: z.number().int().nonnegative(),
  }).optional(),
}).superRefine((note, ctx) => {
  if (note.endSeconds <= note.startSeconds) {
    ctx.addIssue({ code: "custom", path: ["endSeconds"], message: "must be after startSeconds" });
  }
  if (note.sourceEvent && note.sourceEvent.noteOffOrdinal <= note.sourceEvent.noteOnOrdinal) {
    ctx.addIssue({ code: "custom", path: ["sourceEvent", "noteOffOrdinal"], message: "must follow noteOnOrdinal" });
  }
});
export type Note = z.infer<typeof NoteSchema>;

export const TempoChangeSchema = object({
  timeSeconds: sourceTime,
  microsecondsPerQuarterNote: z.number().int().min(1).max(0xffffff),
  // Normalized document order for equal-time tempo changes, not a raw SMF ordinal.
  eventOrdinal: z.number().int().nonnegative(),
});
export type TempoChange = z.infer<typeof TempoChangeSchema>;

export const PedalControlSchema = object({
  timeSeconds: sourceTime,
  controller: z.union([z.literal(64), z.literal(66), z.literal(67)]),
  value: z.number().int().min(0).max(127),
  // Preserves normalized raw-control order; it is not a byte offset or SMF locator.
  eventOrdinal: z.number().int().nonnegative(),
});
export type PedalControl = z.infer<typeof PedalControlSchema>;

export const SongDocumentSchema = object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  projectId: id,
  revision: z.number().int().nonnegative(),
  title: z.string(),
  durationSeconds: sourceTime,
  sourceMidiResourceId: id.optional(),
  tracks: z.array(MidiTrackSchema),
  notes: z.array(NoteSchema),
  tempoMap: z.array(TempoChangeSchema),
  pedalControls: z.array(PedalControlSchema),
}).superRefine((song, ctx) => {
  const trackIds = new Set<string>();
  const instrumentIndexes = new Set<number>();
  for (const [index, track] of song.tracks.entries()) {
    if (trackIds.has(track.trackId)) {
      ctx.addIssue({ code: "custom", path: ["tracks", index, "trackId"], message: "duplicate trackId" });
    }
    if (instrumentIndexes.has(track.instrumentIndex)) {
      ctx.addIssue({ code: "custom", path: ["tracks", index, "instrumentIndex"], message: "duplicate instrumentIndex" });
    }
    trackIds.add(track.trackId);
    instrumentIndexes.add(track.instrumentIndex);
  }
  const noteIds = new Set<string>();
  const sourceNoteOwners = new Map<string, string>();
  const tracksById = new Map(song.tracks.map((track) => [track.trackId, track]));
  for (const [index, note] of song.notes.entries()) {
    if (noteIds.has(note.noteId)) {
      ctx.addIssue({ code: "custom", path: ["notes", index, "noteId"], message: "duplicate noteId" });
    }
    const sourceIdsOnNote = new Set<string>();
    for (const [sourceIndex, sourceNoteId] of (note.sourceNoteIds ?? []).entries()) {
      if (sourceIdsOnNote.has(sourceNoteId) || sourceNoteOwners.has(sourceNoteId)) {
        ctx.addIssue({ code: "custom", path: ["notes", index, "sourceNoteIds", sourceIndex], message: "sourceNoteId must identify exactly one normalized note" });
      }
      sourceIdsOnNote.add(sourceNoteId);
      sourceNoteOwners.set(sourceNoteId, note.noteId);
    }
    const track = tracksById.get(note.trackId);
    if (!track) {
      ctx.addIssue({ code: "custom", path: ["notes", index, "trackId"], message: "unknown trackId" });
    }
    if (track && note.sourceEvent && track.sourceMidiTrackIndex !== undefined &&
        track.sourceMidiTrackIndex !== note.sourceEvent.midiTrackIndex) {
      ctx.addIssue({ code: "custom", path: ["notes", index, "sourceEvent", "midiTrackIndex"], message: "does not match the referenced track mapping" });
    }
    if (track && note.sourceEvent && track.channel !== undefined && track.channel !== note.sourceEvent.channel) {
      ctx.addIssue({ code: "custom", path: ["notes", index, "sourceEvent", "channel"], message: "does not match the referenced track channel" });
    }
    if (note.endSeconds > song.durationSeconds) {
      ctx.addIssue({ code: "custom", path: ["notes", index, "endSeconds"], message: "exceeds song duration" });
    }
    noteIds.add(note.noteId);
  }
  for (const key of ["tempoMap", "pedalControls"] as const) {
    const events = song[key];
    for (let i = 1; i < events.length; i += 1) {
      const prior = events[i - 1]!;
      const current = events[i]!;
      if (prior.timeSeconds > current.timeSeconds ||
          (prior.timeSeconds === current.timeSeconds && prior.eventOrdinal > current.eventOrdinal)) {
        ctx.addIssue({ code: "custom", path: [key, i], message: "events must be ordered by timeSeconds, then eventOrdinal" });
      }
    }
  }
});
export type SongDocument = z.infer<typeof SongDocumentSchema>;

export const PracticeLoopSchema = object({
  startSeconds: sourceTime,
  endSeconds: sourceTime,
  enabled: z.boolean(),
}).superRefine((loop, ctx) => {
  if (loop.endSeconds - loop.startSeconds < PRACTICE_MIN_LOOP_SECONDS - 1e-9) {
    ctx.addIssue({ code: "custom", path: ["endSeconds"], message: "must be at least 0.1 seconds after startSeconds" });
  }
});
export type PracticeLoop = z.infer<typeof PracticeLoopSchema>;

const PracticeBookmarkSchema = object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  timeSeconds: sourceTime,
});

export const PracticeStateSchema = object({
  schemaVersion: z.literal(1),
  sourceMidiSha256: z.string().regex(/^[a-f0-9]{64}$/),
  loop: PracticeLoopSchema.nullable(),
  bookmarks: z.array(PracticeBookmarkSchema),
}).superRefine((practice, ctx) => {
  const ids = new Set<string>();
  for (const [index, bookmark] of practice.bookmarks.entries()) {
    if (ids.has(bookmark.id)) {
      ctx.addIssue({ code: "custom", path: ["bookmarks", index, "id"], message: "bookmark IDs must be unique" });
    }
    ids.add(bookmark.id);
  }
});
export type PracticeState = z.infer<typeof PracticeStateSchema>;

/** Validates practice metadata against the exact source and duration of a project. */
export function validatePracticeStateForProject(
  input: unknown,
  document: SongDocument,
  sourceResource: ResourceDescriptor,
): PracticeState {
  const practice = PracticeStateSchema.parse(input);
  if (sourceResource.purpose !== "source-midi") {
    throw new Error("Practice state must reference a source MIDI resource.");
  }
  if (document.sourceMidiResourceId && sourceResource.resourceId !== document.sourceMidiResourceId) {
    throw new Error("Practice state source resource does not match the project source MIDI resource ID.");
  }
  if (practice.sourceMidiSha256 !== sourceResource.sha256) {
    throw new Error("Practice state source SHA-256 does not match the project source MIDI resource.");
  }
  if (practice.loop && practice.loop.endSeconds > document.durationSeconds) {
    throw new Error("Practice loop endSeconds exceeds the project song duration.");
  }
  for (const [index, bookmark] of practice.bookmarks.entries()) {
    if (bookmark.timeSeconds > document.durationSeconds) {
      throw new Error(`Practice bookmark ${index + 1} exceeds the project song duration.`);
    }
  }
  return practice;
}

const recordOfFinite = z.record(z.string(), finite);
const profileBehaviorValue = z.union([finite, z.string(), z.boolean()]);
export const PianistProfileSchema = object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  profileId: id,
  revision: z.number().int().nonnegative(),
  name: z.string().min(1),
  colorRgb: z.tuple([
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
  ]),
  anatomy: recordOfFinite,
  behavior: z.record(z.string(), profileBehaviorValue),
  skin: z.record(z.string(), JsonValueSchema),
  weights: z.record(z.string(), finite.min(0)),
  createdAtUnixSeconds: finite.nonnegative(),
  modifiedAtUnixSeconds: finite.nonnegative(),
}).superRefine((profile, ctx) => {
  if (profile.modifiedAtUnixSeconds < profile.createdAtUnixSeconds) {
    ctx.addIssue({ code: "custom", path: ["modifiedAtUnixSeconds"], message: "must not precede creation" });
  }
  for (const [key, value] of Object.entries(profile.anatomy)) {
    if (value <= 0) ctx.addIssue({ code: "custom", path: ["anatomy", key], message: "must be positive" });
  }
});
export type PianistProfile = z.infer<typeof PianistProfileSchema>;

export const PlanDiagnosticSchema = object({
  severity: z.enum(["info", "warning", "error"]),
  code: id,
  message: z.string(),
  noteIds: z.array(id).optional(),
});
export type PlanDiagnostic = z.infer<typeof PlanDiagnosticSchema>;

const PlanBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  planId: id,
  projectId: id,
  inputRevision: z.number().int().nonnegative(),
  profileId: id,
  profileRevision: z.number().int().nonnegative(),
  engineVersion: id,
  diagnostics: z.array(PlanDiagnosticSchema),
};

export const FingeringAssignmentSchema = object({
  noteId: id,
  hand: z.enum(["left", "right"]),
  finger: z.number().int().min(1).max(5).nullable(),
  /** Explicit editor finger intent. Missing preserves the source document field. */
  fingerMode: z.enum(["manual", "automatic"]).optional(),
  /** Explicit editor gliss toggle. Missing preserves source MIDI/document intent. */
  glissMode: z.enum(["manual", "automatic"]).optional(),
  disposition: z.enum(["played", "glissando", "unplayable"]),
}).superRefine((assignment, ctx) => {
  if ((assignment.disposition === "played") !== (assignment.finger !== null)) {
    ctx.addIssue({ code: "custom", path: ["finger"], message: "played assignments need a finger; other dispositions need null" });
  }
});
export type FingeringAssignment = z.infer<typeof FingeringAssignmentSchema>;

export const FingeringPlanSchema = object({
  ...PlanBaseShape,
  kind: z.literal("fingering"),
  assignments: z.array(FingeringAssignmentSchema),
}).superRefine((plan, ctx) => {
  uniqueReferences(plan.assignments.map((assignment) => assignment.noteId), "assignments", ctx);
});
export type FingeringPlan = z.infer<typeof FingeringPlanSchema>;

export const EVENT_PRIORITY = { release: 0, pedal: 1, press: 2 } as const;
export type PerformanceEventType = keyof typeof EVENT_PRIORITY;
export const PerformanceEventSchema = z.discriminatedUnion("type", [
  object({ type: z.literal("release"), timeSeconds: sourceTime, noteId: id }),
  object({ type: z.literal("pedal"), timeSeconds: sourceTime, controller: z.union([z.literal(64), z.literal(66), z.literal(67)]), value: z.union([z.literal(0), z.literal(127)]) }),
  object({ type: z.literal("press"), timeSeconds: sourceTime, noteId: id, pitch: z.number().int().min(21).max(108), velocity: z.number().int().min(1).max(127) }),
]);
export type PerformanceEvent = z.infer<typeof PerformanceEventSchema>;

export const PerformancePlanSchema = object({
  ...PlanBaseShape,
  kind: z.literal("performance"),
  fingeringPlanId: id,
  events: z.array(PerformanceEventSchema),
}).superRefine((plan, ctx) => {
  const presses = new Map<string, number>();
  const releases = new Map<string, number>();
  for (let i = 0; i < plan.events.length; i += 1) {
    const event = plan.events[i]!;
    if (i > 0 && compareEvents(plan.events[i - 1]!, event) > 0) {
      ctx.addIssue({ code: "custom", path: ["events", i], message: "events must be ordered by time, then release → pedal → press priority" });
    }
    if (event.type === "press") presses.set(event.noteId, (presses.get(event.noteId) ?? 0) + 1);
    if (event.type === "release") releases.set(event.noteId, (releases.get(event.noteId) ?? 0) + 1);
  }
  for (const noteId of new Set([...presses.keys(), ...releases.keys()])) {
    const pressCount = presses.get(noteId) ?? 0;
    const releaseCount = releases.get(noteId) ?? 0;
    if (pressCount !== 1 || releaseCount !== 1) {
      ctx.addIssue({ code: "custom", path: ["events"], message: `note ${noteId} must have exactly one press and one release` });
    }
  }
  const pressTime = new Map(plan.events.filter((event) => event.type === "press").map((event) => [event.noteId, event.timeSeconds]));
  for (const [index, event] of plan.events.entries()) {
    if (event.type === "release" && pressTime.has(event.noteId) && event.timeSeconds <= pressTime.get(event.noteId)!) {
      ctx.addIssue({ code: "custom", path: ["events", index, "timeSeconds"], message: "release must follow its press" });
    }
  }
});
export type PerformancePlan = z.infer<typeof PerformancePlanSchema>;

const vector3 = z.tuple([finite, finite, finite]);
const BoneSegmentSchema = object({
  a: vector3,
  b: vector3,
  kind: z.enum(["forearm", "carpal", "metacarpal", "proximal", "middle", "distal"]),
  boneId: id.optional(),
});
const JointPointSchema = object({
  point: vector3,
  kind: z.enum(["knuckle", "tip", "wrist"]),
});
export const MotionPoseSchema = object({
  transportTimeSeconds: TransportTimeSchema,
  hand: z.enum(["left", "right"]),
  // Whole-hand drawing layer from arrange_crossing. Both hands may share a
  // layer when no crossing lift is active; larger values draw above smaller.
  // Array order retains the desktop skeleton's within-hand bone layering.
  layerOrder: z.number().int(),
  bones: z.array(BoneSegmentSchema).min(1),
  joints: z.array(JointPointSchema).min(1),
});
export type MotionPose = z.infer<typeof MotionPoseSchema>;

export const MotionPlanSchema = object({
  ...PlanBaseShape,
  kind: z.literal("motion"),
  performancePlanId: id,
  coordinateFrame: z.literal("keyboard-local-inches-v1"),
  poses: z.array(MotionPoseSchema).min(1),
}).superRefine((plan, ctx) => {
  let previous: MotionPose | undefined;
  const keys = new Set<string>();
  for (const [index, pose] of plan.poses.entries()) {
    const key = `${pose.transportTimeSeconds}:${pose.hand}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: ["poses", index], message: "duplicate hand pose at the same time" });
    keys.add(key);
    if (previous && comparePoses(previous, pose) > 0) {
      ctx.addIssue({ code: "custom", path: ["poses", index], message: "poses must be ordered by time, then left before right" });
    }
    previous = pose;
  }
});
export type MotionPlan = z.infer<typeof MotionPlanSchema>;

export const ProjectSourceContextSchema = object({
  fixtureId: id,
  keyStyle: z.enum(["realistic", "equal"]),
});
export type ProjectSourceContext = z.infer<typeof ProjectSourceContextSchema>;

const projectPackageFields = {
  projectId: id,
  document: SongDocumentSchema,
  profiles: z.array(PianistProfileSchema),
  activeProfileId: id.optional(),
  resources: z.array(ResourceDescriptorSchema),
  resourcePayloads: z.record(
    z.string().min(1).refine((value) => {
      const parts = value.replaceAll("\\", "/").split("/");
      return !value.startsWith("/") && !/^[a-z]:/i.test(value) &&
        parts.every((part) => part !== "" && part !== "." && part !== "..");
    }, "must be a safe package-relative path"),
    z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "must be standard base64"),
  ).optional(),
  fingeringPlan: FingeringPlanSchema.nullable().optional(),
  performancePlan: PerformancePlanSchema.nullable().optional(),
  motionPlan: MotionPlanSchema.nullable().optional(),
  practiceState: PracticeStateSchema.optional(),
};
type ProjectPackageFields = z.infer<ReturnType<typeof object<typeof projectPackageFields>>>;

function refineProjectPackage(pkg: ProjectPackageFields, ctx: z.RefinementCtx): void {
  if (pkg.document.projectId !== pkg.projectId) {
    ctx.addIssue({ code: "custom", path: ["document", "projectId"], message: "does not match package projectId" });
  }
  uniqueReferences(pkg.profiles.map((profile) => profile.profileId), "profiles", ctx);
  uniqueReferences(pkg.resources.map((resource) => resource.resourceId), "resources", ctx);
  uniqueReferences(pkg.resources.map((resource) => resource.path), "resources.paths", ctx);
  const profileById = new Map(pkg.profiles.map((profile) => [profile.profileId, profile]));
  if (pkg.activeProfileId && !profileById.has(pkg.activeProfileId)) {
    ctx.addIssue({ code: "custom", path: ["activeProfileId"], message: "must reference a packaged profile" });
  }
  if (pkg.document.sourceMidiResourceId) {
    const source = pkg.resources.find((resource) => resource.resourceId === pkg.document.sourceMidiResourceId);
    if (!source || source.purpose !== "source-midi") {
      ctx.addIssue({ code: "custom", path: ["document", "sourceMidiResourceId"], message: "must reference a source-midi resource in this package" });
    }
  }
  if (pkg.practiceState) {
    const sourceResource = pkg.document.sourceMidiResourceId
      ? pkg.resources.find((resource) => resource.resourceId === pkg.document.sourceMidiResourceId)
      : pkg.resources.find((resource) => resource.purpose === "source-midi");
    if (!sourceResource) {
      ctx.addIssue({ code: "custom", path: ["practiceState"], message: "requires a source MIDI resource in this package" });
    } else {
      try {
        validatePracticeStateForProject(pkg.practiceState, pkg.document, sourceResource);
      } catch (error) {
        ctx.addIssue({ code: "custom", path: ["practiceState"], message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const payloadPaths = new Set(Object.keys(pkg.resourcePayloads ?? {}));
  for (const resource of pkg.resources) {
    if (!payloadPaths.has(resource.path)) {
      ctx.addIssue({ code: "custom", path: ["resourcePayloads", resource.path], message: "every declared resource must have a packaged payload" });
    }
  }
  for (const path of payloadPaths) {
    if (!pkg.resources.some((resource) => resource.path === path)) {
      ctx.addIssue({ code: "custom", path: ["resourcePayloads", path], message: "payload path must reference a declared resource" });
    }
  }
  const plans = [
    ["fingeringPlan", pkg.fingeringPlan],
    ["performancePlan", pkg.performancePlan],
    ["motionPlan", pkg.motionPlan],
  ] as const;
  let planProfile: PianistProfile | undefined;
  let engineVersion: string | undefined;
  for (const [name, plan] of plans) {
    if (!plan) continue;
    if (plan.projectId !== pkg.projectId || plan.inputRevision !== pkg.document.revision) {
      ctx.addIssue({ code: "custom", path: [name], message: "plan project/revision must match the packaged document" });
    }
    if (engineVersion !== undefined && plan.engineVersion !== engineVersion) {
      ctx.addIssue({ code: "custom", path: [name, "engineVersion"], message: "all packaged plans must use the same engine version" });
    }
    engineVersion ??= plan.engineVersion;
    const profile = profileById.get(plan.profileId);
    if (!profile || profile.revision !== plan.profileRevision) {
      ctx.addIssue({ code: "custom", path: [name, "profileId"], message: "plan profile identity/revision must resolve in packaged profiles" });
    } else if (planProfile && (planProfile.profileId !== profile.profileId || planProfile.revision !== profile.revision)) {
      ctx.addIssue({ code: "custom", path: [name, "profileId"], message: "all packaged plans must use the same profile revision" });
    } else {
      planProfile = profile;
    }
  }
  if (pkg.fingeringPlan) {
    const checked = fingeringPlanForSong(pkg.document).safeParse(pkg.fingeringPlan);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: "custom", path: ["fingeringPlan", ...issue.path], message: issue.message });
      }
    }
  }
  if (pkg.performancePlan && !pkg.fingeringPlan) {
    ctx.addIssue({ code: "custom", path: ["performancePlan"], message: "requires the packaged fingering plan" });
  } else if (pkg.performancePlan && pkg.fingeringPlan) {
    const checked = performancePlanForSong(pkg.document).safeParse(pkg.performancePlan);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: "custom", path: ["performancePlan", ...issue.path], message: issue.message });
      }
    }
    if (pkg.performancePlan.fingeringPlanId !== pkg.fingeringPlan.planId) {
      ctx.addIssue({ code: "custom", path: ["performancePlan", "fingeringPlanId"], message: "must reference the packaged fingering plan" });
    }
  }
  if (pkg.motionPlan && (!pkg.performancePlan || !pkg.fingeringPlan)) {
    ctx.addIssue({ code: "custom", path: ["motionPlan"], message: "requires the packaged fingering and performance plans" });
  } else if (pkg.motionPlan && pkg.performancePlan && pkg.fingeringPlan) {
    const checked = MotionPlanSchema.safeParse(pkg.motionPlan);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: "custom", path: ["motionPlan", ...issue.path], message: issue.message });
      }
    }
    if (pkg.motionPlan.performancePlanId !== pkg.performancePlan.planId) {
      ctx.addIssue({ code: "custom", path: ["motionPlan", "performancePlanId"], message: "must reference the packaged performance plan" });
    }
  }
  if (planProfile && pkg.activeProfileId && pkg.activeProfileId !== planProfile.profileId) {
    ctx.addIssue({ code: "custom", path: ["activeProfileId"], message: "must match the profile used by the packaged plans" });
  }
}

export const ProjectPackageV1Schema = object({
  packageVersion: z.literal(1),
  ...projectPackageFields,
}).superRefine(refineProjectPackage);
export type ProjectPackageV1 = z.infer<typeof ProjectPackageV1Schema>;

export const ProjectPackageSchema = object({
  packageVersion: z.literal(PACKAGE_VERSION),
  ...projectPackageFields,
  sourceContext: ProjectSourceContextSchema,
}).superRefine(refineProjectPackage);
export type ProjectPackage = z.infer<typeof ProjectPackageSchema>;

/** Recover the canonical source namespace from every persisted source ID. */
export function recoverLegacySourceContext(
  pkg: ProjectPackageV1,
  keyStyle?: ProjectSourceContext["keyStyle"],
): ProjectSourceContext | null {
  if (!keyStyle) return null;
  return inferProjectSourceContext(pkg.document, keyStyle);
}

export function inferProjectFixtureId(document: SongDocument): string | null {
  const notes = document.notes;
  if (notes.length === 0 || notes.some((note) => !note.sourceNoteIds?.length)) return null;
  const sourceIds = notes.flatMap((note) => note.sourceNoteIds ?? []);
  const prefixes = new Set<string>();
  const identityPattern = /^([A-Za-z0-9._-]+)\/instrument-(?:0|[1-9]\d*)\/note-\d{6}$/;
  for (const sourceId of sourceIds) {
    const match = identityPattern.exec(sourceId);
    if (!match) return null;
    prefixes.add(match[1]!);
  }
  if (prefixes.size !== 1) return null;
  return [...prefixes][0]!;
}

export function inferProjectSourceContext(
  document: SongDocument,
  keyStyle?: ProjectSourceContext["keyStyle"],
): ProjectSourceContext | null {
  if (!keyStyle) return null;
  const fixtureId = inferProjectFixtureId(document);
  if (!fixtureId) return null;
  return ProjectSourceContextSchema.parse({ fixtureId, keyStyle });
}

/** Explicitly migrate a validated v1 package to v2 source-context metadata. */
export function migrateProjectPackageV1(
  input: unknown,
  sourceContext?: ProjectSourceContext,
): ProjectPackage {
  const legacy = ProjectPackageV1Schema.parse(input);
  const context = sourceContext ?? recoverLegacySourceContext(legacy);
  if (!context) {
    if (!inferProjectFixtureId(legacy.document)) {
      throw new Error("Legacy package source identity is ambiguous; source context cannot be recovered safely.");
    }
    throw new Error("Legacy package has no saved keyboard geometry. Choose Realistic or Equal before opening it.");
  }
  return ProjectPackageSchema.parse({ ...legacy, packageVersion: PACKAGE_VERSION, sourceContext: context });
}

const RequestBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: id,
  projectId: id,
  inputRevision: z.number().int().nonnegative(),
  profileId: id,
  profileRevision: z.number().int().nonnegative(),
  engineVersion: id,
  document: SongDocumentSchema,
  profile: PianistProfileSchema,
  options: z.record(z.string(), JsonValueSchema),
};
const EngineRequestSchemaBase = { ...RequestBaseShape };
const RequestIdentityCheck = (
  request: {
    projectId: string; inputRevision: number; profileId: string; profileRevision: number;
    document: SongDocument; profile: PianistProfile;
  },
  ctx: z.RefinementCtx,
) => {
  if (request.projectId !== request.document.projectId || request.inputRevision !== request.document.revision) {
    ctx.addIssue({ code: "custom", path: ["document"], message: "document projectId/revision must match request" });
  }
  if (request.profileId !== request.profile.profileId || request.profileRevision !== request.profile.revision) {
    ctx.addIssue({ code: "custom", path: ["profile"], message: "profile id/revision must match request" });
  }
};
const EngineFingeringRequestSchema = object({ ...EngineRequestSchemaBase, operation: z.literal("fingering") })
  .superRefine((request, ctx) => RequestIdentityCheck(request, ctx));
const EnginePerformanceRequestSchema = object({
  ...EngineRequestSchemaBase, operation: z.literal("performance"), fingeringPlan: FingeringPlanSchema,
}).superRefine((request, ctx) => {
  RequestIdentityCheck(request, ctx);
  checkFingeringPlanForRequest(request.fingeringPlan, request.document, request.profile, request.engineVersion, ctx);
});
const EngineMotionRequestSchema = object({
  ...EngineRequestSchemaBase,
  operation: z.literal("motion"),
  fingeringPlan: FingeringPlanSchema,
  performancePlan: PerformancePlanSchema,
}).superRefine((request, ctx) => {
  RequestIdentityCheck(request, ctx);
  checkFingeringPlanForRequest(request.fingeringPlan, request.document, request.profile, request.engineVersion, ctx);
  checkPerformancePlanForRequest(request.performancePlan, request.document, request.fingeringPlan, request.profile, request.engineVersion, ctx);
});
export const EngineRequestSchema = z.discriminatedUnion("operation", [
  EngineFingeringRequestSchema,
  EnginePerformanceRequestSchema,
  EngineMotionRequestSchema,
]);
export type EngineRequest = z.infer<typeof EngineRequestSchema>;

export const EngineErrorSchema = object({ code: id, message: z.string(), retryable: z.boolean(), stack: z.string().max(8_000).optional() });
const EngineSuccessResponseSchema = z.discriminatedUnion("operation", [
  object({
    schemaVersion: z.literal(SCHEMA_VERSION), ok: z.literal(true), requestId: id,
    operation: z.literal("fingering"), projectId: id, inputRevision: z.number().int().nonnegative(),
    profileId: id, profileRevision: z.number().int().nonnegative(), engineVersion: id,
    result: FingeringPlanSchema,
  }).superRefine((response, ctx) => validateResponseArtifact(response, response.result, ctx)),
  object({
    schemaVersion: z.literal(SCHEMA_VERSION), ok: z.literal(true), requestId: id,
    operation: z.literal("performance"), projectId: id, inputRevision: z.number().int().nonnegative(),
    profileId: id, profileRevision: z.number().int().nonnegative(), engineVersion: id,
    result: PerformancePlanSchema,
  }).superRefine((response, ctx) => validateResponseArtifact(response, response.result, ctx)),
  object({
    schemaVersion: z.literal(SCHEMA_VERSION), ok: z.literal(true), requestId: id,
    operation: z.literal("motion"), projectId: id, inputRevision: z.number().int().nonnegative(),
    profileId: id, profileRevision: z.number().int().nonnegative(), engineVersion: id,
    result: MotionPlanSchema,
  }).superRefine((response, ctx) => validateResponseArtifact(response, response.result, ctx)),
]);
const EngineFailureResponseSchema = object({
    schemaVersion: z.literal(SCHEMA_VERSION), ok: z.literal(false), requestId: id,
    operation: z.enum(["fingering", "performance", "motion"]), projectId: id,
    inputRevision: z.number().int().nonnegative(), profileId: id,
    profileRevision: z.number().int().nonnegative(), engineVersion: id,
    error: EngineErrorSchema,
});
export const EngineResponseSchema = z.union([EngineSuccessResponseSchema, EngineFailureResponseSchema]);
export type EngineResponse = z.infer<typeof EngineResponseSchema>;

// M1's binary analysis protocol is intentionally separate from the M0 JSON
// EngineRequest/EngineResponse API. MIDI bytes cross the Worker boundary as a
// transferable ArrayBuffer, while only normalized documents and plans are DTOs.
export const M1_ENGINE_PROTOCOL_VERSION = 1 as const;
export const M1EngineVersionSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be the packaged adapted-core manifest SHA-256");
const M1IdentityShape = {
  requestId: id,
  projectId: id,
  revision: z.number().int().nonnegative(),
  engineVersion: M1EngineVersionSchema,
};
export const M1ProtocolIdentitySchema = object(M1IdentityShape);
export type M1ProtocolIdentity = z.infer<typeof M1ProtocolIdentitySchema>;

export const M1KeyStyleSchema = z.enum(["realistic", "equal"]);
export type M1KeyStyle = z.infer<typeof M1KeyStyleSchema>;
export const M1KeyboardRectSchema = z.tuple([finite, finite, finite.positive(), finite.positive()]);
export type M1KeyboardRect = z.infer<typeof M1KeyboardRectSchema>;
export const M1AnalysisOptionsSchema = object({
  fixtureId: id.optional(),
  keyStyle: M1KeyStyleSchema.optional(),
  // [x, y, width, height], matching pygame.Rect and the immutable M0 baseline.
  keyboardRect: M1KeyboardRectSchema.optional(),
  sampleDense: z.boolean().optional(),
  sampleTimes: z.array(TransportTimeSchema).max(1_000).optional().superRefine((times, ctx) => {
    if (!times) return;
    for (let index = 1; index < times.length; index += 1) {
      if (times[index]! <= times[index - 1]!) {
        ctx.addIssue({ code: "custom", path: [index], message: "sample times must be unique and increasing" });
      }
    }
  }),
});
export type M1AnalysisOptions = z.infer<typeof M1AnalysisOptionsSchema>;

const ArrayBufferSchema = z.custom<ArrayBuffer>(
  (value): value is ArrayBuffer => typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer,
  "MIDI payload must be an ArrayBuffer transferred over the Worker boundary",
);
export const M1AnalyzeMidiRequestSchema = object({
  type: z.literal("analyze-midi"),
  ...M1IdentityShape,
  midiBytes: ArrayBufferSchema,
  profile: PianistProfileSchema.optional(),
  options: M1AnalysisOptionsSchema,
}).superRefine((request, ctx) => {
  if (request.profile && request.profile.profileId.trim().length === 0) {
    ctx.addIssue({ code: "custom", path: ["profile", "profileId"], message: "must identify the selected pianist profile" });
  }
});
export type M1AnalyzeMidiRequest = z.infer<typeof M1AnalyzeMidiRequestSchema>;

export const M1ReplanDocumentRequestSchema = object({
  type: z.literal("replan-document"),
  ...M1IdentityShape,
  midiBytes: ArrayBufferSchema,
  document: SongDocumentSchema,
  fingeringPlan: FingeringPlanSchema,
  profile: PianistProfileSchema,
  resource: ResourceDescriptorSchema,
  rawBaseline: M1RawBaselineSchema,
  options: object({
    fixtureId: id,
    keyStyle: M1KeyStyleSchema,
    keyboardRect: M1KeyboardRectSchema.optional(),
  }),
}).superRefine((request, ctx) => {
  if (request.document.projectId !== request.projectId || request.document.revision !== request.revision) {
    ctx.addIssue({ code: "custom", path: ["document"], message: "must match the request projectId/revision" });
  }
  if (request.fingeringPlan.projectId !== request.projectId || request.fingeringPlan.inputRevision !== request.revision) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan"], message: "must match the request projectId/revision" });
  }
  if (request.fingeringPlan.profileId !== request.profile.profileId ||
      request.fingeringPlan.profileRevision !== request.profile.revision) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan"], message: "must match the explicit request profile revision" });
  }
  if (request.fingeringPlan.engineVersion !== request.engineVersion) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan", "engineVersion"], message: "must match the request engineVersion" });
  }
  if (request.document.sourceMidiResourceId !== request.resource.resourceId ||
      request.resource.purpose !== "source-midi" || request.resource.mediaType !== "audio/midi" ||
      request.resource.path !== "resources/source.mid" || request.resource.byteLength !== request.midiBytes.byteLength) {
    ctx.addIssue({ code: "custom", path: ["resource"], message: "must describe the source bytes referenced by the document" });
  }
  if (request.rawBaseline.inputSha256 !== request.resource.sha256 ||
      request.rawBaseline.fixtureId !== request.options.fixtureId ||
      request.rawBaseline.status === "invalid-or-rejected") {
    ctx.addIssue({ code: "custom", path: ["rawBaseline"], message: "must be the successful baseline for this source resource and fixture" });
  }
  const planCheck = fingeringPlanForSong(request.document).safeParse(request.fingeringPlan);
  if (!planCheck.success) {
    for (const issue of planCheck.error.issues) {
      ctx.addIssue({ code: "custom", path: ["fingeringPlan", ...issue.path], message: issue.message });
    }
  }
  const documentNotes = new Map(request.document.notes.map((note) => [note.noteId, note]));
  for (const [index, assignment] of request.fingeringPlan.assignments.entries()) {
    const note = documentNotes.get(assignment.noteId);
    if (!note) continue;
    if (assignment.fingerMode === "manual" &&
        (assignment.disposition !== "played" || assignment.finger !== note.finger)) {
      ctx.addIssue({
        code: "custom", path: ["fingeringPlan", "assignments", index],
        message: "manual finger intent must match the document's pinned finger",
      });
    }
    if (assignment.fingerMode === "automatic" && note.finger !== null) {
      ctx.addIssue({
        code: "custom", path: ["document", "notes"],
        message: `automatic finger intent must clear the document finger for ${assignment.noteId}`,
      });
    }
    if (assignment.glissMode === "manual" &&
        (assignment.disposition === "glissando") !== note.glissando) {
      ctx.addIssue({
        code: "custom", path: ["fingeringPlan", "assignments", index],
        message: "manual gliss intent must match the document marker",
      });
    }
  }
});
export type M1ReplanDocumentRequest = z.infer<typeof M1ReplanDocumentRequestSchema>;

export const M1ExportMidiRequestSchema = object({
  type: z.literal("export-midi"),
  ...M1IdentityShape,
  midiBytes: ArrayBufferSchema,
  document: SongDocumentSchema,
  fingeringPlan: FingeringPlanSchema,
}).superRefine((request, ctx) => {
  if (request.document.projectId !== request.projectId) {
    ctx.addIssue({ code: "custom", path: ["document", "projectId"], message: "must match the request projectId" });
  }
  if (request.document.revision !== request.revision) {
    ctx.addIssue({ code: "custom", path: ["document", "revision"], message: "must match the request revision" });
  }
  if (request.fingeringPlan.projectId !== request.projectId) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan", "projectId"], message: "must match the request projectId" });
  }
  if (request.fingeringPlan.inputRevision !== request.revision) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan", "inputRevision"], message: "must match the request revision" });
  }
  if (request.fingeringPlan.engineVersion !== request.engineVersion) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan", "engineVersion"], message: "must match the request engineVersion" });
  }
  // Reuse the document-relative plan check: unknown/missing assignments,
  // hand/disposition consistency and the explicit glissando runs.
  const planCheck = fingeringPlanForSong(request.document).safeParse(request.fingeringPlan);
  if (!planCheck.success) {
    for (const issue of planCheck.error.issues) {
      ctx.addIssue({ code: "custom", path: ["fingeringPlan", ...issue.path], message: issue.message });
    }
  }
});
export type M1ExportMidiRequest = z.infer<typeof M1ExportMidiRequestSchema>;

export const M1ExportMidiDiagnosticSchema = object({
  code: z.literal("unmatched-document-note"),
  noteId: id,
  message: z.string().min(1),
});
export type M1ExportMidiDiagnostic = z.infer<typeof M1ExportMidiDiagnosticSchema>;

export const M1ExportMidiResultSchema = object({
  type: z.literal("export-midi-result"),
  ...M1IdentityShape,
  exportedBytes: ArrayBufferSchema,
  markedCount: z.number().int().nonnegative(),
  diagnostics: z.array(M1ExportMidiDiagnosticSchema),
});
export type M1ExportMidiResult = z.infer<typeof M1ExportMidiResultSchema>;

export const M1SampleMotionRequestSchema = object({
  type: z.literal("sample-motion"),
  ...M1IdentityShape,
  startTimeSeconds: sourceTime,
  endTimeSeconds: sourceTime,
  maxPoses: z.number().int().positive().max(500).default(200),
}).superRefine((req, ctx) => {
  if (req.endTimeSeconds <= req.startTimeSeconds) {
    ctx.addIssue({
      code: "custom",
      path: ["endTimeSeconds"],
      message: "endTimeSeconds must be greater than startTimeSeconds",
    });
  }
  if (req.endTimeSeconds - req.startTimeSeconds > 5) {
    ctx.addIssue({ code: "custom", path: ["endTimeSeconds"], message: "motion window must span at most five seconds" });
  }
});
export type M1SampleMotionRequest = z.infer<typeof M1SampleMotionRequestSchema>;

export const HandCoverageSchema = object({
  coveredStartTimeSeconds: TransportTimeSchema,
  coveredEndTimeSeconds: TransportTimeSchema,
  isComplete: z.boolean(),
  poseCount: z.number().int().nonnegative(),
});
export type HandCoverage = z.infer<typeof HandCoverageSchema>;

/** Runtime-only first playback window; portable musical packages remain v2. */
export const InitialMotionWindowSchema = object({
  startTimeSeconds: sourceTime,
  endTimeSeconds: sourceTime,
  poses: z.array(MotionPoseSchema).max(200),
  coverage: object({
    left: HandCoverageSchema.optional(),
    right: HandCoverageSchema.optional(),
  }),
  truncated: z.boolean(),
  continuationTimeSeconds: TransportTimeSchema.optional(),
}).superRefine((window, ctx) => {
  if (window.endTimeSeconds < window.startTimeSeconds || window.endTimeSeconds - window.startTimeSeconds > 4.000001) {
    ctx.addIssue({ code: "custom", path: ["endTimeSeconds"], message: "initial playback window must span at most four seconds" });
  }
});
export type InitialMotionWindow = z.infer<typeof InitialMotionWindowSchema>;

export const M1SampleMotionResultSchema = object({
  type: z.literal("sample-motion-result"),
  ...M1IdentityShape,
  startTimeSeconds: sourceTime,
  endTimeSeconds: sourceTime,
  poses: z.array(MotionPoseSchema).max(500),
  coverage: object({
    left: HandCoverageSchema.optional(),
    right: HandCoverageSchema.optional(),
  }).optional(),
  truncated: z.boolean().optional(),
  continuationTimeSeconds: TransportTimeSchema.optional(),
}).superRefine((result, ctx) => {
  if (result.endTimeSeconds <= result.startTimeSeconds || result.endTimeSeconds - result.startTimeSeconds > 5) {
    ctx.addIssue({ code: "custom", path: ["endTimeSeconds"], message: "motion result must span a positive window of at most five seconds" });
  }
});
export type M1SampleMotionResult = z.infer<typeof M1SampleMotionResultSchema>;

export const M1EngineLoadRequestSchema = object({ type: z.literal("engine-load"), ...M1IdentityShape });
export type M1EngineLoadRequest = z.infer<typeof M1EngineLoadRequestSchema>;
export const M1EngineStageSchema = z.enum(["load", "init", "compute"]);
export type M1EngineStage = z.infer<typeof M1EngineStageSchema>;
export const M1EngineProgressSchema = object({
  type: z.literal("progress"),
  ...M1IdentityShape,
  stage: M1EngineStageSchema,
  progress: finite.min(0).max(1).optional(),
  message: z.string().optional(),
});
export type M1EngineProgress = z.infer<typeof M1EngineProgressSchema>;
export const M1EngineLoadResultSchema = object({
  type: z.literal("engine-loaded"),
  ...M1IdentityShape,
  runtime: z.enum(["pyodide", "typescript"]),
  runtimeVersion: id,
  pythonVersion: id,
  packageVersions: z.record(id, id),
});
export type M1EngineLoadResult = z.infer<typeof M1EngineLoadResultSchema>;
export const M1EngineErrorSchema = object({
  type: z.literal("worker-error"),
  ...M1IdentityShape,
  stage: M1EngineStageSchema,
  error: EngineErrorSchema,
});
export type M1EngineError = z.infer<typeof M1EngineErrorSchema>;
export const M1EngineCancelledSchema = object({
  type: z.literal("cancelled"),
  ...M1IdentityShape,
  stage: M1EngineStageSchema.optional(),
  reason: z.string().optional(),
});
export type M1EngineCancelled = z.infer<typeof M1EngineCancelledSchema>;
export const M1EngineLifecycleSchema = z.union([
  M1EngineLoadRequestSchema,
  M1EngineProgressSchema,
  M1EngineLoadResultSchema,
  M1EngineErrorSchema,
  M1EngineCancelledSchema,
]);
export type M1EngineLifecycle = z.infer<typeof M1EngineLifecycleSchema>;

const M1AnalysisResultShape = {
  type: z.literal("analysis-result"),
  ...M1IdentityShape,
  status: z.enum(["loaded", "repaired", "invalid"]),
  profile: PianistProfileSchema,
  resource: ResourceDescriptorSchema,
  document: SongDocumentSchema.nullable(),
  fingeringPlan: FingeringPlanSchema.nullable(),
  performancePlan: PerformancePlanSchema.nullable(),
  motionPlan: MotionPlanSchema.nullable(),
  initialMotionWindow: InitialMotionWindowSchema.optional(),
  diagnostics: z.array(PlanDiagnosticSchema),
  rawBaseline: M1RawBaselineSchema,
};
export const M1AnalyzeMidiResultSchema = object(M1AnalysisResultShape).superRefine((result, ctx) => {
  if (result.resource.purpose !== "source-midi" || result.resource.mediaType !== "audio/midi") {
    ctx.addIssue({ code: "custom", path: ["resource"], message: "must describe the original source MIDI bytes" });
  }
  if (result.resource.sha256 !== result.rawBaseline.inputSha256) {
    ctx.addIssue({ code: "custom", path: ["resource", "sha256"], message: "must match the observed raw-baseline input hash" });
  }
  if (result.resource.path !== "resources/source.mid") {
    ctx.addIssue({ code: "custom", path: ["resource", "path"], message: "M1 source MIDI must use the canonical package resource path" });
  }
  if (result.rawBaseline.provenance && result.rawBaseline.provenance.engineVersion !== result.engineVersion) {
    ctx.addIssue({ code: "custom", path: ["rawBaseline", "provenance", "engineVersion"], message: "must match the packaged engineVersion envelope" });
  }
  const expectedRawStatus = result.status === "invalid" ? "invalid-or-rejected" : result.status;
  if (result.rawBaseline.status !== expectedRawStatus) {
    ctx.addIssue({ code: "custom", path: ["rawBaseline", "status"], message: "must preserve the matching desktop-observation status" });
  }
  const artifacts = [result.document, result.fingeringPlan, result.performancePlan];
  if (result.status === "invalid") {
    if (artifacts.some((artifact) => artifact !== null) || result.motionPlan !== null) {
      ctx.addIssue({ code: "custom", path: [], message: "invalid MIDI must not include normalized or derived artifacts" });
    }
    if (!result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      ctx.addIssue({ code: "custom", path: ["diagnostics"], message: "invalid MIDI must preserve an error diagnostic" });
    }
    if (!result.diagnostics.some((diagnostic) => diagnostic.code === "midi-load-failed" || diagnostic.code === "midi-analysis-failed")) {
      ctx.addIssue({ code: "custom", path: ["diagnostics"], message: "invalid MIDI must identify the failed loader or analysis phase" });
    }
    return;
  }
  if (artifacts.some((artifact) => artifact === null)) {
    ctx.addIssue({ code: "custom", path: [], message: "loaded/repaired MIDI needs a document, fingering plan, and performance plan" });
    return;
  }
  const document = result.document!;
  const fingeringPlan = result.fingeringPlan!;
  const performancePlan = result.performancePlan!;
  const fingeringCheck = fingeringPlanForSong(document).safeParse(fingeringPlan);
  if (!fingeringCheck.success) {
    for (const issue of fingeringCheck.error.issues) {
      ctx.addIssue({ code: "custom", path: ["fingeringPlan", ...issue.path], message: issue.message });
    }
  }
  const performanceCheck = performancePlanForSong(document).safeParse(performancePlan);
  if (!performanceCheck.success) {
    for (const issue of performanceCheck.error.issues) {
      ctx.addIssue({ code: "custom", path: ["performancePlan", ...issue.path], message: issue.message });
    }
  }
  if (performancePlan.fingeringPlanId !== fingeringPlan.planId) {
    ctx.addIssue({ code: "custom", path: ["performancePlan", "fingeringPlanId"], message: "must reference the returned fingering plan" });
  }
  const assignmentByNoteId = new Map(fingeringPlan.assignments.map((assignment) => [assignment.noteId, assignment]));
  const performedNoteIds = new Set(performancePlan.events.flatMap((event) => event.type === "pedal" ? [] : [event.noteId]));
  for (const assignment of fingeringPlan.assignments) {
    const performed = performedNoteIds.has(assignment.noteId);
    if ((assignment.disposition === "unplayable") === performed) {
      ctx.addIssue({ code: "custom", path: ["performancePlan", "events"], message: `performance disposition mismatch for note ${assignment.noteId}` });
    }
  }
  for (const [index, event] of performancePlan.events.entries()) {
    if (event.type !== "pedal" && !assignmentByNoteId.has(event.noteId)) {
      ctx.addIssue({ code: "custom", path: ["performancePlan", "events", index, "noteId"], message: "must reference a fingering assignment" });
    }
  }
  const profileId = result.profile.profileId;
  const profileRevision = result.profile.revision;
  for (const [name, plan] of [
    ["fingeringPlan", fingeringPlan],
    ["performancePlan", performancePlan],
    ...(result.motionPlan ? [["motionPlan", result.motionPlan] as const] : []),
  ] as const) {
    if (plan.projectId !== result.projectId || plan.inputRevision !== result.revision ||
        plan.engineVersion !== result.engineVersion || plan.profileId !== profileId || plan.profileRevision !== profileRevision) {
      ctx.addIssue({ code: "custom", path: [name], message: "plan identity, revision, profile, and engine must match the result envelope" });
    }
    for (const [diagnosticIndex, diagnostic] of plan.diagnostics.entries()) {
      for (const noteId of diagnostic.noteIds ?? []) {
        if (!document.notes.some((note) => note.noteId === noteId)) {
          ctx.addIssue({ code: "custom", path: [name, "diagnostics", diagnosticIndex], message: `unknown noteId ${noteId}` });
        }
      }
    }
  }
  if (result.motionPlan && result.motionPlan.performancePlanId !== performancePlan.planId) {
    ctx.addIssue({ code: "custom", path: ["motionPlan", "performancePlanId"], message: "must reference the returned performance plan" });
  }
  for (const [index, mapping] of result.rawBaseline.identityMappings.entries()) {
    if (mapping.status === "ambiguous" &&
        !result.diagnostics.some((diagnostic) => diagnostic.code === "source-event-ambiguous" || diagnostic.code === "source-identity-ambiguous")) {
      ctx.addIssue({ code: "custom", path: ["diagnostics"], message: `ambiguous source identity at mapping ${index} needs an explicit diagnostic` });
    }
  }
});
export type M1AnalyzeMidiResult = z.infer<typeof M1AnalyzeMidiResultSchema>;

export const M1ReplanDocumentResultSchema = object({
  ...M1AnalysisResultShape,
  type: z.literal("replan-document-result"),
  keyStyle: M1KeyStyleSchema,
}).superRefine((result, ctx) => {
  const analysisResult: Record<string, unknown> = { ...result };
  delete analysisResult.keyStyle;
  analysisResult.type = "analysis-result";
  const checked = M1AnalyzeMidiResultSchema.safeParse(analysisResult);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
});
export type M1ReplanDocumentResult = z.infer<typeof M1ReplanDocumentResultSchema>;

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && jsonValueEqual(leftRecord[key]!, rightRecord[key]!));
}

export function m1ReplanDocumentResultForRequest(request: M1ReplanDocumentRequest) {
  return M1ReplanDocumentResultSchema.superRefine((result, ctx) => {
    if (result.requestId !== request.requestId || result.projectId !== request.projectId ||
        result.revision !== request.revision || result.engineVersion !== request.engineVersion) {
      ctx.addIssue({ code: "custom", path: [], message: "replan identity/revision/engineVersion does not match the request" });
    }
    if (result.status === "invalid" || !result.document || !result.fingeringPlan || !result.performancePlan) {
      ctx.addIssue({ code: "custom", path: [], message: "a replan must return a valid document, fingering plan, and performance plan" });
      return;
    }
    if (result.keyStyle !== request.options.keyStyle) {
      ctx.addIssue({ code: "custom", path: ["keyStyle"], message: "must match the requested keyboard style" });
    }
    if (!jsonValueEqual(result.document, request.document)) {
      ctx.addIssue({ code: "custom", path: ["document"], message: "must preserve the edited document and all stable source identities" });
    }
    if (!jsonValueEqual(result.resource, request.resource)) {
      ctx.addIssue({ code: "custom", path: ["resource"], message: "must preserve the original source resource descriptor" });
    }
    if (!jsonValueEqual(result.rawBaseline, request.rawBaseline)) {
      ctx.addIssue({ code: "custom", path: ["rawBaseline"], message: "must preserve the original source observation baseline" });
    }
    if (!jsonValueEqual(result.profile, request.profile)) {
      ctx.addIssue({ code: "custom", path: ["profile"], message: "must echo the explicit request profile" });
    }
    if (result.status !== request.rawBaseline.status) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "must retain the source MIDI load status" });
    }
    const requestAssignments = new Map(request.fingeringPlan.assignments.map((assignment) => [assignment.noteId, assignment]));
    const resultAssignments = new Map(result.fingeringPlan.assignments.map((assignment) => [assignment.noteId, assignment]));
    const documentNotes = new Map(request.document.notes.map((note) => [note.noteId, note]));
    for (const [noteId, requestAssignment] of requestAssignments) {
      const resultAssignment = resultAssignments.get(noteId);
      if (!resultAssignment) continue;
      for (const intentKey of ["fingerMode", "glissMode"] as const) {
        if (requestAssignment[intentKey] !== undefined && resultAssignment[intentKey] !== requestAssignment[intentKey]) {
          ctx.addIssue({
            code: "custom", path: ["fingeringPlan", "assignments"],
            message: `must preserve ${intentKey} for ${noteId}`,
          });
        }
      }
      if (requestAssignment.fingerMode === "manual" &&
          (resultAssignment.disposition !== "played" || resultAssignment.finger !== requestAssignment.finger ||
           result.document.notes.find((note) => note.noteId === noteId)?.finger !== requestAssignment.finger)) {
        ctx.addIssue({
          code: "custom", path: ["fingeringPlan", "assignments"],
          message: `manual finger intent must remain pinned to ${requestAssignment.finger} for ${noteId}`,
        });
      }
      const note = documentNotes.get(noteId);
      if (requestAssignment.glissMode === "manual" && note &&
          (resultAssignment.disposition === "glissando") !== note.glissando) {
        ctx.addIssue({
          code: "custom", path: ["fingeringPlan", "assignments"],
          message: `manual gliss intent must be retained for ${noteId}`,
        });
      }
    }
  });
}

export function validateM1ReplanDocumentResultForRequest(
  request: M1ReplanDocumentRequest,
  response: unknown,
): M1ReplanDocumentResult {
  return m1ReplanDocumentResultForRequest(request).parse(response);
}

export function m1AnalyzeMidiResultForRequest(request: M1AnalyzeMidiRequest) {
  return M1AnalyzeMidiResultSchema.superRefine((result, ctx) => {
    if (result.requestId !== request.requestId || result.projectId !== request.projectId ||
        result.revision !== request.revision || result.engineVersion !== request.engineVersion) {
      ctx.addIssue({ code: "custom", path: [], message: "analysis identity/revision/engineVersion does not match the request" });
    }
    if (result.resource.byteLength !== request.midiBytes.byteLength) {
      ctx.addIssue({ code: "custom", path: ["resource", "byteLength"], message: "must match the transferred MIDI byte length" });
    }
    if (request.options.fixtureId && result.rawBaseline.fixtureId !== request.options.fixtureId) {
      ctx.addIssue({ code: "custom", path: ["rawBaseline", "fixtureId"], message: "must match the requested fixtureId" });
    }
    if (request.profile) {
      if (result.profile.profileId !== request.profile.profileId || result.profile.revision !== request.profile.revision) {
        ctx.addIssue({ code: "custom", path: ["profile"], message: "resolved profile identity/revision must match the requested profile" });
      }
    } else if (result.profile.profileId !== "default" || result.profile.revision !== 0) {
      ctx.addIssue({ code: "custom", path: ["profile"], message: "omitted profile must resolve to default/revision 0" });
    }
    if (result.document && (result.document.projectId !== request.projectId || result.document.revision !== request.revision)) {
      ctx.addIssue({ code: "custom", path: ["document"], message: "must match the request projectId/revision" });
    }
    if (result.document?.sourceMidiResourceId && result.document.sourceMidiResourceId !== result.resource.resourceId) {
      ctx.addIssue({ code: "custom", path: ["document", "sourceMidiResourceId"], message: "must reference the returned source MIDI resource" });
    }
    if (result.rawBaseline.identityMappings.length !== result.rawBaseline.sourceNotes.length) {
      ctx.addIssue({ code: "custom", path: ["rawBaseline", "identityMappings"], message: "must account for every decoded source note" });
    }
    if (result.document) {
      const normalizedIds = new Set(result.document.notes.map((note) => note.noteId));
      for (const [index, mapping] of result.rawBaseline.identityMappings.entries()) {
        if (mapping.normalizedNoteId && !normalizedIds.has(mapping.normalizedNoteId)) {
          ctx.addIssue({ code: "custom", path: ["rawBaseline", "identityMappings", index, "normalizedNoteId"], message: "must reference a returned normalized note" });
        }
      }
    }
  });
}

export function validateM1AnalyzeMidiResultForRequest(
  request: M1AnalyzeMidiRequest,
  response: unknown,
): M1AnalyzeMidiResult {
  return m1AnalyzeMidiResultForRequest(request).parse(response);
}

export const M1EngineMessageSchema = z.union([
  M1AnalyzeMidiRequestSchema,
  M1AnalyzeMidiResultSchema,
  M1ReplanDocumentRequestSchema,
  M1ReplanDocumentResultSchema,
  M1ExportMidiRequestSchema,
  M1ExportMidiResultSchema,
  M1SampleMotionRequestSchema,
  M1SampleMotionResultSchema,
  M1EngineLifecycleSchema,
]);
export type M1EngineMessage = z.infer<typeof M1EngineMessageSchema>;

export const ArtifactCacheKeySchema = object({
  projectId: id,
  inputRevision: z.number().int().nonnegative(),
  profileId: id,
  profileRevision: z.number().int().nonnegative(),
  engineVersion: id,
  operation: z.enum(["fingering", "performance", "motion"]),
  parameterDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArtifactCacheKey = z.infer<typeof ArtifactCacheKeySchema>;

export function performancePlanForSong(song: SongDocument) {
  return PerformancePlanSchema.superRefine((plan, ctx) => {
    checkPerformancePlanForSong(plan, song, ctx);
  });
}

export function fingeringPlanForSong(song: SongDocument) {
  return FingeringPlanSchema.superRefine((plan, ctx) => {
    checkFingeringPlanForSong(plan, song, ctx);
  });
}

function checkFingeringPlanForSong(
  plan: FingeringPlan,
  song: SongDocument,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): void {
  const noteById = new Map(song.notes.map((note) => [note.noteId, note]));
  const assignmentByNoteId = new Map(plan.assignments.map((assignment) => [assignment.noteId, assignment]));
  for (const [index, assignment] of plan.assignments.entries()) {
    const note = noteById.get(assignment.noteId);
    if (!note) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "assignments", index, "noteId"], message: "unknown noteId" });
    } else if (assignment.hand !== note.hand) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "assignments", index, "hand"], message: "must match the normalized source note hand" });
    }
  }
  for (const note of song.notes) {
    if (!assignmentByNoteId.has(note.noteId)) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "assignments"], message: `missing disposition for note ${note.noteId}` });
    }
  }
  for (const [index, diagnostic] of plan.diagnostics.entries()) {
    for (const noteId of diagnostic.noteIds ?? []) {
      if (!noteById.has(noteId)) {
        ctx.addIssue({ code: "custom", path: [...pathPrefix, "diagnostics", index], message: `unknown noteId ${noteId}` });
      }
    }
  }
  for (const hand of ["left", "right"] as const) {
    const marked = song.notes
      .filter((note) => note.hand === hand && note.glissando)
      .sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
    let run: Note[] = [];
    const requireExplicitRun = () => {
      if (run.length >= 2) {
        for (const note of run) {
          const assignment = assignmentByNoteId.get(note.noteId);
          if (assignment && assignment.disposition !== "glissando") {
            const index = plan.assignments.findIndex((candidate) => candidate.noteId === note.noteId);
            ctx.addIssue({
              code: "custom",
              path: [...pathPrefix, "assignments", index, "disposition"],
              message: "notes in an explicit marked glissando run must use the glissando disposition",
            });
          }
        }
      }
    };
    for (const note of marked) {
      if (run.length > 0 && note.startSeconds - run[run.length - 1]!.startSeconds > EXPLICIT_GLISSANDO_MAX_GAP_SECONDS) {
        requireExplicitRun();
        run = [];
      }
      run.push(note);
    }
    requireExplicitRun();
  }
  if (plan.projectId !== song.projectId || plan.inputRevision !== song.revision) {
    ctx.addIssue({ code: "custom", path: [...pathPrefix, "inputRevision"], message: "must match source song projectId/revision" });
  }
}

function checkPerformancePlanForSong(
  plan: PerformancePlan,
  song: SongDocument,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): void {
  const noteById = new Map(song.notes.map((note) => [note.noteId, note]));
  for (const [index, event] of plan.events.entries()) {
    if (event.type === "pedal") continue;
    const note = noteById.get(event.noteId);
    if (!note) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events", index, "noteId"], message: "unknown noteId" });
    } else if (event.type === "press" && event.pitch !== note.pitch) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events", index, "pitch"], message: "does not match source note pitch" });
    }
  }
  for (const [index, diagnostic] of plan.diagnostics.entries()) {
    for (const noteId of diagnostic.noteIds ?? []) {
      if (!noteById.has(noteId)) {
        ctx.addIssue({ code: "custom", path: [...pathPrefix, "diagnostics", index], message: `unknown noteId ${noteId}` });
      }
    }
  }
  if (plan.projectId !== song.projectId || plan.inputRevision !== song.revision) {
    ctx.addIssue({ code: "custom", path: [...pathPrefix, "inputRevision"], message: "must match source song projectId/revision" });
  }
  checkPedalSwitchSequence(plan, song, ctx, pathPrefix);
}

function checkPedalSwitchSequence(
  plan: PerformancePlan,
  song: SongDocument,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): void {
  const states = new Map<number, 0 | 127>();
  const expected = song.pedalControls.flatMap((control) => {
    const next: 0 | 127 = control.value >= 64 ? 127 : 0;
    const prior = states.get(control.controller) ?? 0;
    states.set(control.controller, next);
    return prior === next ? [] : [{ timeSeconds: control.timeSeconds, controller: control.controller, value: next }];
  });
  const actual = plan.events.flatMap((event, index) => event.type === "pedal" ? [{ event, index }] : []);
  if (actual.length !== expected.length) {
    ctx.addIssue({
      code: "custom",
      path: [...pathPrefix, "events"],
      message: "pedal events must exactly match source controls after thresholding at 64 and omitting unchanged states",
    });
  }
  for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
    const actualSwitch = actual[index]!.event;
    const expectedSwitch = expected[index]!;
    if (actualSwitch.type !== "pedal" || actualSwitch.timeSeconds !== expectedSwitch.timeSeconds ||
        actualSwitch.controller !== expectedSwitch.controller || actualSwitch.value !== expectedSwitch.value) {
      ctx.addIssue({
        code: "custom",
        path: [...pathPrefix, "events", actual[index]!.index],
        message: "pedal event does not match the ordered source switch sequence",
      });
    }
  }
}

function checkFingeringPlanForRequest(
  plan: FingeringPlan,
  song: SongDocument,
  profile: PianistProfile,
  engineVersion: string,
  ctx: z.RefinementCtx,
): void {
  checkFingeringPlanForSong(plan, song, ctx, ["fingeringPlan"]);
  if (plan.profileId !== profile.profileId || plan.profileRevision !== profile.revision) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan"], message: "fingering plan must match request profile id/revision" });
  }
  if (plan.engineVersion !== engineVersion) {
    ctx.addIssue({ code: "custom", path: ["fingeringPlan", "engineVersion"], message: "must match request engineVersion" });
  }
}

function checkPerformancePlanForRequest(
  plan: PerformancePlan,
  song: SongDocument,
  fingeringPlan: FingeringPlan,
  profile: PianistProfile,
  engineVersion: string,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = ["performancePlan"],
): void {
  checkPerformancePlanForSong(plan, song, ctx, pathPrefix);
  if (plan.fingeringPlanId !== fingeringPlan.planId) {
    ctx.addIssue({ code: "custom", path: [...pathPrefix, "fingeringPlanId"], message: "must reference the request fingering plan" });
  }
  if (plan.profileId !== profile.profileId || plan.profileRevision !== profile.revision ||
      plan.profileId !== fingeringPlan.profileId || plan.profileRevision !== fingeringPlan.profileRevision) {
    ctx.addIssue({ code: "custom", path: pathPrefix, message: "must match the request and fingering profile revision" });
  }
  if (plan.engineVersion !== engineVersion || plan.engineVersion !== fingeringPlan.engineVersion) {
    ctx.addIssue({ code: "custom", path: [...pathPrefix, "engineVersion"], message: "must match the request and fingering engineVersion" });
  }
  const assignmentByNoteId = new Map(fingeringPlan.assignments.map((assignment) => [assignment.noteId, assignment]));
  const performedNoteIds = new Set<string>();
  for (const [index, event] of plan.events.entries()) {
    if (event.type === "pedal") continue;
    performedNoteIds.add(event.noteId);
    const assignment = assignmentByNoteId.get(event.noteId);
    if (!assignment) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events", index, "noteId"], message: "has no fingering disposition" });
    } else if (assignment.disposition === "unplayable") {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events", index, "noteId"], message: "unplayable notes must not have performance events" });
    }
  }
  for (const assignment of fingeringPlan.assignments) {
    const isPerformed = performedNoteIds.has(assignment.noteId);
    if (assignment.disposition === "unplayable" && isPerformed) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events"], message: `unplayable note ${assignment.noteId} appears in the performance` });
    }
    if (assignment.disposition !== "unplayable" && !isPerformed) {
      ctx.addIssue({ code: "custom", path: [...pathPrefix, "events"], message: `playable note ${assignment.noteId} is missing from the performance` });
    }
  }
}

export function validatePerformancePlanReferences(plan: PerformancePlan, song: SongDocument): PerformancePlan {
  return performancePlanForSong(song).parse(plan);
}

export function validateFingeringPlanReferences(plan: FingeringPlan, song: SongDocument): FingeringPlan {
  return fingeringPlanForSong(song).parse(plan);
}

export function engineResponseForRequest(request: EngineRequest) {
  return EngineResponseSchema.superRefine((response, ctx) => {
    if (response.requestId !== request.requestId || response.operation !== request.operation ||
        response.projectId !== request.projectId || response.inputRevision !== request.inputRevision ||
        response.profileId !== request.profileId || response.profileRevision !== request.profileRevision ||
        response.engineVersion !== request.engineVersion) {
      ctx.addIssue({ code: "custom", path: [], message: "response envelope does not match the active request" });
    }
    if (!response.ok) return;
    if (response.operation === "fingering") {
      if (request.operation !== "fingering") {
        ctx.addIssue({ code: "custom", path: ["operation"], message: "fingering result was not requested" });
      } else {
        const result = fingeringPlanForSong(request.document).safeParse(response.result);
        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({ code: "custom", path: ["result", ...issue.path], message: issue.message });
          }
        }
      }
    }
    if (response.operation === "performance") {
      if (request.operation !== "performance" && request.operation !== "motion") {
        ctx.addIssue({ code: "custom", path: ["operation"], message: "performance result was not requested" });
      } else {
        checkPerformancePlanForRequest(
          response.result,
          request.document,
          request.fingeringPlan,
          request.profile,
          request.engineVersion,
          ctx,
          ["result"],
        );
      }
    }
    if (response.operation === "motion") {
      if (request.operation !== "motion") {
        ctx.addIssue({ code: "custom", path: ["operation"], message: "motion result was not requested" });
      } else if (response.result.performancePlanId !== request.performancePlan.planId) {
        ctx.addIssue({ code: "custom", path: ["result", "performancePlanId"], message: "must reference the active performance plan" });
      }
    }
  });
}

export function validateEngineResponseForRequest(request: EngineRequest, response: unknown): EngineResponse {
  return engineResponseForRequest(request).parse(response);
}

function uniqueReferences(values: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) ctx.addIssue({ code: "custom", path: [path, index], message: `duplicate ${path} reference` });
    seen.add(value);
  });
}

function eventRank(event: PerformanceEvent): number {
  return EVENT_PRIORITY[event.type];
}

function compareEvents(a: PerformanceEvent, b: PerformanceEvent): number {
  return a.timeSeconds - b.timeSeconds || eventRank(a) - eventRank(b);
}

function comparePoses(a: MotionPose, b: MotionPose): number {
  return a.transportTimeSeconds - b.transportTimeSeconds || (a.hand === b.hand ? 0 : a.hand === "left" ? -1 : 1);
}

function validateResponseArtifact(
  response: { projectId: string; inputRevision: number; profileId: string; profileRevision: number; engineVersion: string },
  artifact: { projectId: string; inputRevision: number; profileId: string; profileRevision: number; engineVersion: string },
  ctx: z.RefinementCtx,
): void {
  if (artifact.projectId !== response.projectId || artifact.inputRevision !== response.inputRevision || artifact.engineVersion !== response.engineVersion) {
    ctx.addIssue({ code: "custom", path: ["result"], message: "artifact identity/revision/engineVersion must match response envelope" });
  }
  if (artifact.profileId !== response.profileId || artifact.profileRevision !== response.profileRevision) {
    ctx.addIssue({ code: "custom", path: ["result"], message: "artifact profile identity/revision must match response envelope" });
  }
}
