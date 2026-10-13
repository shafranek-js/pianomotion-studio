export {
  HIGHEST_PIANO_KEY,
  isBlackKey,
  KeyboardLayout,
  KeyboardView,
  LOWEST_PIANO_KEY,
  TOTAL_KEYS,
  type KeyPressInfo,
  type KeyRect,
  type LaneRect,
} from "./keyboardView";

export {
  FallingNotesView,
  type FallingNotesViewOptions,
  type RenderedNoteTiming,
} from "./fallingNotesView";

export {
  HandsView,
  SingleHandRenderer,
  type HandsViewOptions,
} from "./handsView";

export {
  MotionBuffer,
  type MotionBufferOptions,
  type MotionBufferRange,
  type TouchContactVerification,
  lerpPose,
  lerp3,
  getDistalTipPosition,
  verifyTouchContact,
} from "./motionBuffer";

export {
  PianoScene,
  computeBottomLayout,
  type BottomLayout,
  type PianoSceneDisplaySettings,
  type PianoSceneOptions,
  KEY_LEN_WW,
  HAND_LEN_WW,
  BOTTOM_MAX_SHARE,
  HAND_AREA_MIN_H,
  FELT_H,
} from "./pianoScene";

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
  renderCartoonSkin,
  renderGlovesSkin,
  renderHandShadow,
  renderRobotSkin,
  renderSkeletonSkin,
  rgbToHex,
  SEG_TAPER,
  type CartoonColorSlots,
  type GlovesColorSlots,
  type PartialSkinSettings,
  type RobotColorSlots,
  type SkeletonColorSlots,
  type SkinColorSlots,
  type SkinSettings,
  type SkinStyle,
} from "./skins";
