import * as THREE from "three";

export const PIANO_BRANDING_LINES = ["PIANOMOTION", "CONCERT GRAND"] as const;

const CANVAS_WIDTH = 2048;
const CANVAS_HEIGHT = 512;
const BRANDING_WIDTH_IN = 13.2;
const BRANDING_HEIGHT_IN = 3.3;
const APRON_CENTER_Y = (-6.2 - 0.72) * 0.5;

function trackedWidth(
  context: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number {
  return (
    Array.from(text).reduce((sum, letter) => sum + context.measureText(letter).width, 0) +
    Math.max(0, Array.from(text).length - 1) * letterSpacing
  );
}

function fillTrackedText(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  letterSpacing: number,
): void {
  const letters = Array.from(text);
  let x = centerX - trackedWidth(context, text, letterSpacing) * 0.5;
  for (const letter of letters) {
    context.fillText(letter, x, y);
    x += context.measureText(letter).width + letterSpacing;
  }
}

/** Builds discreet gold lettering for the grand's front apron when canvas is available. */
export function createPianoBrandingMesh(frontFaceZ: number): THREE.Mesh | null {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "middle";

  const titleFont = '600 260px Georgia, "Times New Roman", serif';
  context.font = titleFont;
  const titleWidth = trackedWidth(context, PIANO_BRANDING_LINES[0], 10);
  if (titleWidth > CANVAS_WIDTH * 0.9) {
    const fittedSize = (260 * CANVAS_WIDTH * 0.9) / titleWidth;
    context.font = `600 ${fittedSize}px Georgia, "Times New Roman", serif`;
  }
  fillTrackedText(context, PIANO_BRANDING_LINES[0], CANVAS_WIDTH * 0.5, 180, 10);
  context.font = '600 104px Georgia, "Times New Roman", serif';
  fillTrackedText(context, PIANO_BRANDING_LINES[1], CANVAS_WIDTH * 0.5, 354, 10);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xe0bb61,
    map: texture,
    metalness: 0.72,
    roughness: 0.28,
    clearcoat: 0.38,
    clearcoatRoughness: 0.22,
    envMapIntensity: 0.8,
    emissive: 0x2b1c08,
    emissiveIntensity: 0.12,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BRANDING_WIDTH_IN, BRANDING_HEIGHT_IN),
    material,
  );
  mesh.name = "grand-piano-branding";
  mesh.userData.brandingLines = [...PIANO_BRANDING_LINES];
  mesh.position.set(0, APRON_CENTER_Y, frontFaceZ + 0.002);
  return mesh;
}
