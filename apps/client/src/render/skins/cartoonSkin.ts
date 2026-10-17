import type { Graphics } from "pixi.js";
import {
  drawBand,
  drawCapsule,
  drawTaperedCapsule,
  getSegmentDistalRadius,
  getSortedFingersByDepth,
  inflate,
  isThumbTucked,
  unitVector,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";
import { mixRgb, rgbToHex, type SkinSettings } from "./types";

const NAIL_RING: Array<[number, number]> = Array.from({ length: 32 }, (_, i) => {
  const angle = (2 * Math.PI * i) / 32;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    Math.sign(c) * Math.pow(Math.abs(c), 0.7),
    Math.sign(s) * Math.pow(Math.abs(s), 0.7),
  ];
});

function drawKnuckleCrease(
  g: Graphics,
  mcp: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  color: number,
  ppi: number,
): void {
  const hw = 0.6;
  const bow = 0.22;
  const pts: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const s = -1 + (2 * i) / 8;
    const along = radius * (0.08 + bow * (1 - s * s));
    const px = mcp.x + n.x * s * hw * radius + u.x * along;
    const py = mcp.y + n.y * s * hw * radius + u.y * along;
    pts.push(px, py);
  }
  if (pts.length >= 4) {
    g.poly(pts, false).stroke({ width: Math.max(1, 0.03 * ppi), color, cap: "round" });
  }
}

function drawJointCreases(
  g: Graphics,
  p: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  color: number,
): void {
  const w = Math.max(1, radius * 0.12);
  for (const off of [-0.12, 0.12]) {
    const qx = p.x + u.x * radius * off;
    const qy = p.y + u.y * radius * off;
    const p1x = qx + n.x * radius * 0.45;
    const p1y = qy + n.y * radius * 0.45;
    const p2x = qx - n.x * radius * 0.45;
    const p2y = qy - n.y * radius * 0.45;
    g.moveTo(p1x, p1y).lineTo(p2x, p2y).stroke({ width: w, color, cap: "round" });
  }
}

function drawNail(
  g: Graphics,
  tip: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  fillColor: number,
  edgeColor: number,
): void {
  const mid = -0.15 * radius;
  const halfLen = 0.42 * radius;
  const halfW = 0.48 * radius;

  const renderPlate = (grow: number, color: number) => {
    const pts: number[] = [];
    for (const [ec, es] of NAIL_RING) {
      const x = mid + (halfLen + grow) * ec;
      const y = (halfW + grow) * es;
      pts.push(tip.x + u.x * x + n.x * y, tip.y + u.y * x + n.y * y);
    }
    g.poly(pts).fill(color);
  };

  renderPlate(0.12 * radius, edgeColor);
  renderPlate(0.0, fillColor);
}

/**
 * Renders cartoon flesh hand using PixiJS Graphics with strict anatomical layering:
 * 0. Tucked thumb distal phalanges (only during thumb-under crossing)
 * 1. Unified Silhouette Outline Pass (wrist, web, palm, fingers)
 * 2. Unified Flesh Fill Pass (wrist, web, palm, fingers in 3D depth order)
 * 3. Anatomical Details Pass (web crease, MCP knuckles, PIP/DIP creases, nails)
 * 4. Apparel Pass (shirt cuff and sleeve wrapping over wrist skin)
 */
export function renderCartoonSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  const cols = skinSettings.colors.cartoon;
  const skinCol = rgbToHex(cols.skin);
  const lineCol = rgbToHex(cols.line);
  const sleeveCol = rgbToHex(cols.sleeve);
  const nailCol = rgbToHex(cols.nail);
  const nailEdgeCol = rgbToHex(mixRgb(cols.line, cols.nail, 0.3));
  const creaseCol = rgbToHex(mixRgb(cols.line, cols.skin, 0.25));
  const knuckleCol = rgbToHex(mixRgb(cols.line, cols.skin, 0.35));
  const webCreaseCol = rgbToHex(mixRgb(cols.line, cols.skin, 0.35));

  const lw = Math.max(1.0, geom.outlineWidth);
  const u = geom.armUnit;
  const armLen = Math.hypot(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
  const hw = geom.wristWidth * 0.55;
  const cuff0 = 1.0 * ppi;

  const along = (d: number): { x: number; y: number } => ({
    x: geom.wristCenter.x + u.x * d,
    y: geom.wristCenter.y + u.y * d,
  });

  const tucked = isThumbTucked(geom);
  const sortedFingers = getSortedFingersByDepth(geom);
  const forearmSkinEnd = skinSettings.sleeve ? along(cuff0 + 4) : geom.armEnd;

  const renderFingerSegmentsOutline = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius + lw, r2 + lw, lineCol);
    }
  };

  const renderFingerSegmentsFill = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius, r2, skinCol);
    }
  };

  const renderFingerDetails = (f: number, includeBaseKnuckle: boolean, includeDistal: boolean) => {
    if (!skinSettings.details) return;
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    if (includeBaseKnuckle) {
      const baseSeg = segs[0]!;
      drawKnuckleCrease(graphics, baseSeg.a, baseSeg.u, baseSeg.n, baseSeg.radius, knuckleCol, ppi);
      if (f === 1 && tucked && segs.length > 1) {
        drawJointCreases(graphics, baseSeg.b, baseSeg.u, baseSeg.n, getSegmentDistalRadius(segs, 0), creaseCol);
      }
    }

    if (includeDistal) {
      const creaseStart = f === 1 && tucked ? 1 : 0;
      for (let i = creaseStart; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const jointR = getSegmentDistalRadius(segs, i);
        drawJointCreases(graphics, seg.b, seg.u, seg.n, jointR, creaseCol);
      }

      const distSeg = segs[segs.length - 1]!;
      let nailNormal = distSeg.n;
      if (f === 1) {
        const ixMcp = geom.chains[2]?.[1] ?? geom.wristCenter;
        if ((distSeg.b.x - ixMcp.x) * nailNormal.x + (distSeg.b.y - ixMcp.y) * nailNormal.y < 0) {
          nailNormal = { x: -nailNormal.x, y: -nailNormal.y };
        }
      }
      drawNail(graphics, distSeg.b, distSeg.u, nailNormal, distSeg.radius, nailCol, nailEdgeCol);
    }
  };

  // ---------------------------------------------------------------------------
  // 0. Under-Palm Tucked Thumb Pass (ONLY when thumb is tucked under the palm)
  // ---------------------------------------------------------------------------
  if (tucked) {
    renderFingerSegmentsOutline(1, 1, 3);
    renderFingerSegmentsFill(1, 1, 3);
    renderFingerDetails(1, false, true);
  }

  // ---------------------------------------------------------------------------
  // 1. Unified Silhouette Outline Pass (Wrist, Web, Palm, Fingers)
  // ---------------------------------------------------------------------------
  drawCapsule(graphics, along(0), forearmSkinEnd, hw + lw, lineCol);

  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(lineCol);
    for (let i = 0; i < geom.webEdge.length - 1; i++) {
      const p = geom.webEdge[i]!;
      const q = geom.webEdge[i + 1]!;
      graphics
        .moveTo(p[0], p[1])
        .lineTo(q[0], q[1])
        .stroke({ width: 2 * lw, color: lineCol, cap: "round" });
    }
  }

  if (geom.palm.length >= 3) {
    const inflatedPalm = inflate(geom.palm, lw);
    graphics.poly(inflatedPalm.flat()).fill(lineCol);
  }

  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSegmentsOutline(1, 0, 1);
    } else {
      renderFingerSegmentsOutline(f, 0, 3);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Unified Flesh Fill Pass (Wrist, Web, Palm, Fingers)
  // ---------------------------------------------------------------------------
  drawCapsule(graphics, along(0), forearmSkinEnd, hw, skinCol);

  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(skinCol);
  }

  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill(skinCol);
  }

  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSegmentsFill(1, 0, 1);
    } else {
      renderFingerSegmentsFill(f, 0, 3);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Anatomical Details Pass (Web Crease, Knuckles, Joint Creases, Nails)
  // ---------------------------------------------------------------------------
  if (skinSettings.details && geom.palm.length >= 3 && geom.webEdge.length >= 5) {
    const midEdge = geom.webEdge[Math.floor(geom.webEdge.length / 2)]!;
    const d = unitVector(geom.wristCenter.x - midEdge[0], geom.wristCenter.y - midEdge[1]);
    const p1x = midEdge[0] + d.x * 0.12 * ppi;
    const p1y = midEdge[1] + d.y * 0.12 * ppi;
    const p2x = midEdge[0] + d.x * 0.45 * ppi;
    const p2y = midEdge[1] + d.y * 0.45 * ppi;
    graphics
      .moveTo(p1x, p1y)
      .lineTo(p2x, p2y)
      .stroke({ width: Math.max(1, 0.03 * ppi), color: webCreaseCol, cap: "round" });
  }

  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerDetails(1, true, false);
    } else {
      renderFingerDetails(f, true, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Apparel Pass (Cuff & Sleeve drawn over Wrist/Forearm Skin)
  // ---------------------------------------------------------------------------
  if (skinSettings.sleeve) {
    const sl0 = cuff0;
    const sl1 = cuff0 + 0.42 * ppi;
    const cuffMid = along((sl0 + sl1) / 2);
    const cuffOutlineCol = rgbToHex(mixRgb(cols.line, [60, 60, 60], 0.4));

    // Sleeve shirt fabric
    const sleeveMid = along((sl1 + armLen) / 2);
    const sleeveOutlineCol = rgbToHex(mixRgb(cols.sleeve, [0, 0, 0], 0.35));
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2 + lw, hw * 1.34 + lw, sleeveOutlineCol);
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2, hw * 1.34, sleeveCol);

    // Cuff band overlapping wrist skin and sleeve top edge
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2 + lw, hw * 1.28 + lw, cuffOutlineCol);
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2, hw * 1.28, 0xf2f2ee);

    // Cuff button
    const nx = -u.y;
    const ny = u.x;
    const bx = cuffMid.x + nx * hw * 0.8;
    const by = cuffMid.y + ny * hw * 0.8;
    graphics.circle(bx, by, Math.max(1.5, 0.05 * ppi)).fill(0x5a504c);
  }
}

