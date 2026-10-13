"""Progress context adapter for the synchronous batch core.

Calculations keep clean call sites while progress and cancellation
are managed by the worker lifecycle.
"""
from contextlib import contextmanager


@contextmanager
def stage(_start=0.0, _end=1.0):
    yield


def report(_value):
    return None

