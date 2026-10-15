from __future__ import annotations

import json
import io
import copy
from pathlib import Path
import sys

import mido

REPO = Path(__file__).resolve().parents[2]
CORE_ROOT = REPO / "python-core"
DEMO_MIDI_PATH = REPO / "tests" / "fixtures" / "midi" / "tracked-demo-song.mid"

if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from handthesia_core import api  # noqa: E402


def test_motion_window_basic_and_cache():
    """Test sample_motion_window on tracked-demo-song.mid for a 4.0s window,

    and verify active session caching on sliding window calls.
    """
    assert DEMO_MIDI_PATH.exists(), f"Demo midi file not found at {DEMO_MIDI_PATH}"
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    project_id = "test-window-project"
    revision = 1
    options = {
        "projectId": project_id,
        "revision": revision,
        "requestId": "req-window-1",
        "engineVersion": engine_ver,
        "keyStyle": "realistic",
        "keyboardRect": [0, 0, 1400, 150],
        "maxPoses": 200,
    }

    # Clear cache to verify fresh initialization
    api._active_animator_sessions.clear()

    # 1. First call: 4.0-second window [0.0, 4.0]
    result1 = api.sample_motion_window(
        data=midi_bytes,
        document=None,
        fingering_plan=None,
        start_time=0.0,
        end_time=4.0,
        options=options,
    )

    assert result1["type"] == "sample-motion-result"
    assert result1["projectId"] == project_id
    assert result1["revision"] == revision
    assert result1["engineVersion"] == engine_ver
    assert result1["startTimeSeconds"] == 0.0
    assert result1["endTimeSeconds"] == 4.0
    assert isinstance(result1["poses"], list)
    assert len(result1["poses"]) > 0
    assert len(result1["poses"]) <= 200

    # Verify pose structure conforms to MotionPoseSchema
    hands_seen = set()
    for pose in result1["poses"]:
        assert "transportTimeSeconds" in pose
        assert pose["transportTimeSeconds"] >= 0.0
        assert pose["hand"] in ("left", "right")
        hands_seen.add(pose["hand"])
        assert isinstance(pose["layerOrder"], int)
        assert len(pose["bones"]) > 0
        assert len(pose["joints"]) > 0
        for bone in pose["bones"]:
            assert len(bone["a"]) == 3
            assert len(bone["b"]) == 3
            assert "kind" in bone
        for joint in pose["joints"]:
            assert len(joint["point"]) == 3
            assert "kind" in joint

    assert hands_seen == {"left", "right"}, f"Both hands should be present, got: {hands_seen}"

    # Verify poses are sorted by (transportTimeSeconds, hand)
    times_and_hands = [(p["transportTimeSeconds"], p["hand"]) for p in result1["poses"]]
    assert times_and_hands == sorted(times_and_hands), "Poses must be sorted chronologically"

    # Verify session is cached in _active_animator_sessions
    cache_key = (project_id, revision, "default")
    assert cache_key in api._active_animator_sessions, "Active session should be cached"

    # 2. Sliding window call: [2.0, 6.0] with empty bytes (must succeed via cache)
    result2 = api.sample_motion_window(
        data=b"",
        document=None,
        fingering_plan=None,
        start_time=2.0,
        end_time=6.0,
        options={
            "projectId": project_id,
            "revision": revision,
            "requestId": "req-window-2",
            "engineVersion": engine_ver,
            "maxPoses": 200,
        },
    )

    assert result2["type"] == "sample-motion-result"
    assert result2["startTimeSeconds"] == 2.0
    assert result2["endTimeSeconds"] == 6.0
    assert len(result2["poses"]) > 0
    assert len(result2["poses"]) <= 200
    assert any(p["transportTimeSeconds"] >= 2.0 for p in result2["poses"])

    print("PASS: test_motion_window_basic_and_cache")


def test_motion_window_with_document_and_plan():
    """Test sample_motion_window with document and fingering plan from analyze_midi."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    project_id = "test-doc-plan-proj"
    revision = 2
    analysis = api.analyze_midi(midi_bytes, {
        "fixtureId": "demo-analysis",
        "projectId": project_id,
        "revision": revision,
        "requestId": "analysis-1",
        "engineVersion": engine_ver,
    })

    # Clear cache to force parsing with document and plan
    api._active_animator_sessions.clear()

    result = api.sample_motion_window(
        data=midi_bytes,
        document=analysis["document"],
        fingering_plan=analysis["fingeringPlan"],
        start_time=1.0,
        end_time=5.0,
        options={
            "projectId": project_id,
            "revision": revision,
            "engineVersion": engine_ver,
        },
    )

    assert result["type"] == "sample-motion-result"
    assert result["startTimeSeconds"] == 1.0
    assert result["endTimeSeconds"] == 5.0
    assert len(result["poses"]) > 0

    print("PASS: test_motion_window_with_document_and_plan")


def test_motion_window_max_poses_bounding():
    """Test that maxPoses bounds the output poses properly."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    result = api.sample_motion_window(
        data=midi_bytes,
        document=None,
        fingering_plan=None,
        start_time=0.0,
        end_time=4.0,
        options={
            "projectId": "test-max-poses",
            "revision": 1,
            "engineVersion": engine_ver,
            "maxPoses": 40,
        },
    )

    assert len(result["poses"]) <= 40, f"Expected at most 40 poses, got {len(result['poses'])}"
    assert len(result["poses"]) > 0
    print("PASS: test_motion_window_max_poses_bounding")

def test_motion_window_error_cases():
    """Test error validation for sample_motion_window."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()

    # endTimeSeconds <= startTimeSeconds
    try:
        api.sample_motion_window(midi_bytes, None, None, 4.0, 2.0, {})
        raise AssertionError("Expected ValueError for endTimeSeconds <= startTimeSeconds")
    except ValueError as exc:
        assert "endTimeSeconds must be greater than startTimeSeconds" in str(exc)

    # Empty data with unknown cache key
    try:
        api.sample_motion_window(b"", None, None, 0.0, 4.0, {"projectId": "non-existent", "revision": 999})
        raise AssertionError("Expected ValueError for missing session and empty data")
    except ValueError as exc:
        assert "No active animator session" in str(exc)

    print("PASS: test_motion_window_error_cases")


def test_motion_window_caps_1_to_5_and_no_zero_division():
    """A13: verify maxPoses 1..5 do not crash with ZeroDivisionError, and cap=1 prioritizes left hand."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    # Test cap=1 specifically (A13 reproduction scenario)
    res1 = api.sample_motion_window(
        data=midi_bytes,
        document=None,
        fingering_plan=None,
        start_time=0.0,
        end_time=4.0,
        options={
            "projectId": "test-cap-1",
            "revision": 1,
            "engineVersion": engine_ver,
            "maxPoses": 1,
        },
    )
    assert len(res1["poses"]) == 1
    assert res1["poses"][0]["hand"] == "left"
    assert res1["truncated"] is True
    assert res1["continuationTimeSeconds"] == 0.0
    assert "coverage" in res1
    assert res1["coverage"]["left"]["isComplete"] is False

    # Test caps 2..5
    for cap in (2, 3, 4, 5):
        res = api.sample_motion_window(
            data=midi_bytes,
            document=None,
            fingering_plan=None,
            start_time=0.0,
            end_time=4.0,
            options={
                "projectId": f"test-cap-{cap}",
                "revision": 1,
                "engineVersion": engine_ver,
                "maxPoses": cap,
            },
        )
        assert 1 <= len(res["poses"]) <= cap
        assert "coverage" in res

    print("PASS: test_motion_window_caps_1_to_5_and_no_zero_division")


def test_single_active_animator_session_eviction():
    """A12: Worker must hold exactly one active animator session across multiple revisions."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    api._active_animator_sessions.clear()
    for rev in range(1, 21):
        api.sample_motion_window(
            data=midi_bytes,
            document=None,
            fingering_plan=None,
            start_time=0.0,
            end_time=4.0,
            options={
                "projectId": "session-eviction-test",
                "revision": rev,
                "engineVersion": engine_ver,
                "maxPoses": 100,
            },
        )
        assert len(api._active_animator_sessions) == 1, (
            f"Expected exactly 1 cached session at revision {rev}, found {len(api._active_animator_sessions)}"
        )

    print("PASS: test_single_active_animator_session_eviction")


def test_motion_window_hand_coverage_metadata():
    """A10: sample_motion_window returns continuous hand coverage metadata."""
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)

    res = api.sample_motion_window(
        data=midi_bytes,
        document=None,
        fingering_plan=None,
        start_time=0.0,
        end_time=4.0,
        options={
            "projectId": "coverage-test",
            "revision": 1,
            "engineVersion": engine_ver,
            "maxPoses": 200,
        },
    )
    assert "coverage" in res
    assert "left" in res["coverage"]
    assert "right" in res["coverage"]
    for hand, cov in res["coverage"].items():
        assert "coveredStartTimeSeconds" in cov
        assert "coveredEndTimeSeconds" in cov
        assert "isComplete" in cov
        assert "poseCount" in cov
        assert cov["poseCount"] > 0
        assert cov["coveredEndTimeSeconds"] >= cov["coveredStartTimeSeconds"]

    print("PASS: test_motion_window_hand_coverage_metadata")


def test_motion_window_enforces_five_seconds_and_total_pose_cap_without_splitting_pairs():
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    engine_ver = api._engine_version(api._manifest())
    base_options = {
        "projectId": "window-hard-caps",
        "revision": 1,
        "engineVersion": engine_ver,
    }

    try:
        api.sample_motion_window(
            midi_bytes, None, None, 1.0, 10.0,
            {**base_options, "requestId": "overlong-window", "maxPoses": 500},
        )
        raise AssertionError("Expected the Python API to reject windows longer than five seconds")
    except ValueError as exc:
        assert "must not exceed 5 seconds" in str(exc)

    # A large absolute timestamp is valid when the requested range remains bounded.
    long_start = 1_000_000_000.0
    long_window = api.sample_motion_window(
        midi_bytes, None, None, long_start, long_start + 4.0,
        {**base_options, "requestId": "long-absolute-time", "maxPoses": 500},
    )
    assert long_window["startTimeSeconds"] == long_start
    assert long_window["endTimeSeconds"] == long_start + 4.0
    assert long_window["truncated"] is False
    assert len(long_window["poses"]) <= 500

    dense_small_cap = api.sample_motion_window(
        midi_bytes, None, None, 0.0, 4.0,
        {**base_options, "requestId": "dense-small-cap", "maxPoses": 6},
    )
    assert 0 < len(dense_small_cap["poses"]) <= 6
    assert dense_small_cap["truncated"] is True
    assert dense_small_cap["continuationTimeSeconds"] > dense_small_cap["startTimeSeconds"]
    grouped = {}
    for pose in dense_small_cap["poses"]:
        grouped.setdefault(pose["transportTimeSeconds"], []).append(pose["hand"])
    assert all(sorted(hands) == ["left", "right"] for hands in grouped.values()), grouped

    try:
        api.sample_motion_window(
            midi_bytes, None, None, 0.0, 1.0,
            {**base_options, "requestId": "too-many-poses", "maxPoses": 501},
        )
        raise AssertionError("Expected direct Python API to reject maxPoses > 500")
    except ValueError as exc:
        assert "1 through 500" in str(exc)


def test_motion_window_rejects_invalid_ranges_and_caps_before_building_animators(monkeypatch):
    midi_bytes = DEMO_MIDI_PATH.read_bytes()

    def unexpected_build(*_args, **_kwargs):
        raise AssertionError("invalid motion request reached animator construction")

    monkeypatch.setattr(api.hands, "build_hands", unexpected_build)
    invalid_requests = [
        (-0.01, 1.0, 200, "startTimeSeconds must be nonnegative"),
        (1.0, 6.000001, 200, "must not exceed 5 seconds"),
        (0.0, 1.0, 501, "maxPoses must be an integer from 1 through 500"),
    ]
    for index, (start, end, max_poses, expected_message) in enumerate(invalid_requests):
        try:
            api.sample_motion_window(
                midi_bytes,
                None,
                None,
                start,
                end,
                {
                    "projectId": f"invalid-window-{index}",
                    "revision": 1,
                    "maxPoses": max_poses,
                },
            )
            raise AssertionError(f"Expected invalid motion request {index} to fail")
        except ValueError as exc:
            assert expected_message in str(exc)


def test_motion_window_rejects_capacity_smaller_than_a_complete_pose_group(monkeypatch):
    class FakeAnimator:
        groups = []
        performance = []

        def pose(self, _time, _keyboard):
            return {
                "ppi": 1.0,
                "layer": 0,
                "bones": [([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], "wrist")],
                "joints": [([0.0, 0.0, 0.0], "wrist")],
            }

    profile_id = api._resolve_profile(None)[0]["profileId"]
    project_id = "pose-group-capacity"
    revision = 1
    api._active_animator_sessions.clear()
    api._active_animator_sessions[(project_id, revision, profile_id)] = {
        "animators": {"L": FakeAnimator(), "R": FakeAnimator(), "third": FakeAnimator()},
        "planning_song": object(),
        "keyboard": None,
        "song": None,
    }
    monkeypatch.setattr(api.hands, "crossing_episodes", lambda _song: [])
    try:
        try:
            api.sample_motion_window(
                b"", None, None, 0.0, 1.0,
                {
                    "projectId": project_id,
                    "revision": revision,
                    "requestId": "undersized-pose-group",
                    "maxPoses": 2,
                },
            )
            raise AssertionError("Expected an error rather than a partial pose group")
        except ValueError as exc:
            assert "complete paired pose group of 3" in str(exc)
    finally:
        api._active_animator_sessions.clear()


def test_bounded_initial_motion_window_is_runtime_only_and_keeps_sparse_diagnostics():
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    common = {
        "fixtureId": "bounded-initial-window",
        "projectId": "bounded-initial-window",
        "revision": 1,
        "requestId": "same-analysis-request",
        "engineVersion": api._engine_version(api._manifest()),
        "keyStyle": "realistic",
    }
    sparse = api.analyze_midi(midi_bytes, {**common, "sampleDense": False})
    playback = api.analyze_midi(midi_bytes, {**common, "sampleDense": True})

    assert playback["rawBaseline"]["selectedPoses"] == sparse["rawBaseline"]["selectedPoses"]
    assert playback["motionPlan"]["poses"] == sparse["motionPlan"]["poses"]
    window = playback["initialMotionWindow"]
    assert window["startTimeSeconds"] == 0.0
    assert window["endTimeSeconds"] <= 4.0
    assert len(window["poses"]) <= 200
    assert window["coverage"]
    assert "requestId" not in window
    assert "projectId" not in window


def test_dense_pose_cap_continuations_advance_without_replaying_history():
    midi = mido.MidiFile(type=0, ticks_per_beat=1000)
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    absolute_events = []
    for index in range(400):
        start_tick = index * 10
        absolute_events.append((start_tick, 1, mido.Message("note_on", channel=0, note=60 + index % 12, velocity=80, time=0)))
        absolute_events.append((start_tick + 8, 0, mido.Message("note_off", channel=0, note=60 + index % 12, velocity=0, time=0)))
    last_tick = 0
    for tick, _order, message in sorted(absolute_events, key=lambda event: (event[0], event[1])):
        message.time = tick - last_tick
        track.append(message)
        last_tick = tick
    midi.tracks.append(track)
    stream = io.BytesIO()
    midi.save(file=stream)
    midi_bytes = stream.getvalue()
    engine_ver = api._engine_version(api._manifest())
    options = {
        "projectId": "dense-window-progress",
        "revision": 1,
        "engineVersion": engine_ver,
        "maxPoses": 200,
    }

    first = api.sample_motion_window(midi_bytes, None, None, 0.0, 4.0, {**options, "requestId": "dense-1"})
    assert first["truncated"] is True
    continuation = first["continuationTimeSeconds"]
    assert continuation > first["startTimeSeconds"]
    assert len(first["poses"]) == 200

    second = api.sample_motion_window(
        b"", None, None, continuation, 4.0,
        {**options, "requestId": "dense-2"},
    )
    assert second["startTimeSeconds"] == continuation
    assert second["poses"]
    assert min(pose["transportTimeSeconds"] for pose in second["poses"]) == continuation
    if second["truncated"]:
        assert second["continuationTimeSeconds"] > continuation


def test_replan_stream_and_restored_worker_context_use_the_current_revision():
    midi_bytes = DEMO_MIDI_PATH.read_bytes()
    engine_ver = api._engine_version(api._manifest())
    project_id = "replan-motion-stream"
    revision = 9
    api._active_animator_sessions.clear()
    try:
        analysis = api.analyze_midi(midi_bytes, {
            "fixtureId": "tracked-demo-song",
            "projectId": project_id,
            "revision": revision,
            "requestId": "replan-stream-analysis",
            "engineVersion": engine_ver,
            "sampleDense": True,
        })
        source_window = analysis["initialMotionWindow"]
        edited_document = copy.deepcopy(analysis["document"])
        edited_document["revision"] = revision + 1
        edited_plan = copy.deepcopy(analysis["fingeringPlan"])
        edited_plan["inputRevision"] = revision + 1
        profile = analysis["profile"]
        replan_options = {
            "fixtureId": "tracked-demo-song",
            "projectId": project_id,
            "revision": revision + 1,
            "requestId": "replan-stream-current-revision",
            "engineVersion": engine_ver,
            "profile": profile,
            "keyStyle": "equal",
            "resource": analysis["resource"],
            "rawBaseline": analysis["rawBaseline"],
        }
        replanned = api.replan_document(midi_bytes, edited_document, edited_plan, replan_options)
        current_window = replanned["initialMotionWindow"]
        assert replanned["revision"] == revision + 1
        assert current_window["poses"]
        assert current_window != source_window
        assert replanned["keyStyle"] == "equal"

        stream_options = {
            "projectId": project_id,
            "revision": revision + 1,
            "engineVersion": replanned["engineVersion"],
            "fixtureId": "tracked-demo-song",
            "profile": profile,
            "keyStyle": "equal",
            "maxPoses": 200,
        }
        cached_stream = api.sample_motion_window(
            b"", None, None, 0.0, 1.0,
            {**stream_options, "requestId": "replan-stream-cached"},
        )
        assert cached_stream["revision"] == revision + 1
        assert cached_stream["poses"]

        # A fresh Worker has no LRU entry; restoring the source context must
        # rebuild the same edited revision from the original bytes and plans.
        api._active_animator_sessions.clear()
        restored_stream = api.sample_motion_window(
            midi_bytes,
            replanned["document"],
            replanned["fingeringPlan"],
            0.0,
            1.0,
            {**stream_options, "requestId": "replan-stream-restored"},
        )
        assert restored_stream["projectId"] == project_id
        assert restored_stream["revision"] == revision + 1
        assert restored_stream["poses"]
        assert len(api._active_animator_sessions) == 1
    finally:
        api._active_animator_sessions.clear()


if __name__ == "__main__":
    test_motion_window_basic_and_cache()
    test_motion_window_with_document_and_plan()
    test_motion_window_max_poses_bounding()
    test_motion_window_error_cases()
    test_motion_window_caps_1_to_5_and_no_zero_division()
    test_single_active_animator_session_eviction()
    test_motion_window_hand_coverage_metadata()
    test_motion_window_enforces_five_seconds_and_total_pose_cap_without_splitting_pairs()
    test_bounded_initial_motion_window_is_runtime_only_and_keeps_sparse_diagnostics()
    test_dense_pose_cap_continuations_advance_without_replaying_history()
    print("\nAll motion window tests passed successfully!")
