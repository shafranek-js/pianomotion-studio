from types import SimpleNamespace

import pytest

from handthesia_core import hand_split


def test_fit_spans_propagates_dependency_errors(monkeypatch):
    def broken_span(anatomy):
        raise RuntimeError("anatomy dependency failed")

    monkeypatch.setattr("handthesia_core.hands.hand_span_inches", broken_span)

    with pytest.raises(RuntimeError, match="anatomy dependency failed"):
        hand_split._fit_spans(SimpleNamespace(anatomy={}))
