"""Offline MCP/PIP/DIP deform priority survey on genuine Blender LOD0 armatures.

Evaluate both linear blend skinning (LBS) and Blender Preserve Volume (DQS)
at exactly the same 60-degree diagnostic pose around 12 candidate hinge axes
derived from measured rest-bone frames. Each joint is isolated and other
joints remain at rest. This quantifies *where* skin differs; neither option is
an anatomical ground truth or approval to export or enable morph targets.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

ANGLE_DEGREES = 60
EXPECTED_JOINTS = 12


def arguments():
    arguments_ = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--axes", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--side", choices=("left", "right"), required=True)
    return p.parse_args(arguments_)


def locate():
    matching = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE":
            continue
        for obj in bpy.data.objects:
            if obj.type != "MESH":
                continue
            modifiers = [m for m in obj.modifiers
                         if m.type == "ARMATURE" and m.object == arm]
            if len(modifiers) == 1:
                matching.append((arm, obj, modifiers[0]))
    if len(matching) != 1:
        raise ValueError("Exactly one real 25-bone rigged surface is required")
    return matching[0]


def positions(mesh):
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(deps)
    surface = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=deps)
    if surface is None:
        raise ValueError("Blender did not evaluate the skinned surface")
    try:
        return [v.co.copy() for v in surface.vertices]
    finally:
        evaluated.to_mesh_clear()


def local_mask_vertices(mesh, bone_name):
    group = mesh.vertex_groups.get("PM_MASK_" + bone_name)
    if group is None:
        raise ValueError("Missing joint-local sculpt mask " + bone_name)
    indices = []
    for vertex in mesh.data.vertices:
        if any(membership.group == group.index and membership.weight > 0.02
               for membership in vertex.groups):
            indices.append(vertex.index)
    if len(indices) < 10:
        raise ValueError("Not enough joint-local vertices for " + bone_name)
    return indices


def rms_delta_mm(lhs, rhs, subset):
    differences = [(lhs[index] - rhs[index]).length for index in subset]
    if not differences or any(not math.isfinite(v) for v in differences):
        raise ValueError("Cannot measure finite local deformation")
    return math.sqrt(sum(v * v for v in differences) / len(differences)) * 1000


def face_area(vertices, triangle):
    a, b, c = (vertices[index] for index in triangle)
    return ((b - a).cross(c - a)).length * 0.5


def distorted_local_faces(rest, candidate, triangles, affected):
    # At least two vertices inside the joint mask to avoid assigning remote
    # palm/other-digit triangles to this local joint.
    severe_collapse = 0
    severe_expansion = 0
    considered = 0
    for triangle in triangles:
        if sum(i in affected for i in triangle) < 2:
            continue
        base_area = face_area(rest, triangle)
        if base_area < 1e-12:
            continue
        ratio = face_area(candidate, triangle) / base_area
        if not math.isfinite(ratio):
            raise ValueError("Non-finite local deformation area ratio")
        considered += 1
        severe_collapse += ratio < 0.25
        severe_expansion += ratio > 2
    if considered == 0:
        raise ValueError("Joint mask contains no valid surface triangles")
    return {
        "triangles": considered,
        "collapsedBelowQuarter": severe_collapse,
        "expandedAboveDouble": severe_expansion,
    }


def main():
    args = arguments()
    if not args.input.is_file() or not args.axes.is_file():
        raise FileNotFoundError("Missing real Blender hand or measured axes")
    axes = json.loads(args.axes.read_text("utf8"))
    if axes["side"] != args.side or axes["schema"] != "testing-unsigned-hinge-axes-v1":
        raise ValueError("Measured joint-axis report mismatches the requested hand")
    if (axes["anatomicalAxesCalibrated"] is not False or
            axes["exportApproved"] is not False):
        raise ValueError("Candidate axis report must remain explicitly unapproved")
    if len(axes["joints"]) != EXPECTED_JOINTS:
        raise ValueError("A complete MCP/PIP/DIP joint axis survey is required")
    bpy.ops.wm.open_mainfile(filepath=str(args.input.resolve()))
    arm, mesh, modifier = locate()
    if mesh.data.shape_keys:
        for key in mesh.data.shape_keys.key_blocks:
            key.value = 0.0

    rest = [v.co.copy() for v in mesh.data.vertices]
    triangles = [tuple(face.vertices) for face in mesh.data.polygons]
    if any(len(t) != 3 for t in triangles):
        raise ValueError("Expected an original triangulated LOD0 surface")
    results = []
    for row in axes["joints"]:
        bone = row["bone"]
        if bone not in arm.pose.bones:
            raise ValueError("Cannot locate measured joint " + bone)
        local_axis = Vector(row["axisBoneLocalUnsigned"])
        if not all(math.isfinite(float(x)) for x in local_axis) or abs(local_axis.length - 1) > 1e-3:
            raise ValueError("Bad measured local hinge axis " + bone)
        if local_axis.x < 0:
            local_axis.negate()  # keep the diagnostic signed direction closest to local +X
        pb = arm.pose.bones[bone]
        mode = pb.rotation_mode
        old_rotation = pb.rotation_quaternion.copy()
        region = local_mask_vertices(mesh, bone)
        affected = set(region)
        cases = {}
        try:
            pb.rotation_mode = "QUATERNION"
            for name, axis in (("syntheticLocalX", Vector((1, 0, 0))),
                               ("measuredUnsignedAxis", local_axis)):
                pb.rotation_quaternion = Quaternion(axis, math.radians(ANGLE_DEGREES))
                modifier.use_deform_preserve_volume = False
                linear = positions(mesh)
                modifier.use_deform_preserve_volume = True
                dqs = positions(mesh)
                if len(linear) != len(rest) or len(dqs) != len(rest):
                    raise ValueError("Topology changed during single-joint evaluation")
                cases[name] = {
                    "localLbsToDqsRmsMillimeters": rms_delta_mm(linear, dqs, region),
                    "localLbs": distorted_local_faces(rest, linear, triangles, affected),
                    "localDqs": distorted_local_faces(rest, dqs, triangles, affected),
                }
        finally:
            pb.rotation_quaternion = old_rotation
            pb.rotation_mode = mode
            modifier.use_deform_preserve_volume = False
            bpy.context.view_layer.update()
        item = {
            "finger": row["finger"], "joint": row["joint"],
            "bone": bone, "angleDegrees": ANGLE_DEGREES,
            "axisDifferenceFromSyntheticDegrees": row["differenceFromAssumedLocalXDegrees"],
            "regionVertices": len(region),
            "experiments": cases, "axisAnatomicallyCalibrated": False,
        }
        results.append(item)
        print("[Testing local hinge DQS/LBS]", args.side, bone,
              json.dumps(item["experiments"]))
    if len(results) != EXPECTED_JOINTS:
        raise ValueError("Incomplete joint-by-joint deform measurement")
    results.sort(key=lambda entry:
                 -entry["experiments"]["measuredUnsignedAxis"]["localLbsToDqsRmsMillimeters"])
    report = {
        "schema": "testing-hinge-deformation-priority-v1",
        "side": args.side, "vertices": len(rest), "triangles": len(triangles),
        "angleDegrees": ANGLE_DEGREES, "joints": results,
        "axisAnatomicallyCalibrated": False,
        "pianoMotionOrContactValidated": False,
        "dqsIsAnatomicalGroundTruth": False,
        "exportApproved": False,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf8")
    print("[Testing hinge priority]", args.side,
          [(row["bone"], round(row["experiments"]["measuredUnsignedAxis"]["localLbsToDqsRmsMillimeters"], 3))
           for row in results])


if __name__ == "__main__":
    main()
