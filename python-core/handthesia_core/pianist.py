"""
pianist.py - Pianists: a name, hand colour, hand anatomy (the lengths of the
19 bones of the hand) and technique preferences, saved as JSON files in the
"pianists" folder next to this file. One pianist is "active": the hand
animation, the fingering planner and the hand split use them in every mode.

Anatomy is stored in the hand model's own units (see hands.py; one unit is
about 1.09 cm on the drawn keyboard's real scale).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
DEFAULT_ID = "default"

# --------------------------------------------------------------------------- #
# Anatomy: 5 metacarpals + 14 phalanges
# --------------------------------------------------------------------------- #
FINGER_WORD = {1: "Thumb", 2: "Index", 3: "Middle", 4: "Ring", 5: "Little"}
BONE_WORD = {"mc": "metacarpal", "pp": "proximal phalanx", "mp": "middle phalanx", "dp": "distal phalanx"}

# bone id -> (finger, kind); thumb has no middle phalanx
BONES = [("mc1", 1, "mc"), ("pp1", 1, "pp"), ("dp1", 1, "dp")]
for _f in range(2, 6):
    BONES += [(f"mc{_f}", _f, "mc"), (f"pp{_f}", _f, "pp"), (f"mp{_f}", _f, "mp"), (f"dp{_f}", _f, "dp")]
BONE_IDS = [b[0] for b in BONES]
BONE_INFO = {b[0]: (b[1], b[2]) for b in BONES}
METACARPALS = [b for b in BONE_IDS if b.startswith("mc")]
PHALANGES = [b for b in BONE_IDS if not b.startswith("mc")]

# The default hand (the model the animation was built on): metacarpals 2-5 are
# the distances from their base to the knuckle in hands.py; the rest are the
# phalanx lengths there.
DEFAULT_ANATOMY = {
    "mc1": 4.7, "pp1": 3.3, "dp1": 2.8,
    "mc2": 6.684, "pp2": 4.0, "mp2": 2.3, "dp2": 1.8,
    "mc3": 6.626, "pp3": 4.5, "mp3": 2.7, "dp3": 1.9,
    "mc4": 6.332, "pp4": 4.2, "mp4": 2.6, "dp4": 1.9,
    "mc5": 5.974, "pp5": 3.3, "mp5": 1.8, "dp5": 1.7,
}
# Each bone may be 70%..250% of the default: from a small (child's or
# petite adult's) hand to well past the largest pianists' (Rachmaninoff's 13th
# needs about 205% metacarpals with 135% phalanges; everything at 250% spans an
# 18th), in any proportion. (The metacarpals have a limit of their own,
# METACARPAL_MAX, should they ever need a different one.)
BONE_MIN, BONE_MAX = 0.70, 2.50
METACARPAL_MAX = 2.50


# The wrist's width, as a share of the default hand's (anatomy["wrist"]; none = 100%): 75%..200%. Not a bone, so
# it isn't in DEFAULT_ANATOMY (which the bone sliders and limits walk).
WRIST, WRIST_MIN, WRIST_MAX = "wrist", 0.75, 2.0


def clamp_wrist(v):
    return max(WRIST_MIN, min(WRIST_MAX, float(v)))


def bone_max(bid):
    """The most a bone may be, as a share of its default length."""
    return METACARPAL_MAX if BONE_INFO[bid][1] == "mc" else BONE_MAX


def bone_name(bid):
    f, kind = BONE_INFO[bid]
    return f"{FINGER_WORD[f]} {BONE_WORD[kind]}"


def clamp_bone(bid, v):
    d = DEFAULT_ANATOMY[bid]
    return max(d * BONE_MIN, min(d * bone_max(bid), v))


# --------------------------------------------------------------------------- #
# Behaviour
# --------------------------------------------------------------------------- #
# kind "slider": min, max, default, fmt(value)->str, lo/hi end labels
# kind "options": [(value, label, detail)], default
def _pct(v): return f"{int(round(v * 100))}%"
def _ms(v): return f"{int(round(v * 1000))} ms"
def _deg(v): return f"{int(round(v))}°"
def _mps(v): return f"{v:.1f} m/s"
def _sec(v): return f"{v:.2f} s"
def _notes(v): return f"{int(round(v))} notes"


def finger_lead(a):
    """
    (longest head start in s, share of it spent travelling) for the finger
    anticipation setting a (-1..1): from 0 to 1 a finger may set off 0.4 to
    1.4 s ahead and arrive early to hover; below 0 it sets off later and
    later (0.05 s at -1) and arrives just in time.
    """
    if a >= 0:
        return 0.4 + a, 0.9 - 0.6 * a
    return 0.4 + 0.35 * a, 0.9 - 0.1 * a


def _lead(v):
    return f"{int(round(finger_lead(v)[0] * 1000))} ms ahead"
def _bias(v):
    if abs(v) < 0.05:
        return "neutral"
    return f"{int(round(abs(v) * 100))}% toward {'stretching' if v > 0 else 'shifting / crossing'}"


BEHAVIORS = [
    # ---- motion (hands.py)
    dict(id="retraction", group="Motion", label="Retraction of unused fingers", kind="slider",
         min=0.0, max=1.0, default=0.1, fmt=_pct, lo="Stay over the keys", hi="Curl well back",
         desc="How far fingers that aren't playing, and aren't about to, pull back and up "
              "toward the palm."),
    dict(id="finger_curve", group="Motion", label="Finger curvature", kind="slider",
         min=0.0, max=1.0, default=0.4, fmt=_pct, lo="Flatter fingers", hi="Strongly curved",
         desc="How curved the fingers are while they press the keys: flatter fingers let the hand sit "
              "further back from the keys, curved fingers bring it forward over them."),
    dict(id="antic_hand", group="Motion", label="Anticipation speed (hand)", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Last moment", hi="Very early",
         desc="How early the whole hand moves into position for the notes coming up."),
    dict(id="antic_fingers", group="Motion", label="Anticipation speed (fingers)", kind="slider",
         min=-1.0, max=1.0, default=0.5, fmt=_lead, lo="Just in time", hi="Very early",
         desc="How early each finger travels to its next key and waits there, ready to strike - "
              "a thumb passing under, say. The value is the longest head start; a finger never "
              "leaves before it has let go of its last key, and never so late that it would have "
              "to move faster than the top travel speed."),
    dict(id="tendon_link", group="Motion", label="Linked fingers (3, 4, 5)", kind="slider",
         min=0.0, max=1.0, default=0.6, fmt=_pct, lo="Independent", hi="Tightly linked",
         desc="The tendons of the middle, ring and little fingers are joined: when the middle finger "
              "curves down the ring finger goes some way with it, and the other way round, and the "
              "little finger takes both with it - unless they're reaching for keys of their own."),
    dict(id="cross_height", group="Motion", label="Crossing height", kind="slider",
         min=0.0, max=1.0, default=0.33, fmt=_pct, lo="Skim over", hi="Arch high",
         desc="How high a finger arches when it crosses over the thumb."),
    dict(id="lift_height", group="Motion", label="Finger lift height", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Close to the keys", hi="High lift",
         desc="How high a finger rises above its key before striking it."),
    dict(id="wrist_bounce", group="Motion", label="Wrist bounce (repeated chords)", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Still wrist", hi="Big bounce",
         desc="In repeated chords and octaves the hand plays from the wrist: it drops onto each chord "
              "and springs back up between them. This sets how high it springs."),
    dict(id="tremolo_rotation", group="Motion", label="Wrist rotation (tremolos)", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Fingers only", hi="Strong rotation",
         desc="In tremolos and other quick alternations between the two sides of the hand, the forearm "
              "rotates, rocking the thumb side and the little-finger side down in turn."),
    dict(id="gesture_finger_action", group="Motion", label="Finger action in bounces & tremolos",
         kind="slider", min=0.0, max=1.0, default=0.25, fmt=_pct, lo="Hand does it all",
         hi="Fingers lift fully",
         desc="How much the fingers still lift on their own when the wrist bounce or rotation is "
              "doing the playing (repeated chords, tremolos)."),
    dict(id="cross_turn", group="Motion", label="Wrist turn for thumb crossings", kind="slider",
         min=0.0, max=30.0, default=14.0, fmt=_deg, lo="Quiet wrist", hi="Turns a lot",
         desc="How far the hand turns toward the little finger while the thumb passes under "
              "(and back the other way when a finger crosses over)."),
    dict(id="smoothness", group="Motion", label="Hand motion smoothness", kind="slider",
         min=0.02, max=0.15, default=0.07, fmt=_ms, lo="Quick, direct", hi="Smooth, flowing",
         desc="How much the hand's movements are smoothed: shifts accelerate and settle over "
              "this long."),
    dict(id="early_release", group="Motion", label="Early release before a jump", kind="slider",
         min=0.05, max=0.40, default=0.22, fmt=_ms, lo="Legato, late", hi="Detached, early",
         desc="How early a finger lets go of its key when it has to jump straight to another one. "
              "This changes what you hear (without the pedal)."),
    dict(id="max_speed", group="Motion", label="Top travel speed", kind="slider",
         min=0.5, max=5.0, default=3.0, fmt=_mps, lo="Unhurried", hi="Virtuoso leaps",
         desc="The fastest any part of the hand - wrist or fingertip - can travel across the keys. "
              "Fingerings and the split between the hands are chosen so the hands never need to "
              "move faster; when the music still asks for more, the key is let go earlier or struck "
              "late, and that is what you hear."),
    dict(id="key_area_near", group="Motion", label="Playing area on the keys: nearest the edge",
         kind="slider", min=0.0, max=0.5, default=0.0, fmt=_pct, lo="Right at the edge", hi="Well in",
         desc="How close to a key's front edge a fingertip may play, as a share of the key's playable "
              "length (on white keys, up to just past the black keys). Loud notes are played near this end."),
    dict(id="key_area_far", group="Motion", label="Playing area on the keys: furthest up",
         kind="slider", min=0.3, max=1.0, default=1.0, fmt=_pct, lo="Near the edge only", hi="Up among the black keys",
         desc="How far up a key a fingertip may play. Within this area the loudness decides: soft notes "
              "may use all of it, loud ones only the front part, where the key has more leverage."),
    dict(id="roll_speed", group="Motion", label="Rolled chord speed", kind="slider",
         min=0.015, max=0.08, default=0.035, fmt=_ms, lo="Quick roll", hi="Slow roll",
         desc="Chords too wide for this hand are rolled from the bottom up; this is the time "
              "between the notes of the roll."),
    # ---- glissandos (glissando.py, hands.py)
    dict(id="glissando", group="Glissandos", label="Glissandos", kind="options", default="on",
         options=[("on", "Detect and slide them", "A quick string of all-white or all-black keys going one "
                   "way is played as a glissando: the backs of the fingers slide along the keys"),
                  ("off", "Finger every note", "Only glissandos marked in the file (fingering editor) "
                   "are slid; everything else is fingered")],
         desc="Whether this pianist spots glissandos and slides them. Glissandos marked in the file "
              "(\"g\" in the fingering editor) are always slid."),
    dict(id="gliss_gap", group="Glissandos", label="Glissando: longest gap between notes", kind="slider",
         min=0.025, max=0.10, default=0.05, step=0.005, fmt=_ms, lo="Only the fastest", hi="Slower ones too",
         desc="A string of keys counts as a glissando only if each note comes at most this long after the "
              "one before."),
    dict(id="gliss_min", group="Glissandos", label="Glissando: fewest notes", kind="slider",
         min=3, max=16, default=6, step=1, fmt=_notes, lo="Short flicks too", hi="Only long sweeps",
         desc="How many notes in a row a string needs to count as a glissando."),
    dict(id="gliss_merge", group="Glissandos", label="Glissando: stay in the pose between", kind="slider",
         min=0.25, max=3.0, default=1.0, step=0.05, fmt=_sec, lo="Only quick returns", hi="Long breaks too",
         desc="Glissandos closer together than this (with nothing else for the hand to play in between) "
              "are played without leaving the glissando pose - the hand just travels to the next one."),
    # ---- fingering (fingering.py / figures.py / hand_split.py)
    dict(id="fingering_model", group="Fingering", label="Fingering model", kind="options",
         default="learned",
         options=[("learned", "Learned from pianists", "Weights fitted to how professional pianists "
                   "finger real repertoire (the PIG dataset)"),
                  ("textbook", "Textbook (Hanon)", "The original weights, tuned to match Hanon's "
                   "printed fingering, weak-finger training included")],
         desc="The overall cost model behind the fingering. Standard fingerings for scales, "
              "arpeggios, octaves and thirds apply either way; the other settings here adjust it."),
    dict(id="weak_bias", group="Fingering", label="Weak finger bias", kind="slider",
         min=0.0, max=1.0, default=0.25, fmt=_pct, lo="Use 4 and 5 freely", hi="Avoid 4 and 5",
         desc="Bias against the weaker 4th and 5th fingers when stronger ones would do. "
              "Every note is still played."),
    dict(id="stretch_bias", group="Fingering", label="Stretch bias", kind="slider",
         min=-1.0, max=1.0, default=0.0, fmt=_bias, lo="Shift / cross", hi="Stretch",
         desc="Reach wide intervals by stretching the hand, or by shifting and crossing over/under. "
              "The reach itself comes from this pianist's anatomy."),
    dict(id="economy", group="Fingering", label="Economy of motion", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Ignore finger travel", hi="Minimise travel",
         desc="How much to favour fingerings that keep the fingers close to where a relaxed hand "
              "already has them, weighing how far each finger must travel against the time it has."),
    dict(id="black_avoid", group="Fingering", label="Thumb and little finger on black keys", kind="slider",
         min=0.0, max=1.0, default=0.5, fmt=_pct, lo="Don't mind", hi="Avoid strongly",
         desc="How strongly to avoid putting the thumb (and, less so, the little finger) on black keys."),
    dict(id="chromatic", group="Fingering", label="Chromatic scale fingering", kind="options",
         default="13",
         options=[("12", "1212123 12121 23…", "1-2: thumb on white keys, 2 on the black keys and on F / C"),
                  ("13", "1313123 13131 23…", "Traditional: thumb on white keys, 3 on the black keys, 2 on F / C"),
                  ("1234", "1234 123 1234 123…", "Groups of up to four fingers, thumbs on white keys"),
                  ("12345", "1234 12345 123…", "Thumb on C, E and A; groups of four, five and three"),
                  ("231", "231231 212341…", "Thumb on D, F, G and B")],
         desc="Fingering for chromatic scales (shown for the right hand going up from C; "
              "the left hand mirrors it)."),
    dict(id="repeated", group="Fingering", label="Repeated note fingering", kind="options",
         default="321",
         options=[("321", "321321…", "Hanon's changing fingers 3-2-1 (4-3-2-1 in fours)"),
                  ("12", "121212…", ""), ("13", "131313…", ""),
                  ("123", "123123…", ""), ("1234", "12341234…", "")],
         desc="Fingers for quickly repeated notes on one key."),
    dict(id="trill", group="Fingering", label="Trill fingering", kind="options",
         default="auto",
         options=[("auto", "Automatic", "Any strong pair (1-2, 1-3, 2-3, 2-4), never 4-5"),
                  ("12", "121212…", ""), ("23", "232323…", ""), ("13", "131313…", ""),
                  ("14", "141414…", ""), ("1423", "14231423…", "")],
         desc="Fingers for trills (the lower note takes the lower finger numbers)."),
    dict(id="octaves", group="Fingering", label="Octave fingering", kind="options",
         default="4black",
         options=[("4black", "1-5, 4 on black keys", "Hanon: 4 on the black keys in octave passages"),
                  ("5", "1-5 always", "Thumb and little finger for every octave")],
         desc="Fingers for octaves (the right hand's; the left hand mirrors it)."),
]
BEHAVIOR = {b["id"]: b for b in BEHAVIORS}
DEFAULT_BEHAVIOR = {b["id"]: b["default"] for b in BEHAVIORS}


def normalize_behavior(values, strict=False):
    """
    A behavior mapping checked against BEHAVIORS.

    Slider values are coerced to numbers and clamped to their spec range, so a
    profile can never install an out-of-range speed, smoothing time or other
    constant that the rest of the model divides by. Option values must be one
    of the spec's options; anything else keeps the default. Unknown keys are
    ignored, matching `Pianist.from_json`.

    With strict=True a malformed value raises ValueError instead of falling
    back to the default, so the API reports a bad profile rather than silently
    repairing it.
    """
    behavior = dict(DEFAULT_BEHAVIOR)
    if values is None:
        return behavior
    if not isinstance(values, dict):
        raise ValueError("profile behavior must be an object")
    for key, value in values.items():
        spec = BEHAVIOR.get(key)
        if spec is None:
            continue
        if spec["kind"] == "slider":
            if isinstance(value, bool) or value is None:
                if strict:
                    raise ValueError(f"profile.behavior.{key} must be a finite number")
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                if strict:
                    raise ValueError(f"profile.behavior.{key} must be a finite number")
                continue
            if not math.isfinite(number):
                if strict:
                    raise ValueError(f"profile.behavior.{key} must be a finite number")
                continue
            behavior[key] = max(spec["min"], min(spec["max"], number))
        else:
            allowed = [option[0] for option in spec["options"]]
            if isinstance(value, str) and value in allowed:
                behavior[key] = value
            elif strict:
                raise ValueError(f"profile.behavior.{key} must be one of: " + ", ".join(allowed))
    return behavior


# --------------------------------------------------------------------------- #
# The pianist
# --------------------------------------------------------------------------- #
@dataclass
class Pianist:
    name: str
    id: str = ""
    color: tuple = (12, 12, 14)
    anatomy: dict = field(default_factory=lambda: dict(DEFAULT_ANATOMY))
    behavior: dict = field(default_factory=lambda: dict(DEFAULT_BEHAVIOR))
    created: float = 0.0
    modified: float = 0.0
    skin: dict = field(default_factory=dict)      # how the hands look (skins.py)
    weights: dict = field(default_factory=dict)   # fine-tuned fingering weights: id -> value (fingering.FINE_TUNE)

    @property
    def builtin(self):
        return self.id == DEFAULT_ID

    def copy(self):
        import copy
        return Pianist(self.name, self.id, tuple(self.color), dict(self.anatomy), dict(self.behavior),
                       self.created, self.modified, copy.deepcopy(self.skin_settings()), dict(self.weights))

    def skin_settings(self):
        """Return just the color data used by the numerical pose record."""
        skin = dict(self.skin or {})
        colors = dict(skin.get("colors") or {})
        skeleton = dict(colors.get("skeleton") or {})
        skeleton.setdefault("bone", list(self.color))
        colors["skeleton"] = skeleton
        skin["colors"] = colors
        return skin

    @property
    def badge_color(self):
        return tuple(self.color)

    def b(self, key):
        """A behaviour value (the default if it isn't set)."""
        return self.behavior.get(key, DEFAULT_BEHAVIOR[key])

    def to_json(self):
        return {"name": self.name, "color": list(self.color), "anatomy": self.anatomy,
                "behavior": self.behavior, "created": self.created, "modified": self.modified,
                "skin": self.skin_settings(), "weights": self.weights}

    @classmethod
    def from_json(cls, pid, d):
        anatomy = dict(DEFAULT_ANATOMY)
        for k, v in (d.get("anatomy") or {}).items():
            if k in anatomy:
                anatomy[k] = clamp_bone(k, float(v))
            elif k == WRIST:
                try:
                    anatomy[WRIST] = clamp_wrist(v)
                except (TypeError, ValueError):
                    pass
        behavior = dict(DEFAULT_BEHAVIOR)
        for k, v in (d.get("behavior") or {}).items():
            spec = BEHAVIOR.get(k)
            if not spec:
                continue
            if spec["kind"] == "slider":
                behavior[k] = max(spec["min"], min(spec["max"], float(v)))
            elif v in [o[0] for o in spec["options"]]:
                behavior[k] = v
        color = tuple(max(0, min(255, int(c))) for c in (d.get("color") or (12, 12, 14))[:3])
        skin = dict(d.get("skin") or {})
        from .fingering import FINE_TUNE_IDS
        weights = {}
        for k, v in (d.get("weights") or {}).items():
            try:
                if k in FINE_TUNE_IDS:
                    weights[k] = max(0.0, float(v))
            except (TypeError, ValueError):
                pass
        return cls(str(d.get("name") or pid), pid, color, anatomy, behavior,
                   float(d.get("created", 0)), float(d.get("modified", 0)), skin, weights)

    # ----- derived measures ---------------------------------------------------
    def span_whites(self):
        """Comfortable thumb-to-little-finger stretch, in white keys (key centre to key centre)."""
        from .hands import hand_span_inches, WHITE_KEY_IN
        return hand_span_inches(self.anatomy) / WHITE_KEY_IN

    def span_semitones(self):
        return self.span_whites() * 12.0 / 7.0

    def span_label(self):
        from .hands import hand_span_inches
        return f"{interval_name(self.span_whites())}  ·  {hand_span_inches(self.anatomy) * 2.54:.1f} cm"

    def size_class(self):
        w = self.span_whites()                       # the default hand spans 8 (a 9th)
        return "Small" if w < 7.6 else "Medium" if w < 8.6 else "Large"


def default_pianist():
    return Pianist("Default", DEFAULT_ID, created=0.0, modified=0.0,
                   skin={"style": "cartoon", "colors": {"skeleton": {"bone": [12, 12, 14]}}})


def _ordinal(n):
    return {1: "unison", 8: "octave"}.get(n, f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}")


def interval_name(whites):
    """A white-key distance (key centres) as an interval: 7 -> octave, 8 -> 9th, 9 -> 10th."""
    n = int(math.floor(whites + 0.15)) + 1
    return _ordinal(n)


# --------------------------------------------------------------------------- #
# Explicit per-job profile context
# --------------------------------------------------------------------------- #
def active():
    """Compatibility default; web jobs always pass their resolved profile."""
    return default_pianist()


def from_profile_dto(profile):
    """Translate the versioned profile DTO into the numeric profile model."""
    if profile is None:
        return default_pianist()
    if not isinstance(profile, dict):
        profile = profile.model_dump() if hasattr(profile, "model_dump") else vars(profile)
    return Pianist(
        str(profile.get("name") or profile.get("profileId") or DEFAULT_ID),
        str(profile.get("profileId") or DEFAULT_ID),
        tuple(profile.get("colorRgb") or (12, 12, 14)),
        dict(profile.get("anatomy") or DEFAULT_ANATOMY),
        normalize_behavior(profile.get("behavior")),
        float(profile.get("createdAtUnixSeconds", 0.0)),
        float(profile.get("modifiedAtUnixSeconds", 0.0)),
        dict(profile.get("skin") or {"style": "cartoon"}),
        dict(profile.get("weights") or {}),
    )
