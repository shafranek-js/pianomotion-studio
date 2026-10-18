import * as THREE from "three";
import { PianoScene3D, type Camera3DPreset } from "../../../apps/client/src/render3d/pianoScene3d";
import type { Keyboard3DView } from "../../../apps/client/src/render3d/keyboard3dView";
import type { StageAppearance } from "../../../apps/client/src/settings/stageAppearance";

type StageDiagnostics = {
  appearance: StageAppearance;
  radius: number;
  floorY: number;
  reflectionResolution: number;
  reflectionTargetWidth: number;
  reflectionTargetHeight: number;
  reflectionPassEnabled: boolean;
  disposed: boolean;
};

type SceneInternals = {
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  keyboard3D: Keyboard3DView;
  fallingNotes3D: { getGlowSnapshot(): { count: number; noteIds: readonly string[] } };
};

type Frame = { width: number; height: number; data: Uint8ClampedArray };
type FloorPixelStats = { samples: number; changedSamples: number; totalChannelDelta: number; maxChannelDelta: number };
type FadeStats = { validPairs: number; averageChannelDelta: number; maxChannelDelta: number };
type DeckStats = { samples: number; changedDeckSamples: number; before: { peak: number; p99: number; bright: number }; after: { peak: number; p99: number; bright: number } };

declare global {
  interface Window {
    __stageEnvironment?: {
      diagnostics(): StageDiagnostics;
      canvasSize(): { width: number; height: number };
      webgl(): { version: string; contextLost: boolean };
      keyCount(): number;
      keyboardBounds(): { x: number; y: number; width: number; height: number; insideViewport: boolean };
      setAppearance(appearance: StageAppearance): StageDiagnostics;
      setView(view: Camera3DPreset | "overview" | "room"): void;
      capture(name: string, timeSeconds: number): void;
      compareFloor(first: string, second: string): FloorPixelStats;
      compareFadeEdge(): FadeStats;
      setAtmosphereVisible(visible: boolean): boolean;
      compareScreen(first: string, second: string, region: "sky" | "floor" | "all"): FloorPixelStats;
      glowSnapshot(): { count: number; noteIds: readonly string[] };
      setGlowVisible(visible: boolean): boolean;
      setNoteFixture(kind: "default" | "chord" | "edge"): void;
      setDeckFinish(finish: "legacy" | "current"): void;
      compareDeck(first: string, second: string): DeckStats;
      dispose(): void;
    };
    __stageEnvironmentError?: string;
  }
}

const status = document.querySelector<HTMLPreElement>("#status")!;
const width = 1280;
const height = 800;
const floorCenterZ = -16;
const frames = new Map<string, Frame>();
let currentTime = 0.2;
const notes = [
  { noteId: "stage-bass", trackId: "stage-acceptance", pitch: 48, velocity: 92, startSeconds: 0.1, endSeconds: 2.2, hand: "left" as const, finger: null, glissando: false },
  { noteId: "stage-middle", trackId: "stage-acceptance", pitch: 60, velocity: 88, startSeconds: 0.25, endSeconds: 1.8, hand: "left" as const, finger: null, glissando: false },
  { noteId: "stage-treble", trackId: "stage-acceptance", pitch: 72, velocity: 94, startSeconds: 0.4, endSeconds: 2.4, hand: "right" as const, finger: null, glissando: false },
  { noteId: "stage-high", trackId: "stage-acceptance", pitch: 84, velocity: 90, startSeconds: 0.15, endSeconds: 2.0, hand: "right" as const, finger: null, glissando: false },
];

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function projectWorldPoint(point: THREE.Vector3, camera: THREE.PerspectiveCamera): { x: number; y: number } | null {
  const projected = point.clone().project(camera);
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < -1 || projected.z > 1) return null;
  return { x: (projected.x * 0.5 + 0.5) * width, y: (0.5 - projected.y * 0.5) * height };
}

function pixelAt(frame: Frame, x: number, y: number): [number, number, number] | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null;
  const offset = (py * frame.width + px) * 4;
  return [frame.data[offset]!, frame.data[offset + 1]!, frame.data[offset + 2]!];
}

function averagePixel(frame: Frame, x: number, y: number, radius = 2): [number, number, number] | null {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  let r = 0;
  let g = 0;
  let b = 0;
  let samples = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const value = pixelAt(frame, centerX + dx, centerY + dy);
      if (!value) continue;
      r += value[0]; g += value[1]; b += value[2]; samples += 1;
    }
  }
  return samples > 0 ? [r / samples, g / samples, b / samples] : null;
}

function channelDelta(a: readonly number[], b: readonly number[]): number {
  return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
}

async function initialize(): Promise<void> {
  const host = document.querySelector<HTMLDivElement>("#stage-scene-host")!;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Fixed viewport real 3D stage environment");
  host.append(canvas);

  const scene = new PianoScene3D(host, { canvas, fixedViewport: { width, height, resolution: 1 } });
  const internals = scene as unknown as SceneInternals;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = width;
  sampleCanvas.height = height;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true })!;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const deck = internals.scene.getObjectByName("grand-piano-highway-deck") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  assert(deck, "Production note surface must exist");
  const currentDeckMaterial = deck.material;
  // Reproduce the reported finish without modifying any other production surface.
  const legacyDeckMaterial = currentDeckMaterial.clone();
  Object.assign(legacyDeckMaterial, { roughness: 0.16, metalness: 0.06, clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 1 });

  scene.setNotes(notes);
  scene.update(0.2);

  window.__stageEnvironment = {
    diagnostics: () => scene.getStageDiagnostics() as StageDiagnostics,
    canvasSize: () => ({ width: canvas.width, height: canvas.height }),
    webgl: () => {
      const context = internals.renderer.getContext();
      return {
        version: String(context.getParameter(context.VERSION)),
        contextLost: context.isContextLost(),
      };
    },
    keyCount: () => internals.keyboard3D.keysByPitch.size,
    keyboardBounds() {
      const box = new THREE.Box3().setFromObject(internals.keyboard3D.group);
      assert(!box.isEmpty(), "The production keyboard geometry should have visible bounds");
      const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z), new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];
      const projected = corners.map(point => projectWorldPoint(point, internals.camera)).filter(point => point !== null);
      assert(projected.length === 8, "The full keyboard should fit inside the camera clip planes");
      const left = Math.min(...projected.map(point => point!.x));
      const right = Math.max(...projected.map(point => point!.x));
      const top = Math.min(...projected.map(point => point!.y));
      const bottom = Math.max(...projected.map(point => point!.y));
      return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        insideViewport: left >= 0 && top >= 0 && right <= width && bottom <= height,
      };
    },
    setAppearance(appearance) {
      scene.setStageAppearance(appearance);
      scene.update(currentTime);
      return scene.getStageDiagnostics() as StageDiagnostics;
    },
    setView(view) {
      if (view === "room") {
        internals.camera.position.set(42, 38, 64);
        internals.camera.fov = 42;
        internals.camera.lookAt(0, -7, -14);
        internals.camera.updateProjectionMatrix();
        internals.camera.updateMatrixWorld(true);
        scene.update(currentTime);
      } else if (view !== "overview") {
        scene.setCameraPreset(view as Camera3DPreset);
      } else {
        const diagnostics = scene.getStageDiagnostics() as StageDiagnostics;
        const targetY = diagnostics.floorY + diagnostics.radius * 0.12;
        const distance = Math.max(65, diagnostics.radius * 1.8);
        internals.camera.position.set(0, targetY + distance * 0.82, floorCenterZ + distance * 0.57);
        internals.camera.fov = 62;
        internals.camera.far = Math.max(320, diagnostics.radius * 4);
        internals.camera.lookAt(0, targetY, floorCenterZ);
        internals.camera.updateProjectionMatrix();
        internals.camera.updateMatrixWorld(true);
        currentTime = 0.35;
        scene.update(currentTime);
      }
    },
    capture(name, timeSeconds) {
      currentTime = timeSeconds;
      scene.update(timeSeconds);
      sampleContext.clearRect(0, 0, width, height);
      sampleContext.drawImage(canvas, 0, 0, width, height);
      const image = sampleContext.getImageData(0, 0, width, height);
      frames.set(name, { width, height, data: new Uint8ClampedArray(image.data) });
      frames.set("current", { width, height, data: new Uint8ClampedArray(image.data) });
      status.textContent = `Rendered real PianoScene3D at ${timeSeconds.toFixed(2)}s`;
    },
    compareFloor(first, second) {
      const a = frames.get(first);
      const b = frames.get(second);
      assert(a && b, `Missing captured frames ${first} or ${second}`);
      const diagnostics = scene.getStageDiagnostics() as StageDiagnostics;
      // Include the foreground below the apron, where the real reflection is
      // visible. A coarse 3-unit grid skipped most of the narrow reflections.
      const probe = Math.min(40, diagnostics.radius * 0.56);
      const step = 1;
      const samples = new Set<number>();
      const floorPoint = new THREE.Vector3();
      for (let x = -probe; x <= probe; x += step) {
        for (let z = floorCenterZ - probe; z <= floorCenterZ + probe; z += step) {
          if (Math.hypot(x, z - floorCenterZ) >= diagnostics.radius * 0.62) continue;
          floorPoint.set(x, diagnostics.floorY + 0.01, z);
          const screen = projectWorldPoint(floorPoint, internals.camera);
          if (!screen) continue;
          const px = Math.round(screen.x);
          const py = Math.round(screen.y);
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          ndc.set((screen.x / width) * 2 - 1, 1 - (screen.y / height) * 2);
          raycaster.setFromCamera(ndc, internals.camera);
          const firstHit = raycaster.intersectObjects(internals.scene.children, true)[0]?.object;
          if (firstHit?.name === "piano-concert-stage-floor" || firstHit?.name === "piano-concert-stage-reflection") {
            samples.add((py * width + px) * 4);
          }
        }
      }

      let changedSamples = 0;
      let totalChannelDelta = 0;
      let maxChannelDelta = 0;
      for (const offset of samples) {
        const delta = Math.abs(a.data[offset]! - b.data[offset]!) +
          Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) +
          Math.abs(a.data[offset + 2]! - b.data[offset + 2]!);
        totalChannelDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        // Six summed 8-bit RGB levels distinguish subtle dark-floor changes
        // without requiring a bright reflection at every sampled world point.
        if (delta > 6) changedSamples += 1;
      }
      return { samples: samples.size, changedSamples, totalChannelDelta, maxChannelDelta };
    },
    compareFadeEdge() {
      const frame = frames.get("overview");
      assert(frame, "Missing wide stage overview frame");
      const diagnostics = scene.getStageDiagnostics() as StageDiagnostics;
      const radius = diagnostics.radius;
      const floorPoint = new THREE.Vector3();
      let validPairs = 0;
      let totalDelta = 0;
      let maxChannelDelta = 0;
      for (let index = 0; index < 96; index += 1) {
        const angle = (index / 96) * Math.PI * 2;
        floorPoint.set(Math.cos(angle) * radius * 0.975, diagnostics.floorY + 0.01, floorCenterZ + Math.sin(angle) * radius * 0.975);
        const insideScreen = projectWorldPoint(floorPoint, internals.camera);
        floorPoint.set(Math.cos(angle) * radius * 1.025, diagnostics.floorY + 0.01, floorCenterZ + Math.sin(angle) * radius * 1.025);
        const outsideScreen = projectWorldPoint(floorPoint, internals.camera);
        if (!insideScreen || !outsideScreen) continue;
        const inside = averagePixel(frame, insideScreen.x, insideScreen.y);
        const outside = averagePixel(frame, outsideScreen.x, outsideScreen.y);
        if (!inside || !outside) continue;
        const delta = channelDelta(inside, outside);
        totalDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        validPairs += 1;
      }
      return { validPairs, averageChannelDelta: validPairs ? totalDelta / validPairs : 0, maxChannelDelta };
    },
    setAtmosphereVisible(visible) {
      const atmosphere = internals.scene.getObjectByName("piano-stage-atmosphere");
      if (!atmosphere) return false;
      atmosphere.visible = visible;
      scene.update(currentTime);
      return true;
    },
    compareScreen(first, second, region) {
      const a = frames.get(first);
      const b = frames.get(second);
      assert(a && b, `Missing captured frames ${first} or ${second}`);
      let samples = 0;
      let changedSamples = 0;
      let totalChannelDelta = 0;
      let maxChannelDelta = 0;
      const startY = region === "floor" ? Math.round(height * 0.58) : 0;
      const endY = region === "sky" ? Math.round(height * 0.38) : height;
      for (let y = startY; y < endY; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const offset = (y * width + x) * 4;
          const delta = Math.abs(a.data[offset]! - b.data[offset]!) +
            Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) +
            Math.abs(a.data[offset + 2]! - b.data[offset + 2]!);
          samples += 1;
          totalChannelDelta += delta;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          if (delta > 6) changedSamples += 1;
        }
      }
      return { samples, changedSamples, totalChannelDelta, maxChannelDelta };
    },
    glowSnapshot() {
      return internals.fallingNotes3D.getGlowSnapshot();
    },
    setNoteFixture(kind) {
      if (kind === "default") scene.setNotes(notes);
      else if (kind === "edge") scene.setNotes([{ ...notes[3]!, noteId: "edge-note", pitch: 108, startSeconds: 0.1, endSeconds: 30 }]);
      else scene.setNotes([60, 61, 62, 63, 64, 65].map((pitch, index) => ({
        ...notes[index < 3 ? 0 : 3]!, noteId: `chord-${pitch}`, pitch, startSeconds: 0.1, endSeconds: 1.2,
      })));
      scene.update(currentTime);
    },
    setGlowVisible(visible) {
      const glow = internals.scene.getObjectByName("active-note-glow");
      if (!glow) return false;
      glow.visible = visible;
      scene.update(currentTime);
      return true;
    },
    setDeckFinish(finish) {
      deck.material = finish === "legacy" ? legacyDeckMaterial : currentDeckMaterial;
      scene.update(currentTime);
    },
    compareDeck(first, second) {
      const a = frames.get(first);
      const b = frames.get(second);
      assert(a && b, "Missing note surface comparison frames");
      const offsets = new Set<number>();
      for (let x = -22; x <= 22; x += 0.5) {
        for (let z = -8; z >= -39; z -= 0.5) {
          const screen = projectWorldPoint(new THREE.Vector3(x, -0.015, z), internals.camera);
          if (!screen) continue;
          const px = Math.round(screen.x), py = Math.round(screen.y);
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          ndc.set((screen.x / width) * 2 - 1, 1 - (screen.y / height) * 2);
          raycaster.setFromCamera(ndc, internals.camera);
          if (raycaster.intersectObjects(internals.scene.children, true)[0]?.object === deck) offsets.add((py * width + px) * 4);
        }
      }
      // Instanced note pixels can still overlay a raycast deck probe. Only the
      // deck finish changes between frames, so identical pixels (including the
      // bright notes) must not inflate the surface highlight measurement.
      const changedOffsets = [...offsets].filter(offset =>
        Math.abs(a.data[offset]! - b.data[offset]!) + Math.abs(a.data[offset + 1]! - b.data[offset + 1]!) + Math.abs(a.data[offset + 2]! - b.data[offset + 2]!) > 3);
      function stats(frame: Frame) {
        const luminances = changedOffsets.map(offset => frame.data[offset]! * 0.2126 + frame.data[offset + 1]! * 0.7152 + frame.data[offset + 2]! * 0.0722).sort((x, y) => x - y);
        return { peak: luminances.at(-1) ?? 0, p99: luminances[Math.floor(luminances.length * 0.99)] ?? 0, bright: luminances.filter(value => value >= 120).length };
      }
      return { samples: offsets.size, changedDeckSamples: changedOffsets.length, before: stats(a), after: stats(b) };
    },
    dispose() {
      deck.material = currentDeckMaterial;
      legacyDeckMaterial.dispose();
      scene.destroy();
    },
  };

  status.textContent = "Ready: real WebGL PianoScene3D, keyboard, notes, and stage floor";
}

void initialize().catch((error: unknown) => {
  window.__stageEnvironmentError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  status.textContent = `FAIL: ${window.__stageEnvironmentError}`;
});
