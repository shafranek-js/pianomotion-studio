import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FallingNotes3DView } from "../../../apps/client/src/render3d/fallingNotes3dView";
import { Keyboard3DView } from "../../../apps/client/src/render3d/keyboard3dView";
import { PianoScene3D, type Camera3DPreset } from "../../../apps/client/src/render3d/pianoScene3d";
import type { Note } from "../../../packages/contracts/src/index";

declare global {
  interface Window {
    __grandHighway?: {
      evidence: {
        deckFound: boolean;
        rearCavityHits: number;
        outsideRightRimHits: number;
        noteCount: number;
        centerNoteLength: number | null;
        trebleNoteLength: number | null;
        centerFrontZ: number | null;
        trebleFrontZ: number | null;
        leftCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
        rightCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
      };
      renderPreset: (preset: Camera3DPreset) => void;
      renderCheekDetail: (side: "left" | "right") => void;
      renderBrandingDetail: () => { found: boolean; lines: string[]; position: number[]; goldPixels: number };
      renderCheekCloseup: () => {
        leftCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
        rightCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
      };
      dispose: () => void;
    };
    __grandHighwayError?: string;
  }
}

const status = document.querySelector<HTMLPreElement>("#status")!;

function makeNote(noteId: string, pitch: number): Note {
  return {
    noteId,
    trackId: "grand-highway-acceptance",
    pitch,
    velocity: 92,
    startSeconds: 0,
    endSeconds: 10,
    hand: pitch < 60 ? "left" : "right",
    finger: null,
    glissando: false,
  };
}

function noteExtentByPitch(
  highway: FallingNotes3DView,
  keyboard: Keyboard3DView,
  pitch: number,
): { length: number; frontZ: number } | null {
  const key = keyboard.keysByPitch.get(pitch);
  if (!key) return null;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let index = 0; index < highway.instancedMesh.count; index += 1) {
    highway.instancedMesh.getMatrixAt(index, matrix);
    matrix.decompose(position, rotation, scale);
    if (Math.abs(position.x - key.centerX) < 0.01) {
      return { length: scale.z, frontZ: position.z + scale.z * 0.5 };
    }
  }
  return null;
}

function rayHits(mesh: THREE.Mesh, x: number, z: number): number {
  mesh.updateWorldMatrix(true, false);
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, 5, z),
    new THREE.Vector3(0, -1, 0),
    0,
    10,
  );
  return raycaster.intersectObject(mesh, false).length;
}

function cheekGeometryEvidence(keyboard: Keyboard3DView, name: string) {
  const object = keyboard.group.getObjectByName(name);
  if (!(object instanceof THREE.Mesh)) {
    return { found: false, vertexCount: 0, finiteUnitNormals: false };
  }

  const position = object.geometry.getAttribute("position");
  const normal = object.geometry.getAttribute("normal");
  if (!position || !normal || position.count !== normal.count) {
    return { found: true, vertexCount: position?.count ?? 0, finiteUnitNormals: false };
  }

  const vector = new THREE.Vector3();
  let finiteUnitNormals = true;
  for (let index = 0; index < normal.count; index += 1) {
    vector.fromBufferAttribute(normal, index);
    if (
      !Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z) ||
      Math.abs(vector.length() - 1) > 0.02
    ) {
      finiteUnitNormals = false;
      break;
    }
  }
  return { found: true, vertexCount: position.count, finiteUnitNormals };
}

function makeVisualNotes(): Note[] {
  return [
    { ...makeNote("grand-bass", 36), startSeconds: 0.1, endSeconds: 1.8 },
    { ...makeNote("grand-middle", 60), startSeconds: 0.35, endSeconds: 1.65 },
    { ...makeNote("grand-treble", 84), startSeconds: 0.6, endSeconds: 1.9 },
    { ...makeNote("grand-top", 108), startSeconds: 0.85, endSeconds: 1.75 },
  ];
}

async function initialize(): Promise<void> {
  const keyboard = new Keyboard3DView();
  const highway = new FallingNotes3DView(keyboard);
  highway.setNotes([makeNote("center-long", 60), makeNote("treble-long", 108)]);
  highway.update(0);
  highway.group.updateMatrixWorld(true);

  const deck = highway.group.getObjectByName("grand-piano-highway-deck");
  const deckMesh = deck instanceof THREE.Mesh ? deck : null;
  const center = noteExtentByPitch(highway, keyboard, 60);
  const treble = noteExtentByPitch(highway, keyboard, 108);

  const evidence = {
    deckFound: deckMesh !== null,
    // Fixed world points come from the prior grand body's dimensions: the rear point lies
    // inside its tail sweep beyond the former straight highway end at z≈-33.2; the right
    // point lies outside the curved inner wall at this depth while the old rectangle covered it.
    rearCavityHits: deckMesh ? rayHits(deckMesh, -8, -41) : 0,
    outsideRightRimHits: deckMesh ? rayHits(deckMesh, 22, -24) : 0,
    noteCount: highway.instancedMesh.count,
    centerNoteLength: center?.length ?? null,
    trebleNoteLength: treble?.length ?? null,
    centerFrontZ: center?.frontZ ?? null,
    trebleFrontZ: treble?.frontZ ?? null,
    leftCheek: cheekGeometryEvidence(keyboard, "grand-piano-cheek-left"),
    rightCheek: cheekGeometryEvidence(keyboard, "grand-piano-cheek-right"),
  };

  const fullCanvas = document.querySelector<HTMLCanvasElement>("#full-grand-canvas")!;
  const fullScene = new THREE.Scene();
  fullScene.background = new THREE.Color(0x090b10);
  fullScene.add(keyboard.group, highway.group);
  const floorGeometry = new THREE.PlaneGeometry(180, 180);
  floorGeometry.rotateX(-Math.PI * 0.5);
  const floor = new THREE.Mesh(
    floorGeometry,
    new THREE.MeshStandardMaterial({ color: 0x1c1815, roughness: 0.92 }),
  );
  floor.position.y = -20.1;
  floor.receiveShadow = true;
  fullScene.add(floor);
  const ambient = new THREE.HemisphereLight(0xe2e8f0, 0x111015, 0.9);
  ambient.position.set(0, 40, 0);
  fullScene.add(ambient);
  const keyLight = new THREE.DirectionalLight(0xfff5ea, 2.0);
  keyLight.position.set(8, 38, 16);
  fullScene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.5);
  fillLight.position.set(-28, 18, 12);
  fullScene.add(fillLight);
  const cheekKeyLight = new THREE.DirectionalLight(0xfff5ea, 1.15);
  cheekKeyLight.position.set(-32, 24, 12);
  cheekKeyLight.target.position.set(-24, 0, -2);
  fullScene.add(cheekKeyLight, cheekKeyLight.target);
  const cheekFillLight = new THREE.DirectionalLight(0xe2e8f0, 0.55);
  cheekFillLight.position.set(32, 18, 14);
  cheekFillLight.target.position.set(24, 0, -2);
  fullScene.add(cheekFillLight, cheekFillLight.target);
  const fullCamera = new THREE.PerspectiveCamera(45, 1280 / 800, 0.5, 180);
  fullCamera.position.set(0, 34, 30);
  fullCamera.lookAt(0, -7, -20);
  const fullRenderer = new THREE.WebGLRenderer({ canvas: fullCanvas, antialias: true });
  fullRenderer.setPixelRatio(1);
  fullRenderer.setSize(1280, 800);
  fullRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  fullRenderer.toneMappingExposure = 0.96;
  fullRenderer.render(fullScene, fullCamera);

  const pmremGenerator = new THREE.PMREMGenerator(fullRenderer);
  const roomEnvironment = new RoomEnvironment();
  const cheekEnvironment = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
  fullScene.environment = cheekEnvironment;
  fullScene.environmentIntensity = 0.22;
  roomEnvironment.dispose();
  pmremGenerator.dispose();

  const host = document.querySelector<HTMLDivElement>("#preset-scene-host")!;
  const sceneCanvas = document.createElement("canvas");
  sceneCanvas.setAttribute("aria-label", "Fixed viewport grand piano scene");
  host.append(sceneCanvas);
  const scene = new PianoScene3D(host, {
    canvas: sceneCanvas,
    fixedViewport: { width: 1280, height: 720, resolution: 1 },
  });
  scene.setNotes(makeVisualNotes());
  scene.update(0);

  window.__grandHighway = {
    evidence,
    renderPreset(preset) {
      scene.setCameraPreset(preset);
      scene.update(0.05);
      status.textContent = `Rendered fixed 1280×720 Three.js camera: ${preset}`;
    },
    renderCheekCloseup() {
      fullRenderer.setSize(1600, 400);
      fullCamera.aspect = 4;
      fullCamera.fov = 32;
      fullCamera.position.set(0, 18, 15);
      fullCamera.lookAt(0, 0, -2.3);
      fullCamera.updateProjectionMatrix();
      fullRenderer.render(fullScene, fullCamera);
      status.textContent = "Rendered deterministic 1600×400 two-cheek close-up";
      return {
        leftCheek: evidence.leftCheek,
        rightCheek: evidence.rightCheek,
      };
    },
    renderCheekDetail(side) {
      const sign = side === "left" ? -1 : 1;
      fullRenderer.setSize(800, 800);
      fullCamera.aspect = 1;
      fullCamera.fov = 38;
      fullCamera.position.set(sign * 28, 5, 6);
      fullCamera.lookAt(sign * 24.8, -0.7, -2.5);
      fullCamera.updateProjectionMatrix();
      fullRenderer.render(fullScene, fullCamera);
      status.textContent = `Rendered ${side} curved cheek detail`;
    },
    renderBrandingDetail() {
      fullRenderer.setSize(1280, 640);
      fullCamera.aspect = 2;
      fullCamera.fov = 30;
      fullCamera.position.set(0, 0, 18);
      fullCamera.lookAt(0, -3.1, 0.95);
      fullCamera.updateProjectionMatrix();
      fullRenderer.render(fullScene, fullCamera);
      const branding = keyboard.group.getObjectByName("grand-piano-branding");
      const copy = document.createElement("canvas");
      copy.width = fullCanvas.width;
      copy.height = fullCanvas.height;
      const context = copy.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(fullCanvas, 0, 0);
      const pixels = context.getImageData(256, 190, 768, 260).data;
      let goldPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (r > 65 && g > 50 && r > g * 1.05 && g > b * 1.25) goldPixels++;
      }
      status.textContent = "Rendered gold lettering on the front apron";
      return {
        found: Boolean(branding),
        lines: branding?.userData.brandingLines ?? [],
        position: branding?.getWorldPosition(new THREE.Vector3()).toArray() ?? [],
        goldPixels,
      };
    },
    dispose() {
      scene.destroy();
      fullRenderer.dispose();
      cheekEnvironment.dispose();
      floorGeometry.dispose();
      (floor.material as THREE.Material).dispose();
      highway.dispose();
      keyboard.dispose();
    },
  };
  status.textContent = "Ready: real Three.js geometry and fixed viewport scene";
}

void initialize().catch((error: unknown) => {
  window.__grandHighwayError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  status.textContent = `FAIL: ${window.__grandHighwayError}`;
});
