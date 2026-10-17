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
import { FallingNotes3DView, NoteTimeIndex } from "./fallingNotes3dView";
import { Hand3DMeshGroup, KEYBOARD_WIDTH_IN } from "./handRigBuilder";
import { Keyboard3DView } from "./keyboard3dView";

export type Camera3DPreset = "concert" | "overhead" | "pov" | "side_arch";

interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface PianoScene3DOptions {
  canvas?: HTMLCanvasElement;
  fixedViewport?: { width: number; height: number; resolution: 1 };
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
  private readonly fallingNotes3D: FallingNotes3DView;
  private readonly leftHand3D: Hand3DMeshGroup;
  private readonly rightHand3D: Hand3DMeshGroup;
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
  private stageFloorMesh: THREE.Mesh | null = null;
  private stageFloorGeo: THREE.PlaneGeometry | null = null;
  private stageFloorMat: THREE.MeshPhysicalMaterial | null = null;
  private stageFloorTexture: THREE.CanvasTexture | null = null;

  public constructor(
    private readonly target: HTMLElement,
    options: PianoScene3DOptions = {},
  ) {
    this.fixedViewport = options.fixedViewport;
    this.ownsCanvas = options.canvas === undefined;
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

    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.5, 180);
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
            this.renderer.render(this.scene, this.camera);
          }
        });
      }

      this.setupLighting();
      this.setupStageFloor();

      this.keyboard3D = new Keyboard3DView();
      this.scene.add(this.keyboard3D.group);

      this.fallingNotes3D = new FallingNotes3DView(this.keyboard3D);
      this.scene.add(this.fallingNotes3D.group);

      this.leftHand3D = new Hand3DMeshGroup("left");
      this.rightHand3D = new Hand3DMeshGroup("right");
      this.scene.add(this.leftHand3D.group);
      this.scene.add(this.rightHand3D.group);

      this.setCameraPreset("concert");
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
    this.keyboard3D?.dispose();
    this.fallingNotes3D?.dispose();
    this.leftHand3D?.dispose();
    this.rightHand3D?.dispose();
    this.envMapTexture?.dispose();
    this.stageFloorGeo?.dispose();
    this.stageFloorMat?.dispose();
    this.stageFloorTexture?.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.renderer.domElement.remove();
  }

  private setupLighting(): void {
    // Low ambient hemisphere fill so directional shadows on white keys have rich dark contrast
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x111015, 0.24);
    hemiLight.position.set(0, 40, 0);
    this.scene.add(hemiLight);

    // Primary concert spot light casting high-contrast anatomical shadows from hands/fingers onto keys and floor
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 1.68);
    keyLight.position.set(7, 25, 8);
    keyLight.target.position.set(0, 0, -2.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 72;
    keyLight.shadow.camera.left = -30;
    keyLight.shadow.camera.right = 30;
    keyLight.shadow.camera.top = 18;
    keyLight.shadow.camera.bottom = -28;
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.012;
    keyLight.shadow.radius = 2.0;
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);

    // Subtle cool side-fill to sculpt lateral finger contours without flattening shadows
    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.18);
    fillLight.position.set(-18, 12, 14);
    this.scene.add(fillLight);

    // Gentle angled backlight to outline knuckles without creating central fallboard glare
    const rimLight = new THREE.DirectionalLight(0xfde68a, 0.16);
    rimLight.position.set(-10, 16, -24);
    this.scene.add(rimLight);
  }

  private setupStageFloor(): void {
    const floorSize = 160;
    this.stageFloorGeo = new THREE.PlaneGeometry(floorSize, floorSize, 1, 1);
    this.stageFloorGeo.rotateX(-Math.PI * 0.5);

    let floorTexture: THREE.CanvasTexture | null = null;
    if (typeof document !== "undefined") {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 1024;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          // Dark smoked oak / concert stage parquet planks running along Z
          const numPlanks = 16;
          const plankW = canvas.width / numPlanks;
          const plankPalette = [
            "#1c1815",
            "#211c18",
            "#191512",
            "#241e1a",
            "#1e1a16",
            "#221d19",
          ];

          for (let i = 0; i < numPlanks; i++) {
            const x = i * plankW;
            const plankColor = plankPalette[i % plankPalette.length]!;
            ctx.fillStyle = plankColor;
            ctx.fillRect(x, 0, plankW, canvas.height);

            // Subtle wood grain streaks along plank length
            ctx.fillStyle = "rgba(255, 255, 255, 0.015)";
            for (let g = 0; g < 12; g++) {
              const gx = x + ((g * 17) % Math.floor(plankW));
              ctx.fillRect(gx, 0, 1.5, canvas.height);
            }
            ctx.fillStyle = "rgba(0, 0, 0, 0.02)";
            for (let g = 0; g < 12; g++) {
              const gx = x + ((g * 23) % Math.floor(plankW));
              ctx.fillRect(gx, 0, 1.5, canvas.height);
            }

            // Staggered butt joints across the plank
            const jointOffset = (i * 197) % 512;
            ctx.fillStyle = "#0a0807";
            ctx.fillRect(x, jointOffset, plankW, 2.5);
            ctx.fillRect(x, (jointOffset + 512) % 1024, plankW, 2.5);

            // Seam between planks (dark shadow line + subtle highlight bevel)
            ctx.fillStyle = "#0c0a09";
            ctx.fillRect(x, 0, 2.5, canvas.height);
            ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
            ctx.fillRect(x + 2.5, 0, 1, canvas.height);
          }

          floorTexture = new THREE.CanvasTexture(canvas);
          floorTexture.wrapS = THREE.RepeatWrapping;
          floorTexture.wrapT = THREE.RepeatWrapping;
          floorTexture.repeat.set(6, 6);
          this.stageFloorTexture = floorTexture;
        }
      } catch {
        // Fallback without texture if canvas context is unavailable
      }
    }

    this.stageFloorMat = new THREE.MeshPhysicalMaterial({
      color: 0x1d1916,
      ...(floorTexture ? { map: floorTexture } : {}),
      roughness: 0.38,
      metalness: 0.05,
      clearcoat: 0.45,
      clearcoatRoughness: 0.24,
      reflectivity: 0.65,
      envMapIntensity: 0.35,
    });

    this.stageFloorMesh = new THREE.Mesh(this.stageFloorGeo, this.stageFloorMat);
    this.stageFloorMesh.position.set(0, -20.0, -16.0);
    this.stageFloorMesh.receiveShadow = true;
    this.scene.add(this.stageFloorMesh);
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
    this.update(this.currentTransportTime, this.lastActiveNotes);
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
    this.updateHandsAtTime(timeSeconds);

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
    this.renderFrame();
  }

  private updateHandsAtTime(timeSeconds: number): void {
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

    if (leftPose) {
      this.leftHand3D.updateFromPose(leftPose, this.skinSettings, this.showFingerLabels, leftHoverLift);
    } else {
      this.leftHand3D.clear();
    }

    if (rightPose) {
      this.rightHand3D.updateFromPose(rightPose, this.skinSettings, this.showFingerLabels, rightHoverLift);
    } else {
      this.rightHand3D.clear();
    }
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
    this.renderer.render(this.scene, this.camera);
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.resizeObserver?.disconnect();
    this.pointerListenerCleanup?.();
    this.controls?.dispose();
    this.keyboard3D.dispose();
    this.fallingNotes3D.dispose();
    this.leftHand3D.dispose();
    this.rightHand3D.dispose();
    this.envMapTexture?.dispose();
    this.stageFloorGeo?.dispose();
    this.stageFloorMat?.dispose();
    this.stageFloorTexture?.dispose();
    this.renderer.dispose();
    if (this.ownsCanvas) this.canvas.remove();
  }
}
