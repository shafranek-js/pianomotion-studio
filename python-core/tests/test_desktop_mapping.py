from types import SimpleNamespace

from handthesia_core.api import _map_desktop_notes


def _source(note_id, pitch, instrument):
    return {
        "noteId": note_id,
        "pitch": pitch,
        "start": 1.0,
        "end": 5.0,
        "velocity": 80,
        "sourceInstrument": instrument,
        "sourceOrdinal": 0,
    }


def _song(track, pitch):
    return SimpleNamespace(
        track=track,
        pitch=pitch,
        start=1.0,
        end=2.0,
        velocity=80,
        hand="right",
        finger=1,
        gliss=False,
        source_ids=[],
    )


def test_timestamp_fallback_does_not_pick_a_different_pitch():
    mapped, _missing, _by_object = _map_desktop_notes(
        [_source("wrong-pitch", 62, 99)], [_song(99, 60)], "fixture"
    )

    assert mapped[0]["noteId"] is None
    assert mapped[0]["sourceNoteIds"] == []


def test_timestamp_fallback_still_matches_when_pitch_and_start_agree():
    mapped, _missing, _by_object = _map_desktop_notes(
        [_source("same-pitch", 60, 7)], [_song(99, 60)], "fixture"
    )

    assert mapped[0]["noteId"] == "same-pitch"
    assert mapped[0]["sourceNoteIds"] == ["same-pitch"]
