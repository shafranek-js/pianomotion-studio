import type { Graphics } from "pixi.js";
import {
  getSegmentDistalRadius,
  getSortedFingersByDepth,
  inflate,
  isThumbTucked,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";
import { rgbToHex, type SkinSettings } from "./types";

/**
 * Directional stage key light vector in 3D: light coming from above-front.
 */
const LIGHT_DIR = { x: 0.25, y: -0.45, z: 0.85 };
const LIGHT_LEN = Math.hypot(LIGHT_DIR.x, LIGHT_DIR.y, LIGHT_DIR.z);
const L = {
  x: LIGHT_DIR.x / LIGHT_LEN,
  y: LIGHT_DIR.y / LIGHT_LEN,
  z: LIGHT_DIR.z / LIGHT_LEN,
};

/**
 * Calculates 3D PBR skin illumination for a surface element with normal (nx, ny, nz).
 */
function calculatePbrColor(
  baseCol: [number, number, number],
  nx: number,
  ny: number,
  nz: number,
): number {
  // Diffuse Lambertian
  const nDotL = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
  const ambient = 0.35;
  const diffuse = nDotL * 0.65;

  // Specular Blinn-Phong (glossy skin reflectance)
  // View vector V = (0, 0, 1) looking straight down
  const hx = L.x;
  const hy = L.y;
  const hz = L.z + 1.0;
  const hLen = Math.hypot(hx, hy, hz) || 1;
  const nDotH = Math.max(0, (nx * hx + ny * hy + nz * hz) / hLen);
  const spec = Math.pow(nDotH, 20.0) * 0.45;

  // Subsurface scattering warmth on edges (Fresnel rim)
  const fresnel = Math.pow(1.0 - Math.max(0, nz), 2.5) * 0.25;

  const r = Math.min(255, Math.round(baseCol[0] * (ambient + diffuse) + spec * 255 + fresnel * 220));
  const g = Math.min(255, Math.round(baseCol[1] * (ambient + diffuse) + spec * 250 + fresnel * 110));
  const b = Math.min(255, Math.round(baseCol[2] * (ambient + diffuse) + spec * 240 + fresnel * 95));

  return rgbToHex([r, g, b]);
}

function drawHemisphereCap(
  g: Graphics,
  p: ScreenPoint,
  radius: number,
  baseCol: [number, number, number],
): void {
  g.circle(p.x, p.y, radius).fill(calculatePbrColor(baseCol, 0.35, 0.35, 0.35));
  g.circle(p.x, p.y, radius * 0.78).fill(calculatePbrColor(baseCol, 0.15, -0.15, 0.85));
  g.circle(p.x, p.y, radius * 0.48).fill(calculatePbrColor(baseCol, 0, 0, 1.0));
}

/**
 * Draws a 3D cylindrical phalanx bone with multi-faceted 3D volumetric shading.
 */
function draw3DPhalanx(
  g: Graphics,
  a: ScreenPoint,
  b: ScreenPoint,
  r1: number,
  r2: number,
  baseCol: [number, number, number],
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const u = { x: dx / len, y: dy / len };
  const n = { x: -u.y, y: u.x };

  // 1. Hemispherical joint caps drawn BEFORE cylindrical facets so facets blend seamlessly
  drawHemisphereCap(g, a, r1, baseCol);
  drawHemisphereCap(g, b, r2, baseCol);

  // 2. Subdivide cylinder into 6 volumetric facets across its cross-section
  const facets = 6;
  for (let i = 0; i < facets; i++) {
    const t0 = -1.0 + (2.0 * i) / facets;
    const t1 = -1.0 + (2.0 * (i + 1)) / facets;

    const tMid = (t0 + t1) / 2.0;
    const nz = Math.sqrt(Math.max(0, 1.0 - tMid * tMid));
    const nx = n.x * tMid;
    const ny = n.y * tMid;

    const facetCol = calculatePbrColor(baseCol, nx, ny, nz);

    const p0x = a.x + n.x * (t0 * r1);
    const p0y = a.y + n.y * (t0 * r1);
    const p1x = a.x + n.x * (t1 * r1);
    const p1y = a.y + n.y * (t1 * r1);
    const p2x = b.x + n.x * (t1 * r2);
    const p2y = b.y + n.y * (t1 * r2);
    const p3x = b.x + n.x * (t0 * r2);
    const p3y = b.y + n.y * (t0 * r2);

    g.poly([p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y]).fill(facetCol);
  }
}

/**
 * Renders high-fidelity 3D WebGL PBR hands with realistic directional stage lighting,
 * volumetric 3D phalanx shading, glossy nail plates, and depth shadows.
 */
export function renderPhoto3dSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  void ppi;
  const baseCol: [number, number, number] = skinSettings.colors["photo-3d"]?.skin ?? [232, 190, 165];
  const nailCol: [number, number, number] = skinSettings.colors["photo-3d"]?.nail ?? [240, 196, 188];
  const lw = Math.max(1.0, geom.outlineWidth);
  const hw = geom.wristWidth * 0.55;
  const rimCol = calculatePbrColor(baseCol, 0.4, 0.4, 0.2);
  const palmCol = calculatePbrColor(baseCol, 0, 0, 0.95);

  const tucked = isThumbTucked(geom);
  const sortedFingers = getSortedFingersByDepth(geom);

  const render3DFingerSegments = (f: number, startIdx: number, endIdx: number, includeNail: boolean) => {
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i, 0.88);
      draw3DPhalanx(graphics, seg.a, seg.b, seg.radius, r2, baseCol);
    }

    if (includeNail && skinSettings.details) {
      const distSeg = segs[segs.length - 1]!;
      const r = distSeg.radius;
      const nailCenter = {
        x: distSeg.b.x - distSeg.u.x * r * 0.15,
        y: distSeg.b.y - distSeg.u.y * r * 0.15,
      };

      const nail3DCol = calculatePbrColor(nailCol, 0, 0, 1.0);
      graphics.ellipse(nailCenter.x, nailCenter.y, r * 0.52, r * 0.42).fill(nail3DCol);

      graphics
        .circle(
          nailCenter.x - distSeg.u.x * r * 0.1 + distSeg.n.x * r * 0.15,
          nailCenter.y - distSeg.u.y * r * 0.1 + distSeg.n.y * r * 0.15,
          r * 0.12,
        )
        .fill({ color: 0xffffff, alpha: 0.85 });
    }
  };

  // 0. Tucked thumb distal phalanges under palm (ONLY during thumb-under crossing)
  if (tucked) {
    render3DFingerSegments(1, 1, 3, true);
  }

  // 1. Forearm in 3D
  draw3DPhalanx(
    graphics,
    geom.wristCenter,
    geom.armEnd,
    hw,
    hw * 1.15,
    baseCol,
  );

  // 2. Palm & Web Rim + Base Fill
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(palmCol);
  }

  if (geom.palm.length >= 3) {
    if (skinSettings.details) {
      const rimPalm = inflate(geom.palm, lw);
      graphics.poly(rimPalm.flat()).fill({ color: rimCol, alpha: 0.65 });
    }
    graphics.poly(geom.palm.flat()).fill(palmCol);
  }

  // 3. Volumetric Fingers in 3D depth order
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      render3DFingerSegments(1, 0, 1, false);
    } else {
      render3DFingerSegments(f, 0, 3, true);
    }
  }
}

