"""Render LBS vs DQS vs DQS-derived MCP corrective on the SAME posed hand.

Use only for visual diagnostic: the joint is bent around uncalibrated local X,
and these images DO NOT demonstrate natural pianist motion or contact.
Blender CPU Cycles intentionally avoids dependence on a GPU runner.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


def arguments():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--side", choices=("left", "right"), required=True)
    return p.parse_args(args)


def locate():
    matches = []
    for arm in bpy.data.objects:
        if arm.type != "ARMATURE" or "index-finger-phalanx-proximal" not in arm.pose.bones:
            continue
        for mesh in bpy.data.objects:
            if mesh.type == "MESH":
                mods = [m for m in mesh.modifiers if m.type == "ARMATURE" and m.object == arm]
                if len(mods) == 1:
                    matches.append((arm, mesh, mods[0]))
    if len(matches) != 1:
        raise ValueError("Expected exactly one skinned hand for render comparison")
    return matches[0]


def look_at(camera, destination):
    direction = destination - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def prepare_camera(arm, mesh):
    wrist = arm.matrix_world @ arm.data.bones["wrist"].head_local
    index = arm.matrix_world @ arm.data.bones["index-finger-phalanx-proximal"].head_local
    middle = arm.matrix_world @ arm.data.bones["middle-finger-phalanx-proximal"].head_local
    pinky = arm.matrix_world @ arm.data.bones["pinky-finger-phalanx-proximal"].head_local
    span = pinky - index
    forward = middle - wrist
    normal = span.cross(forward)
    if normal.length < 1e-8:
        raise ValueError("Cannot derive real hand camera frame")
    normal.normalize()
    forward.normalize()
    framing = max(0.14, (pinky - index).length * 2.5)

    camera_data = bpy.data.cameras.new("PianoMotion MCP review camera")
    camera = bpy.data.objects.new("PianoMotion MCP review camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = framing
    center = (index + middle) * 0.5
    camera.location = center + normal * framing * 1.9 - forward * 0.2 * framing
    look_at(camera, center)

    light_data = bpy.data.lights.new("PianoMotion joint review softbox", "AREA")
    light = bpy.data.objects.new("PianoMotion joint review softbox", light_data)
    bpy.context.scene.collection.objects.link(light)
    light.location = center + normal * framing * 1.0 + span.normalized() * framing * 0.5
    light_data.energy = 200
    light_data.shape = "DISK"
    light_data.size = framing * 1.5
    look_at(light, center)
    return camera


def configure_render():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 12
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 850
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("PianoMotion review world") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.18, 0.19, 0.22, 1)
        background.inputs["Strength"].default_value = 0.75


def main():
    args = arguments()
    if not args.input.is_file():
        raise FileNotFoundError(args.input)
    bpy.ops.wm.open_mainfile(filepath=str(args.input.resolve()))
    arm, mesh, skin = locate()
    key = mesh.data.shape_keys.key_blocks.get("pmcorr_index_mcp_090")
    if key is None:
        raise ValueError("The real index MCP candidate morph is missing")
    if not any((key.data[i].co - mesh.data.shape_keys.key_blocks[0].data[i].co).length > 1e-7
               for i in range(len(mesh.data.vertices))):
        raise ValueError("Cannot compare a blank corrective key")
    pb = arm.pose.bones["index-finger-phalanx-proximal"]
    original_mode = pb.rotation_mode
    original_quat = pb.rotation_quaternion.copy()
    camera = prepare_camera(arm, mesh)
    configure_render()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion((1, 0, 0), math.radians(90))
        for variant, preserve_volume, morph in [
            ("lbs", False, 0),
            ("preserve-volume", True, 0),
            ("mcp-candidate", False, 1),
        ]:
            skin.use_deform_preserve_volume = preserve_volume
            key.value = morph
            bpy.context.view_layer.update()
            destination = args.output_dir / f"{args.side}-index-mcp-090-{variant}.png"
            bpy.context.scene.render.filepath = str(destination.resolve())
            bpy.ops.render.render(write_still=True)
            if not destination.is_file() or destination.stat().st_size < 15000:
                raise ValueError(f"Blender failed to produce valid render: {destination}")
            print("[Testing hand rendered pose QA]", variant, destination)
    finally:
        pb.rotation_quaternion = original_quat
        pb.rotation_mode = original_mode
        key.value = 0
        skin.use_deform_preserve_volume = False


if __name__ == "__main__":
    main()
