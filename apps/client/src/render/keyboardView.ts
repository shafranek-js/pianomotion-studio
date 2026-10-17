import type { M1KeyStyle } from "@handthesia/contracts";
import { Container, Graphics, Text } from "pixi.js";

export const LOWEST_PIANO_KEY = 21; // A0
export const HIGHEST_PIANO_KEY = 108; // C8
export const TOTAL_KEYS = 88;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const BLACK_OFFSETS: Record<number, number> = { 1: -0.12, 3: 0.12, 6: -0.14, 8: 0.0, 10: 0.14 };
const EQUAL_A0_MAX = 2.0;

export function isBlackKey(pitch: number): boolean {
  return BLACK_PITCH_CLASSES.has(pitch % 12);
}

export interface KeyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneRect {
  x: number;
  width: number;
}

export interface KeyPressInfo {
  hand: "left" | "right";
  finger?: number | null;
}

export class KeyboardLayout {
  public rect: KeyRect = { x: 0, y: 0, width: 0, height: 0 };
  public style: M1KeyStyle = "realistic";
  public whiteW = 0;
  public blackW = 0;
  public blackH = 0;
  public ppi = 0; // pixels per inch

  public keyRects = new Map<number, KeyRect>();
  public lanes = new Map<number, LaneRect>();
  public laneLines: number[] = [];
  public tails = new Map<number, KeyRect>();
  public fronts = new Map<number, { left: number; right: number }>();
  public laneShade: LaneRect[] = [];

  public compute(rect: KeyRect, style: M1KeyStyle = "realistic"): void {
    this.rect = { ...rect };
    this.style = style;
    this.keyRects.clear();
    this.lanes.clear();
    this.laneLines = [];
    this.tails.clear();
    this.fronts.clear();
    this.laneShade = [];

    if (style === "equal") {
      this.computeEqual(rect);
    } else {
      this.computeRealistic(rect);
    }
  }

  private computeRealistic(rect: KeyRect): void {
    const whitePitches: number[] = [];
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (!isBlackKey(p)) whitePitches.push(p);
    }

    this.whiteW = rect.width / whitePitches.length;
    this.blackW = this.whiteW * 0.6;
    this.blackH = Math.round(rect.height * 0.63);
    // Standard piano octave is 6.5 inches across 7 white keys => 6.5 / 7 inches per white key
    this.ppi = this.whiteW / (6.5 / 7.0);

    let whiteIndex = 0;
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (isBlackKey(p)) {
        const boundary = rect.x + whiteIndex * this.whiteW;
        const offset = BLACK_OFFSETS[p % 12] ?? 0;
        const x = boundary - this.blackW / 2 + offset * this.blackW;
        const keyRect: KeyRect = {
          x: Math.round(x),
          y: rect.y,
          width: Math.round(this.blackW),
          height: this.blackH,
        };
        this.keyRects.set(p, keyRect);
        this.lanes.set(p, { x: keyRect.x, width: keyRect.width });
      } else {
        const x0 = Math.round(rect.x + whiteIndex * this.whiteW);
        const x1 = Math.round(rect.x + (whiteIndex + 1) * this.whiteW);
        const keyRect: KeyRect = {
          x: x0,
          y: rect.y,
          width: x1 - x0,
          height: rect.height,
        };
        this.keyRects.set(p, keyRect);

        const pad = Math.max(1, Math.round(this.whiteW * 0.08));
        this.lanes.set(p, { x: x0 + pad, width: x1 - x0 - 2 * pad });

        if (p % 12 === 0 || p % 12 === 5) {
          this.laneLines.push(x0);
        }
        whiteIndex += 1;
      }
    }
  }

  private computeEqual(rect: KeyRect): void {
    const whitePitches: number[] = [];
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (!isBlackKey(p)) whitePitches.push(p);
    }

    this.whiteW = rect.width / whitePitches.length;
    this.ppi = this.whiteW / (6.5 / 7.0);

    const n = TOTAL_KEYS;
    const P = Math.max(2, Math.floor(rect.width / n));
    const g = Math.max(1, Math.round(P / 15));
    const L = P - g;
    let back = rect.width - (n - 1) * P;
    const margin = Math.max(0, back - Math.floor(EQUAL_A0_MAX * P));
    back -= margin;
    const left = rect.x + Math.floor(margin / 2);
    const x0 = left + back - P;
    const gl = Math.floor(g / 2);

    this.blackW = L;
    this.blackH = Math.round(rect.height * 0.63);

    const lane = (p: number) => x0 + (p - LOWEST_PIANO_KEY) * P;

    const heads = new Map<number, { off: number; h: number }>();
    const groups = [
      { first: 0, keys: [0, 2, 4], lanesN: 5 },
      { first: 5, keys: [5, 7, 9, 11], lanesN: 7 },
    ];
    for (const { first, keys, lanesN } of groups) {
      const k = keys.length;
      const h = (lanesN * P - k * g) / k;
      for (const [i, pc] of keys.entries()) {
        heads.set(pc, {
          off: first * P + gl + i * (h + g),
          h,
        });
      }
    }

    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      const a = lane(p);
      const laneRect: KeyRect = { x: a + gl, y: rect.y, width: L, height: this.blackH };

      if (isBlackKey(p)) {
        this.keyRects.set(p, laneRect);
        this.lanes.set(p, { x: laneRect.x, width: L });
        continue;
      }

      const head = heads.get(p % 12);
      const off = head?.off ?? 0;
      let h = head?.h ?? L;
      let hx = lane(p - (p % 12)) + off;
      const tail: KeyRect = { x: laneRect.x, y: rect.y, width: L, height: this.blackH + g };

      if (p === HIGHEST_PIANO_KEY) {
        hx = tail.x;
        h = L;
      }
      if (p === LOWEST_PIANO_KEY) {
        tail.width += tail.x - left;
        tail.x = left;
        h += hx - left;
        hx = left;
      }

      this.fronts.set(p, { left: hx, right: hx + h });
      const rx0 = Math.round(hx);
      const rx1 = Math.round(hx + h);
      this.keyRects.set(p, { x: rx0, y: rect.y, width: rx1 - rx0, height: rect.height });
      this.tails.set(p, tail);
      this.lanes.set(p, { x: laneRect.x, width: L });
      this.laneShade.push({ x: laneRect.x, width: L });
    }
  }

  public getKeyRect(pitch: number): KeyRect | undefined {
    return this.keyRects.get(pitch);
  }

  public getLane(pitch: number): LaneRect {
    const lane = this.lanes.get(pitch);
    if (lane) return lane;
    const key = this.keyRects.get(pitch);
    return key ? { x: key.x, width: key.width } : { x: 0, width: 20 };
  }

  public getPitchAt(x: number, y: number): number | null {
    if (
      x < this.rect.x ||
      x > this.rect.x + this.rect.width ||
      y < this.rect.y ||
      y > this.rect.y + this.rect.height
    ) {
      return null;
    }

    // 1. Check black keys first (sit above white keys)
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (!isBlackKey(p)) continue;
      const r = this.keyRects.get(p);
      if (r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        return p;
      }
    }

    // 2. Check white keys
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (isBlackKey(p)) continue;
      if (this.style === "equal") {
        const front = this.fronts.get(p);
        const tail = this.tails.get(p);
        if (tail && x >= tail.x && x <= tail.x + tail.width && y >= tail.y && y <= tail.y + tail.height) {
          return p;
        }
        if (front) {
          const top = this.rect.y + this.blackH;
          const h = this.rect.height - this.blackH;
          if (x >= front.left && x <= front.right && y >= top && y <= top + h) {
            return p;
          }
        }
      } else {
        const r = this.keyRects.get(p);
        if (r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
          return p;
        }
      }
    }

    return null;
  }
}

export class KeyboardView extends Container {
  private readonly layout = new KeyboardLayout();
  private readonly bgGraphics = new Graphics();
  private readonly whiteKeysGraphics = new Graphics();
  private readonly blackKeysGraphics = new Graphics();
  private readonly badgesGraphics = new Graphics();
  private readonly labelsContainer = new Container();

  private pressedKeys = new Map<number, KeyPressInfo>();
  private targetKeys = new Map<number, KeyPressInfo>();
  private wrongKeys = new Set<number>();
  private labelTextPool: Text[] = [];
  private showFingerLabels = false;

  public constructor() {
    super();
    this.addChild(this.bgGraphics);
    this.addChild(this.whiteKeysGraphics);
    this.addChild(this.blackKeysGraphics);
    this.addChild(this.badgesGraphics);
    this.addChild(this.labelsContainer);
  }

  public setLayout(rect: KeyRect, style: M1KeyStyle = "realistic"): void {
    this.layout.compute(rect, style);
    this.renderKeyboard();
  }

  public getLayout(): KeyboardLayout {
    return this.layout;
  }

  public getKeyRect(pitch: number): KeyRect | undefined {
    return this.layout.getKeyRect(pitch);
  }

  public getLane(pitch: number): LaneRect {
    return this.layout.getLane(pitch);
  }

  public getPitchAt(x: number, y: number): number | null {
    return this.layout.getPitchAt(x, y);
  }

  public setPlayAlongState(
    targets?: Map<number, KeyPressInfo> | null,
    wrongPitches?: Set<number> | null,
  ): void {
    this.targetKeys.clear();
    if (targets) {
      for (const [pitch, info] of targets.entries()) {
        this.targetKeys.set(pitch, info);
      }
    }
    this.wrongKeys.clear();
    if (wrongPitches) {
      for (const pitch of wrongPitches) {
        this.wrongKeys.add(pitch);
      }
    }
    this.renderKeyboard();
  }

  public getTargetKeys(): ReadonlyMap<number, KeyPressInfo> {
    return this.targetKeys;
  }

  public setPressedKeys(
    pressed: Map<number, KeyPressInfo> | Record<number, KeyPressInfo> | number[],
  ): void {
    this.pressedKeys.clear();
    if (pressed instanceof Map) {
      for (const [pitch, info] of pressed.entries()) {
        this.pressedKeys.set(pitch, info);
      }
    } else if (Array.isArray(pressed)) {
      for (const pitch of pressed) {
        this.pressedKeys.set(pitch, { hand: pitch < 60 ? "left" : "right" });
      }
    } else {
      for (const [keyStr, info] of Object.entries(pressed)) {
        const pitch = Number(keyStr);
        if (!Number.isNaN(pitch)) {
          this.pressedKeys.set(pitch, info);
        }
      }
    }
    this.renderKeyboard();
  }

  public setShowFingerLabels(show: boolean): void {
    if (this.showFingerLabels === show) return;
    this.showFingerLabels = show;
    this.renderKeyboard();
  }

  private renderKeyboard(): void {
    this.bgGraphics.clear();
    this.whiteKeysGraphics.clear();
    this.blackKeysGraphics.clear();
    this.badgesGraphics.clear();

    for (const text of this.labelTextPool) {
      text.visible = false;
    }
    let labelIndex = 0;

    const { rect } = this.layout;
    if (rect.width <= 0 || rect.height <= 0) return;

    // Draw keyboard backdrop
    this.bgGraphics.rect(rect.x, rect.y, rect.width, rect.height).fill(0x16161a);

    // 1. Draw white keys
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (isBlackKey(p)) continue;

      const r = this.layout.keyRects.get(p);
      if (!r) continue;

      const press = this.pressedKeys.get(p);
      let fillColor = 0xf5f5f0;
      let strokeColor = 0xb0b0b8;

      const target = this.targetKeys.get(p);
      const isWrong = this.wrongKeys.has(p);

      if (isWrong) {
        fillColor = 0xf87171; // vivid red for wrong key
        strokeColor = 0xdc2626;
      } else if (press) {
        if (press.hand === "left") {
          fillColor = 0x60a5fa; // saturated pressed blue
          strokeColor = 0x2563eb;
        } else {
          fillColor = 0x34d399; // saturated pressed green
          strokeColor = 0x059669;
        }
      } else if (target) {
        if (target.hand === "left") {
          fillColor = 0xbfdbfe; // clear target blue
          strokeColor = 0x3b82f6;
        } else {
          fillColor = 0xa7f3d0; // clear target green
          strokeColor = 0x10b981;
        }
      }

      if (this.layout.style === "equal") {
        const front = this.layout.fronts.get(p);
        const tail = this.layout.tails.get(p);
        if (front && tail) {
          const top = rect.y + this.layout.blackH;
          const h = r.height - this.layout.blackH;
          const fx0 = Math.round(front.left);
          const fx1 = Math.round(front.right);
          this.whiteKeysGraphics
            .roundRect(fx0, top, fx1 - fx0, h, 3)
            .fill(fillColor);
          this.whiteKeysGraphics
            .rect(tail.x, tail.y, tail.width, tail.height)
            .fill(fillColor);
        }
      } else {
        this.whiteKeysGraphics
          .roundRect(r.x, r.y, r.width, r.height, 3)
          .fill(fillColor);
        // Key separator line
        this.whiteKeysGraphics
          .moveTo(r.x, r.y)
          .lineTo(r.x, r.y + r.height - 1)
          .stroke({ width: 1, color: 0xb0b0b8 });
        if (isWrong || press || target) {
          this.whiteKeysGraphics
            .roundRect(r.x + 1, r.y + 1, Math.max(2, r.width - 2), Math.max(2, r.height - 2), 2)
            .stroke({ width: press || isWrong ? 2 : 1.5, color: strokeColor });
        }
        if (press || isWrong) {
          // Visual key-down depression shadow at top of key
          this.whiteKeysGraphics
            .rect(r.x + 1, r.y, Math.max(2, r.width - 2), Math.min(6, r.height * 0.08))
            .fill({ color: 0x000000, alpha: 0.22 });
        }
      }

      // Pressed or target badge with finger label
      if (press && !isWrong) {
        const badgeInfo = target ? { hand: target.hand, finger: target.finger ?? press.finger } : press;
        this.renderKeyBadge(r, badgeInfo, false, labelIndex, Boolean(target));
        labelIndex += 1;
      } else if (target && !isWrong) {
        this.renderKeyBadge(r, target, false, labelIndex, true);
        labelIndex += 1;
      }
    }

    // 2. Draw black keys
    for (let p = LOWEST_PIANO_KEY; p <= HIGHEST_PIANO_KEY; p += 1) {
      if (!isBlackKey(p)) continue;

      const r = this.layout.keyRects.get(p);
      if (!r) continue;

      const press = this.pressedKeys.get(p);
      const target = this.targetKeys.get(p);
      const isWrong = this.wrongKeys.has(p);

      if (isWrong) {
        this.blackKeysGraphics
          .roundRect(r.x, r.y, r.width, r.height, 2)
          .fill(0xdc2626)
          .stroke({ width: 1.5, color: 0xfca5a5 });
      } else if (press) {
        const blackPressColor = press.hand === "left" ? 0x3b82f6 : 0x10b981;
        const blackPressStroke = press.hand === "left" ? 0x93c5fd : 0x6ee7b7;
        this.blackKeysGraphics
          .roundRect(r.x, r.y, r.width, r.height, 2)
          .fill(blackPressColor)
          .stroke({ width: 1.5, color: blackPressStroke });

        const badgeInfo = target ? { hand: target.hand, finger: target.finger ?? press.finger } : press;
        this.renderKeyBadge(r, badgeInfo, true, labelIndex, Boolean(target));
        labelIndex += 1;
      } else if (target) {
        const targetColor = target.hand === "left" ? 0x1e3a8a : 0x064e3b;
        const targetStroke = target.hand === "left" ? 0x60a5fa : 0x34d399;
        this.blackKeysGraphics
          .roundRect(r.x, r.y, r.width, r.height, 2)
          .fill(targetColor)
          .stroke({ width: 1.5, color: targetStroke });

        this.renderKeyBadge(r, target, true, labelIndex, true);
        labelIndex += 1;
      } else {
        // Unpressed black key
        this.blackKeysGraphics
          .roundRect(r.x, r.y, r.width, r.height, 2)
          .fill(0x18181c);

        if (r.width > 6) {
          const bevelHeight = Math.max(4, Math.round(r.height * 0.88));
          this.blackKeysGraphics
            .roundRect(r.x + 2, r.y, r.width - 4, bevelHeight, 2)
            .fill(0x383842);
          this.blackKeysGraphics
            .roundRect(r.x + 3, r.y, r.width - 6, Math.max(2, bevelHeight - 3), 1)
            .fill(0x18181c);
        }
      }
    }
  }

  private renderKeyBadge(
    r: KeyRect,
    press: KeyPressInfo,
    isBlack: boolean,
    labelIdx: number,
    forceShowFinger = false,
  ): void {
    const badgeRadius = Math.max(4, Math.min(Math.round(r.width * 0.38), 10));
    const centerX = r.x + r.width / 2;
    const centerY = isBlack
      ? r.y + r.height - badgeRadius - 4
      : r.y + r.height - badgeRadius - 8;

    const badgeColor = press.hand === "left" ? 0x1d4ed8 : 0x047857;
    const ringColor = 0xffffff;

    this.badgesGraphics
      .circle(centerX, centerY, badgeRadius + 1)
      .fill(ringColor);
    this.badgesGraphics
      .circle(centerX, centerY, badgeRadius)
      .fill(badgeColor);

    if ((this.showFingerLabels || forceShowFinger) && press.finger && press.finger >= 1 && press.finger <= 5 && badgeRadius >= 6) {
      let label = this.labelTextPool[labelIdx];
      if (!label) {
        label = new Text({
          text: "",
          style: {
            fontFamily: "system-ui, sans-serif",
            fontSize: 10,
            fontWeight: "bold",
            fill: 0xffffff,
            align: "center",
          },
        });
        label.anchor.set(0.5, 0.5);
        this.labelsContainer.addChild(label);
        this.labelTextPool.push(label);
      }
      label.text = String(press.finger);
      label.style.fontSize = Math.max(8, badgeRadius * 1.3);
      label.position.set(centerX, centerY);
      label.visible = true;
    }
  }

  public override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.bgGraphics.destroy();
    this.whiteKeysGraphics.destroy();
    this.blackKeysGraphics.destroy();
    this.badgesGraphics.destroy();
    for (const text of this.labelTextPool) {
      text.destroy();
    }
    this.labelsContainer.destroy();
    super.destroy(options);
  }
}
