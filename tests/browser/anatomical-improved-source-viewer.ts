import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

type HandId = "left" | "right";
type LodManifest = { level: number; url: string };
type TextureSet = {
  baseColor: string;
  normal: string;
  roughness: string;
  flipY: false;
  baseColorColorSpace: "srgb";
  normalColorSpace: "linear";
  roughnessColorSpace: "linear";
};
type ModelManifest = {
  hands: Record<HandId, { lods: LodManifest[] }>;
  textures: { high: TextureSet };
};

type ViewerResult = {
  status: "ready" | "error";
  sourceMode: "manifest-lod0" | "draft-lod1" | "texture-compare-lod0";
  assetUrls: string[];
  hands: Record<HandId, { weightedVertices: number; skeletonBones: number; triangleCount: number }>;
  textureComparison?: { reference: TextureSet; candidateBase: string };
  error?: string;
};

const categoryColors: Record<string, THREE.Color> = {
  thumb: new THREE.Color("#e66159"),
  index: new THREE.Color("#efb648"),
  middle: new THREE.Color("#70bf73"),
  ring: new THREE.Color("#5998e8"),
  pinky: new THREE.Color("#aa75da"),
  palm: new THREE.Color("#d0d3d3"),
  other: new THREE.Color("#555b63"),
};

function boneCategory(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("thumb")) return "thumb";
  if (normalized.includes("index")) return "index";
  if (normalized.includes("middle")) return "middle";
  if (normalized.includes("ring")) return "ring";
  if (normalized.includes("pinky") || normalized.includes("little")) return "pinky";
  if (normalized.includes("palm") || normalized.includes("wrist")) return "palm";
  return "other";
}

function setClay(root: THREE.Object3D): void {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = new THREE.MeshStandardMaterial({ color: "#b8b6ae", roughness: 0.88, metalness: 0 });
  });
}

function setWeights(root: THREE.Object3D): { weightedVertices: number; skeletonBones: number } {
  let weightedVertices = 0;
  let skeletonBones = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    skeletonBones = Math.max(skeletonBones, object.skeleton.bones.length);
    const geometry = object.geometry.clone();
    const skinIndices = geometry.getAttribute("skinIndex");
    const skinWeights = geometry.getAttribute("skinWeight");
    if (!skinIndices || !skinWeights) return;
    const colors = new Float32Array(geometry.attributes.position!.count * 3);
    for (let vertex = 0; vertex < geometry.attributes.position!.count; vertex++) {
      let bestWeight = 0;
      let bestBone = -1;
      for (let influence = 0; influence < 4; influence++) {
        const weight = skinWeights.getComponent(vertex, influence);
        if (weight > bestWeight) {
          bestWeight = weight;
          bestBone = skinIndices.getComponent(vertex, influence);
        }
      }
      if (bestWeight > 0) weightedVertices++;
      const category = bestBone >= 0 ? boneCategory(object.skeleton.bones[bestBone]?.name ?? "") : "other";
      const color = categoryColors[category] ?? categoryColors.other!;
      colors[vertex * 3] = color.r;
      colors[vertex * 3 + 1] = color.g;
      colors[vertex * 3 + 2] = color.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    object.geometry = geometry;
    object.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  });
  return { weightedVertices, skeletonBones };
}

function inspectWeights(root: THREE.Object3D): { weightedVertices: number; skeletonBones: number } {
  let weightedVertices = 0;
  let skeletonBones = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    skeletonBones = Math.max(skeletonBones, object.skeleton.bones.length);
    const weights = object.geometry.getAttribute("skinWeight");
    if (!weights) return;
    for (let vertex = 0; vertex < weights.count; vertex++) {
      if (weights.getComponent(vertex, 0) + weights.getComponent(vertex, 1) +
          weights.getComponent(vertex, 2) + weights.getComponent(vertex, 3) > 0) weightedVertices++;
    }
  });
  return { weightedVertices, skeletonBones };
}

function addSkeleton(root: THREE.Object3D, scene: THREE.Scene): number {
  let boneCount = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    boneCount = Math.max(boneCount, object.skeleton.bones.length);
    const helper = new THREE.SkeletonHelper(object);
    helper.material = new THREE.LineBasicMaterial({ color: "#fff5be", depthTest: false, depthWrite: false });
    helper.renderOrder = 1000;
    scene.add(helper);
  });
  return boneCount;
}

async function loadGlb(url: string): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  return (await loader.loadAsync(url)).scene;
}

function cloneMaterials(root: THREE.Object3D): void {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(material => material.clone())
      : object.material.clone();
  });
}

async function applyTextureSet(root: THREE.Object3D, base: string, descriptor: TextureSet): Promise<void> {
  const loader = new THREE.TextureLoader();
  const [baseColor, normal, roughness] = await Promise.all([
    loader.loadAsync(`${base}${descriptor.baseColor}`),
    loader.loadAsync(`${base}${descriptor.normal}`),
    loader.loadAsync(`${base}${descriptor.roughness}`),
  ]);
  baseColor.flipY = descriptor.flipY;
  baseColor.colorSpace = THREE.SRGBColorSpace;
  normal.flipY = descriptor.flipY;
  normal.colorSpace = THREE.NoColorSpace;
  roughness.flipY = descriptor.flipY;
  roughness.colorSpace = THREE.NoColorSpace;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.map = baseColor;
      material.normalMap = normal;
      material.roughnessMap = roughness;
      material.needsUpdate = true;
    }
  });
}

function getWristToMiddleTipAxis(root: THREE.Object3D): THREE.Vector3 {
  const bones: THREE.Bone[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Bone) bones.push(object);
  });
  const wrist = bones.find(bone => bone.name.toLowerCase().includes("wrist"));
  const middleTip = bones.find(bone => bone.name.toLowerCase().includes("middle-finger-tip"));
  if (!wrist || !middleTip) throw new Error("Rest viewer requires wrist and middle-finger-tip bones.");
  root.updateMatrixWorld(true);
  const from = wrist.getWorldPosition(new THREE.Vector3());
  const to = middleTip.getWorldPosition(new THREE.Vector3());
  const axis = to.sub(from);
  if (axis.lengthSq() < 1e-8) throw new Error("Wrist-to-middle-tip camera axis has zero length.");
  return axis.normalize();
}

function fitCamera(root: THREE.Object3D, camera: THREE.OrthographicCamera, hand: HandId): void {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const dorsal = new THREE.Vector3(hand === "left" ? -1 : 1, 0, 0);
  const center = bounds.getCenter(new THREE.Vector3()).addScaledVector(dorsal, 0.3);
  const size = bounds.getSize(new THREE.Vector3());
  const distance = Math.max(size.length() * 1.5, 0.8);
  camera.up.copy(getWristToMiddleTipAxis(root));
  camera.position.copy(center).addScaledVector(dorsal, distance);
  camera.lookAt(center);
  camera.near = 0.001;
  camera.far = distance + size.length() * 3;
  camera.updateMatrixWorld(true);

  let halfWidth = 0;
  let halfHeight = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        halfWidth = Math.max(halfWidth, Math.abs(point.x));
        halfHeight = Math.max(halfHeight, Math.abs(point.y));
      }
    }
  }
  const padding = 1.12;
  camera.left = -halfWidth * padding;
  camera.right = halfWidth * padding;
  camera.top = halfHeight * padding;
  camera.bottom = -halfHeight * padding;
  camera.updateProjectionMatrix();
}

async function renderSourceViews(): Promise<ViewerResult> {
  const search = new URLSearchParams(location.search);
  const base = search.get("assetBase") ?? "/models/hands/improved/";
  const candidateTextureBase = search.get("candidateTextureBase");
  const compareTextures = search.get("compareTextures") === "1";
  const canvas = document.querySelector<HTMLCanvasElement>("#source-viewer-canvas");
  if (!canvas) throw new Error("Source viewer canvas is missing.");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(1);
  const columns = compareTextures ? 2 : 3;
  const cellSize = compareTextures ? 640 : 480;
  const canvasWidth = columns * cellSize;
  const canvasHeight = 2 * cellSize;
  renderer.setSize(canvasWidth, canvasHeight, false);
  renderer.setClearColor("#171a1e", 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const draftLod1 = search.get("draft") === "lod1";
  if (compareTextures && (!candidateTextureBase || draftLod1)) {
    throw new Error("Texture comparison requires final LOD0 assets and a frozen candidate texture directory.");
  }
  const assetUrls: string[] = [];
  let sourceUrls: Record<HandId, string>;
  let manifest: ModelManifest | null = null;
  if (draftLod1) {
    sourceUrls = {
      left: `${base}left-lod1.glb`,
      right: `${base}right-lod1.glb`,
    };
  } else {
    const manifestResponse = await fetch(`${base}manifest.json`);
    if (!manifestResponse.ok) throw new Error(`Improved hand manifest request failed: ${manifestResponse.status}`);
    manifest = await manifestResponse.json() as ModelManifest;
    assetUrls.push(`${base}manifest.json`);
    sourceUrls = {
      left: `${base}${manifest.hands.left.lods.find(lod => lod.level === 0)!.url}`,
      right: `${base}${manifest.hands.right.lods.find(lod => lod.level === 0)!.url}`,
    };
  }
  const sourceScenes: Record<HandId, THREE.Group> = {
    left: await loadGlb(sourceUrls.left),
    right: await loadGlb(sourceUrls.right),
  };
  const hands: ViewerResult["hands"] = {
    left: { weightedVertices: 0, skeletonBones: 0, triangleCount: 0 },
    right: { weightedVertices: 0, skeletonBones: 0, triangleCount: 0 },
  };
  const modes = compareTextures
    ? ["Reference", "Candidate"] as const
    : ["Textured", "Clay", "Weights + skeleton"] as const;
  const scenes: THREE.Scene[] = [];
  const cameras: THREE.OrthographicCamera[] = [];

  for (const handId of ["left", "right"] as const) {
    for (const mode of modes) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#171a1e");
      scene.add(new THREE.HemisphereLight("#fff9eb", "#373b45", 2.4));
      const key = new THREE.DirectionalLight("#ffffff", 2.5);
      key.position.set(handId === "left" ? -4 : 4, 3, 1.5);
      scene.add(key);
      const fill = new THREE.DirectionalLight("#dce8ff", 0.8);
      fill.position.set(handId === "left" ? -2 : 2, -2, -3);
      scene.add(fill);
      const root = cloneSkeleton(sourceScenes[handId]);
      let weightInfo = { weightedVertices: 0, skeletonBones: 0 };
      if (compareTextures) {
        weightInfo = inspectWeights(root);
        cloneMaterials(root);
        await applyTextureSet(
          root,
          mode === "Reference" ? base : candidateTextureBase!,
          manifest!.textures.high,
        );
      } else if (mode === "Clay") setClay(root);
      if (mode === "Weights + skeleton") {
        weightInfo = setWeights(root);
        addSkeleton(root, scene);
      }
      let triangleCount = 0;
      root.traverse(object => {
        if (object instanceof THREE.Mesh) {
          const position = object.geometry.getAttribute("position");
          const index = object.geometry.index;
          triangleCount += Math.floor((index?.count ?? position?.count ?? 0) / 3);
        }
      });
      if (mode === "Weights + skeleton" || mode === "Reference") {
        hands[handId] = { ...weightInfo, triangleCount };
      }
      scene.add(root);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
      fitCamera(root, camera, handId);
      scenes.push(scene);
      cameras.push(camera);
    }
  }

  const draw = () => {
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);
    const cellWidth = cellSize;
    const cellHeight = cellSize;
    for (let index = 0; index < scenes.length; index++) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth;
      const y = row * cellHeight;
      renderer.setViewport(x, canvasHeight - y - cellHeight, cellWidth, cellHeight);
      renderer.setScissor(x, canvasHeight - y - cellHeight, cellWidth, cellHeight);
      renderer.clear(true, true, true);
      renderer.render(scenes[index]!, cameras[index]!);
    }
    renderer.setScissorTest(false);
  };
  draw();
  const assetRequestList = performance.getEntriesByType("resource")
    .map(entry => entry.name)
    .filter(url => url.includes("/models/hands/improved/") || url.includes("/frozen-optimized-textures/"));
  assetUrls.push(...new Set(assetRequestList));
  renderer.dispose();
  return {
    status: "ready",
    sourceMode: compareTextures ? "texture-compare-lod0" : draftLod1 ? "draft-lod1" : "manifest-lod0",
    assetUrls,
    hands,
    ...(compareTextures ? { textureComparison: { reference: manifest!.textures.high, candidateBase: candidateTextureBase! } } : {}),
  };
}

void renderSourceViews()
  .then(result => { (window as Window & { __anatomicalSourceViewerResult?: ViewerResult }).__anatomicalSourceViewerResult = result; })
  .catch(error => {
    (window as Window & { __anatomicalSourceViewerResult?: ViewerResult }).__anatomicalSourceViewerResult = {
      status: "error",
      sourceMode: "manifest-lod0",
      assetUrls: [],
      hands: {
        left: { weightedVertices: 0, skeletonBones: 0, triangleCount: 0 },
        right: { weightedVertices: 0, skeletonBones: 0, triangleCount: 0 },
      },
      error: error instanceof Error ? error.message : String(error),
    };
  });
