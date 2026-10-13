from __future__ import annotations

import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[3]
CORE_ROOT = REPO / "web" / "python-core"
DEMO_MIDI_PATH = REPO / "web" / "tests" / "fixtures" / "midi" / "tracked-demo-song.mid"

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


if __name__ == "__main__":
    test_motion_window_basic_and_cache()
    test_motion_window_with_document_and_plan()
    test_motion_window_max_poses_bounding()
    test_motion_window_error_cases()
    print("\nAll motion window tests passed successfully!")
