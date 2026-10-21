import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ANATOMY, handSpanInches, type Pianist } from "../src/pianist.ts";
import { _fit_spans, SPAN_FREE, SPAN_HELD_MAX, SPAN_MAX } from "../src/handSplit.ts";

function pianistWith(anatomy: Record<string, number>): Pianist {
  return { anatomy } as unknown as Pianist;
}

afterEach(() => {
  _fit_spans(null);
});

describe("hand split span scaling", () => {
  it("scales the spans by the hand model ratio, like Python hand_span_inches", () => {
    const scaled = Object.fromEntries(
      Object.entries(DEFAULT_ANATOMY).map(([bone, length]) => [bone, length * 1.2]),
    );
    const expected = handSpanInches(scaled) / handSpanInches(null);
    expect(expected).toBeGreaterThan(1.05);
    expect(expected).toBeLessThan(1.3);

    _fit_spans(pianistWith(scaled));

    expect(SPAN_FREE).toBeCloseTo(12 * expected, 6);
    expect(SPAN_MAX).toBeCloseTo(16 * expected, 6);
    expect(SPAN_HELD_MAX).toBeCloseTo(19 * expected, 6);
  });

  it("ignores the legacy hand_span key that Python never read", () => {
    // The old TS port looked for a "hand_span" anatomy field that is absent
    // from DEFAULT_ANATOMY, so this anatomy used to leave the spans unchanged.
    _fit_spans(pianistWith({ ...DEFAULT_ANATOMY, hand_span: 12 }));

    expect(SPAN_FREE).toBe(12);
    expect(SPAN_MAX).toBe(16);
    expect(SPAN_HELD_MAX).toBe(19);
  });
});
