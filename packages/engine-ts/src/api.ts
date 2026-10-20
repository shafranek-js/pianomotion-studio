/**
 * api.ts - Synchronous, serializable API used by one Worker batch job.
 *
 * Ported 1-to-1 from python-core/handthesia_core/api.py.
 */

// @ts-nocheck
import { sha256 } from "./sha256.ts";
import { pyMod, pyRound, rounded, bisectLeft, bisectRight, pyGet, pyItems, pyValues, pyKeys, pyPop, pyClear, getattr, pyIn, pyIter, bool, ValueError, KeyError, IndexError, pySorted, pyRange, enumerate, pyNext, pySetDefault, pyUpdate, dict, type, zip, pyAugAdd, pyBitOr, pyBitAnd, pySetUnion, pyMin, pyMax, min, max, pyEq, pyNotEq, pyCmp, pyLen, len } from "./pythonCompat.ts";
import { KeyboardGeometry, NumericRect } from "./geometry.ts";
import * as pianist_module from "./pianist.ts";
import { default_pianist, from_profile_dto, DEFAULT_ID } from "./pianist.ts";
import * as hands from "./hands.ts";
import { build_hands, crossing_episodes, arrange_crossing, pyId } from "./hands.ts";
import * as midi_loader from "./midiLoader.ts";
import { Note, MidiSong, LOWEST_PIANO_KEY, save_fingered_midi_bytes, LEFT, RIGHT } from "./midiLoader.ts";
import * as identity from "./identity.ts";
import { observe_source } from "./identity.ts";
import * as fingering from "./fingering.ts";
import { reset_context } from "./fingering.ts";

const EMBEDDED_MANIFEST = {
  "schemaVersion": 1,
  "engineVersion": "cfb68636b58b2dd2b28eb4cfb7190f4ad539023e3925ee14fb632cb56e59f961",
  "entrypoint": "handthesia_core.api:analyze_midi",
  "replanEntrypoint": "handthesia_core.api:replan_document",
  "pythonPackages": [
    "pretty_midi",
    "mido",
    "numpy"
  ],
  "files": {
    "handthesia_core/__init__.py": "b717704c7b696ca09293395731d10d903b82772d691f5ef60028bcf4d4e67ac0",
    "handthesia_core/api.py": "e50548bc59a9fb6fb1fb1ce27088c7713b74dd0ce5a88528c6356cc9589c3f5a",
    "handthesia_core/figures.py": "0c89b85176c73f566528c692944e6c7192444f9c7134c13d5ec027063fb86fb9",
    "handthesia_core/fingering.py": "2140b2a5b81e4724fce03e99470edef9aff0c97f56fc6bff07c66aedf672c9ac",
    "handthesia_core/geometry.py": "df96013f715b51fb21ed95087259a1fe202dd7e828e6e09e4578172a43f3c5fd",
    "handthesia_core/glissando.py": "7c1a472b3edb380d222a06ca41def651bb84078ecaddcb6180ee4b0a2b772923",
    "handthesia_core/hand_split.py": "0e2dc047343befe0fa8b0384f81a19fe9ab944736a46dda62d4280eb2f4f4243",
    "handthesia_core/hands.py": "065239356c3a63565edf4d684294cfe9bfcb740b6572ffe577e1e736d565d800",
    "handthesia_core/identity.py": "a2bf6d82f09e2bea6610b29ad0d494931e64ee43744bfcbc8e6b20cfab694906",
    "handthesia_core/midi_loader.py": "883fe70d80f1af7baebddffafd78647947ebff6c810012ea798f6d3987b96359",
    "handthesia_core/pianist.py": "e80a4b4c4f2511e344d9b8ee8921f83442dac816ea53dfc8f5d2747e0f49cb19",
    "handthesia_core/progress.py": "e068d2edf6dbde6b51028259d6516594d86c277193e3bdca5b95f23e1c632d6a"
  },
  "desktopSourceCommit": "f8189c021d9235005fb35faa2c8cfbc09a3768a0",
  "desktopVersion": "v1.0.0"
}
;

// Synchronous, serializable API used by one Worker batch job.
export let SCHEMA_VERSION: any = 1;
export let _active_animator_sessions: any = {  };
export function _store_active_session(key: any = null, session_data: any = null): any {
  // Store active animator session, evicting previous sessions (A12).
  pyClear(_active_animator_sessions);
  _active_animator_sessions[key] = session_data;
}
export function _manifest(): any {
  return EMBEDDED_MANIFEST;
}
export function _engine_version(manifest: any = null): any {
  return (manifest || EMBEDDED_MANIFEST).engineVersion;
}
export function _rounded(value: any, digits: any = 8): any {
  let result: any;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw ValueError('Cannot serialize a non-finite engine coordinate or time');
  }
  result = pyRound(numeric, digits);
  return ((pyEq(result, 0)) ? 0.0 : result);
}
export function _finite(value: any = null, label: any = null): any {
  let number: any;
  number = Number(value);
  if (bool((!bool(Number.isFinite(number))))) {
    throw ValueError(`${label} must be finite`);
  }
  return number;
}
export let _global_progress_callback: any = null;
export function set_progress_callback(callback: any = null): any {
  _global_progress_callback = callback;
}
export function _report_progress(fraction: any = null, message: any = null): any {
  let cb: any;
  cb = _global_progress_callback;
  if ((cb !== null)) {
    try {
      cb(Number(fraction), String(message));
    } catch (_err: any) {
      ;
    }
  }
}
export function _default_profile_dto(): any {
  let p: any;
  p = pianist_module.default_pianist();
  return { ['schemaVersion']: SCHEMA_VERSION, ['profileId']: pianist_module.DEFAULT_ID, ['revision']: 0, ['name']: p.name, ['colorRgb']: [...p.color], ['anatomy']: { ...p.anatomy }, ['behavior']: { ...p.behavior }, ['skin']: { ...p.skin }, ['weights']: {  }, ['createdAtUnixSeconds']: 0.0, ['modifiedAtUnixSeconds']: 0.0 };
}
export function _resolve_profile(value: any = null): any {
  let context: any, missing: any, profile: any, required: any, resolved: any;
  profile = ((value === null) ? _default_profile_dto() : { ...value });
  required = ['schemaVersion', 'profileId', 'revision', 'name', 'colorRgb', 'anatomy', 'behavior', 'skin', 'weights', 'createdAtUnixSeconds', 'modifiedAtUnixSeconds'];
  missing = Array.from(pyIter(required)).filter((key: any) => ((!pyIn(key, profile)))).map((key: any) => key);
  if (bool(missing)) {
    throw ValueError(('profile DTO is missing: ' + missing.join(', ')));
  }
  if ((pyNotEq(profile['schemaVersion'], SCHEMA_VERSION))) {
    throw ValueError('unsupported profile schemaVersion');
  }
  if ((Math.trunc(profile['revision']) < 0)) {
    throw ValueError('profile revision must be nonnegative');
  }
  if ((bool((!bool(String(profile['profileId']).trim()))) ? ((!bool(String(profile['profileId']).trim()))) : ((!bool(String(profile['name']).trim()))))) {
    throw ValueError('profile identity and name must be nonempty');
  }
  resolved = { ['schemaVersion']: SCHEMA_VERSION, ['profileId']: String(profile['profileId']), ['revision']: Math.trunc(profile['revision']), ['name']: String(profile['name']), ['colorRgb']: Array.from(pyIter(profile['colorRgb'])).map((c: any) => Math.trunc(c)), ['anatomy']: Object.fromEntries(Array.from(pyIter(pyItems(profile['anatomy']))).map(([k, v]: any) => [String(k), _finite(v, `profile.anatomy.${k}`)])), ['behavior']: pianist_module.normalize_behavior(profile['behavior'], { strict: true }), ['skin']: { ...profile['skin'] }, ['weights']: Object.fromEntries(Array.from(pyIter(pyItems(profile['weights']))).map(([k, v]: any) => [String(k), _finite(v, `profile.weights.${k}`)])), ['createdAtUnixSeconds']: _finite(profile['createdAtUnixSeconds'], 'profile.createdAtUnixSeconds'), ['modifiedAtUnixSeconds']: _finite(profile['modifiedAtUnixSeconds'], 'profile.modifiedAtUnixSeconds') };
  context = pianist_module.from_profile_dto(resolved);
  return [resolved, context];
}
export function _empty_raw_baseline(fixture_id: any = null, input_hash: any = null, status: any = null, parse_errors: any = null, error: any = null): any {
  let result: any;
  result = { ['fixtureId']: fixture_id, ['inputSha256']: input_hash, ['status']: status, ['desktopNotes']: [], ['assignments']: [], ['performanceEvents']: [], ['pedals']: [], ['rawPedals']: [], ['selectedPoses']: [], ['cleanup']: [], ['sourceNotes']: [], ['sourcePedals']: [], ['sourceParseErrors']: parse_errors, ['unmappedSourceNoteIds']: [], ['tracks']: [], ['hands']: [], ['crossingEpisodes']: [], ['identityLosses']: [], ['identityMappings']: [], ['duration']: 0.0, ['goldenTrust']: 'observed-error; expected-invalid-fixture', ['sourceNoteIdentitySemantics']: 'IDs use instrument and note ordinals after PrettyMIDI decode. Raw SMF note-on/off locators are included only when the original message events were observed and uniquely matched.' };
  if ((error !== null)) {
    result['loadError'] = error;
  }
  return result;
}
export function _map_desktop_notes(source_notes: any = null, song_notes: any = null, fixture_id: any = null): any {
  let by_object: any, by_pitch_start: any, by_track_key: any, candidates: any, entry: any, key: any, matching: any, missing: any, note: any, note_index: any, output: any, primary: any, signature: any, source: any, source_id: any, source_ids: any, stable_id: any, used: any, used_decoded: any;
  // Mirror the baseline join while preserving decoded IDs as stable aliases.
  [by_track_key, by_pitch_start] = [{  }, {  }];
  for (source of pyIter(source_notes)) {
    pySetDefault(by_pitch_start, [source['pitch'], pyRound(source['start'], 5)], []).push(source);
    key = [source['sourceInstrument'], source['pitch'], pyRound(source['start'], 5), source['velocity']];
    pySetDefault(by_track_key, key, []).push(source);
  }
  [output, used, by_object] = [[], new Set(), {  }];
  used_decoded = new Set();
  for ([note_index, note] of pyIter(enumerate(song_notes))) {
    signature = [note.track, note.pitch, pyRound(note.start, 5), note.velocity];
    candidates = Array.from(pyIter(pyGet(by_track_key, signature, []))).filter((item: any) => ((!pyIn(item['noteId'], used)))).map((item: any) => item);
    if (bool((!bool(candidates)))) {
      candidates = Array.from(pyIter(source_notes)).filter((item: any) => (((pyEq(item['sourceInstrument'], note.track))) && ((Math.abs((item['start'] - note.start)) <= 0.005)) && (((!pyIn(item['noteId'], used)))))).map((item: any) => item);
    }
    if (bool((!bool(candidates)))) {
      candidates = Array.from(pyIter(source_notes)).filter((item: any) => (((Math.abs((item['start'] - note.start)) <= 0.005)) && (((!pyIn(item['noteId'], used)))))).map((item: any) => item);
    }
    candidates.sort((a: any, b: any) => { const ka = ((item) => [item['end'], (-item['sourceInstrument']), (-item['sourceOrdinal'])]) ? (((item) => [item['end'], (-item['sourceInstrument']), (-item['sourceOrdinal'])]))(a) : a; const kb = ((item) => [item['end'], (-item['sourceInstrument']), (-item['sourceOrdinal'])]) ? (((item) => [item['end'], (-item['sourceInstrument']), (-item['sourceOrdinal'])]))(b) : b; return ka < kb ? (true ? 1 : -1) : (ka > kb ? (true ? -1 : 1) : 0); });
    primary = (bool(candidates) ? candidates[0] : null);
    if (bool(primary)) {
      used.add(primary['noteId']);
    }
    matching = [...pyGet(by_pitch_start, [note.pitch, pyRound(note.start, 5)], [])];
    if (bool((!bool(matching)))) {
      matching = Array.from(pyIter(source_notes)).filter((item: any) => (((pyEq(item['pitch'], note.pitch))) && ((Math.abs((item['start'] - note.start)) <= 0.005)))).map((item: any) => item);
    }
    source_ids = Array.from(pyIter(matching)).map((item: any) => item['noteId']);
    if ((((!bool(source_ids))) && bool(note.source_ids))) {
      source_ids = [...note.source_ids];
    }
    pyUpdate(used, source_ids);
    stable_id = (bool(primary) ? primary['noteId'] : (bool(source_ids) ? source_ids[0] : `${fixture_id}/normalized/note-${note_index}`));
    entry = { ['noteId']: (bool(primary) ? primary['noteId'] : null), ['stableNoteId']: stable_id, ['sourceNoteIds']: source_ids, ['pitch']: Math.trunc(note.pitch), ['start']: _rounded(note.start), ['end']: _rounded(note.end), ['velocity']: Math.trunc(note.velocity), ['track']: Math.trunc(note.track), ['hand']: note.hand, ['manualFinger']: (bool((typeof note.finger === 'number' && Number.isInteger(note.finger))) ? Math.trunc(note.finger) : null), ['gliss']: bool(note.gliss) };
    output.push(entry);
    by_object[pyId(note)] = entry;
    for (source_id of pyIter(note.source_ids)) {
      used_decoded.add(source_id);
    }
  }
  missing = pySorted(Array.from(pyIter(source_notes)).filter((item: any) => ((!pyIn(item['noteId'], used)))).map((item: any) => item['noteId']), null, false);
  return [output, missing, by_object];
}
export function _profile_identity(profile: any = null, options: any = null, version: any = null): any {
  return { ['schemaVersion']: SCHEMA_VERSION, ['planId']: 'unused', ['projectId']: String(options['projectId']), ['inputRevision']: Math.trunc(options['revision']), ['profileId']: profile['profileId'], ['profileRevision']: profile['revision'], ['engineVersion']: version, ['diagnostics']: [] };
}
export function _serialize_pose(pose: any = null, hand_name: any = null, sample_time: any = null, rect: any = null): any {
  let struct: any;
  struct = pose['struct'];
  return { ['hand']: hand_name, ['time']: _rounded(sample_time), ['layer']: Math.trunc(pyGet(pose, 'layer', 0)), ['coordinateFrame']: { ['units']: 'screen pixels', ['keyboardRect']: [Math.trunc(rect.x), Math.trunc(rect.y), Math.trunc(rect.w), Math.trunc(rect.h)], ['origin']: 'top-left of keyboardRect', ['axes']: { ['x']: 'right', ['y']: 'down', ['z']: 'up toward viewer' }, ['pixelsPerInch']: _rounded(pose['ppi']), ['frontY']: _rounded(pose['front_y']) }, ['wristPose']: { ['positionPx']: Array.from(pyIter(pose['wrist'].slice(0, 2))).map((x: any) => _rounded(x)), ['headingRadians']: _rounded(pose['wrist'][2]) }, ['armEnd']: Array.from(pyIter(struct['arm_end'])).map((x: any) => _rounded(x)), ['fingerTips']: Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [String(f), Array.from(pyIter(struct['chains'][f][struct['chains'][f].length - 1])).map((x: any) => _rounded(x))])), ['fingerChains']: Object.fromEntries(Array.from(pyIter(pyRange(1, 6))).map((f: any) => [String(f), Array.from(pyIter(struct['chains'][f])).map((point: any) => Array.from(pyIter(point)).map((x: any) => _rounded(x)))])), ['wristJoints']: Array.from(pyIter(struct['wrist'])).map((point: any) => Array.from(pyIter(point)).map((x: any) => _rounded(x))), ['bones']: Array.from(pyIter(pose['bones'])).map(([start, end, kind]: any) => ({ ['type']: kind, ['start']: Array.from(pyIter(start)).map((x: any) => _rounded(x)), ['end']: Array.from(pyIter(end)).map((x: any) => _rounded(x)) })), ['joints']: Array.from(pyIter(pose['joints'])).map(([point, kind]: any) => ({ ['type']: kind, ['position']: Array.from(pyIter(point)).map((x: any) => _rounded(x)) })), ['boneCount']: (pose['bones']).length, ['jointCount']: (pose['joints']).length };
}
export function _selected_times(animator: any = null): any {
  let attacks: any, chosen: any;
  if (bool((!bool(animator.groups)))) {
    return [];
  }
  attacks = Array.from(pyIter(animator.groups)).map(([t, _notes]: any) => Number(t));
  chosen = [attacks[0], attacks[Math.floor((attacks).length / 2)], attacks[attacks.length - 1]];
  if (((attacks).length > 1)) {
    chosen.push(((attacks[0] + attacks[1]) / 2));
  }
  return pySorted(new Set(chosen), null, false);
}
export function _motion_pose(pose: any = null, hand_name: any = null, sample_time: any = null, keyboard_left: any = null, ppi: any = null): any {
  const point = (raw: any = null): any => {
    return [_rounded(((raw[0] - keyboard_left) / ppi)), _rounded((raw[1] / ppi)), _rounded((raw[2] / ppi))];
  };
  return { ['transportTimeSeconds']: _rounded(sample_time), ['hand']: ((pyEq(hand_name, midi_loader.LEFT)) ? 'left' : 'right'), ['layerOrder']: Math.trunc(pyGet(pose, 'layer', 0)), ['bones']: Array.from(pyIter(pose['bones'])).map(([start, end, kind]: any) => ({ ['a']: point(start), ['b']: point(end), ['kind']: kind })), ['joints']: Array.from(pyIter(pose['joints'])).map(([p, kind]: any) => ({ ['point']: point(p), ['kind']: kind })) };
}
export function _dedupe_serialized_motion_poses(poses: any = null): any {
  let key: any, pose: any, previous: any;
  // Drop only identical poses whose timestamps collide after serialization.
  const unique: any[] = [];
  const by_hand_time = new Map<string, any>();
  for (pose of pyIter(poses)) {
    key = `${pose['transportTimeSeconds']}:${pose['hand']}`;
    previous = by_hand_time.get(key);
    if (previous === undefined) {
      by_hand_time.set(key, pose);
      unique.push(pose);
    } else {
      if ((pyNotEq(previous, pose))) {
        throw ValueError('distinct motion poses collide at the same serialized hand/time');
      }
    }
  }
  return unique;
}
export function _plan_id(kind: any = null, request_id: any = null): any {
  let digest: any;
  digest = ({ hexdigest: () => sha256(new TextEncoder().encode(`${kind}\u0000${request_id}`)) }).hexdigest().slice(0, 24);
  return `${kind}/${digest}`;
}
export function _same_json(left: any = null, right: any = null): any {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isNaN(left) && Number.isNaN(right)) return true;
    return Math.abs(left - right) < 1e-7;
  }
  // Compare JSON DTOs without relying on insertion order.
  if (typeof left === 'object' && !Array.isArray(left) && typeof right === 'object' && !Array.isArray(right)) {
    const keysLeft = Object.keys(left);
    const keysRight = Object.keys(right);
    if (keysLeft.length !== keysRight.length) return false;
    for (const key of keysLeft) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!_same_json(left[key], right[key])) return false;
    }
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!_same_json(left[i], right[i])) return false;
    }
    return true;
  }
  return pyEq(left, right);
}
export function _check_replan_document(expected: any = null, edited: any = null, plan: any = null, resource: any = null): any {
  let after: any, assignment: any, assignments: any, assignments_by_id: any, before: any, disposition: any, edited_notes: any, expected_notes: any, finger: any, finger_mode: any, gliss_mode: any, immutable_document_keys: any, key: any, note: any, note_id: any, value: any;
  if ((bool((!bool((typeof edited === 'object' && edited !== null && !Array.isArray(edited))))) ? ((!bool((typeof edited === 'object' && edited !== null && !Array.isArray(edited))))) : ((!bool((typeof plan === 'object' && plan !== null && !Array.isArray(plan))))))) {
    throw ValueError('replan document and fingering plan must be JSON objects');
  }
  if ((pyNotEq(pyKeys(expected), pyKeys(edited)))) {
    throw ValueError('edited document must preserve the exact SongDocument fields');
  }
  immutable_document_keys = ['schemaVersion', 'projectId', 'revision', 'title', 'durationSeconds', 'sourceMidiResourceId', 'tracks', 'tempoMap', 'pedalControls'];
  for (key of pyIter(immutable_document_keys)) {
    if (bool((!bool(_same_json(pyGet(expected, key, null), pyGet(edited, key, null)))))) {
      throw ValueError(`edited document changed immutable source field ${key}`);
    }
  }
  if ((pyNotEq(pyGet(edited, 'sourceMidiResourceId', null), pyGet(resource, 'resourceId', null)))) {
    throw ValueError('edited document does not reference the original source resource');
  }
  expected_notes = Object.fromEntries(Array.from(pyIter(pyGet(expected, 'notes', []))).map((note: any) => [pyGet(note, 'noteId', null), note]));
  edited_notes = Object.fromEntries(Array.from(pyIter(pyGet(edited, 'notes', []))).map((note: any) => [pyGet(note, 'noteId', null), note]));
  if (pyLen(expected_notes) !== pyGet(expected, 'notes', []).length || pyLen(edited_notes) !== pyGet(edited, 'notes', []).length) {
    throw ValueError('document note IDs must be unique');
  }
  if ((pyNotEq(pyKeys(expected_notes), pyKeys(edited_notes)))) {
    throw ValueError('edited document must preserve every normalized note ID');
  }
  for ([note_id, before] of pyIter(pyItems(expected_notes))) {
    after = edited_notes[note_id];
    if ((pyNotEq(pyKeys(before), pyKeys(after)))) {
      throw ValueError(`edited note ${note_id} must preserve its exact source fields`);
    }
    for ([key, value] of pyIter(pyItems(before))) {
      if (((((!pyIn(key, ['hand', 'finger', 'glissando'])))) && ((!bool(_same_json(value, pyGet(after, key, null))))))) {
        throw ValueError(`edited document changed source note field ${key} for ${note_id}`);
      }
    }
    if (((!pyIn(pyGet(after, 'hand', null), ['left', 'right'])))) {
      throw ValueError(`edited document has invalid hand for ${note_id}`);
    }
    if (bool((!bool((typeof pyGet(after, 'glissando', null) === 'boolean'))))) {
      throw ValueError(`edited document has invalid glissando state for ${note_id}`);
    }
    finger = pyGet(after, 'finger', null);
    if ((((finger !== null)) && ((bool((!bool((typeof finger === 'number' && Number.isInteger(finger))))) ? ((!bool((typeof finger === 'number' && Number.isInteger(finger))))) : ((bool((finger < 1)) ? ((finger < 1)) : ((finger > 5)))))))) {
      throw ValueError(`edited document has invalid finger for ${note_id}`);
    }
  }
  assignments = pyGet(plan, 'assignments', null);
  if (bool((!bool(Array.isArray(assignments))))) {
    throw ValueError('fingering plan assignments must be a list');
  }
  assignments_by_id = Object.fromEntries(Array.from(pyIter(assignments)).map((assignment: any) => [pyGet(assignment, 'noteId', null), assignment]));
  if ((bool((pyNotEq(pyLen(assignments_by_id), (assignments).length))) ? ((pyNotEq(pyLen(assignments_by_id), (assignments).length))) : ((pyNotEq(pyKeys(assignments_by_id), pyKeys(edited_notes)))))) {
    throw ValueError('fingering plan must assign every edited document note exactly once');
  }
  if ((bool((pyNotEq(pyGet(plan, 'projectId', null), pyGet(edited, 'projectId', null)))) ? ((pyNotEq(pyGet(plan, 'projectId', null), pyGet(edited, 'projectId', null)))) : ((pyNotEq(pyGet(plan, 'inputRevision', null), pyGet(edited, 'revision', null)))))) {
    throw ValueError('fingering plan project/revision identity does not match the edited document');
  }
  for ([note_id, assignment] of pyIter(pyItems(assignments_by_id))) {
    note = edited_notes[note_id];
    disposition = pyGet(assignment, 'disposition', null);
    if ((pyNotEq(pyGet(assignment, 'hand', null), pyGet(note, 'hand', null)))) {
      throw ValueError(`fingering hand does not match edited document for ${note_id}`);
    }
    finger_mode = pyGet(assignment, 'fingerMode', null);
    if (((!pyIn(finger_mode, [null, 'manual', 'automatic'])))) {
      throw ValueError(`invalid finger mode for ${note_id}`);
    }
    gliss_mode = pyGet(assignment, 'glissMode', null);
    if (((!pyIn(gliss_mode, [null, 'manual', 'automatic'])))) {
      throw ValueError(`invalid gliss mode for ${note_id}`);
    }
    if ((((pyEq(gliss_mode, 'manual'))) && ((pyNotEq((pyEq(disposition, 'glissando')), pyGet(note, 'glissando', null)))))) {
      throw ValueError(`explicit gliss intent does not match the edited document for ${note_id}`);
    }
    if ((((pyEq(finger_mode, 'manual'))) && ((bool((pyNotEq(disposition, 'played'))) ? ((pyNotEq(disposition, 'played'))) : ((pyNotEq(pyGet(note, 'finger', null), pyGet(assignment, 'finger', null)))))))) {
      throw ValueError(`manual finger intent does not match the edited document for ${note_id}`);
    }
    if ((((pyEq(finger_mode, 'automatic'))) && ((pyGet(note, 'finger', null) !== null)))) {
      throw ValueError(`automatic finger intent must clear the document finger for ${note_id}`);
    }
    if ((((pyEq(disposition, 'unplayable'))) && ((bool((pyEq(finger_mode, 'manual'))) ? ((pyEq(finger_mode, 'manual'))) : ((((pyEq(gliss_mode, 'manual'))) && bool(pyGet(note, 'glissando', null)))))))) {
      throw ValueError(`unplayable disposition conflicts with explicit note intent for ${note_id}`);
    }
  }
  return [edited_notes, assignments_by_id];
}
export function _profile_diagnostics(diagnostics: any = null): any {
  return Array.from(pyIter(diagnostics)).map((item: any) => ({ ...item }));
}
export function analyze_midi(data: any = null, options: any = null): any {
  let _lead: any, _strength: any, _top: any, aliases_by_note: any, ambiguous_alias_ids: any, ambiguous_normalized_ids: any, ambiguous_source_identity_diagnostic: any, ambiguous_source_ids: any, animator: any, animators: any, arranged: any, assignment_by_identity: any, assignment_dto: any, assignment_dtos: any, assignments: any, bpm: any, cleanup: any, common_plan: any, common_result: any, common_sample_times: any, controller: any, crossing_episodes: any, decoded: any, desktop_notes: any, diagnostics: any, disposition: any, document: any, document_notes: any, dto: any, edited_assignments: any, edited_assignments_by_id: any, edited_document: any, edited_intent: any, edited_note: any, edited_notes: any, edited_plan: any, end: any, engine_version: any, entry: any, entry_by_id: any, entry_by_object: any, error: any, event: any, event_by_source_id: any, finger: any, fingering_plan: any, fixture_id: any, frac: any, gliss_ids: any, hand_name: any, hands_summary: any, identity_losses: any, identity_mappings: any, index: any, initial_end: any, initial_motion_window: any, input_hash: any, intent_key: any, key_style: any, keyboard: any, keyboard_rect: any, locators: any, manifest: any, missing: any, motion_plan: any, motion_poses: any, normalized: any, normalized_id: any, note: any, note_id: any, note_id_by_object: any, observed: any, ordinal: any, original_song: any, paired: any, parse_errors: any, parser_cleanup: any, pedal_controls: any, pedals: any, performance_events: any, performance_plan: any, performance_plan_events: any, planning_song: any, pose: any, press: any, profile_context: any, profile_dto: any, profile_id: any, profile_revision: any, project_id: any, raw: any, raw_baseline: any, raw_channels: any, raw_events: any, raw_observation: any, raw_pedals: any, raw_poses: any, raw_status: any, raw_tracks: any, rect_values: any, release: any, replan_context: any, report_step: any, request_id: any, requested_times: any, required: any, resource: any, resource_id: any, revision: any, sample_time: any, sample_times_by_hand: any, sampled: any, sampled_window: any, shared: any, solved_count: any, song: any, source: any, source_bytes: any, source_decode_error: any, source_event_map: any, source_id: any, source_ids: any, source_items: any, source_note: any, source_notes: any, source_notes_by_id: any, source_parse_errors: any, source_pm: any, start: any, status: any, tempi: any, tempo_map: any, tempo_times: any, time_seconds: any, total_samples: any, track: any, track_dto: any, track_dtos: any, tracks_by_index: any, unmapped_source_ids: any, unplayable_ids: any, updated_entries: any, updated_note_ids: any, updated_notes: any, value: any;
  // Import, normalize, finger, schedule, and sample a MIDI in one job.
  //
  //     ``data`` remains in memory and its SHA-256 is returned as a resource
  //     descriptor. No Python object identity is serialized.
  //
  if (bool((!bool((data instanceof Uint8Array || data instanceof ArrayBuffer))))) {
    throw TypeError('data must be bytes-like');
  }
  options = { ...(bool(options) ? (options) : ({  })) };
  required = ['fixtureId', 'projectId', 'revision', 'requestId', 'engineVersion'];
  missing = Array.from(pyIter(required)).filter((key: any) => ((!pyIn(key, options)))).map((key: any) => key);
  if (bool(missing)) {
    throw ValueError(('options is missing: ' + missing.join(', ')));
  }
  fixture_id = String(options['fixtureId']).trim();
  project_id = String(options['projectId']).trim();
  request_id = String(options['requestId']).trim();
  revision = Math.trunc(options['revision']);
  if ((bool((!bool(fixture_id))) ? ((!bool(fixture_id))) : ((bool((!bool(project_id))) ? ((!bool(project_id))) : ((bool((!bool(request_id))) ? ((!bool(request_id))) : ((revision < 0)))))))) {
    throw ValueError('fixtureId, projectId, requestId must be nonempty and revision nonnegative');
  }
  source_bytes = (data instanceof Uint8Array ? data : new Uint8Array(data));
  input_hash = ({ hexdigest: () => sha256(source_bytes) }).hexdigest();
  [profile_dto, profile_context] = _resolve_profile(pyGet(options, 'profile', null));
  manifest = EMBEDDED_MANIFEST;
  engine_version = _engine_version(manifest);
  options['engineVersion'] = engine_version;
  key_style = pyGet(options, 'keyStyle', 'realistic');
  if (((!pyIn(key_style, ['realistic', 'equal'])))) {
    throw ValueError('keyStyle must be realistic or equal');
  }
  rect_values = pyGet(options, 'keyboardRect', [0, 0, 1400, 150]);
  if ((bool((!bool(Array.isArray(rect_values)))) ? ((!bool(Array.isArray(rect_values)))) : ((pyNotEq((rect_values).length, 4))))) {
    throw ValueError('keyboardRect must be [x,y,w,h]');
  }
  keyboard_rect = new NumericRect(...Array.from(pyIter(rect_values)).map((v: any) => Math.trunc(v)));
  if ((bool((keyboard_rect.w <= 0)) ? ((keyboard_rect.w <= 0)) : ((keyboard_rect.h <= 0)))) {
    throw ValueError('keyboardRect width and height must be positive');
  }
  requested_times = pyGet(options, 'sampleTimes', null);
  if ((requested_times !== null)) {
    requested_times = Array.from(pyIter(requested_times)).map((t: any) => _finite(t, 'sampleTimes entry'));
    if (((requested_times).length > 1000)) {
      throw ValueError('sampleTimes contains more than 1000 entries');
    }
  }
  resource_id = `source-midi/${fixture_id}`;
  resource = { ['resourceId']: resource_id, ['purpose']: 'source-midi', ['mediaType']: 'audio/midi', ['byteLength']: (source_bytes).length, ['sha256']: input_hash, ['path']: 'resources/source.mid' };
  common_result = { ['type']: 'analysis-result', ['requestId']: request_id, ['projectId']: project_id, ['revision']: revision, ['engineVersion']: engine_version, ['profile']: profile_dto, ['resource']: resource };
  diagnostics = [];
  source_parse_errors = [];
  try {
    [decoded, cleanup] = midi_loader.read_midi(source_bytes);
  } catch (exc: any) {
    parse_errors = [{ ['phase']: 'pretty_midi source inventory', ['type']: type(exc).__name__, ['message']: String(exc) }];
    raw_observation = identity.observe_source(source_bytes, null, fixture_id);
    parse_errors.push(...pyGet(raw_observation, 'sourceParseErrors', []));
    error = { ['type']: type(exc).__name__, ['message']: String(exc) };
    raw = _empty_raw_baseline(fixture_id, input_hash, 'invalid-or-rejected', parse_errors, error);
    diagnostics.push({ ['severity']: 'error', ['code']: 'midi-load-failed', ['message']: (bool(String(exc)) ? (String(exc)) : (type(exc).__name__)) });
    return { ...common_result, ['status']: 'invalid', ['document']: null, ['fingeringPlan']: null, ['performancePlan']: null, ['motionPlan']: null, ['diagnostics']: diagnostics, ['rawBaseline']: raw };
  }
  parser_cleanup = [...cleanup];
  source_pm = decoded;
  source_decode_error = null;
  if (bool(cleanup)) {
    try {

      source_pm = new midi_loader.PrettyMIDI(source_bytes);
    } catch (exc: any) {
      source_pm = null;
      source_decode_error = { ['phase']: 'pretty_midi source inventory', ['type']: type(exc).__name__, ['message']: String(exc) };
      source_parse_errors.push(source_decode_error);
    }
  }
  observed = identity.observe_source(source_bytes, source_pm, fixture_id);
  source_parse_errors.push(...pyGet(observed, 'sourceParseErrors', []));
  source_notes = observed['sourceNotes'];
  source_event_map = {  };
  for (source of pyIter(source_notes)) {
    event = pyGet(observed['eventBySourceId'], source['noteId'], null);
    if (bool(event)) {
      source_event_map[[source['sourceInstrument'], source['sourceOrdinal']]] = event;
    }
  }
  fingering.reset_context(profile_context);
  song = midi_loader.load_midi(source_bytes, { fixture_id: fixture_id, source_event_map: source_event_map, pianist_context: profile_context, decoded: [decoded, [...cleanup]] });
  _report_progress(0.15, `Loaded ${(song.notes).length} notes; planning fingering...`);
  [desktop_notes, unmapped_source_ids, entry_by_object] = _map_desktop_notes(source_notes, song.notes, fixture_id);
  aliases_by_note = {  };
  note_id_by_object = {  };
  document_notes = [];
  tracks_by_index = Object.fromEntries(Array.from(pyIter(song.tracks)).map((track: any) => [track.index, track]));
  event_by_source_id = observed['eventBySourceId'];
  for ([index, note] of pyIter(enumerate(song.notes))) {
    entry = entry_by_object[pyId(note)];
    source_ids = [...dict.fromkeys(note.source_ids)];
    note_id = ((pyIn(entry['noteId'], source_ids)) ? entry['noteId'] : (bool(source_ids) ? source_ids[0] : `${fixture_id}/normalized/note-${index}`));
    note_id_by_object[pyId(note)] = note_id;
    for (source_id of pyIter(source_ids)) {
      pySetDefault(aliases_by_note, source_id, []).push(note_id);
    }
    track = tracks_by_index[note.track];
    dto = { ['noteId']: note_id, ['trackId']: `${fixture_id}/track-${track.index}`, ['pitch']: Math.trunc(note.pitch), ['velocity']: Math.trunc(note.velocity), ['startSeconds']: _rounded(note.start), ['endSeconds']: _rounded(note.end), ['hand']: ((pyEq(note.hand, midi_loader.LEFT)) ? 'left' : 'right'), ['finger']: (bool((typeof note.finger === 'number' && Number.isInteger(note.finger))) ? Math.trunc(note.finger) : null), ['glissando']: bool(note.gliss) };
    if (bool(source_ids)) {
      dto['sourceNoteIds'] = source_ids;
    }
    if ((((pyEq((source_ids).length, 1))) && ((pyIn(source_ids[0], event_by_source_id))))) {
      dto['sourceEvent'] = { ...event_by_source_id[source_ids[0]] };
    }
    document_notes.push(dto);
  }
  ambiguous_alias_ids = new Set(Array.from(pyIter(pyItems(aliases_by_note))).filter(([source_id, normalized_ids]: any) => ((new Set(normalized_ids)).size > 1)).map(([source_id, normalized_ids]: any) => source_id));
  if (bool(ambiguous_alias_ids)) {
    for (source_id of pyIter(ambiguous_alias_ids)) {
      pyPop(event_by_source_id, source_id, null);
    }
    for (source of pyIter(source_notes)) {
      if ((pyIn(source['noteId'], ambiguous_alias_ids))) {
        pyPop(source, 'sourceEvent', null);
      }
    }
    for (note of pyIter(document_notes)) {
      if (bool(Array.from(Array.from(pyIter(pyGet(note, 'sourceNoteIds', []))).map((source_id: any) => (pyIn(source_id, ambiguous_alias_ids)))).some(Boolean))) {
        pyPop(note, 'sourceEvent', null);
      }
    }
  }
  track_dtos = [];
  for (track of pyIter(song.tracks)) {
    source_items = Array.from(pyIter(source_notes)).filter((item: any) => (pyEq(item['sourceInstrument'], track.index))).map((item: any) => item);
    locators = Array.from(pyIter(source_items)).map((item: any) => pyGet(event_by_source_id, item['noteId'], null));
    locators = Array.from(pyIter(locators)).filter((item: any) => item).map((item: any) => item);
    raw_tracks = new Set(Array.from(pyIter(locators)).map((item: any) => item['midiTrackIndex']));
    raw_channels = new Set(Array.from(pyIter(locators)).map((item: any) => item['channel']));
    track_dto = { ['trackId']: `${fixture_id}/track-${track.index}`, ['instrumentIndex']: Math.trunc(track.index), ['name']: String(track.name), ['program']: Math.trunc(track.program), ['hand']: ((pyEq(track.hand, midi_loader.LEFT)) ? 'left' : ((pyEq(track.hand, midi_loader.RIGHT)) ? 'right' : null)) };
    if ((((pyEq((raw_tracks).size, 1))) && ((pyEq((locators).length, (source_items).length))))) {
      track_dto['sourceMidiTrackIndex'] = pyNext(pyIter(raw_tracks));
    }
    if ((((pyEq((raw_channels).size, 1))) && ((pyEq((locators).length, (source_items).length))))) {
      track_dto['channel'] = pyNext(pyIter(raw_channels));
    }
    track_dtos.push(track_dto);
  }
  [tempo_times, tempi] = decoded.get_tempo_changes();
  tempo_map = [];
  for ([ordinal, [time_seconds, bpm]] of pyIter(enumerate(zip(tempo_times, tempi)))) {
    if ((bpm <= 0)) {
      continue;
    }
    tempo_map.push({ ['timeSeconds']: _rounded(time_seconds), ['microsecondsPerQuarterNote']: pyMax(1, pyMin(16777215, Math.trunc(Math.round((60000000 / bpm))))), ['eventOrdinal']: ordinal });
  }
  if (bool((!bool(tempo_map)))) {
    tempo_map = [{ ['timeSeconds']: 0.0, ['microsecondsPerQuarterNote']: 500000, ['eventOrdinal']: 0 }];
  }
  pedal_controls = Array.from(pyIter(enumerate(song.raw_controls))).map(([ordinal, [t, controller, value]]: any) => ({ ['timeSeconds']: _rounded(t), ['controller']: Math.trunc(controller), ['value']: Math.trunc(value), ['eventOrdinal']: ordinal }));
  document = { ['schemaVersion']: SCHEMA_VERSION, ['projectId']: project_id, ['revision']: revision, ['title']: song.title, ['durationSeconds']: _rounded(song.duration), ['sourceMidiResourceId']: resource_id, ['tracks']: track_dtos, ['notes']: document_notes, ['tempoMap']: tempo_map, ['pedalControls']: pedal_controls };
  planning_song = song;
  replan_context = pyGet(options, '_editorReplan', null);
  edited_assignments_by_id = {  };
  if ((replan_context !== null)) {
    edited_document = pyGet(replan_context, 'document', null);
    edited_plan = pyGet(replan_context, 'fingeringPlan', null);
    [edited_notes, edited_assignments] = _check_replan_document(document, edited_document, edited_plan, pyGet(replan_context, 'resource', {  }));
    edited_assignments_by_id = edited_assignments;
    source_notes_by_id = Object.fromEntries(Array.from(pyIter(song.notes)).map((note: any) => [note_id_by_object[pyId(note)], note]));
    if ((pyNotEq(pyKeys(source_notes_by_id), pyKeys(edited_notes)))) {
      throw ValueError('replan document IDs do not map one-to-one to normalized source notes');
    }
    updated_notes = [];
    updated_entries = {  };
    updated_note_ids = {  };
    entry_by_id = Object.fromEntries(Array.from(pyIter(pyItems(entry_by_object))).map(([identity, entry]: any) => [note_id_by_object[identity], entry]));
    for ([note_id, source_note] of pyIter(pyItems(source_notes_by_id))) {
      dto = edited_notes[note_id];
      edited_note = new Note(source_note.pitch, source_note.start, source_note.end, source_note.velocity, source_note.track, ((pyEq(dto['hand'], 'left')) ? midi_loader.LEFT : midi_loader.RIGHT), dto['finger'], dto['glissando'], source_note.source_ids, source_note.source_events);
      updated_notes.push(edited_note);
      updated_entries[pyId(edited_note)] = entry_by_id[note_id];
      updated_note_ids[pyId(edited_note)] = note_id;
    }
    original_song = song;
    song = new MidiSong(updated_notes, original_song.tracks, original_song.duration, original_song.bar_times, original_song.beat_times, original_song.path, original_song.raw_controls);
    song.cleanup = [...original_song.cleanup];
    entry_by_object = updated_entries;
    note_id_by_object = updated_note_ids;
    document = edited_document;
    unplayable_ids = new Set(Array.from(pyIter(pyItems(edited_assignments))).filter(([note_id, assignment]: any) => (pyEq(assignment['disposition'], 'unplayable'))).map(([note_id, assignment]: any) => note_id));
    planning_song = new MidiSong(Array.from(pyIter(song.notes)).filter((note: any) => ((!pyIn(note_id_by_object[pyId(note)], unplayable_ids)))).map((note: any) => note), song.tracks, song.duration, song.bar_times, song.beat_times, song.path, song.raw_controls);
    planning_song.cleanup = [...song.cleanup];
  }
  animators = hands.build_hands(planning_song, { pianist: profile_context, key_style: key_style });
  _report_progress(0.28, 'Solving kinematics and scheduling rolled chords...');
  keyboard = new KeyboardGeometry(keyboard_rect, key_style);
  _store_active_session([project_id, revision, profile_dto['profileId']], { ['animators']: animators, ['planning_song']: planning_song, ['keyboard']: keyboard, ['song']: song });
  assignments = [];
  assignment_by_identity = {  };
  gliss_ids = new Set();
  hands_summary = [];
  performance_events = [];
  for (hand_name of pyIter([midi_loader.RIGHT, midi_loader.LEFT])) {
    animator = pyGet(animators, hand_name, null);
    if ((animator === null)) {
      continue;
    }
    pyUpdate(assignment_by_identity, animator.fingering);
    pyUpdate(gliss_ids, animator.gliss_ids);
    hands_summary.push({ ['hand']: hand_name, ['assignedCount']: pyLen(animator.fingering), ['rolledChords']: Math.trunc(animator.rolled), ['glissRuns']: Array.from(pyIter(animator.gliss_runs)).map((run: any) => Array.from(pyIter(run)).map((note: any) => _rounded(note.start))) });
    for ([press, release, note] of pyIter(animator.performance)) {
      entry = entry_by_object[pyId(note)];
      performance_events.push({ ['noteId']: entry['noteId'], ['sourceNoteIds']: entry['sourceNoteIds'], ['hand']: hand_name, ['press']: _rounded(press), ['release']: _rounded(release) });
    }
  }
  performance_events.sort((a: any, b: any) => { const ka = [a['press'], a['hand'], bool(a['noteId']) ? a['noteId'] : '']; const kb = [b['press'], b['hand'], bool(b['noteId']) ? b['noteId'] : '']; return pyCmp(ka, kb); });
  for (note of pyIter(song.notes)) {
    entry = entry_by_object[pyId(note)];
    finger = pyGet(assignment_by_identity, pyId(note), null);
    assignments.push({ ['noteId']: entry['noteId'], ['sourceNoteIds']: entry['sourceNoteIds'], ['hand']: note.hand, ['finger']: (bool((typeof finger === 'number' && Number.isInteger(finger))) ? Math.trunc(finger) : null), ['manualFinger']: (bool((typeof note.finger === 'number' && Number.isInteger(note.finger))) ? Math.trunc(note.finger) : null), ['gliss']: bool(note.gliss) });
  }
  assignments.sort((a: any, b: any) => { const ka = [bool(a['noteId']) ? a['noteId'] : '', a['hand']]; const kb = [bool(b['noteId']) ? b['noteId'] : '', b['hand']]; return pyCmp(ka, kb); });
  crossing_episodes = hands.crossing_episodes(planning_song);
  ambiguous_normalized_ids = pySorted(new Set(Array.from(pyIter(pyGet(observed, 'ambiguousSourceIds', []))).flatMap((source_id: any) => Array.from(pyIter(pyGet(aliases_by_note, source_id, []))).map((normalized_id: any) => normalized_id))), null, false);
  ambiguous_normalized_ids = pySorted(pySetUnion(new Set(ambiguous_normalized_ids), Array.from(pyIter(ambiguous_alias_ids)).flatMap((source_id: any) => Array.from(pyIter(pyGet(aliases_by_note, source_id, []))).map((normalized_id: any) => normalized_id))), null, false);
  for (normalized_id of pyIter(ambiguous_normalized_ids)) {
    diagnostics.push({ ['severity']: 'warning', ['code']: 'source-event-ambiguous', ['message']: 'Raw SMF event locator is ambiguous; decoded note identity is retained without a locator.', ['noteIds']: [normalized_id] });
  }
  ambiguous_source_ids = pySorted(pyBitOr(new Set(pyGet(observed, 'ambiguousSourceIds', [])), ambiguous_alias_ids), null, false);
  ambiguous_source_identity_diagnostic = (bool(ambiguous_source_ids) ? { ['severity']: 'warning', ['code']: 'source-identity-ambiguous', ['message']: 'Decoded source-note identities have ambiguous event or normalized-note mappings; see the raw identity mappings for affected source IDs.', ['noteIds']: ambiguous_source_ids } : null);
  for (note of pyIter(song.notes)) {
    if (((((!pyIn(pyId(note), assignment_by_identity)))) && (((!pyIn(pyId(note), gliss_ids)))))) {
      normalized_id = note_id_by_object[pyId(note)];
      diagnostics.push({ ['severity']: 'warning', ['code']: 'note-unplayable', ['message']: 'Fingering planner did not assign a playable finger to this note.', ['noteIds']: [normalized_id] });
    }
  }
  if (bool(parser_cleanup)) {
    diagnostics.push({ ['severity']: 'info', ['code']: 'midi-repaired', ['message']: parser_cleanup[0] });
  }
  diagnostics.push(...Array.from(pyIter(source_parse_errors)).map((item: any) => ({ ['severity']: 'warning', ['code']: 'source-parse-warning', ['message']: `${item['phase']}: ${item['type']}: ${item['message']}`.trimEnd() })));
  [profile_id, profile_revision] = [profile_dto['profileId'], profile_dto['revision']];
  common_plan = { ['schemaVersion']: SCHEMA_VERSION, ['projectId']: project_id, ['inputRevision']: revision, ['profileId']: profile_id, ['profileRevision']: profile_revision, ['engineVersion']: engine_version, ['diagnostics']: _profile_diagnostics(diagnostics) };
  assignment_dtos = [];
  for (note of pyIter(song.notes)) {
    note_id = note_id_by_object[pyId(note)];
    finger = pyGet(assignment_by_identity, pyId(note), null);
    if ((pyIn(pyId(note), gliss_ids))) {
      disposition = 'glissando';
      finger = null;
    } else {
      if (bool((typeof finger === 'number' && Number.isInteger(finger)))) {
        disposition = 'played';
      } else {
        disposition = 'unplayable';
        finger = null;
      }
    }
    assignment_dto = { ['noteId']: note_id, ['hand']: ((pyEq(note.hand, midi_loader.LEFT)) ? 'left' : 'right'), ['finger']: (bool((typeof finger === 'number' && Number.isInteger(finger))) ? Math.trunc(finger) : null), ['disposition']: disposition };
    edited_intent = pyGet(edited_assignments_by_id, note_id, null);
    if ((edited_intent !== null)) {
      for (intent_key of pyIter(['fingerMode', 'glissMode'])) {
        if ((pyIn(intent_key, edited_intent))) {
          assignment_dto[intent_key] = edited_intent[intent_key];
        }
      }
    }
    assignment_dtos.push(assignment_dto);
  }
  fingering_plan = { ...common_plan, ['planId']: _plan_id('fingering', request_id), ['kind']: 'fingering', ['assignments']: assignment_dtos };
  performance_plan_events = [];
  for (animator of pyIter(pyValues(animators))) {
    for ([press, release, note] of pyIter(animator.performance)) {
      note_id = note_id_by_object[pyId(note)];
      performance_plan_events.push([release, 0, { ['type']: 'release', ['timeSeconds']: _rounded(release), ['noteId']: note_id }]);
      performance_plan_events.push([press, 2, { ['type']: 'press', ['timeSeconds']: _rounded(press), ['noteId']: note_id, ['pitch']: Math.trunc(note.pitch), ['velocity']: Math.trunc(note.velocity) }]);
    }
  }
  for ([time_seconds, controller, value] of pyIter(song.controls)) {
    performance_plan_events.push([time_seconds, 1, { ['type']: 'pedal', ['timeSeconds']: _rounded(time_seconds), ['controller']: Math.trunc(controller), ['value']: Math.trunc(value) }]);
  }
  performance_plan_events.sort((a: any, b: any) => { const ka = [a[2]['timeSeconds'], a[1]]; const kb = [b[2]['timeSeconds'], b[1]]; return pyCmp(ka, kb); });
  performance_plan = { ...common_plan, ['planId']: _plan_id('performance', request_id), ['kind']: 'performance', ['fingeringPlanId']: fingering_plan['planId'], ['events']: Array.from(pyIter(performance_plan_events)).map(([_0, _1, event]: any) => event) };
  if ((requested_times === null)) {
    common_sample_times = new Set();
    if (pyLen(animators) === 2) {
      for (animator of pyIter(pyValues(animators))) {
        pyUpdate(common_sample_times, _selected_times(animator));
      }
      for ([start, end, _top, _strength, _lead] of pyIter(crossing_episodes)) {
        common_sample_times.add(Number(start));
        if ((end > start)) {
          common_sample_times.add(Number(((start + end) / 2)));
        }
      }
    }
    sample_times_by_hand = Object.fromEntries(Array.from(pyIter(pyItems(animators))).map(([hand_name, animator]: any) => [hand_name, (bool(common_sample_times) ? pySorted(common_sample_times, null, false) : _selected_times(animator))]));
  } else {
    shared = pySorted(new Set(requested_times), null, false);
    sample_times_by_hand = Object.fromEntries(Array.from(pyIter(animators)).map((hand_name: any) => [hand_name, shared]));
  }
  sampled = new Map<string, any>();
  const sampledEntries: Array<{ hand_name: any; sample_time: any; pose: any }> = [];
  raw_poses = [];
  motion_poses = [];
  total_samples = (Array.from(pyIter(pyValues(sample_times_by_hand))).map((times: any) => pyLen(times))).reduce((a: any, b: any) => a + b, 0);
  solved_count = 0;
  report_step = pyMax(1, Math.floor(total_samples / 40));
  for ([hand_name, animator] of pyIter(pyItems(animators))) {
    for (sample_time of pyIter(sample_times_by_hand[hand_name])) {
      pose = animator.pose(sample_time, keyboard);
      if (pyLen(animators) === 2) {
        pyUpdate(pose, { ['hand']: hand_name, ['anim']: animator, ['song']: planning_song, ['t']: sample_time });
      } else {
        pose['hand'] = hand_name;
      }
      sampled.set(`${hand_name}:${sample_time}`, pose);
      sampledEntries.push({ hand_name, sample_time, pose });
      solved_count = pyAugAdd(solved_count, 1);
      if ((bool((pyEq(pyMod(solved_count, report_step), 0))) ? ((pyEq(pyMod(solved_count, report_step), 0))) : ((pyEq(solved_count, total_samples))))) {
        frac = (0.38 + (0.56 * (solved_count / pyMax(1, total_samples))));
        _report_progress(frac, `Calculating hand poses: ${solved_count}/${total_samples} (${Math.trunc((frac * 100))}%)`);
      }
    }
  }
  _report_progress(0.96, 'Arranging hand crossings and finalizing motion plan...');
  if (pyLen(animators) === 2) {
    for (sample_time of pyIter(pySorted(new Set(Array.from(pyIter(pyValues(sample_times_by_hand))).flatMap((times: any) => Array.from(pyIter(times)).map((t: any) => t))), null, false))) {
      paired = Array.from(pyIter(pyKeys(animators))).filter((hand_name: any) => sampled.has(`${hand_name}:${sample_time}`)).map((hand_name: any) => sampled.get(`${hand_name}:${sample_time}`));
      arranged = ((pyEq(pyLen(paired), 2)) ? hands.arrange_crossing(paired) : paired);
      for (pose of pyIter(arranged)) {
        hand_name = pose['hand'];
        raw_poses.push(_serialize_pose(pose, hand_name, sample_time, keyboard.rect));
        motion_poses.push(_motion_pose(pose, hand_name, sample_time, keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left, pose['ppi']));
      }
    }
  } else {
    for (const { hand_name, sample_time, pose } of sampledEntries) {
      raw_poses.push(_serialize_pose(pose, hand_name, sample_time, keyboard.rect));
      motion_poses.push(_motion_pose(pose, hand_name, sample_time, keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left, pose['ppi']));
    }
  }
  raw_poses.sort((a: any, b: any) => { const ka = [a['time'], a['hand']]; const kb = [b['time'], b['hand']]; return pyCmp(ka, kb); });
  motion_poses.sort((a: any, b: any) => { const ka = [a['transportTimeSeconds'], a['hand']]; const kb = [b['transportTimeSeconds'], b['hand']]; return pyCmp(ka, kb); });
  motion_poses = _dedupe_serialized_motion_poses(motion_poses);
  motion_plan = null;
  if (bool(motion_poses)) {
    motion_plan = { ...common_plan, ['planId']: _plan_id('motion', request_id), ['kind']: 'motion', ['performancePlanId']: performance_plan['planId'], ['coordinateFrame']: 'keyboard-local-inches-v1', ['poses']: motion_poses };
  }
  _store_active_session([project_id, revision, profile_dto['profileId']], { ['animators']: animators, ['planning_song']: planning_song, ['keyboard']: keyboard, ['song']: song });
  raw_pedals = Array.from(pyIter(song.raw_controls)).map(([t, c, v]: any) => ({ ['time']: _rounded(t), ['controller']: Math.trunc(c), ['value']: Math.trunc(v) }));
  pedals = Array.from(pyIter(song.controls)).map(([t, c, v]: any) => ({ ['time']: _rounded(t), ['controller']: Math.trunc(c), ['value']: Math.trunc(v) }));
  identity_mappings = [];
  for (source of pyIter(source_notes)) {
    source_id = source['noteId'];
    normalized = pySorted(new Set(pyGet(aliases_by_note, source_id, [])), null, false);
    raw = pyGet(event_by_source_id, source_id, null);
    if ((bool((pyIn(source_id, pyGet(observed, 'ambiguousSourceIds', [])))) ? ((pyIn(source_id, pyGet(observed, 'ambiguousSourceIds', [])))) : ((bool((pyIn(source_id, ambiguous_alias_ids))) ? ((pyIn(source_id, ambiguous_alias_ids))) : (((normalized).length > 1)))))) {
      status = 'ambiguous';
    } else {
      if (bool((!bool(normalized)))) {
        status = 'unmapped';
      } else {
        if (bool((!bool(raw)))) {
          status = 'decoded-only';
        } else {
          if (bool(Array.from(Array.from(pyIter(normalized)).map((note_id: any) => ((source_ids_for([note_id], document_notes)).length > 1))).some(Boolean))) {
            status = 'merged';
          } else {
            status = 'exact';
          }
        }
      }
    }
    raw_events = ((bool(raw) && ((pyIn(status, ['exact', 'merged'])))) ? [{ ...raw }] : []);
    if (bool((!bool(raw_events)))) {
      pyPop(source, 'sourceEvent', null);
    }
    identity_mappings.push({ ['noteId']: source_id, ['sourceInstrument']: source['sourceInstrument'], ['sourceOrdinal']: source['sourceOrdinal'], ['rawEvents']: raw_events, ['normalizedNoteId']: ((pyEq((normalized).length, 1)) ? normalized[0] : null), ['status']: status });
  }
  identity_losses = Array.from(pyIter(desktop_notes)).filter((item: any) => ((item['sourceNoteIds']).length > 1)).map((item: any) => ({ ['normalizedNoteId']: item['noteId'], ['sourceNoteIds']: item['sourceNoteIds'] }));
  raw_status = (bool(parser_cleanup) ? 'repaired' : 'loaded');
  raw_baseline = { ['fixtureId']: fixture_id, ['inputSha256']: input_hash, ['status']: raw_status, ['duration']: _rounded(song.duration), ['sourceNotes']: source_notes, ['sourceParseErrors']: source_parse_errors, ['desktopNotes']: Array.from(pyIter(desktop_notes)).map((item: any) => Object.fromEntries(Array.from(pyIter(['noteId', 'sourceNoteIds', 'pitch', 'start', 'end', 'velocity', 'track', 'hand', 'manualFinger', 'gliss'])).map((key: any) => [key, item[key]]))), ['unmappedSourceNoteIds']: unmapped_source_ids, ['sourcePedals']: observed['sourcePedals'], ['rawPedals']: raw_pedals, ['pedals']: pedals, ['tracks']: Array.from(pyIter(song.tracks)).map((track: any) => ({ ['index']: Math.trunc(track.index), ['name']: track.name, ['program']: Math.trunc(track.program), ['noteCount']: Math.trunc(track.note_count), ['declaredHand']: track.hand })), ['assignments']: assignments, ['performanceEvents']: performance_events, ['hands']: hands_summary, ['crossingEpisodes']: Array.from(pyIter(crossing_episodes)).map(([start, end, top, strength, lead]: any) => ({ ['start']: _rounded(start), ['end']: _rounded(end), ['topHand']: top, ['strength']: _rounded(strength), ['lead']: _rounded(lead) })), ['selectedPoses']: raw_poses, ['cleanup']: [...song.cleanup], ['identityLosses']: identity_losses, ['identityMappings']: identity_mappings, ['sourceNoteIdentitySemantics']: 'Stable IDs use instrument and note ordinals after PrettyMIDI decode. Raw SMF note-on/off event locators are attached only when the original events are observed and uniquely matched; ambiguous pitch/time matches are not guessed.', ['goldenTrust']: (bool(cleanup) ? 'observed salvage; source was deliberately truncated and desktop repair dropped or fixed an event' : (bool(identity_losses) ? 'desktop-observation with source identity loss; decoded source aliases are explicit; raw-event mapping is omitted where ambiguous; this is not an independent correctness oracle' : 'desktop-observation; decoded source IDs are stable ordinals, raw event locators are conservative; this is not an independent correctness oracle')), ['provenance']: { ['profile']: (bool(pyGet(options, 'profile', null)) ? 'explicit per-job PianistProfile DTO' : 'deterministic built-in default profile'), ['engineVersion']: engine_version, ['desktopSourceCommit']: pyGet(manifest, 'desktopSourceCommit', null), ['desktopVersion']: pyGet(manifest, 'desktopVersion', null), ['adaptedFiles']: manifest['files'], ['keyStyle']: key_style, ['rawEventCount']: pyGet(observed, 'rawEventCount', 0) } };
  initial_motion_window = null;
  if ((bool((pyEq(fixture_id, 'imported-midi'))) ? ((pyEq(fixture_id, 'imported-midi'))) : (pyGet(options, 'sampleDense', false)))) {
    initial_end = pyMin(4.0, Number(song.duration));
    if ((initial_end > 0.0)) {
      sampled_window = sample_motion_window(new Uint8Array([]), null, null, 0.0, initial_end, { ['projectId']: project_id, ['revision']: revision, ['requestId']: (request_id + '/initial-motion'), ['engineVersion']: engine_version, ['profile']: profile_dto, ['keyStyle']: key_style, ['keyboardRect']: Array.from(pyIter(rect_values)).map((v: any) => Math.trunc(v)), ['maxPoses']: 200 });
      initial_motion_window = Object.fromEntries(Array.from(pyIter(['startTimeSeconds', 'endTimeSeconds', 'poses', 'coverage', 'truncated', 'continuationTimeSeconds'])).filter((key: any) => (pyIn(key, sampled_window))).map((key: any) => [key, sampled_window[key]]));
    }
  }
  if ((ambiguous_source_identity_diagnostic !== null)) {
    diagnostics.push(ambiguous_source_identity_diagnostic);
  }
  _report_progress(1.0, 'Analysis complete.');
  return { ...common_result, ['status']: raw_status, ['document']: document, ['fingeringPlan']: fingering_plan, ['performancePlan']: performance_plan, ['motionPlan']: motion_plan, ...((initial_motion_window !== null) ? { ['initialMotionWindow']: initial_motion_window } : {  }), ['diagnostics']: diagnostics, ['rawBaseline']: raw_baseline };
}
export function replan_document(data: any = null, document: any = null, fingering_plan: any = null, options: any = null): any {
  let actual_hash: any, analyze_options: any, baseline: any, missing: any, profile_id: any, profile_revision: any, required: any, resource: any, result: any, source_bytes: any;
  // Recompute performance and motion from original bytes plus typed edits.
  //
  //     The normalized source is decoded again, then edited note intents are joined
  //     only by the document's persistent note IDs. No MIDI export/reimport or
  //     pitch/time proximity matching participates in the replan.
  //
  options = { ...(bool(options) ? (options) : ({  })) };
  required = ['fixtureId', 'projectId', 'revision', 'requestId', 'engineVersion', 'profile', 'keyStyle', 'resource', 'rawBaseline'];
  missing = Array.from(pyIter(required)).filter((key: any) => ((!pyIn(key, options)))).map((key: any) => key);
  if (bool(missing)) {
    throw ValueError(('options is missing: ' + missing.join(', ')));
  }
  source_bytes = (data instanceof Uint8Array ? data : new Uint8Array(data));
  resource = options['resource'];
  baseline = options['rawBaseline'];
  if ((bool((!bool((typeof resource === 'object' && resource !== null && !Array.isArray(resource))))) ? ((!bool((typeof resource === 'object' && resource !== null && !Array.isArray(resource))))) : ((!bool((typeof baseline === 'object' && baseline !== null && !Array.isArray(baseline))))))) {
    throw ValueError('resource and rawBaseline must be JSON objects');
  }
  if ((bool((pyNotEq(pyGet(resource, 'purpose', null), 'source-midi'))) ? ((pyNotEq(pyGet(resource, 'purpose', null), 'source-midi'))) : ((pyNotEq(pyGet(resource, 'mediaType', null), 'audio/midi'))))) {
    throw ValueError('replan resource must describe source MIDI');
  }
  if ((bool((pyNotEq(pyGet(resource, 'path', null), 'resources/source.mid'))) ? ((pyNotEq(pyGet(resource, 'path', null), 'resources/source.mid'))) : ((pyNotEq(pyGet(resource, 'byteLength', null), (source_bytes).length))))) {
    throw ValueError('source resource path or byteLength does not match the original bytes');
  }
  actual_hash = ({ hexdigest: () => sha256(source_bytes) }).hexdigest();
  if ((bool((pyNotEq(pyGet(resource, 'sha256', null), actual_hash))) ? ((pyNotEq(pyGet(resource, 'sha256', null), actual_hash))) : ((pyNotEq(pyGet(baseline, 'inputSha256', null), actual_hash))))) {
    throw ValueError('source resource checksum does not match the original bytes');
  }
  if ((bool((pyNotEq(pyGet(baseline, 'fixtureId', null), options['fixtureId']))) ? ((pyNotEq(pyGet(baseline, 'fixtureId', null), options['fixtureId']))) : (((!pyIn(pyGet(baseline, 'status', null), ['loaded', 'repaired'])))))) {
    throw ValueError('rawBaseline must be the successful source observation for this fixture');
  }
  if ((pyNotEq(pyGet(document, 'sourceMidiResourceId', null), pyGet(resource, 'resourceId', null)))) {
    throw ValueError('edited document does not reference the source MIDI resource');
  }
  if ((bool((pyNotEq(pyGet(document, 'projectId', null), options['projectId']))) ? ((pyNotEq(pyGet(document, 'projectId', null), options['projectId']))) : ((pyNotEq(pyGet(document, 'revision', null), Math.trunc(options['revision'])))))) {
    throw ValueError('edited document identity does not match the replan request');
  }
  if ((bool((pyNotEq(pyGet(fingering_plan, 'projectId', null), options['projectId']))) ? ((pyNotEq(pyGet(fingering_plan, 'projectId', null), options['projectId']))) : ((pyNotEq(pyGet(fingering_plan, 'inputRevision', null), Math.trunc(options['revision'])))))) {
    throw ValueError('fingering plan identity does not match the replan request');
  }
  profile_id = String(pyGet(options['profile'], 'profileId', ''));
  profile_revision = Math.trunc(pyGet(options['profile'], 'revision', (-1)));
  if ((bool((pyNotEq(pyGet(fingering_plan, 'profileId', null), profile_id))) ? ((pyNotEq(pyGet(fingering_plan, 'profileId', null), profile_id))) : ((pyNotEq(pyGet(fingering_plan, 'profileRevision', null), profile_revision))))) {
    throw ValueError('fingering plan profile identity does not match the request');
  }
  options['engineVersion'] = _engine_version(EMBEDDED_MANIFEST);
  analyze_options = Object.fromEntries(Array.from(pyIter(pyItems(options))).filter(([key, value]: any) => ((!pyIn(key, ['resource', 'rawBaseline'])))).map(([key, value]: any) => [key, value]));
  pySetDefault(analyze_options, 'sampleDense', true);
  analyze_options['_editorReplan'] = { ['document']: document, ['fingeringPlan']: fingering_plan, ['resource']: resource };
  result = analyze_midi(source_bytes, analyze_options);
  if ((pyEq(result['status'], 'invalid'))) {
    throw ValueError('original source MIDI no longer loads for typed replan');
  }
  if (bool((!bool(_same_json(result['document'], document))))) {
    throw ValueError('replan did not preserve the edited SongDocument');
  }
  if (bool((!bool(_same_json(result['resource'], resource))))) {
    throw ValueError('replan source descriptor changed');
  }
  result['rawBaseline'] = baseline;
  result['keyStyle'] = options['keyStyle'];
  result['type'] = 'replan-document-result';
  return result;
}
export function source_ids_for(normalized_ids: any = null, document_notes: any = null): any {
  let wanted: any;
  wanted = new Set(normalized_ids);
  return Array.from(pyIter(wanted)).flatMap((note_id: any) => Array.from(pyIter(document_notes)).filter((note: any) => (pyEq(note['noteId'], note_id))).flatMap((note: any) => Array.from(pyIter(pyGet(note, 'sourceNoteIds', []))).map((note_id: any) => note_id)));
}
export function export_fingered_midi(data: any = null, document: any = null, fingering_plan: any = null): any {
  let assign: any, assignments: any, disposition: any, exported_bytes: any, finger: any, fingers: any, hand: any, hand_val: any, is_gliss: any, marked_count: any, nid: any, note_dto: any, note_obj: any, notes: any, notes_dto: any, raw_finger: any;
  // Takes original MIDI bytes, SongDocument DTO, and FingeringPlan DTO.
  //     Maps FingeringPlan.assignments to note objects.
  //     Calls save_fingered_midi_bytes.
  //     Returns: {"exportedBytes": exported_bytes, "markedCount": count}.
  //
  if (bool((!bool((data instanceof Uint8Array || data instanceof ArrayBuffer))))) {
    throw TypeError('data must be bytes-like');
  }
  if ((bool((!bool((typeof document === 'object' && document !== null && !Array.isArray(document))))) ? ((!bool((typeof document === 'object' && document !== null && !Array.isArray(document))))) : ((!bool((typeof fingering_plan === 'object' && fingering_plan !== null && !Array.isArray(fingering_plan))))))) {
    throw TypeError('document and fingering_plan must be dicts');
  }
  notes_dto = pyGet(document, 'notes', []);
  assignments = Object.fromEntries(Array.from(pyIter(pyGet(fingering_plan, 'assignments', []))).filter((a: any) => (pyIn('noteId', a))).map((a: any) => [a['noteId'], a]));
  notes = [];
  fingers = {  };
  for (note_dto of pyIter(notes_dto)) {
    nid = pyGet(note_dto, 'noteId', null);
    assign = pyGet(assignments, nid, null);
    hand_val = ((bool(assign) && ((pyIn('hand', assign)))) ? pyGet(assign, 'hand', null) : pyGet(note_dto, 'hand', 'right'));
    hand = ((pyIn(hand_val, ['left', midi_loader.LEFT])) ? midi_loader.LEFT : midi_loader.RIGHT);
    disposition = (bool(assign) ? pyGet(assign, 'disposition', null) : (bool(pyGet(note_dto, 'glissando', null)) ? 'glissando' : 'played'));
    if ((pyEq(disposition, 'glissando'))) {
      is_gliss = true;
      finger = 'g';
    } else {
      if ((pyEq(disposition, 'unplayable'))) {
        is_gliss = false;
        finger = null;
      } else {
        is_gliss = bool(pyGet(assign, 'glissando', pyGet(note_dto, 'glissando', false)));
        raw_finger = ((bool(assign) && ((pyIn('finger', assign)))) ? pyGet(assign, 'finger', null) : pyGet(note_dto, 'finger', null));
        finger = ((raw_finger !== null) ? Math.trunc(raw_finger) : null);
      }
    }
    note_obj = new Note(Math.trunc(note_dto['pitch']), Number(note_dto['startSeconds']), Number(note_dto['endSeconds']), Math.trunc(pyGet(note_dto, 'velocity', 64)), 0, hand, (bool((typeof finger === 'number' && Number.isInteger(finger))) ? finger : null), is_gliss);
    notes.push(note_obj);
    fingers[pyId(note_obj)] = finger;
  }
  [exported_bytes, marked_count] = midi_loader.save_fingered_midi_bytes((data instanceof Uint8Array ? data : new Uint8Array(data)), notes, fingers);
  return { ['exportedBytes']: exported_bytes, ['markedCount']: marked_count };
}
export function sample_motion_window(data: any = null, document: any = null, fingering_plan: any = null, start_time: any = null, end_time: any = null, options: any = null): any {
  let _lead: any, _n: any, _notes: any, _strength: any, _top: any, animator: any, animator_hand: any, animators: any, arranged: any, assign: any, assignments_by_id: any, c_end: any, c_start: any, ce: any, cleanup: any, continuation_time: any, continuous_end: any, coverage: any, coverage_hand: any, cs: any, curr_t: any, decoded: any, desktop_notes: any, disposition: any, doc_note: any, edited_note: any, effective_end_time: any, engine_version: any, entry_by_object: any, episodes: any, event: any, finger: any, fixture_id: any, gap: any, grid_step: any, h: any, h_poses: any, h_times: any, hand: any, hand_key: any, hand_name: any, hand_val: any, has_gap: any, idx: any, is_complete: any, is_gliss: any, key_style: any, keyboard: any, keyboard_rect: any, lowest_key_left: any, manifest: any, max_poses: any, mid: any, motion_poses: any, nid: any, note: any, note_id_by_object: any, notes_by_id: any, observed: any, p: any, paired: any, pf: any, planning_notes: any, planning_song: any, pose: any, poses_for_t: any, press: any, profile_context: any, profile_dto: any, profile_id: any, project_id: any, raw_finger: any, raw_hand: any, raw_max_poses: any, rect_values: any, release: any, request_id: any, res: any, revision: any, rf: any, sample_times: any, sampled: any, session: any, session_key: any, single_coverage: any, single_pose: any, song: any, sorted_times: any, source: any, source_bytes: any, source_event_map: any, source_notes: any, strike_dt: any, t: any, tf: any, truncated: any, unmapped_source_ids: any, unplayable_ids: any, updated_notes: any, window_end: any, window_start: any;
  // Bounded motion lookahead buffer sampling.
  //
  //     Samples from the explicit start through the effective end plus a small forward
  //     strike lookahead. Continuations should pass their own boundary overlap; implicit
  //     history is excluded so a dense capped window can make forward progress. Samples
  //     note events, crossings, and uniform steps no farther apart than 250ms, while
  //     keeping poses at each timestamp together under the total pose cap.
  //
  //     Active animator sessions are cached by (projectId, revision, profileId).
  //
  options = { ...(bool(options) ? (options) : ({  })) };
  start_time = _finite(start_time, 'start_time');
  end_time = _finite(end_time, 'end_time');
  if ((start_time < 0)) {
    throw ValueError('startTimeSeconds must be nonnegative');
  }
  if ((end_time <= start_time)) {
    throw ValueError('endTimeSeconds must be greater than startTimeSeconds');
  }
  if (((end_time - start_time) > 5.0)) {
    throw ValueError('Motion window must not exceed 5 seconds');
  }
  raw_max_poses = pyGet(options, 'maxPoses', 200);
  try {
    max_poses = Math.trunc(raw_max_poses);
  } catch (exc: any) {
    throw ValueError('maxPoses must be an integer from 1 through 500');
  }
  if ((bool((typeof raw_max_poses === 'boolean')) ? ((typeof raw_max_poses === 'boolean')) : ((bool((pyNotEq(max_poses, raw_max_poses))) ? ((pyNotEq(max_poses, raw_max_poses))) : ((bool((max_poses < 1)) ? ((max_poses < 1)) : ((max_poses > 500)))))))) {
    throw ValueError('maxPoses must be an integer from 1 through 500');
  }
  [profile_dto, profile_context] = _resolve_profile(pyGet(options, 'profile', null));
  profile_id = profile_dto['profileId'];
  project_id = String((bool(pyGet(options, 'projectId', null)) ? pyGet(options, 'projectId', null) : null) || (bool(document) ? pyGet(document, 'projectId', null) : null) || (bool(fingering_plan) ? pyGet(fingering_plan, 'projectId', null) : null) || 'default-project').trim();
  revision = Math.trunc(pyGet(options, 'revision', null) !== null ? pyGet(options, 'revision', null) : pyGet(document, 'revision', null) !== null ? pyGet(document, 'revision', null) : pyGet(fingering_plan, 'inputRevision', null) !== null ? pyGet(fingering_plan, 'inputRevision', null) : 0);
  session_key = [project_id, revision, profile_id];
  key_style = pyGet(options, 'keyStyle', 'realistic');
  if (((!pyIn(key_style, ['realistic', 'equal'])))) {
    throw ValueError('keyStyle must be realistic or equal');
  }
  rect_values = pyGet(options, 'keyboardRect', [0, 0, 1400, 150]);
  if ((bool((!bool(Array.isArray(rect_values)))) ? ((!bool(Array.isArray(rect_values)))) : ((pyNotEq((rect_values).length, 4))))) {
    throw ValueError('keyboardRect must be [x,y,w,h]');
  }
  keyboard_rect = new NumericRect(...Array.from(pyIter(rect_values)).map((v: any) => Math.trunc(v)));
  if ((pyIn(session_key, _active_animator_sessions))) {
    session = _active_animator_sessions[session_key];
    animators = session['animators'];
    planning_song = session['planning_song'];
    keyboard = new KeyboardGeometry(keyboard_rect, key_style);
  } else {
    if (bool((!bool(data)))) {
      throw ValueError(`No active animator session for ${session_key} and no MIDI data provided`);
    }
    source_bytes = (data instanceof Uint8Array ? data : new Uint8Array(data));
    fixture_id = String((bool(pyGet(options, 'fixtureId', null)) ? (pyGet(options, 'fixtureId', null)) : ('window-midi'))).trim();
    keyboard = new KeyboardGeometry(keyboard_rect, key_style);
    [decoded, cleanup] = midi_loader.read_midi(source_bytes);
    observed = identity.observe_source(source_bytes, decoded, fixture_id);
    source_notes = observed['sourceNotes'];
    source_event_map = {  };
    for (source of pyIter(source_notes)) {
      event = pyGet(observed['eventBySourceId'], source['noteId'], null);
      if (bool(event)) {
        source_event_map[[source['sourceInstrument'], source['sourceOrdinal']]] = event;
      }
    }
    fingering.reset_context(profile_context);
    song = midi_loader.load_midi(source_bytes, { fixture_id: fixture_id, source_event_map: source_event_map, pianist_context: profile_context, decoded: [decoded, [...cleanup]] });
    [desktop_notes, unmapped_source_ids, entry_by_object] = _map_desktop_notes(source_notes, song.notes, fixture_id);
    note_id_by_object = Object.fromEntries(Array.from(pyIter(pyItems(entry_by_object))).map(([identity, entry]: any) => [identity, entry['noteId']]));
    planning_song = song;
    if ((bool(document) && bool(fingering_plan))) {
      notes_by_id = Object.fromEntries(Array.from(pyIter(pyGet(document, 'notes', []))).filter((n: any) => (typeof n === 'object' && n !== null && !Array.isArray(n))).map((n: any) => [pyGet(n, 'noteId', null), n]));
      assignments_by_id = Object.fromEntries(Array.from(pyIter(pyGet(fingering_plan, 'assignments', []))).filter((a: any) => (typeof a === 'object' && a !== null && !Array.isArray(a))).map((a: any) => [pyGet(a, 'noteId', null), a]));
      updated_notes = [];
      for (note of pyIter(song.notes)) {
        nid = pyGet(note_id_by_object, pyId(note), null);
        doc_note = pyGet(notes_by_id, nid, null);
        assign = pyGet(assignments_by_id, nid, null);
        hand_val = (bool(assign) ? pyGet(assign, 'hand', null) : null) || (bool(doc_note) ? pyGet(doc_note, 'hand', null) : null) || (pyEq(note.hand, midi_loader.LEFT) ? 'left' : 'right');
        hand = ((pyEq(hand_val, 'left')) ? midi_loader.LEFT : midi_loader.RIGHT);
        raw_finger = (bool(assign) ? pyGet(assign, 'finger', null) : null) || (bool(doc_note) ? pyGet(doc_note, 'finger', null) : null);
        finger = (bool((typeof raw_finger === 'number' && Number.isInteger(raw_finger))) ? Math.trunc(raw_finger) : null);
        is_gliss = (bool((bool(assign) && ((pyEq(pyGet(assign, 'disposition', null), 'glissando'))))) ? ((bool(assign) && ((pyEq(pyGet(assign, 'disposition', null), 'glissando'))))) : ((bool(doc_note) && bool(pyGet(doc_note, 'glissando', false)))));
        disposition = (bool(assign) ? pyGet(assign, 'disposition', null) : null);
        edited_note = new Note(note.pitch, note.start, note.end, note.velocity, note.track, hand, finger, bool(is_gliss), note.source_ids, note.source_events);
        updated_notes.push([edited_note, nid, disposition]);
      }
      unplayable_ids = new Set(Array.from(pyIter(updated_notes)).filter(([_n, nid, disp]: any) => (pyEq(disp, 'unplayable'))).map(([_n, nid, disp]: any) => nid));
      planning_notes = Array.from(pyIter(updated_notes)).filter(([n, nid, _disp]: any) => ((!pyIn(nid, unplayable_ids)))).map(([n, nid, _disp]: any) => n);
      planning_song = new MidiSong(planning_notes, song.tracks, song.duration, song.bar_times, song.beat_times, song.path, song.raw_controls);
      planning_song.cleanup = [...song.cleanup];
    }
    animators = hands.build_hands(planning_song, { pianist: profile_context, key_style: key_style });
    _store_active_session(session_key, { ['animators']: animators, ['planning_song']: planning_song, ['keyboard']: keyboard, ['song']: song });
  }
  effective_end_time = end_time;
  truncated = false;
  continuation_time = null;
  manifest = EMBEDDED_MANIFEST;
  engine_version = String((bool(pyGet(options, 'engineVersion', null)) ? (pyGet(options, 'engineVersion', null)) : (_engine_version(manifest))));
  request_id = String((bool(pyGet(options, 'requestId', null)) ? (pyGet(options, 'requestId', null)) : (`motion-window/${project_id}/${revision}/${_rounded(start_time)}-${_rounded(effective_end_time)}`))).trim();
  lowest_key_left = keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left;
  if ((pyEq(max_poses, 1))) {
    raw_hand = ((pyIn(midi_loader.LEFT, animators)) ? midi_loader.LEFT : pyNext(pyIter(animators)));
    pose = animators[raw_hand].pose(start_time, keyboard);
    hand_key = ((pyEq(raw_hand, midi_loader.LEFT)) ? 'left' : 'right');
    single_pose = _motion_pose(pose, raw_hand, start_time, lowest_key_left, pose['ppi']);
    single_coverage = {  };
    for (animator_hand of pyIter(animators)) {
      coverage_hand = ((pyEq(animator_hand, midi_loader.LEFT)) ? 'left' : 'right');
      single_coverage[coverage_hand] = { ['coveredStartTimeSeconds']: _rounded(start_time), ['coveredEndTimeSeconds']: _rounded(start_time), ['isComplete']: false, ['poseCount']: ((pyEq(coverage_hand, hand_key)) ? 1 : 0) };
    }
    return { ['type']: 'sample-motion-result', ['requestId']: request_id, ['projectId']: project_id, ['revision']: revision, ['engineVersion']: engine_version, ['startTimeSeconds']: _rounded(start_time), ['endTimeSeconds']: _rounded(effective_end_time), ['poses']: [single_pose], ['coverage']: single_coverage, ['truncated']: true, ['continuationTimeSeconds']: _rounded(start_time) };
  }
  window_start = pyMax(0.0, start_time);
  window_end = pyMax(window_start, (effective_end_time + 0.2));
  sample_times = new Set();
  strike_dt = (1.0 / 60.0);
  for (animator of pyIter(pyValues(animators))) {
    for ([t, _notes] of pyIter(getattr(animator, 'groups', []))) {
      tf = Number(t);
      if (((window_start <= tf) && (tf <= window_end))) {
        sample_times.add(tf);
        if (((tf - strike_dt) >= window_start)) {
          sample_times.add((tf - strike_dt));
        }
        if (((tf + strike_dt) <= window_end)) {
          sample_times.add((tf + strike_dt));
        }
      }
    }
    for ([press, release, _n] of pyIter(getattr(animator, 'performance', []))) {
      pf = Number(press);
      if (((window_start <= pf) && (pf <= window_end))) {
        sample_times.add(pf);
        if (((pf - strike_dt) >= window_start)) {
          sample_times.add((pf - strike_dt));
        }
        if (((pf + strike_dt) <= window_end)) {
          sample_times.add((pf + strike_dt));
        }
      }
      rf = Number(release);
      if (((window_start <= rf) && (rf <= window_end))) {
        sample_times.add(rf);
      }
    }
  }
  episodes = hands.crossing_episodes(planning_song);
  for ([c_start, c_end, _top, _strength, _lead] of pyIter(episodes)) {
    cs = Number(c_start);
    ce = Number(c_end);
    if (((window_start <= cs) && (cs <= window_end))) {
      sample_times.add(cs);
    }
    if (((window_start <= ce) && (ce <= window_end))) {
      sample_times.add(ce);
    }
    mid = ((cs + ce) / 2.0);
    if (((window_start <= mid) && (mid <= window_end))) {
      sample_times.add(mid);
    }
  }
  grid_step = 0.25;
  curr_t = window_start;
  while ((curr_t <= window_end)) {
    sample_times.add(curr_t);
    curr_t = pyAugAdd(curr_t, grid_step);
  }
  sample_times.add(window_end);
  sample_times.add(start_time);
  sample_times.add(effective_end_time);
  sorted_times = pySorted(new Set(Array.from(pyIter(sample_times)).filter((t: any) => ((window_start <= t) && (t <= window_end))).map((t: any) => _rounded(t))), null, false);
  motion_poses = [];
  for (t of pyIter(sorted_times)) {
    poses_for_t = [];
    if ((pyEq(pyLen(animators), 2))) {
      sampled = {  };
      for (h of pyIter([midi_loader.RIGHT, midi_loader.LEFT])) {
        if ((pyIn(h, animators))) {
          p = animators[h].pose(t, keyboard);
          pyUpdate(p, { ['hand']: h, ['anim']: animators[h], ['song']: planning_song, ['t']: t });
          sampled[h] = p;
        }
      }
      paired = Array.from(pyIter([midi_loader.RIGHT, midi_loader.LEFT])).filter((h: any) => (pyIn(h, sampled))).map((h: any) => sampled[h]);
      arranged = ((pyEq((paired).length, 2)) ? hands.arrange_crossing(paired) : paired);
      for (pose of pyIter(arranged)) {
        poses_for_t.push(_motion_pose(pose, pose['hand'], t, lowest_key_left, pose['ppi']));
      }
    } else {
      for ([hand_name, animator] of pyIter(pyItems(animators))) {
        p = animator.pose(t, keyboard);
        poses_for_t.push(_motion_pose(p, hand_name, t, lowest_key_left, p['ppi']));
      }
    }
    if (((poses_for_t).length > max_poses)) {
      throw ValueError(`maxPoses=${max_poses} cannot fit a complete paired pose group of ${(poses_for_t).length}`);
    }
    if ((((motion_poses).length + (poses_for_t).length) > max_poses)) {
      truncated = true;
      continuation_time = _rounded(t);
      break;
    }
    motion_poses.push(...poses_for_t);
  }
  motion_poses.sort((a: any, b: any) => pyCmp([a['transportTimeSeconds'], a['hand']], [b['transportTimeSeconds'], b['hand']]));
  coverage = {  };
  for (raw_hand of pyIter(animators)) {
    hand_key = ((pyEq(raw_hand, midi_loader.LEFT)) ? 'left' : 'right');
    h_poses = Array.from(pyIter(motion_poses)).filter((p: any) => (pyEq(p['hand'], hand_key))).map((p: any) => p);
    if (bool((!bool(h_poses)))) {
      coverage[hand_key] = { ['coveredStartTimeSeconds']: _rounded(start_time), ['coveredEndTimeSeconds']: _rounded(start_time), ['isComplete']: false, ['poseCount']: 0 };
      continue;
    }
    h_times = Array.from(pyIter(h_poses)).map((p: any) => p['transportTimeSeconds']);
    continuous_end = h_times[0];
    has_gap = false;
    for (idx of pyIter(pyRange(((h_times).length - 1)))) {
      gap = (h_times[(idx + 1)] - h_times[idx]);
      if ((gap > 0.250001)) {
        continuous_end = h_times[idx];
        has_gap = true;
        break;
      }
      continuous_end = h_times[(idx + 1)];
    }
    is_complete = (((!bool(truncated))) && ((!bool(has_gap))) && ((h_times[0] <= (start_time + 0.0001))) && ((continuous_end >= (effective_end_time - 0.0001))));
    coverage[hand_key] = { ['coveredStartTimeSeconds']: _rounded(h_times[0]), ['coveredEndTimeSeconds']: _rounded(continuous_end), ['isComplete']: is_complete, ['poseCount']: (h_poses).length };
  }
  res = { ['type']: 'sample-motion-result', ['requestId']: request_id, ['projectId']: project_id, ['revision']: revision, ['engineVersion']: engine_version, ['startTimeSeconds']: _rounded(start_time), ['endTimeSeconds']: _rounded(effective_end_time), ['poses']: motion_poses, ['coverage']: coverage, ['truncated']: bool(truncated) };
  if ((continuation_time !== null)) {
    res['continuationTimeSeconds'] = continuation_time;
  }
  return res;
}
