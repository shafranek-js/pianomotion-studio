import type { Graphics } from "pixi.js";
import {
  drawBand,
  drawCapsule,
  drawTaperedCapsule,
  inflate,
  unitVector,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";
import { mixRgb, rgbToHex, type SkinSettings } from "./types";

/**
 * Superellipse ring generator for anatomical nail shape.
 */
const REALISTIC_NAIL_RING: Array<[number, number]> = Array.from({ length: 32 }, (_, i) => {
  const angle = (2 * Math.PI * i) / 32;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    Math.sign(c) * Math.pow(Math.abs(c), 0.72),
    Math.sign(s) * Math.pow(Math.abs(s), 0.72),
  ];
});

/**
 * Draw dorsal MCP knuckle skin wrinkles (curved concentric arches).
 */
function drawRealisticKnuckleCreases(
  g: Graphics,
  mcp: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  creaseColor: number,
  highlightColor: number,
  ppi: number,
): void {
  const hw = 0.65;
  const bow = 0.26;

  // Primary deeper crease
  const pts1: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const s = -1 + (2 * i) / 8;
    const along = radius * (0.07 + bow * (1 - s * s));
    pts1.push(
      mcp.x + n.x * s * hw * radius + u.x * along,
      mcp.y + n.y * s * hw * radius + u.y * along,
    );
  }
  if (pts1.length >= 4) {
    g.poly(pts1, false).stroke({
      width: Math.max(1, 0.024 * ppi),
      color: creaseColor,
      cap: "round",
      alpha: 0.7,
    });
  }

  // Secondary fine wrinkle
  const pts2: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const s = -0.8 + (1.6 * i) / 8;
    const along = radius * (-0.08 + bow * 0.7 * (1 - s * s));
    pts2.push(
      mcp.x + n.x * s * hw * 0.8 * radius + u.x * along,
      mcp.y + n.y * s * hw * 0.8 * radius + u.y * along,
    );
  }
  if (pts2.length >= 4) {
    g.poly(pts2, false).stroke({
      width: Math.max(0.8, 0.016 * ppi),
      color: creaseColor,
      cap: "round",
      alpha: 0.45,
    });
  }

  // Soft dorsal knuckle bone highlight
  g.circle(mcp.x - u.x * radius * 0.1, mcp.y - u.y * radius * 0.1, radius * 0.38).fill({
    color: highlightColor,
    alpha: 0.22,
  });
}

/**
 * Draw PIP / DIP phalanx joint skin wrinkles.
 */
function drawRealisticJointCreases(
  g: Graphics,
  p: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  creaseColor: number,
  highlightColor: number,
): void {
  const w = Math.max(0.9, radius * 0.09);

  // Soft joint highlight pad
  g.circle(p.x, p.y, radius * 0.32).fill({
    color: highlightColor,
    alpha: 0.18,
  });

  // Dual fine skin creases
  for (const [offset, span, alpha] of [
    [-0.1, 0.5, 0.65],
    [0.1, 0.42, 0.5],
  ] as const) {
    const qx = p.x + u.x * radius * offset;
    const qy = p.y + u.y * radius * offset;
    const p1x = qx + n.x * radius * span;
    const p1y = qy + n.y * radius * span;
    const p2x = qx - n.x * radius * span;
    const p2y = qy - n.y * radius * span;
    g.moveTo(p1x, p1y)
      .lineTo(p2x, p2y)
      .stroke({ width: w, color: creaseColor, cap: "round", alpha });
  }
}

/**
 * Renders an anatomically realistic fingernail with cuticle, lunula, translucent nail bed,
 * pale free edge, and specular reflection highlight.
 */
function drawRealisticNail(
  g: Graphics,
  tip: ScreenPoint,
  u: { x: number; y: number },
  n: { x: number; y: number },
  radius: number,
  nailBedColor: number,
  cuticleColor: number,
  lunulaColor: number,
  freeEdgeColor: number,
): void {
  const mid = -0.16 * radius;
  const halfLen = 0.46 * radius;
  const halfW = 0.49 * radius;

  const buildRingPts = (growL: number, growW: number, offsetL = 0): number[] => {
    const pts: number[] = [];
    for (const [ec, es] of REALISTIC_NAIL_RING) {
      const x = mid + offsetL + (halfLen + growL) * ec;
      const y = (halfW + growW) * es;
      pts.push(tip.x + u.x * x + n.x * y, tip.y + u.y * x + n.y * y);
    }
    return pts;
  };

  // 1. Cuticle / lateral nail fold rim
  const cuticlePts = buildRingPts(0.08 * radius, 0.08 * radius);
  g.poly(cuticlePts).fill({ color: cuticleColor, alpha: 0.6 });

  // 2. Translucent pinkish nail bed
  const nailBedPts = buildRingPts(0.0, 0.0);
  g.poly(nailBedPts).fill({ color: nailBedColor, alpha: 0.95 });

  // 3. Pale Lunula (proximal half-moon at base of nail)
  const lunulaCenter = {
    x: tip.x + u.x * (mid - halfLen * 0.55),
    y: tip.y + u.y * (mid - halfLen * 0.55),
  };
  g.ellipse(lunulaCenter.x, lunulaCenter.y, halfW * 0.52, halfLen * 0.35).fill({
    color: lunulaColor,
    alpha: 0.75,
  });

  // 4. Pale free edge at the distal tip of the nail
  const freeEdgeCenter = {
    x: tip.x + u.x * (mid + halfLen * 0.78),
    y: tip.y + u.y * (mid + halfLen * 0.78),
  };
  g.ellipse(freeEdgeCenter.x, freeEdgeCenter.y, halfW * 0.85, halfLen * 0.22).fill({
    color: freeEdgeColor,
    alpha: 0.82,
  });

  // 5. Specular highlight streak (light catching the glossy convex nail plate)
  const specP1 = {
    x: tip.x + u.x * (mid - halfLen * 0.3) + n.x * (halfW * 0.35),
    y: tip.y + u.y * (mid - halfLen * 0.3) + n.y * (halfW * 0.35),
  };
  const specP2 = {
    x: tip.x + u.x * (mid + halfLen * 0.45) + n.x * (halfW * 0.28),
    y: tip.y + u.y * (mid + halfLen * 0.45) + n.y * (halfW * 0.28),
  };
  g.moveTo(specP1.x, specP1.y)
    .lineTo(specP2.x, specP2.y)
    .stroke({
      width: Math.max(0.8, radius * 0.1),
      color: 0xffffff,
      cap: "round",
      alpha: 0.7,
    });
}

/**
 * Renders realistic human hands with organic skin tones, extensor tendon ridges,
 * 3D cylindrical phalanx highlights, anatomical knuckle creases, and realistic nails.
 */
export function renderRealisticSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  const cols = skinSettings.colors.realistic ?? {
    skin: [232, 190, 165],
    shadow: [175, 122, 98],
    highlight: [248, 220, 202],
    nail: [240, 196, 188],
    crease: [140, 95, 78],
    sleeve: [32, 36, 44],
  };

  const skinCol = rgbToHex(cols.skin);
  const shadowCol = rgbToHex(cols.shadow);
  const highlightCol = rgbToHex(cols.highlight);
  const nailCol = rgbToHex(cols.nail);
  const creaseCol = rgbToHex(cols.crease);
  const sleeveCol = rgbToHex(cols.sleeve);

  // Soft contour / subcutaneous tone
  const contourCol = rgbToHex(mixRgb(cols.shadow, cols.skin, 0.4));
  // Warm capillary subsurface scattering on distal pads
  const capillaryCol = rgbToHex(mixRgb(cols.skin, [245, 142, 132], 0.38));
  // Soft tendon shadow and highlight
  const tendonShadowCol = rgbToHex(mixRgb(cols.shadow, cols.skin, 0.55));
  const tendonHighlightCol = rgbToHex(cols.highlight);
  // Nail components
  const nailCuticleCol = rgbToHex(mixRgb(cols.shadow, cols.nail, 0.45));
  const nailLunulaCol = rgbToHex(mixRgb(cols.nail, [255, 252, 248], 0.75));
  const nailFreeEdgeCol = rgbToHex(mixRgb(cols.nail, [255, 250, 242], 0.88));

  const lw = Math.max(1.0, geom.outlineWidth);
  const u = geom.armUnit;
  const armLen = Math.hypot(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
  const hw = geom.wristWidth * 0.55;
  const cuff0 = 1.0 * ppi;

  const along = (d: number): { x: number; y: number } => ({
    x: geom.wristCenter.x + u.x * d,
    y: geom.wristCenter.y + u.y * d,
  });

  // ---------------------------------------------------------------------------
  // 1. Arm, Cuff, and Sleeve
  // ---------------------------------------------------------------------------
  if (skinSettings.sleeve) {
    // Forearm skin transition
    drawCapsule(graphics, along(0), along(cuff0 + 4), hw + lw, contourCol);
    drawCapsule(graphics, along(0), along(cuff0 + 4), hw, skinCol);

    // Inner folded white shirt cuff
    const sl0 = cuff0;
    const sl1 = cuff0 + 0.38 * ppi;
    const cuffMid = along((sl0 + sl1) / 2);
    const cuffOutlineCol = 0xc5c5c0;
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2 + lw, hw * 1.25 + lw, cuffOutlineCol);
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2, hw * 1.25, 0xfcfcfa);

    // Dark metallic cufflink button
    const nx = -u.y;
    const ny = u.x;
    const bx = cuffMid.x + nx * hw * 0.78;
    const by = cuffMid.y + ny * hw * 0.78;
    graphics.circle(bx, by, Math.max(1.8, 0.05 * ppi)).fill(0x303036);
    graphics.circle(bx, by, Math.max(1.0, 0.035 * ppi)).fill(0xb8b8c2);
    graphics.circle(bx - 0.5, by - 0.5, Math.max(0.5, 0.015 * ppi)).fill(0xffffff);

    // Tailored dark suit jacket sleeve
    const sleeveMid = along((sl1 + armLen) / 2);
    const sleeveOutlineCol = rgbToHex(mixRgb(cols.sleeve, [0, 0, 0], 0.45));
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2 + lw, hw * 1.34 + lw, sleeveOutlineCol);
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2, hw * 1.34, sleeveCol);

    // Subtle jacket cuff seam
    const seamPt = along(sl1 + 0.12 * ppi);
    graphics
      .moveTo(seamPt.x - nx * hw * 1.3, seamPt.y - ny * hw * 1.3)
      .lineTo(seamPt.x + nx * hw * 1.3, seamPt.y + ny * hw * 1.3)
      .stroke({ width: 1.0, color: rgbToHex(mixRgb(cols.sleeve, [255, 255, 255], 0.15)), alpha: 0.6 });
  } else {
    // Bare forearm
    drawCapsule(graphics, along(0), geom.armEnd, hw + lw, contourCol);
    drawCapsule(graphics, along(0), geom.armEnd, hw, skinCol);

    // Forearm muscle / tendon subtle dorsal highlight
    const faU = unitVector(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
    const faN = { x: -faU.y, y: faU.x };
    const faMid = along(armLen * 0.4);
    graphics
      .moveTo(faMid.x - faN.x * hw * 0.15, faMid.y - faN.y * hw * 0.15)
      .lineTo(geom.wristCenter.x, geom.wristCenter.y)
      .stroke({ width: Math.max(1, hw * 0.2), color: highlightCol, alpha: 0.25, cap: "round" });
  }

  // Helper to draw realistic finger outline
  const renderRealisticFingerOutline = (f: number) => {
    const segs = geom.radius[f];
    if (segs) {
      for (const seg of segs) {
        drawTaperedCapsule(
          graphics,
          seg.a,
          seg.b,
          seg.radius + lw,
          seg.radius * 0.95 + lw,
          contourCol,
        );
      }
    }
  };

  // Helper to draw realistic finger phalanxes, highlights, creases, and nail
  const renderRealisticFingerFillAndDetails = (f: number) => {
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    // A. Base phalanx capsules
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const r2 = i === segs.length - 1 ? seg.radius * 0.92 : seg.radius * 0.96;
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius, r2, skinCol);

      // B. Longitudinal cylindrical highlight (3D volumetric depth)
      drawTaperedCapsule(
        graphics,
        seg.a,
        seg.b,
        seg.radius * 0.42,
        r2 * 0.38,
        highlightCol,
        0.26,
      );
    }

    // C. Capillary subsurface warmth on distal pad
    const distSeg = segs[segs.length - 1]!;
    const padCenter = {
      x: distSeg.b.x - distSeg.u.x * distSeg.radius * 0.2,
      y: distSeg.b.y - distSeg.u.y * distSeg.radius * 0.2,
    };
    graphics.circle(padCenter.x, padCenter.y, distSeg.radius * 0.7).fill({
      color: capillaryCol,
      alpha: 0.35,
    });

    if (skinSettings.details) {
      // D. Joint creases at phalanx articulations (PIP, DIP)
      for (let i = 0; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        drawRealisticJointCreases(
          graphics,
          seg.b,
          seg.u,
          seg.n,
          seg.radius,
          creaseCol,
          highlightCol,
        );
      }

      // E. Knuckle wrinkles at base / MCP joint
      const baseSeg = segs[0]!;
      drawRealisticKnuckleCreases(
        graphics,
        baseSeg.a,
        baseSeg.u,
        baseSeg.n,
        baseSeg.radius,
        creaseCol,
        highlightCol,
        ppi,
      );

      // F. Anatomical fingernail
      let nailNormal = distSeg.n;
      if (f === 1) {
        // Thumb nail points away from index finger
        const ixMcp = geom.chains[2]?.[1] ?? geom.wristCenter;
        if ((distSeg.b.x - ixMcp.x) * nailNormal.x + (distSeg.b.y - ixMcp.y) * nailNormal.y < 0) {
          nailNormal = { x: -nailNormal.x, y: -nailNormal.y };
        }
      }

      drawRealisticNail(
        graphics,
        distSeg.b,
        distSeg.u,
        nailNormal,
        distSeg.radius,
        nailCol,
        nailCuticleCol,
        nailLunulaCol,
        nailFreeEdgeCol,
      );
    }
  };

  // ---------------------------------------------------------------------------
  // 2. Anatomical Layer 1: Thumb (Finger 1)
  // In top-down dorsal view, the thumb articulates on the palmar side and passes UNDER
  // the dorsum and other fingers during thumb-under movements (подкладывание 1-го пальца).
  // ---------------------------------------------------------------------------
  renderRealisticFingerOutline(1);
  renderRealisticFingerFillAndDetails(1);

  // ---------------------------------------------------------------------------
  // 3. Anatomical Layer 2: Dorsum (Palm & Web)
  // Drawn ON TOP of the thumb so thumb-under movements pass naturally underneath the dorsum.
  // ---------------------------------------------------------------------------
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(contourCol);
    for (let i = 0; i < geom.webEdge.length - 1; i++) {
      const p = geom.webEdge[i]!;
      const q = geom.webEdge[i + 1]!;
      graphics
        .moveTo(p[0], p[1])
        .lineTo(q[0], q[1])
        .stroke({ width: 2 * lw, color: contourCol, cap: "round" });
    }
  }

  if (geom.palm.length >= 3) {
    const inflatedPalm = inflate(geom.palm, lw);
    graphics.poly(inflatedPalm.flat()).fill(contourCol);
  }

  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(skinCol);
  }

  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill(skinCol);

    if (skinSettings.details) {
      // Metacarpal extensor digitorum tendon ridges (from wrist to MCP knuckles)
      for (const finger of [2, 3, 4, 5, 1]) {
        const chain = geom.chains[finger];
        if (!chain || chain.length < 2) continue;
        const mcpPt = chain[1]!;
        const wristPt = geom.wristCenter;

        const tu = unitVector(mcpPt.x - wristPt.x, mcpPt.y - wristPt.y);
        const tn = { x: -tu.y, y: tu.x };

        // Soft lateral shadow side
        graphics
          .moveTo(wristPt.x + tn.x * 1.5, wristPt.y + tn.y * 1.5)
          .lineTo(mcpPt.x + tn.x * 1.5, mcpPt.y + tn.y * 1.5)
          .stroke({ width: Math.max(1, 0.02 * ppi), color: tendonShadowCol, alpha: 0.35, cap: "round" });

        // Raised dorsal tendon ridge specular highlight
        graphics
          .moveTo(wristPt.x, wristPt.y)
          .lineTo(mcpPt.x, mcpPt.y)
          .stroke({ width: Math.max(0.8, 0.016 * ppi), color: tendonHighlightCol, alpha: 0.45, cap: "round" });
      }

      // Thenar web fold crease (between thumb and index metacarpal)
      if (geom.webEdge.length >= 5) {
        const midEdge = geom.webEdge[Math.floor(geom.webEdge.length / 2)]!;
        const d = unitVector(geom.wristCenter.x - midEdge[0], geom.wristCenter.y - midEdge[1]);
        const p1x = midEdge[0] + d.x * 0.12 * ppi;
        const p1y = midEdge[1] + d.y * 0.12 * ppi;
        const p2x = midEdge[0] + d.x * 0.48 * ppi;
        const p2y = midEdge[1] + d.y * 0.48 * ppi;
        graphics
          .moveTo(p1x, p1y)
          .lineTo(p2x, p2y)
          .stroke({ width: Math.max(1, 0.025 * ppi), color: creaseCol, alpha: 0.55, cap: "round" });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Anatomical Layer 3: Fingers 2..5 (Index, Middle, Ring, Pinky)
  // Fingers 2..5 lie on the dorsal-facing margin and also occlude thumb-under crossings.
  // ---------------------------------------------------------------------------
  for (let f = 2; f <= 5; f++) {
    renderRealisticFingerOutline(f);
    renderRealisticFingerFillAndDetails(f);
  }
}
