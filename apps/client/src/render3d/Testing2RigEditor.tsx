import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { ArrowDownToLine, Check, Hand, Redo2, RotateCcw, Save, Undo2, X } from "lucide-react";
import {
  IMPROVED_HAND_JOINT_NAMES,
  improvedHandAssetLoader,
  type ImprovedHandAsset,
  type ImprovedHandSide,
} from "./improvedHandAssets";
import { buildImprovedHandGlbRig, type ParsedHandGlbRig } from "./handRigBuilder";
import {
  compareTesting2RigJointCentersMirror,
  createTesting2RigEditTransaction,
  measureTesting2RigChains,
  readTesting2RigJointCenters,
  TESTING2_INCHES_PER_METER,
  TESTING2_RIG_CHAIN_EDGES,
  TESTING2_RIG_JOINT_NAMES,
  validateTesting2RigJointCenters,
  type Testing2RigJointCenters,
  type Testing2RigJointName,
} from "./testing2RigEdit";
import {
  createTesting2RigPreset,
  testing2RigPresetSourceAssetFromManifest,
  validateTesting2RigPreset,
  type Testing2RigPreset,
  type Testing2RigPresetDraft,
} from "./testing2RigPreset";
import "./Testing2RigEditor.css";

const METERS_TO_MILLIMETERS = 1000;
const PRESET_MAX_ABS_METERS = 2;
const DEFAULT_BEND_DEGREES = 35;
const CAMERA_FIT_PADDING = 1.1;
const CAMERA_VIEW_DIRECTION = new THREE.Vector3(0.8, 0.62, 1.25).normalize();
const EMPTY_PRESETS: readonly Testing2RigPreset[] = [];
const BONE_LINE_NAMES: readonly (readonly [Testing2RigJointName, Testing2RigJointName])[] = TESTING2_RIG_CHAIN_EDGES;

function getCameraOffset(distance: number): THREE.Vector3 {
  return CAMERA_VIEW_DIRECTION.clone().multiplyScalar(distance * CAMERA_FIT_PADDING);
}

type FingerId = "thumb" | "index" | "middle" | "ring" | "pinky";
type VisibleFinger = FingerId | "all";
type AxisIndex = 0 | 1 | 2;
type JointInputs = Record<Testing2RigJointName, [string, string, string]>;
type CentersByHand = Record<ImprovedHandSide, Testing2RigJointCenters>;

interface Testing2RigInstance {
  side: ImprovedHandSide;
  asset: ImprovedHandAsset;
  root: THREE.Group;
  rig: ParsedHandGlbRig;
  material: THREE.MeshPhysicalMaterial;
  overlay: THREE.Group;
  markers: Map<Testing2RigJointName, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>;
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  baseCenters: Testing2RigJointCenters;
  visualCenters: Testing2RigJointCenters;
}

interface RigEditorRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  transformControls: TransformControls;
  rigs: Record<ImprovedHandSide, Testing2RigInstance>;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  animationFrame: number;
  resizeObserver: ResizeObserver | null;
  removeResizeListener: (() => void) | null;
  removePointerListeners: (() => void) | null;
}

interface EditHistoryEntry {
  before: CentersByHand;
  after: CentersByHand;
}

interface EditSession {
  before: CentersByHand;
  changed: boolean;
}

interface BendSnapshot {
  side: ImprovedHandSide;
  bones: Array<{
    bone: THREE.Bone;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    matrix: THREE.Matrix4;
    matrixAutoUpdate: boolean;
  }>;
}

export interface Testing2RigEditorProps {
  onClose(): void;
  /** Optional parent-managed saved presets shown in the load picker. */
  presets?: readonly Testing2RigPreset[];
  /** Loads one selected immutable preset; the component still validates its asset identity. */
  onLoadPreset?: (presetId: string) => Promise<Testing2RigPreset | null>;
  /** Persists a new immutable preset. The callback must reject collisions instead of replacing. */
  onSavePreset?: (draft: Testing2RigPresetDraft) => Promise<Testing2RigPreset>;
}

const FINGER_CHAINS: Record<FingerId, Testing2RigJointName[]> = {
  thumb: ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  index: ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  middle: ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  ring: ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  pinky: ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
};

function cloneCentersByHand(centers: CentersByHand): CentersByHand {
  return {
    left: validateTesting2RigJointCenters(centers.left),
    right: validateTesting2RigJointCenters(centers.right),
  };
}

function centersEqual(a: Testing2RigJointCenters, b: Testing2RigJointCenters): boolean {
  return TESTING2_RIG_JOINT_NAMES.every((name) =>
    a[name][0] === b[name][0] && a[name][1] === b[name][1] && a[name][2] === b[name][2],
  );
}

function centersByHandEqual(a: CentersByHand, b: CentersByHand): boolean {
  return centersEqual(a.left, b.left) && centersEqual(a.right, b.right);
}

function makeJointInputs(centers: Testing2RigJointCenters, name: Testing2RigJointName): [string, string, string] {
  return centers[name].map((value) => (value * METERS_TO_MILLIMETERS).toFixed(1)) as [string, string, string];
}

function makeAllJointInputs(centers: Testing2RigJointCenters): JointInputs {
  return Object.fromEntries(TESTING2_RIG_JOINT_NAMES.map((name) => [name, makeJointInputs(centers, name)])) as JointInputs;
}

function centersForPreset(preset: Testing2RigPreset): CentersByHand {
  const toCenters = (side: ImprovedHandSide): Testing2RigJointCenters => {
    const entries = preset.hands[side];
    return validateTesting2RigJointCenters(Object.fromEntries(
      entries.map((entry) => [entry.name, [...entry.positionMeters]]),
    ));
  };
  return { left: toCenters("left"), right: toCenters("right") };
}

function centersToPresetPositions(centers: Testing2RigJointCenters) {
  return TESTING2_RIG_JOINT_NAMES.map((name) => ({ name, positionMeters: [...centers[name]] as [number, number, number] }));
}

function setLinePositions(instance: Testing2RigInstance, centers: Testing2RigJointCenters): void {
  const attribute = instance.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
  const positions = attribute.array as Float32Array;
  BONE_LINE_NAMES.forEach(([start, end], edgeIndex) => {
    const a = centers[start];
    const b = centers[end];
    for (let axis = 0; axis < 3; axis++) {
      positions[edgeIndex * 6 + axis] = a[axis]! * TESTING2_INCHES_PER_METER;
      positions[edgeIndex * 6 + 3 + axis] = b[axis]! * TESTING2_INCHES_PER_METER;
    }
  });
  attribute.needsUpdate = true;
  instance.lines.geometry.computeBoundingSphere();
}

/** Only changes overlay visibility; the skin, bind positions and edit history are untouched. */
function setVisibleFinger(instance: Testing2RigInstance, finger: VisibleFinger): void {
  const visible = finger === "all" ? null : new Set<Testing2RigJointName>(FINGER_CHAINS[finger]);
  for (const [name, marker] of instance.markers) marker.visible = visible === null || visible.has(name);
  const indices = BONE_LINE_NAMES.flatMap(([start, end], index) =>
    visible === null || (visible.has(start) && visible.has(end)) ? [index * 2, index * 2 + 1] : [],
  );
  instance.lines.geometry.setIndex(indices);
}

function updateMarkers(instance: Testing2RigInstance, centers: Testing2RigJointCenters, selectedJoint: Testing2RigJointName): void {
  instance.visualCenters = centers;
  for (const name of TESTING2_RIG_JOINT_NAMES) {
    const marker = instance.markers.get(name);
    if (!marker) continue;
    const [x, y, z] = centers[name];
    marker.position.set(x, y, z).multiplyScalar(TESTING2_INCHES_PER_METER);
    marker.material.color.set(name === selectedJoint ? "#ffe38a" : "#92d7ce");
    marker.scale.setScalar(name === selectedJoint ? 1.45 : 1);
  }
  setLinePositions(instance, centers);
  instance.root.updateMatrixWorld(true);
  instance.rig.skinnedMesh.skeleton.update();
}

function disposeRig(instance: Testing2RigInstance): void {
  instance.overlay.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material.dispose();
    }
  });
  instance.rig.skinnedMesh.geometry.dispose();
  instance.rig.skinnedMesh.skeleton.dispose();
  instance.material.dispose();
  instance.root.clear();
}

function createOverlay(
  side: ImprovedHandSide,
  root: THREE.Group,
  rig: ParsedHandGlbRig,
  centers: Testing2RigJointCenters,
): Pick<Testing2RigInstance, "overlay" | "markers" | "lines"> {
  const overlay = new THREE.Group();
  overlay.name = `testing2-rig-overlay-${side}`;
  const linePositions = new Float32Array(BONE_LINE_NAMES.length * 6);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  const lines = new THREE.LineSegments(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: 0x82a7a4, transparent: true, opacity: 0.72 }),
  );
  lines.name = `testing2-rig-bone-lines-${side}`;
  overlay.add(lines);

  const sphereGeometry = new THREE.SphereGeometry(0.095, 12, 10);
  const markers = new Map<Testing2RigJointName, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();
  for (const name of TESTING2_RIG_JOINT_NAMES) {
    const marker = new THREE.Mesh(
      sphereGeometry,
      new THREE.MeshBasicMaterial({ color: 0x92d7ce, depthTest: false }),
    );
    marker.name = `testing2-joint-${side}-${name}`;
    marker.userData.jointName = name;
    marker.renderOrder = 5;
    markers.set(name, marker);
    overlay.add(marker);
  }
  root.add(overlay);
  const temporaryInstance = { side, root, rig, overlay, markers, lines } as Testing2RigInstance;
  updateMarkers(temporaryInstance, centers, "wrist");
  return { overlay, markers, lines };
}

function prepareScene(host: HTMLDivElement): RigEditorRuntime {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#111720");
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 300);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.className = "testing2-rig-editor__canvas";
  renderer.domElement.setAttribute("aria-label", "Orbitable Testing2 hand rig preview. Click a joint marker to edit it.");
  host.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xe7f4f2, 0x252b35, 2.05));
  const keyLight = new THREE.DirectionalLight(0xffebd1, 3.5);
  keyLight.position.set(5, 9, 8);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x93c8ff, 1.3);
  fillLight.position.set(-7, 3, -5);
  scene.add(fillLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 100;
  controls.target.set(0, 0, 0);
  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  transformControls.space = "world";
  transformControls.size = 0.78;
  transformControls.translationSnap = 0.03937007874015748;
  scene.add(transformControls.getHelper());
  transformControls.addEventListener("dragging-changed", (event) => {
    controls.enabled = event.value !== true;
  });

  const runtime: RigEditorRuntime = {
    scene,
    camera,
    renderer,
    controls,
    transformControls,
    rigs: {} as Record<ImprovedHandSide, Testing2RigInstance>,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    animationFrame: 0,
    resizeObserver: null,
    removeResizeListener: null,
    removePointerListeners: null,
  };

  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  if (typeof ResizeObserver !== "undefined") {
    runtime.resizeObserver = new ResizeObserver(resize);
    runtime.resizeObserver.observe(host);
  } else {
    window.addEventListener("resize", resize);
    runtime.removeResizeListener = () => window.removeEventListener("resize", resize);
  }
  return runtime;
}

function disposeRuntime(runtime: RigEditorRuntime, host: HTMLDivElement): void {
  cancelAnimationFrame(runtime.animationFrame);
  runtime.resizeObserver?.disconnect();
  runtime.removeResizeListener?.();
  runtime.removePointerListeners?.();
  runtime.transformControls.detach();
  runtime.transformControls.dispose();
  runtime.controls.dispose();
  for (const side of ["left", "right"] as const) {
    const instance = runtime.rigs[side];
    if (instance) disposeRig(instance);
  }
  runtime.scene.clear();
  runtime.renderer.dispose();
  runtime.renderer.domElement.remove();
  if (host.contains(runtime.renderer.domElement)) host.removeChild(runtime.renderer.domElement);
}

function makeRigInstance(side: ImprovedHandSide, asset: ImprovedHandAsset): Testing2RigInstance {
  const root = new THREE.Group();
  root.name = `testing2-rig-coordinate-root-${side}`;
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#c6bdb4"),
    roughness: 0.76,
    metalness: 0,
    clearcoat: 0.05,
    side: THREE.DoubleSide,
  });
  const rig = buildImprovedHandGlbRig(
    side,
    material,
    root,
    asset.buffer,
    asset.lod,
    IMPROVED_HAND_JOINT_NAMES,
    asset.manifest.extras,
  );
  root.updateMatrixWorld(true);
  rig.skinnedMesh.skeleton.update();
  const baseCenters = readTesting2RigJointCenters(rig.skinnedMesh, root, TESTING2_INCHES_PER_METER);
  const overlay = createOverlay(side, root, rig, baseCenters);
  return {
    side,
    asset,
    root,
    rig,
    material,
    ...overlay,
    baseCenters,
    visualCenters: baseCenters,
  };
}

function getCameraFit(instance: Testing2RigInstance): { center: THREE.Vector3; distance: number } {
  instance.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(instance.rig.skinnedMesh);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  return { center, distance: Math.max(3.5, size.length() * 1.35) };
}

function makePresetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `rig-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Secure random IDs are unavailable. The rig preset was not saved.");
}

function getBendPivot(finger: FingerId): { pivot: Testing2RigJointName; affected: Testing2RigJointName[] } {
  const chain = FINGER_CHAINS[finger];
  const pivotIndex = finger === "thumb" ? 1 : 2;
  return { pivot: chain[pivotIndex]!, affected: chain.slice(pivotIndex) };
}

export function Testing2RigEditor({ onClose, presets = EMPTY_PRESETS, onLoadPreset, onSavePreset }: Testing2RigEditorProps) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<RigEditorRuntime | null>(null);
  const initialCentersRef = useRef<CentersByHand | null>(null);
  const cleanCentersRef = useRef<CentersByHand | null>(null);
  const draftCentersRef = useRef<CentersByHand | null>(null);
  const editSessionRef = useRef<EditSession | null>(null);
  const bendSnapshotRef = useRef<BendSnapshot | null>(null);
  const undoStackRef = useRef<EditHistoryEntry[]>([]);
  const redoStackRef = useRef<EditHistoryEntry[]>([]);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const activeHandRef = useRef<ImprovedHandSide>("right");
  const editorStateRef = useRef({
    activeHand: "right" as ImprovedHandSide,
    selectedJoint: "index-finger-phalanx-proximal" as Testing2RigJointName,
    isBendPreview: false,
  });

  const [activeHand, setActiveHand] = useState<ImprovedHandSide>("right");
  const [selectedJoint, setSelectedJoint] = useState<Testing2RigJointName>("index-finger-phalanx-proximal");
  const [visibleFinger, setVisibleFingerFilter] = useState<VisibleFinger>("all");
  const [fingerToBend, setFingerToBend] = useState<FingerId>("index");
  const [bendDegrees, setBendDegrees] = useState(DEFAULT_BEND_DEGREES);
  const [isBendPreview, setIsBendPreview] = useState(false);
  const [centers, setCenters] = useState<CentersByHand | null>(null);
  const [jointInputs, setJointInputs] = useState<JointInputs | null>(null);
  const [sourceAsset, setSourceAsset] = useState<Testing2RigPresetDraft["sourceAsset"] | null>(null);
  const [savedPresets, setSavedPresets] = useState<readonly Testing2RigPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState(presets[0]?.presetId ?? "");
  const [presetName, setPresetName] = useState("Testing2 rig copy");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPreset, setIsLoadingPreset] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [showDiscardConfirmation, setShowDiscardConfirmation] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const localPresets = useMemo(() => {
    const byId = new Map<string, Testing2RigPreset>();
    for (const preset of presets) byId.set(preset.presetId, preset);
    for (const preset of savedPresets) byId.set(preset.presetId, preset);
    return [...byId.values()];
  }, [presets, savedPresets]);

  const activePresetId = localPresets.some((preset) => preset.presetId === selectedPresetId)
    ? selectedPresetId
    : localPresets[0]?.presetId ?? "";

  useEffect(() => {
    activeHandRef.current = activeHand;
  }, [activeHand]);

  useEffect(() => {
    editorStateRef.current = { activeHand, selectedJoint, isBendPreview };
  }, [activeHand, isBendPreview, selectedJoint]);

  const selectedChainMeasurements = useMemo(() => {
    if (!centers) return [];
    return measureTesting2RigChains(centers[activeHand]).filter((measurement) =>
      measurement.start === selectedJoint || measurement.end === selectedJoint,
    );
  }, [activeHand, centers, selectedJoint]);

  const mirrorCheck = useMemo(() => {
    if (!centers) return null;
    try {
      return compareTesting2RigJointCentersMirror(centers.left, centers.right);
    } catch {
      return null;
    }
  }, [centers]);

  const selectedJointDisplayName = selectedJoint.replaceAll("-", " ");

  const syncInputValues = useCallback((nextCenters: CentersByHand, side: ImprovedHandSide, name: Testing2RigJointName) => {
    setJointInputs((current) => ({
      ...(current ?? makeAllJointInputs(nextCenters[side])),
      [name]: makeJointInputs(nextCenters[side], name),
    }));
  }, []);

  const setDraftState = useCallback((next: CentersByHand) => {
    const cloned = cloneCentersByHand(next);
    draftCentersRef.current = cloned;
    setCenters(cloned);
    const currentJoint = selectedJoint;
    setJointInputs(makeAllJointInputs(cloned[activeHand]));
    syncInputValues(cloned, activeHand, currentJoint);
  }, [activeHand, selectedJoint, syncInputValues]);

  const applyCenters = useCallback((next: CentersByHand): CentersByHand => {
    const validated: CentersByHand = {
      left: validateTesting2RigJointCenters(next.left),
      right: validateTesting2RigJointCenters(next.right),
    };
    const runtime = runtimeRef.current;
    if (!runtime?.rigs.left || !runtime.rigs.right) throw new Error("Both Testing2 hand rigs are not ready yet.");
    const applied: Array<{ undo(): void }> = [];
    try {
      for (const side of ["left", "right"] as const) {
        applied.push(createTesting2RigEditTransaction(
          runtime.rigs[side].rig.skinnedMesh,
          runtime.rigs[side].root,
          validated[side],
          { rootUnitsPerMeter: TESTING2_INCHES_PER_METER },
        ));
      }
    } catch (error) {
      for (const transaction of applied.reverse()) {
        try { transaction.undo(); } catch { /* Preserve the original transaction failure. */ }
      }
      throw error;
    }
    for (const side of ["left", "right"] as const) {
      updateMarkers(runtime.rigs[side], validated[side], selectedJoint);
    }
    return validated;
  }, [selectedJoint]);

  const stopBendPreview = useCallback(() => {
    const snapshot = bendSnapshotRef.current;
    const runtime = runtimeRef.current;
    if (!snapshot || !runtime?.rigs[snapshot.side]) {
      bendSnapshotRef.current = null;
      setIsBendPreview(false);
      return;
    }
    const instance = runtime.rigs[snapshot.side];
    for (const saved of snapshot.bones) {
      saved.bone.position.copy(saved.position);
      saved.bone.quaternion.copy(saved.quaternion);
      saved.bone.scale.copy(saved.scale);
      saved.bone.matrixAutoUpdate = saved.matrixAutoUpdate;
      saved.bone.matrix.copy(saved.matrix);
      saved.bone.matrixWorldNeedsUpdate = true;
    }
    instance.root.updateMatrixWorld(true);
    instance.rig.skinnedMesh.skeleton.update();
    const current = draftCentersRef.current;
    if (current) updateMarkers(instance, current[snapshot.side], selectedJoint);
    bendSnapshotRef.current = null;
    setIsBendPreview(false);
  }, [selectedJoint]);

  const pushHistory = useCallback((before: CentersByHand, after: CentersByHand) => {
    if (centersByHandEqual(before, after)) return;
    undoStackRef.current = [...undoStackRef.current, { before: cloneCentersByHand(before), after: cloneCentersByHand(after) }];
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const commitInputEdit = useCallback(() => {
    const session = editSessionRef.current;
    const current = draftCentersRef.current;
    if (session?.changed && current) pushHistory(session.before, current);
    editSessionRef.current = null;
    if (current) setJointInputs(makeAllJointInputs(current[activeHand]));
  }, [activeHand, pushHistory]);

  const applyPresetCenters = useCallback((next: CentersByHand, history = true) => {
    stopBendPreview();
    const before = draftCentersRef.current;
    if (!before) throw new Error("The Testing2 rig is not ready.");
    const applied = applyCenters(next);
    setDraftState(applied);
    setValidationError(null);
    setOperationMessage(null);
    if (history) pushHistory(before, applied);
  }, [applyCenters, pushHistory, setDraftState, stopBendPreview]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    let disposed = false;
    let runtime: RigEditorRuntime;
    try {
      runtime = prepareScene(host);
      runtimeRef.current = runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => {
        if (disposed) return;
        setSceneError(message);
        setIsLoading(false);
      });
      return () => { disposed = true; };
    }

    const startRenderLoop = () => {
      const render = () => {
        if (disposed) return;
        runtime.controls.update();
        runtime.renderer.render(runtime.scene, runtime.camera);
        runtime.animationFrame = requestAnimationFrame(render);
      };
      runtime.animationFrame = requestAnimationFrame(render);
    };

    const initialize = async () => {
      try {
        const [leftAsset, rightAsset] = await Promise.all([
          improvedHandAssetLoader.load("left", 0),
          improvedHandAssetLoader.load("right", 0),
        ]);
        if (disposed) return;
        const source = await testing2RigPresetSourceAssetFromManifest(leftAsset.manifest, {
          left: leftAsset.buffer,
          right: rightAsset.buffer,
        });
        if (disposed) return;
        const left = makeRigInstance("left", leftAsset);
        runtime.rigs.left = left;
        const right = makeRigInstance("right", rightAsset);
        runtime.rigs.right = right;
        runtime.scene.add(left.root, right.root);
        left.root.visible = false;
        right.root.visible = true;
        const allCenters = { left: left.baseCenters, right: right.baseCenters };
        initialCentersRef.current = cloneCentersByHand(allCenters);
        cleanCentersRef.current = cloneCentersByHand(allCenters);
        draftCentersRef.current = cloneCentersByHand(allCenters);
        setCenters(cloneCentersByHand(allCenters));
        setJointInputs(makeAllJointInputs(allCenters.right));
        setSourceAsset(source);
        const fit = getCameraFit(right);
        runtime.controls.target.copy(fit.center);
        runtime.camera.position.copy(fit.center).add(getCameraOffset(fit.distance));
        runtime.camera.near = Math.max(0.02, fit.distance * CAMERA_FIT_PADDING / 500);
        runtime.camera.far = Math.max(100, fit.distance * CAMERA_FIT_PADDING * 60);
        runtime.camera.updateProjectionMatrix();
        runtime.controls.update();

        const canvas = runtime.renderer.domElement;
        const onPointerDown = (event: PointerEvent) => { pointerDownRef.current = { x: event.clientX, y: event.clientY }; };
        const onPointerUp = (event: PointerEvent) => {
          const down = pointerDownRef.current;
          pointerDownRef.current = null;
          if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
          const rect = canvas.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          runtime.pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          runtime.raycaster.setFromCamera(runtime.pointer, runtime.camera);
          const instance = runtime.rigs[activeHandRef.current];
          const intersects = runtime.raycaster.intersectObjects([...instance.markers.values()].filter(marker => marker.visible), false);
          const hitName = intersects[0]?.object.userData.jointName;
          if (typeof hitName === "string" && (TESTING2_RIG_JOINT_NAMES as readonly string[]).includes(hitName)) {
            setSelectedJoint(hitName as Testing2RigJointName);
            const current = draftCentersRef.current;
            if (current) setJointInputs(makeAllJointInputs(current[activeHandRef.current]));
          }
        };
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerup", onPointerUp);
        const onGizmoDraggingChanged = (event: { value: unknown }) => {
          if (event.value === true) {
            if (!editSessionRef.current && draftCentersRef.current) {
              editSessionRef.current = { before: cloneCentersByHand(draftCentersRef.current), changed: false };
            }
            return;
          }
          const session = editSessionRef.current;
          const current = draftCentersRef.current;
          if (session?.changed && current) pushHistory(session.before, current);
          editSessionRef.current = null;
          if (current) setJointInputs(makeAllJointInputs(current[editorStateRef.current.activeHand]));
        };
        const onGizmoObjectChange = () => {
          const editor = editorStateRef.current;
          if (editor.isBendPreview) return;
          const current = draftCentersRef.current;
          if (!current) return;
          const instance = runtime.rigs[editor.activeHand];
          const marker = instance.markers.get(editor.selectedJoint);
          if (!marker) return;
          const candidatePoint = [
            marker.position.x / TESTING2_INCHES_PER_METER,
            marker.position.y / TESTING2_INCHES_PER_METER,
            marker.position.z / TESTING2_INCHES_PER_METER,
          ] as const;
          try {
            if (candidatePoint.some((value) => !Number.isFinite(value) || Math.abs(value) > PRESET_MAX_ABS_METERS)) {
              throw new Error(`Joint coordinates must stay within ±${PRESET_MAX_ABS_METERS * METERS_TO_MILLIMETERS} mm.`);
            }
            const nextSide = validateTesting2RigJointCenters({
              ...current[editor.activeHand],
              [editor.selectedJoint]: candidatePoint,
            });
            createTesting2RigEditTransaction(
              instance.rig.skinnedMesh,
              instance.root,
              nextSide,
              { rootUnitsPerMeter: TESTING2_INCHES_PER_METER },
            );
            const next = cloneCentersByHand({ ...current, [editor.activeHand]: nextSide });
            draftCentersRef.current = next;
            setCenters(next);
            setJointInputs(makeAllJointInputs(next[editor.activeHand]));
            updateMarkers(instance, nextSide, editor.selectedJoint);
            setValidationError(null);
            if (!editSessionRef.current) editSessionRef.current = { before: cloneCentersByHand(current), changed: false };
            editSessionRef.current.changed = true;
          } catch (error) {
            updateMarkers(instance, current[editor.activeHand], editor.selectedJoint);
            setValidationError(error instanceof Error ? error.message : String(error));
          }
        };
        runtime.transformControls.addEventListener("dragging-changed", onGizmoDraggingChanged);
        runtime.transformControls.addEventListener("objectChange", onGizmoObjectChange);
        runtime.removePointerListeners = () => {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointerup", onPointerUp);
          runtime.transformControls.removeEventListener("dragging-changed", onGizmoDraggingChanged);
          runtime.transformControls.removeEventListener("objectChange", onGizmoObjectChange);
        };
        startRenderLoop();
        setIsLoading(false);
      } catch (error) {
        if (!disposed) {
          setSceneError(error instanceof Error ? error.message : String(error));
          setIsLoading(false);
        }
      }
    };
    void initialize();

    return () => {
      disposed = true;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      disposeRuntime(runtime, host);
    };
  }, [pushHistory]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.rigs.left || !runtime.rigs.right) return;
    runtime.rigs.left.root.visible = activeHand === "left";
    runtime.rigs.right.root.visible = activeHand === "right";
    const fit = getCameraFit(runtime.rigs[activeHand]);
    runtime.controls.target.copy(fit.center);
    runtime.camera.position.copy(fit.center).add(getCameraOffset(fit.distance));
    runtime.camera.updateProjectionMatrix();
    runtime.controls.update();
  }, [activeHand, isLoading]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.rigs.left || !runtime.rigs.right || !centers) return;
    for (const side of ["left", "right"] as const) {
      const isBentSide = isBendPreview && bendSnapshotRef.current?.side === side;
      updateMarkers(runtime.rigs[side], isBentSide ? runtime.rigs[side].visualCenters : centers[side], selectedJoint);
    }
  }, [activeHand, centers, isBendPreview, selectedJoint]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.rigs.left || !runtime.rigs.right) return;
    setVisibleFinger(runtime.rigs.left, visibleFinger);
    setVisibleFinger(runtime.rigs.right, visibleFinger);
  }, [visibleFinger, isLoading]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.rigs.left || !runtime.rigs.right) return;
    if (isBendPreview) {
      runtime.transformControls.detach();
      return;
    }
    const selectedMarker = runtime.rigs[activeHand].markers.get(selectedJoint);
    if (selectedMarker) runtime.transformControls.attach(selectedMarker);
  }, [activeHand, isBendPreview, isLoading, selectedJoint]);

  const handleJointInput = (axis: AxisIndex, rawValue: string) => {
    setOperationMessage(null);
    setJointInputs((current) => {
      if (!current) return current;
      return { ...current, [selectedJoint]: current[selectedJoint].map((value, index) => index === axis ? rawValue : value) as [string, string, string] };
    });
    if (!editSessionRef.current && draftCentersRef.current) {
      editSessionRef.current = { before: cloneCentersByHand(draftCentersRef.current), changed: false };
    }
    if (isBendPreview) {
      setValidationError("Stop the temporary bend preview before editing bind-frame coordinates.");
      return;
    }
    const input = jointInputs?.[selectedJoint] ?? makeJointInputs(centers![activeHand], selectedJoint);
    const nextText = [...input] as [string, string, string];
    nextText[axis] = rawValue;
    if (nextText.some((value) => value.trim() === "")) {
      setValidationError("Enter finite X, Y, and Z values in millimeters.");
      return;
    }
    const values = nextText.map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value) || Math.abs(value / METERS_TO_MILLIMETERS) > PRESET_MAX_ABS_METERS)) {
      setValidationError(`Coordinates must be finite and within ±${PRESET_MAX_ABS_METERS * METERS_TO_MILLIMETERS} mm.`);
      return;
    }
    const current = draftCentersRef.current;
    if (!current) return;
    const candidate = {
      ...current[activeHand],
      [selectedJoint]: values.map((value) => value / METERS_TO_MILLIMETERS),
    };
    try {
      const validated = validateTesting2RigJointCenters(candidate);
      const next = { ...current, [activeHand]: validated };
      const runtime = runtimeRef.current;
      if (!runtime) throw new Error("The rig preview is not ready.");
      createTesting2RigEditTransaction(
        runtime.rigs[activeHand].rig.skinnedMesh,
        runtime.rigs[activeHand].root,
        validated,
        { rootUnitsPerMeter: TESTING2_INCHES_PER_METER },
      );
      runtime.rigs[activeHand].visualCenters = validated;
      updateMarkers(runtime.rigs[activeHand], validated, selectedJoint);
      draftCentersRef.current = cloneCentersByHand(next);
      setCenters(draftCentersRef.current);
      setValidationError(null);
      if (editSessionRef.current) editSessionRef.current.changed = true;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const undo = () => {
    commitInputEdit();
    stopBendPreview();
    const entry = undoStackRef.current.at(-1);
    if (!entry) return;
    try {
      const applied = applyCenters(entry.before);
      setDraftState(applied);
      undoStackRef.current = undoStackRef.current.slice(0, -1);
      redoStackRef.current = [...redoStackRef.current, entry];
      setCanUndo(undoStackRef.current.length > 0);
      setCanRedo(true);
      setValidationError(null);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const redo = () => {
    commitInputEdit();
    stopBendPreview();
    const entry = redoStackRef.current.at(-1);
    if (!entry) return;
    try {
      const applied = applyCenters(entry.after);
      setDraftState(applied);
      redoStackRef.current = redoStackRef.current.slice(0, -1);
      undoStackRef.current = [...undoStackRef.current, entry];
      setCanUndo(true);
      setCanRedo(redoStackRef.current.length > 0);
      setValidationError(null);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetCurrentHand = () => {
    const initial = initialCentersRef.current;
    const current = draftCentersRef.current;
    if (!initial || !current) return;
    const next = { ...current, [activeHand]: initial[activeHand] };
    try {
      applyPresetCenters(next);
      setOperationMessage(`${activeHand === "left" ? "Left" : "Right"} hand reset to the packaged bind pose.`);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetBothHands = () => {
    const initial = initialCentersRef.current;
    const current = draftCentersRef.current;
    if (!initial || !current) return;
    try {
      applyPresetCenters(initial);
      setOperationMessage("Both hands reset to their packaged bind poses.");
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const startBendPreview = () => {
    if (isBendPreview) {
      stopBendPreview();
      return;
    }
    const runtime = runtimeRef.current;
    const current = draftCentersRef.current;
    if (!runtime || !current) return;
    const instance = runtime.rigs[activeHand];
    const { pivot, affected } = getBendPivot(fingerToBend);
    const axisTuple = instance.asset.manifest.extras.boneFrames[activeHand][pivot]?.hinge;
    if (!axisTuple) {
      setValidationError(`No validated hinge axis is available for ${pivot}.`);
      return;
    }
    const bones = instance.rig.skinnedMesh.skeleton.bones;
    const snapshot: BendSnapshot = {
      side: activeHand,
      bones: bones.map((bone) => ({
        bone,
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
        matrix: bone.matrix.clone(),
        matrixAutoUpdate: bone.matrixAutoUpdate,
      })),
    };
    const pivotPoint = new THREE.Vector3(...current[activeHand][pivot]).multiplyScalar(TESTING2_INCHES_PER_METER);
    const axis = new THREE.Vector3(...axisTuple).normalize();
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, bendDegrees * Math.PI / 180);
    const bentCenters = { ...current[activeHand] } as Record<Testing2RigJointName, readonly [number, number, number]>;
    for (const name of affected) {
      const point = new THREE.Vector3(...current[activeHand][name]).multiplyScalar(TESTING2_INCHES_PER_METER);
      point.sub(pivotPoint).applyQuaternion(rotation).add(pivotPoint);
      bentCenters[name] = [point.x / TESTING2_INCHES_PER_METER, point.y / TESTING2_INCHES_PER_METER, point.z / TESTING2_INCHES_PER_METER];
      const bone = instance.rig.bonesByName.get(name)?.bone;
      if (!bone) continue;
      bone.position.copy(point);
      bone.quaternion.premultiply(rotation);
      bone.updateMatrix();
      bone.matrixWorldNeedsUpdate = true;
    }
    try {
      const validatedBend = validateTesting2RigJointCenters(bentCenters);
      instance.root.updateMatrixWorld(true);
      instance.rig.skinnedMesh.skeleton.update();
      updateMarkers(instance, validatedBend, selectedJoint);
      bendSnapshotRef.current = snapshot;
      setIsBendPreview(true);
      setValidationError(null);
      setOperationMessage("Temporary test bend is shown for the selected finger. It is not part of the saved bind-pose preset.");
    } catch (error) {
      for (const saved of snapshot.bones) {
        saved.bone.position.copy(saved.position);
        saved.bone.quaternion.copy(saved.quaternion);
        saved.bone.scale.copy(saved.scale);
        saved.bone.matrixAutoUpdate = saved.matrixAutoUpdate;
        saved.bone.matrix.copy(saved.matrix);
      }
      instance.root.updateMatrixWorld(true);
      instance.rig.skinnedMesh.skeleton.update();
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const savePreset = async () => {
    const current = draftCentersRef.current;
    if (!current || !sourceAsset || !onSavePreset) return;
    commitInputEdit();
    stopBendPreview();
    setIsSaving(true);
    setValidationError(null);
    setOperationMessage(null);
    try {
      const draft: Testing2RigPresetDraft = {
        presetId: makePresetId(),
        name: presetName.trim(),
        createdAtUnixMs: Date.now(),
        sourceAsset,
        hands: {
          left: centersToPresetPositions(current.left),
          right: centersToPresetPositions(current.right),
        },
      };
      createTesting2RigPreset(draft);
      const persisted = await onSavePreset(draft);
      const validated = validateTesting2RigPreset(persisted, sourceAsset);
      cleanCentersRef.current = cloneCentersByHand(centersForPreset(validated));
      setSavedPresets((existing) => [validated, ...existing.filter((preset) => preset.presetId !== validated.presetId)]);
      setSelectedPresetId(validated.presetId);
      setOperationMessage(`Saved new rig preset “${validated.name}”. No pianist profile was changed.`);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const loadSelectedPreset = async () => {
    const presetId = activePresetId;
    if (!presetId || !sourceAsset) return;
    setIsLoadingPreset(true);
    setValidationError(null);
    setOperationMessage(null);
    try {
      const preset = onLoadPreset
        ? await onLoadPreset(presetId)
        : localPresets.find((candidate) => candidate.presetId === presetId) ?? null;
      if (!preset) throw new Error("The selected rig preset could not be loaded.");
      const validated = validateTesting2RigPreset(preset, sourceAsset);
      const next = centersForPreset(validated);
      applyPresetCenters(next);
      cleanCentersRef.current = cloneCentersByHand(next);
      setOperationMessage(`Loaded “${validated.name}” as an unsaved editor draft.`);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingPreset(false);
    }
  };

  const requestClose = () => {
    commitInputEdit();
    stopBendPreview();
    const current = draftCentersRef.current;
    const clean = cleanCentersRef.current ?? initialCentersRef.current;
    if (!current || !clean || centersByHandEqual(current, clean)) {
      onClose();
      return;
    }
    setShowDiscardConfirmation(true);
  };

  const confirmDiscardAndClose = () => {
    setShowDiscardConfirmation(false);
    onClose();
  };

  const cancelDiscard = () => setShowDiscardConfirmation(false);

  const activeInputs = jointInputs?.[selectedJoint] ?? ["", "", ""];
  const selectedJointSegments = selectedChainMeasurements.map((measurement) => ({
    key: `${measurement.start}-${measurement.end}`,
    label: `${measurement.start.replaceAll("-", " ")} → ${measurement.end.replaceAll("-", " ")}`,
    lengthMm: measurement.lengthMeters * METERS_TO_MILLIMETERS,
  }));

  return (
    <div className="testing2-rig-editor" role="dialog" aria-modal="true" aria-labelledby="testing2-rig-editor-title" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (showDiscardConfirmation) cancelDiscard();
      else requestClose();
    }}>
      <header className="testing2-rig-editor__header">
        <div className="testing2-rig-editor__title-wrap">
          <div className="testing2-rig-editor__eyebrow">EXPERIMENTAL • NEUTRAL BIND PREVIEW</div>
          <h1 id="testing2-rig-editor-title">Testing2 rig editor</h1>
          <p>Adjust estimated joint centers on the source-derived hand mesh.</p>
        </div>
        <button className="testing2-rig-editor__icon-button" type="button" aria-label="Close rig editor" onClick={requestClose}><X size={19} /></button>
      </header>

      <div className="testing2-rig-editor__notice" role="note">
        <strong>These 25 bind/rest joint centers are estimates, not verified anatomy.</strong>
        <span>Joint moves are validated and rebound for a neutral mesh preview; the surface stays at rest. Runtime animation metadata, profile anatomy, skin weights, and existing pianist profiles are not modified.</span>
      </div>

      <main className="testing2-rig-editor__body">
        <section className="testing2-rig-editor__viewport-panel" aria-label="3D rig preview">
          <div className="testing2-rig-editor__viewport-toolbar">
            <div className="testing2-rig-editor__hand-switch" role="group" aria-label="Select hand">
              {(["left", "right"] as const).map((hand) => (
                <button key={hand} type="button" aria-pressed={activeHand === hand} onClick={() => {
                  commitInputEdit();
                  stopBendPreview();
                  setActiveHand(hand);
                  const current = draftCentersRef.current;
                  if (current) setJointInputs(makeAllJointInputs(current[hand]));
                  setValidationError(null);
                }}>
                  <Hand size={15} /> {hand === "left" ? "Left hand" : "Right hand"}
                </button>
              ))}
            </div>
            <label className="testing2-rig-editor__field-label" htmlFor="testing2-visible-finger">
              Show joints
              <select id="testing2-visible-finger" value={visibleFinger} onChange={event => {
                const finger = event.currentTarget.value as VisibleFinger;
                commitInputEdit();
                setVisibleFingerFilter(finger);
                if (finger !== "all" && !FINGER_CHAINS[finger].includes(selectedJoint)) {
                  setSelectedJoint(FINGER_CHAINS[finger][1]!);
                }
              }}>
                <option value="all">All fingers</option>
                {(["thumb", "index", "middle", "ring", "pinky"] as const).map(finger =>
                  <option key={finger} value={finger}>{finger[0]!.toUpperCase() + finger.slice(1)}</option>,
                )}
              </select>
            </label>
            <span className="testing2-rig-editor__viewport-hint">Orbit · scroll to zoom · select a joint · drag gizmo axes to move it</span>
          </div>
          <div className="testing2-rig-editor__viewport" ref={canvasHostRef}>
            {(isLoading || sceneError) && (
              <div className={`testing2-rig-editor__viewport-state${sceneError ? " is-error" : ""}`} role={sceneError ? "alert" : "status"}>
                {sceneError ? `Could not load the Testing2 rig: ${sceneError}` : "Loading both improved-hand LOD 0 rigs…"}
              </div>
            )}
            {isBendPreview && <div className="testing2-rig-editor__preview-badge">TEMPORARY {fingerToBend.toUpperCase()} BEND · {bendDegrees}°</div>}
          </div>
          <div className="testing2-rig-editor__viewport-footer">
            <span>{visibleFinger === "all" ? "25 named joints" : `${FINGER_CHAINS[visibleFinger].length} visible joints`}</span>
            <span>GLB bind frame · right-handed · measurements in mm</span>
            {mirrorCheck && <span className={mirrorCheck.consistent ? "is-ok" : "is-warning"} title="Mirror check centers each hand at its wrist and reflects X; it never auto-edits coordinates.">
              {mirrorCheck.consistent ? "Pair mirror check within 5 mm" : `Pair differs by ${(mirrorCheck.maxDeviationMeters * 1000).toFixed(1)} mm`}
            </span>}
          </div>
        </section>

        <aside className="testing2-rig-editor__controls" aria-label="Joint editor controls">
          <section className="testing2-rig-editor__card">
            <div className="testing2-rig-editor__section-title"><span>01</span><h2>Selected joint</h2></div>
            <label className="testing2-rig-editor__field-label" htmlFor="testing2-joint-select">Joint</label>
            <select id="testing2-joint-select" value={selectedJoint} onChange={(event) => {
              commitInputEdit();
              const joint = event.target.value as Testing2RigJointName;
              setSelectedJoint(joint);
              const current = draftCentersRef.current;
              if (current) setJointInputs(makeAllJointInputs(current[activeHand]));
              setValidationError(null);
            }}>
              {TESTING2_RIG_JOINT_NAMES.filter(name => visibleFinger === "all" || FINGER_CHAINS[visibleFinger].includes(name))
                .map((name) => <option key={name} value={name}>{name.replaceAll("-", " ")}</option>)}
            </select>
            <div className="testing2-rig-editor__coordinates-heading">
              <span>Position from GLB asset origin</span>
              <span>mm</span>
            </div>
            <div className="testing2-rig-editor__coordinate-grid">
              {(["X", "Y", "Z"] as const).map((axis, index) => (
                <label key={axis} className={`testing2-rig-editor__coordinate-field axis-${axis.toLowerCase()}`}>
                  <span>{axis}</span>
                  <input
                    aria-label={`${selectedJointDisplayName} ${axis} coordinate in millimeters`}
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={activeInputs[index] ?? ""}
                    disabled={isLoading || Boolean(sceneError) || isBendPreview}
                    onFocus={() => {
                      if (!editSessionRef.current && draftCentersRef.current) editSessionRef.current = { before: cloneCentersByHand(draftCentersRef.current), changed: false };
                    }}
                    onChange={(event) => handleJointInput(index as AxisIndex, event.target.value)}
                    onBlur={(event) => {
                      if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".testing2-rig-editor__coordinate-grid")) return;
                      commitInputEdit();
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="testing2-rig-editor__axis-note">Coordinates use the right-handed source GLB bind frame, in millimeters from the asset origin.</div>
            {selectedJointSegments.length > 0 && (
              <div className="testing2-rig-editor__segment-list" aria-label="Connected segment lengths">
                {selectedJointSegments.map((segment) => <div key={segment.key}><span>{segment.label}</span><strong>{segment.lengthMm.toFixed(1)} mm</strong></div>)}
              </div>
            )}
            {validationError && <div className="testing2-rig-editor__error" role="alert">{validationError}</div>}
          </section>

          <section className="testing2-rig-editor__card">
            <div className="testing2-rig-editor__section-title"><span>02</span><h2>Preview tools</h2></div>
            <div className="testing2-rig-editor__button-row">
              <button type="button" disabled={!canUndo || isLoading || isBendPreview} onClick={undo}><Undo2 size={15} /> Undo</button>
              <button type="button" disabled={!canRedo || isLoading || isBendPreview} onClick={redo}><Redo2 size={15} /> Redo</button>
            </div>
            <button className="testing2-rig-editor__secondary-button" type="button" disabled={!centers || isLoading || isBendPreview} onClick={resetCurrentHand}><RotateCcw size={15} /> Reset this hand to packaged bind pose</button>
            <div className="testing2-rig-editor__bend-controls">
              <label className="testing2-rig-editor__field-label" htmlFor="testing2-bend-finger">Temporary test fold</label>
              <div className="testing2-rig-editor__bend-row">
                <select id="testing2-bend-finger" value={fingerToBend} disabled={isBendPreview} onChange={(event) => setFingerToBend(event.target.value as FingerId)}>
                  {Object.keys(FINGER_CHAINS).map((finger) => <option key={finger} value={finger}>{finger[0]!.toUpperCase() + finger.slice(1)}</option>)}
                </select>
                <label className="testing2-rig-editor__angle-field"><span>Angle</span><input type="number" min="5" max="60" step="5" value={bendDegrees} disabled={isBendPreview} onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) setBendDegrees(Math.max(5, Math.min(60, value)));
                }} /><b>°</b></label>
              </div>
              <button className="testing2-rig-editor__accent-button" type="button" disabled={isLoading || Boolean(sceneError)} onClick={startBendPreview}>
                <Hand size={15} /> {isBendPreview ? "Return to neutral bind pose" : "Preview test fold"}
              </button>
              <p>This temporary fold is a view-only deformation test. Stop it to edit or save bind-frame centers.</p>
            </div>
          </section>

          <section className="testing2-rig-editor__card">
            <div className="testing2-rig-editor__section-title"><span>03</span><h2>Rig presets</h2></div>
            <label className="testing2-rig-editor__field-label" htmlFor="testing2-preset-name">Save as a new preset</label>
            <input id="testing2-preset-name" value={presetName} maxLength={120} disabled={!onSavePreset || isSaving || isBendPreview} onChange={(event) => setPresetName(event.target.value)} />
            <button className="testing2-rig-editor__accent-button" type="button" disabled={!onSavePreset || !sourceAsset || isSaving || isLoading || isBendPreview || Boolean(validationError) || !presetName.trim()} onClick={() => void savePreset()}>
              {isSaving ? <span className="testing2-rig-editor__spinner" aria-hidden="true" /> : <Save size={15} />} {isSaving ? "Saving new preset…" : "Save new rig preset"}
            </button>
            {!onSavePreset && <p className="testing2-rig-editor__muted-note">Preset saving is not connected by the parent screen.</p>}
            {localPresets.length > 0 && (
              <div className="testing2-rig-editor__load-row">
                <select aria-label="Saved rig presets" value={activePresetId} disabled={isLoadingPreset || isBendPreview} onChange={(event) => setSelectedPresetId(event.target.value)}>
                  {localPresets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.name}</option>)}
                </select>
                <button type="button" disabled={isLoadingPreset || isBendPreview || !activePresetId} title="Load as a draft; saving remains a separate action." onClick={() => void loadSelectedPreset()}>
                  <ArrowDownToLine size={14} /> {isLoadingPreset ? "Loading…" : "Load"}
                </button>
              </div>
            )}
            {operationMessage && <div className="testing2-rig-editor__success" role="status"><Check size={14} /> {operationMessage}</div>}
          </section>
        </aside>
      </main>

      <footer className="testing2-rig-editor__footer">
        <span>{sourceAsset ? `Source: ${sourceAsset.uri} · LOD0 L ${sourceAsset.handLod0Sha256.left.slice(0, 10)} · R ${sourceAsset.handLod0Sha256.right.slice(0, 10)}` : "Verifying the packaged left/right LOD0 assets…"}</span>
        <div>
          <button type="button" className="testing2-rig-editor__footer-reset" disabled={!centers || isLoading || isBendPreview} onClick={resetBothHands}>Reset both</button>
          <button type="button" onClick={requestClose}>Close</button>
        </div>
      </footer>
      {showDiscardConfirmation && (
        <div className="testing2-rig-editor__discard-backdrop">
          <section
            className="testing2-rig-editor__discard-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="testing2-rig-editor-discard-title"
            aria-describedby="testing2-rig-editor-discard-description"
          >
            <h2 id="testing2-rig-editor-discard-title">Discard unsaved rig edits?</h2>
            <p id="testing2-rig-editor-discard-description">
              Joint centers differ from the last successfully loaded or saved pose. Closing now will discard this editor draft.
            </p>
            <div className="testing2-rig-editor__discard-actions">
              <button type="button" autoFocus onClick={cancelDiscard}>Keep editing</button>
              <button type="button" onClick={confirmDiscardAndClose}>Discard draft and close</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
