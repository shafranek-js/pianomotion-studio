import type { Graphics } from "pixi.js";
import {
  drawCapsule,
  drawTaperedCapsule,
  getSegmentDistalRadius,
  getSortedFingersByDepth,
  inflate,
  isThumbTucked,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";
import { mixRgb, rgbToHex, type SkinSettings } from "./types";

function drawGloveCreases(
  g: Graphics,
  p: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  color: number,
): void {
  const w = Math.max(1.5, radius * 0.12);
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

/**
 * Renders white cartoon glove in PixiJS Graphics with clean layered passes:
 * Halo -> Outline -> Shade -> Lit Glove Fabric -> Stitching & Joint Creases -> Cuff
 */
export function renderGlovesSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  const cols = skinSettings.colors.gloves;
  const gloveCol = rgbToHex(cols.glove);
  const lineCol = rgbToHex(cols.line);
  const armCol = rgbToHex(cols.arm);
  const haloCol = rgbToHex(mixRgb(cols.glove, [120, 120, 130], 0.35));
  const shadeCol = rgbToHex(mixRgb(cols.glove, [0, 0, 0], 0.13));
  const stitchCol = rgbToHex(mixRgb(cols.line, cols.glove, 0.35));
  const creaseCol = rgbToHex(mixRgb(cols.line, cols.glove, 0.45));

  const lw = Math.max(1.5, geom.outlineWidth * 2.6);
  const u = geom.armUnit;

  const along = (d: number): { x: number; y: number } => ({
    x: geom.wristCenter.x + u.x * d,
    y: geom.wristCenter.y + u.y * d,
  });

  const tucked = isThumbTucked(geom);
  const sortedFingers = getSortedFingersByDepth(geom);

  const renderFingerSegmentsHalo = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius + lw + 1, r2 + lw + 1, haloCol);
    }
  };

  const renderFingerSegmentsOutline = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius + lw, r2 + lw, lineCol);
    }
  };

  const renderFingerSegmentsShade = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius, r2, shadeCol);
    }
  };

  const renderFingerSegmentsLit = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r1 = seg.radius;
      const r2 = getSegmentDistalRadius(segs, i);
      const o1 = 0.20 * r1;
      const o2 = 0.20 * r2;
      drawTaperedCapsule(
        graphics,
        { x: seg.a.x - o1, y: seg.a.y - o1 },
        { x: seg.b.x - o2, y: seg.b.y - o2 },
        r1 * 0.82,
        r2 * 0.82,
        gloveCol,
      );
    }
  };

  const renderFingerCreases = (f: number, startIdx: number, endIdx: number) => {
    if (!skinSettings.details) return;
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length - 1); i++) {
      const seg = segs[i]!;
      const jointR = getSegmentDistalRadius(segs, i);
      drawGloveCreases(graphics, seg.b, seg.u, seg.n, jointR, creaseCol);
    }
  };

  // 1. Thin dark arm sleeve (underneath wrist cuff)
  const ar = 0.2 * ppi * skinSettings.finger_width;
  drawCapsule(graphics, along(0.3 * ppi), geom.armEnd, ar + 1, haloCol);
  drawCapsule(graphics, along(0.3 * ppi), geom.armEnd, ar, armCol);

  // 0. Under-Palm Tucked Thumb Pass (ONLY when thumb is tucked under the palm)
  if (tucked) {
    renderFingerSegmentsHalo(1, 1, 3);
    renderFingerSegmentsOutline(1, 1, 3);
    renderFingerSegmentsShade(1, 1, 3);
    renderFingerSegmentsLit(1, 1, 3);
    renderFingerCreases(1, 1, 2);
  }

  // 2. Unified Halo Silhouette Pass
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(haloCol);
  }
  if (geom.palm.length >= 3) {
    const inflatedPalm = inflate(geom.palm, lw + 1);
    graphics.poly(inflatedPalm.flat()).fill(haloCol);
  }
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSegmentsHalo(1, 0, 1);
    } else {
      renderFingerSegmentsHalo(f, 0, 3);
    }
  }

  // 3. Unified Bold Dark Outline Pass
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

  // 4. Unified Glove Shade Pass (all segments before lit white fabric so shade caps don't overlap white)
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(shadeCol);
  }
  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill(shadeCol);
  }
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSegmentsShade(1, 0, 1);
    } else {
      renderFingerSegmentsShade(f, 0, 3);
    }
  }

  // 5. Unified Lit White Glove Fabric Pass
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill({ color: gloveCol, alpha: 0.92 });
  }
  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill({ color: gloveCol, alpha: 0.95 });
  }
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSegmentsLit(1, 0, 1);
    } else {
      renderFingerSegmentsLit(f, 0, 3);
    }
  }

  // 6. Back-of-Hand Stitching & Joint Creases Pass
  if (skinSettings.details) {
    const knuckles: ScreenPoint[] = [];
    for (let f = 2; f <= 5; f++) {
      const mcp = geom.chains[f]?.[1];
      if (mcp) knuckles.push(mcp);
    }

    if (knuckles.length >= 4) {
      const stitchW = Math.max(1.5, 0.045 * ppi);
      for (let i = 0; i < 3; i++) {
        const kA = knuckles[i]!;
        const kB = knuckles[i + 1]!;
        const mx = (kA.x + kB.x) / 2;
        const my = (kA.y + kB.y) / 2;
        const wx = mx + (geom.wristCenter.x - mx) * 0.55;
        const wy = my + (geom.wristCenter.y - my) * 0.55;
        const m2x = mx + (geom.wristCenter.x - mx) * 0.12;
        const m2y = my + (geom.wristCenter.y - my) * 0.12;
        graphics
          .moveTo(m2x, m2y)
          .lineTo(wx, wy)
          .stroke({ width: stitchW, color: stitchCol, cap: "round" });
      }
    }

    for (const f of sortedFingers) {
      if (f === 1 && tucked) {
        renderFingerCreases(1, 0, 1);
      } else {
        renderFingerCreases(f, 0, 2);
      }
    }
  }

  // 7. Puffy Rounded Wrist Cuff Pass
  if (skinSettings.sleeve) {
    const nx = -u.y;
    const ny = u.x;
    const cc = along(0.22 * ppi);
    const half = geom.wristWidth * 0.62;
    const cuffA = { x: cc.x + nx * half, y: cc.y + ny * half };
    const cuffB = { x: cc.x - nx * half, y: cc.y - ny * half };
    const cuffR = 0.26 * ppi;

    drawCapsule(graphics, cuffA, cuffB, cuffR + lw + 1, haloCol);
    drawCapsule(graphics, cuffA, cuffB, cuffR + lw, lineCol);
    drawCapsule(graphics, cuffA, cuffB, cuffR, shadeCol);

    const shift = 0.04 * ppi;
    const highA = { x: cuffA.x - shift, y: cuffA.y - shift };
    const highB = { x: cuffB.x - shift, y: cuffB.y - shift };
    drawCapsule(graphics, highA, highB, cuffR * 0.78, gloveCol);
  }
}

