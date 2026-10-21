"""Synchronous, serializable API used by one Worker batch job."""
from __future__ import annotations

import hashlib
import io
import json
import math
from dataclasses import replace
from pathlib import Path

from . import fingering, hands, identity, midi_loader, pianist
from .geometry import KeyboardGeometry, NumericRect

SCHEMA_VERSION = 1

_active_animator_sessions: dict[tuple[str, int, str], dict] = {}


def _store_active_session(key: tuple[str, int, str], session_data: dict) -> None:
    """Store active animator session, evicting previous sessions (A12)."""
    _active_animator_sessions.clear()
    _active_animator_sessions[key] = session_data


def _manifest():
    path = Path(__file__).with_name("source_manifest.json")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError("python-core source_manifest.json is missing; run package-python-core.mjs") from exc


def _engine_version(manifest):
    payload = json.dumps({"files": dict(sorted(manifest["files"].items()))},
                         sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _rounded(value, digits=8):
    result = round(float(value), digits)
    return 0.0 if result == 0 else result


def _finite(value, label):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    return number


_global_progress_callback = None


def set_progress_callback(callback):
    global _global_progress_callback
    _global_progress_callback = callback


def _report_progress(fraction: float, message: str):
    cb = _global_progress_callback
    if cb is not None:
        try:
            cb(float(fraction), str(message))
        except Exception:
            pass


def _default_profile_dto():
    p = pianist.default_pianist()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": pianist.DEFAULT_ID,
        "revision": 0,
        "name": p.name,
        "colorRgb": list(p.color),
        "anatomy": dict(p.anatomy),
        "behavior": dict(p.behavior),
        "skin": dict(p.skin),
        "weights": {},
        "createdAtUnixSeconds": 0.0,
        "modifiedAtUnixSeconds": 0.0,
    }


def _resolve_profile(value):
    profile = _default_profile_dto() if value is None else dict(value)
    required = ("schemaVersion", "profileId", "revision", "name", "colorRgb", "anatomy",
                "behavior", "skin", "weights", "createdAtUnixSeconds", "modifiedAtUnixSeconds")
    missing = [key for key in required if key not in profile]
    if missing:
        raise ValueError("profile DTO is missing: " + ", ".join(missing))
    if profile["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("unsupported profile schemaVersion")
    if int(profile["revision"]) < 0:
        raise ValueError("profile revision must be nonnegative")
    if not str(profile["profileId"]).strip() or not str(profile["name"]).strip():
        raise ValueError("profile identity and name must be nonempty")
    resolved = {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": str(profile["profileId"]),
        "revision": int(profile["revision"]),
        "name": str(profile["name"]),
        "colorRgb": [int(c) for c in profile["colorRgb"]],
        "anatomy": {str(k): _finite(v, f"profile.anatomy.{k}") for k, v in profile["anatomy"].items()},
        "behavior": pianist.normalize_behavior(profile["behavior"], strict=True),
        "skin": dict(profile["skin"]),
        "weights": {str(k): _finite(v, f"profile.weights.{k}") for k, v in profile["weights"].items()},
        "createdAtUnixSeconds": _finite(profile["createdAtUnixSeconds"], "profile.createdAtUnixSeconds"),
        "modifiedAtUnixSeconds": _finite(profile["modifiedAtUnixSeconds"], "profile.modifiedAtUnixSeconds"),
    }
    context = pianist.from_profile_dto(resolved)
    return resolved, context


def _empty_raw_baseline(fixture_id, input_hash, status, parse_errors, error=None):
    result = {
        "fixtureId": fixture_id,
        "inputSha256": input_hash,
        "status": status,
        "desktopNotes": [],
        "assignments": [],
        "performanceEvents": [],
        "pedals": [],
        "rawPedals": [],
        "selectedPoses": [],
        "cleanup": [],
        "sourceNotes": [],
        "sourcePedals": [],
        "sourceParseErrors": parse_errors,
        "unmappedSourceNoteIds": [],
        "tracks": [],
        "hands": [],
        "crossingEpisodes": [],
        "identityLosses": [],
        "identityMappings": [],
        "duration": 0.0,
        "goldenTrust": "observed-error; expected-invalid-fixture",
        "sourceNoteIdentitySemantics": (
            "IDs use instrument and note ordinals after PrettyMIDI decode. Raw SMF note-on/off locators are "
            "included only when the original message events were observed and uniquely matched."
        ),
    }
    if error is not None:
        result["loadError"] = error
    return result


def _map_desktop_notes(source_notes, song_notes, fixture_id):
    """Mirror the baseline join while preserving decoded IDs as stable aliases."""
    by_track_key, by_pitch_start = {}, {}
    for source in source_notes:
        by_pitch_start.setdefault((source["pitch"], round(source["start"], 5)), []).append(source)
        key = (source["sourceInstrument"], source["pitch"], round(source["start"], 5), source["velocity"])
        by_track_key.setdefault(key, []).append(source)
    output, used, by_object = [], set(), {}
    used_decoded = set()
    for note_index, note in enumerate(song_notes):
        signature = (note.track, note.pitch, round(note.start, 5), note.velocity)
        candidates = [item for item in by_track_key.get(signature, []) if item["noteId"] not in used]
        if not candidates:
            candidates = [item for item in source_notes if item["sourceInstrument"] == note.track
                          and abs(item["start"] - note.start) <= 0.005 and item["noteId"] not in used]
        if not candidates:
            candidates = [item for item in source_notes if abs(item["start"] - note.start) <= 0.005
                          and item["noteId"] not in used]
        candidates.sort(key=lambda item: (item["end"], -item["sourceInstrument"], -item["sourceOrdinal"]),
                        reverse=True)
        primary = candidates[0] if candidates else None
        if primary:
            used.add(primary["noteId"])
        matching = list(by_pitch_start.get((note.pitch, round(note.start, 5)), []))
        if not matching:
            matching = [item for item in source_notes if item["pitch"] == note.pitch
                        and abs(item["start"] - note.start) <= 0.005]
        source_ids = [item["noteId"] for item in matching]
        if not source_ids and note.source_ids:
            source_ids = list(note.source_ids)
        used.update(source_ids)
        stable_id = primary["noteId"] if primary else (
            source_ids[0] if source_ids else f"{fixture_id}/normalized/note-{note_index:06d}")
        entry = {
            "noteId": primary["noteId"] if primary else None,
            "stableNoteId": stable_id,
            "sourceNoteIds": source_ids,
            "pitch": int(note.pitch),
            "start": _rounded(note.start),
            "end": _rounded(note.end),
            "velocity": int(note.velocity),
            "track": int(note.track),
            "hand": note.hand,
            "manualFinger": int(note.finger) if isinstance(note.finger, int) else None,
            "gliss": bool(note.gliss),
        }
        output.append(entry)
        by_object[id(note)] = entry
        for source_id in note.source_ids:
            used_decoded.add(source_id)
    missing = sorted(item["noteId"] for item in source_notes if item["noteId"] not in used)
    return output, missing, by_object


def _profile_identity(profile, options, version):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "planId": "unused",
        "projectId": str(options["projectId"]),
        "inputRevision": int(options["revision"]),
        "profileId": profile["profileId"],
        "profileRevision": profile["revision"],
        "engineVersion": version,
        "diagnostics": [],
    }


def _serialize_pose(pose, hand_name, sample_time, rect):
    struct = pose["struct"]
    return {
        "hand": hand_name,
        "time": _rounded(sample_time),
        "layer": int(pose.get("layer", 0)),
        "coordinateFrame": {
            "units": "screen pixels",
            "keyboardRect": [int(rect.x), int(rect.y), int(rect.w), int(rect.h)],
            "origin": "top-left of keyboardRect",
            "axes": {"x": "right", "y": "down", "z": "up toward viewer"},
            "pixelsPerInch": _rounded(pose["ppi"]),
            "frontY": _rounded(pose["front_y"]),
        },
        "wristPose": {
            "positionPx": [_rounded(x) for x in pose["wrist"][:2]],
            "headingRadians": _rounded(pose["wrist"][2]),
        },
        "armEnd": [_rounded(x) for x in struct["arm_end"]],
        "fingerTips": {str(f): [_rounded(x) for x in struct["chains"][f][-1]] for f in range(1, 6)},
        "fingerChains": {
            str(f): [[_rounded(x) for x in point] for point in struct["chains"][f]] for f in range(1, 6)
        },
        "wristJoints": [[_rounded(x) for x in point] for point in struct["wrist"]],
        "bones": [
            {"type": kind, "start": [_rounded(x) for x in start], "end": [_rounded(x) for x in end]}
            for start, end, kind in pose["bones"]
        ],
        "joints": [{"type": kind, "position": [_rounded(x) for x in point]} for point, kind in pose["joints"]],
        "boneCount": len(pose["bones"]),
        "jointCount": len(pose["joints"]),
    }


def _selected_times(animator):
    if not animator.groups:
        return []
    attacks = [float(t) for t, _notes in animator.groups]
    chosen = [attacks[0], attacks[len(attacks) // 2], attacks[-1]]
    if len(attacks) > 1:
        chosen.append((attacks[0] + attacks[1]) / 2)
    return sorted(set(chosen))


def _motion_pose(pose, hand_name, sample_time, keyboard_left, ppi):
    def point(raw):
        return [_rounded((raw[0] - keyboard_left) / ppi), _rounded(raw[1] / ppi), _rounded(raw[2] / ppi)]

    return {
        "transportTimeSeconds": _rounded(sample_time),
        "hand": "left" if hand_name == midi_loader.LEFT else "right",
        "layerOrder": int(pose.get("layer", 0)),
        "bones": [
            {"a": point(start), "b": point(end), "kind": kind}
            for start, end, kind in pose["bones"]
        ],
        "joints": [{"point": point(p), "kind": kind} for p, kind in pose["joints"]],
    }


def _dedupe_serialized_motion_poses(poses):
    """Drop only identical poses whose timestamps collide after serialization."""
    unique = []
    by_hand_time = {}
    for pose in poses:
        key = (pose["transportTimeSeconds"], pose["hand"])
        previous = by_hand_time.get(key)
        if previous is None:
            by_hand_time[key] = pose
            unique.append(pose)
        elif previous != pose:
            raise ValueError("distinct motion poses collide at the same serialized hand/time")
    return unique


def _plan_id(kind, request_id):
    digest = hashlib.sha256(f"{kind}\0{request_id}".encode("utf-8")).hexdigest()[:24]
    return f"{kind}/{digest}"


def _same_json(left, right):
    """Compare JSON DTOs without relying on insertion order."""
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def _check_replan_document(expected, edited, plan, resource):
    if not isinstance(edited, dict) or not isinstance(plan, dict):
        raise ValueError("replan document and fingering plan must be JSON objects")
    if expected.keys() != edited.keys():
        raise ValueError("edited document must preserve the exact SongDocument fields")
    immutable_document_keys = (
        "schemaVersion", "projectId", "revision", "title", "durationSeconds",
        "sourceMidiResourceId", "tracks", "tempoMap", "pedalControls",
    )
    for key in immutable_document_keys:
        if not _same_json(expected.get(key), edited.get(key)):
            raise ValueError(f"edited document changed immutable source field {key}")
    if edited.get("sourceMidiResourceId") != resource.get("resourceId"):
        raise ValueError("edited document does not reference the original source resource")

    expected_notes = {note.get("noteId"): note for note in expected.get("notes", [])}
    edited_notes = {note.get("noteId"): note for note in edited.get("notes", [])}
    if len(expected_notes) != len(expected.get("notes", [])) or len(edited_notes) != len(edited.get("notes", [])):
        raise ValueError("document note IDs must be unique")
    if expected_notes.keys() != edited_notes.keys():
        raise ValueError("edited document must preserve every normalized note ID")
    for note_id, before in expected_notes.items():
        after = edited_notes[note_id]
        if before.keys() != after.keys():
            raise ValueError(f"edited note {note_id} must preserve its exact source fields")
        for key, value in before.items():
            if key not in ("hand", "finger", "glissando") and not _same_json(value, after.get(key)):
                raise ValueError(f"edited document changed source note field {key} for {note_id}")
        if after.get("hand") not in ("left", "right"):
            raise ValueError(f"edited document has invalid hand for {note_id}")
        if not isinstance(after.get("glissando"), bool):
            raise ValueError(f"edited document has invalid glissando state for {note_id}")
        finger = after.get("finger")
        if finger is not None and (not isinstance(finger, int) or finger < 1 or finger > 5):
            raise ValueError(f"edited document has invalid finger for {note_id}")

    assignments = plan.get("assignments")
    if not isinstance(assignments, list):
        raise ValueError("fingering plan assignments must be a list")
    assignments_by_id = {assignment.get("noteId"): assignment for assignment in assignments}
    if len(assignments_by_id) != len(assignments) or assignments_by_id.keys() != edited_notes.keys():
        raise ValueError("fingering plan must assign every edited document note exactly once")
    if plan.get("projectId") != edited.get("projectId") or plan.get("inputRevision") != edited.get("revision"):
        raise ValueError("fingering plan project/revision identity does not match the edited document")
    for note_id, assignment in assignments_by_id.items():
        note = edited_notes[note_id]
        disposition = assignment.get("disposition")
        if assignment.get("hand") != note.get("hand"):
            raise ValueError(f"fingering hand does not match edited document for {note_id}")
        finger_mode = assignment.get("fingerMode")
        if finger_mode not in (None, "manual", "automatic"):
            raise ValueError(f"invalid finger mode for {note_id}")
        gliss_mode = assignment.get("glissMode")
        if gliss_mode not in (None, "manual", "automatic"):
            raise ValueError(f"invalid gliss mode for {note_id}")
        if gliss_mode == "manual" and ((disposition == "glissando") != note.get("glissando")):
            raise ValueError(f"explicit gliss intent does not match the edited document for {note_id}")
        if finger_mode == "manual" and (disposition != "played" or note.get("finger") != assignment.get("finger")):
            raise ValueError(f"manual finger intent does not match the edited document for {note_id}")
        if finger_mode == "automatic" and note.get("finger") is not None:
            raise ValueError(f"automatic finger intent must clear the document finger for {note_id}")
        if disposition == "unplayable" and (
                finger_mode == "manual" or
                gliss_mode == "manual" and note.get("glissando")):
            raise ValueError(f"unplayable disposition conflicts with explicit note intent for {note_id}")
    return edited_notes, assignments_by_id


def _profile_diagnostics(diagnostics):
    return [dict(item) for item in diagnostics]


def analyze_midi(data: bytes, options: dict) -> dict:
    """Import, normalize, finger, schedule, and sample a MIDI in one job.

    ``data`` remains in memory and its SHA-256 is returned as a resource
    descriptor. No Python object identity is serialized.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("data must be bytes-like")
    options = dict(options or {})
    required = ("fixtureId", "projectId", "revision", "requestId", "engineVersion")
    missing = [key for key in required if key not in options]
    if missing:
        raise ValueError("options is missing: " + ", ".join(missing))
    fixture_id = str(options["fixtureId"]).strip()
    project_id = str(options["projectId"]).strip()
    request_id = str(options["requestId"]).strip()
    revision = int(options["revision"])
    if not fixture_id or not project_id or not request_id or revision < 0:
        raise ValueError("fixtureId, projectId, requestId must be nonempty and revision nonnegative")
    source_bytes = bytes(data)
    input_hash = hashlib.sha256(source_bytes).hexdigest()
    profile_dto, profile_context = _resolve_profile(options.get("profile"))
    manifest = _manifest()
    engine_version = _engine_version(manifest)
    options["engineVersion"] = engine_version
    key_style = options.get("keyStyle", "realistic")
    if key_style not in ("realistic", "equal"):
        raise ValueError("keyStyle must be realistic or equal")
    rect_values = options.get("keyboardRect", [0, 0, 1400, 150])
    if not isinstance(rect_values, (list, tuple)) or len(rect_values) != 4:
        raise ValueError("keyboardRect must be [x,y,w,h]")
    keyboard_rect = NumericRect(*[int(v) for v in rect_values])
    if keyboard_rect.w <= 0 or keyboard_rect.h <= 0:
        raise ValueError("keyboardRect width and height must be positive")
    requested_times = options.get("sampleTimes")
    if requested_times is not None:
        requested_times = [_finite(t, "sampleTimes entry") for t in requested_times]
        if len(requested_times) > 1000:
            raise ValueError("sampleTimes contains more than 1000 entries")

    resource_id = f"source-midi/{fixture_id}"
    resource = {
        "resourceId": resource_id,
        "purpose": "source-midi",
        "mediaType": "audio/midi",
        "byteLength": len(source_bytes),
        "sha256": input_hash,
        "path": "resources/source.mid",
    }
    common_result = {
        "requestId": request_id,
        "projectId": project_id,
        "revision": revision,
        "engineVersion": engine_version,
        "profile": profile_dto,
        "resource": resource,
    }

    diagnostics = []
    source_parse_errors = []
    try:
        decoded, cleanup = midi_loader.read_midi(source_bytes)
    except Exception as exc:
        parse_errors = [{"phase": "pretty_midi source inventory", "type": type(exc).__name__, "message": str(exc)}]
        raw_observation = identity.observe_source(source_bytes, None, fixture_id)
        parse_errors.extend(raw_observation.get("sourceParseErrors", []))
        error = {"type": type(exc).__name__, "message": str(exc)}
        raw = _empty_raw_baseline(fixture_id, input_hash, "invalid-or-rejected", parse_errors, error)
        diagnostics.append({"severity": "error", "code": "midi-load-failed", "message": str(exc) or type(exc).__name__})
        return {
            **common_result,
            "status": "invalid",
            "document": None,
            "fingeringPlan": None,
            "performancePlan": None,
            "motionPlan": None,
            "diagnostics": diagnostics,
            "rawBaseline": raw,
        }
    parser_cleanup = list(cleanup)

    # The baseline source inventory uses strict decoding of the original bytes.
    # A repaired PrettyMIDI is still used for the calculation, but never claimed
    # as a raw-source locator.
    source_pm = decoded
    source_decode_error = None
    if cleanup:
        try:
            import pretty_midi
            source_pm = pretty_midi.PrettyMIDI(io.BytesIO(source_bytes))
        except Exception as exc:
            source_pm = None
            source_decode_error = {"phase": "pretty_midi source inventory", "type": type(exc).__name__,
                                   "message": str(exc)}
            source_parse_errors.append(source_decode_error)
    observed = identity.observe_source(source_bytes, source_pm, fixture_id)
    source_parse_errors.extend(observed.get("sourceParseErrors", []))
    source_notes = observed["sourceNotes"]
    source_event_map = {}
    for source in source_notes:
        event = observed["eventBySourceId"].get(source["noteId"])
        if event:
            source_event_map[(source["sourceInstrument"], source["sourceOrdinal"])] = event

    # Once PrettyMIDI has accepted or repaired the bytes, subsequent failures
    # are compute/adapter failures. Let them propagate to the Worker as errors;
    # don't misclassify an implementation defect as invalid MIDI.
    fingering.reset_context(profile_context)
    song = midi_loader.load_midi(source_bytes, fixture_id=fixture_id,
                                 source_event_map=source_event_map,
                                 pianist_context=profile_context, decoded=(decoded, list(cleanup)))
    _report_progress(0.15, f"Loaded {len(song.notes)} notes; planning fingering...")

    desktop_notes, unmapped_source_ids, entry_by_object = _map_desktop_notes(source_notes, song.notes, fixture_id)
    aliases_by_note = {}
    note_id_by_object = {}
    document_notes = []
    tracks_by_index = {track.index: track for track in song.tracks}
    event_by_source_id = observed["eventBySourceId"]
    for index, note in enumerate(song.notes):
        entry = entry_by_object[id(note)]
        # The legacy join is retained only for rawBaseline's frozen desktop
        # comparator fields. Typed document identity comes from aliases that
        # midi_loader actually carried through normalization, never a
        # pitch/time proximity match.
        source_ids = list(dict.fromkeys(note.source_ids))
        note_id = (entry["noteId"] if entry["noteId"] in source_ids else
                   source_ids[0] if source_ids else f"{fixture_id}/normalized/note-{index:06d}")
        note_id_by_object[id(note)] = note_id
        for source_id in source_ids:
            aliases_by_note.setdefault(source_id, []).append(note_id)
        track = tracks_by_index[note.track]
        dto = {
            "noteId": note_id,
            "trackId": f"{fixture_id}/track-{track.index}",
            "pitch": int(note.pitch),
            "velocity": int(note.velocity),
            "startSeconds": _rounded(note.start),
            "endSeconds": _rounded(note.end),
            "hand": "left" if note.hand == midi_loader.LEFT else "right",
            "finger": int(note.finger) if isinstance(note.finger, int) else None,
            "glissando": bool(note.gliss),
        }
        if source_ids:
            dto["sourceNoteIds"] = source_ids
        if len(source_ids) == 1 and source_ids[0] in event_by_source_id:
            dto["sourceEvent"] = dict(event_by_source_id[source_ids[0]])
        document_notes.append(dto)

    # If one decoded source alias fans out to several normalized targets, an
    # event locator cannot truthfully belong to any one target. Suppress it at
    # every serialized boundary and diagnose the identity loss explicitly.
    ambiguous_alias_ids = {
        source_id for source_id, normalized_ids in aliases_by_note.items()
        if len(set(normalized_ids)) > 1
    }
    if ambiguous_alias_ids:
        for source_id in ambiguous_alias_ids:
            event_by_source_id.pop(source_id, None)
        for source in source_notes:
            if source["noteId"] in ambiguous_alias_ids:
                source.pop("sourceEvent", None)
        for note in document_notes:
            if any(source_id in ambiguous_alias_ids for source_id in note.get("sourceNoteIds", [])):
                note.pop("sourceEvent", None)

    track_dtos = []
    for track in song.tracks:
        source_items = [item for item in source_notes if item["sourceInstrument"] == track.index]
        locators = [event_by_source_id.get(item["noteId"]) for item in source_items]
        locators = [item for item in locators if item]
        raw_tracks = {item["midiTrackIndex"] for item in locators}
        raw_channels = {item["channel"] for item in locators}
        track_dto = {
            "trackId": f"{fixture_id}/track-{track.index}",
            "instrumentIndex": int(track.index),
            "name": str(track.name),
            "program": int(track.program),
            "hand": "left" if track.hand == midi_loader.LEFT else "right" if track.hand == midi_loader.RIGHT else None,
        }
        if len(raw_tracks) == 1 and len(locators) == len(source_items):
            track_dto["sourceMidiTrackIndex"] = next(iter(raw_tracks))
        if len(raw_channels) == 1 and len(locators) == len(source_items):
            track_dto["channel"] = next(iter(raw_channels))
        track_dtos.append(track_dto)

    tempo_times, tempi = decoded.get_tempo_changes()
    tempo_map = []
    for ordinal, (time_seconds, bpm) in enumerate(zip(tempo_times, tempi)):
        if bpm <= 0:
            continue
        tempo_map.append({"timeSeconds": _rounded(time_seconds),
                          "microsecondsPerQuarterNote": max(1, min(0xFFFFFF, int(round(60_000_000 / bpm)))),
                          "eventOrdinal": ordinal})
    if not tempo_map:
        tempo_map = [{"timeSeconds": 0.0, "microsecondsPerQuarterNote": 500000, "eventOrdinal": 0}]

    pedal_controls = [
        {"timeSeconds": _rounded(t), "controller": int(controller), "value": int(value), "eventOrdinal": ordinal}
        for ordinal, (t, controller, value) in enumerate(song.raw_controls)
    ]
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "projectId": project_id,
        "revision": revision,
        "title": song.title,
        "durationSeconds": _rounded(song.duration),
        "sourceMidiResourceId": resource_id,
        "tracks": track_dtos,
        "notes": document_notes,
        "tempoMap": tempo_map,
        "pedalControls": pedal_controls,
    }

    planning_song = song
    replan_context = options.get("_editorReplan")
    edited_assignments_by_id = {}
    if replan_context is not None:
        edited_document = replan_context.get("document")
        edited_plan = replan_context.get("fingeringPlan")
        edited_notes, edited_assignments = _check_replan_document(
            document, edited_document, edited_plan, replan_context.get("resource", {}),
        )
        edited_assignments_by_id = edited_assignments
        source_notes_by_id = {note_id_by_object[id(note)]: note for note in song.notes}
        if source_notes_by_id.keys() != edited_notes.keys():
            raise ValueError("replan document IDs do not map one-to-one to normalized source notes")

        updated_notes = []
        updated_entries = {}
        updated_note_ids = {}
        entry_by_id = {note_id_by_object[identity]: entry for identity, entry in entry_by_object.items()}
        for note_id, source_note in source_notes_by_id.items():
            dto = edited_notes[note_id]
            edited_note = replace(
                source_note,
                hand=midi_loader.LEFT if dto["hand"] == "left" else midi_loader.RIGHT,
                finger=dto["finger"],
                gliss=dto["glissando"],
            )
            updated_notes.append(edited_note)
            updated_entries[id(edited_note)] = entry_by_id[note_id]
            updated_note_ids[id(edited_note)] = note_id
        original_song = song
        song = midi_loader.MidiSong(
            updated_notes, original_song.tracks, original_song.duration,
            original_song.bar_times, original_song.beat_times,
            original_song.path, controls=original_song.raw_controls,
        )
        song.cleanup = list(original_song.cleanup)
        entry_by_object = updated_entries
        note_id_by_object = updated_note_ids
        document = edited_document

        unplayable_ids = {
            note_id for note_id, assignment in edited_assignments.items()
            if assignment["disposition"] == "unplayable"
        }
        planning_song = midi_loader.MidiSong(
            [note for note in song.notes if note_id_by_object[id(note)] not in unplayable_ids],
            song.tracks, song.duration, song.bar_times, song.beat_times,
            song.path, controls=song.raw_controls,
        )
        planning_song.cleanup = list(song.cleanup)

    animators = hands.build_hands(planning_song, pianist=profile_context, key_style=key_style)
    _report_progress(0.28, "Solving kinematics and scheduling rolled chords...")
    keyboard = KeyboardGeometry(keyboard_rect, style=key_style)
    _store_active_session((project_id, revision, profile_dto["profileId"]), {
        "animators": animators,
        "planning_song": planning_song,
        "keyboard": keyboard,
        "song": song,
    })
    assignments = []
    assignment_by_identity = {}
    gliss_ids = set()
    hands_summary = []
    performance_events = []
    for hand_name in (midi_loader.RIGHT, midi_loader.LEFT):
        animator = animators.get(hand_name)
        if animator is None:
            continue
        assignment_by_identity.update(animator.fingering)
        gliss_ids.update(animator.gliss_ids)
        hands_summary.append({
            "hand": hand_name,
            "assignedCount": len(animator.fingering),
            "rolledChords": int(animator.rolled),
            "glissRuns": [[_rounded(note.start) for note in run] for run in animator.gliss_runs],
        })
        for press, release, note in animator.performance:
            entry = entry_by_object[id(note)]
            performance_events.append({
                "noteId": entry["noteId"],
                "sourceNoteIds": entry["sourceNoteIds"],
                "hand": hand_name,
                "press": _rounded(press),
                "release": _rounded(release),
            })
    performance_events.sort(key=lambda event: (event["press"], event["hand"], event["noteId"] or ""))

    for note in song.notes:
        entry = entry_by_object[id(note)]
        finger = assignment_by_identity.get(id(note))
        assignments.append({
            "noteId": entry["noteId"],
            "sourceNoteIds": entry["sourceNoteIds"],
            "hand": note.hand,
            "finger": int(finger) if isinstance(finger, int) else None,
            "manualFinger": int(note.finger) if isinstance(note.finger, int) else None,
            "gliss": bool(note.gliss),
        })
    assignments.sort(key=lambda item: (item["noteId"] or "", item["hand"]))

    crossing_episodes = hands.crossing_episodes(planning_song)
    ambiguous_normalized_ids = sorted({
        normalized_id for source_id in observed.get("ambiguousSourceIds", [])
        for normalized_id in aliases_by_note.get(source_id, [])
    })
    ambiguous_normalized_ids = sorted(set(ambiguous_normalized_ids).union(
        normalized_id for source_id in ambiguous_alias_ids
        for normalized_id in aliases_by_note.get(source_id, [])
    ))
    for normalized_id in ambiguous_normalized_ids:
        diagnostics.append({"severity": "warning", "code": "source-event-ambiguous",
                            "message": "Raw SMF event locator is ambiguous; decoded note identity is retained without a locator.",
                            "noteIds": [normalized_id]})
    ambiguous_source_ids = sorted(
        set(observed.get("ambiguousSourceIds", [])) | ambiguous_alias_ids
    )
    ambiguous_source_identity_diagnostic = ({
            "severity": "warning",
            "code": "source-identity-ambiguous",
            "message": "Decoded source-note identities have ambiguous event or normalized-note mappings; see the raw identity mappings for affected source IDs.",
            "noteIds": ambiguous_source_ids,
        } if ambiguous_source_ids else None)
    for note in song.notes:
        if id(note) not in assignment_by_identity and id(note) not in gliss_ids:
            normalized_id = note_id_by_object[id(note)]
            diagnostics.append({"severity": "warning", "code": "note-unplayable",
                                "message": "Fingering planner did not assign a playable finger to this note.",
                                "noteIds": [normalized_id]})
    if parser_cleanup:
        diagnostics.append({"severity": "info", "code": "midi-repaired",
                            "message": parser_cleanup[0]})
    diagnostics.extend({"severity": "warning", "code": "source-parse-warning",
                        "message": f"{item['phase']}: {item['type']}: {item['message']}".rstrip()}
                       for item in source_parse_errors)

    profile_id, profile_revision = profile_dto["profileId"], profile_dto["revision"]
    common_plan = {
        "schemaVersion": SCHEMA_VERSION,
        "projectId": project_id,
        "inputRevision": revision,
        "profileId": profile_id,
        "profileRevision": profile_revision,
        "engineVersion": engine_version,
        "diagnostics": _profile_diagnostics(diagnostics),
    }
    assignment_dtos = []
    for note in song.notes:
        note_id = note_id_by_object[id(note)]
        finger = assignment_by_identity.get(id(note))
        if id(note) in gliss_ids:
            disposition = "glissando"
            finger = None
        elif isinstance(finger, int):
            disposition = "played"
        else:
            disposition = "unplayable"
            finger = None
        assignment_dto = {
            "noteId": note_id,
            "hand": "left" if note.hand == midi_loader.LEFT else "right",
            "finger": int(finger) if isinstance(finger, int) else None,
            "disposition": disposition,
        }
        edited_intent = edited_assignments_by_id.get(note_id)
        if edited_intent is not None:
            for intent_key in ("fingerMode", "glissMode"):
                if intent_key in edited_intent:
                    assignment_dto[intent_key] = edited_intent[intent_key]
        assignment_dtos.append(assignment_dto)
    fingering_plan = {
        **common_plan, "planId": _plan_id("fingering", request_id), "kind": "fingering",
        "assignments": assignment_dtos,
    }

    performance_plan_events = []
    for animator in animators.values():
        for press, release, note in animator.performance:
            note_id = note_id_by_object[id(note)]
            performance_plan_events.append((release, 0, {"type": "release", "timeSeconds": _rounded(release),
                                                          "noteId": note_id}))
            performance_plan_events.append((press, 2, {"type": "press", "timeSeconds": _rounded(press),
                                                        "noteId": note_id, "pitch": int(note.pitch),
                                                        "velocity": int(note.velocity)}))
    for time_seconds, controller, value in song.controls:
        performance_plan_events.append((time_seconds, 1, {"type": "pedal", "timeSeconds": _rounded(time_seconds),
                                                           "controller": int(controller), "value": int(value)}))
    performance_plan_events.sort(key=lambda item: (item[0], item[1]))
    performance_plan = {
        **common_plan, "planId": _plan_id("performance", request_id), "kind": "performance",
        "fingeringPlanId": fingering_plan["planId"],
        "events": [event for _, _, event in performance_plan_events],
    }

    if requested_times is None:
        # Persist only canonical sparse controls in rawBaseline/motionPlan.
        # Playback density is returned separately in initialMotionWindow below,
        # so ordinary opens never create a full-duration dense plan.
        common_sample_times = set()
        if len(animators) == 2:
            for animator in animators.values():
                common_sample_times.update(_selected_times(animator))
            for start, end, _top, _strength, _lead in crossing_episodes:
                common_sample_times.add(float(start))
                if end > start:
                    common_sample_times.add(float((start + end) / 2))
        sample_times_by_hand = {
            hand_name: sorted(common_sample_times) if common_sample_times else _selected_times(animator)
            for hand_name, animator in animators.items()
        }
    else:
        shared = sorted(set(requested_times))
        sample_times_by_hand = {hand_name: shared for hand_name in animators}

    sampled, raw_poses, motion_poses = {}, [], []
    total_samples = sum(len(times) for times in sample_times_by_hand.values())
    solved_count = 0
    report_step = max(1, total_samples // 40)
    for hand_name, animator in animators.items():
        for sample_time in sample_times_by_hand[hand_name]:
            pose = animator.pose(sample_time, keyboard)
            if len(animators) == 2:
                pose.update({"hand": hand_name, "anim": animator, "song": planning_song, "t": sample_time})
            else:
                pose["hand"] = hand_name
            sampled[(hand_name, sample_time)] = pose
            solved_count += 1
            if solved_count % report_step == 0 or solved_count == total_samples:
                frac = 0.38 + 0.56 * (solved_count / max(1, total_samples))
                _report_progress(frac, f"Calculating hand poses: {solved_count}/{total_samples} ({int(frac * 100)}%)")

    _report_progress(0.96, "Arranging hand crossings and finalizing motion plan...")
    if len(animators) == 2:
        for sample_time in sorted(set(t for times in sample_times_by_hand.values() for t in times)):
            paired = [sampled[(hand_name, sample_time)] for hand_name in animators
                      if (hand_name, sample_time) in sampled]
            arranged = hands.arrange_crossing(paired) if len(paired) == 2 else paired
            for pose in arranged:
                hand_name = pose["hand"]
                raw_poses.append(_serialize_pose(pose, hand_name, sample_time, keyboard.rect))
                motion_poses.append(_motion_pose(pose, hand_name, sample_time,
                                                  keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left,
                                                  pose["ppi"]))
    else:
        for (hand_name, sample_time), pose in sampled.items():
            raw_poses.append(_serialize_pose(pose, hand_name, sample_time, keyboard.rect))
            motion_poses.append(_motion_pose(pose, hand_name, sample_time,
                                              keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left,
                                              pose["ppi"]))
    raw_poses.sort(key=lambda item: (item["time"], item["hand"]))
    motion_poses.sort(key=lambda item: (item["transportTimeSeconds"], item["hand"]))
    motion_poses = _dedupe_serialized_motion_poses(motion_poses)
    motion_plan = None
    if motion_poses:
        motion_plan = {
            **common_plan, "planId": _plan_id("motion", request_id), "kind": "motion",
            "performancePlanId": performance_plan["planId"],
            "coordinateFrame": "keyboard-local-inches-v1",
            "poses": motion_poses,
        }
    _store_active_session((project_id, revision, profile_dto["profileId"]), {
        "animators": animators,
        "planning_song": planning_song,
        "keyboard": keyboard,
        "song": song,
    })

    raw_pedals = [{"time": _rounded(t), "controller": int(c), "value": int(v)}
                  for t, c, v in song.raw_controls]
    pedals = [{"time": _rounded(t), "controller": int(c), "value": int(v)}
              for t, c, v in song.controls]
    identity_mappings = []
    for source in source_notes:
        source_id = source["noteId"]
        normalized = sorted(set(aliases_by_note.get(source_id, [])))
        raw = event_by_source_id.get(source_id)
        if source_id in observed.get("ambiguousSourceIds", []) or source_id in ambiguous_alias_ids or len(normalized) > 1:
            status = "ambiguous"
        elif not normalized:
            status = "unmapped"
        elif not raw:
            status = "decoded-only"
        elif any(len(source_ids_for([note_id], document_notes)) > 1 for note_id in normalized):
            status = "merged"
        else:
            status = "exact"
        raw_events = [dict(raw)] if raw and status in ("exact", "merged") else []
        if not raw_events:
            # The raw event may still be observable for a decoded note that
            # sanitation drops (for example, percussion in a piano score).
            # Keep its decoded source identity, but do not expose that locator
            # as a normalized mapping the document cannot represent.
            source.pop("sourceEvent", None)
        identity_mappings.append({
            "noteId": source_id,
            "sourceInstrument": source["sourceInstrument"],
            "sourceOrdinal": source["sourceOrdinal"],
            "rawEvents": raw_events,
            "normalizedNoteId": normalized[0] if len(normalized) == 1 else None,
            "status": status,
        })
    identity_losses = [{"normalizedNoteId": item["noteId"], "sourceNoteIds": item["sourceNoteIds"]}
                       for item in desktop_notes if len(item["sourceNoteIds"]) > 1]
    raw_status = "repaired" if parser_cleanup else "loaded"
    raw_baseline = {
        "fixtureId": fixture_id,
        "inputSha256": input_hash,
        "status": raw_status,
        "duration": _rounded(song.duration),
        "sourceNotes": source_notes,
        "sourceParseErrors": source_parse_errors,
        "desktopNotes": [{key: item[key] for key in ("noteId", "sourceNoteIds", "pitch", "start", "end",
                                                       "velocity", "track", "hand", "manualFinger", "gliss")}
                          for item in desktop_notes],
        "unmappedSourceNoteIds": unmapped_source_ids,
        "sourcePedals": observed["sourcePedals"],
        "rawPedals": raw_pedals,
        "pedals": pedals,
        "tracks": [{"index": int(track.index), "name": track.name, "program": int(track.program),
                    "noteCount": int(track.note_count), "declaredHand": track.hand} for track in song.tracks],
        "assignments": assignments,
        "performanceEvents": performance_events,
        "hands": hands_summary,
        "crossingEpisodes": [{"start": _rounded(start), "end": _rounded(end), "topHand": top,
                               "strength": _rounded(strength), "lead": _rounded(lead)}
                              for start, end, top, strength, lead in crossing_episodes],
        "selectedPoses": raw_poses,
        "cleanup": list(song.cleanup),
        "identityLosses": identity_losses,
        "identityMappings": identity_mappings,
        "sourceNoteIdentitySemantics": (
            "Stable IDs use instrument and note ordinals after PrettyMIDI decode. Raw SMF note-on/off "
            "event locators are attached only when the original events are observed and uniquely matched; "
            "ambiguous pitch/time matches are not guessed."
        ),
        "goldenTrust": (
            "observed salvage; source was deliberately truncated and desktop repair dropped or fixed an event"
            if cleanup else
            "desktop-observation with source identity loss; decoded source aliases are explicit; "
            "raw-event mapping is omitted where ambiguous; this is not an independent correctness oracle"
            if identity_losses else
            "desktop-observation; decoded source IDs are stable ordinals, raw event locators are conservative; "
            "this is not an independent correctness oracle"
        ),
        "provenance": {
            "profile": "explicit per-job PianistProfile DTO" if options.get("profile") else "deterministic built-in default profile",
            "engineVersion": engine_version,
            "desktopSourceCommit": manifest.get("desktopSourceCommit"),
            "desktopVersion": manifest.get("desktopVersion"),
            "adaptedFiles": manifest["files"],
            "keyStyle": key_style,
            "rawEventCount": observed.get("rawEventCount", 0),
        },
    }

    initial_motion_window = None
    if fixture_id == "imported-midi" or options.get("sampleDense", False):
        initial_end = min(4.0, float(song.duration))
        if initial_end > 0.0:
            # Startup playback gets a bounded, explicitly covered window. The
            # result is runtime metadata; canonical rawBaseline samples above
            # remain sparse and unchanged.
            sampled_window = sample_motion_window(
                b"", None, None, 0.0, initial_end,
                {
                    "projectId": project_id,
                    "revision": revision,
                    "requestId": request_id + "/initial-motion",
                    "engineVersion": engine_version,
                    "profile": profile_dto,
                    "keyStyle": key_style,
                    "keyboardRect": [int(v) for v in rect_values],
                    "maxPoses": 200,
                },
            )
            initial_motion_window = {
                key: sampled_window[key]
                for key in (
                    "startTimeSeconds", "endTimeSeconds", "poses", "coverage",
                    "truncated", "continuationTimeSeconds",
                )
                if key in sampled_window
            }

    if ambiguous_source_identity_diagnostic is not None:
        # These noteIds name decoded source identities, which can be absent
        # from the normalized SongDocument. Keep the diagnostic at the result
        # level so plan diagnostics remain constrained to document note IDs.
        diagnostics.append(ambiguous_source_identity_diagnostic)
    _report_progress(1.0, "Analysis complete.")
    return {
        **common_result,
        "status": raw_status,
        "document": document,
        "fingeringPlan": fingering_plan,
        "performancePlan": performance_plan,
        "motionPlan": motion_plan,
        **({"initialMotionWindow": initial_motion_window} if initial_motion_window is not None else {}),
        "diagnostics": diagnostics,
        "rawBaseline": raw_baseline,
    }


def replan_document(data: bytes, document: dict, fingering_plan: dict, options: dict) -> dict:
    """Recompute performance and motion from original bytes plus typed edits.

    The normalized source is decoded again, then edited note intents are joined
    only by the document's persistent note IDs. No MIDI export/reimport or
    pitch/time proximity matching participates in the replan.
    """
    options = dict(options or {})
    required = ("fixtureId", "projectId", "revision", "requestId", "engineVersion",
                "profile", "keyStyle", "resource", "rawBaseline")
    missing = [key for key in required if key not in options]
    if missing:
        raise ValueError("options is missing: " + ", ".join(missing))
    source_bytes = bytes(data)
    resource = options["resource"]
    baseline = options["rawBaseline"]
    if not isinstance(resource, dict) or not isinstance(baseline, dict):
        raise ValueError("resource and rawBaseline must be JSON objects")
    if resource.get("purpose") != "source-midi" or resource.get("mediaType") != "audio/midi":
        raise ValueError("replan resource must describe source MIDI")
    if resource.get("path") != "resources/source.mid" or resource.get("byteLength") != len(source_bytes):
        raise ValueError("source resource path or byteLength does not match the original bytes")
    actual_hash = hashlib.sha256(source_bytes).hexdigest()
    if resource.get("sha256") != actual_hash or baseline.get("inputSha256") != actual_hash:
        raise ValueError("source resource checksum does not match the original bytes")
    if baseline.get("fixtureId") != options["fixtureId"] or baseline.get("status") not in ("loaded", "repaired"):
        raise ValueError("rawBaseline must be the successful source observation for this fixture")
    if document.get("sourceMidiResourceId") != resource.get("resourceId"):
        raise ValueError("edited document does not reference the source MIDI resource")
    if document.get("projectId") != options["projectId"] or document.get("revision") != int(options["revision"]):
        raise ValueError("edited document identity does not match the replan request")
    if fingering_plan.get("projectId") != options["projectId"] or fingering_plan.get("inputRevision") != int(options["revision"]):
        raise ValueError("fingering plan identity does not match the replan request")
    profile_id = str(options["profile"].get("profileId", ""))
    profile_revision = int(options["profile"].get("revision", -1))
    if (fingering_plan.get("profileId") != profile_id or
            fingering_plan.get("profileRevision") != profile_revision):
        raise ValueError("fingering plan profile identity does not match the request")

    # Replans are tied to the currently packaged engine source. Derive the
    # version here just as analyze_midi does; there is no local variable from
    # a prior Worker request to trust.
    options["engineVersion"] = _engine_version(_manifest())

    analyze_options = {key: value for key, value in options.items() if key not in ("resource", "rawBaseline")}
    # Replans feed the active player too, so return a fresh bounded startup
    # window for this edited revision instead of leaving stale motion on screen.
    analyze_options.setdefault("sampleDense", True)
    analyze_options["_editorReplan"] = {
        "document": document,
        "fingeringPlan": fingering_plan,
        "resource": resource,
    }
    result = analyze_midi(source_bytes, analyze_options)
    if result["status"] == "invalid":
        raise ValueError("original source MIDI no longer loads for typed replan")
    if not _same_json(result["document"], document):
        raise ValueError("replan did not preserve the edited SongDocument")
    if not _same_json(result["resource"], resource):
        raise ValueError("replan source descriptor changed")
    result["rawBaseline"] = baseline
    result["keyStyle"] = options["keyStyle"]
    return result


def source_ids_for(normalized_ids, document_notes):
    wanted = set(normalized_ids)
    return [note_id for note_id in wanted for note in document_notes
            if note["noteId"] == note_id for note_id in note.get("sourceNoteIds", [])]


def export_fingered_midi(data: bytes, document: dict, fingering_plan: dict) -> dict:
    """Takes original MIDI bytes, SongDocument DTO, and FingeringPlan DTO.
    Maps FingeringPlan.assignments to note objects.
    Calls save_fingered_midi_bytes.
    Returns: {"exportedBytes": exported_bytes, "markedCount": count}.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("data must be bytes-like")
    if not isinstance(document, dict) or not isinstance(fingering_plan, dict):
        raise TypeError("document and fingering_plan must be dicts")

    notes_dto = document.get("notes", [])
    assignments = {a["noteId"]: a for a in fingering_plan.get("assignments", []) if "noteId" in a}

    notes = []
    fingers = {}
    note_ids = {}
    for note_dto in notes_dto:
        nid = note_dto.get("noteId")
        assign = assignments.get(nid)
        hand_val = assign.get("hand") if assign and "hand" in assign else note_dto.get("hand", "right")
        hand = midi_loader.LEFT if hand_val in ("left", midi_loader.LEFT) else midi_loader.RIGHT

        disposition = assign.get("disposition") if assign else ("glissando" if note_dto.get("glissando") else "played")
        if disposition == "glissando":
            is_gliss = True
            finger = 'g'
        elif disposition == "unplayable":
            is_gliss = False
            finger = None
        else:
            is_gliss = bool(assign.get("glissando", note_dto.get("glissando", False)))
            raw_finger = assign.get("finger") if assign and "finger" in assign else note_dto.get("finger")
            finger = int(raw_finger) if raw_finger is not None else None

        note_obj = midi_loader.Note(
            pitch=int(note_dto["pitch"]),
            start=float(note_dto["startSeconds"]),
            end=float(note_dto["endSeconds"]),
            velocity=int(note_dto.get("velocity", 64)),
            track=0,
            hand=hand,
            finger=finger if isinstance(finger, int) else None,
            gliss=is_gliss,
        )
        notes.append(note_obj)
        fingers[id(note_obj)] = finger
        if nid is not None:
            note_ids[id(note_obj)] = nid

    exported_bytes, marked_count, diagnostics = midi_loader.save_fingered_midi_bytes(bytes(data), notes, fingers, note_ids)
    return {
        "exportedBytes": exported_bytes,
        "markedCount": marked_count,
        "diagnostics": diagnostics,
    }


def sample_motion_window(
    data: bytes,
    document: dict | None,
    fingering_plan: dict | None,
    start_time: float,
    end_time: float,
    options: dict | None = None,
) -> dict:
    """Bounded motion lookahead buffer sampling.

    Samples from the explicit start through the effective end plus a small forward
    strike lookahead. Continuations should pass their own boundary overlap; implicit
    history is excluded so a dense capped window can make forward progress. Samples
    note events, crossings, and uniform steps no farther apart than 250ms, while
    keeping poses at each timestamp together under the total pose cap.

    Active animator sessions are cached by (projectId, revision, profileId).
    """
    options = dict(options or {})
    start_time = _finite(start_time, "start_time")
    end_time = _finite(end_time, "end_time")
    if start_time < 0:
        raise ValueError("startTimeSeconds must be nonnegative")
    if end_time <= start_time:
        raise ValueError("endTimeSeconds must be greater than startTimeSeconds")
    if end_time - start_time > 5.0:
        raise ValueError("Motion window must not exceed 5 seconds")

    raw_max_poses = options.get("maxPoses", 200)
    try:
        max_poses = int(raw_max_poses)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("maxPoses must be an integer from 1 through 500") from exc
    if isinstance(raw_max_poses, bool) or max_poses != raw_max_poses or max_poses < 1 or max_poses > 500:
        raise ValueError("maxPoses must be an integer from 1 through 500")

    profile_dto, profile_context = _resolve_profile(options.get("profile"))
    profile_id = profile_dto["profileId"]
    project_id = str(options.get("projectId") or (document and document.get("projectId")) or (fingering_plan and fingering_plan.get("projectId")) or "default-project").strip()
    revision = int(options.get("revision") if options.get("revision") is not None else (document and document.get("revision")) if (document and document.get("revision") is not None) else (fingering_plan and fingering_plan.get("inputRevision")) if (fingering_plan and fingering_plan.get("inputRevision") is not None) else 0)
    session_key = (project_id, revision, profile_id)

    key_style = options.get("keyStyle", "realistic")
    if key_style not in ("realistic", "equal"):
        raise ValueError("keyStyle must be realistic or equal")

    rect_values = options.get("keyboardRect", [0, 0, 1400, 150])
    if not isinstance(rect_values, (list, tuple)) or len(rect_values) != 4:
        raise ValueError("keyboardRect must be [x,y,w,h]")
    keyboard_rect = NumericRect(*[int(v) for v in rect_values])

    if session_key in _active_animator_sessions:
        session = _active_animator_sessions[session_key]
        animators = session["animators"]
        planning_song = session["planning_song"]
        keyboard = KeyboardGeometry(keyboard_rect, style=key_style)
    else:
        if not data:
            raise ValueError(f"No active animator session for {session_key} and no MIDI data provided")
        source_bytes = bytes(data)
        fixture_id = str(options.get("fixtureId") or "window-midi").strip()
        keyboard = KeyboardGeometry(keyboard_rect, style=key_style)

        decoded, cleanup = midi_loader.read_midi(source_bytes)
        observed = identity.observe_source(source_bytes, decoded, fixture_id)
        source_notes = observed["sourceNotes"]
        source_event_map = {}
        for source in source_notes:
            event = observed["eventBySourceId"].get(source["noteId"])
            if event:
                source_event_map[(source["sourceInstrument"], source["sourceOrdinal"])] = event

        fingering.reset_context(profile_context)
        song = midi_loader.load_midi(
            source_bytes,
            fixture_id=fixture_id,
            source_event_map=source_event_map,
            pianist_context=profile_context,
            decoded=(decoded, list(cleanup)),
        )
        desktop_notes, unmapped_source_ids, entry_by_object = _map_desktop_notes(source_notes, song.notes, fixture_id)
        note_id_by_object = {identity: entry["noteId"] for identity, entry in entry_by_object.items()}
        planning_song = song

        if document and fingering_plan:
            notes_by_id = {n.get("noteId"): n for n in document.get("notes", []) if isinstance(n, dict)}
            assignments_by_id = {a.get("noteId"): a for a in fingering_plan.get("assignments", []) if isinstance(a, dict)}
            updated_notes = []
            for note in song.notes:
                nid = note_id_by_object.get(id(note))
                doc_note = notes_by_id.get(nid)
                assign = assignments_by_id.get(nid)
                hand_val = (assign and assign.get("hand")) or (doc_note and doc_note.get("hand")) or ("left" if note.hand == midi_loader.LEFT else "right")
                hand = midi_loader.LEFT if hand_val == "left" else midi_loader.RIGHT
                raw_finger = (assign and assign.get("finger")) or (doc_note and doc_note.get("finger"))
                finger = int(raw_finger) if isinstance(raw_finger, int) else None
                is_gliss = (assign and assign.get("disposition") == "glissando") or (doc_note and doc_note.get("glissando", False))
                disposition = assign.get("disposition") if assign else None
                edited_note = replace(
                    note,
                    hand=hand,
                    finger=finger,
                    gliss=bool(is_gliss),
                )
                updated_notes.append((edited_note, nid, disposition))

            unplayable_ids = {nid for _n, nid, disp in updated_notes if disp == "unplayable"}
            planning_notes = [n for n, nid, _disp in updated_notes if nid not in unplayable_ids]
            planning_song = midi_loader.MidiSong(
                planning_notes, song.tracks, song.duration, song.bar_times, song.beat_times,
                song.path, controls=song.raw_controls,
            )
            planning_song.cleanup = list(song.cleanup)

        animators = hands.build_hands(planning_song, pianist=profile_context, key_style=key_style)
        _store_active_session(session_key, {
            "animators": animators,
            "planning_song": planning_song,
            "keyboard": keyboard,
            "song": song,
        })

    effective_end_time = end_time
    truncated = False
    continuation_time: float | None = None

    manifest = _manifest()
    engine_version = str(options.get("engineVersion") or _engine_version(manifest))
    request_id = str(options.get("requestId") or f"motion-window/{project_id}/{revision}/{_rounded(start_time)}-{_rounded(effective_end_time)}").strip()
    lowest_key_left = keyboard.key_rects[midi_loader.LOWEST_PIANO_KEY].left

    # A13: maxPoses=1 returns single pose at window start, left-hand priority, without full coverage claim
    if max_poses == 1:
        raw_hand = midi_loader.LEFT if midi_loader.LEFT in animators else next(iter(animators))
        pose = animators[raw_hand].pose(start_time, keyboard)
        hand_key = "left" if raw_hand == midi_loader.LEFT else "right"
        single_pose = _motion_pose(pose, raw_hand, start_time, lowest_key_left, pose["ppi"])
        single_coverage = {}
        for animator_hand in animators:
            coverage_hand = "left" if animator_hand == midi_loader.LEFT else "right"
            single_coverage[coverage_hand] = {
                "coveredStartTimeSeconds": _rounded(start_time),
                "coveredEndTimeSeconds": _rounded(start_time),
                "isComplete": False,
                "poseCount": 1 if coverage_hand == hand_key else 0,
            }
        return {
            "type": "sample-motion-result",
            "requestId": request_id,
            "projectId": project_id,
            "revision": revision,
            "engineVersion": engine_version,
            "startTimeSeconds": _rounded(start_time),
            "endTimeSeconds": _rounded(effective_end_time),
            "poses": [single_pose],
            "coverage": single_coverage,
            "truncated": True,
            "continuationTimeSeconds": _rounded(start_time),
        }

    # Window starts are explicit. The caller supplies a small boundary overlap
    # when needed; excluding implicit history prevents dense continuations from
    # spending the pose budget on already-returned groups.
    window_start = max(0.0, start_time)
    window_end = max(window_start, effective_end_time + 0.2)

    sample_times: set[float] = set()

    # 1. Attacks and note events in [window_start, window_end] with 60Hz key strikes
    strike_dt = 1.0 / 60.0
    for animator in animators.values():
        for t, _notes in getattr(animator, "groups", []):
            tf = float(t)
            if window_start <= tf <= window_end:
                sample_times.add(tf)
                if tf - strike_dt >= window_start:
                    sample_times.add(tf - strike_dt)
                if tf + strike_dt <= window_end:
                    sample_times.add(tf + strike_dt)
        for press, release, _n in getattr(animator, "performance", []):
            pf = float(press)
            if window_start <= pf <= window_end:
                sample_times.add(pf)
                if pf - strike_dt >= window_start:
                    sample_times.add(pf - strike_dt)
                if pf + strike_dt <= window_end:
                    sample_times.add(pf + strike_dt)
            rf = float(release)
            if window_start <= rf <= window_end:
                sample_times.add(rf)

    # Crossing episodes in [window_start, window_end]
    episodes = hands.crossing_episodes(planning_song)
    for c_start, c_end, _top, _strength, _lead in episodes:
        cs = float(c_start)
        ce = float(c_end)
        if window_start <= cs <= window_end:
            sample_times.add(cs)
        if window_start <= ce <= window_end:
            sample_times.add(ce)
        mid = (cs + ce) / 2.0
        if window_start <= mid <= window_end:
            sample_times.add(mid)

    # 2. Lazy uniform intermediate steps (at least every 0.25s) within requested window only (A11)
    grid_step = 0.25
    curr_t = window_start
    while curr_t <= window_end:
        sample_times.add(curr_t)
        curr_t += grid_step
    sample_times.add(window_end)
    sample_times.add(start_time)
    sample_times.add(effective_end_time)

    sorted_times = sorted({_rounded(t) for t in sample_times if window_start <= t <= window_end})

    # 3. Solve poses without splitting paired time groups
    motion_poses = []
    for t in sorted_times:
        poses_for_t = []
        if len(animators) == 2:
            sampled = {}
            for h in (midi_loader.RIGHT, midi_loader.LEFT):
                if h in animators:
                    p = animators[h].pose(t, keyboard)
                    p.update({"hand": h, "anim": animators[h], "song": planning_song, "t": t})
                    sampled[h] = p
            paired = [sampled[h] for h in (midi_loader.RIGHT, midi_loader.LEFT) if h in sampled]
            arranged = hands.arrange_crossing(paired) if len(paired) == 2 else paired
            for pose in arranged:
                poses_for_t.append(_motion_pose(pose, pose["hand"], t, lowest_key_left, pose["ppi"]))
        else:
            for hand_name, animator in animators.items():
                p = animator.pose(t, keyboard)
                poses_for_t.append(_motion_pose(p, hand_name, t, lowest_key_left, p["ppi"]))

        if len(poses_for_t) > max_poses:
            raise ValueError(
                f"maxPoses={max_poses} cannot fit a complete paired pose group of {len(poses_for_t)}"
            )
        if len(motion_poses) + len(poses_for_t) > max_poses:
            truncated = True
            continuation_time = _rounded(t)
            break

        motion_poses.extend(poses_for_t)

    motion_poses.sort(key=lambda item: (item["transportTimeSeconds"], item["hand"]))

    # 4. Calculate continuous coverage per hand (no gaps > 250ms)
    coverage = {}
    for raw_hand in animators:
        hand_key = "left" if raw_hand == midi_loader.LEFT else "right"
        h_poses = [p for p in motion_poses if p["hand"] == hand_key]
        if not h_poses:
            coverage[hand_key] = {
                "coveredStartTimeSeconds": _rounded(start_time),
                "coveredEndTimeSeconds": _rounded(start_time),
                "isComplete": False,
                "poseCount": 0,
            }
            continue

        h_times = [p["transportTimeSeconds"] for p in h_poses]
        continuous_end = h_times[0]
        has_gap = False
        for idx in range(len(h_times) - 1):
            gap = h_times[idx + 1] - h_times[idx]
            if gap > 0.250001:
                continuous_end = h_times[idx]
                has_gap = True
                break
            continuous_end = h_times[idx + 1]

        is_complete = (
            not truncated
            and not has_gap
            and h_times[0] <= start_time + 1e-4
            and continuous_end >= effective_end_time - 1e-4
        )
        coverage[hand_key] = {
            "coveredStartTimeSeconds": _rounded(h_times[0]),
            "coveredEndTimeSeconds": _rounded(continuous_end),
            "isComplete": is_complete,
            "poseCount": len(h_poses),
        }

    res = {
        "type": "sample-motion-result",
        "requestId": request_id,
        "projectId": project_id,
        "revision": revision,
        "engineVersion": engine_version,
        "startTimeSeconds": _rounded(start_time),
        "endTimeSeconds": _rounded(effective_end_time),
        "poses": motion_poses,
        "coverage": coverage,
        "truncated": bool(truncated),
    }
    if continuation_time is not None:
        res["continuationTimeSeconds"] = continuation_time
    return res


