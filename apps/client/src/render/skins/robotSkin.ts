import type { Graphics } from "pixi.js";
import {
  drawBand,
  drawCapsule,
  inflate,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";
import { mixRgb, rgbToHex, type SkinSettings } from "./types";

function drawJointCylinder(
  g: Graphics,
  p: ScreenPoint,
  radius: number,
  jointCol: number,
  chromeCol: number,
  darkJointCol: number,
  pinCol: number,
): void {
  g.circle(p.x, p.y, radius * 0.78).fill(darkJointCol);
  g.circle(p.x, p.y, radius * 0.62).fill(jointCol);
  g.circle(p.x - radius * 0.18, p.y - radius * 0.18, radius * 0.26).fill(chromeCol);
  g.circle(p.x, p.y, Math.max(1, radius * 0.12)).fill(pinCol);
}

/**
 * Renders futuristic robot hand in PixiJS Graphics
 */
export function renderRobotSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  const cols = skinSettings.colors.robot;
  const shellCol = rgbToHex(cols.shell);
  const jointCol = rgbToHex(cols.joint);
  const tipCol = rgbToHex(cols.tip);
  const edgeCol = rgbToHex(mixRgb(cols.shell, [0, 0, 0], 0.45));
  const glossCol = rgbToHex(mixRgb(cols.shell, [255, 255, 255], 0.7));
  const chromeCol = rgbToHex(mixRgb(cols.joint, [255, 255, 255], 0.55));
  const darkJointCol = rgbToHex(mixRgb(cols.joint, [0, 0, 0], 0.35));
  const pinCol = rgbToHex(mixRgb(cols.joint, [0, 0, 0], 0.5));
  const screwCol = rgbToHex(mixRgb(cols.shell, [255, 255, 255], 0.3));
  const membraneCol = rgbToHex(mixRgb(cols.joint, [0, 0, 0], 0.3));

  const lw = Math.max(1.0, geom.outlineWidth * 0.8);
  const u = geom.armUnit;
  const armLen = Math.hypot(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
  const hw = geom.wristWidth * 0.52;
  const cyl0 = 1.45 * ppi;

  const along = (d: number): { x: number; y: number } => ({
    x: geom.wristCenter.x + u.x * d,
    y: geom.wristCenter.y + u.y * d,
  });

  // 1. Forearm: Black inner cylinder, then white/light wrist shell
  const cylMid = along((cyl0 + armLen) / 2);
  drawBand(graphics, cylMid, u, (armLen - cyl0) / 2, hw * 0.95, 0x161618);

  const nx = -u.y;
  const ny = u.x;
  const lineStart = {
    x: cylMid.x - nx * hw * 0.5 - u.x * (armLen - cyl0) / 2,
    y: cylMid.y - ny * hw * 0.5 - u.y * (armLen - cyl0) / 2,
  };
  const lineEnd = {
    x: cylMid.x - nx * hw * 0.5 + u.x * (armLen - cyl0) / 2,
    y: cylMid.y - ny * hw * 0.5 + u.y * (armLen - cyl0) / 2,
  };
  graphics
    .moveTo(lineStart.x, lineStart.y)
    .lineTo(lineEnd.x, lineEnd.y)
    .stroke({ width: Math.max(1, 0.05 * ppi), color: 0x46464c, cap: "round" });

  drawCapsule(graphics, along(0), along(cyl0), hw + lw, edgeCol);
  drawCapsule(graphics, along(0), along(cyl0), hw, shellCol);

  if (skinSettings.details) {
    const seamA = along(cyl0 * 0.62);
    graphics
      .moveTo(seamA.x + nx * hw, seamA.y + ny * hw)
      .lineTo(seamA.x - nx * hw, seamA.y - ny * hw)
      .stroke({ width: 1, color: edgeCol });
  }

  const gap = 0.075 * ppi;

  const renderRobotFinger = (f: number) => {
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    // Thumb base housing
    if (f === 1 && segs.length > 0) {
      const baseSeg = segs[0]!;
      drawCapsule(graphics, baseSeg.a, baseSeg.b, baseSeg.radius * 0.9 + lw, edgeCol);
      drawCapsule(graphics, baseSeg.a, baseSeg.b, baseSeg.radius * 0.9, darkJointCol);
      graphics
        .moveTo(baseSeg.a.x - baseSeg.radius * 0.3, baseSeg.a.y - baseSeg.radius * 0.3)
        .lineTo(baseSeg.b.x - baseSeg.radius * 0.3, baseSeg.b.y - baseSeg.radius * 0.3)
        .stroke({
          width: Math.max(1, baseSeg.radius * 0.15),
          color: chromeCol,
          cap: "round",
        });
    }

    // Joint metal cylinders at joints
    const activeSegs = f === 1 ? segs.slice(1) : segs;
    for (const seg of activeSegs) {
      drawJointCylinder(graphics, seg.a, seg.radius, jointCol, chromeCol, darkJointCol, pinCol);
    }

    // Shell plates with visible gaps
    for (let i = 0; i < activeSegs.length; i++) {
      const seg = activeSegs[i]!;
      const isLast = i === activeSegs.length - 1;
      const g0 = Math.min(gap + seg.radius * 0.5, seg.length * 0.35);
      const g1 = isLast ? 0.0 : Math.min(gap + seg.radius * 0.5, seg.length * 0.35);

      const p0 = { x: seg.a.x + seg.u.x * g0, y: seg.a.y + seg.u.y * g0 };
      const p1 = { x: seg.b.x - seg.u.x * g1, y: seg.b.y - seg.u.y * g1 };
      const rr = seg.radius * (isLast ? 0.9 : 0.95);

      drawCapsule(graphics, p0, p1, rr + lw, edgeCol);
      drawCapsule(graphics, p0, p1, rr, shellCol);

      // Gloss line highlight along one edge
      const glossOffset = rr * 0.45;
      const gEnd = isLast
        ? { x: p0.x + (p1.x - p0.x) * 0.4, y: p0.y + (p1.y - p0.y) * 0.4 }
        : p1;

      graphics
        .moveTo(p0.x - seg.n.x * glossOffset, p0.y - seg.n.y * glossOffset)
        .lineTo(gEnd.x - seg.n.x * glossOffset, gEnd.y - seg.n.y * glossOffset)
        .stroke({ width: Math.max(1, rr * 0.18), color: glossCol, cap: "round" });

      // Fingertip cap
      if (isLast) {
        const t0 = { x: p0.x + (p1.x - p0.x) * 0.45, y: p0.y + (p1.y - p0.y) * 0.45 };
        drawCapsule(graphics, t0, p1, rr * 0.98, tipCol);

        // Highlight spot on dark tip
        const spotX = p1.x - seg.n.x * rr * 0.35 - seg.u.x * rr * 0.3;
        const spotY = p1.y - seg.n.y * rr * 0.35 - seg.u.y * rr * 0.3;
        const tipHighlight = rgbToHex(mixRgb(cols.tip, [255, 255, 255], 0.3));
        graphics.circle(spotX, spotY, Math.max(1, rr * 0.2)).fill(tipHighlight);
      }
    }
  };

  // Layer 1: Thumb (Finger 1) underneath palm
  renderRobotFinger(1);

  // Layer 2: Palm Plate
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(membraneCol);
  }

  if (geom.palm.length >= 3) {
    const inflatedPalm = inflate(geom.palm, lw);
    graphics.poly(inflatedPalm.flat()).fill(edgeCol);
    graphics.poly(geom.palm.flat()).fill(shellCol);
  }

  // Palm Seam & Screws (if details)
  if (skinSettings.details && geom.chains[1] && geom.chains[2] && geom.chains[5]) {
    const k2 = geom.chains[2][1] ?? geom.wristCenter;
    const k5 = geom.chains[5][1] ?? geom.wristCenter;
    const cm = geom.chains[1][0] ?? geom.wristCenter;
    const ptA = { x: cm.x + (k2.x - cm.x) * 0.55, y: cm.y + (k2.y - cm.y) * 0.55 };
    const ptSide = {
      x: geom.wristU.x + (k5.x - geom.wristU.x) * 0.55,
      y: geom.wristU.y + (k5.y - geom.wristU.y) * 0.55,
    };
    const ctrl = {
      x: (ptA.x + ptSide.x) / 2 + (geom.wristCenter.x - (ptA.x + ptSide.x) / 2) * 0.35,
      y: (ptA.y + ptSide.y) / 2 + (geom.wristCenter.y - (ptA.y + ptSide.y) / 2) * 0.35,
    };

    const seamPts: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const oneMinusT = 1 - t;
      const sx = oneMinusT * oneMinusT * ptA.x + 2 * oneMinusT * t * ctrl.x + t * t * ptSide.x;
      const sy = oneMinusT * oneMinusT * ptA.y + 2 * oneMinusT * t * ctrl.y + t * t * ptSide.y;
      seamPts.push(sx, sy);
    }
    if (seamPts.length >= 4) {
      graphics.poly(seamPts, false).stroke({ width: Math.max(1, 0.03 * ppi), color: edgeCol });
    }

    // Screw heads
    const screwR = Math.max(1.2, 0.045 * ppi);
    for (const t of [0.25, 0.5]) {
      const sBaseX = ptSide.x + (geom.wristU.x - ptSide.x) * t;
      const sBaseY = ptSide.y + (geom.wristU.y - ptSide.y) * t;
      const sx = sBaseX + (geom.wristCenter.x - sBaseX) * 0.18;
      const sy = sBaseY + (geom.wristCenter.y - sBaseY) * 0.18;
      graphics.circle(sx, sy, screwR).fill(screwCol);
      graphics.circle(sx, sy, Math.max(0.5, screwR * 0.3)).fill(edgeCol);
    }
  }

  // Layer 3: Fingers 2..5 on top
  for (let f = 2; f <= 5; f++) {
    renderRobotFinger(f);
  }
}
