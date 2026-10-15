from __future__ import annotations

import io
import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]
CORE_ROOT = REPO / "python-core"
FIXTURES = REPO / "tests" / "fixtures"

if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from handthesia_core import api, midi_loader  # noqa: E402
from handthesia_core.midi_loader import LEFT, RIGHT, Note  # noqa: E402

MANIFEST = json.loads((CORE_ROOT / "handthesia_core" / "source_manifest.json").read_text("utf-8"))


def _options(fixture_id="export-test", **overrides):
    manifest = api._manifest()
    engine_ver = api._engine_version(manifest)
    opts = {
        "fixtureId": fixture_id,
        "projectId": "export-test-project",
        "revision": 1,
        "requestId": f"req-{fixture_id}",
        "engineVersion": engine_ver,
        "keyStyle": "realistic",
        "keyboardRect": [0, 0, 1400, 150],
    }
    opts.update(overrides)
    return opts


def test_pig_helpers():
    cases = [
        ("C4", 60),
        ("C#4", 61),
        ("Db4", 61),
        ("A0", 21),
        ("C8", 108),
        ("F#3", 54),
        ("Bb5", 82),
        ("G#2", 44),
    ]
    for name, pitch in cases:
        p = midi_loader.pig_pitch(name)
        assert p == pitch, f"pig_pitch({name}) = {p} != {pitch}"
        out_name = midi_loader.pig_name(pitch)
        assert midi_loader.pig_pitch(out_name) == pitch, f"Roundtrip failed for {pitch}: {out_name}"


def test_pig_roundtrip():
    notes = [
        Note(pitch=60, start=0.0, end=0.5, velocity=80, track=0, hand=RIGHT),
        Note(pitch=64, start=0.5, end=1.0, velocity=75, track=0, hand=RIGHT),
        Note(pitch=67, start=1.0, end=1.5, velocity=85, track=0, hand=RIGHT),
        Note(pitch=48, start=0.0, end=0.75, velocity=90, track=1, hand=LEFT),
        Note(pitch=52, start=0.75, end=1.5, velocity=88, track=1, hand=LEFT),
        Note(pitch=55, start=1.5, end=2.0, velocity=70, track=1, hand=LEFT),
        Note(pitch=72, start=2.0, end=2.5, velocity=64, track=0, hand=RIGHT),
    ]
    fingers = {
        id(notes[0]): 1,
        id(notes[1]): 3,
        id(notes[2]): 5,
        id(notes[3]): 1,
        id(notes[4]): 3,
        id(notes[5]): 5,
        id(notes[6]): None,  # unassigned finger
    }

    pig_text = midi_loader.save_pig_text(notes, fingers)
    assert "//Version: PianoFingering_v170101" in pig_text
    lines = [line for line in pig_text.splitlines() if line.strip() and not line.startswith("//")]
    assert len(lines) == len(notes)

    # Re-import with fingering
    song_with = midi_loader.read_pig_text(pig_text, with_fingering=True)
    assert len(song_with.notes) == len(notes)
    for orig, imported in zip(sorted(notes, key=lambda n: (n.start, n.pitch)), song_with.notes):
        assert imported.pitch == orig.pitch
        assert abs(imported.start - orig.start) < 1e-4
        assert abs(imported.end - orig.end) < 1e-4
        assert imported.velocity == orig.velocity
        assert imported.hand == orig.hand
        expected_finger = fingers[id(orig)]
        assert imported.finger == expected_finger, (
            f"Pitch {orig.pitch} expected finger {expected_finger}, got {imported.finger}"
        )

    # Re-import without fingering
    song_without = midi_loader.read_pig_text(pig_text, with_fingering=False)
    assert len(song_without.notes) == len(notes)
    for imported in song_without.notes:
        assert imported.finger is None


def _verify_fixture_export(fixture_name: str):
    midi_path = FIXTURES / "midi" / fixture_name
    source_bytes = midi_path.read_bytes()
    fixture_id = fixture_name.replace(".mid", "")

    analysis = api.analyze_midi(source_bytes, _options(fixture_id))
    assert analysis["status"] in ("loaded", "repaired")
    doc = analysis["document"]
    plan = analysis["fingeringPlan"]
    assert doc is not None and plan is not None

    export_result = api.export_fingered_midi(source_bytes, doc, plan)
    exported_bytes = export_result["exportedBytes"]
    marked_count = export_result["markedCount"]
    assert isinstance(exported_bytes, bytes)
    assert len(exported_bytes) > 0
    assert marked_count == len(doc["notes"])

    # Load back the exported MIDI via midi_loader.load_midi
    reloaded_song = midi_loader.load_midi(exported_bytes, fixture_id="reloaded")
    assert len(reloaded_song.notes) == len(doc["notes"])

    # Build lookup for expected note properties from document and fingering plan
    assignments_by_id = {a["noteId"]: a for a in plan["assignments"]}
    expected_notes = []
    for note_dto in doc["notes"]:
        assign = assignments_by_id[note_dto["noteId"]]
        expected_hand = LEFT if assign["hand"] == "left" else RIGHT
        disp = assign["disposition"]
        if disp == "glissando":
            exp_finger = None
            exp_gliss = True
        elif disp == "unplayable":
            exp_finger = None
            exp_gliss = False
        else:
            exp_finger = assign["finger"]
            exp_gliss = False
        expected_notes.append({
            "pitch": note_dto["pitch"],
            "start": note_dto["startSeconds"],
            "hand": expected_hand,
            "finger": exp_finger,
            "gliss": exp_gliss,
        })

    # Sort both by start time and pitch to align notes
    expected_sorted = sorted(expected_notes, key=lambda n: (round(n["start"], 4), n["pitch"]))
    reloaded_sorted = sorted(reloaded_song.notes, key=lambda n: (round(n.start, 4), n.pitch))

    assert len(expected_sorted) == len(reloaded_sorted)

    # Verify 100% retention of hand, finger, and glissando markers!
    for i, (exp, rel) in enumerate(zip(expected_sorted, reloaded_sorted)):
        assert rel.pitch == exp["pitch"], f"Note {i}: pitch mismatch {rel.pitch} vs {exp['pitch']}"
        assert abs(rel.start - exp["start"]) <= 0.005, f"Note {i}: start mismatch {rel.start} vs {exp['start']}"
        assert rel.hand == exp["hand"], (
            f"Note {i} (pitch {rel.pitch} at {rel.start}): hand {rel.hand} != {exp['hand']}"
        )
        assert rel.finger == exp["finger"], (
            f"Note {i} (pitch {rel.pitch} at {rel.start}): finger {rel.finger} != {exp['finger']}"
        )
        assert rel.gliss == exp["gliss"], (
            f"Note {i} (pitch {rel.pitch} at {rel.start}): gliss {rel.gliss} != {exp['gliss']}"
        )


def test_export_fingered_midi_and_reimport_100_percent_retention():
    fixtures = [
        "synthetic-scale-chords.mid",
        "synthetic-manual-fingering-gliss.mid",
        "tracked-right-hand.mid",
        "tracked-demo-song.mid",
    ]
    for fixture in fixtures:
        _verify_fixture_export(fixture)


def test_channel_separation_and_pedal_broadcast():
    # 1. Test channel separation on a two-handed fixture
    fixture_name = "synthetic-crossing-wide-chord.mid"
    source_bytes = (FIXTURES / "midi" / fixture_name).read_bytes()
    analysis = api.analyze_midi(source_bytes, _options("ch-test"))
    doc = analysis["document"]
    plan = analysis["fingeringPlan"]

    export_result = api.export_fingered_midi(source_bytes, doc, plan)
    exported_bytes = export_result["exportedBytes"]

    header, chunks, tracks = midi_loader._smf_tracks(exported_bytes)

    # Verify that RH and LH note-ons were assigned to separate channels
    rh_channels = set()
    lh_channels = set()
    sounding = {}

    for track_events in tracks.values():
        pending_marker = None
        for t, kind, payload in track_events:
            if kind == "meta" and payload[0] == 0x01:
                pending_marker = midi_loader._marker(payload[1])
            elif kind == "midi":
                st, ch = payload[0] & 0xF0, payload[0] & 0x0F
                if st == 0x90 and payload[2] > 0:
                    if pending_marker:
                        hand, _finger = pending_marker
                        if hand == "R":
                            rh_channels.add(ch)
                        elif hand == "L":
                            lh_channels.add(ch)
                    sounding.setdefault((ch, payload[1]), []).append(ch)
                    pending_marker = None
                elif st in (0x80, 0x90):
                    # note-off channel should match note-on channel
                    stack = sounding.get((ch, payload[1]))
                    assert stack is not None, f"Note-off on channel {ch} pitch {payload[1]} without note-on"
                    assert stack.pop(0) == ch

    # Right hand channel and left hand channel must be distinct
    assert len(rh_channels) == 1, f"Expected 1 RH channel, got {rh_channels}"
    assert len(lh_channels) == 1, f"Expected 1 LH channel, got {lh_channels}"
    rh_ch = next(iter(rh_channels))
    lh_ch = next(iter(lh_channels))
    assert rh_ch != lh_ch, f"Right hand channel {rh_ch} should differ from left hand channel {lh_ch}"
    assert lh_ch != 9, "Left hand channel must not be drums channel 9"

    # 2. Test CC/pedal broadcast on synthetic-tempo-pedals-overlap
    pedal_bytes = (FIXTURES / "midi" / "synthetic-tempo-pedals-overlap.mid").read_bytes()
    pedal_analysis = api.analyze_midi(pedal_bytes, _options("pedal-test"))
    pedal_export = api.export_fingered_midi(pedal_bytes, pedal_analysis["document"], pedal_analysis["fingeringPlan"])
    _, _, pedal_tracks = midi_loader._smf_tracks(pedal_export["exportedBytes"])

    cc_channels = set()
    for evs in pedal_tracks.values():
        for t, k, p in evs:
            if k == "midi" and (p[0] & 0xF0) == 0xB0:
                cc_channels.add(p[0] & 0x0F)

    # CC controllers must be broadcast to both hands' channels
    assert rh_ch in cc_channels and lh_ch in cc_channels


if __name__ == "__main__":
    tests = [
        test_pig_helpers,
        test_pig_roundtrip,
        test_export_fingered_midi_and_reimport_100_percent_retention,
        test_channel_separation_and_pedal_broadcast,
    ]
    failed = 0
    for test in tests:
        name = test.__name__
        try:
            test()
            print(f"PASS: {name}")
        except Exception as exc:
            print(f"FAIL: {name}: {exc}")
            import traceback
            traceback.print_exc()
            failed += 1
    if failed:
        sys.exit(1)
    print(f"\nAll {len(tests)} test suites passed successfully!")
    sys.exit(0)
