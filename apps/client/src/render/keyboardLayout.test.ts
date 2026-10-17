import { describe, expect, it } from "vitest";
import { KeyboardLayout, KeyboardView } from "./keyboardView";

describe("KeyboardLayout.getPitchAt", () => {
  it("returns correct pitch for realistic keyboard geometry", () => {
    const layout = new KeyboardLayout();
    layout.compute({ x: 0, y: 100, width: 1040, height: 120 }, "realistic");

    // Outside bounds
    expect(layout.getPitchAt(-10, 150)).toBeNull();
    expect(layout.getPitchAt(500, 50)).toBeNull();
    expect(layout.getPitchAt(500, 300)).toBeNull();

    // Check middle C (MIDI 60, white key)
    const c4Rect = layout.getKeyRect(60);
    expect(c4Rect).toBeDefined();
    // Hit at the front of C4 (lower part of key where no black key can overlap)
    const pitchC4 = layout.getPitchAt(c4Rect!.x + c4Rect!.width / 2, c4Rect!.y + c4Rect!.height - 10);
    expect(pitchC4).toBe(60);

    // Check C#4 (MIDI 61, black key)
    const cs4Rect = layout.getKeyRect(61);
    expect(cs4Rect).toBeDefined();
    const pitchCs4 = layout.getPitchAt(cs4Rect!.x + cs4Rect!.width / 2, cs4Rect!.y + cs4Rect!.height / 2);
    expect(pitchCs4).toBe(61);
  });

  it("returns correct pitch for equal key width geometry", () => {
    const layout = new KeyboardLayout();
    layout.compute({ x: 0, y: 100, width: 1040, height: 120 }, "equal");

    const a0Rect = layout.getKeyRect(21);
    expect(a0Rect).toBeDefined();
    expect(layout.getPitchAt(a0Rect!.x + 2, a0Rect!.y + 110)).toBe(21);

    const c8Rect = layout.getKeyRect(108);
    expect(c8Rect).toBeDefined();
    expect(layout.getPitchAt(c8Rect!.x + 2, c8Rect!.y + 110)).toBe(108);
  });
});

describe("KeyboardView play along state", () => {
  it("accepts target keys and renders without error", () => {
    const view = new KeyboardView();
    view.setLayout({ x: 0, y: 0, width: 800, height: 100 });

    expect(() => {
      view.setPlayAlongState(
        new Map([
          [60, { hand: "right", finger: 1 }],
          [64, { hand: "right", finger: 3 }],
        ]),
        new Set([62]),
      );
    }).not.toThrow();

    expect(() => {
      view.setPressedKeys([60]);
    }).not.toThrow();
  });
});
