"""Bake an experimental *nonzero* joint corrective from Blender's DQS-LBS difference.

The algorithm targets the same mesh's DQS result for a SINGLE 90° test pose,
then solves inverse LBS at each vertex so an ordinary linear-skinned glTF morph
can approximate that result. Weighted joint masks restrict the correction.

IMPORTANT: local +X is a diagnostic rotation axis, NOT anatomical calibration;
the result is a CANDIDATE ONLY. Do not deploy this mesh or enable this morph in
Testing until visual, piano-motion and contact QA passes.

Run after prepare_corrective_sculpt.py:
  blender -b -t 2 --python-exit-code 2 --python \
    tools/testing-hand-blender/prototype_mcp_corrective.py -- \
    --input scratch/blender-correctives/left-lod0.blend \
    --output scratch/blender-correctives/left-mcp-candidate.blend \
    --report scratch/blender-correctives/left-mcp-candidate.json
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

TARGET_JOINTS = {
    "index-finger-phalanx-proximal": "pmcorr_index_mcp_090",
    "middle-finger-phalanx-proximal": "pmcorr_middle_mcp_090",
}
ANGLE_DEGREES = 90
MAX_REST_DELTA_M = 0.004


def parse_arguments():
    vals = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--report", required=True, type=Path)
    return p.parse_args(vals)


def resolve_rig():
    matches = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE" or not all(k in arm.pose.bones for k in TARGET_JOINTS):
            continue
        for mesh in bpy.data.objects:
            if mesh.type != "MESH":
                continue
            skin = [m for m in mesh.modifiers if m.type == "ARMATURE" and m.object == arm]
            if len(skin) == 1:
                matches.append((arm, mesh, skin[0]))
    if len(matches) != 1:
        raise ValueError(f"Expected one rigged hand with index and middle MCP, found {len(matches)}")
    return matches[0]


def capture_vertices(mesh):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(dg)
    current = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=dg)
    if current is None:
        raise ValueError("Cannot evaluate skinned hand")
    try:
        return np.array([v.co[:] for v in current.vertices], dtype=np.float64)
    finally:
        evaluated.to_mesh_clear()


def group_weights(mesh, group):
    vertex_group = mesh.vertex_groups[group]
    weights = np.zeros(len(mesh.data.vertices), dtype=np.float64)
    index = vertex_group.index
    for v in mesh.data.vertices:
        for membership in v.groups:
            if membership.group == index:
                weights[v.index] = membership.weight
                break
    return weights


def weighted_skin_transforms(arm, mesh):
    # Both matrices act in the mesh's ORIGINAL local coordinates, which must
    # match the evaluated Blender armature-modified positions.
    into_arm = arm.matrix_world.inverted_safe() @ mesh.matrix_world
    into_mesh = mesh.matrix_world.inverted_safe() @ arm.matrix_world
    mappings = {}
    for name, pose_bone in arm.pose.bones.items():
        mappings[name] = np.array(
            into_mesh @ pose_bone.matrix @ pose_bone.bone.matrix_local.inverted_safe() @ into_arm,
            dtype=np.float64,
        )
    return mappings


def rms(vector):
    return math.sqrt(float(np.mean(np.sum(vector * vector, axis=1))))


def surface_distortion(reference, displaced, triangles):
    """Whole-hand face-area diagnostics, measured at equal triangles/pose."""
    bad_quarter = 0
    bad_half = 0
    above_double = 0
    ratios = []
    for triangle in triangles:
        a, b, c = triangle
        base = np.linalg.norm(np.cross(
            reference[b] - reference[a], reference[c] - reference[a]
        )) / 2
        if base <= 1e-12:
            continue
        current = np.linalg.norm(np.cross(
            displaced[b] - displaced[a], displaced[c] - displaced[a]
        )) / 2
        ratio = float(current / base)
        if not math.isfinite(ratio):
            raise ValueError("Corrective skin has non-finite triangle area")
        ratios.append(ratio)
        bad_quarter += ratio < 0.25
        bad_half += ratio < 0.5
        above_double += ratio > 2
    if not ratios:
        raise ValueError("No valid skin triangles for corrective QA")
    return {
        "faces": len(ratios),
        "belowQuarter": bad_quarter,
        "belowHalf": bad_half,
        "aboveDouble": above_double,
        "minimumRatio": min(ratios),
        "maximumRatio": max(ratios),
    }


def generate_one(arm, mesh, modifier, bone_name, shape_name, rest_positions, triangles):
    shape = mesh.data.shape_keys.key_blocks.get(shape_name)
    if shape is None:
        raise ValueError(f"Missing prepared shape key: {shape_name}")
    if shape.vertex_group != f"PM_MASK_{bone_name}":
        raise ValueError(f"Expected matching native joint mask on {shape_name}")

    original_group = shape.vertex_group
    weights = group_weights(mesh, original_group)
    candidates = np.where(weights > 0.04)[0]
    if candidates.size < 10:
        raise ValueError(f"Insufficient sculpt vertices near {bone_name}")

    pb = arm.pose.bones[bone_name]
    original_mode = pb.rotation_mode
    original_quaternion = pb.rotation_quaternion.copy()
    try:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion((1, 0, 0), math.radians(ANGLE_DEGREES))
        modifier.use_deform_preserve_volume = False
        linear = capture_vertices(mesh)
        modifier.use_deform_preserve_volume = True
        desired = capture_vertices(mesh)
        modifier.use_deform_preserve_volume = False

        mapping = weighted_skin_transforms(arm, mesh)
        matrices = [mapping.get(group.name) for group in mesh.vertex_groups]
        correction = np.zeros_like(rest_positions)
        baseline = rms(desired[candidates] - linear[candidates])
        max_error = 0.0
        # Validate our bone-frame reconstruction before using inverse skinning.
        # Significant mismatch means transforms or imported rig are incompatible.
        reconstructed_errors = []
        applied = 0
        for index in candidates:
            vertex = mesh.data.vertices[int(index)]
            frame = np.zeros((3, 3), dtype=np.float64)
            translation = np.zeros(3, dtype=np.float64)
            influence_total = 0.0
            for membership in vertex.groups:
                name = mesh.vertex_groups[membership.group].name
                if name.startswith("PM_MASK_"):
                    continue
                transform = matrices[membership.group]
                if transform is None or membership.weight <= 0:
                    continue
                strength = float(membership.weight)
                frame += transform[:3, :3] * strength
                translation += transform[:3, 3] * strength
                influence_total += strength
            if influence_total <= 1e-6:
                continue
            frame /= influence_total
            translation /= influence_total
            estimated_lbs = frame @ rest_positions[index] + translation
            local_error = float(np.linalg.norm(estimated_lbs - linear[index]))
            reconstructed_errors.append(local_error)
            max_error = max(max_error, local_error)
            # Blender LBS and our analytic LBS must agree (metres).
            if local_error > 0.002:
                raise ValueError(
                    f"Cannot invert LBS rig at vertex {index}: "
                    f"predicted error {local_error:.6f} m exceeds 2 mm"
                )
            wished = desired[index] - linear[index]
            try:
                delta = np.linalg.lstsq(frame, wished, rcond=1e-5)[0]
            except np.linalg.LinAlgError as exc:
                raise ValueError(f"Singular LBS frame for vertex {index}") from exc
            if not np.all(np.isfinite(delta)):
                raise ValueError(f"Nonfinite shape correction at vertex {index}")
            delta *= min(1.0, float(weights[index]) * 3)
            displacement = float(np.linalg.norm(delta))
            if displacement > MAX_REST_DELTA_M:
                delta *= MAX_REST_DELTA_M / displacement
            correction[index] = delta
            if float(np.linalg.norm(delta)) > 1e-7:
                applied += 1
        if not reconstructed_errors or applied < 10:
            raise ValueError(f"No meaningful corrective vertex displacements for {bone_name}")

        # Bake the mask into the actual shape delta, rather than relying on a
        # Blender-only vertex-group mask that may not be preserved in glTF.
        basis = mesh.data.shape_keys.key_blocks[0]
        shape.vertex_group = ""
        for v in mesh.data.vertices:
            index = v.index
            shape.data[index].co = basis.data[index].co + Vector(correction[index].tolist())
        shape.value = 1.0
        candidate_mesh = capture_vertices(mesh)
        corrected = rms(desired[candidates] - candidate_mesh[candidates])
        shape.value = 0.0

        before_areas = surface_distortion(rest_positions, linear, triangles)
        target_areas = surface_distortion(rest_positions, desired, triangles)
        candidate_areas = surface_distortion(rest_positions, candidate_mesh, triangles)

        if not math.isfinite(corrected) or corrected >= baseline:
            raise ValueError(
                f"{shape_name} did not improve DQS-targeted RMS: "
                f"LBS {baseline:.6f} m, corrected {corrected:.6f} m"
            )
        return {
            "targetName": shape_name,
            "bone": bone_name,
            "angleDegrees": ANGLE_DEGREES,
            "axis": "local +X diagnostic, NOT calibrated piano flexion",
            "maskedVertices": int(candidates.size),
            "nonzeroCorrectiveVertices": applied,
            "baselineLbsToDqsRmsMeters": baseline,
            "candidateToDqsRmsMeters": corrected,
            "rmsImprovementPercent": (1 - corrected / baseline) * 100,
            "maxLbsReconstructionErrorMeters": max_error,
            "maxRestDeltaMeters": float(np.max(np.linalg.norm(correction, axis=1))),
            "lbsDistortion": before_areas,
            "dqsDistortion": target_areas,
            "candidateDistortion": candidate_areas,
            "glTFExportApproved": False,
        }
    finally:
        shape.value = 0.0
        pb.rotation_quaternion = original_quaternion
        pb.rotation_mode = original_mode
        modifier.use_deform_preserve_volume = False
        bpy.context.view_layer.update()


def main():
    args = parse_arguments()
    if args.input.resolve() == args.output.resolve():
        raise ValueError("Refusing to overwrite Blender source file")
    bpy.ops.wm.open_mainfile(filepath=str(args.input.resolve()))
    arm, mesh, modifier = resolve_rig()
    rest = np.array([v.co[:] for v in mesh.data.vertices], dtype=np.float64)
    triangles = [
        tuple(face.vertices) for face in mesh.data.polygons
        if len(face.vertices) == 3
    ]
    if len(triangles) != len(mesh.data.polygons):
        raise ValueError("Non-triangulated surface prevents quantitative skin checks")
    targets = []
    for bone, name in TARGET_JOINTS.items():
        results = generate_one(arm, mesh, modifier, bone, name, rest, triangles)
        print("[Testing DQS-derived prototype]", json.dumps(results))
        targets.append(results)

    report = {
        "schema": "testing-hand-mcp-dqs-candidate-v1",
        "source": str(args.input),
        "mesh": mesh.name,
        "armature": arm.name,
        "vertices": len(rest),
        "targets": targets,
        "artistValidated": False,
        "anatomicalAxesCalibrated": False,
        "keyContactValidated": False,
        "exportApproved": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output.resolve()))
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Saved NONZERO experimental MCP shape keys; NO final anatomical sculpt or export approval.")


if __name__ == "__main__":
    main()
