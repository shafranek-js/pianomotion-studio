import * as THREE from "three";
import {
  HIGHEST_PIANO_KEY,
  isBlackKey,
  LOWEST_PIANO_KEY,
  type KeyPressInfo,
} from "../render/keyboardView";
import { KEYBOARD_WIDTH_IN, WHITE_KEY_WIDTH_IN } from "./handRigBuilder";
import { createPianoCaseGeometry } from "./pianoCaseGeometry";
import { createPianoBrandingMesh } from "./pianoBranding3d";
import {
  GRAND_PIANO_FRONT_DEPTH_IN,
  GRAND_PIANO_HALF_WIDTH_IN,
  GRAND_PIANO_INTERIOR_CONTOUR,
  GRAND_PIANO_KEY_LENGTH_FACTOR,
  GRAND_PIANO_TAIL_DEPTH_IN,
  createGrandPianoInteriorShape,
} from "./grandPianoFootprint";

export const KEY_LEN_WW_3D = GRAND_PIANO_KEY_LENGTH_FACTOR;
export const WHITE_KEY_LEN_IN = KEY_LEN_WW_3D * WHITE_KEY_WIDTH_IN; // ~5.2 in
export const BLACK_KEY_W_IN = WHITE_KEY_WIDTH_IN * 0.58;
export const BLACK_KEY_LEN_IN = WHITE_KEY_LEN_IN * 0.635;
export const WHITE_KEY_HEIGHT_IN = 0.72;
export const BLACK_KEY_HEIGHT_IN = 0.46;

const BLACK_OFFSETS: Record<number, number> = {
  1: -0.12,
  3: 0.12,
  6: -0.14,
  8: 0.0,
  10: 0.14,
};

export interface Key3DMeshEntry {
  pitch: number;
  isBlack: boolean;
  pivotGroup: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  centerX: number;
  width: number;
  length: number;
}

/** Releases GPU resources created for a scene-owned object graph exactly once. */
export function disposeOwnedThreeResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (!renderable.material) return;

    for (const material of Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  root.clear();
}

/**
 * Builds an authentic 3D tapered ebony black key geometry:
 * - Wider at base (BLACK_KEY_W_IN), narrower at top playing surface (80% width)
 * - Slanted front nose (~20 deg bevel at front lip)
 * - Local origin (0,0,0) is at the rear balance pin (z_world = -WHITE_KEY_LEN_IN)
 */
/**
 * Builds an authentic solid beveled ebony black piano key:
 * - Tapered flanks (wider at base, narrower at playing surface)
 * - Gently slanted front nose with rounded front-left and front-right vertical corners
 * - Smoothly rounded fillet transition across the top-front nose crest
 * - Soft beveled/chamfered top playing surface edges catching natural studio glints
 * - Outward-facing normals everywhere, satisfying star-convex test bounds
 * - Local origin (0, 0, 0) is at the rear balance pin (z_world = -WHITE_KEY_LEN_IN)
 */
function createTaperedBlackKeyGeometry(): THREE.BufferGeometry {
  const wBot = BLACK_KEY_W_IN * 0.5;
  const wTop = BLACK_KEY_W_IN * 0.395;
  const h = BLACK_KEY_HEIGHT_IN;
  const lenBot = BLACK_KEY_LEN_IN;
  const lenTop = BLACK_KEY_LEN_IN - 0.28;

  const bevelY = 0.036; // height of top rounded rim
  const bevelX = 0.020; // inward side bevel
  const bevelZ = 0.046; // front nose rounding curve
  const cornerR = 0.038; // front vertical corner rounding

  interface RingParam {
    y: number;
    w: number;
    len: number;
    rCorner: number;
  }

  const rings: RingParam[] = [];

  // Main tapered body slices
  const yCrest = h - bevelY;
  const bodyLevels = [0, 0.5, 1.0];
  for (const t of bodyLevels) {
    const y = yCrest * t;
    const w = wBot + (wTop - wBot) * t;
    const len = lenBot + (lenTop + bevelZ * 0.5 - lenBot) * t;
    rings.push({ y, w, len, rCorner: cornerR });
  }

  // Top bevel fillet slices (quarter circle from phi = 0 to pi/2)
  const filletSteps = 3;
  for (let s = 1; s <= filletSteps; s++) {
    const phi = (Math.PI * 0.5) * (s / filletSteps);
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    const y = yCrest + bevelY * sinP;
    const w = wTop - bevelX * (1 - cosP);
    const len = (lenTop + bevelZ * 0.5) - (bevelZ * 1.5) * (1 - cosP);
    const rCorner = Math.max(0.016, cornerR - bevelX * 0.5 * (1 - cosP));
    rings.push({ y, w, len, rCorner });
  }

  function getPerimeter(param: RingParam): Array<[number, number, number]> {
    const { y, w, len, rCorner: r } = param;
    const pts: Array<[number, number, number]> = [];

    // Rear-left (0)
    pts.push([-w, y, 0]);
    // Left flank (1)
    pts.push([-w, y, len - r]);

    // Front-left rounded corner (arc from 180 deg to 90 deg) (2, 3, 4)
    const arcAnglesLeft = [
      Math.PI - Math.PI / 8,
      Math.PI - Math.PI / 4,
      Math.PI - (3 * Math.PI) / 8,
    ];
    for (const ang of arcAnglesLeft) {
      pts.push([-w + r + r * Math.cos(ang), y, len - r + r * Math.sin(ang)]);
    }
    // Front lip left (5)
    pts.push([-w + r, y, len]);
    // Front lip right (6)
    pts.push([w - r, y, len]);

    // Front-right rounded corner (arc from 90 deg to 0 deg) (7, 8, 9)
    const arcAnglesRight = [
      (3 * Math.PI) / 8,
      Math.PI / 4,
      Math.PI / 8,
    ];
    for (const ang of arcAnglesRight) {
      pts.push([w - r + r * Math.cos(ang), y, len - r + r * Math.sin(ang)]);
    }
    // Right flank (10)
    pts.push([w, y, len - r]);
    // Rear-right (11)
    pts.push([w, y, 0]);

    return pts;
  }

  const ringVerts = rings.map(getPerimeter);
  const numPts = ringVerts[0]!.length; // 12 points

  const positions: number[] = [];
  const indices: number[] = [];

  // 1. Shell quads connecting adjacent rings (shared vertices within the shell for smooth normals)
  // Vertex layout: ring r point p is at index (r * numPts + p)
  for (let r = 0; r < ringVerts.length; r++) {
    for (let p = 0; p < numPts; p++) {
      positions.push(...ringVerts[r]![p]!);
    }
  }

  for (let r = 0; r < ringVerts.length - 1; r++) {
    const rowCurr = r * numPts;
    const rowNext = (r + 1) * numPts;
    for (let p = 0; p < numPts - 1; p++) {
      const p0 = rowCurr + p;
      const p1 = rowCurr + p + 1;
      const q1 = rowNext + p + 1;
      const q0 = rowNext + p;
      indices.push(p0, p1, q1);
      indices.push(p0, q1, q0);
    }
  }

  // 2. Rear face: flat vertical quads at z = 0 connecting rear-right and rear-left
  for (let r = 0; r < ringVerts.length - 1; r++) {
    const rCurr = ringVerts[r]!;
    const rNext = ringVerts[r + 1]!;
    const v0 = positions.length / 3;
    positions.push(...rCurr[numPts - 1]!, ...rCurr[0]!, ...rNext[0]!, ...rNext[numPts - 1]!);
    indices.push(v0, v0 + 1, v0 + 2);
    indices.push(v0, v0 + 2, v0 + 3);
  }

  // 3. Bottom face: flat cap at y = 0 facing downward (-Y)
  const rBot = ringVerts[0]!;
  const vBotCenter = positions.length / 3;
  positions.push(0, 0, lenBot * 0.5);
  for (let p = 0; p < numPts; p++) {
    const pNext = (p + 1) % numPts;
    const v0 = positions.length / 3;
    positions.push(...rBot[p]!, ...rBot[pNext]!);
    indices.push(vBotCenter, v0 + 1, v0);
  }

  // 4. Top playing surface: flat cap at y = h facing upward (+Y)
  const rTop = ringVerts[ringVerts.length - 1]!;
  const vTopCenter = positions.length / 3;
  const topLen = rings[rings.length - 1]!.len;
  positions.push(0, h, topLen * 0.5);
  for (let p = 0; p < numPts; p++) {
    const pNext = (p + 1) % numPts;
    const v0 = positions.length / 3;
    positions.push(...rTop[p]!, ...rTop[pNext]!);
    indices.push(vTopCenter, v0, v0 + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds an authentic solid beveled ivorite white piano key:
 * - Single continuous solid mesh across full height (WHITE_KEY_HEIGHT_IN)
 * - Rounded front-left and front-right vertical corners
 * - Soft beveled top perimeter catching natural studio highlights
 * - Solid ivory white side flanks (no black gaps/voids when neighboring keys are pressed)
 * - Local origin (0, 0, 0) is at the rear balance pin (z_world = -WHITE_KEY_LEN_IN)
 */
function createSolidWhiteKeyGeometry(width: number, length: number): THREE.BufferGeometry {
  const bevel = 0.022;
  const cornerR = 0.042;
  const hw = width * 0.5 - bevel;
  const totalH = WHITE_KEY_HEIGHT_IN;
  const depth = totalH - bevel * 2;

  const shape = new THREE.Shape();
  // Rear edge at y = 0
  shape.moveTo(-hw, 0);
  // Left flank to front-left rounded corner
  shape.lineTo(-hw, length - cornerR - bevel);
  shape.quadraticCurveTo(-hw, length - bevel, -hw + cornerR, length - bevel);
  // Front apron lip
  shape.lineTo(hw - cornerR, length - bevel);
  shape.quadraticCurveTo(hw, length - bevel, hw, length - cornerR - bevel);
  // Right flank to rear
  shape.lineTo(hw, 0);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
  });

  geo.rotateX(Math.PI * 0.5);
  geo.translate(0, -bevel, 0);
  geo.computeVertexNormals();
  return geo;
}



/**
 * Builds an authentic concert grand cast brass pedal paddle geometry:
 * - Sturdy rectangular shank pivoting inside the lyre box
 * - Graceful transition into flared foot paddle with rounded nose
 * - Symmetrical paddle for center (sostenuto) pedal
 * - Curved flared paddles for left (una corda) and right (sustain) pedals
 * - Beveled rounded fillets on all top/bottom rims catching lustrous metallic highlights
 * - Local origin (0, 0, 0) is at the rear pivot pin inside the box
 */
export function createGrandPedalGeometry(
  style: "left" | "center" | "right",
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const shankW = 0.22;
  const shankL = 0.95;

  if (style === "center") {
    shape.moveTo(shankW, 0);
    shape.lineTo(shankW, shankL);
    shape.bezierCurveTo(0.24, 1.4, 0.54, 1.8, 0.56, 2.2);
    shape.bezierCurveTo(0.56, 2.5, 0.52, 2.7, 0.52, 2.7);
    shape.quadraticCurveTo(0.38, 3.15, 0.0, 3.15);
    shape.quadraticCurveTo(-0.38, 3.15, -0.52, 2.7);
    shape.bezierCurveTo(-0.52, 2.7, -0.56, 2.5, -0.56, 2.2);
    shape.bezierCurveTo(-0.54, 1.8, -0.24, 1.4, -shankW, shankL);
    shape.lineTo(-shankW, 0);
    shape.closePath();
  } else if (style === "right") {
    shape.moveTo(shankW, 0);
    shape.lineTo(shankW, shankL);
    shape.bezierCurveTo(0.3, 1.4, 0.85, 1.8, 0.98, 2.2);
    shape.bezierCurveTo(0.98, 2.5, 0.9, 2.7, 0.9, 2.7);
    shape.quadraticCurveTo(0.76, 3.15, 0.42, 3.15);
    shape.quadraticCurveTo(0.08, 3.15, -0.06, 2.7);
    shape.bezierCurveTo(-0.06, 2.7, -0.1, 2.5, -0.1, 2.2);
    shape.bezierCurveTo(-0.1, 1.8, -0.18, 1.4, -shankW, shankL);
    shape.lineTo(-shankW, 0);
    shape.closePath();
  } else {
    shape.moveTo(shankW, 0);
    shape.lineTo(shankW, shankL);
    shape.bezierCurveTo(0.18, 1.4, 0.1, 1.8, 0.1, 2.2);
    shape.bezierCurveTo(0.1, 2.5, 0.06, 2.7, 0.06, 2.7);
    shape.quadraticCurveTo(-0.08, 3.15, -0.42, 3.15);
    shape.quadraticCurveTo(-0.76, 3.15, -0.9, 2.7);
    shape.bezierCurveTo(-0.9, 2.7, -0.98, 2.5, -0.98, 2.2);
    shape.bezierCurveTo(-0.85, 1.8, -0.3, 1.4, -shankW, shankL);
    shape.lineTo(-shankW, 0);
    shape.closePath();
  }

  const depth = 0.22;
  const bevel = 0.045;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 4,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });

  // Rotate so 2D shape in (X, Y) maps to (X, Z) extending forward into +Z towards pianist
  geo.rotateX(Math.PI * 0.5);
  geo.computeVertexNormals();
  return geo;
}

export class Keyboard3DView {
  public readonly group = new THREE.Group();
  public readonly keysByPitch = new Map<number, Key3DMeshEntry>();
  private readonly keyMeshes: THREE.Mesh[] = [];
  private activePitches = new Map<number, KeyPressInfo | null>();
  private targetPitches = new Map<number, KeyPressInfo>();
  private wrongPitches = new Set<number>();
  private softPedalPivot: THREE.Group | null = null;
  private sostenutoPedalPivot: THREE.Group | null = null;
  private sustainPedalPivot: THREE.Group | null = null;

  public constructor() {
    this.buildGrandPianoBody();
    this.buildKeys();
  }

  private buildGrandPianoBody(): void {
    const ebonyLacquerMat = new THREE.MeshPhysicalMaterial({
      color: 0x07080c,
      roughness: 0.18,
      metalness: 0.04,
      clearcoat: 0.85,
      clearcoatRoughness: 0.14,
      reflectivity: 0.75,
      envMapIntensity: 0.28,
    });

    const polishedBrassMat = new THREE.MeshPhysicalMaterial({
      color: 0xf5cf68,
      roughness: 0.15,
      metalness: 0.94,
      clearcoat: 0.65,
      clearcoatRoughness: 0.12,
      reflectivity: 0.9,
      envMapIntensity: 0.6,
    });

    const halfW = GRAND_PIANO_HALF_WIDTH_IN;
    const zFront = -GRAND_PIANO_FRONT_DEPTH_IN;
    const zTail = -GRAND_PIANO_TAIL_DEPTH_IN;

    // 1. Solid Keybed & Protruding Front Apron Shelf (supporting the keyboard down to y = -6.2)
    // The apron board protrudes 0.95" forward past the front of the keys (Z = 0.0), matching real piano console styling.
    const zFrontProtrusion = 0.95;
    const bedHeight = 6.2 - WHITE_KEY_HEIGHT_IN; // 5.48 in
    const bedDepth = zFrontProtrusion - zFront; // ~6.55 in
    const bedCenterZ = (zFrontProtrusion + zFront) * 0.5; // ~ -2.325 in
    const bedGeo = new THREE.BoxGeometry(
      halfW * 2,
      bedHeight,
      bedDepth,
    );
    const bedMesh = new THREE.Mesh(bedGeo, ebonyLacquerMat);
    bedMesh.position.set(
      0,
      -WHITE_KEY_HEIGHT_IN - bedHeight * 0.5,
      bedCenterZ,
    );
    bedMesh.receiveShadow = true;
    bedMesh.castShadow = true;
    this.group.add(bedMesh);

    // Softly rounded bullnose edge molding along the front lip of the protruding keybed shelf
    const shelfNosingGeo = new THREE.CylinderGeometry(0.06, 0.06, halfW * 2, 16);
    shelfNosingGeo.rotateZ(Math.PI * 0.5);
    const shelfNosing = new THREE.Mesh(shelfNosingGeo, ebonyLacquerMat);
    shelfNosing.position.set(0, -WHITE_KEY_HEIGHT_IN - 0.03, zFrontProtrusion);
    this.group.add(shelfNosing);

    // Polished brass accent inlay line along the lower keybed apron above the front legs
    const brassTrimGeo = new THREE.BoxGeometry(halfW * 2, 0.08, 0.04);
    const brassTrim = new THREE.Mesh(brassTrimGeo, polishedBrassMat);
    brassTrim.position.set(0, -5.75, zFrontProtrusion + 0.02);
    this.group.add(brassTrim);

    const branding = createPianoBrandingMesh(zFrontProtrusion);
    if (branding) this.group.add(branding);

    // 2. Plush Crimson Felt Rail & Rear Ebony Keybed Rail
    const feltGeo = new THREE.BoxGeometry(KEYBOARD_WIDTH_IN + 0.2, 0.16, 0.24);
    const feltMat = new THREE.MeshStandardMaterial({
      color: 0x9b1b24,
      roughness: 0.88,
    });
    const feltMesh = new THREE.Mesh(feltGeo, feltMat);
    feltMesh.position.set(0, 0.05, -WHITE_KEY_LEN_IN + 0.06);
    this.group.add(feltMesh);

    // Low-profile rear ebony keybed rail flush with felt cushion (no tall partition blocking falling note blocks)
    const rearRailGeo = new THREE.BoxGeometry(KEYBOARD_WIDTH_IN + 0.4, 0.25, 0.5);
    const rearRail = new THREE.Mesh(rearRailGeo, ebonyLacquerMat);
    rearRail.position.set(0, -0.06, -WHITE_KEY_LEN_IN - 0.25);
    rearRail.receiveShadow = true;
    this.group.add(rearRail);

    // 3. Sculpted Waterfall Cheek Blocks (left of A0 and right of C8)
    const cheekShape = new THREE.Shape();
    const cLen = zFrontProtrusion - zFront;
    cheekShape.moveTo(0, -6.2);
    cheekShape.lineTo(cLen, -6.2);
    cheekShape.lineTo(cLen, 1.85);
    cheekShape.bezierCurveTo(cLen * 0.55, 1.85, cLen * 0.22, 0.85, 0.25, 0.42);
    cheekShape.quadraticCurveTo(0, 0.35, 0, -0.15);
    cheekShape.lineTo(0, -6.2);
    cheekShape.closePath();

    const cheekGeo = createPianoCaseGeometry(cheekShape, {
      depth: 1.05,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.06,
    });
    cheekGeo.rotateY(Math.PI * 0.5);

    for (const sign of [-1, 1] as const) {
      const cheek = new THREE.Mesh(cheekGeo, ebonyLacquerMat);
      cheek.name = sign < 0 ? "grand-piano-cheek-left" : "grand-piano-cheek-right";
      const xOffset =
        sign < 0
          ? -KEYBOARD_WIDTH_IN * 0.5 - 1.12
          : KEYBOARD_WIDTH_IN * 0.5 + 0.07;
      cheek.position.set(xOffset, 0, zFrontProtrusion);
      cheek.castShadow = true;
      cheek.receiveShadow = true;
      this.group.add(cheek);
    }

    // 4. Sculpted Concert Grand Piano Curved Rim (S-bend Bentside & Tail)

    const yFront = -zFront;
    const yTail = -zTail;

    // Open curved perimeter rim: wraps around bass spine, tail, and treble bentside.
    // The entire front width between cheek blocks is completely OPEN so falling notes are never obstructed!
    const openRimShape = new THREE.Shape();
    openRimShape.moveTo(-halfW, yFront);
    openRimShape.lineTo(-halfW, yTail - 9.0);
    // Semicircular bass tail
    openRimShape.bezierCurveTo(
      -halfW,
      yTail + 2.5,
      -3.5,
      yTail + 3.0,
      2.5,
      yTail - 2.0,
    );
    // Iconic S-bend bentside sweeping back to treble cheek
    openRimShape.bezierCurveTo(
      8.0,
      yTail - 7.5,
      11.5,
      yFront + 18.0,
      halfW,
      yFront + 9.5,
    );
    // Outer corner at right cheek block
    openRimShape.lineTo(halfW, yFront);

    // Follow the shared inner contour back to the open front mouth.
    for (let i = GRAND_PIANO_INTERIOR_CONTOUR.length - 1; i >= 0; i -= 1) {
      const point = GRAND_PIANO_INTERIOR_CONTOUR[i]!;
      openRimShape.lineTo(point.x, point.depth);
    }
    // Close endcap at left cheek block
    openRimShape.closePath();

    const rimHeight = 8.2;
    const rimGeo = createPianoCaseGeometry(openRimShape, {
      depth: rimHeight,
      bevelEnabled: true,
      bevelThickness: 0.18,
      bevelSize: 0.14,
    });
    rimGeo.rotateX(-Math.PI * 0.5);
    const rimMesh = new THREE.Mesh(rimGeo, ebonyLacquerMat);
    rimMesh.name = "grand-piano-rim";
    rimMesh.position.set(0, -6.2, 0);
    rimMesh.castShadow = true;
    rimMesh.receiveShadow = true;
    this.group.add(rimMesh);

    // 5. Clean, deep obsidian interior cavity floor (no distracting strings, struts, or soundboard ribs)
    const cavityFloorGeo = new THREE.ShapeGeometry(createGrandPianoInteriorShape());
    cavityFloorGeo.rotateX(-Math.PI * 0.5);
    const cavityFloorMat = new THREE.MeshPhysicalMaterial({
      color: 0x07080c,
      roughness: 0.38,
      metalness: 0.08,
      clearcoat: 0.45,
      clearcoatRoughness: 0.25,
      reflectivity: 0.5,
      envMapIntensity: 0.2,
    });
    const cavityFloor = new THREE.Mesh(cavityFloorGeo, cavityFloorMat);
    cavityFloor.name = "grand-piano-cavity-floor";
    cavityFloor.position.set(0, -1.25, 0);
    cavityFloor.receiveShadow = true;
    this.group.add(cavityFloor);

    // 6. Concert Grand Legs & Dual Brass Casters (resting solidly on floor at y = -20.0)
    const legCoords: Array<[number, number]> = [
      [-halfW + 2.8, zFront - 2.5],
      [halfW - 2.8, zFront - 2.5],
      [-4.0, zTail + 5.0],
    ];

    const legCapitalGeo = new THREE.BoxGeometry(2.6, 1.0, 2.6);
    const legShaftGeo = new THREE.CylinderGeometry(1.15, 0.72, 11.2, 24);
    const legFerruleGeo = new THREE.CylinderGeometry(0.74, 0.68, 0.5, 24);
    const casterBracketGeo = new THREE.BoxGeometry(0.45, 0.35, 0.7);
    const wheelGeo = new THREE.CylinderGeometry(0.475, 0.475, 0.16, 18);
    wheelGeo.rotateZ(Math.PI * 0.5);

    for (const [lx, lz] of legCoords) {
      // 1. Top mounting capital under keybed
      const capital = new THREE.Mesh(legCapitalGeo, ebonyLacquerMat);
      capital.position.set(lx, -6.7, lz);
      capital.castShadow = true;
      capital.receiveShadow = true;
      this.group.add(capital);

      // 2. Conical tapered leg column
      const shaft = new THREE.Mesh(legShaftGeo, ebonyLacquerMat);
      shaft.position.set(lx, -12.8, lz);
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      this.group.add(shaft);

      // 3. Turned polished brass ferrule collar
      const ferrule = new THREE.Mesh(legFerruleGeo, polishedBrassMat);
      ferrule.position.set(lx, -18.65, lz);
      ferrule.castShadow = true;
      this.group.add(ferrule);

      // 4. Brass caster fork bracket
      const bracket = new THREE.Mesh(casterBracketGeo, polishedBrassMat);
      bracket.position.set(lx, -19.05, lz);
      bracket.castShadow = true;
      this.group.add(bracket);

      // 5. Dual brass concert roller wheels resting exactly at floor level (y = -20.0)
      for (const wx of [-0.16, 0.16]) {
        const wheel = new THREE.Mesh(wheelGeo, polishedBrassMat);
        wheel.position.set(lx + wx, -19.525, lz);
        wheel.castShadow = true;
        this.group.add(wheel);
      }
    }

    // 7. Concert Grand 3-Pedal Lyre Assembly (Una Corda, Sostenuto, Sustain)
    const lyreGroup = new THREE.Group();

    // Lyre Base Box
    const zBox = zFront - 2.0;
    const yBox = -17.3;

    // Main ebony pedal box
    const pedalBoxGeo = new THREE.BoxGeometry(6.0, 1.5, 2.0);
    const pedalBox = new THREE.Mesh(pedalBoxGeo, ebonyLacquerMat);
    pedalBox.position.set(0, yBox, zBox);
    pedalBox.castShadow = true;
    pedalBox.receiveShadow = true;
    lyreGroup.add(pedalBox);

    // Profiled top cornice of lyre box
    const lidStepGeo = new THREE.BoxGeometry(6.4, 0.22, 2.3);
    const lidStep = new THREE.Mesh(lidStepGeo, ebonyLacquerMat);
    lidStep.position.set(0, yBox + 0.86, zBox);
    lidStep.castShadow = true;
    lyreGroup.add(lidStep);

    const lidTopGeo = new THREE.BoxGeometry(6.8, 0.32, 2.6);
    const lidTop = new THREE.Mesh(lidTopGeo, ebonyLacquerMat);
    lidTop.position.set(0, yBox + 1.13, zBox);
    lidTop.castShadow = true;
    lyreGroup.add(lidTop);

    // Profiled base plinth of lyre box
    const plinthGeo = new THREE.BoxGeometry(6.4, 0.26, 2.3);
    const plinth = new THREE.Mesh(plinthGeo, ebonyLacquerMat);
    plinth.position.set(0, yBox - 0.88, zBox);
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    lyreGroup.add(plinth);

    // Polished brass toe-guard trim on the front face of the box (z = zBox + 1.0)
    const zTrim = zBox + 1.01;
    const basePlateGeo = new THREE.BoxGeometry(5.4, 0.16, 0.03);
    const basePlate = new THREE.Mesh(basePlateGeo, polishedBrassMat);
    basePlate.position.set(0, yBox - 0.35, zTrim);
    lyreGroup.add(basePlate);

    const slotBezelColGeo = new THREE.BoxGeometry(0.12, 0.52, 0.03);
    const slotBezelTopGeo = new THREE.BoxGeometry(0.88, 0.12, 0.03);

    // Vertical lyre pillars
    const pillarShaftGeo = new THREE.BoxGeometry(0.85, 9.8, 1.25);
    const pillarCapGeo = new THREE.BoxGeometry(1.2, 0.35, 1.55);

    for (const px of [-2.15, 2.15]) {
      const shaft = new THREE.Mesh(pillarShaftGeo, ebonyLacquerMat);
      shaft.position.set(px, -11.1, zBox);
      shaft.castShadow = true;
      lyreGroup.add(shaft);

      const bottomCap = new THREE.Mesh(pillarCapGeo, ebonyLacquerMat);
      bottomCap.position.set(px, -15.85, zBox);
      bottomCap.castShadow = true;
      lyreGroup.add(bottomCap);

      const topCap = new THREE.Mesh(pillarCapGeo, ebonyLacquerMat);
      topCap.position.set(px, -6.38, zBox);
      topCap.castShadow = true;
      lyreGroup.add(topCap);
    }

    // Vertical polished brass push rods running between the pillars
    const rodGeo = new THREE.CylinderGeometry(0.045, 0.045, 9.8, 12);
    for (const rx of [-1.6, 0.0, 1.6]) {
      const rod = new THREE.Mesh(rodGeo, polishedBrassMat);
      rod.position.set(rx, -11.1, zBox);
      rod.castShadow = true;
      lyreGroup.add(rod);
    }

    // Diagonal rear brass braces from behind lyre box up into piano underbelly
    const braceDestOffsets = [-1.8, 1.8];
    const braceTargets = [-3.2, 3.2];
    for (let b = 0; b < 2; b++) {
      const start = new THREE.Vector3(braceDestOffsets[b]!, yBox - 0.1, zBox - 0.9);
      const end = new THREE.Vector3(braceTargets[b]!, -6.2, zBox - 11.5);
      const vec = end.clone().sub(start);
      const len = vec.length();
      const mid = start.clone().addScaledVector(vec, 0.5);
      const braceGeo = new THREE.CylinderGeometry(0.09, 0.09, len, 12);
      const braceMesh = new THREE.Mesh(braceGeo, polishedBrassMat);
      braceMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vec.clone().normalize());
      braceMesh.position.copy(mid);
      braceMesh.castShadow = true;
      lyreGroup.add(braceMesh);
    }

    // Authentic Grand Piano Pedals (Left: Una Corda, Center: Sostenuto, Right: Sustain)
    const pedalConfigs: Array<{
      x: number;
      style: "left" | "center" | "right";
      role: "soft" | "sostenuto" | "sustain";
    }> = [
      { x: -1.6, style: "left", role: "soft" },
      { x: 0.0, style: "center", role: "sostenuto" },
      { x: 1.6, style: "right", role: "sustain" },
    ];

    for (const cfg of pedalConfigs) {
      // Brass toe-guard bezel framing the pedal slot
      const leftCol = new THREE.Mesh(slotBezelColGeo, polishedBrassMat);
      leftCol.position.set(cfg.x - 0.38, yBox - 0.05, zTrim);
      lyreGroup.add(leftCol);

      const rightCol = new THREE.Mesh(slotBezelColGeo, polishedBrassMat);
      rightCol.position.set(cfg.x + 0.38, yBox - 0.05, zTrim);
      lyreGroup.add(rightCol);

      const topCol = new THREE.Mesh(slotBezelTopGeo, polishedBrassMat);
      topCol.position.set(cfg.x, yBox + 0.25, zTrim);
      lyreGroup.add(topCol);

      // Pedal pivot & paddle mesh
      const pPivot = new THREE.Group();
      pPivot.position.set(cfg.x, yBox - 0.05, zBox - 0.3);

      const pGeo = createGrandPedalGeometry(cfg.style);
      const pMesh = new THREE.Mesh(pGeo, polishedBrassMat);
      pMesh.castShadow = true;
      pPivot.add(pMesh);

      lyreGroup.add(pPivot);

      if (cfg.role === "soft") this.softPedalPivot = pPivot;
      else if (cfg.role === "sostenuto") this.sostenutoPedalPivot = pPivot;
      else if (cfg.role === "sustain") this.sustainPedalPivot = pPivot;
    }

    this.group.add(lyreGroup);


  }

  private buildKeys(): void {
    const gap = 0.036;
    const whiteW = WHITE_KEY_WIDTH_IN - gap;

    const solidWhiteGeo = createSolidWhiteKeyGeometry(whiteW, WHITE_KEY_LEN_IN);
    const blackGeo = createTaperedBlackKeyGeometry();

    let whiteIndex = 0;
    for (let pitch = LOWEST_PIANO_KEY; pitch <= HIGHEST_PIANO_KEY; pitch++) {
      const black = isBlackKey(pitch);
      const pivotGroup = new THREE.Group();

      if (!black) {
        const centerX =
          -KEYBOARD_WIDTH_IN * 0.5 + (whiteIndex + 0.5) * WHITE_KEY_WIDTH_IN;
        pivotGroup.position.set(centerX, 0, -WHITE_KEY_LEN_IN);

        const material = new THREE.MeshPhysicalMaterial({
          color: 0xf6f5f0,
          roughness: 0.22,
          metalness: 0.01,
          clearcoat: 0.45,
          clearcoatRoughness: 0.18,
          reflectivity: 0.65,
          envMapIntensity: 0.22,
        });

        // Single solid beveled ivorite mesh: full height and solid white flanks
        const mesh = new THREE.Mesh(solidWhiteGeo, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { pitch };
        pivotGroup.add(mesh);
        this.group.add(pivotGroup);

        this.keysByPitch.set(pitch, {
          pitch,
          isBlack: false,
          pivotGroup,
          mesh,
          material,
          centerX,
          width: whiteW,
          length: WHITE_KEY_LEN_IN,
        });
        this.keyMeshes.push(mesh);
        whiteIndex++;
      } else {
        const boundaryX = -KEYBOARD_WIDTH_IN * 0.5 + whiteIndex * WHITE_KEY_WIDTH_IN;
        const offset = BLACK_OFFSETS[pitch % 12] ?? 0;
        const centerX = boundaryX + offset * BLACK_KEY_W_IN;
        pivotGroup.position.set(centerX, 0, -WHITE_KEY_LEN_IN);

        const material = new THREE.MeshPhysicalMaterial({
          color: 0x16171b,
          roughness: 0.28,
          metalness: 0.02,
          clearcoat: 0.55,
          clearcoatRoughness: 0.2,
          reflectivity: 0.55,
          envMapIntensity: 0.22,
        });

        const mesh = new THREE.Mesh(blackGeo, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { pitch };
        pivotGroup.add(mesh);
        this.group.add(pivotGroup);

        this.keysByPitch.set(pitch, {
          pitch,
          isBlack: true,
          pivotGroup,
          mesh,
          material,
          centerX,
          width: BLACK_KEY_W_IN,
          length: BLACK_KEY_LEN_IN,
        });
        this.keyMeshes.push(mesh);
      }
    }
  }

  public setSustainPedal(depressed: boolean): void {
    if (this.sustainPedalPivot) {
      this.sustainPedalPivot.rotation.x = depressed ? 0.14 : 0;
    }
  }

  public setSoftPedal(depressed: boolean): void {
    if (this.softPedalPivot) {
      this.softPedalPivot.rotation.x = depressed ? 0.14 : 0;
    }
  }

  public setSostenutoPedal(depressed: boolean): void {
    if (this.sostenutoPedalPivot) {
      this.sostenutoPedalPivot.rotation.x = depressed ? 0.14 : 0;
    }
  }

  public updateKeys(
    active: ReadonlyMap<number, KeyPressInfo | null> | ReadonlySet<number> | readonly number[],
    targets?: ReadonlyMap<number, KeyPressInfo> | null,
    wrong?: ReadonlySet<number> | null,
  ): void {
    this.setActiveKeys(active);
    if (targets !== undefined) {
      this.setTargetKeys(targets);
    }
    if (wrong !== undefined) {
      this.setWrongKeys(wrong);
    }
  }

  public setActiveKeys(
    active: ReadonlyMap<number, KeyPressInfo | null> | ReadonlySet<number> | readonly number[],
  ): void {
    this.activePitches.clear();
    if ("get" in active) {
      for (const [pitch, info] of active.entries()) {
        this.activePitches.set(pitch, info);
      }
    } else {
      for (const pitch of active) {
        this.activePitches.set(pitch, null);
      }
    }
    this.refreshKeyStates();
  }

  public setTargetKeys(targets: ReadonlyMap<number, KeyPressInfo> | null): void {
    this.targetPitches.clear();
    if (targets) {
      for (const [pitch, info] of targets.entries()) {
        this.targetPitches.set(pitch, info);
      }
    }
    this.refreshKeyStates();
  }

  public setWrongKeys(wrong: ReadonlySet<number> | null): void {
    this.wrongPitches.clear();
    if (wrong) {
      for (const pitch of wrong) {
        this.wrongPitches.add(pitch);
      }
    }
    this.refreshKeyStates();
  }

  private refreshKeyStates(): void {
    for (const [pitch, entry] of this.keysByPitch.entries()) {
      const isPressed = this.activePitches.has(pitch);
      const isWrong = this.wrongPitches.has(pitch);
      const pressInfo = this.activePitches.get(pitch);
      const targetInfo = this.targetPitches.get(pitch);

      // Physical downward key rotation around the rear balance pin when pressed
      entry.pivotGroup.rotation.x = isPressed
        ? entry.isBlack
          ? 0.064
          : 0.056
        : 0;

      if (isWrong) {
        entry.material.color.setHex(0xef4444);
        entry.material.emissive.setHex(0xb91c1c);
        entry.material.emissiveIntensity = 0.45;
      } else if (isPressed) {
        if (pressInfo?.hand === "left") {
          entry.material.color.setHex(entry.isBlack ? 0x2563eb : 0x60a5fa);
          entry.material.emissive.setHex(0x1d4ed8);
          entry.material.emissiveIntensity = 0.35;
        } else if (pressInfo?.hand === "right") {
          entry.material.color.setHex(entry.isBlack ? 0x059669 : 0x34d399);
          entry.material.emissive.setHex(0x047857);
          entry.material.emissiveIntensity = 0.35;
        } else {
          // Physical MIDI or mouse live press
          entry.material.color.setHex(entry.isBlack ? 0xd97706 : 0xfbbf24);
          entry.material.emissive.setHex(0xb45309);
          entry.material.emissiveIntensity = 0.4;
        }
      } else if (targetInfo) {
        // Play Along target cue: highlighted top without physical depression
        if (targetInfo.hand === "left") {
          entry.material.color.setHex(entry.isBlack ? 0x1e40af : 0x93c5fd);
          entry.material.emissive.setHex(0x1e3a8a);
          entry.material.emissiveIntensity = 0.25;
        } else {
          entry.material.color.setHex(entry.isBlack ? 0x065f46 : 0x6ee7b7);
          entry.material.emissive.setHex(0x064e3b);
          entry.material.emissiveIntensity = 0.25;
        }
      } else {
        entry.material.color.setHex(entry.isBlack ? 0x111216 : 0xf2efe6);
        entry.material.emissive.setHex(0x000000);
        entry.material.emissiveIntensity = 0;
      }
    }
  }

  public getPitchFromRaycaster(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObjects(this.keyMeshes, false);
    if (hits.length === 0) return null;
    const pitch = hits[0]?.object?.userData?.pitch;
    return typeof pitch === "number" ? pitch : null;
  }

  public dispose(): void {
    disposeOwnedThreeResources(this.group);
    this.keysByPitch.clear();
    this.keyMeshes.length = 0;
  }
}
