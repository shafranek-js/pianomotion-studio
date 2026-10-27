import type { FingeringPlan, M1KeyStyle, MotionPlan, Note, PerformancePlan, SongDocument } from "@handthesia/contracts";
import { Application, Container, Graphics } from "pixi.js";
import { PianoScene3D, type Camera3DPreset } from "../render3d";
import type { HandModelDiagnosticsSnapshot } from "../render3d/improvedHandRuntime";
import { FallingNotesView } from "./fallingNotesView";
import { HandsView } from "./handsView";
import { KeyboardView, type KeyPressInfo } from "./keyboardView";
import type { MotionBuffer } from "./motionBuffer";
import { preloadAllPhotoAssets, type SkinStyle } from "./skins";
import { normalizeStageAppearance, type StageAppearance } from "../settings/stageAppearance";

export interface PianoSceneDisplaySettings {
  stageAppearance?: StageAppearance;
  showFingerLabels?: boolean;
  showNoteNames?: boolean;
  skinStyle?: SkinStyle;
  handModel?: "anatomical" | "anatomical-improved" | "webxr" | "testing";
  testingHandMaterial?: "original" | "no-normal" | "no-albedo" | "clay";
  testingThumbStrength?: 0 | 0.25 | 0.5 | 0.75 | 1;
  testingKeyContact?: boolean;
  showHandShadow?: boolean;
  renderCapFps?: number;
}

export interface PianoSceneOptions {
  target: HTMLElement;
  /** Offline renders have an immutable pixel viewport and no automatic ticker. */
  fixedViewport?: { width: number; height: number; resolution: 1 };
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
  onContextLost?: (error: Error) => void;
  onContextRestored?: () => void;
}

/**
 * Piano roll and keyboard layout constants
 */
export const KEY_LEN_WW = 5.6; // White key length in white-key widths
export const HAND_LEN_WW = 7.0; // Room below keys for hands and forearms
export const BOTTOM_MAX_SHARE = 0.5; // Keys + hand area never take more than 50% of height
export const HAND_AREA_MIN_H = 120; // Minimum hand area height in px
export const FELT_H = 6; // Red piano felt strip height in px

function getRendererResolution(): number {
  const devicePixelRatio = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(2, Math.max(1, devicePixelRatio));
}

export interface BottomLayout {
  keyboardRect: { x: number; y: number; width: number; height: number };
  handRect: { x: number; y: number; width: number; height: number };
  feltRect: { x: number; y: number; width: number; height: number };
}

export interface PianoSceneFingeringEditorOptions {
  active: boolean;
  playing: boolean;
  plan: FingeringPlan | null;
  selectedNoteIds: ReadonlySet<string>;
  onSelectionChange?: (noteIds: readonly string[]) => void;
  onPauseForScroll?: () => void;
  onEditorViewTimeChange?: (time: number | null) => void;
}

export interface PianoSceneGeometrySnapshot {
  notes: Array<{
    noteId: string;
    pitch: number;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  keyboardRect: { x: number; y: number; width: number; height: number } | null;
  keyCount: number;
  minPitch: number;
  maxPitch: number;
  rendererSize: { width: number; height: number };
  viewTime: number;
  handModelDiagnostics: HandModelDiagnosticsSnapshot | null;
}

export function getKeyboardInventory(keyRects: ReadonlyMap<number, unknown>): {
  keyCount: number;
  minPitch: number;
  maxPitch: number;
} {
  const pitches = [...keyRects.keys()].sort((left, right) => left - right);
  return {
    keyCount: pitches.length,
    minPitch: pitches[0] ?? 0,
    maxPitch: pitches[pitches.length - 1] ?? 0,
  };
}

export function computeBottomLayout(
  width: number,
  height: number,
  customKeyboardHeight?: number,
): BottomLayout {
  const ww = Math.max(1, width) / 52.0;
  const budget = Math.max(0, BOTTOM_MAX_SHARE * height);
  const desiredKeyboardHeight = Math.max(1, customKeyboardHeight ?? Math.round(ww * KEY_LEN_WW));
  const desiredHandHeight = Math.max(
    Math.round(ww * HAND_LEN_WW),
    Math.min(HAND_AREA_MIN_H, Math.round(height * 0.2)),
  );
  const desiredTotal = desiredKeyboardHeight + desiredHandHeight;
  const verticalScale = desiredTotal > budget && desiredTotal > 0 ? budget / desiredTotal : 1;
  const kbH = Math.max(0, Math.round(desiredKeyboardHeight * verticalScale));
  const scaledHandHeight = Math.max(0, Math.round(desiredHandHeight * verticalScale));
  const handH = Math.max(0, Math.min(scaledHandHeight, Math.floor(budget) - kbH));
  // Keep all 88 keys visible across the available width; only their vertical
  // presentation is compressed in short viewports.
  const kbW = Math.max(0, width);
  const kbX = 0;
  const kbY = Math.max(0, height - handH - kbH);

  return {
    keyboardRect: { x: kbX, y: kbY, width: kbW, height: kbH },
    handRect: { x: kbX, y: kbY + kbH, width: kbW, height: handH },
    feltRect: { x: kbX, y: kbY - FELT_H, width: kbW, height: FELT_H },
  };
}

/**
 * Releases a partially initialized Pixi application or scene after startup
 * failure without masking the original initialization error.
 */
export function disposeFailedScene(
  app: Pick<Application, "destroy">,
  scene: Pick<PianoScene, "destroy"> | null,
): void {
  if (scene) {
    try {
      scene.destroy();
    } catch {
      // Preserve the original initialization error.
    }
    return;
  }
  try {
    app.destroy(true, { children: true });
  } catch {
    // Preserve the original initialization error.
  }
}

export class PianoScene {
  private readonly app: Application;
  private readonly target: HTMLElement;
  private readonly fixedViewport: PianoSceneOptions["fixedViewport"];
  private readonly keyboardView: KeyboardView;
  private readonly fallingNotesView: FallingNotesView;
  private readonly handsView: HandsView;
  private readonly backgroundGraphics = new Graphics();
  private readonly fallingNotesMask = new Graphics();
  private readonly sceneContainer = new Container();
  private readonly onContextLost?: (error: Error) => void;
  private readonly onContextRestored?: () => void;
  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.onContextLost?.(new Error("WebGL context lost"));
  };
  private readonly handleContextRestored = () => {
    this.onContextRestored?.();
  };

  private keyStyle: M1KeyStyle = "realistic";
  private pixelsPerSecond = 200;
  private keyboardHeight?: number;
  private currentBottomLayout: BottomLayout | null = null;
  private notes: Note[] = [];
  private motionPlan: MotionPlan | null = null;
  private performancePlan: PerformancePlan | null = null;
  private fingeringEditor: PianoSceneFingeringEditorOptions = {
    active: false,
    playing: false,
    plan: null,
    selectedNoteIds: new Set(),
  };
  private editorViewTime: number | null = null;
  private currentTransportTime = 0;
  private lastActiveNotes: number[] | undefined;
  private pointerSelection: {
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    additive: boolean;
    originalSelection: Set<string>;
  } | null = null;
  private activePointerPitches = new Map<number, number>();
  private livePhysicalPitches = new Set<number>();
  private playAlongMode = false;
  private onPianoKeyDown?: (pitch: number) => void;
  private onPianoKeyUp?: (pitch: number) => void;
  private displaySettings: Required<PianoSceneDisplaySettings> = {
    stageAppearance: normalizeStageAppearance(undefined),
    showFingerLabels: false,
    showNoteNames: false,
    skinStyle: "cartoon",
    showHandShadow: true,
    renderCapFps: 60,
    handModel: "anatomical",
    testingHandMaterial: "original",
    testingThumbStrength: 0,
    testingKeyContact: true,
  };
  private resizeObserver: ResizeObserver | null = null;
  private scene3D: PianoScene3D | null = null;
  private mode3D = false;
  private camera3DPreset: Camera3DPreset = "concert";
  private isDestroyed = false;

  private constructor(app: Application, options: PianoSceneOptions) {
    this.app = app;
    this.target = options.target;
    this.fixedViewport = options.fixedViewport;
    this.onContextLost = options.onContextLost;
    this.onContextRestored = options.onContextRestored;
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
    this.fallingNotesView.mask = this.fallingNotesMask;
    this.sceneContainer.addChild(this.backgroundGraphics);
    this.sceneContainer.addChild(this.fallingNotesMask);
    this.sceneContainer.addChild(this.fallingNotesView);
    this.sceneContainer.addChild(this.keyboardView);
    this.sceneContainer.addChild(this.handsView);

    this.app.stage.addChild(this.sceneContainer);
    this.app.canvas.tabIndex = 0;
    this.app.canvas.setAttribute("aria-label", "Piano workspace");
    this.app.canvas.addEventListener("pointerdown", this.handleEditorPointerDown);
    this.app.canvas.addEventListener("pointermove", this.handleEditorPointerMove);
    this.app.canvas.addEventListener("pointerup", this.handleEditorPointerUp);
    this.app.canvas.addEventListener("pointercancel", this.handleEditorPointerUp);
    this.app.canvas.addEventListener("wheel", this.handleEditorWheel, { passive: false });
    this.app.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.app.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);

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
    let scene: PianoScene | null = null;
    try {
      const isCanvas = options.target instanceof HTMLCanvasElement;
      const fixed = options.fixedViewport;
      if (fixed && (!Number.isInteger(fixed.width) || !Number.isInteger(fixed.height) ||
          fixed.width < 2 || fixed.height < 2 || fixed.resolution !== 1)) {
        throw new Error("Export viewport requires integer width/height of at least two pixels and resolution=1.");
      }

      await app.init({
        ...(isCanvas ? { canvas: options.target as HTMLCanvasElement } : fixed ? {} : { resizeTo: options.target }),
        ...(fixed ? { width: fixed.width, height: fixed.height, autoStart: false, sharedTicker: false } : {}),
        autoDensity: !fixed,
        // Native DPR plus MSAA smooths vector edges without extra full-scene supersampling.
        antialias: true,
        resolution: fixed?.resolution ?? getRendererResolution(),
        backgroundColor: options.backgroundColor ?? 0x121216,
      });

      if (!isCanvas) {
        options.target.appendChild(app.canvas);
      }

      preloadAllPhotoAssets().catch(() => {});

      scene = new PianoScene(app, options);
      scene.setupResizeObserver();
      scene.resize();
      return scene;
    } catch (error) {
      disposeFailedScene(app, scene);
      throw error;
    }
  }

  private setupResizeObserver(): void {
    if (this.fixedViewport) return;
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

    const width = this.fixedViewport?.width ?? Math.max(10, this.target.clientWidth || this.app.screen.width);
    const height = this.fixedViewport?.height ?? Math.max(10, this.target.clientHeight || this.app.screen.height);
    const resolution = this.fixedViewport?.resolution ?? getRendererResolution();

    // `resizeTo` handles ordinary visible DOM resizes, while this explicit
    // resize keeps the renderer backing canvas in step with measured pane
    // dimensions after the scene was hidden or moved by the studio splitter.
    if (
      this.app.screen.width !== width ||
      this.app.screen.height !== height ||
      this.app.renderer.resolution !== resolution
    ) {
      this.app.renderer.resize(width, height, resolution);
    }

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
    this.fallingNotesMask.clear();
    this.fallingNotesMask.rect(0, 0, width, bottomLayout.keyboardRect.y).fill(0xffffff);
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
    this.currentTransportTime = transportTime;
    this.lastActiveNotes = activeNotes;
    const editorPaused = this.fingeringEditor.active && !this.fingeringEditor.playing;
    const sceneTime = editorPaused ? (this.editorViewTime ?? transportTime) : transportTime;

    // Determine pressed keys map
    const pressedMap = new Map<number, KeyPressInfo>();
    const targetKeys = this.keyboardView.getTargetKeys();

    if (this.playAlongMode) {
      // In Play Along mode, score notes at sceneTime are targets waiting to be pressed,
      // NOT automatically pressed keys. Only explicit activeNotes or livePhysicalPitches are pressed.
      if (activeNotes !== undefined) {
        for (const pitch of activeNotes) {
          const targetInfo = targetKeys.get(pitch);
          const matched = targetInfo ?? this.findActiveNoteForPitch(pitch, sceneTime);
          if (matched) {
            pressedMap.set(pitch, { hand: matched.hand, finger: matched.finger });
          } else {
            pressedMap.set(pitch, { hand: pitch < 60 ? "left" : "right" });
          }
        }
      }
    } else if (activeNotes !== undefined && !editorPaused) {
      for (const pitch of activeNotes) {
        // Try to match hand and finger from current note in song
        const matched = this.findActiveNoteForPitch(pitch, sceneTime);
        if (matched) {
          pressedMap.set(pitch, { hand: matched.hand, finger: matched.finger });
        } else {
          pressedMap.set(pitch, { hand: pitch < 60 ? "left" : "right" });
        }
      }
    } else {
      // Keyboard state follows the performed key-down intervals when available.
      for (const note of this.fallingNotesView.getRenderedNoteTimings()) {
        if (note.startSeconds <= sceneTime && sceneTime < note.endSeconds) {
          pressedMap.set(note.pitch, { hand: note.hand, finger: note.finger });
        }
      }
    }

    // Direct physical MIDI / keyboard input: keys held by user are always shown as pressed!
    for (const pitch of this.livePhysicalPitches) {
      if (!pressedMap.has(pitch)) {
        const targetInfo = targetKeys.get(pitch);
        const matched = targetInfo ?? this.findActiveNoteForPitch(pitch, sceneTime);
        if (matched) {
          pressedMap.set(pitch, { hand: matched.hand, finger: matched.finger });
        } else {
          pressedMap.set(pitch, { hand: pitch < 60 ? "left" : "right" });
        }
      }
    }

    const show3D = this.mode3D && !this.fingeringEditor.active;
    if (!show3D) {
      this.keyboardView.setPressedKeys(pressedMap);
      this.fallingNotesView.update(sceneTime);
      this.handsView.update(sceneTime);
    }

    if (this.scene3D && show3D) {
      this.scene3D.update(sceneTime, [...pressedMap.keys()]);
    }
  }

  public set3DMode(enabled: boolean): void {
    if (this.fixedViewport || this.isDestroyed) return;
    if (enabled && !this.scene3D) {
      let candidate: PianoScene3D | null = null;
      try {
        candidate = new PianoScene3D(this.target, {
          onContextLost: this.onContextLost,
          onContextRestored: this.onContextRestored,
          initialHandModel: this.displaySettings.handModel,
        });
        candidate.setNotes(this.notes);
        candidate.setMotionPlan(this.motionPlan);
        candidate.setMotionBuffer(this.handsView.getMotionBuffer());
        candidate.setPerformancePlan(this.performancePlan);
        candidate.setPixelsPerSecond(this.pixelsPerSecond);
        candidate.setDisplaySettings(this.displaySettings);
        candidate.setPlayAlongMode(this.playAlongMode);
        candidate.setPlayAlongTargetPitches(this.keyboardView.getTargetKeys());
        candidate.setLivePressedPitches(this.livePhysicalPitches);
        candidate.setCameraPreset(this.camera3DPreset);
        candidate.setKeyInputHandlers({
        onKeyDown: (pitch) => this.onPianoKeyDown?.(pitch),
        onKeyUp: (pitch) => this.onPianoKeyUp?.(pitch),
        });
        this.scene3D = candidate;
      } catch (error) {
        candidate?.destroy();
        this.mode3D = false;
        this.sync3DVisibility();
        throw error;
      }
    }
    this.mode3D = enabled;
    this.sync3DVisibility();
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public is3DMode(): boolean {
    return this.mode3D;
  }

  public setCamera3DPreset(preset: Camera3DPreset): void {
    this.camera3DPreset = preset;
    this.scene3D?.setCameraPreset(preset);
  }

  public getCamera3DPreset(): Camera3DPreset {
    return this.camera3DPreset;
  }

  private sync3DVisibility(): void {
    const show3D = this.mode3D && !this.fingeringEditor.active;
    this.app.canvas.style.visibility = show3D ? "hidden" : "visible";
    this.scene3D?.setVisible(show3D);

    if (!this.fixedViewport && this.app.ticker) {
      if (show3D) {
        if (this.app.ticker.started) {
          this.app.ticker.stop();
        }
      } else {
        if (!this.app.ticker.started) {
          this.app.ticker.start();
        }
      }
    }
  }

  public setLivePhysicalPitch(pitch: number, isDown: boolean): void {
    if (isDown) {
      this.livePhysicalPitches.add(pitch);
    } else {
      this.livePhysicalPitches.delete(pitch);
    }
    this.scene3D?.setLivePressedPitches(this.livePhysicalPitches);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public clearLivePhysicalPitches(): void {
    if (this.livePhysicalPitches.size === 0) return;
    this.livePhysicalPitches.clear();
    this.scene3D?.setLivePressedPitches(this.livePhysicalPitches);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public getLivePhysicalPitches(): ReadonlySet<number> {
    return this.livePhysicalPitches;
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
    this.scene3D?.setNotes(notes);
    if (this.fingeringEditor.active) {
      this.fallingNotesView.setFingeringPlan(this.fingeringEditor.plan);
    } else if (this.performancePlan) {
      this.fallingNotesView.setPerformancePlan(this.performancePlan, this.notes);
    }
  }

  public setPerformancePlan(plan: PerformancePlan | null, document?: SongDocument): void {
    if (document) {
      this.notes = document.notes;
      this.fallingNotesView.setNotes(this.notes);
      this.scene3D?.setNotes(this.notes);
    }
    this.performancePlan = plan;
    this.scene3D?.setPerformancePlan(plan);
    if (this.fingeringEditor.active) {
      this.fallingNotesView.setFingeringPlan(this.fingeringEditor.plan);
    } else {
      this.fallingNotesView.setPerformancePlan(plan, this.notes);
    }
  }

  public setFingeringEditor(options: PianoSceneFingeringEditorOptions): void {
    const wasActive = this.fingeringEditor.active;
    const planChanged = this.fingeringEditor.plan !== options.plan;
    this.fingeringEditor = options;
    if (options.active) {
      // A transport lead-in is useful for playback, but can leave the edit
      // viewport entirely before the first note on a short screen.
      if (!wasActive && !options.playing && this.editorViewTime === null && this.currentTransportTime < 0) {
        this.editorViewTime = 0;
        options.onEditorViewTimeChange?.(0);
      }
      if (!wasActive || planChanged) this.fallingNotesView.setFingeringPlan(options.plan);
      this.fallingNotesView.setSelectedNoteIds(options.selectedNoteIds);
    } else if (wasActive) {
      this.fallingNotesView.setPerformancePlan(this.performancePlan, this.notes);
      this.fallingNotesView.setSelectedNoteIds([]);
      this.fallingNotesView.setSelectionMarquee(null);
      this.pointerSelection = null;
    }
    this.sync3DVisibility();
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setPianoKeyListeners(onDown?: (pitch: number) => void, onUp?: (pitch: number) => void): void {
    this.onPianoKeyDown = onDown;
    this.onPianoKeyUp = onUp;
    this.scene3D?.setKeyInputHandlers({
      onKeyDown: (pitch) => this.onPianoKeyDown?.(pitch),
      onKeyUp: (pitch) => this.onPianoKeyUp?.(pitch),
    });
  }

  public setPlayAlongState(
    targets?: Map<number, KeyPressInfo> | null,
    wrongPitches?: Set<number> | null,
  ): void {
    this.playAlongMode = Boolean(targets);
    if (!this.playAlongMode) {
      this.lastActiveNotes = undefined;
    }
    this.keyboardView.setPlayAlongState(targets, wrongPitches);
    this.scene3D?.setPlayAlongMode(this.playAlongMode);
    this.scene3D?.setPlayAlongTargetPitches(targets ?? null, wrongPitches ?? null);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  private getCanvasPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const bounds = this.app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (this.app.screen.width / Math.max(1, bounds.width)),
      y: (event.clientY - bounds.top) * (this.app.screen.height / Math.max(1, bounds.height)),
    };
  }

  private handleEditorPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const point = this.getCanvasPoint(event);

    // 1. Check if clicking on the piano keyboard
    if (this.currentBottomLayout && point.y >= this.currentBottomLayout.keyboardRect.y) {
      const pitch = this.keyboardView.getPitchAt(point.x, point.y);
      if (pitch !== null) {
        this.activePointerPitches.set(event.pointerId, pitch);
        this.onPianoKeyDown?.(pitch);
        try {
          this.app.canvas.setPointerCapture(event.pointerId);
        } catch {
          // Ignored
        }
        event.preventDefault();
        return;
      }
    }

    if (!this.fingeringEditor.active) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const noteId = this.fallingNotesView.getNoteAtPoint(point.x, point.y, this.getCurrentSceneTime());
    if (noteId) {
      const selection = new Set(this.fingeringEditor.selectedNoteIds);
      if (additive && selection.has(noteId)) selection.delete(noteId);
      else if (additive) selection.add(noteId);
      else {
        selection.clear();
        selection.add(noteId);
      }
      this.fallingNotesView.setSelectedNoteIds(selection);
      this.fingeringEditor.onSelectionChange?.([...selection]);
      this.app.canvas.focus({ preventScroll: true });
      event.preventDefault();
      return;
    }

    this.pointerSelection = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      moved: false,
      additive,
      originalSelection: new Set(this.fingeringEditor.selectedNoteIds),
    };
    try {
      this.app.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Ignored
    }
    this.fallingNotesView.setSelectionMarquee({ x: point.x, y: point.y, width: 0, height: 0 });
    this.app.canvas.focus({ preventScroll: true });
    event.preventDefault();
  };

  private handleEditorPointerMove = (event: PointerEvent): void => {
    // 1. Check if dragging across piano keys
    const activePitch = this.activePointerPitches.get(event.pointerId);
    if (activePitch !== undefined) {
      const point = this.getCanvasPoint(event);
      const nextPitch = this.keyboardView.getPitchAt(point.x, point.y);
      if (nextPitch !== activePitch) {
        this.onPianoKeyUp?.(activePitch);
        if (nextPitch !== null) {
          this.activePointerPitches.set(event.pointerId, nextPitch);
          this.onPianoKeyDown?.(nextPitch);
        } else {
          this.activePointerPitches.delete(event.pointerId);
        }
      }
      event.preventDefault();
      return;
    }

    const drag = this.pointerSelection;
    if (!this.fingeringEditor.active || !drag || drag.pointerId !== event.pointerId) return;
    const point = this.getCanvasPoint(event);
    const deltaX = point.x - drag.startX;
    const deltaY = point.y - drag.startY;
    drag.moved ||= Math.hypot(deltaX, deltaY) >= 4;
    if (!drag.moved) return;
    this.fallingNotesView.setSelectionMarquee({
      x: Math.min(drag.startX, point.x),
      y: Math.min(drag.startY, point.y),
      width: Math.abs(deltaX),
      height: Math.abs(deltaY),
    });
    event.preventDefault();
  };

  private handleEditorPointerUp = (event: PointerEvent): void => {
    // 1. Check if releasing piano key
    const activePitch = this.activePointerPitches.get(event.pointerId);
    if (activePitch !== undefined) {
      this.activePointerPitches.delete(event.pointerId);
      if (this.app.canvas.hasPointerCapture(event.pointerId)) {
        try {
          this.app.canvas.releasePointerCapture(event.pointerId);
        } catch {
          // Ignored
        }
      }
      this.onPianoKeyUp?.(activePitch);
      event.preventDefault();
      return;
    }

    const drag = this.pointerSelection;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.pointerSelection = null;
    if (this.app.canvas.hasPointerCapture(event.pointerId)) this.app.canvas.releasePointerCapture(event.pointerId);
    this.fallingNotesView.setSelectionMarquee(null);
    if (event.type === "pointercancel") return;

    const selection = drag.moved
      ? new Set(this.fallingNotesView.getNoteIdsInRect({
          x: Math.min(drag.startX, this.getCanvasPoint(event).x),
          y: Math.min(drag.startY, this.getCanvasPoint(event).y),
          width: Math.abs(this.getCanvasPoint(event).x - drag.startX),
          height: Math.abs(this.getCanvasPoint(event).y - drag.startY),
        }, this.getCurrentSceneTime()))
      : new Set<string>();
    if (drag.additive) for (const noteId of drag.originalSelection) selection.add(noteId);
    this.fallingNotesView.setSelectedNoteIds(selection);
    this.fingeringEditor.onSelectionChange?.([...selection]);
    event.preventDefault();
  };

  private handleEditorWheel = (event: WheelEvent): void => {
    if (!this.fingeringEditor.active) return;
    event.preventDefault();
    if (this.fingeringEditor.playing) {
      this.editorViewTime = this.currentTransportTime;
      this.fingeringEditor.onEditorViewTimeChange?.(this.editorViewTime);
      this.fingeringEditor.onPauseForScroll?.();
      return;
    }
    let anchor = this.editorViewTime ?? this.currentTransportTime;
    const oldPps = this.pixelsPerSecond;
    if (event.ctrlKey || event.metaKey) {
      const point = this.getCanvasPoint(event);
      const hitLine = this.currentBottomLayout?.keyboardRect.y ?? this.app.screen.height;
      const timeAtCursor = anchor + (hitLine - point.y) / oldPps;
      const nextPps = Math.max(40, Math.min(600, oldPps * Math.exp(-event.deltaY * 0.001)));
      anchor = timeAtCursor - (hitLine - point.y) / nextPps;
      this.setPixelsPerSecond(nextPps);
    } else {
      anchor += event.deltaY / oldPps;
    }
    this.setEditorViewTime(Math.max(0, anchor));
  };

  private getCurrentSceneTime(): number {
    return this.fingeringEditor.active && !this.fingeringEditor.playing
      ? (this.editorViewTime ?? this.currentTransportTime)
      : this.currentTransportTime;
  }

  public setEditorViewTime(time: number | null): void {
    this.editorViewTime = typeof time === "number" && Number.isFinite(time) ? time : null;
    this.fingeringEditor.onEditorViewTimeChange?.(this.editorViewTime);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public getEditorViewTime(): number | null {
    return this.editorViewTime;
  }

  public getGeometrySnapshot(): PianoSceneGeometrySnapshot {
    const editorPaused = this.fingeringEditor.active && !this.fingeringEditor.playing;
    const viewTime = editorPaused ? (this.editorViewTime ?? this.currentTransportTime) : this.currentTransportTime;
    if (this.mode3D && !this.fingeringEditor.active) {
      this.fallingNotesView.update(viewTime);
    }
    const inventory = getKeyboardInventory(this.keyboardView.getLayout().keyRects);
    return {
      notes: this.fallingNotesView.getPaintedNoteGeometries(viewTime).map((note) => ({
        noteId: note.noteId,
        pitch: note.pitch,
        rect: { ...note.visibleRect },
      })),
      keyboardRect: this.currentBottomLayout ? { ...this.currentBottomLayout.keyboardRect } : null,
      ...inventory,
      rendererSize: { width: this.app.screen.width, height: this.app.screen.height },
      viewTime,
      handModelDiagnostics: this.scene3D?.getHandModelDiagnostics() ?? null,
    };
  }

  public setMotionPlan(motionPlan: MotionPlan | null): void {
    this.motionPlan = motionPlan;
    this.handsView.setMotionPlan(motionPlan);
    this.scene3D?.setMotionPlan(motionPlan);
  }

  public setMotionBuffer(buffer: MotionBuffer | null): void {
    this.handsView.setMotionBuffer(buffer);
    this.scene3D?.setMotionBuffer(buffer);
  }

  public getMotionBuffer(): MotionBuffer | null {
    return this.handsView.getMotionBuffer();
  }

  public async waitForHandModelReady(): Promise<void> {
    await this.scene3D?.waitForHandModelReady();
  }

  public setDisplaySettings(settings: PianoSceneDisplaySettings): void {
    const requestedCap = settings.renderCapFps;
    this.displaySettings = {
      ...this.displaySettings,
      ...settings,
      stageAppearance: normalizeStageAppearance(settings.stageAppearance ?? this.displaySettings.stageAppearance),
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
    this.scene3D?.setDisplaySettings(this.displaySettings);
  }

  public setKeyStyle(style: M1KeyStyle): void {
    if (this.keyStyle !== style) {
      this.keyStyle = style;
      this.resize();
    }
  }

  public setPixelsPerSecond(pps: number): void {
    this.pixelsPerSecond = Math.max(40, Math.min(600, pps));
    this.fallingNotesView.setPixelsPerSecond(this.pixelsPerSecond);
    this.scene3D?.setPixelsPerSecond(this.pixelsPerSecond);
    this.update(this.currentTransportTime, this.lastActiveNotes);
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

    this.scene3D?.destroy();
    this.scene3D = null;

    if (this.app.ticker?.started) {
      this.app.ticker.stop();
    }

    this.app.canvas.removeEventListener("pointerdown", this.handleEditorPointerDown);
    this.app.canvas.removeEventListener("pointermove", this.handleEditorPointerMove);
    this.app.canvas.removeEventListener("pointerup", this.handleEditorPointerUp);
    this.app.canvas.removeEventListener("pointercancel", this.handleEditorPointerUp);
    this.app.canvas.removeEventListener("wheel", this.handleEditorWheel);
    this.app.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.app.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);

    this.sceneContainer.destroy({ children: true });
    this.app.destroy(true, { children: true });
  }
}
