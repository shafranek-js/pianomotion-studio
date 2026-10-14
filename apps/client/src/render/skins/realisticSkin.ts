import type { Graphics } from "pixi.js";
import {
  drawBand,
  drawCapsule,
  drawTaperedCapsule,
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
  const hw = 0.60;
  const bow = 0.22;

  // Primary soft dorsal crease
  const pts1: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const s = -1 + (2 * i) / 8;
    const along = radius * (0.06 + bow * (1 - s * s));
    pts1.push(
      mcp.x + n.x * s * hw * radius + u.x * along,
      mcp.y + n.y * s * hw * radius + u.y * along,
    );
  }
  if (pts1.length >= 4) {
    g.poly(pts1, false).stroke({
      width: Math.max(0.6, 0.012 * ppi),
      color: creaseColor,
      cap: "round",
      alpha: 0.32,
    });
  }

  // Soft dorsal knuckle bone highlight
  g.circle(mcp.x - u.x * radius * 0.08, mcp.y - u.y * radius * 0.08, radius * 0.34).fill({
    color: highlightColor,
    alpha: 0.16,
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
  const w = Math.max(0.6, radius * 0.06);

  // Soft joint highlight pad
  g.circle(p.x, p.y, radius * 0.30).fill({
    color: highlightColor,
    alpha: 0.14,
  });

  // Dual fine skin creases
  for (const [offset, span, alpha] of [
    [-0.08, 0.44, 0.30],
    [0.08, 0.36, 0.22],
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
  const cuticlePts = buildRingPts(0.06 * radius, 0.06 * radius);
  g.poly(cuticlePts).fill({ color: cuticleColor, alpha: 0.40 });

  // 2. Translucent pinkish nail bed
  const nailBedPts = buildRingPts(0.0, 0.0);
  g.poly(nailBedPts).fill({ color: nailBedColor, alpha: 0.95 });

  // 3. Pale Lunula (proximal half-moon at base of nail)
  const lunulaCenter = {
    x: tip.x + u.x * (mid - halfLen * 0.55),
    y: tip.y + u.y * (mid - halfLen * 0.55),
  };
  g.ellipse(lunulaCenter.x, lunulaCenter.y, halfW * 0.50, halfLen * 0.32).fill({
    color: lunulaColor,
    alpha: 0.70,
  });

  // 4. Pale free edge at the distal tip of the nail
  const freeEdgeCenter = {
    x: tip.x + u.x * (mid + halfLen * 0.78),
    y: tip.y + u.y * (mid + halfLen * 0.78),
  };
  g.ellipse(freeEdgeCenter.x, freeEdgeCenter.y, halfW * 0.82, halfLen * 0.20).fill({
    color: freeEdgeColor,
    alpha: 0.80,
  });

  // 5. Specular highlight streak (light catching the glossy convex nail plate)
  const specP1 = {
    x: tip.x + u.x * (mid - halfLen * 0.3) + n.x * (halfW * 0.30),
    y: tip.y + u.y * (mid - halfLen * 0.3) + n.y * (halfW * 0.30),
  };
  const specP2 = {
    x: tip.x + u.x * (mid + halfLen * 0.45) + n.x * (halfW * 0.24),
    y: tip.y + u.y * (mid + halfLen * 0.45) + n.y * (halfW * 0.24),
  };
  g.moveTo(specP1.x, specP1.y)
    .lineTo(specP2.x, specP2.y)
    .stroke({
      width: Math.max(0.7, radius * 0.08),
      color: 0xffffff,
      cap: "round",
      alpha: 0.65,
    });
}

/**
 * Renders realistic human hands with lifelike skin tones, 3D volumetric phalanx shading,
 * soft ambient occlusion, anatomical knuckle creases, and realistic nails.
 */
export function renderRealisticSkin(
  graphics: Graphics,
  geom: HandGeometry,
  skinSettings: SkinSettings,
  ppi: number,
): void {
  const cols = skinSettings.colors.realistic ?? {
    skin: [238, 196, 172],
    shadow: [180, 130, 108],
    highlight: [255, 230, 214],
    nail: [242, 202, 196],
    crease: [155, 108, 92],
    sleeve: [24, 26, 32],
  };

  const skinCol = rgbToHex(cols.skin);
  const shadowCol = rgbToHex(cols.shadow);
  const highlightCol = rgbToHex(cols.highlight);
  const nailCol = rgbToHex(cols.nail);
  const creaseCol = rgbToHex(cols.crease);
  const sleeveCol = rgbToHex(cols.sleeve);

  // Soft ambient subsurface contour (no harsh black comic outline)
  const softRimCol = rgbToHex(mixRgb(cols.shadow, cols.skin, 0.70));
  // Warm capillary blood flow on distal pads
  const capillaryCol = rgbToHex(mixRgb(cols.skin, [240, 140, 130], 0.32));
  // Very soft tendon shadow and highlight
  const tendonShadowCol = rgbToHex(mixRgb(cols.shadow, cols.skin, 0.75));
  const tendonHighlightCol = rgbToHex(mixRgb(cols.highlight, cols.skin, 0.5));
  // Nail components
  const nailCuticleCol = rgbToHex(mixRgb(cols.shadow, cols.nail, 0.35));
  const nailLunulaCol = rgbToHex(mixRgb(cols.nail, [255, 252, 248], 0.70));
  const nailFreeEdgeCol = rgbToHex(mixRgb(cols.nail, [255, 250, 242], 0.85));

  const u = geom.armUnit;
  const armLen = Math.hypot(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
  const hw = geom.wristWidth * 0.54;
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
    drawCapsule(graphics, along(0), along(cuff0 + 4), hw + 0.8, softRimCol, 0.5);
    drawCapsule(graphics, along(0), along(cuff0 + 4), hw, skinCol);

    // Inner folded white shirt cuff
    const sl0 = cuff0;
    const sl1 = cuff0 + 0.35 * ppi;
    const cuffMid = along((sl0 + sl1) / 2);
    const cuffOutlineCol = 0xdcdcd8;
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2 + 0.8, hw * 1.22 + 0.8, cuffOutlineCol);
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2, hw * 1.22, 0xfcfcfa);

    // Dark metallic cufflink button
    const nx = -u.y;
    const ny = u.x;
    const bx = cuffMid.x + nx * hw * 0.76;
    const by = cuffMid.y + ny * hw * 0.76;
    graphics.circle(bx, by, Math.max(1.8, 0.05 * ppi)).fill(0x282a30);
    graphics.circle(bx, by, Math.max(1.0, 0.035 * ppi)).fill(0xb8b8c2);
    graphics.circle(bx - 0.5, by - 0.5, Math.max(0.5, 0.015 * ppi)).fill(0xffffff);

    // Tailored concert tuxedo sleeve
    const sleeveMid = along((sl1 + armLen) / 2);
    const sleeveOutlineCol = rgbToHex(mixRgb(cols.sleeve, [0, 0, 0], 0.35));
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2 + 0.8, hw * 1.30 + 0.8, sleeveOutlineCol);
    drawBand(graphics, sleeveMid, u, (armLen - sl1) / 2, hw * 1.30, sleeveCol);

    // Subtle jacket cuff seam
    const seamPt = along(sl1 + 0.12 * ppi);
    graphics
      .moveTo(seamPt.x - nx * hw * 1.25, seamPt.y - ny * hw * 1.25)
      .lineTo(seamPt.x + nx * hw * 1.25, seamPt.y + ny * hw * 1.25)
      .stroke({ width: 0.8, color: rgbToHex(mixRgb(cols.sleeve, [255, 255, 255], 0.12)), alpha: 0.5 });
  } else {
    // Bare forearm with smooth volumetric shading
    drawCapsule(graphics, along(0), geom.armEnd, hw + 0.8, softRimCol, 0.5);
    drawCapsule(graphics, along(0), geom.armEnd, hw, skinCol);

    // Forearm muscle / tendon subtle dorsal highlight
    const faU = unitVector(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
    const faN = { x: -faU.y, y: faU.x };
    const faMid = along(armLen * 0.4);
    graphics
      .moveTo(faMid.x - faN.x * hw * 0.15, faMid.y - faN.y * hw * 0.15)
      .lineTo(geom.wristCenter.x, geom.wristCenter.y)
      .stroke({ width: Math.max(1, hw * 0.22), color: highlightCol, alpha: 0.18, cap: "round" });
  }

  // Helper to draw realistic finger phalanxes, volumetric 3D shading, creases, and nail
  const renderRealisticFinger = (f: number) => {
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    // 1. Phalanx segments with volumetric cylindrical 3D shading
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const r2 = i === segs.length - 1 ? seg.radius * 0.90 : seg.radius * 0.95;

      // Outer soft subcutaneous warmth
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius + 0.6, r2 + 0.6, softRimCol, 0.35);

      // Main flesh fill
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius, r2, skinCol, 1.0);

      // Flank ambient shadow (gives round cross-section)
      const nx = -seg.u.y;
      const ny = seg.u.x;
      const p1a = { x: seg.a.x + nx * seg.radius * 0.42, y: seg.a.y + ny * seg.radius * 0.42 };
      const p1b = { x: seg.b.x + nx * r2 * 0.42, y: seg.b.y + ny * r2 * 0.42 };
      drawTaperedCapsule(graphics, p1a, p1b, seg.radius * 0.48, r2 * 0.48, shadowCol, 0.16);

      // Dorsal cylindrical highlight (light catching top ridge)
      const h1a = { x: seg.a.x - nx * seg.radius * 0.12, y: seg.a.y - ny * seg.radius * 0.12 };
      const h1b = { x: seg.b.x - nx * r2 * 0.12, y: seg.b.y - ny * r2 * 0.12 };
      drawTaperedCapsule(graphics, h1a, h1b, seg.radius * 0.50, r2 * 0.46, highlightCol, 0.24);
      drawTaperedCapsule(graphics, h1a, h1b, seg.radius * 0.22, r2 * 0.20, 0xffffff, 0.12);
    }

    // 2. Capillary subsurface warmth on distal pad
    const distSeg = segs[segs.length - 1]!;
    const padCenter = {
      x: distSeg.b.x - distSeg.u.x * distSeg.radius * 0.22,
      y: distSeg.b.y - distSeg.u.y * distSeg.radius * 0.22,
    };
    graphics.circle(padCenter.x, padCenter.y, distSeg.radius * 0.70).fill({
      color: capillaryCol,
      alpha: 0.30,
    });

    if (skinSettings.details) {
      // 3. Joint creases at phalanx articulations (PIP, DIP)
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

      // 4. Knuckle wrinkles at base / MCP joint
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

      // 5. Anatomical fingernail
      let nailNormal = distSeg.n;
      if (f === 1) {
        // Thumb nail points naturally away from index finger
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
  // Thumb articulates on the palmar side and passes UNDER the dorsum and other fingers.
  // ---------------------------------------------------------------------------
  renderRealisticFinger(1);

  // ---------------------------------------------------------------------------
  // 3. Anatomical Layer 2: Dorsum (Palm & Webbing)
  // Drawn ON TOP of the thumb so thumb-under movements pass naturally underneath.
  // ---------------------------------------------------------------------------
  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill({ color: softRimCol, alpha: 0.25 });
    graphics.poly(geom.web.flat()).fill({ color: skinCol, alpha: 0.95 });
  }

  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill(skinCol);

    // Soft dorsal palm center highlight (dome of the hand)
    const midMcp = geom.chains[3]?.[1] ?? geom.wristCenter;
    const palmMid = {
      x: (geom.wristCenter.x + midMcp.x) * 0.5,
      y: (geom.wristCenter.y + midMcp.y) * 0.5,
    };
    graphics.ellipse(palmMid.x, palmMid.y, geom.wristWidth * 0.36, geom.wristWidth * 0.26).fill({
      color: highlightCol,
      alpha: 0.15,
    });

    if (skinSettings.details) {
      // Metacarpal extensor digitorum tendon ridges (soft, natural subcutaneous volume)
      for (const finger of [2, 3, 4, 5, 1]) {
        const chain = geom.chains[finger];
        if (!chain || chain.length < 2) continue;
        const mcpPt = chain[1]!;
        const wristPt = geom.wristCenter;

        const tu = unitVector(mcpPt.x - wristPt.x, mcpPt.y - wristPt.y);
        const tn = { x: -tu.y, y: tu.x };

        const startD = 0.28 * ppi;
        const endD = Math.hypot(mcpPt.x - wristPt.x, mcpPt.y - wristPt.y) - 0.12 * ppi;
        if (endD <= startD) continue;

        // Subtle shadow flank
        graphics
          .moveTo(wristPt.x + tu.x * startD + tn.x * 1.5, wristPt.y + tu.y * startD + tn.y * 1.5)
          .lineTo(wristPt.x + tu.x * endD + tn.x * 1.0, wristPt.y + tu.y * endD + tn.y * 1.0)
          .stroke({ width: 1.0, color: tendonShadowCol, alpha: 0.10, cap: "round" });

        // Subtle highlight ridge
        graphics
          .moveTo(wristPt.x + tu.x * startD - tn.x * 0.8, wristPt.y + tu.y * startD - tn.y * 0.8)
          .lineTo(wristPt.x + tu.x * endD - tn.x * 0.5, wristPt.y + tu.y * endD - tn.y * 0.5)
          .stroke({ width: 1.2, color: tendonHighlightCol, alpha: 0.12, cap: "round" });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Anatomical Layer 3: Fingers 2..5 (Index, Middle, Ring, Pinky)
  // Drawn ON TOP of the dorsum with smooth organic phalanxes and nails.
  // ---------------------------------------------------------------------------
  for (let f = 2; f <= 5; f++) {
    renderRealisticFinger(f);
  }
}
