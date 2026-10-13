import type { MotionPose } from "@handthesia/contracts";
import type { Graphics } from "pixi.js";
import { LOWEST_PIANO_KEY, type KeyboardLayout } from "../keyboardView";
import { drawCapsule, type HandGeometry } from "./geometry";
import { computeShadowAlpha, computeShadowOffset } from "./types";

export { computeShadowAlpha, computeShadowOffset };

/**
 * Renders soft projected drop shadow beneath a hand onto PixiJS Graphics
 */
export function renderHandShadow(
  graphics: Graphics,
  geom: HandGeometry,
  ppi: number,
  pose?: MotionPose,
  keyboardLayout?: KeyboardLayout,
): void {
  const shadowColor = 0x000000;
  const offset = computeShadowOffset(geom.palmZIn, ppi);
  const alpha = computeShadowAlpha(geom.palmZIn);

  let drewGeometry = false;

  // 1. Projected palm polygon
  if (geom.palm.length >= 3) {
    const palmPts = geom.palm.flatMap(([x, y]) => [x + offset.dx, y + offset.dy]);
    graphics.poly(palmPts).fill({ color: shadowColor, alpha });
    drewGeometry = true;
  }

  // 2. Projected thenar web
  if (geom.web.length >= 3) {
    const webPts = geom.web.flatMap(([x, y]) => [x + offset.dx, y + offset.dy]);
    graphics.poly(webPts).fill({ color: shadowColor, alpha });
    drewGeometry = true;
  }

  // 3. Projected finger capsules
  for (let f = 1; f <= 5; f++) {
    const segs = geom.radius[f];
    if (segs && segs.length > 0) {
      drewGeometry = true;
      for (const seg of segs) {
        drawCapsule(
          graphics,
          { x: seg.a.x + offset.dx, y: seg.a.y + offset.dy },
          { x: seg.b.x + offset.dx, y: seg.b.y + offset.dy },
          seg.radius,
          shadowColor,
          alpha,
        );
      }
    }
  }

  // 4. Projected forearm shadow
  if (drewGeometry) {
    drawCapsule(
      graphics,
      { x: geom.wristCenter.x + offset.dx, y: geom.wristCenter.y + offset.dy },
      { x: geom.armEnd.x + offset.dx, y: geom.armEnd.y + offset.dy },
      geom.wristWidth * 0.45,
      shadowColor,
      alpha * 0.75,
    );
  } else if (pose && keyboardLayout) {
    // Fallback for minimal/synthetic test poses that have bones but no full hand chains
    const key21 = keyboardLayout.getKeyRect(LOWEST_PIANO_KEY);
    const keyboardLeft = key21 ? key21.x : keyboardLayout.rect.x;
    const keyboardBottom = keyboardLayout.rect.y + keyboardLayout.rect.height;
    for (const bone of pose.bones) {
      const ax = keyboardLeft + bone.a[0] * ppi + offset.dx;
      const ay = keyboardBottom - bone.a[1] * ppi + offset.dy;
      const bx = keyboardLeft + bone.b[0] * ppi + offset.dx;
      const by = keyboardBottom - bone.b[1] * ppi + offset.dy;
      drawCapsule(graphics, { x: ax, y: ay }, { x: bx, y: by }, 6, shadowColor, alpha);
    }
  }
}
