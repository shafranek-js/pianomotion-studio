from types import SimpleNamespace

from handthesia_core.hands import _roll_onsets


def _notes(count, start=0.0):
    return [SimpleNamespace(start=start) for _ in range(count)]


def test_roll_onsets_natural_and_compressed():
    natural = _roll_onsets(_notes(3), 0.1)
    assert natural == [0.0, 0.1, 0.2]

    compressed = _roll_onsets(_notes(3), 0.1, 0.15)
    assert compressed[0] == 0.0
    assert abs(compressed[1] - 0.1) < 1e-9
    assert abs(compressed[2] - 0.15) < 1e-9
    assert max(compressed) <= 0.15 + 1e-9


def test_roll_onsets_never_moves_a_late_note_earlier():
    late = _notes(2, start=0.3)
    assert _roll_onsets(late, 0.1, 0.1) == [0.3, 0.3]
