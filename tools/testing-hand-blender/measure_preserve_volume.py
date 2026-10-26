"""Evaluate DQS (Preserve Volume) against linear skinning on actual hands.

Diagnostic only: compare identical *synthetic* MCP/thumb rotations of the
imported rig at 30, 60 and 90 degrees. Armature-local X is a temporary
standardized test axis, not yet an anatomically calibrated flexion axis.
Do not export these deformations or deploy them as piano animation.

Blender usage:
  blender -b -t 2 --python-exit-code 2 --python \
    tools/testing-hand-blender/measure_preserve_volume.py -- \
    --input scratch/blender-correctives/left-lod0.blend \
    --report scratch/blender-correctives/left-preserve-volume.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


BONES = (
    "index-finger-phalanx-proximal",
    "middle-finger-phalanx-proximal",
    "ring-finger-phalanx-proximal",
    "thumb-metacarpal",
)


def args():
    rest = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    return parser.parse_args(rest)


def locate():
    candidates = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE" or not all(b in arm.pose.bones for b in BONES):
            continue
        for mesh in bpy.data.objects:
            if mesh.type != "MESH":
                continue
            modifiers = [m for m in mesh.modifiers if m.type == "ARMATURE" and m.object == arm]
            if len(modifiers) == 1:
                candidates.append((arm, mesh, modifiers[0]))
    if len(candidates) != 1:
        raise ValueError(f"Require exactly one skinned hand, found {len(candidates)}")
    return candidates[0]


def evaluated_vertices(mesh):
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(deps)
    temp = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=deps)
    if temp is None:
        raise RuntimeError("Cannot evaluate Blender deformed hand mesh")
    try:
        return [v.co.copy() for v in temp.vertices]
    finally:
        evaluated.to_mesh_clear()


def area(verts, triangle):
    a, b, c = (verts[i] for i in triangle)
    return (b - a).cross(c - a).length * 0.5


def measure(bind, posed, triangles):
    values = []
    below_half = 0
    below_quarter = 0
    above_double = 0
    for triangle in triangles:
        rest = area(bind, triangle)
        if rest <= 1e-12:
            continue
        ratio = area(posed, triangle) / rest
        if not math.isfinite(ratio):
            raise ValueError("Nonfinite deformation area")
        values.append(ratio)
        below_half += ratio < 0.5
        below_quarter += ratio < 0.25
        above_double += ratio > 2
    values.sort()
    if not values:
        raise ValueError("No valid triangles for test")
    return {
        "triangles": len(values),
        "collapsedBelowHalf": below_half,
        "collapsedBelowQuarter": below_quarter,
        "expandedAboveDouble": above_double,
        "p05AreaRatio": values[int(0.05 * (len(values) - 1))],
        "p95AreaRatio": values[int(0.95 * (len(values) - 1))],
        "minAreaRatio": values[0],
        "maxAreaRatio": values[-1],
    }


def main():
    args_ = args()
    if not args_.input.is_file():
        raise FileNotFoundError(args_.input)
    bpy.ops.wm.open_mainfile(filepath=str(args_.input.resolve()))
    arm, mesh, modifier = locate()
    basis = [v.co.copy() for v in mesh.data.vertices]
    triangles = [
        tuple(loop.vertices) for poly in mesh.data.polygons
        for loop in poly.loop_triangles
    ] if False else []
    mesh.data.calc_loop_triangles()
    triangles = [tuple(t.vertices) for t in mesh.data.loop_triangles]
    results = []

    for bone_name in BONES:
        pbone = arm.pose.bones[bone_name]
        original_mode = pbone.rotation_mode
        original_rotation = pbone.rotation_quaternion.copy()
        try:
            pbone.rotation_mode = "QUATERNION"
            for degrees in (30, 60, 90):
                pbone.rotation_quaternion = Quaternion((1, 0, 0), math.radians(degrees))
                modifier.use_deform_preserve_volume = False
                linear = evaluated_vertices(mesh)
                modifier.use_deform_preserve_volume = True
                quaternion = evaluated_vertices(mesh)
                if len(linear) != len(basis) or len(quaternion) != len(basis):
                    raise ValueError("Subdivision altered topology; cannot compare skinned mesh")
                drift = [(a - b).length for a, b in zip(linear, quaternion)]
                drift.sort()
                metric = {
                    "bone": bone_name,
                    "degrees": degrees,
                    "axis": "armature local +X (synthetic, not clinically calibrated)",
                    "lbs": measure(basis, linear, triangles),
                    "dqs": measure(basis, quaternion, triangles),
                    "meanVertexDisplacementDifference": sum(drift) / len(drift),
                    "p95VertexDisplacementDifference": drift[int(0.95 * (len(drift) - 1))],
                    "maxVertexDisplacementDifference": drift[-1],
                }
                results.append(metric)
                print("[Testing Blender DQS/LBS]", json.dumps(metric))
        finally:
            pbone.rotation_quaternion = original_rotation
            pbone.rotation_mode = original_mode
            modifier.use_deform_preserve_volume = False
            bpy.context.view_layer.update()

    report = {
        "schema": "testing-hand-preserve-volume-ab-v1",
        "sourceBlend": str(args_.input),
        "mesh": mesh.name,
        "vertices": len(basis),
        "triangles": len(triangles),
        "rig": arm.name,
        "axisCalibrated": False,
        "humanMotionValidated": False,
        "correctiveShapeKeysSculpted": False,
        "measurements": results,
    }
    args_.report.parent.mkdir(parents=True, exist_ok=True)
    args_.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Diagnostic only; no generated morph targets are approved.")


if __name__ == "__main__":
    main()
