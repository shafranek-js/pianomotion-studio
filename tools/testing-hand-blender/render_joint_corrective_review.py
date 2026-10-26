"""Render real joint closeups from the offline measured-axis Blender candidate.

A/B/C: source LBS, Blender Preserve Volume (DQS reference), and the
selected bounded, locally baked morph under exactly the same 60-degree
synthetic, unsigned rest hinge axis. Camera, light, rig and topology match.
These captures DO NOT validate pianist motion or approve export.
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_mcp_comparison import (  # noqa: E402
    configure_render, locate, prepare_camera, look_at,
)

CASES = (
    ("ring-mcp", "ring-finger-phalanx-proximal", "pmcorr_ring_mcp_060"),
    ("pinky-dip", "pinky-finger-phalanx-distal", "pmcorr_pinky_dip_060"),
)


def main():
    rest = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--axes", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--side", choices=("left", "right"), required=True)
    params = parser.parse_args(rest)
    if not params.input.is_file() or not params.axes.is_file():
        raise FileNotFoundError("Missing real offline corrective .blend or matching axes")
    axes = json.loads(params.axes.read_text("utf8"))
    if axes["side"] != params.side or axes["schema"] != "testing-unsigned-hinge-axes-v1":
        raise ValueError("The visual review axes do not match this hand")
    if axes["anatomicalAxesCalibrated"] or axes["exportApproved"]:
        raise ValueError("Unapproved axes must not be represented as calibrated")
    axis_by_bone = {row["bone"]: row["axisBoneLocalUnsigned"] for row in axes["joints"]}
    bpy.ops.wm.open_mainfile(filepath=str(params.input.resolve()))
    arm, mesh, skin = locate()
    keys = mesh.data.shape_keys.key_blocks
    if keys is None:
        raise ValueError("Corrective .blend is missing the baked shape keys")
    if any(name not in axis_by_bone or keys.get(shape) is None
           for _, name, shape in CASES):
        raise ValueError("Missing measured rest hinge axes or baked corrective shapes")
    for key in keys:
        key.value = 0
    camera, _, lateral, normal, forward, framing = prepare_camera(arm, mesh)
    configure_render()
    # Shared framing for each A/B/C triplet: no auto-framing per shape.
    bpy.context.scene.cycles.samples = 12
    bpy.context.scene.render.resolution_x = 960
    bpy.context.scene.render.resolution_y = 960
    params.output_dir.mkdir(parents=True, exist_ok=True)
    reports = []

    for short, bone_name, shape_name in CASES:
        joint = arm.pose.bones[bone_name]
        shape = keys[shape_name]
        axis = Vector(axis_by_bone[bone_name])
        if not all(math.isfinite(float(x)) for x in axis) or abs(axis.length - 1) > .001:
            raise ValueError("Invalid rest hinge axis: " + bone_name)
        if axis.x < 0:
            axis.negate()
        center = arm.matrix_world @ arm.data.bones[bone_name].head_local
        # Joint-side/palmar 3/4 view rather than a whole-hand shot: expose
        # crease compression and dorsal contour near the rotating phalanx.
        camera.location = (center + lateral * framing * .85
                           + normal * framing * .50
                           - forward * framing * .15)
        look_at(camera, center)
        camera.data.ortho_scale = max(.080, framing * .32)

        old_mode, old_rotation = joint.rotation_mode, joint.rotation_quaternion.copy()
        try:
            joint.rotation_mode = "QUATERNION"
            joint.rotation_quaternion = Quaternion(axis, math.radians(60))
            for variant, preserve_volume, value in (
                ("lbs", False, 0.0),
                ("preserve-volume", True, 0.0),
                ("bounded-corrective", False, 1.0),
            ):
                skin.use_deform_preserve_volume = preserve_volume
                shape.value = value
                bpy.context.view_layer.update()
                filename = f"{params.side}-{short}-060-{variant}-joint-closeup.png"
                destination = params.output_dir / filename
                bpy.context.scene.render.filepath = str(destination.resolve())
                bpy.ops.render.render(write_still=True)
                if not destination.is_file() or destination.stat().st_size < 15000:
                    raise ValueError(f"Missing or empty actual Blender joint render: {filename}")
                reports.append({
                    "side": params.side, "bone": bone_name,
                    "morphName": shape_name, "variant": variant,
                    "image": filename, "jointBendDegrees": 60,
                    "anatomicallyApproved": False,
                })
                print("[Testing bounded joint render]", filename)
        finally:
            shape.value = 0
            skin.use_deform_preserve_volume = False
            joint.rotation_quaternion = old_rotation
            joint.rotation_mode = old_mode
    if len(reports) != 6:
        raise ValueError("Expected six real joint A/B/C images per hand")
    output = params.output_dir / f"{params.side}-bounded-joint-review.json"
    output.write_text(json.dumps({
        "schema": "testing-joint-abc-blender-v1",
        "source": str(params.input), "side": params.side, "images": reports,
        "axisAnatomicallyCalibrated": False,
        "humanVisualReviewAccepted": False, "exportApproved": False,
    }, indent=2), encoding="utf8")


if __name__ == "__main__":
    main()
