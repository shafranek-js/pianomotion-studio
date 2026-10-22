from handthesia_core.midi_loader import _marker


def test_bare_marker_text_is_recognized_but_unrelated_text_is_not():
    # This pins the documented, intent-dependent format: a text meta event that
    # is exactly R1/L1/F1/Rg/Lg/R/L is a fingering marker. Arbitrary longer text
    # is not. Namespacing the format would need a backward-compatibility
    # decision, so the collision remains an accepted risk.
    assert _marker(b"R1") == ("R", 1)
    assert _marker(b"Lg") == ("L", "g")
    assert _marker(b"R") == ("R", None)
    assert _marker(b"Rehearsal R1") is None
    assert _marker(b"hello") is None
