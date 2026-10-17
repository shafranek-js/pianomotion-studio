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

  // Soft dorsal knuckle bone highlight
  g.circle(mcp.x - u.x * radius * 0.08, mcp.y - u.y * radius * 0.08, radius * 0.34).fill({
    color: highlightColor,
    alpha: 0.16,
  });

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
 * Renders realistic human hands with lifelike skin tones, continuous 3D volumetric phalanx
 * shading, soft ambient subsurface contour, anatomical knuckle creases, and realistic nails.
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

  const tucked = isThumbTucked(geom);
  const sortedFingers = getSortedFingersByDepth(geom);
  const forearmSkinEnd = skinSettings.sleeve ? along(cuff0 + 4) : geom.armEnd;

  const renderFingerSubsurfaceRim = (f: number, startIdx: number, endIdx: number) => {
    const segs = geom.radius[f];
    if (!segs) return;
    for (let i = startIdx; i < Math.min(endIdx, segs.length); i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i, 0.90);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius + 0.6, r2 + 0.6, softRimCol, 0.35);
    }
  };

  const renderFingerFleshAndVolume = (
    f: number,
    startIdx: number,
    endIdx: number,
    includeDistalPad: boolean,
  ) => {
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;
    const stop = Math.min(endIdx, segs.length);

    // Sub-pass A: Opaque continuous flesh base across all phalanges first
    // so no subsequent segment's rim or shadow ever stamps a circle over a joint!
    for (let i = startIdx; i < stop; i++) {
      const seg = segs[i]!;
      const r2 = getSegmentDistalRadius(segs, i, 0.90);
      drawTaperedCapsule(graphics, seg.a, seg.b, seg.radius, r2, skinCol, 1.0);
    }

    // Sub-pass B: Lateral flank ambient shadow (inset slightly from joints to avoid double-alpha caps)
    for (let i = startIdx; i < stop; i++) {
      const seg = segs[i]!;
      const r1 = seg.radius;
      const r2 = getSegmentDistalRadius(segs, i, 0.90);
      const nx = -seg.u.y;
      const ny = seg.u.x;
      const t0 = i > startIdx ? 0.12 : 0.04;
      const t1 = i + 1 < stop ? 0.88 : 0.94;
      const aIn = {
        x: seg.a.x + (seg.b.x - seg.a.x) * t0,
        y: seg.a.y + (seg.b.y - seg.a.y) * t0,
      };
      const bIn = {
        x: seg.a.x + (seg.b.x - seg.a.x) * t1,
        y: seg.a.y + (seg.b.y - seg.a.y) * t1,
      };
      const rA = r1 + (r2 - r1) * t0;
      const rB = r1 + (r2 - r1) * t1;
      const p1a = { x: aIn.x + nx * rA * 0.42, y: aIn.y + ny * rA * 0.42 };
      const p1b = { x: bIn.x + nx * rB * 0.42, y: bIn.y + ny * rB * 0.42 };
      drawTaperedCapsule(graphics, p1a, p1b, rA * 0.46, rB * 0.46, shadowCol, 0.14);
    }

    // Sub-pass C: Dorsal cylindrical highlight along each phalanx ridge
    for (let i = startIdx; i < stop; i++) {
      const seg = segs[i]!;
      const r1 = seg.radius;
      const r2 = getSegmentDistalRadius(segs, i, 0.90);
      const nx = -seg.u.y;
      const ny = seg.u.x;
      const t0 = i > startIdx ? 0.14 : 0.06;
      const t1 = i + 1 < stop ? 0.86 : 0.92;
      const aIn = {
        x: seg.a.x + (seg.b.x - seg.a.x) * t0,
        y: seg.a.y + (seg.b.y - seg.a.y) * t0,
      };
      const bIn = {
        x: seg.a.x + (seg.b.x - seg.a.x) * t1,
        y: seg.a.y + (seg.b.y - seg.a.y) * t1,
      };
      const rA = r1 + (r2 - r1) * t0;
      const rB = r1 + (r2 - r1) * t1;
      const h1a = { x: aIn.x - nx * rA * 0.12, y: aIn.y - ny * rA * 0.12 };
      const h1b = { x: bIn.x - nx * rB * 0.12, y: bIn.y - ny * rB * 0.12 };
      drawTaperedCapsule(graphics, h1a, h1b, rA * 0.48, rB * 0.44, highlightCol, 0.22);
      drawTaperedCapsule(graphics, h1a, h1b, rA * 0.20, rB * 0.18, 0xffffff, 0.10);
    }

    // Sub-pass D: Capillary subsurface warmth on distal pad
    if (includeDistalPad) {
      const distSeg = segs[segs.length - 1]!;
      const padCenter = {
        x: distSeg.b.x - distSeg.u.x * distSeg.radius * 0.22,
        y: distSeg.b.y - distSeg.u.y * distSeg.radius * 0.22,
      };
      graphics.circle(padCenter.x, padCenter.y, distSeg.radius * 0.70).fill({
        color: capillaryCol,
        alpha: 0.30,
      });
    }
  };

  const renderFingerDetails = (f: number, includeBaseKnuckle: boolean, includeDistal: boolean) => {
    if (!skinSettings.details) return;
    const segs = geom.radius[f];
    if (!segs || segs.length === 0) return;

    if (includeBaseKnuckle) {
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
      if (f === 1 && tucked && segs.length > 1) {
        drawRealisticJointCreases(
          graphics,
          baseSeg.b,
          baseSeg.u,
          baseSeg.n,
          getSegmentDistalRadius(segs, 0, 0.90),
          creaseCol,
          highlightCol,
        );
      }
    }

    if (includeDistal) {
      const creaseStart = f === 1 && tucked ? 1 : 0;
      for (let i = creaseStart; i < segs.length - 1; i++) {
        const seg = segs[i]!;
        const jointR = getSegmentDistalRadius(segs, i, 0.90);
        drawRealisticJointCreases(
          graphics,
          seg.b,
          seg.u,
          seg.n,
          jointR,
          creaseCol,
          highlightCol,
        );
      }

      const distSeg = segs[segs.length - 1]!;
      let nailNormal = distSeg.n;
      if (f === 1) {
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
  // 0. Under-Palm Tucked Thumb Pass (ONLY when thumb is tucked under the palm)
  // ---------------------------------------------------------------------------
  if (tucked) {
    renderFingerSubsurfaceRim(1, 1, 3);
    renderFingerFleshAndVolume(1, 1, 3, true);
    renderFingerDetails(1, false, true);
  }

  // ---------------------------------------------------------------------------
  // 1. Unified Soft Subsurface Rim / Silhouette Pass
  // ---------------------------------------------------------------------------
  drawCapsule(graphics, along(0), forearmSkinEnd, hw + 0.8, softRimCol, 0.5);

  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill({ color: softRimCol, alpha: 0.25 });
  }

  if (geom.palm.length >= 3) {
    const rimPalm = inflate(geom.palm, 0.8);
    graphics.poly(rimPalm.flat()).fill({ color: softRimCol, alpha: 0.35 });
  }

  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerSubsurfaceRim(1, 0, 1);
    } else {
      renderFingerSubsurfaceRim(f, 0, 3);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Unified Opaque Flesh & Volumetric Shading Pass
  // ---------------------------------------------------------------------------
  drawCapsule(graphics, along(0), forearmSkinEnd, hw, skinCol);

  if (!skinSettings.sleeve) {
    // Bare forearm muscle / tendon subtle dorsal highlight
    const faU = unitVector(geom.armEnd.x - geom.wristCenter.x, geom.armEnd.y - geom.wristCenter.y);
    const faN = { x: -faU.y, y: faU.x };
    const faMid = along(armLen * 0.4);
    graphics
      .moveTo(faMid.x - faN.x * hw * 0.15, faMid.y - faN.y * hw * 0.15)
      .lineTo(geom.wristCenter.x, geom.wristCenter.y)
      .stroke({ width: Math.max(1, hw * 0.22), color: highlightCol, alpha: 0.18, cap: "round" });
  }

  if (geom.web.length >= 3) {
    graphics.poly(geom.web.flat()).fill(skinCol);
  }

  if (geom.palm.length >= 3) {
    graphics.poly(geom.palm.flat()).fill(skinCol);
  }

  // Render finger opaque flesh + cylindrical volume before dorsal tendons & creases
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerFleshAndVolume(1, 0, 1, false);
    } else {
      renderFingerFleshAndVolume(f, 0, 3, true);
    }
  }

  // Dorsal palm dome highlight and extensor digitorum tendons (sit seamlessly over palm-knuckle transition)
  if (geom.palm.length >= 3) {
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

        graphics
          .moveTo(wristPt.x + tu.x * startD + tn.x * 1.5, wristPt.y + tu.y * startD + tn.y * 1.5)
          .lineTo(wristPt.x + tu.x * endD + tn.x * 1.0, wristPt.y + tu.y * endD + tn.y * 1.0)
          .stroke({ width: 1.0, color: tendonShadowCol, alpha: 0.10, cap: "round" });

        graphics
          .moveTo(wristPt.x + tu.x * startD - tn.x * 0.8, wristPt.y + tu.y * startD - tn.y * 0.8)
          .lineTo(wristPt.x + tu.x * endD - tn.x * 0.5, wristPt.y + tu.y * endD - tn.y * 0.5)
          .stroke({ width: 1.2, color: tendonHighlightCol, alpha: 0.12, cap: "round" });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Anatomical Details Pass (MCP Knuckles, PIP/DIP Creases, Fingernails)
  // ---------------------------------------------------------------------------
  for (const f of sortedFingers) {
    if (f === 1 && tucked) {
      renderFingerDetails(1, true, false);
    } else {
      renderFingerDetails(f, true, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Apparel Pass (Shirt Cuff, Cufflink, Tuxedo Sleeve over Wrist Skin)
  // ---------------------------------------------------------------------------
  if (skinSettings.sleeve) {
    const sl0 = cuff0;
    const sl1 = cuff0 + 0.35 * ppi;
    const cuffMid = along((sl0 + sl1) / 2);
    const cuffOutlineCol = 0xdcdcd8;
    const nx = -u.y;
    const ny = u.x;

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

    // Inner folded white shirt cuff overlapping wrist skin
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2 + 0.8, hw * 1.22 + 0.8, cuffOutlineCol);
    drawBand(graphics, cuffMid, u, (sl1 - sl0) / 2, hw * 1.22, 0xfcfcfa);

    // Dark metallic cufflink button
    const bx = cuffMid.x + nx * hw * 0.76;
    const by = cuffMid.y + ny * hw * 0.76;
    graphics.circle(bx, by, Math.max(1.8, 0.05 * ppi)).fill(0x282a30);
    graphics.circle(bx, by, Math.max(1.0, 0.035 * ppi)).fill(0xb8b8c2);
    graphics.circle(bx - 0.5, by - 0.5, Math.max(0.5, 0.015 * ppi)).fill(0xffffff);
  }
}

