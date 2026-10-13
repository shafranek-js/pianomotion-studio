"""Numeric keyboard layout for PianoMotion.

This module contains only the rectangles and positions used by the IK and
chord-fit calculations. Its integer rounding provides clean geometric coordinates.
"""
from __future__ import annotations

from dataclasses import dataclass

LOWEST_PIANO_KEY = 21
HIGHEST_PIANO_KEY = 108
KEY_LEN_WW = 5.6
_BLACK_PITCH_CLASSES = {1, 3, 6, 8, 10}
_BLACK_OFFSETS = {1: -0.12, 3: 0.12, 6: -0.14, 8: 0.0, 10: 0.14}
_EQUAL_A0_MAX = 2.0


def is_black_key(pitch: int) -> bool:
    return pitch % 12 in _BLACK_PITCH_CLASSES


@dataclass(frozen=True)
class NumericRect:
    """Small integer rectangle for pose math."""

    x: int
    y: int
    w: int
    h: int

    def __init__(self, x=0, y=0, w=0, h=0):
        object.__setattr__(self, "x", int(x))
        object.__setattr__(self, "y", int(y))
        object.__setattr__(self, "w", int(w))
        object.__setattr__(self, "h", int(h))

    @property
    def left(self): return self.x
    @property
    def right(self): return self.x + self.w
    @property
    def top(self): return self.y
    @property
    def bottom(self): return self.y + self.h
    @property
    def width(self): return self.w
    @property
    def height(self): return self.h
    @property
    def centerx(self): return self.x + self.w // 2
    @property
    def centery(self): return self.y + self.h // 2

    def __iter__(self):
        return iter((self.x, self.y, self.w, self.h))


def _equal_head(pitch: int) -> tuple[float, float]:
    i = pitch % 12
    if i <= 4:
        k = i // 2
        return k * 5 / 3, (k + 1) * 5 / 3
    k = (i - 5) // 2
    return 5 + k * 7 / 4, 5 + (k + 1) * 7 / 4


class KeyboardGeometry:
    """Keyboard coordinates required by the hand model and chord fitting."""

    def __init__(self, rect: NumericRect, low=LOWEST_PIANO_KEY,
                 high=HIGHEST_PIANO_KEY, style="realistic"):
        self.low, self.high = low, high
        self.style = style
        self.layout(rect)

    def layout(self, rect: NumericRect):
        self.rect = NumericRect(*rect)
        self.tails = {}
        self.lane_shade = []
        if self.style == "equal" and self.low == LOWEST_PIANO_KEY and self.high == HIGHEST_PIANO_KEY:
            self._layout_equal()
            return
        self.style = "realistic"
        whites = [p for p in range(self.low, self.high + 1) if not is_black_key(p)]
        self.white_w = self.rect.w / len(whites)
        self.black_w = self.white_w * 0.6
        self.black_h = int(self.rect.h * 0.63)
        self.key_rects, self.lanes, self.lane_lines = {}, {}, []
        white_index = 0
        for p in range(self.low, self.high + 1):
            if is_black_key(p):
                boundary = self.rect.x + white_index * self.white_w
                x = boundary - self.black_w / 2 + _BLACK_OFFSETS[p % 12] * self.black_w
                r = NumericRect(round(x), self.rect.y, round(self.black_w), self.black_h)
                self.key_rects[p] = r
                self.lanes[p] = (r.x, r.w)
            else:
                x0 = round(self.rect.x + white_index * self.white_w)
                x1 = round(self.rect.x + (white_index + 1) * self.white_w)
                self.key_rects[p] = NumericRect(x0, self.rect.y, x1 - x0, self.rect.h)
                pad = max(1, round(self.white_w * 0.08))
                self.lanes[p] = (x0 + pad, x1 - x0 - 2 * pad)
                if p % 12 in (0, 5):
                    self.lane_lines.append(x0)
                white_index += 1

    def _layout_equal(self):
        rect = self.rect
        whites = [p for p in range(self.low, self.high + 1) if not is_black_key(p)]
        self.white_w = rect.w / len(whites)
        n = self.high - self.low + 1
        P = max(2, rect.w // n)
        g = self.gap = max(1, round(P / 15))
        L = P - g
        back = rect.w - (n - 1) * P
        margin = max(0, back - int(_EQUAL_A0_MAX * P))
        back -= margin
        left = rect.x + margin // 2
        x0 = left + back - P
        self.pitch = P
        self.keys_x = (left, x0 + n * P)
        self.black_w = L
        self.black_h = int(rect.h * 0.63)
        self.key_rects, self.lanes, self.lane_lines = {}, {}, []
        self.fronts = {}
        lane = lambda p: x0 + (p - self.low) * P
        gl, gr = g // 2, g - g // 2
        heads = {}
        for first, keys, lanes_n in ((0, (0, 2, 4), 5), (5, (5, 7, 9, 11), 7)):
            k = len(keys)
            h = (lanes_n * P - k * g) / k
            for i, pc in enumerate(keys):
                heads[pc] = (first * P + gl + i * (h + g), h)
        for p in range(self.low, self.high + 1):
            a = lane(p)
            lane_rect = NumericRect(a + gl, rect.y, L, self.black_h)
            if is_black_key(p):
                self.key_rects[p] = lane_rect
                self.lanes[p] = (lane_rect.x, L)
                continue
            off, h = heads[p % 12]
            hx = lane(p - p % 12) + off
            tail = NumericRect(lane_rect.x, rect.y, L, self.black_h + g)
            if p == self.high:
                hx, h = tail.x, L
            if p == self.low:
                tail = NumericRect(left, tail.y, tail.w + tail.x - left, tail.h)
                h += hx - left
                hx = left
            self.fronts[p] = (hx, hx + h)
            rx0, rx1 = round(hx), round(hx + h)
            self.key_rects[p] = NumericRect(rx0, rect.y, rx1 - rx0, rect.h)
            self.tails[p] = tail
            self.lanes[p] = (lane_rect.x, L)
            self.lane_shade.append((lane_rect.x, L))

