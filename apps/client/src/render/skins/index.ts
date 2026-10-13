export {
  computeFingerRadius,
  computeShadowAlpha,
  computeShadowOffset,
  DEFAULT_SKIN_COLORS,
  DEFAULT_SKIN_SETTINGS,
  depthScale,
  FINGER_W_IN,
  FINGER_WIDTH_RANGE,
  mixRgb,
  normalizeSkinSettings,
  OUTLINE_RANGE,
  rgbToHex,
  SEG_TAPER,
  type CartoonColorSlots,
  type GlovesColorSlots,
  type RobotColorSlots,
  type SkeletonColorSlots,
  type RealisticColorSlots,
  type PartialSkinSettings,
  type SkinColorSlots,
  type SkinSettings,
  type SkinStyle,
} from "./types";

export {
  buildHandGeometry,
  chaikin,
  convexHull,
  drawBand,
  drawCapsule,
  drawTaperedCapsule,
  getFingerTipsByFinger,
  inflate,
  unitVector,
  type FingerSegment,
  type HandGeometry,
  type ScreenPoint,
} from "./geometry";

export { renderCartoonSkin } from "./cartoonSkin";
export { renderGlovesSkin } from "./glovesSkin";
export { renderRobotSkin } from "./robotSkin";
export { renderRealisticSkin } from "./realisticSkin";
export { renderSkeletonSkin } from "./skeletonSkin";
export { renderHandShadow } from "./shadowRenderer";

