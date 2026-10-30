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
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { KeyPressInfo } from "../render/keyboardView";
import { describeMotionPoseSample, lerpPose, type MotionBuffer } from "../render/motionBuffer";
import { isHandFrameCaptureActiveFor, observeHandFrameNoteBoundaries, type TestingHandDiagnosticContext } from "../diagnostics/testingHandCapture";
import type { PianoSceneDisplaySettings } from "../render/pianoScene";
import { normalizeSkinSettings, type SkinSettings } from "../render/skins";
import type { StageAppearance } from "../settings/stageAppearance";
import { FallingNotes3DView, NoteTimeIndex } from "./fallingNotes3dView";
import {
  Hand3DMeshGroup,
  KEYBOARD_WIDTH_IN,
} from "./handRigBuilder";
import { chooseImprovedHandExportLod, chooseImprovedHandLod, isDetailedHandModel, usesImprovedHandMotion, type HandModelDiagnosticsSnapshot, type HandModelId } from "./improvedHandRuntime";
import { populateHandContactTargets, type ImprovedHandContactTarget } from "./improvedHandContact";
import { Keyboard3DView } from "./keyboard3dView";
import { PianoStage3D, type PianoStageDiagnostics } from "./pianoStage3d";
import {
  RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES,
  type RiggedExperimentalHandBoneName,
  type RiggedExperimentalHandPose,
} from "./riggedExperimentalHand";
import { RIGGED_EXPERIMENTAL_HAND_MODEL_ID } from "./improvedHandRuntime";
import { collectRiggedPoseEditTimepoints, type RiggedPoseEditTimepoint } from "./riggedPoseEditNavigation";
import { importRiggedHandPosePresetJson } from "./riggedHandPosePreset";

export type { RiggedPoseEditTimepoint } from "./riggedPoseEditNavigation";

export type Camera3DPreset = "concert" | "overhead" | "pov" | "side_arch";
export type RiggedPoseEditSide = "left" | "right";
export type RiggedPoseEditFingerFilter = "all" | 1 | 2 | 3 | 4 | 5;
export type RiggedPoseEditTransformMode = "rotate" | "translate";
export type RiggedPoseEditPair = Readonly<{
  left: RiggedExperimentalHandPose;
  right: RiggedExperimentalHandPose;
}>;
export type RiggedPoseEditSelection = Readonly<{
  side: RiggedPoseEditSide;
  boneName: RiggedExperimentalHandBoneName | null;
  fingerFilter: RiggedPoseEditFingerFilter;
  transformMode: RiggedPoseEditTransformMode;
}>;
export type RiggedPoseEditSourceHashes = Readonly<{ left: string | null; right: string | null }>;
export type RiggedPoseEditAvailability = Readonly<{
  available: boolean;
  leftAvailable: boolean;
  rightAvailable: boolean;
  reason: "no-3d-scene" | "model-mismatch" | "hand-not-ready" | "sample-unavailable" | null;
}>;
export type RiggedPoseEditSampleSource = Readonly<{
  sampleMode: "held-first" | "exact" | "interpolated" | "unavailable";
  sourcePoseTimeSeconds: number | null;
  sourcePoseTimeStartSeconds: number | null;
  sourcePoseTimeEndSeconds: number | null;
}>;

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
  /** Actual configured transport lead-in duration, in seconds. */
  leadInDurationSeconds?: number;
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

function poseEditFingerForBoneName(name: string): RiggedPoseEditFingerFilter | null {
  if (name.includes("_thumb_")) return 1;
  if (name.includes("_index_")) return 2;
  if (name.includes("_middle_")) return 3;
  if (name.includes("_ring_")) return 4;
  if (name.includes("_little_")) return 5;
  return null;
}

function isPoseTimeInsideRange(poses: readonly MotionPose[], timeSeconds: number): boolean {
  return poses.length > 0 &&
    timeSeconds >= poses[0]!.transportTimeSeconds &&
    timeSeconds <= poses[poses.length - 1]!.transportTimeSeconds;
}

function hasPoseTimeWithinTolerance(times: readonly number[], timeSeconds: number, toleranceSeconds = 0): boolean {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle]! < timeSeconds - toleranceSeconds) low = middle + 1;
    else high = middle;
  }
  return low < times.length && Math.abs(times[low]! - timeSeconds) <= toleranceSeconds;
}

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
  private poseTransformControls: TransformControls | null = null;
  private readonly poseMarkers = new Map<RiggedExperimentalHandBoneName, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();
  private poseMarkerGeometry: THREE.SphereGeometry | null = null;
  private poseMarkerMaterials: Record<RiggedPoseEditSide, THREE.MeshBasicMaterial> | null = null;
  private poseEditActive = false;
  private poseEditSide: RiggedPoseEditSide = "right";
  private poseEditBoneName: RiggedExperimentalHandBoneName | null = null;
  private poseEditFingerFilter: RiggedPoseEditFingerFilter = "all";
  private poseEditTransformMode: RiggedPoseEditTransformMode = "rotate";
  private poseEditSampling: { timepoint: RiggedPoseEditTimepoint; } | null = null;
  private poseEditTimepoint: RiggedPoseEditTimepoint | null = null;
  private readonly poseEditUndoStack: RiggedPoseEditPair[] = [];
  private onPoseEditSelectionChange?: (side: RiggedPoseEditSide, boneName: RiggedExperimentalHandBoneName | null) => void;
  private onPoseEditChange?: () => void;
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
  private testingKeyContact = true;
  private currentTransportTime = 0;
  private leadInDurationSeconds = 2;
  private bundledLeadInPoseRequest = 0;
  private bundledLeadInPosePending = false;
  private bundledLeadInPoseApplied = false;
  private bundledLeadInPoseFailed = false;
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
    this.leadInDurationSeconds = Number.isFinite(options.leadInDurationSeconds)
      ? THREE.MathUtils.clamp(options.leadInDurationSeconds!, 0, 2)
      : 2;
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
      if (isDetailedHandModel(this.requestedHandModel) || this.requestedHandModel === RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
        this.applyHandModelSelection();
      }
      if (!this.fixedViewport) {
        this.setupPoseTransformControls();
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
    this.disposePoseEditControls();
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

  public setLeadInDurationSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const next = THREE.MathUtils.clamp(seconds, 0, 2);
    if (next === this.leadInDurationSeconds) return;
    this.leadInDurationSeconds = next;
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
    if (settings.testingShowBindAlignment !== undefined) {
      this.leftHand3D.setTestingBindAlignmentOverlay(settings.testingShowBindAlignment);
      this.rightHand3D.setTestingBindAlignmentOverlay(settings.testingShowBindAlignment);
    }
    if (settings.testingKeyContact !== undefined) {
      this.testingKeyContact = settings.testingKeyContact;
      this.leftHand3D.setTestingKeyContact(settings.testingKeyContact);
      this.rightHand3D.setTestingKeyContact(settings.testingKeyContact);
    }
    if (settings.testingThumbStrength !== undefined) {
      // Controlled research A/B; affects only Testing shell weight sampling.
      this.leftHand3D.setTestingThumbStrength(settings.testingThumbStrength);
      this.rightHand3D.setTestingThumbStrength(settings.testingThumbStrength);
    }
    if (settings.testingHandMaterial !== undefined) {
      // Preview shader changes on both loaded Testing hands without reloading
      // the GLB or altering any finger pose, skin weights, or source texture.
      this.leftHand3D.setTestingMaterialMode(settings.testingHandMaterial);
      this.rightHand3D.setTestingMaterialMode(settings.testingHandMaterial);
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

  public getPoseEditTimepoints(leadInTimeSeconds?: number): RiggedPoseEditTimepoint[] {
    const planTimes = this.motionPlan?.poses.map(pose => pose.transportTimeSeconds) ?? [];
    const bufferTimes = this.motionBuffer?.poses.map(pose => pose.transportTimeSeconds) ?? [];
    let leadIn: { displayedTransportTimeSeconds: number; sourcePoseTimeSeconds: number } | null = null;
    if (leadInTimeSeconds !== undefined && leadInTimeSeconds < 0) {
      const leftFirst = this.getFirstPoseSourceTime("left");
      const rightFirst = this.getFirstPoseSourceTime("right");
      if (leftFirst === 0 && rightFirst === 0 &&
          leadInTimeSeconds < leftFirst - 1e-6) {
        leadIn = { displayedTransportTimeSeconds: leadInTimeSeconds, sourcePoseTimeSeconds: leftFirst };
      }
    }
    return collectRiggedPoseEditTimepoints(planTimes, bufferTimes, leadIn);
  }

  public getPoseEditAvailability(timepoint: RiggedPoseEditTimepoint): RiggedPoseEditAvailability {
    return this.getPoseEditAvailabilityForTimepoints([timepoint])[timepoint.id]!;
  }

  public getPoseEditAvailabilityForTimepoints(timepoints: readonly RiggedPoseEditTimepoint[]): Record<string, RiggedPoseEditAvailability> {
    const modelReady = [this.leftHand3D, this.rightHand3D].every(hand => {
      const model = hand.getHandModelDiagnostics();
      return model.requestedModel === RIGGED_EXPERIMENTAL_HAND_MODEL_ID &&
        model.loadedModel === RIGGED_EXPERIMENTAL_HAND_MODEL_ID && model.state === "ready";
    });
    const bufferTimes = {
      left: this.motionBuffer?.poses.filter(pose => pose.hand === "left").map(pose => pose.transportTimeSeconds) ?? [],
      right: this.motionBuffer?.poses.filter(pose => pose.hand === "right").map(pose => pose.transportTimeSeconds) ?? [],
    };
    const result: Record<string, RiggedPoseEditAvailability> = {};
    for (const timepoint of timepoints) {
      const hasSide = (side: RiggedPoseEditSide): boolean => {
        if (timepoint.kind === "lead-in-held") {
          const first = this.getFirstPoseSourceTime(side);
          return first !== null && Math.abs(first - timepoint.sourcePoseTimeSeconds) <= 1e-6;
        }
        const timeSeconds = timepoint.displayedTransportTimeSeconds;
        const exactBufferFrame = hasPoseTimeWithinTolerance(bufferTimes[side], timeSeconds);
        const covered = this.motionBuffer?.getHandCoverageIntervals(side).some(interval =>
          interval.start <= timeSeconds && interval.end >= timeSeconds) ?? false;
        return exactBufferFrame || (covered && Boolean(this.motionBuffer?.samplePose(timeSeconds, side))) ||
          isPoseTimeInsideRange(this.getPlanPoses(side), timeSeconds);
      };
      const leftAvailable = hasSide("left");
      const rightAvailable = hasSide("right");
      const base = { leftAvailable, rightAvailable };
      if (!this.isVisible()) result[timepoint.id] = { ...base, available: false, reason: "no-3d-scene" };
      else if (this.requestedHandModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
        result[timepoint.id] = { ...base, available: false, reason: "model-mismatch" };
      } else if (!modelReady) result[timepoint.id] = { ...base, available: false, reason: "hand-not-ready" };
      else if (!leftAvailable || !rightAvailable) result[timepoint.id] = { ...base, available: false, reason: "sample-unavailable" };
      else result[timepoint.id] = { ...base, available: true, reason: null };
    }
    return result;
  }

  public getPoseEditSampleSource(timepoint: RiggedPoseEditTimepoint, side: RiggedPoseEditSide): RiggedPoseEditSampleSource {
    if (timepoint.kind === "lead-in-held") {
      const firstPoseTime = this.getFirstPoseSourceTime(side);
      if (firstPoseTime !== null && Math.abs(firstPoseTime - timepoint.sourcePoseTimeSeconds) <= 1e-6) {
        return {
          sampleMode: "held-first",
          sourcePoseTimeSeconds: firstPoseTime,
          sourcePoseTimeStartSeconds: firstPoseTime,
          sourcePoseTimeEndSeconds: firstPoseTime,
        };
      }
      return { sampleMode: "unavailable", sourcePoseTimeSeconds: null, sourcePoseTimeStartSeconds: null, sourcePoseTimeEndSeconds: null };
    }

    const sourcePoses = this.getPoseSourcePosesAt(timepoint.displayedTransportTimeSeconds, side);
    const exactPose = sourcePoses.find(pose => pose.transportTimeSeconds === timepoint.displayedTransportTimeSeconds);
    if (exactPose) {
      return {
        sampleMode: "exact",
        sourcePoseTimeSeconds: exactPose.transportTimeSeconds,
        sourcePoseTimeStartSeconds: exactPose.transportTimeSeconds,
        sourcePoseTimeEndSeconds: exactPose.transportTimeSeconds,
      };
    }
    const sample = describeMotionPoseSample(sourcePoses, timepoint.displayedTransportTimeSeconds);
    if (sample.sampleMode === "unknown") {
      return { sampleMode: "unavailable", sourcePoseTimeSeconds: null, sourcePoseTimeStartSeconds: null, sourcePoseTimeEndSeconds: null };
    }
    return {
      sampleMode: sample.sampleMode === "exact" || sample.sampleMode === "lower-frame" ? "exact" : "interpolated",
      sourcePoseTimeSeconds: sample.sampleMode === "exact" || sample.sampleMode === "lower-frame" ? sample.sourcePoseTimeStartSeconds : null,
      sourcePoseTimeStartSeconds: sample.sourcePoseTimeStartSeconds,
      sourcePoseTimeEndSeconds: sample.sourcePoseTimeEndSeconds,
    };
  }

  public getPoseEditSourceHashes(): RiggedPoseEditSourceHashes {
    return {
      left: this.leftHand3D.getPoseEditSourceAssetSha256(),
      right: this.rightHand3D.getPoseEditSourceAssetSha256(),
    };
  }

  public getPoseEditTimepoint(): RiggedPoseEditTimepoint | null {
    return this.poseEditTimepoint;
  }

  public getPoseEditSelection(): RiggedPoseEditSelection {
    return {
      side: this.poseEditSide,
      boneName: this.poseEditBoneName,
      fingerFilter: this.poseEditFingerFilter,
      transformMode: this.poseEditTransformMode,
    };
  }

  public setPoseEditSelectionListener(listener: ((side: RiggedPoseEditSide, boneName: RiggedExperimentalHandBoneName | null) => void) | undefined): void {
    this.onPoseEditSelectionChange = listener;
  }

  public setPoseEditChangeListener(listener: (() => void) | undefined): void {
    this.onPoseEditChange = listener;
  }

  public async setPoseEditMode(enabled: boolean): Promise<void> {
    if (!enabled) {
      if (!this.poseEditActive) return;
      this.poseTransformControls?.detach();
      if (this.poseTransformControls) this.poseTransformControls.getHelper().visible = false;
      this.hidePoseMarkers();
      this.leftHand3D.restoreAnimatedPose();
      this.rightHand3D.restoreAnimatedPose();
      this.poseEditActive = false;
      this.poseEditTimepoint = null;
      this.poseEditUndoStack.length = 0;
      this.renderFrame();
      return;
    }
    if (this.poseEditActive) return;
    if (!this.poseEditTimepoint) throw new Error("Choose an available sampled pose before entering pose edit mode.");
    const availability = this.getPoseEditAvailability(this.poseEditTimepoint);
    if (!availability.available) throw new Error(`Pose editing is unavailable: ${availability.reason ?? "sample-unavailable"}.`);
    await this.waitForHandModelReady();
    if (this.requestedHandModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
      throw new Error("The selected hand model changed before pose editing could start.");
    }
    this.leftHand3D.setPoseEditMode(true);
    try {
      this.rightHand3D.setPoseEditMode(true);
    } catch (error) {
      this.leftHand3D.restoreAnimatedPose();
      throw error;
    }
    this.poseEditActive = true;
    this.poseEditUndoStack.length = 0;
    this.setPoseEditTarget(this.poseEditSide, this.poseEditBoneName);
    this.syncPoseMarkers();
    this.renderFrame();
  }

  public isPoseEditMode(): boolean {
    return this.poseEditActive;
  }

  /** Samples both hands at a real plan/buffer time without boundary clamping. */
  public updatePoseEditAtTimepoint(timepoint: RiggedPoseEditTimepoint): void {
    const availability = this.getPoseEditAvailability(timepoint);
    if (!availability.available) throw new Error(`Pose ${timepoint.displayedTransportTimeSeconds.toFixed(3)}s is unavailable: ${availability.reason ?? "sample-unavailable"}.`);
    this.poseEditTimepoint = timepoint;
    this.poseEditSampling = { timepoint };
    try {
      this.update(timepoint.displayedTransportTimeSeconds, undefined);
    } finally {
      this.poseEditSampling = null;
    }
  }

  public exportPoseEditPair(): RiggedPoseEditPair {
    if (!this.poseEditActive) throw new Error("Pose snapshots are available only while pose edit mode is active.");
    return { left: this.leftHand3D.exportPose(), right: this.rightHand3D.exportPose() };
  }

  public applyPoseEditPair(pair: RiggedPoseEditPair): void {
    if (!this.poseEditActive) throw new Error("Pose snapshots can be applied only while pose edit mode is active.");
    if (pair.left.side !== "left" || pair.right.side !== "right") throw new Error("Pose snapshots must contain one left and one right hand.");
    const previous = this.exportPoseEditPair();
    try {
      this.leftHand3D.applyPose(pair.left);
      this.rightHand3D.applyPose(pair.right);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        this.leftHand3D.applyPose(previous.left);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        this.rightHand3D.applyPose(previous.right);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        const cause = error instanceof Error ? error.message : String(error);
        const rollbackCause = rollbackErrors.map(item => item instanceof Error ? item.message : String(item)).join("; ");
        throw new Error(`Could not apply the two-hand pose atomically (${cause}); rollback also failed (${rollbackCause}).`);
      }
      this.leftHand3D.refreshPoseEdit();
      this.rightHand3D.refreshPoseEdit();
      throw error;
    }
    this.leftHand3D.refreshPoseEdit();
    this.rightHand3D.refreshPoseEdit();
    this.syncPoseMarkers();
    this.renderFrame();
  }

  public setPoseEditSide(side: RiggedPoseEditSide): void {
    this.setPoseEditTarget(side, null);
  }

  public setPoseEditTarget(side: RiggedPoseEditSide, boneName: RiggedExperimentalHandBoneName | null): void {
    this.poseEditSide = side;
    if (boneName !== null && !boneName.startsWith(`${side}_`)) {
      throw new Error(`Pose edit bone ${boneName} does not belong to the ${side} hand.`);
    }
    this.poseEditBoneName = boneName;
    if (!this.poseEditActive || !this.poseTransformControls) {
      this.onPoseEditSelectionChange?.(side, boneName);
      return;
    }
    const hand = this.getHand3D(side);
    const target = boneName === null ? hand.getEditableHandGroup() : hand.getEditableBone(boneName);
    this.poseTransformControls.attach(target);
    this.poseTransformControls.setSpace("local");
    this.poseTransformControls.setMode(boneName === null ? this.poseEditTransformMode : "rotate");
    this.poseTransformControls.getHelper().visible = true;
    this.syncPoseMarkers();
    this.onPoseEditSelectionChange?.(side, boneName);
    this.renderFrame();
  }

  public setPoseEditFingerFilter(filter: RiggedPoseEditFingerFilter): void {
    this.poseEditFingerFilter = filter;
    this.syncPoseMarkers();
    this.renderFrame();
  }

  public setPoseEditTransformMode(mode: RiggedPoseEditTransformMode): void {
    this.poseEditTransformMode = mode;
    if (this.poseEditActive && this.poseEditBoneName === null) {
      this.poseTransformControls?.setMode(mode);
    }
  }

  public hasPoseEditUndo(): boolean {
    return this.poseEditUndoStack.length > 0;
  }

  public undoPoseEdit(): boolean {
    if (!this.poseEditActive) return false;
    const previous = this.poseEditUndoStack.pop();
    if (!previous) return false;
    this.applyPoseEditPair(previous);
    this.onPoseEditChange?.();
    return true;
  }

  public resetPoseEditHand(side: RiggedPoseEditSide): void {
    if (!this.poseEditActive) throw new Error("Reset is available only while pose edit mode is active.");
    this.pushPoseEditUndoSnapshot();
    const hand = this.getHand3D(side);
    hand.setPoseEditMode(false);
    hand.setPoseEditMode(true);
    hand.refreshPoseEdit();
    this.syncPoseMarkers();
    this.renderFrame();
    this.onPoseEditChange?.();
  }

  private getHand3D(side: RiggedPoseEditSide): Hand3DMeshGroup {
    return side === "left" ? this.leftHand3D : this.rightHand3D;
  }

  private getPlanPoses(side: RiggedPoseEditSide): MotionPose[] {
    return side === "left" ? this.leftPoses : this.rightPoses;
  }

  private getPoseSourcePosesAt(timeSeconds: number, side: RiggedPoseEditSide): MotionPose[] {
    if (this.motionBuffer) {
      const exactBufferFrame = this.motionBuffer.poses.some(pose => pose.hand === side && pose.transportTimeSeconds === timeSeconds);
      const covered = this.motionBuffer.getHandCoverageIntervals(side).some(interval =>
        interval.start <= timeSeconds && interval.end >= timeSeconds);
      if (exactBufferFrame || covered) return this.motionBuffer.poses.filter(pose => pose.hand === side);
    }
    return this.getPlanPoses(side);
  }

  private getFirstPoseSourceTime(side: RiggedPoseEditSide): number | null {
    const firstPlan = this.getPlanPoses(side)[0]?.transportTimeSeconds;
    const firstBuffer = this.motionBuffer?.getFirstPose(side)?.transportTimeSeconds;
    if (firstPlan === undefined) return firstBuffer ?? null;
    if (firstBuffer === undefined) return firstPlan;
    return Math.min(firstPlan, firstBuffer);
  }

  private samplePoseForPoseEdit(timepoint: RiggedPoseEditTimepoint, side: RiggedPoseEditSide): MotionPose | null {
    if (timepoint.kind === "lead-in-held") {
      const planned = this.getPlanPoses(side)[0];
      const buffered = this.motionBuffer?.getFirstPose(side) ?? undefined;
      const candidates = [planned, buffered].filter((pose): pose is MotionPose => pose !== undefined);
      return candidates.sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds)[0] ?? null;
    }
    if (this.motionBuffer) {
      const exactBufferFrame = this.motionBuffer.poses.some(pose => pose.hand === side &&
        pose.transportTimeSeconds === timepoint.displayedTransportTimeSeconds);
      const covered = this.motionBuffer.getHandCoverageIntervals(side).some(interval =>
        interval.start <= timepoint.displayedTransportTimeSeconds && interval.end >= timepoint.displayedTransportTimeSeconds);
      if (exactBufferFrame || covered) {
        const exactPose = this.motionBuffer.poses.find(pose => pose.hand === side && pose.transportTimeSeconds === timepoint.displayedTransportTimeSeconds);
        if (exactPose) return exactPose;
        return this.motionBuffer.samplePose(timepoint.displayedTransportTimeSeconds, side);
      }
    }
    return this.interpolatePoseFromArray(this.getPlanPoses(side), timepoint.displayedTransportTimeSeconds);
  }

  private pushPoseEditUndoSnapshot(): void {
    if (!this.poseEditActive) return;
    this.poseEditUndoStack.push(this.exportPoseEditPair());
    if (this.poseEditUndoStack.length > 64) this.poseEditUndoStack.shift();
  }

  private setupPoseTransformControls(): void {
    if (this.fixedViewport) return;
    const controls = new TransformControls(this.camera, this.canvas);
    controls.setMode("rotate");
    controls.setSpace("local");
    controls.size = 0.78;
    const helper = controls.getHelper();
    helper.visible = false;
    this.scene.add(helper);
    controls.addEventListener("dragging-changed", (event) => {
      if (this.controls) this.controls.enabled = event.value !== true;
    });
    controls.addEventListener("mouseDown", () => this.pushPoseEditUndoSnapshot());
    controls.addEventListener("objectChange", () => {
      if (!this.poseEditActive) return;
      this.getHand3D(this.poseEditSide).refreshPoseEdit();
      this.syncPoseMarkers();
      this.renderFrame();
    });
    controls.addEventListener("mouseUp", () => {
      if (!this.poseEditActive) return;
      this.onPoseEditChange?.();
      this.renderFrame();
    });
    this.poseTransformControls = controls;
  }

  private disposePoseEditControls(): void {
    this.poseTransformControls?.detach();
    if (this.poseTransformControls) {
      this.scene.remove(this.poseTransformControls.getHelper());
      this.poseTransformControls.dispose();
      this.poseTransformControls = null;
    }
    this.hidePoseMarkers();
    this.poseMarkerGeometry?.dispose();
    this.poseMarkerGeometry = null;
    this.poseMarkerMaterials?.left.dispose();
    this.poseMarkerMaterials?.right.dispose();
    this.poseMarkerMaterials = null;
  }

  private syncPoseMarkers(): void {
    if (!this.poseEditActive) return this.hidePoseMarkers();
    this.hidePoseMarkers();
    if (!this.poseMarkerGeometry) this.poseMarkerGeometry = new THREE.SphereGeometry(0.16, 12, 8);
    if (!this.poseMarkerMaterials) {
      this.poseMarkerMaterials = {
        left: new THREE.MeshBasicMaterial({ color: 0x45b7ff, depthTest: false, depthWrite: false }),
        right: new THREE.MeshBasicMaterial({ color: 0x69e1a8, depthTest: false, depthWrite: false }),
      };
    }
    for (const suffix of RIGGED_EXPERIMENTAL_POSE_BONE_SUFFIXES) {
      const name = `${this.poseEditSide}_${suffix}` as RiggedExperimentalHandBoneName;
      const finger = poseEditFingerForBoneName(name);
      const visible = this.poseEditFingerFilter === "all" || finger === this.poseEditFingerFilter;
      let marker = this.poseMarkers.get(name);
      if (!marker) {
        marker = new THREE.Mesh(this.poseMarkerGeometry, this.poseMarkerMaterials[this.poseEditSide]);
        marker.name = `pose-joint-marker:${name}`;
        marker.userData.poseEditBoneName = name;
        marker.renderOrder = 1000;
        marker.frustumCulled = false;
        this.poseMarkers.set(name, marker);
        this.scene.add(marker);
      }
      marker.visible = visible;
      if (!visible) continue;
      const bone = this.getHand3D(this.poseEditSide).getEditableBone(name);
      bone.getWorldPosition(marker.position);
      marker.scale.setScalar(name === this.poseEditBoneName ? 1.45 : 1);
    }
  }

  private hidePoseMarkers(): void {
    for (const marker of this.poseMarkers.values()) marker.visible = false;
  }

  private applyHandModelSelection(): void {
    if (!isDetailedHandModel(this.requestedHandModel)) {
      this.leftHand3D.setHandModel(this.requestedHandModel);
      this.rightHand3D.setHandModel(this.requestedHandModel);
      if (this.requestedHandModel === RIGGED_EXPERIMENTAL_HAND_MODEL_ID) {
        this.ensureBundledLeadInPose();
      } else {
        this.clearBundledLeadInPose();
      }
      return;
    }
    this.clearBundledLeadInPose();
    this.leftHand3D.setHandModel(
      this.requestedHandModel,
      this.selectImprovedLod(this.leftHand3D),
    );
    this.rightHand3D.setHandModel(
      this.requestedHandModel,
      this.selectImprovedLod(this.rightHand3D),
    );
  }

  private clearBundledLeadInPose(): void {
    if (!this.bundledLeadInPosePending && !this.bundledLeadInPoseApplied && !this.bundledLeadInPoseFailed) return;
    this.bundledLeadInPoseRequest += 1;
    this.bundledLeadInPosePending = false;
    this.bundledLeadInPoseApplied = false;
    this.bundledLeadInPoseFailed = false;
    this.leftHand3D.setLeadInStartPose(null);
    this.rightHand3D.setLeadInStartPose(null);
  }

  private ensureBundledLeadInPose(): void {
    if (this.isDestroyed || this.bundledLeadInPosePending || this.bundledLeadInPoseApplied || this.bundledLeadInPoseFailed) return;
    const request = ++this.bundledLeadInPoseRequest;
    this.bundledLeadInPosePending = true;
    void (async () => {
      try {
        await Promise.all([this.leftHand3D.waitForHandModelReady(), this.rightHand3D.waitForHandModelReady()]);
        if (this.isDestroyed || request !== this.bundledLeadInPoseRequest || this.requestedHandModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) return;
        const leftRig = this.leftHand3D.getRiggedExperimentalHand();
        const rightRig = this.rightHand3D.getRiggedExperimentalHand();
        const leftHash = leftRig?.sourceAssetSha256;
        const rightHash = rightRig?.sourceAssetSha256;
        if (!leftRig || !rightRig || !leftHash || !rightHash) return;

        const response = await fetch(`${import.meta.env.BASE_URL}models/hands/rigged-experimental/right_hand_starting_pose.rigged-hand-pose.json`);
        if (!response.ok) throw new Error(`Bundled start pose could not be loaded (${response.status}).`);
        const preset = importRiggedHandPosePresetJson(await response.text(), { left: leftHash, right: rightHash });
        if (this.isDestroyed || request !== this.bundledLeadInPoseRequest || this.requestedHandModel !== RIGGED_EXPERIMENTAL_HAND_MODEL_ID) return;

        const rightStartPose = this.rightHand3D.retargetLeadInStartPoseFrom(this.rightHand3D, preset.hands.right, false);
        const leftStartPose = this.leftHand3D.retargetLeadInStartPoseFrom(this.rightHand3D, preset.hands.right, true);
        this.rightHand3D.setLeadInStartPose(rightStartPose);
        this.leftHand3D.setLeadInStartPose(leftStartPose);
        this.bundledLeadInPoseApplied = true;
        this.update(this.currentTransportTime, this.lastActiveNotes);
      } catch {
        // A missing, invalid, or GLB-mismatched optional preset must not block normal playback.
        if (request === this.bundledLeadInPoseRequest) {
          this.leftHand3D.setLeadInStartPose(null);
          this.rightHand3D.setLeadInStartPose(null);
          this.bundledLeadInPoseFailed = true;
        }
      } finally {
        if (request === this.bundledLeadInPoseRequest) this.bundledLeadInPosePending = false;
      }
    })();
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
    let leftSamplingSource: TestingHandDiagnosticContext["samplingSource"] = "motion-plan-array";
    let rightSamplingSource: TestingHandDiagnosticContext["samplingSource"] = "motion-plan-array";

    if (this.poseEditSampling) {
      leftPose = this.samplePoseForPoseEdit(this.poseEditSampling.timepoint, "left");
      rightPose = this.samplePoseForPoseEdit(this.poseEditSampling.timepoint, "right");
      leftSamplingSource = this.motionBuffer ? "motion-buffer" : "motion-plan-array";
      rightSamplingSource = this.motionBuffer ? "motion-buffer" : "motion-plan-array";
    } else if (this.motionBuffer) {
      leftPose = this.motionBuffer.samplePoseClamped(timeSeconds, "left");
      rightPose = this.motionBuffer.samplePoseClamped(timeSeconds, "right");
      leftSamplingSource = "motion-buffer";
      rightSamplingSource = "motion-buffer";
    } else if (this.motionPlan) {
      leftPose = this.interpolatePoseFromArray(this.leftPoses, timeSeconds);
      rightPose = this.interpolatePoseFromArray(this.rightPoses, timeSeconds);
    }

    // Fall back to motionPlan poses if buffer did not yield a pose for that hand
    if (!this.poseEditSampling && !leftPose && this.leftPoses.length > 0) {
      leftPose = this.interpolatePoseFromArray(this.leftPoses, timeSeconds);
      leftSamplingSource = "motion-plan-fallback";
    }
    if (!this.poseEditSampling && !rightPose && this.rightPoses.length > 0) {
      rightPose = this.interpolatePoseFromArray(this.rightPoses, timeSeconds);
      rightSamplingSource = "motion-plan-fallback";
    }

    const captureModel = this.requestedHandModel === "testing" || this.requestedHandModel === "rigged-experimental"
      ? this.requestedHandModel
      : null;
    const captureHandDiagnostics = captureModel !== null && isHandFrameCaptureActiveFor(captureModel);
    const rendered = this.fallingNotes3D.getRenderedNoteTimings();
    const noteSource = this.performancePlan ? rendered : this.notes;
    const boundaryEvents = captureHandDiagnostics ? {
      left: observeHandFrameNoteBoundaries("left", noteSource, timeSeconds),
      right: observeHandFrameNoteBoundaries("right", noteSource, timeSeconds),
    } : { left: [], right: [] };
    const sampleContext = (
      hand: "left" | "right",
      source: TestingHandDiagnosticContext["samplingSource"],
    ): TestingHandDiagnosticContext | undefined => {
      if (!captureHandDiagnostics) return undefined;
      const fallbackPoses = hand === "left" ? this.leftPoses : this.rightPoses;
      const sourcePoses = source === "motion-buffer" && this.motionBuffer
        ? this.motionBuffer.poses.filter(pose => pose.hand === hand)
        : fallbackPoses;
      const model = (hand === "left" ? this.leftHand3D : this.rightHand3D).getHandModelDiagnostics();
      const intervals = this.motionBuffer?.getHandCoverageIntervals(hand) ?? null;
      const isCovered = intervals === null ? null : intervals.some(interval =>
        interval.start <= timeSeconds + 1e-4 && interval.end >= timeSeconds - 1e-4);
      return {
        displayedTransportTimeSeconds: timeSeconds,
        noteBoundaryEvents: boundaryEvents[hand],
        samplingSource: source,
        motionPlanIdentity: this.motionPlan ? {
          planId: this.motionPlan.planId,
          inputRevision: this.motionPlan.inputRevision,
          profileId: this.motionPlan.profileId,
          profileRevision: this.motionPlan.profileRevision,
          engineVersion: this.motionPlan.engineVersion,
        } : null,
        handModel: {
          requestedModel: model.requestedModel,
          loadedModel: model.loadedModel,
          requestedLod: model.requestedLod,
          loadedLod: model.loadedLod,
          state: model.state,
          error: model.error,
        },
        poseSampling: describeMotionPoseSample(sourcePoses, timeSeconds),
        coverage: {
          source: intervals === null ? "static-motion-plan-no-coverage-metadata" : "verified-motion-buffer",
          intervals,
          requestedTimeCovered: isCovered,
          continuousCoverageEndSeconds: this.motionBuffer?.getHandContinuousCoverageUntil(hand, timeSeconds) ?? null,
        },
      };
    };

    const leftHoverLift = calculateHandHoverLift("left", timeSeconds, noteSource);
    const rightHoverLift = calculateHandHoverLift("right", timeSeconds, noteSource);
    // Testing contact correction and Rigged Experimental capture both need the
    // current key target data. The experimental update records this context only;
    // it does not run the Testing solver or alter the rendered rig.
    const usesImprovedHand = usesImprovedHandMotion(this.requestedHandModel) ||
      (this.requestedHandModel === "testing" && (this.testingKeyContact || captureHandDiagnostics));
    const capturesRiggedTargets = this.requestedHandModel === "rigged-experimental" && captureHandDiagnostics;
    const shouldProvideContactTargets = usesImprovedHand || capturesRiggedTargets;

    if (leftPose) {
      if (shouldProvideContactTargets) {
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
          sampleContext("left", leftSamplingSource),
          timeSeconds,
          this.leadInDurationSeconds,
        );
      } else {
        this.leftHand3D.updateFromPose(leftPose, this.skinSettings, this.showFingerLabels, leftHoverLift, [], sampleContext("left", leftSamplingSource), timeSeconds, this.leadInDurationSeconds);
      }
    } else {
      this.leftHand3D.clear();
    }

    if (rightPose) {
      if (shouldProvideContactTargets) {
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
          sampleContext("right", rightSamplingSource),
          timeSeconds,
          this.leadInDurationSeconds,
        );
      } else {
        this.rightHand3D.updateFromPose(rightPose, this.skinSettings, this.showFingerLabels, rightHoverLift, [], sampleContext("right", rightSamplingSource), timeSeconds, this.leadInDurationSeconds);
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
    const poseMarkerPointerDown = (e: PointerEvent) => {
      if (!this.poseEditActive || e.button !== 0 || this.poseMarkers.size === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const visibleMarkers = [...this.poseMarkers.values()].filter(marker => marker.visible);
      const marker = this.raycaster.intersectObjects(visibleMarkers, false)[0]?.object as THREE.Mesh | undefined;
      const boneName = marker?.userData.poseEditBoneName as RiggedExperimentalHandBoneName | undefined;
      if (!boneName) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setPoseEditTarget(this.poseEditSide, boneName);
    };
    // Capture before OrbitControls and TransformControls so clicking a joint
    // marker selects it without starting a camera drag or piano note.
    this.canvas.addEventListener("pointerdown", poseMarkerPointerDown, true);

    const getPitchAtEvent = (e: PointerEvent): number | null => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      return this.keyboard3D.getPitchFromRaycaster(this.raycaster);
    };

    const pointerDown = (e: PointerEvent) => {
      if (this.poseEditActive) return;
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
      this.canvas.removeEventListener("pointerdown", poseMarkerPointerDown, true);
      for (const [type, listener] of listeners) this.canvas.removeEventListener(type, listener);
      this.pointerListenerCleanup = null;
    };
    for (const [type, listener] of listeners) this.canvas.addEventListener(type, listener);
  }

  private renderFrame(): void {
    if (this.isDestroyed || !this.isVisible()) return;
    if (this.poseEditActive) this.syncPoseMarkers();
    if (isDetailedHandModel(this.requestedHandModel)) {
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
    this.disposePoseEditControls();
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
