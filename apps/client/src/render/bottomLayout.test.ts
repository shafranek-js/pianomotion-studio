import { describe, expect, it } from "vitest";
import {
  computeBottomLayout,
  BOTTOM_MAX_SHARE,
  FELT_H,
  getKeyboardInventory,
  HAND_AREA_MIN_H,
  HAND_LEN_WW,
  KEY_LEN_WW,
} from "./pianoScene";
import { KeyboardLayout } from "./keyboardView";

describe("computeBottomLayout (hand viewport framing)", () => {
  it("computes proportional keyboard and hand area within budget for standard 16:10 window (1200x800)", () => {
    const layout = computeBottomLayout(1200, 800);
    const { keyboardRect, handRect, feltRect } = layout;

    // 1. Keyboard and hand proportions
    const ww = 1200 / 52;
    expect(keyboardRect.width).toBe(Math.round(ww * 52));
    expect(keyboardRect.height).toBe(Math.round(ww * KEY_LEN_WW));
    expect(handRect.height).toBe(Math.round(ww * HAND_LEN_WW));

    // 2. Budget constraint: keys + hand area <= 50% of screen height
    const totalBottomH = keyboardRect.height + handRect.height;
    expect(totalBottomH).toBeLessThanOrEqual(800 * BOTTOM_MAX_SHARE);

    // 3. Perfect vertical alignment: felt -> keys -> hand area -> bottom of screen
    expect(feltRect.y + feltRect.height).toBe(keyboardRect.y);
    expect(feltRect.height).toBe(FELT_H);
    expect(keyboardRect.y + keyboardRect.height).toBe(handRect.y);
    expect(handRect.y + handRect.height).toBe(800);

    // 4. Keyboard spans full width (centered at x=0)
    expect(keyboardRect.x).toBe(0);
    expect(handRect.x).toBe(0);
  });

  it("keeps all 88 keys across the viewport and caps vertical height when ultra-wide (1920x600)", () => {
    const layout = computeBottomLayout(1920, 600);
    const { keyboardRect, handRect, feltRect } = layout;

    // Budget: 50% of 600 = 300px
    const totalBottomH = keyboardRect.height + handRect.height;
    expect(totalBottomH).toBeLessThanOrEqual(300);

    // Horizontal width represents the full piano regardless of viewport height.
    expect(keyboardRect.x).toBe(0);
    expect(keyboardRect.width).toBe(1920);
    expect(handRect.x).toBe(keyboardRect.x);
    expect(handRect.width).toBe(keyboardRect.width);
    expect(feltRect.x).toBe(keyboardRect.x);
    expect(feltRect.width).toBe(keyboardRect.width);

    // Hand area touches bottom of screen
    expect(handRect.y + handRect.height).toBe(600);
  });

  it("enforces HAND_AREA_MIN_H in narrow/tall window (700x1100)", () => {
    const layout = computeBottomLayout(700, 1100);
    const { handRect } = layout;

    expect(handRect.height).toBeGreaterThanOrEqual(HAND_AREA_MIN_H);
    expect(handRect.y + handRect.height).toBe(1100);
  });

  it("respects customKeyboardHeight override if provided", () => {
    const layout = computeBottomLayout(1200, 800, 150);
    expect(layout.keyboardRect.height).toBe(150);
    expect(layout.keyboardRect.y + layout.keyboardRect.height).toBe(layout.handRect.y);
    expect(layout.handRect.y + layout.handRect.height).toBe(800);
  });

  it("provides sufficient clearance for anatomical palm and wrist without canvas clipping", () => {
    const layout = computeBottomLayout(1200, 800);
    const kbLayout = new KeyboardLayout();
    kbLayout.compute(layout.keyboardRect, "realistic");

    // The wrist and forearm extend south (negative Y in keyboard coordinates)
    // by up to ~4.5 inches behind the keyboard front edge.
    const wristYInches = -4.0;
    const keyboardBottom = layout.keyboardRect.y + layout.keyboardRect.height;

    // In screen coordinates: y = keyboardBottom - wristYInches * ppi
    const wristScreenY = keyboardBottom - wristYInches * kbLayout.ppi;

    // Assert that the wrist Screen Y is inside the canvas (< 800) and inside handRect
    expect(wristScreenY).toBeLessThanOrEqual(800);
    expect(wristScreenY).toBeGreaterThanOrEqual(keyboardBottom);
    expect(wristScreenY).toBeLessThanOrEqual(layout.handRect.y + layout.handRect.height);
  });

  it("preserves all 88 keys at narrow and short workspace sizes", () => {
    for (const [width, height] of [[320, 220], [1600, 160]]) {
      const layout = computeBottomLayout(width, height);
      const keyboard = new KeyboardLayout();
      keyboard.compute(layout.keyboardRect, "realistic");
      const inventory = getKeyboardInventory(keyboard.keyRects);

      expect(layout.keyboardRect.x).toBe(0);
      expect(layout.keyboardRect.width).toBe(width);
      expect(inventory).toEqual({ keyCount: 88, minPitch: 21, maxPitch: 108 });
      expect(keyboard.getKeyRect(inventory.minPitch)).toBeDefined();
      expect(keyboard.getKeyRect(inventory.maxPitch)).toBeDefined();
      expect(layout.keyboardRect.height + layout.handRect.height).toBeLessThanOrEqual(height * BOTTOM_MAX_SHARE);
      expect(layout.keyboardRect.y + layout.keyboardRect.height).toBe(layout.handRect.y);
      expect(layout.handRect.y + layout.handRect.height).toBe(height);
    }
  });
});
