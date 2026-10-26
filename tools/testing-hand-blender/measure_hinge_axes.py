"""Measure *unsigned* geometric MCP/PIP/DIP hinge-axis candidates in Blender.

This is an offline rest-armature survey. It cannot determine anatomical
flexion sign, thumb opposition, true phalanx pivot centers, or skin quality.
Do not drive renderer bones/morph targets from these estimates without artist
calibration and paired actual-motion evidence.
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path
import bpy
from mathutils import Vector

FINGERS = ("index", "middle", "ring", "pinky")
SEGMENTS = (("mcp", "phalanx-proximal"),
            ("pip", "phalanx-intermediate"),
            ("dip", "phalanx-distal"))

def unit(value, description):
    if any(not math.isfinite(float(x)) for x in value) or value.length < 1e-7:
        raise ValueError("Invalid hand rest frame: " + description)
    return value.normalized()

def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--side", required=True, choices=("left", "right"))
    arg = parser.parse_args(args)
    if not arg.input.is_file():
        raise FileNotFoundError(arg.input)
    bpy.ops.wm.open_mainfile(filepath=str(arg.input.resolve()))
    rigs = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("Expected exactly one hand armature")
    arm = rigs[0]
    bones = arm.data.bones
    required = ("wrist", "index-finger-phalanx-proximal",
                "middle-finger-phalanx-proximal", "pinky-finger-phalanx-proximal")
    if any(name not in bones for name in required):
        raise ValueError("Missing hand/palm reference bones")
    wrist = bones["wrist"].head_local
    index = bones["index-finger-phalanx-proximal"].head_local
    middle = bones["middle-finger-phalanx-proximal"].head_local
    pinky = bones["pinky-finger-phalanx-proximal"].head_local
    lateral = unit(pinky - index, "palm lateral")
    approximate_forward = unit(middle - wrist, "palm forward")
    normal = unit(lateral.cross(approximate_forward), "palm normal")
    forward = unit(normal.cross(lateral), "palm tangent")
    rows = []
    for finger in FINGERS:
        for joint, segment in SEGMENTS:
            name = f"{finger}-finger-{segment}"
            if name not in bones:
                raise ValueError("Missing finger joint " + name)
            bone = bones[name]
            longitudinal = unit(bone.tail_local - bone.head_local, name)
            hinge = unit(normal.cross(longitudinal), name + " hinge")
            local = unit(bone.matrix_local.to_3x3().inverted_safe() @ hinge,
                         name + " local axis")
            cosine = min(1.0, max(0.0, abs(local.dot(Vector((1, 0, 0))))))
            row = {
                "finger": finger, "joint": joint, "bone": name,
                "restBoneLengthMeters": float(bone.length),
                "headArmatureMeters": [float(v) for v in bone.head_local],
                "axisArmatureUnsigned": [float(v) for v in hinge],
                "axisBoneLocalUnsigned": [float(v) for v in local],
                "differenceFromAssumedLocalXDegrees": math.degrees(math.acos(cosine)),
                "perpendicularityError": max(abs(hinge.dot(longitudinal)),
                                              abs(hinge.dot(normal))),
                "headOffsetFromPalmPlaneMeters": float(
                    (bone.head_local - wrist).dot(normal)),
                "artistValidated": False,
            }
            if row["restBoneLengthMeters"] <= 0.001 or row["perpendicularityError"] > 1e-4:
                raise ValueError("Unusable rest-bone axis for " + name)
            rows.append(row)
    if len(rows) != 12:
        raise ValueError("Missing 12 non-thumb MCP/PIP/DIP axes")
    result = {
        "schema": "testing-unsigned-hinge-axes-v1", "side": arg.side,
        "rig": arm.name,
        "palmNormalArmatureUnsigned": [float(v) for v in normal],
        "palmLateralArmature": [float(v) for v in lateral],
        "palmForwardArmature": [float(v) for v in forward],
        "joints": rows, "anatomicalAxesCalibrated": False,
        "physiologicalFlexionSignCalibrated": False,
        "thumbOppositionCalibrated": False, "exportApproved": False,
        "warnings": [
            "Geometric hinge estimate only; native GLB pivots are estimated.",
            "The sign of palmar flexion and the thumb CMC axes are unverified.",
            "Do not deploy any corrective based on this report alone.",
        ],
    }
    arg.report.parent.mkdir(parents=True, exist_ok=True)
    arg.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print("[Testing unsigned candidate joint axes]", arg.side,
          [(r["finger"], r["joint"], round(r["differenceFromAssumedLocalXDegrees"], 1))
           for r in rows])

if __name__ == "__main__":
    main()
