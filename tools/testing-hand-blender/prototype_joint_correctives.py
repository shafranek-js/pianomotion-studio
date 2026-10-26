"""Offline DQS-targeted corrective candidates for joint-local deformations.

Experimental bake for three MCP knuckles and pinky DIP at 60 degrees, based
on actual Blender source armatures and independently estimated UNSIGNED
hinge axes. Do not apply to the Testing runtime: these morphs lack signed
biomechanical and artist validation, and Blender DQS is not a guaranteed
physically accurate target.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Quaternion, Vector

# Import the already-tested inverse Blender linear skinning implementation.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prototype_mcp_corrective import (  # noqa: E402
    capture_vertices, group_weights, weighted_skin_transforms, rms,
)

TARGETS = (
    ("ring", "mcp", "ring-finger-phalanx-proximal"),
    ("index", "mcp", "index-finger-phalanx-proximal"),
    ("middle", "mcp", "middle-finger-phalanx-proximal"),
    ("pinky", "dip", "pinky-finger-phalanx-distal"),
)
ANGLE_DEGREES = 60
MAX_REST_DELTA_M = 0.004


def args():
    parts = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--axes", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--side", choices=("left", "right"), required=True)
    return parser.parse_args(parts)


def select_rig():
    choices = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE" or not all(name in arm.pose.bones for _, _, name in TARGETS):
            continue
        for mesh in bpy.data.objects:
            if mesh.type == "MESH":
                modifiers = [m for m in mesh.modifiers
                             if m.type == "ARMATURE" and m.object == arm]
                if len(modifiers) == 1:
                    choices.append((arm, mesh, modifiers[0]))
    if len(choices) != 1:
        raise ValueError("Require exactly one genuine Blender hand/skinned mesh")
    return choices[0]


def triangle_area_ratios(rest, posed, triangles):
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    baseline = np.linalg.norm(np.cross(rest[b] - rest[a], rest[c] - rest[a]), axis=1)
    changed = np.linalg.norm(np.cross(posed[b] - posed[a], posed[c] - posed[a]), axis=1)
    valid = baseline > 1e-12
    if not np.any(valid):
        raise ValueError("Joint has no measurable triangles")
    ratio = changed[valid] / baseline[valid]
    if not np.all(np.isfinite(ratio)):
        raise ValueError("Joint deformation has non-finite triangle area")
    return {
        "faces": int(len(ratio)),
        "belowQuarter": int(np.count_nonzero(ratio < .25)),
        "belowHalf": int(np.count_nonzero(ratio < .5)),
        "aboveDouble": int(np.count_nonzero(ratio > 2)),
        "minRatio": float(np.min(ratio)),
        "maxRatio": float(np.max(ratio)),
    }


def candidate_for_joint(arm, mesh, modifier, bone, target, local_axis, rest, all_triangles):
    shapes = mesh.data.shape_keys.key_blocks
    shape = shapes.get(target)
    mask_name = "PM_MASK_" + bone
    if shape is None or shape.vertex_group != mask_name:
        raise ValueError("Missing untouched native joint mask/key for " + target)
    mask_weights = group_weights(mesh, mask_name)
    region = np.flatnonzero(mask_weights > .04)
    if len(region) < 10:
        raise ValueError("Joint mask does not contain enough vertices: " + bone)
    associated = np.count_nonzero(np.isin(all_triangles, region), axis=1) >= 2
    local_triangles = all_triangles[associated]
    if len(local_triangles) < 10:
        raise ValueError("Joint has too few local triangles: " + bone)
    local_axis = Vector(local_axis)
    if abs(local_axis.length - 1) > .001 or not all(math.isfinite(float(v)) for v in local_axis):
        raise ValueError("Measured axis is not a finite unit vector: " + bone)
    if local_axis.x < 0:
        local_axis.negate()  # nearest direction to the previous diagnostic local +X
    pose_bone = arm.pose.bones[bone]
    original_mode, old_rotation = pose_bone.rotation_mode, pose_bone.rotation_quaternion.copy()
    try:
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = Quaternion(local_axis, math.radians(ANGLE_DEGREES))
        modifier.use_deform_preserve_volume = False
        linear = capture_vertices(mesh)
        modifier.use_deform_preserve_volume = True
        desired = capture_vertices(mesh)
        modifier.use_deform_preserve_volume = False
        if linear.shape != rest.shape or desired.shape != rest.shape:
            raise ValueError("Blender changed mesh topology")
        baseline = rms(desired[region] - linear[region])
        if baseline <= 1e-8:
            raise ValueError("No measurable LBS/DQS difference around " + bone)
        mapping = weighted_skin_transforms(arm, mesh)
        by_group = [mapping.get(group.name) for group in mesh.vertex_groups]
        delta_by_vertex = np.zeros_like(rest)
        reconstruction_max = 0.0
        generated = 0

        for idx in region:
            vertex = mesh.data.vertices[int(idx)]
            transform = np.zeros((3, 3), dtype=np.float64)
            translation = np.zeros(3, dtype=np.float64)
            total = 0.0
            for membership in vertex.groups:
                name = mesh.vertex_groups[membership.group].name
                if name.startswith("PM_MASK_") or membership.weight <= 0:
                    continue
                matrix = by_group[membership.group]
                if matrix is None:
                    continue
                weight = float(membership.weight)
                transform += matrix[:3, :3] * weight
                translation += matrix[:3, 3] * weight
                total += weight
            if total <= 1e-6:
                continue
            transform /= total
            translation /= total
            error = float(np.linalg.norm(transform @ rest[idx] + translation - linear[idx]))
            reconstruction_max = max(reconstruction_max, error)
            if error > .002:
                raise ValueError(f"Nonmatching Blender LBS reconstruction for {bone} at vertex {idx}: {error:.5f} m")
            target_delta = desired[idx] - linear[idx]
            correction = np.linalg.lstsq(transform, target_delta, rcond=1e-5)[0]
            if not np.all(np.isfinite(correction)):
                raise ValueError("Singular correction at " + bone)
            correction *= min(1.0, float(mask_weights[idx]) * 3)
            norm = float(np.linalg.norm(correction))
            if norm > MAX_REST_DELTA_M:
                correction *= MAX_REST_DELTA_M / norm
            delta_by_vertex[idx] = correction
            generated += float(np.linalg.norm(correction)) > 1e-7
        if generated < 10:
            raise ValueError("Experimental correction did not move enough local vertices: " + bone)

        # First evaluate the unrestricted proposal. LBS is linear in rest
        # morph deltas, so any reduced amplitude is the exact linear
        # interpolation between neutral LBS and the full posed morph.
        basis = shapes[0]
        shape.vertex_group = ""
        for i in range(len(rest)):
            shape.data[i].co = basis.data[i].co + Vector(delta_by_vertex[i].tolist())
        shape.value = 1
        full_candidate = capture_vertices(mesh)
        raw_area = triangle_area_ratios(rest, full_candidate, local_triangles)
        before_area = triangle_area_ratios(rest, linear, local_triangles)
        dqs_area = triangle_area_ratios(rest, desired, local_triangles)
        full_displacement = full_candidate - linear

        # Never exchange an RMS gain for new quarter- or half-area collapses.
        # Search each joint independently; under local linear blend skinning
        # these candidates require NO new inverse bind calculation.
        feasible = []
        for step in range(1, 101):
            alpha = step / 100
            trial = linear + alpha * full_displacement
            trial_area = triangle_area_ratios(rest, trial, local_triangles)
            trial_rms = rms(desired[region] - trial[region])
            if (trial_rms < baseline and
                    trial_area["belowQuarter"] <= before_area["belowQuarter"] and
                    trial_area["belowHalf"] <= before_area["belowHalf"]):
                feasible.append((trial_rms, -alpha, trial_area))
        if not feasible:
            raise ValueError(f"No positive amplitude preserves local half/quarter collapse for {bone}")
        corrected, negative_alpha, candidate_area = min(feasible, key=lambda x: (x[0], x[1]))
        chosen_alpha = -negative_alpha
        # Bake a real, reduced morph rather than retaining an unsafe full key
        # and merely setting the Blender shape slider below 1. glTF will
        # receive the actual reduced vertex deltas if later approved.
        for i in range(len(rest)):
            shape.data[i].co = basis.data[i].co + Vector((delta_by_vertex[i] * chosen_alpha).tolist())
        shape.value = 1
        confirmed = capture_vertices(mesh)
        measured_rms = rms(desired[region] - confirmed[region])
        verified_area = triangle_area_ratios(rest, confirmed, local_triangles)
        if abs(measured_rms - corrected) > 1e-6 or (
            verified_area["belowHalf"] != candidate_area["belowHalf"] or
            verified_area["belowQuarter"] != candidate_area["belowQuarter"]
        ):
            raise ValueError(f"Linear morph interpolation not verified in Blender for {bone}")
        corrected = measured_rms
        candidate_area = verified_area
        result = {
            "bone": bone, "targetName": target, "angleDegrees": ANGLE_DEGREES,
            "measuredAxisBoneLocalUnsigned": [float(v) for v in local_axis],
            "regionVertices": int(len(region)), "nonzeroCorrectiveVertices": int(generated),
            "baselineLbsToDqsRmsMillimeters": baseline * 1000,
            "candidateToDqsRmsMillimeters": corrected * 1000,
            "rmsImprovementPercent": (1 - corrected / baseline) * 100,
            "maxLbsReconstructionErrorMillimeters": reconstruction_max * 1000,
            "maxRestDeltaMillimeters": float(np.max(np.linalg.norm(delta_by_vertex, axis=1))) * 1000 * chosen_alpha,
            "chosenCorrectiveAmplitude": chosen_alpha,
            "unrestrictedLocalArea": raw_area,
            "unrestrictedLocalRmsMillimeters": rms(desired[region] - full_candidate[region]) * 1000,
            "lbsLocalArea": before_area, "dqsLocalArea": dqs_area,
            "candidateLocalArea": candidate_area,
            # Local area can worsen even as DQS displacement improves.
            "noAdditionalQuarterAreaCollapse": (
                candidate_area["belowQuarter"] <= before_area["belowQuarter"]
            ),
            "noAdditionalHalfAreaCollapse": (
                candidate_area["belowHalf"] <= before_area["belowHalf"]
            ),
            "axisAndFlexionSignCalibrated": False, "approvedForExport": False,
        }
        print("[Testing joint corrective candidate]", json.dumps(result))
        return result
    finally:
        shape.value = 0
        pose_bone.rotation_quaternion = old_rotation
        pose_bone.rotation_mode = original_mode
        modifier.use_deform_preserve_volume = False
        bpy.context.view_layer.update()


def main():
    arguments = args()
    if arguments.input.resolve() == arguments.output.resolve():
        raise ValueError("Source and output Blender files cannot be identical")
    if not arguments.input.is_file() or not arguments.axes.is_file():
        raise FileNotFoundError("Missing genuine rigged source / measured axis JSON")
    axes = json.loads(arguments.axes.read_text("utf8"))
    if axes.get("schema") != "testing-unsigned-hinge-axes-v1" or axes["side"] != arguments.side:
        raise ValueError("Axes must match the same hand and generated schema")
    if axes["anatomicalAxesCalibrated"] or axes["exportApproved"]:
        raise ValueError("This test must not treat candidate axes as validated")
    axis_by_bone = {item["bone"]: item["axisBoneLocalUnsigned"] for item in axes["joints"]}
    if any(name not in axis_by_bone for _, _, name in TARGETS):
        raise ValueError("Missing source joint axis")
    bpy.ops.wm.open_mainfile(filepath=str(arguments.input.resolve()))
    arm, mesh, modifier = select_rig()
    if mesh.data.shape_keys is None:
        raise ValueError("Missing prepared native Blender corrective slots")
    for key in mesh.data.shape_keys.key_blocks:
        key.value = 0
    rest = np.array([vertex.co[:] for vertex in mesh.data.vertices], dtype=np.float64)
    triangles = np.array([tuple(poly.vertices) for poly in mesh.data.polygons], dtype=np.int32)
    if len(triangles) == 0 or triangles.shape[1] != 3:
        raise ValueError("Expected triangulated LOD0 source")
    results = []
    for finger, joint, bone in TARGETS:
        name = f"pmcorr_{finger}_{joint}_{ANGLE_DEGREES:03d}"
        results.append(candidate_for_joint(arm, mesh, modifier, bone, name, axis_by_bone[bone],
                                           rest, triangles))
    report = {
        "schema": "testing-measured-axis-joint-corrective-candidate-v1",
        "side": arguments.side, "targets": results, "vertices": len(rest),
        "axisAnatomicallyCalibrated": False, "physiologicalFlexionSignCalibrated": False,
        "keyContactValidated": False, "allThreeLodsVerified": False,
        "humanVisualReviewAccepted": False, "exportApproved": False,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.report.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(arguments.output.resolve()))
    arguments.report.write_text(json.dumps(report, indent=2), encoding="utf8")
    print("[Testing joint candidate summary]", arguments.side,
          [(r["targetName"], round(r["rmsImprovementPercent"], 2),
            r["noAdditionalQuarterAreaCollapse"]) for r in results])


if __name__ == "__main__":
    main()
