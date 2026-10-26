import type {
  MotionPlan,
  MotionPose,
  Note,
  PerformanceEvent,
  PerformancePlan,
  SongDocument,
} from "@handthesia/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { KeyPressInfo } from "../render/keyboardView";
import { lerpPose, type MotionBuffer } from "../render/motionBuffer";
import type { PianoSceneDisplaySettings } from "../render/pianoScene";
import { normalizeSkinSettings, type SkinSettings } from "../render/skins";
import type { StageAppearance } from "../settings/stageAppearance";
import { FallingNotes3DView, NoteTimeIndex } from "./fallingNotes3dView";
import {
  Hand3DMeshGroup,
  KEYBOARD_WIDTH_IN,
} from "./handRigBuilder";
import { chooseImprovedHandExportLod, chooseImprovedHandLod, IMPROVED_HAND_MODEL_ID, type HandModelDiagnosticsSnapshot, type HandModelId } from "./improvedHandRuntime";
import { populateHandContactTargets, type ImprovedHandContactTarget } from "./improvedHandContact";
import { Keyboard3DView } from "./keyboard3dView";
import { PianoStage3D, type PianoStageDiagnostics } from "./pianoStage3d";

export type Camera3DPreset = "concert" | "overhead" | "pov" | "side_arch";

interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface PianoScene3DOptions {
  canvas?: HTMLCanvasElement;
  fixedViewport?: { width: number; height: number; resolution: 1 };
  onContextLost?: (error: Error) => void;
  onContextRestored?: () => void;
  /** Select the initial visible model before constructing either hand rig. */
  initialHandModel?: HandModelId;
}

export interface PianoCameraFit {
  fov: number;
  distance: number;
}

/** Keeps the full keyboard in frame on narrow viewports while preserving each preset's view direction. */
export function calculatePianoCameraFit(
  width: number,
  height: number,
  baseFov: number,
  preferredDistance: number,
  fitToKeyboard = true,
): PianoCameraFit {
  const aspect = Math.max(0.1, width) / Math.max(0.1, height);
  if (!fitToKeyboard) {
    const aspectScale = aspect < 1.0 ? Math.min(1.0 / aspect, 1.35) : 1;
    const fov = Math.min(65, baseFov * aspectScale);
    const distance = aspect < 1.0 ? preferredDistance * Math.min(1.4, 1.0 / aspect) : preferredDistance;
    return { fov, distance };
  }

  const fovFactor = aspect < 1.4 ? Math.min(1.4 / aspect, 1.45) : 1;
  const fov = Math.min(65, baseFov * fovFactor);

  // Full 88-key piano keyboard width is 48 inches (±24 in from center).
  // With cheeks and safe viewing margin (~8%), half-extent is ~27.2 in.
  const halfWidthWithMargin = (KEYBOARD_WIDTH_IN * 0.5 + 1.2) * 1.08;
  const frontKeyDepthOffset = 3.5;

  const halfHorizontalFov = Math.tan((fov * Math.PI) / 360) * aspect;
  const minDistance = halfWidthWithMargin / Math.max(1e-4, halfHorizontalFov) + frontKeyDepthOffset;
  const distance = Math.max(preferredDistance, minDistance);
  return { fov, distance };
}

/** Builds key depressions from score intervals only when the transport has no authoritative pitch set. */
export function buildActiveKeysForFrame(
  activeScoreNotes: readonly Note[],
  explicitActiveNotes: readonly number[] | undefined,
): Map<number, KeyPressInfo | null> {
  const active = new Map<number, KeyPressInfo | null>();
  if (explicitActiveNotes !== undefined) {
    for (const pitch of explicitActiveNotes) {
      const note = activeScoreNotes.find((candidate) => candidate.pitch === pitch);
      active.set(
        pitch,
        note?.hand
          ? { hand: note.hand, ...(note.finger != null ? { finger: note.finger } : {}) }
          : null,
      );
    }
  } else {
    for (const note of activeScoreNotes) {
      active.set(
        note.pitch,
        note.hand
          ? { hand: note.hand, ...(note.finger != null ? { finger: note.finger } : {}) }
          : null,
      );
    }
  }
  return active;
}

/** Finds the latest CC64 state at a transport time; CC66/67 never affect the sustain pedal. */
export function sustainPedalDownAtTime(
  events: readonly Extract<PerformanceEvent, { type: "pedal" }>[],
  timeSeconds: number,
): boolean {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid]!.timeSeconds <= timeSeconds) low = mid + 1;
    else high = mid;
  }
  return low > 0 && events[low - 1]!.value >= 64;
}

/** Calculates hover release lift (0 to 1) for a hand after its final note completes. */
export function calculateHandHoverLift(
  hand: "left" | "right",
  timeSeconds: number,
  noteSource: readonly Note[],
): number {
  let lastNoteEnd = -1;
  let hasNotes = false;

  for (const note of noteSource) {
    const isThisHand = note.hand === hand || (note.hand as string) === (hand === "left" ? "L" : "R");
    if (isThisHand) {
      hasNotes = true;
      if (note.endSeconds > lastNoteEnd) {
        lastNoteEnd = note.endSeconds;
      }
    }
  }

  if (!hasNotes) return 1.0;
  if (timeSeconds < lastNoteEnd) return 0;
  return 1.0;
}

const CAMERA_PRESETS: Record<Camera3DPreset, CameraPose> = {
  concert: {
    position: [0, 25.5, 20.5],
    target: [0, 0.2, -4.2],
    fov: 38,
  },
  overhead: {
    position: [0, 37.0, 6.5],
    target: [0, 0.0, -5.0],
    fov: 36,
  },
  pov: {
    position: [0, 14.5, 11.5],
    target: [0, -0.5, -5.5],
    fov: 45,
  },
  side_arch: {
    position: [-23.0, 10.5, 9.5],
    target: [-2.0, 1.0, -2.5],
    fov: 36,
  },
};

export class PianoScene3D {
  public readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private readonly keyboard3D: Keyboard3DView;
  private readonly sampleKeySurfaceY = (pitch: number, x: number, z: number): number | null =>
    this.keyboard3D.sampleKeySurfaceYAt(pitch, x, z);
  private readonly enrichContactTargetsWithKeyBounds = (targets: ImprovedHandContactTarget[]): void => {
    const bounds = new THREE.Box3();
    const center = new THREE.Vector3();
    for (const target of targets) {
      if (target.pitch === null) continue;
      const key = this.keyboard3D.keysByPitch.get(target.pitch);
      if (!key) continue;
      key.mesh.updateWorldMatrix(true, false);
      bounds.setFromObject(key.mesh);
      if (bounds.isEmpty()) continue;
      bounds.getCenter(center);
      target.contactCenterX = center.x;
      target.contactMinX = bounds.min.x;
      target.contactMaxX = bounds.max.x;
      target.contactMinZ = bounds.min.z;
      target.contactMaxZ = bounds.max.z;
    }
  };
  private readonly leftHandContactTargets: ImprovedHandContactTarget[] = [];
  private readonly rightHandContactTargets: ImprovedHandContactTarget[] = [];
  private readonly fallingNotes3D: FallingNotes3DView;
  private readonly leftHand3D: Hand3DMeshGroup;
  private readonly rightHand3D: Hand3DMeshGroup;
  private stage3D: PianoStage3D | null = null;
  private readonly fixedViewport: PianoScene3DOptions["fixedViewport"];
  private readonly ownsCanvas: boolean;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly noteTimeIndex = new NoteTimeIndex();
  private readonly cameraTarget = new THREE.Vector3();
  private envMapTexture: THREE.Texture | null = null;

  private notes: Note[] = [];
  private performancePlan: PerformancePlan | null = null;
  private sustainEvents: Extract<PerformanceEvent, { type: "pedal" }>[] = [];
  private softPedalEvents: Extract<PerformanceEvent, { type: "pedal" }>[] = [];
  private sostenutoEvents: Extract<PerformanceEvent, { type: "pedal" }>[] = [];
  private motionPlan: MotionPlan | null = null;
  private leftPoses: MotionPose[] = [];
  private rightPoses: MotionPose[] = [];
  private motionBuffer: MotionBuffer | null = null;
  private skinSettings: SkinSettings = normalizeSkinSettings();
  private showFingerLabels = false;
  private currentTransportTime = 0;
  private lastActiveNotes: number[] | undefined;
  private playAlongMode = false;
  private livePhysicalPitches = new Set<number>();
  private activePointerPitches = new Map<number, number>();
  private isPlayingKeyWithPointer = false;
  private onPianoKeyDown?: (pitch: number) => void;
  private onPianoKeyUp?: (pitch: number) => void;
  private currentPreset: Camera3DPreset = "concert";
  private presetCameraDistance = 0;
  private lastViewportFitDistance: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pointerListenerCleanup: (() => void) | null = null;
  private isDestroyed = false;
  private isUpdatingControlsInternally = false;
  private deferStageAppearanceRender = false;
  private readonly onContextLost?: (error: Error) => void;
  private readonly onContextRestored?: () => void;
  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.onContextLost?.(new Error("WebGL context lost"));
  };
  private readonly handleContextRestored = () => {
    this.onContextRestored?.();
  };
  private requestedHandModel: HandModelId = "anatomical";
  private readonly handProjectionPoint = new THREE.Vector3();
  private readonly renderFrameTimes = new Float64Array(1200);
  private renderFrameTimeCount = 0;
  private renderFrameTimeCursor = 0;
  private renderedFramesTotal = 0;
  private readonly handUpdateTimes = new Float64Array(1200);
  private readonly handUpdateDurations = new Float32Array(1200);
  private handUpdateSampleCount = 0;
  private handUpdateSampleCursor = 0;
  private handUpdateFramesTotal = 0;
  private readonly diagnosticsCreatedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

  public constructor(
    private readonly target: HTMLElement,
    options: PianoScene3DOptions = {},
  ) {
    this.requestedHandModel = options.initialHandModel ?? "anatomical";
    this.fixedViewport = options.fixedViewport;
    this.ownsCanvas = options.canvas === undefined;
    this.onContextLost = options.onContextLost;
    this.onContextRestored = options.onContextRestored;
    if (this.fixedViewport && (
      !Number.isInteger(this.fixedViewport.width) || this.fixedViewport.width <= 0 ||
      !Number.isInteger(this.fixedViewport.height) || this.fixedViewport.height <= 0
    )) {
      throw new RangeError("Fixed 3D viewport dimensions must be positive integers.");
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090b10);
    this.scene.fog = new THREE.FogExp2(0x090b10, 0.0068);

    const width = this.fixedViewport?.width ?? Math.max(2, target.clientWidth || 960);
    const height = this.fixedViewport?.height ?? Math.max(2, target.clientHeight || 540);

    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.5, 360);
    this.renderer = new THREE.WebGLRenderer({
      ...(options.canvas ? { canvas: options.canvas } : {}),
      antialias: true,
      powerPreference: "high-performance",
    });
    try {
      this.renderer.setPixelRatio(
        this.fixedViewport?.resolution ?? Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1),
      );
      this.renderer.setSize(width, height);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.94;

      // Generate subtle studio HDR environment reflections without washing out shadows.
      try {
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        const roomEnv = new RoomEnvironment();
        try {
          this.envMapTexture = pmremGenerator.fromScene(roomEnv, 0.04).texture;
          this.scene.environment = this.envMapTexture;
          this.scene.environmentIntensity = 0.22;
        } finally {
          roomEnv.dispose();
          pmremGenerator.dispose();
        }
      } catch {
        // Fallback if WebGL context does not support PMREM.
      }

      this.canvas = this.renderer.domElement;
      this.canvas.className = "piano-scene-3d-canvas";
      this.canvas.style.position = "absolute";
      this.canvas.style.inset = "0";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      this.canvas.style.display = this.fixedViewport ? "block" : "none";
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("aria-label", "3D piano keyboard");
      this.canvas.setAttribute("data-testid", "piano-canvas-3d");
      if (!this.fixedViewport) {
        this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
        this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
      }
      if (this.ownsCanvas && !this.fixedViewport) this.target.appendChild(this.canvas);

      if (!this.fixedViewport) {
        const controls = new OrbitControls(this.camera, this.canvas);
        this.controls = controls;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.maxPolarAngle = Math.PI * 0.48;
        controls.minDistance = 8;
        controls.maxDistance = 180;
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        };
        controls.addEventListener("change", () => {
          if (!this.isDestroyed && !this.isUpdatingControlsInternally && this.canvas.style.display !== "none") {
            this.renderFrame();
          }
        });
      }

      this.stage3D = new PianoStage3D(this.scene, this.renderer, width);

      this.keyboard3D = new Keyboard3DView();
      this.scene.add(this.keyboard3D.group);

      this.fallingNotes3D = new FallingNotes3DView(this.keyboard3D);
      this.scene.add(this.fallingNotes3D.group);

      const initialRigModel = this.requestedHandModel === "anatomical" ? "anatomical" : "webxr";
      this.leftHand3D = new Hand3DMeshGroup("left", initialRigModel);
      this.rightHand3D = new Hand3DMeshGroup("right", initialRigModel);
      this.scene.add(this.leftHand3D.group);
      this.scene.add(this.rightHand3D.group);

      this.setCameraPreset("concert");
      if (this.requestedHandModel === IMPROVED_HAND_MODEL_ID) this.applyHandModelSelection();
      if (!this.fixedViewport) {
        this.setupPointerEvents();
        this.setupResizeObserver();
      }
    } catch (error) {
      this.cleanupAllocatedResources();
      throw error;
    }
  }

  private cleanupAllocatedResources(): void {
    this.resizeObserver?.disconnect();
    this.pointerListenerCleanup?.();
    this.controls?.dispose();
    this.stage3D?.dispose();
    this.keyboard3D?.dispose();
    this.fallingNotes3D?.dispose();
    this.leftHand3D?.dispose();
    this.rightHand3D?.dispose();
    this.envMapTexture?.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.renderer.domElement.remove();
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
    const width = this.fixedViewport?.width ?? Math.max(2, this.target.clientWidth || 960);
    const height = this.fixedViewport?.height ?? Math.max(2, this.target.clientHeight || 540);
    this.camera.aspect = width / height;
    const baseFov = CAMERA_PRESETS[this.currentPreset].fov;
    const target = this.controls?.target ?? this.cameraTarget;
    const offset = this.camera.position.clone().sub(target);
    const currentDistance = offset.length();
    const alreadyFitted = this.lastViewportFitDistance !== null &&
      Math.abs(currentDistance - this.lastViewportFitDistance) < 0.05;
    const preferredDistance = alreadyFitted ? this.presetCameraDistance : currentDistance;
    const fitToKeyboard = this.currentPreset === "concert" || this.currentPreset === "overhead";
    const fit = calculatePianoCameraFit(width, height, baseFov, preferredDistance, fitToKeyboard);
    const direction = currentDistance > 1e-6
      ? offset.multiplyScalar(1 / currentDistance)
      : new THREE.Vector3(0, 0, 1);
    this.camera.position.copy(target).addScaledVector(direction, fit.distance);
    this.camera.fov = fit.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.stage3D?.setViewportWidth(width);
    if (this.controls) {
      this.controls.maxDistance = Math.max(180, fit.distance * 1.5);
      this.isUpdatingControlsInternally = true;
      try {
        this.controls.update();
      } finally {
        this.isUpdatingControlsInternally = false;
      }
    } else {
      // Fixed export cameras have no OrbitControls to orient them toward the
      // preset target. Keep the camera rotation and world matrix current after
      // fitting its position to the fixed viewport.
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld(true);
    }
    this.lastViewportFitDistance = fit.distance;
    this.renderFrame();
  }

  public setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? "block" : "none";
    if (visible) {
      this.resize();
      this.update(this.currentTransportTime, this.lastActiveNotes);
    }
  }

  public isVisible(): boolean {
    return this.canvas.style.display !== "none";
  }

  public setCameraPreset(preset: Camera3DPreset): void {
    this.currentPreset = preset;
    const cfg = CAMERA_PRESETS[preset];
    this.camera.position.set(...cfg.position);
    this.cameraTarget.set(...cfg.target);
    this.controls?.target.copy(this.cameraTarget);
    this.presetCameraDistance = this.camera.position.distanceTo(this.cameraTarget);
    this.lastViewportFitDistance = null;
    this.resize();
  }

  public getCameraPreset(): Camera3DPreset {
    return this.currentPreset;
  }

  public setSong(song: SongDocument | null): void {
    this.notes = song ? [...song.notes] : [];
    this.noteTimeIndex.setNotes(this.notes);
    this.fallingNotes3D.setNotes(this.notes);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setNotes(notes: Note[]): void {
    this.notes = [...notes];
    this.noteTimeIndex.setNotes(this.notes);
    this.fallingNotes3D.setNotes(this.notes);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setMotionPlan(motionPlan: MotionPlan | null): void {
    this.motionPlan = motionPlan;
    this.leftPoses = [];
    this.rightPoses = [];
    if (motionPlan) {
      for (const pose of motionPlan.poses) {
        if (pose.hand === "left") {
          this.leftPoses.push(pose);
        } else {
          this.rightPoses.push(pose);
        }
      }
      this.leftPoses.sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);
      this.rightPoses.sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);
    }
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setMotionBuffer(buffer: MotionBuffer | null): void {
    this.motionBuffer = buffer;
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setPerformancePlan(plan: PerformancePlan | null): void {
    this.performancePlan = plan;
    this.sustainEvents = [];
    this.softPedalEvents = [];
    this.sostenutoEvents = [];
    for (const event of plan?.events ?? []) {
      if (event.type !== "pedal") continue;
      if (event.controller === 64) this.sustainEvents.push(event);
      else if (event.controller === 67) this.softPedalEvents.push(event);
      else this.sostenutoEvents.push(event);
    }
    this.fallingNotes3D.setPerformancePlan(plan, this.notes);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setPixelsPerSecond(pps: number): void {
    this.fallingNotes3D.setPixelsPerSecond(pps);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setDisplaySettings(settings: PianoSceneDisplaySettings): void {
    if (settings.showFingerLabels !== undefined) {
      this.showFingerLabels = settings.showFingerLabels;
    }
    if (settings.skinStyle !== undefined || settings.showHandShadow !== undefined) {
      this.skinSettings = normalizeSkinSettings({
        ...this.skinSettings,
        ...(settings.skinStyle !== undefined ? { style: settings.skinStyle } : {}),
        ...(settings.showHandShadow !== undefined ? { shadow: settings.showHandShadow } : {}),
      });
    }
    if (settings.handModel !== undefined) {
      this.requestedHandModel = settings.handModel;
      this.applyHandModelSelection();
    }
    if ("stageAppearance" in settings) {
      this.deferStageAppearanceRender = true;
      try {
        this.setStageAppearance(settings.stageAppearance as StageAppearance);
      } finally {
        this.deferStageAppearanceRender = false;
      }
    }
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setStageAppearance(appearance: StageAppearance): void {
    if (this.isDestroyed) return;
    this.stage3D?.setAppearance(appearance);
    if (!this.deferStageAppearanceRender) this.renderFrame();
  }

  public getStageDiagnostics(): PianoStageDiagnostics | null {
    return this.stage3D?.getDiagnostics() ?? null;
  }

  public getHandModelDiagnostics(): HandModelDiagnosticsSnapshot {
    const left = this.leftHand3D.getHandModelDiagnostics();
    const right = this.rightHand3D.getHandModelDiagnostics();
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const renderCutoff = now - 5000;
    const renderSamples = Math.min(this.renderFrameTimeCount, this.renderFrameTimes.length);
    let renderedFramesWindow = 0;
    for (let index = 0; index < renderSamples; index++) {
      const sample = this.renderFrameTimes[index]!;
      if (sample >= renderCutoff) renderedFramesWindow++;
    }
    const handCutoff = now - 5000;
    const handSamples = Math.min(this.handUpdateSampleCount, this.handUpdateTimes.length);
    let handUpdateFramesWindow = 0;
    let handUpdateDurationTotalMs = 0;
    let handUpdateLastMs = 0;
    let latestHandUpdateTime = -Infinity;
    for (let index = 0; index < handSamples; index++) {
      const sampleTime = this.handUpdateTimes[index]!;
      if (sampleTime < handCutoff) continue;
      handUpdateFramesWindow++;
      handUpdateDurationTotalMs += this.handUpdateDurations[index]!;
      if (sampleTime > latestHandUpdateTime) {
        latestHandUpdateTime = sampleTime;
        handUpdateLastMs = this.handUpdateDurations[index]!;
      }
    }
    const snapshot: HandModelDiagnosticsSnapshot = {
      left,
      right,
      renderer: {
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        renderedFramesTotal: this.renderedFramesTotal,
        renderedFramesWindow,
        renderWindowMs: Math.min(5000, Math.max(0, now - this.diagnosticsCreatedAt)),
        handUpdateFramesTotal: this.handUpdateFramesTotal,
        handUpdateFramesWindow,
        handUpdateMeanMs: handUpdateFramesWindow > 0
          ? handUpdateDurationTotalMs / handUpdateFramesWindow
          : 0,
        handUpdateLastMs,
      },
    };
    return snapshot;
  }

  public async waitForHandModelReady(): Promise<void> {
    await Promise.all([
      this.leftHand3D.waitForHandModelReady(),
      this.rightHand3D.waitForHandModelReady(),
    ]);
  }

  private applyHandModelSelection(): void {
    if (this.requestedHandModel !== IMPROVED_HAND_MODEL_ID) {
      this.leftHand3D.setHandModel(this.requestedHandModel);
      this.rightHand3D.setHandModel(this.requestedHandModel);
      return;
    }
    this.leftHand3D.setHandModel(
      IMPROVED_HAND_MODEL_ID,
      this.selectImprovedLod(this.leftHand3D),
    );
    this.rightHand3D.setHandModel(
      IMPROVED_HAND_MODEL_ID,
      this.selectImprovedLod(this.rightHand3D),
    );
  }

  private selectImprovedLod(hand: Hand3DMeshGroup): 0 | 1 | 2 {
    if (this.fixedViewport) return chooseImprovedHandExportLod();
    const diagnostics = hand.getHandModelDiagnostics();
    const current = diagnostics.requestedLod ?? diagnostics.loadedLod;
    const bone = hand.getBone("wrist");
    if (!bone) return chooseImprovedHandLod(Number.POSITIVE_INFINITY, current);
    bone.getWorldPosition(this.handProjectionPoint);
    const distance = Math.max(0.5, this.camera.position.distanceTo(this.handProjectionPoint));
    const viewportHeight = Math.max(2, this.target.clientHeight || this.renderer.domElement.clientHeight || 540);
    const projectedHeight = (8 / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * distance)) * viewportHeight;
    return chooseImprovedHandLod(projectedHeight, current);
  }

  private recordHandUpdate(durationMs: number): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.handUpdateTimes[this.handUpdateSampleCursor] = now;
    this.handUpdateDurations[this.handUpdateSampleCursor] = durationMs;
    this.handUpdateSampleCursor = (this.handUpdateSampleCursor + 1) % this.handUpdateTimes.length;
    this.handUpdateSampleCount = Math.min(this.handUpdateSampleCount + 1, this.handUpdateTimes.length);
    this.handUpdateFramesTotal += 1;
  }

  private recordRenderedFrame(): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.renderFrameTimes[this.renderFrameTimeCursor] = now;
    this.renderFrameTimeCursor = (this.renderFrameTimeCursor + 1) % this.renderFrameTimes.length;
    this.renderFrameTimeCount = Math.min(this.renderFrameTimeCount + 1, this.renderFrameTimes.length);
    this.renderedFramesTotal += 1;
  }

  public setKeyInputHandlers(handlers: {
    onKeyDown?: (pitch: number) => void;
    onKeyUp?: (pitch: number) => void;
  }): void {
    this.onPianoKeyDown = handlers.onKeyDown;
    this.onPianoKeyUp = handlers.onKeyUp;
  }

  public setLivePressedPitches(pitches: Iterable<number>): void {
    this.livePhysicalPitches = new Set(pitches);
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setPlayAlongMode(enabled: boolean): void {
    if (this.playAlongMode === enabled) return;
    this.playAlongMode = enabled;
    if (!enabled) {
      this.keyboard3D.setTargetKeys(null);
      this.keyboard3D.setWrongKeys(null);
    }
    this.update(this.currentTransportTime, this.lastActiveNotes);
  }

  public setPlayAlongTargetPitches(
    targets: ReadonlyMap<number, KeyPressInfo> | null,
    wrong?: ReadonlySet<number> | null,
  ): void {
    this.keyboard3D.setTargetKeys(targets);
    if (wrong !== undefined) {
      this.keyboard3D.setWrongKeys(wrong);
    }
    this.renderFrame();
  }

  public update(timeSeconds: number, activeNotes?: number[]): void {
    if (this.isDestroyed) return;
    this.currentTransportTime = timeSeconds;
    this.lastActiveNotes = activeNotes;
    if (!this.isVisible()) return;

    this.fallingNotes3D.update(timeSeconds);

    // Update pedal depression states:
    // CC64: Sustain (right pedal)
    // CC67: Soft / Una Corda (left pedal)
    // CC66: Sostenuto (middle pedal)
    this.keyboard3D.setSustainPedal(sustainPedalDownAtTime(this.sustainEvents, timeSeconds));
    this.keyboard3D.setSoftPedal(sustainPedalDownAtTime(this.softPedalEvents, timeSeconds));
    this.keyboard3D.setSostenutoPedal(sustainPedalDownAtTime(this.sostenutoEvents, timeSeconds));

    const activeMap = new Map<number, KeyPressInfo | null>();
    if (!this.playAlongMode) {
      const activeScoreNotes: Note[] = [];
      const rendered = this.fallingNotes3D.getRenderedNoteTimings();
      const noteSource = this.performancePlan ? rendered : this.notes;
      for (const note of noteSource) {
        if (
          note.startSeconds <= timeSeconds &&
          note.endSeconds > timeSeconds
        ) {
          activeScoreNotes.push(note);
        }
      }
      const built = buildActiveKeysForFrame(activeScoreNotes, activeNotes);
      for (const [pitch, info] of built) {
        activeMap.set(pitch, info);
      }
    }

    for (const p of this.livePhysicalPitches) {
      if (!activeMap.has(p)) activeMap.set(p, null);
    }
    for (const p of this.activePointerPitches.values()) {
      if (!activeMap.has(p)) activeMap.set(p, null);
    }

    this.keyboard3D.setActiveKeys(activeMap);
    this.updateHandsAtTime(timeSeconds);
    this.renderFrame();
  }

  private updateHandsAtTime(timeSeconds: number): void {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    let leftPose: MotionPose | null = null;
    let rightPose: MotionPose | null = null;

    if (this.motionBuffer) {
      leftPose = this.motionBuffer.samplePoseClamped(timeSeconds, "left");
      rightPose = this.motionBuffer.samplePoseClamped(timeSeconds, "right");
    } else if (this.motionPlan) {
      leftPose = this.interpolatePoseFromArray(this.leftPoses, timeSeconds);
      rightPose = this.interpolatePoseFromArray(this.rightPoses, timeSeconds);
    }

    // Fall back to motionPlan poses if buffer did not yield a pose for that hand
    if (!leftPose && this.leftPoses.length > 0) {
      leftPose = this.interpolatePoseFromArray(this.leftPoses, timeSeconds);
    }
    if (!rightPose && this.rightPoses.length > 0) {
      rightPose = this.interpolatePoseFromArray(this.rightPoses, timeSeconds);
    }

    const rendered = this.fallingNotes3D.getRenderedNoteTimings();
    const noteSource = this.performancePlan ? rendered : this.notes;

    const leftHoverLift = calculateHandHoverLift("left", timeSeconds, noteSource);
    const rightHoverLift = calculateHandHoverLift("right", timeSeconds, noteSource);
    const usesImprovedHand = this.requestedHandModel === IMPROVED_HAND_MODEL_ID;

    if (leftPose) {
      if (usesImprovedHand) {
        const contactTargets = populateHandContactTargets(
          noteSource,
          "left",
          timeSeconds,
          this.leftHandContactTargets,
          this.sampleKeySurfaceY,
        );
        this.enrichContactTargetsWithKeyBounds(contactTargets);
        this.leftHand3D.updateFromPose(
          leftPose,
          this.skinSettings,
          this.showFingerLabels,
          leftHoverLift,
          contactTargets,
        );
      } else {
        this.leftHand3D.updateFromPose(leftPose, this.skinSettings, this.showFingerLabels, leftHoverLift);
      }
    } else {
      this.leftHand3D.clear();
    }

    if (rightPose) {
      if (usesImprovedHand) {
        const contactTargets = populateHandContactTargets(
          noteSource,
          "right",
          timeSeconds,
          this.rightHandContactTargets,
          this.sampleKeySurfaceY,
        );
        this.enrichContactTargetsWithKeyBounds(contactTargets);
        this.rightHand3D.updateFromPose(
          rightPose,
          this.skinSettings,
          this.showFingerLabels,
          rightHoverLift,
          contactTargets,
        );
      } else {
        this.rightHand3D.updateFromPose(rightPose, this.skinSettings, this.showFingerLabels, rightHoverLift);
      }
    } else {
      this.rightHand3D.clear();
    }
    const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.recordHandUpdate(Math.max(0, finishedAt - startedAt));
  }

  private interpolatePoseFromArray(poses: MotionPose[], timeSeconds: number): MotionPose | null {
    if (poses.length === 0) return null;
    if (timeSeconds <= poses[0]!.transportTimeSeconds) return poses[0]!;
    const last = poses[poses.length - 1]!;
    if (timeSeconds >= last.transportTimeSeconds) return last;

    let lo = 0;
    let hi = poses.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (poses[mid]!.transportTimeSeconds <= timeSeconds) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const idx = Math.max(0, lo - 1);
    const a = poses[idx]!;
    const b = poses[Math.min(poses.length - 1, idx + 1)]!;
    const span = b.transportTimeSeconds - a.transportTimeSeconds;
    const t = span > 1e-6 ? (timeSeconds - a.transportTimeSeconds) / span : 0;
    return lerpPose(a, b, t);
  }

  private setupPointerEvents(): void {
    const getPitchAtEvent = (e: PointerEvent): number | null => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      return this.keyboard3D.getPitchFromRaycaster(this.raycaster);
    };

    const pointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const pitch = getPitchAtEvent(e);
      if (pitch !== null) {
        if (this.controls) this.controls.enabled = false;
        this.isPlayingKeyWithPointer = true;
        this.activePointerPitches.set(e.pointerId, pitch);
        this.onPianoKeyDown?.(pitch);
        this.update(this.currentTransportTime, this.lastActiveNotes);
      }
    };

    const pointerMove = (e: PointerEvent) => {
      if (!this.isPlayingKeyWithPointer || !this.activePointerPitches.has(e.pointerId)) return;
      const prevPitch = this.activePointerPitches.get(e.pointerId)!;
      const nextPitch = getPitchAtEvent(e);
      if (nextPitch !== prevPitch) {
        this.activePointerPitches.delete(e.pointerId);
        this.onPianoKeyUp?.(prevPitch);
        if (nextPitch !== null) {
          this.activePointerPitches.set(e.pointerId, nextPitch);
          this.onPianoKeyDown?.(nextPitch);
        }
        this.update(this.currentTransportTime, this.lastActiveNotes);
      }
    };

    const releasePointer = (e: PointerEvent) => {
      if (this.activePointerPitches.has(e.pointerId)) {
        const prevPitch = this.activePointerPitches.get(e.pointerId)!;
        this.activePointerPitches.delete(e.pointerId);
        this.onPianoKeyUp?.(prevPitch);
        this.update(this.currentTransportTime, this.lastActiveNotes);
      }
      if (this.activePointerPitches.size === 0) {
        this.isPlayingKeyWithPointer = false;
        if (this.controls) this.controls.enabled = true;
      }
    };

    const listeners: Array<[string, EventListener]> = [
      ["pointerdown", pointerDown as EventListener],
      ["pointermove", pointerMove as EventListener],
      ["pointerup", releasePointer as EventListener],
      ["pointercancel", releasePointer as EventListener],
    ];
    this.pointerListenerCleanup = () => {
      for (const [type, listener] of listeners) this.canvas.removeEventListener(type, listener);
      this.pointerListenerCleanup = null;
    };
    for (const [type, listener] of listeners) this.canvas.addEventListener(type, listener);
  }

  private renderFrame(): void {
    if (this.isDestroyed || !this.isVisible()) return;
    if (this.requestedHandModel === IMPROVED_HAND_MODEL_ID) {
      this.applyHandModelSelection();
    }
    this.renderer.render(this.scene, this.camera);
    this.recordRenderedFrame();
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.resizeObserver?.disconnect();
    this.pointerListenerCleanup?.();
    this.controls?.dispose();
    this.stage3D?.dispose();
    this.keyboard3D.dispose();
    this.fallingNotes3D.dispose();
    this.leftHand3D.dispose();
    this.rightHand3D.dispose();
    this.envMapTexture?.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.canvas.remove();
  }
}
