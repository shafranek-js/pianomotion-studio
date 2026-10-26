"""Build a standalone comparison gallery from *actual* Blender-rendered PNGs.

No inferred results: fails when left/right manifests or any image are absent.
The gallery is evidence for human review, never an export/acceptance signal.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path
from urllib.parse import quote

JOINTS = (
    ("ring-finger-phalanx-proximal", "Ring finger — MCP"),
    ("pinky-finger-phalanx-distal", "Little finger — DIP"),
)
ANGLES = (0, 30, 60, 90)
MATERIALS = ("textured", "clay")
BASE_VARIANTS = ("lbs",)
SIXTY_VARIANTS = ("lbs", "preserve-volume", "bounded-corrective")
SIDES = ("left", "right")


def load_and_check(directory: Path, side: str) -> dict:
    path = directory / f"{side}-bounded-joint-review.json"
    report = json.loads(path.read_text(encoding="utf8"))
    if (report.get("schema") != "testing-joint-material-pose-blender-v2"
            or report.get("side") != side
            or report.get("exportApproved") is not False
            or report.get("humanVisualReviewAccepted") is not False
            or report.get("physiologicalFlexionSignCalibrated") is not False):
        raise ValueError(f"Missing safe review contract: {path}")
    mapping = {}
    for row in report["images"]:
        key = (row["bone"], row["jointBendDegrees"], row["variant"],
               row["materialMode"])
        name = row["image"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+\.png", name):
            raise ValueError(f"Unsafe or missing image filename: {name!r}")
        if key in mapping:
            raise ValueError(f"Duplicate frame: {side}, {key}")
        if row.get("anatomicallyApproved") is not False:
            raise ValueError("Uncalibrated frames must not be marked accepted")
        image = directory / name
        if not image.is_file() or image.stat().st_size < 15000:
            raise FileNotFoundError(f"Actual Blender image missing: {image}")
        mapping[key] = name
    expected = {
        (bone, angle, variant, material)
        for bone, _ in JOINTS
        for angle in ANGLES
        for variant in (SIXTY_VARIANTS if angle == 60 else BASE_VARIANTS)
        for material in MATERIALS
    }
    if set(mapping) != expected or len(mapping) != 24:
        raise ValueError(f"Incomplete pose/material coverage for {side}: "
                         f"missing {expected - set(mapping)}, extra {set(mapping) - expected}")
    return mapping


def build(directory: Path) -> str:
    maps = {side: load_and_check(directory, side) for side in SIDES}
    blocks = []
    for side in SIDES:
        blocks.append(f'<section class="hand" id="{side}"><h2>{side.title()} hand</h2>')
        for bone, title in JOINTS:
            blocks.append(f'<section class="joint"><h3>{html.escape(title)}</h3>')
            for angle in ANGLES:
                blocks.append(f'<section class="angle"><h4>{angle}° — '
                              + ("A/B/C at authored pose" if angle == 60
                                 else "LBS baseline only") + "</h4>")
                variants = SIXTY_VARIANTS if angle == 60 else BASE_VARIANTS
                for variant in variants:
                    blocks.append(f'<div class="comparison"><h5>{html.escape(variant)}</h5>'
                                  '<div class="images">')
                    for material in MATERIALS:
                        filename = maps[side][(bone, angle, variant, material)]
                        blocks.append(
                            f'<figure><a href="{quote(filename)}">'
                            f'<img loading="lazy" src="{quote(filename)}" '
                            f'alt="{html.escape(side)} {html.escape(title)} '
                            f'{angle} degrees {html.escape(variant)} '
                            f'{material}"></a>'
                            f'<figcaption>{html.escape(material.title())}</figcaption>'
                            '</figure>'
                        )
                    blocks.append("</div></div>")
                blocks.append("</section>")
            blocks.append("</section>")
        blocks.append("</section>")
    css = """
:root { color-scheme: dark; font-family: system-ui, sans-serif; }
body { background: #181b20; color: #e9e9e9; margin: 0 auto;
       padding: 1.5rem; max-width: 1250px; line-height: 1.5; }
a { color: #a9c5eb; }
header { border-bottom: 1px solid #51545b; margin-bottom: 1.5rem; }
.note { padding: .8rem 1rem; border-left: 3px solid #aeb7c5;
        background: #252932; }
.hand { border-top: 2px solid #6b7380; margin-top: 2rem; }
.joint { margin: 1.5rem 0 2rem; }
.angle { border-top: 1px solid #41464d; margin-top: 1rem; }
.comparison { margin-bottom: 1.2rem; }
h5 { margin: .5rem 0; font-size: 1rem; text-transform: uppercase; }
.images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: .65rem; }
figure { margin: 0; background: #252932; padding: .35rem; }
img { display: block; width: 100%; height: auto; }
figcaption { text-align: center; font-size: .85rem; padding: .2rem; }
@media (max-width: 620px) {
  .images { grid-template-columns: 1fr; }
}
"""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>PianoMotion Testing — real Blender joint evidence</title>'
        f'<style>{css}</style></head><body>'
        '<header><h1>Testing hand: real Blender joint evidence</h1>'
        '<p>Original textured material versus neutral clay without shader '
        'normal maps. Identical mesh, light and camera per joint.</p>'
        '<p><a href="#left">Left hand</a> · '
        '<a href="#right">Right hand</a></p></header>'
        '<p class="note"><strong>Research only — NOT visually approved.</strong> '
        'Joint bend axes and flexion signs are not anatomically calibrated. '
        'The 60° bounded corrective is never extrapolated to other angles. '
        'Images cannot prove natural pianist movement, thumb opposition, '
        'key contact, all-LOD quality or export readiness.</p>'
        + "".join(blocks) + "</body></html>"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    directory = args.input_dir.resolve()
    if not directory.is_dir():
        raise NotADirectoryError(directory)
    page = build(directory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page, encoding="utf8")
    print("[Testing hand gallery]", args.output, "48 verified real PNGs")


if __name__ == "__main__":
    main()
