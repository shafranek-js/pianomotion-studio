/**
 * @handthesia/engine-ts - Pure TypeScript calculation engine for Hand-thesia.
 *
 * Implements 1-to-1 feature parity with python-core/handthesia_core.
 */

export {
  analyze_midi,
  analyze_midi as analyzeMidi,
  replan_document,
  replan_document as replanDocument,
  sample_motion_window,
  sample_motion_window as sampleMotionWindow,
  export_fingered_midi,
  export_fingered_midi as exportFingeredMidi,
  set_progress_callback,
  set_progress_callback as setProgressCallback,
  _manifest,
  _engine_version,
} from "./api.ts";

export { HandAnimator } from "./hands.ts";
export {
  Pianist,
  default_pianist,
  default_pianist as defaultPianist,
  from_profile_dto,
  from_profile_dto as fromProfileDto,
  DEFAULT_ID,
} from "./pianist.ts";

export { KeyboardGeometry } from "./geometry.ts";
export { MidiSong, Note } from "./midiLoader.ts";
export { sha256 } from "./sha256.ts";

export * as api from "./api.ts";
export * as hands from "./hands.ts";
export * as fingering from "./fingering.ts";
export * as midiLoader from "./midiLoader.ts";
export * as handSplit from "./handSplit.ts";
export * as figures from "./figures.ts";
export * as glissando from "./glissando.ts";
export * as pianist from "./pianist.ts";
export * as geometry from "./geometry.ts";
export * as identity from "./identity.ts";
export * as pedalHold from "./pedalHold.ts";
export * as playability from "./playability.ts";
export {
  buildPedalSpans,
  pedalCarries,
  inferBassPedalGap,
  computePhysicalReleaseTimes,
  type PedalSpan,
  type PedalHoldNoteLike,
  type ComputeReleaseOptions,
} from "./pedalHold.ts";
export {
  checkPianoPlayability,
  repairPianoHandSplit,
  PIANO_MAX_NOTES,
  PIANO_REACH,
  PIANO_WIDE_REACH,
  JUMP_SEMITONES,
  JUMP_SECONDS,
  CROSS_SECONDS,
  type PlayabilityIssueKind,
  type PlayabilityIssue,
  type PlayabilitySummary,
  type PlayabilityNoteInput,
  type PianoPlayabilityOptions,
  type PianoRepairResult,
} from "./playability.ts";
