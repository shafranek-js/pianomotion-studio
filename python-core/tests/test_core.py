from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import mido
import pytest


REPO = Path(__file__).resolve().parents[2]
CORE_ROOT = REPO / "python-core"
FIXTURES = REPO / "tests" / "fixtures"
GOLDEN_INDEX = REPO / "docs" / "evidence" / "baseline-2026-10-13" / "golden-index.json"
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from handthesia_core.api import analyze_midi, _dedupe_serialized_motion_poses  # noqa: E402
from handthesia_core import identity  # noqa: E402
from handthesia_core.geometry import KeyboardGeometry, NumericRect  # noqa: E402
from handthesia_core.midi_loader import read_midi  # noqa: E402


MANIFEST = json.loads((CORE_ROOT / "handthesia_core" / "source_manifest.json").read_text("utf-8"))


def options(fixture_id="core-test", **overrides):
    result = {
        "fixtureId": fixture_id,
        "projectId": "m1-core-test",
        "revision": 1,
        "requestId": "same-request-for-determinism",
        "engineVersion": MANIFEST["engineVersion"],
        "keyStyle": "realistic",
        "keyboardRect": [0, 0, 1400, 150],
    }
    result.update(overrides)
    return result


def _find_difference(expected, actual, path="$", limit=6):
    if type(expected) is not type(actual):
        return [(path, expected, actual)]
    if isinstance(expected, dict):
        differences = []
        for key in sorted(set(expected) | set(actual)):
            if key not in expected or key not in actual:
                differences.append((f"{path}.{key}", expected.get(key, "<missing>"), actual.get(key, "<missing>")))
            else:
                differences.extend(_find_difference(expected[key], actual[key], f"{path}.{key}", limit))
            if len(differences) >= limit:
                break
        return differences
    if isinstance(expected, list):
        if len(expected) != len(actual):
            return [(f"{path}.length", len(expected), len(actual))]
        differences = []
        for index, (left, right) in enumerate(zip(expected, actual)):
            differences.extend(_find_difference(left, right, f"{path}[{index}]", limit))
            if len(differences) >= limit:
                break
        return differences
    if expected != actual:
        return [(path, expected, actual)]
    return []


def test_python_package_imports_without_pygame():
    source = r"""
import importlib.abc, sys
class BlockPygame(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'pygame' or fullname.startswith('pygame.'):
            raise AssertionError('python-core imported pygame')
sys.meta_path.insert(0, BlockPygame())
sys.path.insert(0, sys.argv[1])
from handthesia_core.api import analyze_midi
assert callable(analyze_midi)
assert not any(name == 'pygame' or name.startswith('pygame.') for name in sys.modules)
"""
    result = subprocess.run([sys.executable, "-c", source, str(CORE_ROOT)], cwd=REPO,
                            text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_source_manifest_hash_is_canonical_and_reproducible():
    files = MANIFEST["files"]
    canonical = json.dumps({"files": dict(sorted(files.items()))}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    assert hashlib.sha256(canonical).hexdigest() == MANIFEST["engineVersion"]
    for relative_path, digest in files.items():
        payload = (CORE_ROOT / relative_path).read_bytes()
        assert hashlib.sha256(payload).hexdigest() == digest, relative_path


def test_keyboard_geometry_matches_desktop_rectangles():
    desktop_repo = REPO.parent / "pygame-piano-animator"
    if desktop_repo.exists() and str(desktop_repo) not in sys.path:
        sys.path.insert(0, str(desktop_repo))
    try:
        import pygame
        import common
    except ImportError as exc:
        pytest.skip(f"Desktop pygame/common not available: {exc}")
        return

    cases = [
        (21, 108, "realistic", (17, 19, 1400, 150)),
        (21, 108, "realistic", (3, -7, 887, 123)),
        (21, 108, "equal", (17, 19, 1400, 150)),
        (21, 108, "equal", (3, -7, 887, 123)),
        (21, 108, "equal", (5, 11, 507, 81)),
        (36, 84, "realistic", (17, 19, 887, 123)),
        (36, 84, "equal", (17, 19, 887, 123)),  # unsupported equal range falls back to realistic
    ]
    for low, high, style, rect_values in cases:
        desktop = common.Keyboard(pygame.Rect(*rect_values), low=low, high=high, style=style)
        numeric = KeyboardGeometry(NumericRect(*rect_values), low=low, high=high, style=style)
        assert numeric.style == desktop.style
        assert tuple(numeric.rect) == tuple(desktop.rect)
        assert numeric.white_w == desktop.white_w
        assert numeric.black_w == desktop.black_w
        assert numeric.black_h == desktop.black_h
        assert {key: tuple(rect) for key, rect in numeric.key_rects.items()} == {
            key: tuple(rect) for key, rect in desktop.key_rects.items()
        }
        assert numeric.lanes == desktop.lanes
        assert numeric.lane_lines == desktop.lane_lines
        assert numeric.lane_shade == desktop.lane_shade
        assert {key: tuple(rect) for key, rect in numeric.tails.items()} == {
            key: tuple(rect) for key, rect in desktop.tails.items()
        }
        if style == "equal" and low == 21 and high == 108:
            assert numeric.fronts == desktop.fronts
            assert numeric.keys_x == desktop.keys_x
            assert numeric.key_rects[21].left == desktop.key_rects[21].left


def test_core_matches_frozen_desktop_numeric_fields_for_all_fixtures():
    index = json.loads(GOLDEN_INDEX.read_text("utf-8"))
    compared = ("status", "desktopNotes", "assignments", "performanceEvents", "pedals",
                "rawPedals", "selectedPoses", "cleanup")
    for record in index["fixtureRecords"]:
        fixture_id = record["fixtureId"]
        payload = (FIXTURES / "midi" / f"{fixture_id}.mid").read_bytes()
        golden = json.loads((FIXTURES / "golden" / f"{fixture_id}.json").read_text("utf-8"))
        result = analyze_midi(payload, options(fixture_id, requestId=f"golden/{fixture_id}"))
        raw = result["rawBaseline"]
        for key in compared:
            expected = golden.get(key, [] if isinstance(raw[key], list) else raw[key])
            differences = _find_difference(expected, raw[key])
            assert not differences, f"{fixture_id}.{key}: {differences}"
        assert result["status"] == ("invalid" if golden["status"] == "invalid-or-rejected" else golden["status"])
        assert raw["inputSha256"] == hashlib.sha256(payload).hexdigest()
        assert result["resource"]["sha256"] == raw["inputSha256"]


def _midi_bytes(*tracks, ticks_per_beat=1000):
    midi = mido.MidiFile(type=1, ticks_per_beat=ticks_per_beat)
    conductor = mido.MidiTrack()
    conductor.append(mido.MetaMessage("track_name", name="Conductor", time=0))
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    midi.tracks.append(conductor)
    for track in tracks:
        midi.tracks.append(track)
    output = __import__("io").BytesIO()
    midi.save(file=output)
    return output.getvalue()


def _named_track(name, events):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    for message in events:
        track.append(message)
    return track


def test_raw_event_mapping_never_claims_a_clean_cross_track_duplicate():
    # A has overlapping same-pitch notes. PrettyMIDI decodes A0 and clean B0
    # with identical signatures; B's clean raw pair must not win A0's mapping.
    track_a = _named_track("Right A", [
        mido.Message("note_on", channel=0, note=60, velocity=88, time=0),
        mido.Message("note_on", channel=0, note=60, velocity=88, time=200),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=400),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=100),
    ])
    track_b = _named_track("Left B", [
        mido.Message("note_on", channel=1, note=60, velocity=88, time=0),
        mido.Message("note_off", channel=1, note=60, velocity=0, time=600),
    ])
    data = _midi_bytes(track_a, track_b)
    import pretty_midi
    import io
    decoded = pretty_midi.PrettyMIDI(io.BytesIO(data))
    observed = identity.observe_source(data, decoded, "ambiguous-overlap")
    assert len(observed["sourceNotes"]) == 3
    assert observed["eventBySourceId"] == {}
    assert set(observed["ambiguousSourceIds"]) == {n["noteId"] for n in observed["sourceNotes"]}

    simple = _named_track("Piano", [
        mido.Message("note_on", channel=0, note=64, velocity=75, time=40),
        mido.Message("note_off", channel=0, note=64, velocity=0, time=500),
    ])
    unique_bytes = _midi_bytes(simple)
    unique_pm = pretty_midi.PrettyMIDI(io.BytesIO(unique_bytes))
    unique = identity.observe_source(unique_bytes, unique_pm, "unique")
    assert len(unique["eventBySourceId"]) == 1
    locator = next(iter(unique["eventBySourceId"].values()))
    assert locator["midiTrackIndex"] == 1
    assert locator["channel"] == 0
    assert locator["noteOnOrdinal"] == 1  # track-name meta is ordinal 0
    assert locator["noteOffOrdinal"] == 2


def test_unmapped_decoded_notes_do_not_claim_normalized_raw_event_pairs():
    percussion = _named_track("Drums", [
        mido.Message("note_on", channel=9, note=36, velocity=92, time=0),
        mido.Message("note_off", channel=9, note=36, velocity=0, time=300),
    ])
    piano = _named_track("Piano", [
        mido.Message("note_on", channel=0, note=60, velocity=78, time=0),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=500),
    ])
    result = analyze_midi(_midi_bytes(percussion, piano), options("dropped-percussion"))
    raw = result["rawBaseline"]
    source_by_pitch = {item["pitch"]: item for item in raw["sourceNotes"]}
    mapping_by_id = {item["noteId"]: item for item in raw["identityMappings"]}

    drum_source = source_by_pitch[36]
    drum_mapping = mapping_by_id[drum_source["noteId"]]
    assert drum_mapping["status"] == "unmapped"
    assert drum_mapping["normalizedNoteId"] is None
    assert drum_mapping["rawEvents"] == []
    assert "sourceEvent" not in drum_source

    piano_source = source_by_pitch[60]
    piano_mapping = mapping_by_id[piano_source["noteId"]]
    assert piano_mapping["status"] == "exact"
    assert len(piano_mapping["rawEvents"]) == 1
    assert piano_source["sourceEvent"] == piano_mapping["rawEvents"][0]


def test_dropped_ambiguous_source_identities_have_explicit_diagnostics():
    percussion = _named_track("Drums", [
        mido.Message("note_on", channel=9, note=36, velocity=82, time=0),
        mido.Message("note_on", channel=9, note=36, velocity=82, time=0),
        mido.Message("note_off", channel=9, note=36, velocity=0, time=500),
        mido.Message("note_off", channel=9, note=36, velocity=0, time=0),
    ])
    piano = _named_track("Piano", [
        mido.Message("note_on", channel=0, note=60, velocity=82, time=0),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=500),
    ])
    result = analyze_midi(_midi_bytes(percussion, piano), options("ambiguous-dropped-source"))
    mappings = result["rawBaseline"]["identityMappings"]
    ambiguous = [mapping for mapping in mappings if mapping["status"] == "ambiguous"]
    assert len(ambiguous) == 2
    assert all(mapping["normalizedNoteId"] is None for mapping in ambiguous)
    assert all(mapping["rawEvents"] == [] for mapping in ambiguous)

    diagnostic = next(item for item in result["diagnostics"]
                      if item["code"] == "source-identity-ambiguous")
    assert set(diagnostic["noteIds"]) == {mapping["noteId"] for mapping in ambiguous}
    document_ids = {note["noteId"] for note in result["document"]["notes"]}
    for plan in (result["fingeringPlan"], result["performancePlan"]):
        assert all(item["code"] != "source-identity-ambiguous" for item in plan["diagnostics"])
        assert all(set(item.get("noteIds", [])).issubset(document_ids) for item in plan["diagnostics"])


def test_motion_pose_dedup_only_removes_identical_serialized_collisions():
    earlier = {"transportTimeSeconds": 1.4, "hand": "left", "layerOrder": 0, "joints": []}
    duplicate = dict(earlier)
    other_hand = {"transportTimeSeconds": 1.4, "hand": "right", "layerOrder": 0, "joints": []}
    later = {"transportTimeSeconds": 1.5, "hand": "left", "layerOrder": 0, "joints": []}
    assert _dedupe_serialized_motion_poses([earlier, duplicate, other_hand, later]) == [
        earlier, other_hand, later,
    ]
    with pytest.raises(ValueError, match="distinct motion poses collide"):
        _dedupe_serialized_motion_poses([earlier, {**earlier, "layerOrder": 1}])


def test_document_source_ids_follow_normalizer_aliases_not_pitch_time_join():
    track_first = _named_track("Piano A", [
        mido.Message("note_on", channel=0, note=11, velocity=90, time=0),
        mido.Message("note_off", channel=0, note=11, velocity=0, time=400),
    ])
    track_second = _named_track("Piano B", [
        mido.Message("note_on", channel=1, note=11, velocity=90, time=6),  # +3 ms: sanitation merge
        mido.Message("note_off", channel=1, note=11, velocity=0, time=500),
        mido.Message("note_on", channel=1, note=15, velocity=70, time=500),
        mido.Message("note_off", channel=1, note=15, velocity=0, time=400),
    ])
    payload = _midi_bytes(track_first, track_second)
    result = analyze_midi(payload, options("alias-normalization"))
    folded = [note for note in result["document"]["notes"] if note["pitch"] == 23]
    assert len(folded) == 1
    assert folded[0]["sourceNoteIds"] == [
        "alias-normalization/instrument-0/note-000000",
        "alias-normalization/instrument-1/note-000000",
    ]
    assert folded[0]["noteId"] in folded[0]["sourceNoteIds"]
    assert "sourceEvent" not in folded[0]
    mapped = [item for item in result["rawBaseline"]["identityMappings"]
              if item["noteId"] in folded[0]["sourceNoteIds"]]
    assert len(mapped) == 2
    assert all(item["normalizedNoteId"] == folded[0]["noteId"] for item in mapped)
    assert all(item["status"] == "merged" and len(item["rawEvents"]) == 1 for item in mapped)
    folded_from_15 = next(note for note in result["document"]["notes"] if note["pitch"] == 27)
    assert folded_from_15["sourceNoteIds"] == ["alias-normalization/instrument-1/note-000001"]
    assert folded_from_15["sourceEvent"]["midiTrackIndex"] == 2


def test_profile_a_b_a_runs_are_observationally_isolated():
    payload = (FIXTURES / "midi" / "synthetic-scale-chords.mid").read_bytes()
    default = analyze_midi(payload, options("profile-isolation"))
    profile_b = json.loads(json.dumps(default["profile"]))
    profile_b["profileId"] = "larger-hand"
    profile_b["revision"] = 1
    profile_b["anatomy"] = {key: value * 1.4 for key, value in profile_b["anatomy"].items()}
    run_b = analyze_midi(payload, options("profile-isolation", profile=profile_b))
    run_a_again = analyze_midi(payload, options("profile-isolation"))
    assert default["fingeringPlan"] == run_a_again["fingeringPlan"]
    assert default["performancePlan"] == run_a_again["performancePlan"]
    assert default["motionPlan"] == run_a_again["motionPlan"]
    assert run_b["profile"]["profileId"] == "larger-hand"
    assert run_b["motionPlan"] != default["motionPlan"]


def test_hands_cache_trim_evicts_oldest_without_wholesale_clear():
    from handthesia_core.hands import _trim_cache

    cache = {index: index for index in range(6)}
    _trim_cache(cache, 3)
    assert list(cache) == [3, 4, 5]


def test_reset_context_restores_defaults_after_mutation():
    from handthesia_core import figures, fingering

    fingering.reset_context(None)
    expected_w = dict(fingering.W)
    expected_strength = dict(fingering.FINGER_STRENGTH)
    figures.PREFS["__eng10_probe__"] = 0.5
    fingering.FINGER_STRENGTH[1] = 0.0

    fingering.reset_context(None)

    assert dict(fingering.W) == expected_w
    assert dict(fingering.FINGER_STRENGTH) == expected_strength
    assert "__eng10_probe__" not in figures.PREFS


def test_profile_behavior_is_clamped_and_validated():
    from handthesia_core import fingering, pianist
    from handthesia_core.api import _resolve_profile

    base, _ = _resolve_profile(None)

    # A zero or negative speed is a valid request: clamp it, never divide by it.
    zero_speed = json.loads(json.dumps(base))
    zero_speed["profileId"] = "zero-speed"
    zero_speed["revision"] = 1
    zero_speed["behavior"]["max_speed"] = 0.0
    zero_speed["behavior"]["smoothness"] = 1e9
    resolved, context = _resolve_profile(zero_speed)
    assert resolved["behavior"]["max_speed"] == pianist.BEHAVIOR["max_speed"]["min"]
    assert resolved["behavior"]["smoothness"] == pianist.BEHAVIOR["smoothness"]["max"]
    assert context.behavior["max_speed"] == resolved["behavior"]["max_speed"]
    fingering.apply_pianist(context)
    assert fingering.travel_time(1.0) > 0.0

    # A Pianist constructed outside the API is still safe.
    raw = pianist.from_profile_dto({"behavior": {"max_speed": 0.0}})
    fingering.apply_pianist(raw)
    assert fingering.travel_time(1.0) > 0.0

    # Malformed values are reported instead of being silently repaired.
    bad_type = json.loads(json.dumps(base))
    bad_type["behavior"]["max_speed"] = "fast"
    with pytest.raises(ValueError):
        _resolve_profile(bad_type)

    bad_option = json.loads(json.dumps(base))
    bad_option["behavior"]["octaves"] = "nonsense"
    with pytest.raises(ValueError):
        _resolve_profile(bad_option)


if __name__ == "__main__":
    for test in (
        test_python_package_imports_without_pygame,
        test_source_manifest_hash_is_canonical_and_reproducible,
        test_keyboard_geometry_matches_desktop_rectangles,
        test_core_matches_frozen_desktop_numeric_fields_for_all_fixtures,
        test_raw_event_mapping_never_claims_a_clean_cross_track_duplicate,
        test_unmapped_decoded_notes_do_not_claim_normalized_raw_event_pairs,
        test_dropped_ambiguous_source_identities_have_explicit_diagnostics,
        test_motion_pose_dedup_only_removes_identical_serialized_collisions,
        test_document_source_ids_follow_normalizer_aliases_not_pitch_time_join,
        test_profile_a_b_a_runs_are_observationally_isolated,
        test_profile_behavior_is_clamped_and_validated,
    ):
        test()
        print(f"PASS: {test.__name__}")
