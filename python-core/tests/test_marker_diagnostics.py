from pathlib import Path

from handthesia_core import midi_loader
from handthesia_core.midi_loader import read_markers_with_diagnostics

REPO = Path(__file__).resolve().parents[2]


def test_marker_parse_error_is_reported_instead_of_silently_empty():
    markers, error = read_markers_with_diagnostics(b"not a midi file")

    assert markers == {}
    assert error is not None
    assert error["phase"] == "fingering markers"
    assert error["message"]


def test_load_midi_attaches_marker_diagnostic(monkeypatch):
    source = (REPO / "tests" / "fixtures" / "midi" / "tracked-right-hand.mid").read_bytes()
    expected = {"phase": "fingering markers", "type": "ValueError", "message": "synthetic marker failure"}
    monkeypatch.setattr(midi_loader, "read_markers_with_diagnostics", lambda _source: ({}, expected))

    song = midi_loader.load_midi(source, fixture_id="marker-diagnostic")

    assert song.marker_parse_error == expected
