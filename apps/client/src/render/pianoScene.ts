import type { M1KeyStyle, MotionPlan, Note, PerformancePlan, SongDocument } from "@handthesia/contracts";
import { Application, Container, Graphics } from "pixi.js";
import { FallingNotesView } from "./fallingNotesView";
import { HandsView } from "./handsView";
import { KeyboardView, type KeyPressInfo } from "./keyboardView";
import type { MotionBuffer } from "./motionBuffer";
import type { SkinStyle } from "./skins";

export interface PianoSceneDisplaySettings {
  showFingerLabels?: boolean;
  showNoteNames?: boolean;
  skinStyle?: SkinStyle;
  showHandShadow?: boolean;
  renderCapFps?: number;
}

export interface PianoSceneOptions {
  target: HTMLElement;
  keyStyle?: M1KeyStyle;
  pixelsPerSecond?: number;
  keyboardHeight?: number;
  song?: SongDocument | null;
  notes?: Note[];
  motionPlan?: MotionPlan | null;
  performancePlan?: PerformancePlan | null;
  displaySettings?: PianoSceneDisplaySettings;
  backgroundColor?: number;
  motionBuffer?: MotionBuffer | null;
}

/**
 * Piano roll and keyboard layout constants
 */
export const KEY_LEN_WW = 5.6; // White key length in white-key widths
export const HAND_LEN_WW = 7.0; // Room below keys for hands and forearms
export const BOTTOM_MAX_SHARE = 0.5; // Keys + hand area never take more than 50% of height
export const HAND_AREA_MIN_H = 120; // Minimum hand area height in px
export const FELT_H = 6; // Red piano felt strip height in px

export interface BottomLayout {
  keyboardRect: { x: number; y: number; width: number; height: number };
  handRect: { x: number; y: number; width: number; height: number };
  feltRect: { x: number; y: number; width: number; height: number };
}

export function computeBottomLayout(
  width: number,
  height: number,
  customKeyboardHeight?: number,
): BottomLayout {
  let ww = width / 52.0;
  const budget = BOTTOM_MAX_SHARE * height;
  if (ww * (KEY_LEN_WW + HAND_LEN_WW) > budget) {
    ww = budget / (KEY_LEN_WW + HAND_LEN_WW);
  }

  const kbW = Math.round(ww * 52);
  const kbH = customKeyboardHeight ?? Math.round(ww * KEY_LEN_WW);
  const handH = Math.max(
    Math.round(ww * HAND_LEN_WW),
    Math.min(HAND_AREA_MIN_H, Math.round(height * 0.2)),
  );
  const kbX = Math.round((width - kbW) / 2);
  const kbY = Math.max(FELT_H, height - handH - kbH);

  return {
    keyboardRect: { x: kbX, y: kbY, width: kbW, height: kbH },
    handRect: { x: kbX, y: kbY + kbH, width: kbW, height: handH },
    feltRect: { x: kbX, y: kbY - FELT_H, width: kbW, height: FELT_H },
  };
}

export class PianoScene {
  private readonly app: Application;
  private readonly target: HTMLElement;
  private readonly keyboardView: KeyboardView;
  private readonly fallingNotesView: FallingNotesView;
  private readonly handsView: HandsView;
  private readonly backgroundGraphics = new Graphics();
  private readonly sceneContainer = new Container();

  private keyStyle: M1KeyStyle = "realistic";
  private pixelsPerSecond = 200;
  private keyboardHeight?: number;
  private currentBottomLayout: BottomLayout | null = null;
  private notes: Note[] = [];
  private motionPlan: MotionPlan | null = null;
  private performancePlan: PerformancePlan | null = null;
  private displaySettings: Required<PianoSceneDisplaySettings> = {
    showFingerLabels: true,
    showNoteNames: false,
    skinStyle: "cartoon",
    showHandShadow: true,
    renderCapFps: 60,
  };
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;

  private constructor(app: Application, options: PianoSceneOptions) {
    this.app = app;
    this.target = options.target;
    this.keyStyle = options.keyStyle ?? "realistic";
    this.pixelsPerSecond = options.pixelsPerSecond ?? 200;
    this.keyboardHeight = options.keyboardHeight;

    this.keyboardView = new KeyboardView();
    this.fallingNotesView = new FallingNotesView({ pixelsPerSecond: this.pixelsPerSecond });
    this.handsView = new HandsView();

    // Scene display hierarchy:
    // 1. Background lanes/guides
    // 2. Falling notes
    // 3. Piano keyboard
    // 4. Skeletal hands
    this.sceneContainer.addChild(this.backgroundGraphics);
    this.sceneContainer.addChild(this.fallingNotesView);
    this.sceneContainer.addChild(this.keyboardView);
    this.sceneContainer.addChild(this.handsView);

    this.app.stage.addChild(this.sceneContainer);

    if (options.song) {
      this.setSong(options.song);
    } else if (options.notes) {
      this.setNotes(options.notes);
    }
    if (options.motionPlan) {
      this.setMotionPlan(options.motionPlan);
    }
    if (options.motionBuffer !== undefined) {
      this.setMotionBuffer(options.motionBuffer);
    }
    if (options.performancePlan) {
      this.setPerformancePlan(options.performancePlan);
    }
    if (options.displaySettings) {
      this.setDisplaySettings(options.displaySettings);
    }
  }

  public static async create(options: PianoSceneOptions): Promise<PianoScene> {
    const app = new Application();
    const isCanvas = options.target instanceof HTMLCanvasElement;

    await app.init({
      ...(isCanvas ? { canvas: options.target as HTMLCanvasElement } : { resizeTo: options.target }),
      autoDensity: true,
      resolution: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      backgroundColor: options.backgroundColor ?? 0x121216,
    });

    if (!isCanvas) {
      options.target.appendChild(app.canvas);
    }

    const scene = new PianoScene(app, options);
    scene.setupResizeObserver();
    scene.resize();
    return scene;
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.isDestroyed) {
          this.resize();
        }
      });
      this.resizeObserver.observe(this.target);
    }
  }

  public resize(): void {
    if (this.isDestroyed) return;

    const width = Math.max(10, this.target.clientWidth || this.app.screen.width);
    const height = Math.max(10, this.target.clientHeight || this.app.screen.height);

    const bottomLayout = computeBottomLayout(width, height, this.keyboardHeight);
    this.currentBottomLayout = bottomLayout;
    this.keyboardView.setLayout(bottomLayout.keyboardRect, this.keyStyle);

    const layout = this.keyboardView.getLayout();
    this.fallingNotesView.setLayout({
      hitLineY: bottomLayout.keyboardRect.y,
      viewportTop: 0,
      viewportBottom: bottomLayout.keyboardRect.y,
      keyboardLayout: layout,
    });
    this.handsView.setKeyboardLayout(layout);

    this.drawBackground(width, height, bottomLayout);
  }

  public getBottomLayout(): BottomLayout | null {
    return this.currentBottomLayout;
  }

  private drawBackground(width: number, height: number, layout: BottomLayout): void {
    this.backgroundGraphics.clear();
    if (width <= 0 || height <= 0) return;

    const { keyboardRect, handRect, feltRect } = layout;
    const fallingHeight = keyboardRect.y;

    // 1. Falling notes backdrop
    this.backgroundGraphics.rect(0, 0, width, fallingHeight).fill(0x101014);

    const kbLayout = this.keyboardView.getLayout();

    // Equal mode lane shading
    if (kbLayout.style === "equal" && kbLayout.laneShade.length > 0) {
      for (const lane of kbLayout.laneShade) {
        this.backgroundGraphics
          .rect(lane.x, 0, lane.width, fallingHeight)
          .fill({ color: 0x171720, alpha: 0.5 });
      }
    }

    // Guide lines at octave boundaries (C and F)
    for (const lineX of kbLayout.laneLines) {
      this.backgroundGraphics
        .moveTo(lineX, 0)
        .lineTo(lineX, fallingHeight)
        .stroke({ width: 1, color: 0x252530, alpha: 0.4 });
    }

    // 2. Red felt strip above keys (FELT = 0x961622)
    this.backgroundGraphics
      .rect(feltRect.x, feltRect.y, feltRect.width, feltRect.height)
      .fill(0x961622);
    this.backgroundGraphics
      .moveTo(feltRect.x, feltRect.y)
      .lineTo(feltRect.x + feltRect.width, feltRect.y)
      .stroke({ width: 1, color: 0xb55c64 });

    // 3. Hand area backdrop below keys (HAND_AREA_BG = 0x1e1e26)
    this.backgroundGraphics
      .rect(handRect.x, handRect.y, handRect.width, handRect.height)
      .fill(0x1e1e26);
    // Subtle top border line between keyboard and hand area
    this.backgroundGraphics
      .moveTo(handRect.x, handRect.y)
      .lineTo(handRect.x + handRect.width, handRect.y)
      .stroke({ width: 1, color: 0x32323e });

    // 4. Margins on left and right (if keyboard is centered and narrower than window)
    if (keyboardRect.x > 0) {
      const marginH = height - (keyboardRect.y - feltRect.height);
      const marginY = keyboardRect.y - feltRect.height;
      // Left margin
      this.backgroundGraphics
        .rect(0, marginY, keyboardRect.x, marginH)
        .fill(0x121216);
      // Right margin
      const rightX = keyboardRect.x + keyboardRect.width;
      this.backgroundGraphics
        .rect(rightX, marginY, width - rightX, marginH)
        .fill(0x121216);
    }
  }

  public update(transportTime: number, activeNotes?: number[]): void {
    if (this.isDestroyed) return;

    // Determine pressed keys map
    const pressedMap = new Map<number, KeyPressInfo>();

    if (activeNotes !== undefined) {
      for (const pitch of activeNotes) {
        // Try to match hand and finger from current note in song
        const matched = this.findActiveNoteForPitch(pitch, transportTime);
        if (matched) {
          pressedMap.set(pitch, { hand: matched.hand, finger: matched.finger });
        } else {
          pressedMap.set(pitch, { hand: pitch < 60 ? "left" : "right" });
        }
      }
    } else {
      // Keyboard state follows the performed key-down intervals when available.
      for (const note of this.fallingNotesView.getRenderedNoteTimings()) {
        if (note.startSeconds <= transportTime && transportTime < note.endSeconds) {
          pressedMap.set(note.pitch, { hand: note.hand, finger: note.finger });
        }
      }
    }

    this.keyboardView.setPressedKeys(pressedMap);
    this.fallingNotesView.update(transportTime);
    this.handsView.update(transportTime);
  }

  private findActiveNoteForPitch(pitch: number, time: number) {
    return this.fallingNotesView.getRenderedNoteTimings().find(
      (n) => n.pitch === pitch && n.startSeconds <= time && time <= n.endSeconds + 0.05,
    );
  }

  public setSong(song: SongDocument | null): void {
    this.setNotes(song?.notes ?? []);
  }

  public setNotes(notes: Note[]): void {
    this.notes = notes;
    this.fallingNotesView.setNotes(notes);
    if (this.performancePlan) {
      this.fallingNotesView.setPerformancePlan(this.performancePlan, this.notes);
    }
  }

  public setPerformancePlan(plan: PerformancePlan | null, document?: SongDocument): void {
    if (document) {
      this.notes = document.notes;
      this.fallingNotesView.setNotes(this.notes);
    }
    this.performancePlan = plan;
    this.fallingNotesView.setPerformancePlan(plan, this.notes);
  }

  public setMotionPlan(motionPlan: MotionPlan | null): void {
    this.motionPlan = motionPlan;
    this.handsView.setMotionPlan(motionPlan);
  }

  public setMotionBuffer(buffer: MotionBuffer | null): void {
    this.handsView.setMotionBuffer(buffer);
  }

  public getMotionBuffer(): MotionBuffer | null {
    return this.handsView.getMotionBuffer();
  }

  public setDisplaySettings(settings: PianoSceneDisplaySettings): void {
    const requestedCap = settings.renderCapFps;
    this.displaySettings = {
      ...this.displaySettings,
      ...settings,
      renderCapFps:
        requestedCap === 0 || requestedCap === 30 || requestedCap === 60 || requestedCap === 120
          ? requestedCap
          : this.displaySettings.renderCapFps,
    };
    this.app.ticker.maxFPS = this.displaySettings.renderCapFps;
    this.keyboardView.setShowFingerLabels(this.displaySettings.showFingerLabels);
    this.fallingNotesView.setDisplaySettings({
      showFingerLabels: this.displaySettings.showFingerLabels,
      showNoteNames: this.displaySettings.showNoteNames,
    });
    this.handsView.setShowFingerLabels(this.displaySettings.showFingerLabels);
    const currentSkin = this.handsView.getSkinSettings();
    this.handsView.setSkinSettings({
      ...currentSkin,
      style: this.displaySettings.skinStyle,
      shadow: this.displaySettings.showHandShadow,
    });
  }

  public setKeyStyle(style: M1KeyStyle): void {
    if (this.keyStyle !== style) {
      this.keyStyle = style;
      this.resize();
    }
  }

  public setPixelsPerSecond(pps: number): void {
    this.pixelsPerSecond = pps;
    this.fallingNotesView.setPixelsPerSecond(pps);
  }

  public getApp(): Application {
    return this.app;
  }

  public getKeyboardView(): KeyboardView {
    return this.keyboardView;
  }

  public getFallingNotesView(): FallingNotesView {
    return this.fallingNotesView;
  }

  public getHandsView(): HandsView {
    return this.handsView;
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.sceneContainer.destroy({ children: true });
    this.app.destroy(true, { children: true });
  }
}
