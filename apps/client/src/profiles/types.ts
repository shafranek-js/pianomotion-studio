import {
  type PianistProfile,
  PianistProfileSchema,
  SCHEMA_VERSION,
} from "@handthesia/contracts";

export type { PianistProfile };
export { PianistProfileSchema, SCHEMA_VERSION };

// ---------------------------------------------------------------------------
// Anatomy definitions: 19 bones + wrist
// ---------------------------------------------------------------------------

export type MetacarpalBoneId = "mc1" | "mc2" | "mc3" | "mc4" | "mc5";
export type ProximalBoneId = "pp1" | "pp2" | "pp3" | "pp4" | "pp5";
export type MiddleBoneId = "mp2" | "mp3" | "mp4" | "mp5";
export type DistalBoneId = "dp1" | "dp2" | "dp3" | "dp4" | "dp5";

export type BoneId =
  | MetacarpalBoneId
  | ProximalBoneId
  | MiddleBoneId
  | DistalBoneId;

export type AnatomyKey = BoneId | "wrist";

export type FingerNumber = 1 | 2 | 3 | 4 | 5;
export type BoneKind = "mc" | "pp" | "mp" | "dp";

export interface AnatomyBoneDefinition {
  id: BoneId;
  finger: FingerNumber;
  fingerName: "Thumb" | "Index" | "Middle" | "Ring" | "Little";
  kind: BoneKind;
  kindName: "metacarpal" | "proximal phalanx" | "middle phalanx" | "distal phalanx";
  name: string;
  defaultLength: number;
  min: number;
  max: number;
}

export interface AnatomyWristDefinition {
  id: "wrist";
  name: string;
  defaultLength: number;
  min: number;
  max: number;
}

export const DEFAULT_ANATOMY: Readonly<Record<BoneId, number>> = Object.freeze({
  mc1: 4.7,
  pp1: 3.3,
  dp1: 2.8,
  mc2: 6.684,
  pp2: 4.0,
  mp2: 2.3,
  dp2: 1.8,
  mc3: 6.626,
  pp3: 4.5,
  mp3: 2.7,
  dp3: 1.9,
  mc4: 6.332,
  pp4: 4.2,
  mp4: 2.6,
  dp4: 1.9,
  mc5: 5.974,
  pp5: 3.3,
  mp5: 1.8,
  dp5: 1.7,
});

export const BONE_SCALE_MIN = 0.7;
export const BONE_SCALE_MAX = 2.5;

export const WRIST_SCALE_MIN = 0.75;
export const WRIST_SCALE_MAX = 2.0;
export const DEFAULT_WRIST_SCALE = 1.0;

export const WRIST_DEFINITION: Readonly<AnatomyWristDefinition> = Object.freeze({
  id: "wrist",
  name: "Wrist Width",
  defaultLength: DEFAULT_WRIST_SCALE,
  min: WRIST_SCALE_MIN,
  max: WRIST_SCALE_MAX,
});

export const ANATOMY_BONES: readonly AnatomyBoneDefinition[] = Object.freeze([
  // Finger 1 (Thumb) - no middle phalanx
  {
    id: "mc1",
    finger: 1,
    fingerName: "Thumb",
    kind: "mc",
    kindName: "metacarpal",
    name: "Thumb Metacarpal",
    defaultLength: 4.7,
    min: 4.7 * BONE_SCALE_MIN,
    max: 4.7 * BONE_SCALE_MAX,
  },
  {
    id: "pp1",
    finger: 1,
    fingerName: "Thumb",
    kind: "pp",
    kindName: "proximal phalanx",
    name: "Thumb Proximal Phalanx",
    defaultLength: 3.3,
    min: 3.3 * BONE_SCALE_MIN,
    max: 3.3 * BONE_SCALE_MAX,
  },
  {
    id: "dp1",
    finger: 1,
    fingerName: "Thumb",
    kind: "dp",
    kindName: "distal phalanx",
    name: "Thumb Distal Phalanx",
    defaultLength: 2.8,
    min: 2.8 * BONE_SCALE_MIN,
    max: 2.8 * BONE_SCALE_MAX,
  },
  // Finger 2 (Index)
  {
    id: "mc2",
    finger: 2,
    fingerName: "Index",
    kind: "mc",
    kindName: "metacarpal",
    name: "Index Metacarpal",
    defaultLength: 6.684,
    min: 6.684 * BONE_SCALE_MIN,
    max: 6.684 * BONE_SCALE_MAX,
  },
  {
    id: "pp2",
    finger: 2,
    fingerName: "Index",
    kind: "pp",
    kindName: "proximal phalanx",
    name: "Index Proximal Phalanx",
    defaultLength: 4.0,
    min: 4.0 * BONE_SCALE_MIN,
    max: 4.0 * BONE_SCALE_MAX,
  },
  {
    id: "mp2",
    finger: 2,
    fingerName: "Index",
    kind: "mp",
    kindName: "middle phalanx",
    name: "Index Middle Phalanx",
    defaultLength: 2.3,
    min: 2.3 * BONE_SCALE_MIN,
    max: 2.3 * BONE_SCALE_MAX,
  },
  {
    id: "dp2",
    finger: 2,
    fingerName: "Index",
    kind: "dp",
    kindName: "distal phalanx",
    name: "Index Distal Phalanx",
    defaultLength: 1.8,
    min: 1.8 * BONE_SCALE_MIN,
    max: 1.8 * BONE_SCALE_MAX,
  },
  // Finger 3 (Middle)
  {
    id: "mc3",
    finger: 3,
    fingerName: "Middle",
    kind: "mc",
    kindName: "metacarpal",
    name: "Middle Metacarpal",
    defaultLength: 6.626,
    min: 6.626 * BONE_SCALE_MIN,
    max: 6.626 * BONE_SCALE_MAX,
  },
  {
    id: "pp3",
    finger: 3,
    fingerName: "Middle",
    kind: "pp",
    kindName: "proximal phalanx",
    name: "Middle Proximal Phalanx",
    defaultLength: 4.5,
    min: 4.5 * BONE_SCALE_MIN,
    max: 4.5 * BONE_SCALE_MAX,
  },
  {
    id: "mp3",
    finger: 3,
    fingerName: "Middle",
    kind: "mp",
    kindName: "middle phalanx",
    name: "Middle Middle Phalanx",
    defaultLength: 2.7,
    min: 2.7 * BONE_SCALE_MIN,
    max: 2.7 * BONE_SCALE_MAX,
  },
  {
    id: "dp3",
    finger: 3,
    fingerName: "Middle",
    kind: "dp",
    kindName: "distal phalanx",
    name: "Middle Distal Phalanx",
    defaultLength: 1.9,
    min: 1.9 * BONE_SCALE_MIN,
    max: 1.9 * BONE_SCALE_MAX,
  },
  // Finger 4 (Ring)
  {
    id: "mc4",
    finger: 4,
    fingerName: "Ring",
    kind: "mc",
    kindName: "metacarpal",
    name: "Ring Metacarpal",
    defaultLength: 6.332,
    min: 6.332 * BONE_SCALE_MIN,
    max: 6.332 * BONE_SCALE_MAX,
  },
  {
    id: "pp4",
    finger: 4,
    fingerName: "Ring",
    kind: "pp",
    kindName: "proximal phalanx",
    name: "Ring Proximal Phalanx",
    defaultLength: 4.2,
    min: 4.2 * BONE_SCALE_MIN,
    max: 4.2 * BONE_SCALE_MAX,
  },
  {
    id: "mp4",
    finger: 4,
    fingerName: "Ring",
    kind: "mp",
    kindName: "middle phalanx",
    name: "Ring Middle Phalanx",
    defaultLength: 2.6,
    min: 2.6 * BONE_SCALE_MIN,
    max: 2.6 * BONE_SCALE_MAX,
  },
  {
    id: "dp4",
    finger: 4,
    fingerName: "Ring",
    kind: "dp",
    kindName: "distal phalanx",
    name: "Ring Distal Phalanx",
    defaultLength: 1.9,
    min: 1.9 * BONE_SCALE_MIN,
    max: 1.9 * BONE_SCALE_MAX,
  },
  // Finger 5 (Little)
  {
    id: "mc5",
    finger: 5,
    fingerName: "Little",
    kind: "mc",
    kindName: "metacarpal",
    name: "Little Metacarpal",
    defaultLength: 5.974,
    min: 5.974 * BONE_SCALE_MIN,
    max: 5.974 * BONE_SCALE_MAX,
  },
  {
    id: "pp5",
    finger: 5,
    fingerName: "Little",
    kind: "pp",
    kindName: "proximal phalanx",
    name: "Little Proximal Phalanx",
    defaultLength: 3.3,
    min: 3.3 * BONE_SCALE_MIN,
    max: 3.3 * BONE_SCALE_MAX,
  },
  {
    id: "mp5",
    finger: 5,
    fingerName: "Little",
    kind: "mp",
    kindName: "middle phalanx",
    name: "Little Middle Phalanx",
    defaultLength: 1.8,
    min: 1.8 * BONE_SCALE_MIN,
    max: 1.8 * BONE_SCALE_MAX,
  },
  {
    id: "dp5",
    finger: 5,
    fingerName: "Little",
    kind: "dp",
    kindName: "distal phalanx",
    name: "Little Distal Phalanx",
    defaultLength: 1.7,
    min: 1.7 * BONE_SCALE_MIN,
    max: 1.7 * BONE_SCALE_MAX,
  },
]);

// ---------------------------------------------------------------------------
// Behavior slider definitions
// ---------------------------------------------------------------------------

export type BehaviorSliderKey =
  | "retraction"
  | "finger_curve"
  | "antic_hand"
  | "antic_fingers"
  | "tendon_link"
  | "cross_height"
  | "lift_height"
  | "wrist_bounce"
  | "tremolo_rotation"
  | "gesture_finger_action"
  | "cross_turn"
  | "smoothness"
  | "early_release"
  | "max_speed"
  | "key_area_near"
  | "key_area_far"
  | "roll_speed"
  | "weak_bias"
  | "stretch_bias"
  | "economy"
  | "black_avoid"
  | "gliss_gap"
  | "gliss_min"
  | "gliss_merge";

export interface BehaviorSliderDefinition {
  id: BehaviorSliderKey;
  group: "Motion" | "Glissandos" | "Fingering";
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  lowLabel?: string;
  highLabel?: string;
  unit?: string;
  description: string;
}

export const BEHAVIOR_SLIDERS: readonly BehaviorSliderDefinition[] = Object.freeze([
  // Motion sliders
  {
    id: "retraction",
    group: "Motion",
    label: "Retraction of unused fingers",
    min: 0.0,
    max: 1.0,
    default: 0.1,
    step: 0.01,
    lowLabel: "Stay over the keys",
    highLabel: "Curl well back",
    unit: "%",
    description:
      "How far fingers that aren't playing, and aren't about to, pull back and up toward the palm.",
  },
  {
    id: "finger_curve",
    group: "Motion",
    label: "Finger curvature",
    min: 0.0,
    max: 1.0,
    default: 0.4,
    step: 0.01,
    lowLabel: "Flatter fingers",
    highLabel: "Strongly curved",
    unit: "%",
    description:
      "How curved the fingers are while they press the keys: flatter fingers let the hand sit further back from the keys, curved fingers bring it forward over them.",
  },
  {
    id: "antic_hand",
    group: "Motion",
    label: "Anticipation speed (hand)",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Last moment",
    highLabel: "Very early",
    unit: "%",
    description:
      "How early the whole hand moves into position for the notes coming up.",
  },
  {
    id: "antic_fingers",
    group: "Motion",
    label: "Anticipation speed (fingers)",
    min: -1.0,
    max: 1.0,
    default: 0.5,
    step: 0.05,
    lowLabel: "Just in time",
    highLabel: "Very early",
    unit: "ms ahead",
    description:
      "How early each finger travels to its next key and waits there, ready to strike - a thumb passing under, say.",
  },
  {
    id: "tendon_link",
    group: "Motion",
    label: "Linked fingers (3, 4, 5)",
    min: 0.0,
    max: 1.0,
    default: 0.6,
    step: 0.01,
    lowLabel: "Independent",
    highLabel: "Tightly linked",
    unit: "%",
    description:
      "The tendons of the middle, ring and little fingers are joined: when the middle finger curves down the ring finger goes some way with it.",
  },
  {
    id: "cross_height",
    group: "Motion",
    label: "Crossing height",
    min: 0.0,
    max: 1.0,
    default: 0.33,
    step: 0.01,
    lowLabel: "Skim over",
    highLabel: "Arch high",
    unit: "%",
    description: "How high a finger arches when it crosses over the thumb.",
  },
  {
    id: "lift_height",
    group: "Motion",
    label: "Finger lift height",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Close to the keys",
    highLabel: "High lift",
    unit: "%",
    description: "How high a finger rises above its key before striking it.",
  },
  {
    id: "wrist_bounce",
    group: "Motion",
    label: "Wrist bounce (repeated chords)",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Still wrist",
    highLabel: "Big bounce",
    unit: "%",
    description:
      "In repeated chords and octaves the hand plays from the wrist: it drops onto each chord and springs back up between them.",
  },
  {
    id: "tremolo_rotation",
    group: "Motion",
    label: "Wrist rotation (tremolos)",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Fingers only",
    highLabel: "Strong rotation",
    unit: "%",
    description:
      "In tremolos and other quick alternations between the two sides of the hand, the forearm rotates.",
  },
  {
    id: "gesture_finger_action",
    group: "Motion",
    label: "Finger action in bounces & tremolos",
    min: 0.0,
    max: 1.0,
    default: 0.25,
    step: 0.01,
    lowLabel: "Hand does it all",
    highLabel: "Fingers lift fully",
    unit: "%",
    description:
      "How much the fingers still lift on their own when the wrist bounce or rotation is doing the playing.",
  },
  {
    id: "cross_turn",
    group: "Motion",
    label: "Wrist turn for thumb crossings",
    min: 0.0,
    max: 30.0,
    default: 14.0,
    step: 0.5,
    lowLabel: "Quiet wrist",
    highLabel: "Turns a lot",
    unit: "°",
    description:
      "How far the hand turns toward the little finger while the thumb passes under (and back the other way when a finger crosses over).",
  },
  {
    id: "smoothness",
    group: "Motion",
    label: "Hand motion smoothness",
    min: 0.02,
    max: 0.15,
    default: 0.07,
    step: 0.005,
    lowLabel: "Quick, direct",
    highLabel: "Smooth, flowing",
    unit: "ms",
    description:
      "How much the hand's movements are smoothed: shifts accelerate and settle over this long.",
  },
  {
    id: "early_release",
    group: "Motion",
    label: "Early release before a jump",
    min: 0.05,
    max: 0.4,
    default: 0.22,
    step: 0.01,
    lowLabel: "Legato, late",
    highLabel: "Detached, early",
    unit: "ms",
    description:
      "How early a finger lets go of its key when it has to jump straight to another one.",
  },
  {
    id: "max_speed",
    group: "Motion",
    label: "Top travel speed",
    min: 0.5,
    max: 5.0,
    default: 3.0,
    step: 0.1,
    lowLabel: "Unhurried",
    highLabel: "Virtuoso leaps",
    unit: "m/s",
    description:
      "The fastest any part of the hand - wrist or fingertip - can travel across the keys.",
  },
  {
    id: "key_area_near",
    group: "Motion",
    label: "Playing area on the keys: nearest the edge",
    min: 0.0,
    max: 0.5,
    default: 0.0,
    step: 0.01,
    lowLabel: "Right at the edge",
    highLabel: "Well in",
    unit: "%",
    description:
      "How close to a key's front edge a fingertip may play, as a share of the key's playable length.",
  },
  {
    id: "key_area_far",
    group: "Motion",
    label: "Playing area on the keys: furthest up",
    min: 0.3,
    max: 1.0,
    default: 1.0,
    step: 0.01,
    lowLabel: "Near the edge only",
    highLabel: "Up among the black keys",
    unit: "%",
    description: "How far up a key a fingertip may play.",
  },
  {
    id: "roll_speed",
    group: "Motion",
    label: "Rolled chord speed",
    min: 0.015,
    max: 0.08,
    default: 0.035,
    step: 0.005,
    lowLabel: "Quick roll",
    highLabel: "Slow roll",
    unit: "ms",
    description:
      "Chords too wide for this hand are rolled from the bottom up; this is the time between notes of the roll.",
  },
  // Glissando sliders
  {
    id: "gliss_gap",
    group: "Glissandos",
    label: "Glissando: longest gap between notes",
    min: 0.025,
    max: 0.1,
    default: 0.05,
    step: 0.005,
    lowLabel: "Only the fastest",
    highLabel: "Slower ones too",
    unit: "ms",
    description:
      "A string of keys counts as a glissando only if each note comes at most this long after the one before.",
  },
  {
    id: "gliss_min",
    group: "Glissandos",
    label: "Glissando: fewest notes",
    min: 3,
    max: 16,
    default: 6,
    step: 1,
    lowLabel: "Short flicks too",
    highLabel: "Only long sweeps",
    unit: "notes",
    description:
      "How many notes in a row a string needs to count as a glissando.",
  },
  {
    id: "gliss_merge",
    group: "Glissandos",
    label: "Glissando: stay in the pose between",
    min: 0.25,
    max: 3.0,
    default: 1.0,
    step: 0.05,
    lowLabel: "Only quick returns",
    highLabel: "Long breaks too",
    unit: "s",
    description:
      "Glissandos closer together than this are played without leaving the glissando pose.",
  },
  // Fingering sliders
  {
    id: "weak_bias",
    group: "Fingering",
    label: "Weak finger bias",
    min: 0.0,
    max: 1.0,
    default: 0.25,
    step: 0.01,
    lowLabel: "Use 4 and 5 freely",
    highLabel: "Avoid 4 and 5",
    unit: "%",
    description:
      "Bias against the weaker 4th and 5th fingers when stronger ones would do.",
  },
  {
    id: "stretch_bias",
    group: "Fingering",
    label: "Stretch bias",
    min: -1.0,
    max: 1.0,
    default: 0.0,
    step: 0.05,
    lowLabel: "Shift / cross",
    highLabel: "Stretch",
    unit: "%",
    description:
      "Reach wide intervals by stretching the hand, or by shifting and crossing over/under.",
  },
  {
    id: "economy",
    group: "Fingering",
    label: "Economy of motion",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Ignore finger travel",
    highLabel: "Minimise travel",
    unit: "%",
    description:
      "How much to favour fingerings that keep the fingers close to where a relaxed hand already has them.",
  },
  {
    id: "black_avoid",
    group: "Fingering",
    label: "Thumb and little finger on black keys",
    min: 0.0,
    max: 1.0,
    default: 0.5,
    step: 0.01,
    lowLabel: "Don't mind",
    highLabel: "Avoid strongly",
    unit: "%",
    description:
      "How strongly to avoid putting the thumb (and, less so, the little finger) on black keys.",
  },
]);

// ---------------------------------------------------------------------------
// Behavior option definitions
// ---------------------------------------------------------------------------

export type GlissandoOption = "on" | "off";
export type FingeringModelOption = "learned" | "textbook";
export type ChromaticOption = "12" | "13" | "1234" | "12345" | "231";
export type RepeatedOption = "321" | "12" | "13" | "123" | "1234";
export type TrillOption = "auto" | "12" | "23" | "13" | "14" | "1423";
export type OctavesOption = "4black" | "5";

export type BehaviorOptionKey =
  | "glissando"
  | "fingering_model"
  | "chromatic"
  | "repeated"
  | "trill"
  | "octaves";

export interface BehaviorOptionChoice<T extends string = string> {
  value: T;
  label: string;
  detail?: string;
}

export interface BehaviorOptionDefinition<T extends string = string> {
  id: BehaviorOptionKey;
  group: "Glissandos" | "Fingering";
  label: string;
  default: T;
  options: readonly BehaviorOptionChoice<T>[];
  description: string;
}

export const BEHAVIOR_OPTIONS: readonly BehaviorOptionDefinition[] = Object.freeze([
  {
    id: "glissando",
    group: "Glissandos",
    label: "Glissandos",
    default: "on",
    options: [
      {
        value: "on",
        label: "Detect and slide them",
        detail:
          "A quick string of all-white or all-black keys going one way is played as a glissando: the backs of the fingers slide along the keys",
      },
      {
        value: "off",
        label: "Finger every note",
        detail:
          "Only glissandos marked in the file (fingering editor) are slid; everything else is fingered",
      },
    ],
    description:
      'Whether this pianist spots glissandos and slides them. Glissandos marked in the file ("g" in the fingering editor) are always slid.',
  },
  {
    id: "fingering_model",
    group: "Fingering",
    label: "Fingering model",
    default: "learned",
    options: [
      {
        value: "learned",
        label: "Learned from pianists",
        detail:
          "Weights fitted to how professional pianists finger real repertoire (the PIG dataset)",
      },
      {
        value: "textbook",
        label: "Textbook (Hanon)",
        detail:
          "The original weights, tuned to match Hanon's printed fingering, weak-finger training included",
      },
    ],
    description:
      "The overall cost model behind the fingering. Standard fingerings for scales, arpeggios, octaves and thirds apply either way.",
  },
  {
    id: "chromatic",
    group: "Fingering",
    label: "Chromatic scale fingering",
    default: "13",
    options: [
      {
        value: "13",
        label: "1313123 13131 23…",
        detail: "Traditional: thumb on white keys, 3 on the black keys, 2 on F / C",
      },
      {
        value: "12",
        label: "1212123 12121 23…",
        detail: "1-2: thumb on white keys, 2 on the black keys and on F / C",
      },
      {
        value: "1234",
        label: "1234 123 1234 123…",
        detail: "Groups of up to four fingers, thumbs on white keys",
      },
      {
        value: "12345",
        label: "1234 12345 123…",
        detail: "Thumb on C, E and A; groups of four, five and three",
      },
      {
        value: "231",
        label: "231231 212341…",
        detail: "Thumb on D, F, G and B",
      },
    ],
    description:
      "Fingering for chromatic scales (shown for the right hand going up from C; the left hand mirrors it).",
  },
  {
    id: "repeated",
    group: "Fingering",
    label: "Repeated note fingering",
    default: "321",
    options: [
      {
        value: "321",
        label: "321321…",
        detail: "Hanon's changing fingers 3-2-1 (4-3-2-1 in fours)",
      },
      {
        value: "12",
        label: "121212…",
        detail: "1-2 alternation",
      },
      {
        value: "13",
        label: "131313…",
        detail: "1-3 alternation",
      },
      {
        value: "123",
        label: "123123…",
        detail: "1-2-3 cycling",
      },
      {
        value: "1234",
        label: "12341234…",
        detail: "1-2-3-4 cycling",
      },
    ],
    description: "Fingers for quickly repeated notes on one key.",
  },
  {
    id: "trill",
    group: "Fingering",
    label: "Trill fingering",
    default: "auto",
    options: [
      {
        value: "auto",
        label: "Automatic",
        detail: "Any strong pair (1-2, 1-3, 2-3, 2-4), never 4-5",
      },
      {
        value: "12",
        label: "121212…",
        detail: "1-2 trill",
      },
      {
        value: "23",
        label: "232323…",
        detail: "2-3 trill",
      },
      {
        value: "13",
        label: "131313…",
        detail: "1-3 trill",
      },
      {
        value: "14",
        label: "141414…",
        detail: "1-4 trill",
      },
      {
        value: "1423",
        label: "14231423…",
        detail: "Double trill with 1-4 and 2-3",
      },
    ],
    description:
      "Fingers for trills (the lower note takes the lower finger numbers).",
  },
  {
    id: "octaves",
    group: "Fingering",
    label: "Octave fingering",
    default: "4black",
    options: [
      {
        value: "4black",
        label: "1-5, 4 on black keys",
        detail: "Hanon: 4 on the black keys in octave passages",
      },
      {
        value: "5",
        label: "1-5 always",
        detail: "Thumb and little finger for every octave",
      },
    ],
    description: "Fingers for octaves (the right hand's; the left hand mirrors it).",
  },
]);

// ---------------------------------------------------------------------------
// Combined default behavior
// ---------------------------------------------------------------------------

export const DEFAULT_BEHAVIOR: Readonly<Record<string, number | string | boolean>> =
  Object.freeze({
    retraction: 0.1,
    finger_curve: 0.4,
    antic_hand: 0.5,
    antic_fingers: 0.5,
    tendon_link: 0.6,
    cross_height: 0.33,
    lift_height: 0.5,
    wrist_bounce: 0.5,
    tremolo_rotation: 0.5,
    gesture_finger_action: 0.25,
    cross_turn: 14.0,
    smoothness: 0.07,
    early_release: 0.22,
    max_speed: 3.0,
    key_area_near: 0.0,
    key_area_far: 1.0,
    roll_speed: 0.035,
    glissando: "on",
    gliss_gap: 0.05,
    gliss_min: 6.0,
    gliss_merge: 1.0,
    fingering_model: "learned",
    weak_bias: 0.25,
    stretch_bias: 0.0,
    economy: 0.5,
    black_avoid: 0.5,
    chromatic: "13",
    repeated: "321",
    trill: "auto",
    octaves: "4black",
  });

// ---------------------------------------------------------------------------
// Editing and draft types
// ---------------------------------------------------------------------------

export interface ProfileDraft {
  name: string;
  colorRgb: [number, number, number];
  anatomy: Record<string, number>;
  behavior: Record<string, number | string | boolean>;
  skin?: Record<string, unknown>;
  weights?: Record<string, number>;
}
