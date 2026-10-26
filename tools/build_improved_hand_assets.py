#!/usr/bin/env python3
"""Build reproducible, articulated WebXR hand assets from hand_standard.glb.

Run from the repository root with the isolated interpreter created under
scratch/improved-assets/.venv. Requirements: numpy, scipy, Pillow,
fast-simplification. No active application Python environment is used.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import struct
import sys
import time
from collections import Counter, defaultdict, deque
from pathlib import Path

import fast_simplification
import numpy as np
from PIL import Image, ImageDraw
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.ndimage import binary_erosion, distance_transform_edt
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DEFAULT = Path.home() / "Downloads" / "hand_standard.glb"
OUT_DEFAULT = ROOT / "apps/client/public/models/hands/improved"
EVIDENCE_DEFAULT = ROOT / "docs/evidence/anatomical-improved"
SCRATCH_DEFAULT = ROOT / "scratch/improved-assets"
CUT_Y = -0.28
TARGETS = ((0, 35000), (1, 18000), (2, 8000))
WEIGHT_SIGMA_SOURCE_UNITS = .03
WEIGHT_HEAT_STEPS = 2
WEIGHT_HEAT_ALPHA = .18
WEIGHT_TOPOLOGY_TEMPERATURE_SOURCE_UNITS = .05
JOINT_NAMES = [
    "pinky-finger-tip", "pinky-finger-phalanx-distal", "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-proximal", "pinky-finger-metacarpal",
    "ring-finger-tip", "ring-finger-phalanx-distal", "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-proximal", "ring-finger-metacarpal",
    "middle-finger-tip", "middle-finger-phalanx-distal", "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-proximal", "middle-finger-metacarpal",
    "index-finger-tip", "index-finger-phalanx-distal", "index-finger-phalanx-intermediate",
    "index-finger-phalanx-proximal", "index-finger-metacarpal",
    "thumb-tip", "thumb-phalanx-distal", "thumb-phalanx-proximal", "thumb-metacarpal", "wrist",
]
DIGITS = ["pinky", "ring", "middle", "index", "thumb"]
DIGIT_JOINTS = {
    "pinky": ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
    "ring": ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
    "middle": ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
    "index": ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
    "thumb": ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
}


def log(msg: str) -> None:
    print(msg, flush=True)


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError(f"Not a GLB 2.0 file: {path}")
    total = struct.unpack_from("<I", data, 8)[0]
    if total != len(data):
        raise ValueError(f"GLB length header mismatch: {total} != {len(data)}")
    json_len, chunk_type = struct.unpack_from("<I4s", data, 12)
    if chunk_type != b"JSON":
        raise ValueError("GLB JSON chunk missing")
    gltf = json.loads(data[20:20 + json_len].decode("utf-8"))
    bin_header = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<I4s", data, bin_header)
    if bin_type != b"BIN\x00":
        raise ValueError("GLB BIN chunk missing")
    binary = data[bin_header + 8:bin_header + 8 + bin_len]
    return gltf, binary


def accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    acc = gltf["accessors"][index]
    if "sparse" in acc:
        raise ValueError("Sparse accessors are not supported by this source importer")
    view = gltf["bufferViews"][acc["bufferView"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
    dtype = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[acc["componentType"]]
    item = np.dtype(dtype).itemsize * components
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride", item)
    if stride == item:
        raw = np.frombuffer(binary, dtype=dtype, count=acc["count"] * components, offset=offset)
        arr = raw.reshape(acc["count"], components) if components > 1 else raw
    else:
        arr = np.ndarray((acc["count"], components), dtype=dtype, buffer=binary, offset=offset, strides=(stride, np.dtype(dtype).itemsize))
    if acc.get("normalized"):
        if acc["componentType"] == 5121:
            arr = arr.astype(np.float32) / 255.0
        elif acc["componentType"] == 5123:
            arr = arr.astype(np.float32) / 65535.0
        elif acc["componentType"] == 5122:
            arr = np.maximum(arr.astype(np.float32) / 32767.0, -1.0)
    return np.asarray(arr)


def load_source(path: Path) -> tuple[dict, dict, bytes, dict[str, np.ndarray], np.ndarray, dict]:
    gltf, binary = read_glb(path)
    primitive = gltf["meshes"][0]["primitives"][0]
    attrs = primitive["attributes"]
    raw = {k: accessor(gltf, binary, v) for k, v in attrs.items()}
    indices = accessor(gltf, binary, primitive["indices"]).astype(np.int64).reshape(-1, 3)
    node = gltf.get("nodes", [{}])[0]
    scale = np.asarray(node.get("scale", [1, 1, 1]), dtype=np.float64)
    translation = np.asarray(node.get("translation", [0, 0, 0]), dtype=np.float64)
    raw["POSITION"] = raw["POSITION"].astype(np.float64) * scale + translation
    raw["NORMAL"] = normalize_rows(raw["NORMAL"].astype(np.float64))
    tangent = raw["TANGENT"].astype(np.float64)
    tangent[:, :3] = normalize_rows(tangent[:, :3])
    raw["TANGENT"] = tangent
    transform = gltf["materials"][primitive.get("material", 0)]["pbrMetallicRoughness"]["baseColorTexture"]["extensions"]["KHR_texture_transform"]
    return gltf, primitive, binary, raw, indices, transform


def normalize_rows(a: np.ndarray) -> np.ndarray:
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-12)


def weld_geometry(pos: np.ndarray, faces: np.ndarray, precision: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Weld only coincident positions for geometric simplification."""
    quant = np.rint(np.asarray(pos) * (10 ** precision)).astype(np.int64)
    unique, inverse = np.unique(quant, axis=0, return_inverse=True)
    geom = unique.astype(np.float64) / (10 ** precision)
    wf = inverse[np.asarray(faces, dtype=np.int64)]
    good = (wf[:, 0] != wf[:, 1]) & (wf[:, 1] != wf[:, 2]) & (wf[:, 2] != wf[:, 0])
    return geom, wf[good]


def projected_attributes(src_pos: np.ndarray, src_faces: np.ndarray, src_attrs: dict[str, np.ndarray],
                         dst_pos: np.ndarray, dst_faces: np.ndarray, log_fn=print) -> tuple[np.ndarray, ...]:
    """Barycentrically restore per-corner source attributes after welded collapse.

    Projection is restricted to a neighborhood of source triangle centroids.
    A geometric vertex is duplicated only when its quantized UV chart differs;
    this preserves real seams without preserving every source seam vertex.
    """
    tri = src_pos[src_faces]
    centroids = tri.mean(axis=1)
    tree = cKDTree(centroids)
    # Target each corner independently so UV chart discontinuities can split
    # the final indexed mesh where the original source charts require it.
    corner_ids = dst_faces.reshape(-1)
    query_points = dst_pos[corner_ids]
    source_uv = src_attrs["TEXCOORD_0"]
    source_n = src_attrs["NORMAL"]
    source_t = src_attrs["TANGENT"]
    # The nearest source face at each target-face center establishes its UV
    # chart. Corner candidates are then scored for both geometric distance and
    # continuity with that face chart, preserving real seams after welding.
    target_face_centers = dst_pos[dst_faces].mean(axis=1)
    seed_face = tree.query(target_face_centers, k=1, workers=-1)[1]
    seed_uv = source_uv[src_faces[seed_face]].mean(axis=1)
    seed_uv_per_corner = np.repeat(seed_uv, 3, axis=0)
    out_pos, out_n, out_t, out_uv, out_faces = [], [], [], [], np.empty_like(dst_faces, dtype=np.int64)
    buckets: dict[tuple, list[int]] = {}
    k = 16
    chunk = 8192
    corner_to_out = np.empty(len(corner_ids), dtype=np.int64)
    for begin in range(0, len(query_points), chunk):
        end = min(begin + chunk, len(query_points))
        q = query_points[begin:end]
        dcent, candidates = tree.query(q, k=k, workers=-1)
        if candidates.ndim == 1:
            candidates = candidates[:, None]
        a = tri[candidates, 0]
        b = tri[candidates, 1]
        c = tri[candidates, 2]
        ab, ac = b - a, c - a
        ap = q[:, None, :] - a
        d00 = np.sum(ab * ab, axis=2); d01 = np.sum(ab * ac, axis=2); d11 = np.sum(ac * ac, axis=2)
        d20 = np.sum(ap * ab, axis=2); d21 = np.sum(ap * ac, axis=2)
        den = np.maximum(d00 * d11 - d01 * d01, 1e-24)
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        u = 1.0 - v - w
        inside = (u >= 0) & (v >= 0) & (w >= 0)
        bary = np.stack([u, v, w], axis=-1)
        projected = np.sum(bary[..., None] * np.stack([a, b, c], axis=3), axis=2)
        dist2 = np.where(inside, np.sum((projected - q[:, None, :]) ** 2, axis=2), np.inf)
        # Outside projected triangles, compare exact closest points on all
        # three source edges; this avoids extrapolating chart attributes.
        for ei, (p0, p1, wi, wj) in enumerate(((a, b, 0, 1), (b, c, 1, 2), (c, a, 2, 0))):
            edge = p1 - p0
            alpha = np.clip(np.sum((q[:, None, :] - p0) * edge, axis=2) / np.maximum(np.sum(edge * edge, axis=2), 1e-24), 0, 1)
            ep = p0 + alpha[..., None] * edge
            ed2 = np.sum((ep - q[:, None, :]) ** 2, axis=2)
            take = (~inside) & (ed2 < dist2)
            dist2[take] = ed2[take]
            bary[take] = 0
            rows, cols = np.where(take)
            bary[rows, cols, wi] = 1 - alpha[rows, cols]
            bary[rows, cols, wj] = alpha[rows, cols]
        candidate_uv = np.sum(source_uv[src_faces[candidates]] * bary[..., None], axis=2)
        chart_d2 = np.sum((candidate_uv - seed_uv_per_corner[begin:end, None, :]) ** 2, axis=2)
        score = dist2 + chart_d2 * (0.003 ** 2)
        choice = np.argmin(score, axis=1)
        rows = np.arange(len(q))
        face_idx = candidates[rows, choice]
        weights = bary[rows, choice]
        fverts = src_faces[face_idx]
        uv = np.sum(source_uv[fverts] * weights[..., None], axis=1)
        normal = normalize_rows(np.sum(source_n[fverts] * weights[..., None], axis=1))
        tangent = np.sum(source_t[fverts] * weights[..., None], axis=1)
        tangent[:, :3] -= normal * np.sum(tangent[:, :3] * normal, axis=1)[:, None]
        tangent[:, :3] = normalize_rows(tangent[:, :3])
        tangent[:, 3] = np.where(tangent[:, 3] < 0, -1.0, 1.0)
        for j in range(len(q)):
            uvkey = tuple(np.rint(np.clip(uv[j], 0, 1) * 8192).astype(np.int32))
            key = (int(corner_ids[begin + j]), *uvkey)
            idx = None
            for old in buckets.get(key, []):
                if np.dot(out_n[old], normal[j]) > .995 and np.dot(out_t[old][:3], tangent[j][:3]) > .99:
                    idx = old
                    break
            if idx is None:
                idx = len(out_pos)
                buckets.setdefault(key, []).append(idx)
                out_pos.append(dst_pos[corner_ids[begin + j]].copy())
                out_n.append(normal[j].copy())
                out_t.append(tangent[j].copy())
                out_uv.append(np.clip(uv[j], 0, 1).copy())
            corner_to_out[begin + j] = idx
        if end == len(query_points) or end % (chunk * 8) == 0:
            log_fn(f"barycentric projection: {end:,}/{len(query_points):,} target corners; unique seam vertices={len(out_pos):,}")
    out_faces = corner_to_out.reshape(dst_faces.shape)
    return (np.asarray(out_pos, dtype=np.float64), np.asarray(out_n, dtype=np.float64),
            np.asarray(out_t, dtype=np.float64), np.asarray(out_uv, dtype=np.float64), out_faces)


def clip_mesh_to_wrist(attrs: dict[str, np.ndarray], faces: np.ndarray, cut_y: float) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Clip triangles to y>=cut, interpolating all seam-local attributes."""
    p = attrs["POSITION"]
    tri_y = p[faces, 1]
    all_in = np.all(tri_y >= cut_y, axis=1)
    any_in = np.any(tri_y >= cut_y, axis=1)
    kept = [faces[all_in].astype(np.int64, copy=False)]
    old_count = len(p)
    out_attrs = {k: [v.copy()] for k, v in attrs.items()}
    edge_cache: dict[tuple[int, int], int] = {}
    crossing = faces[any_in & ~all_in]

    def intersection(a: int, b: int) -> int:
        key = (min(a, b), max(a, b))
        if key in edge_cache:
            return edge_cache[key]
        ya, yb = p[a, 1], p[b, 1]
        t = (cut_y - ya) / (yb - ya)
        idx = old_count + len(edge_cache)
        for name, values in attrs.items():
            value = values[a] + t * (values[b] - values[a])
            if name == "POSITION":
                value[1] = cut_y
            out_attrs[name].append(value[None, :])
        edge_cache[key] = idx
        return idx

    cross_tris = []
    for face in crossing:
        poly: list[int] = []
        for i in range(3):
            a, b = int(face[i]), int(face[(i + 1) % 3])
            a_in, b_in = p[a, 1] >= cut_y, p[b, 1] >= cut_y
            if a_in and b_in:
                poly.append(b)
            elif a_in and not b_in:
                poly.append(intersection(a, b))
            elif not a_in and b_in:
                poly.append(intersection(a, b))
                poly.append(b)
        # Adjacent clipping events can repeat a vertex on exact-plane edges.
        compact = []
        for idx in poly:
            if not compact or compact[-1] != idx:
                compact.append(idx)
        if len(compact) > 1 and compact[0] == compact[-1]:
            compact.pop()
        if len(compact) < 3:
            continue
        for i in range(1, len(compact) - 1):
            cross_tris.append((compact[0], compact[i], compact[i + 1]))
    if cross_tris:
        kept.append(np.asarray(cross_tris, dtype=np.int64))
    faces_out = np.concatenate(kept, axis=0)
    attrs_out = {k: np.concatenate(v, axis=0) for k, v in out_attrs.items()}
    used = np.unique(faces_out)
    remap = np.full(len(attrs_out["POSITION"]), -1, dtype=np.int64)
    remap[used] = np.arange(len(used), dtype=np.int64)
    attrs_out = {k: v[used] for k, v in attrs_out.items()}
    faces_out = remap[faces_out]
    # Remove duplicate/degenerate face indices introduced by exact-on-plane edges.
    valid = (faces_out[:, 0] != faces_out[:, 1]) & (faces_out[:, 1] != faces_out[:, 2]) & (faces_out[:, 2] != faces_out[:, 0])
    return attrs_out, faces_out[valid]


def cross_section_components(points: np.ndarray, faces: np.ndarray, axis: int, value: float) -> list[dict]:
    """Return contour components from exact triangle-plane intersections."""
    other = [i for i in range(3) if i != axis]
    tri = points[faces]
    lo = tri[:, :, axis].min(axis=1)
    hi = tri[:, :, axis].max(axis=1)
    rows = tri[(lo < value) & (hi > value)]
    if not len(rows):
        return []
    segments = []
    for t in rows:
        hits = []
        for a, b in ((0, 1), (1, 2), (2, 0)):
            pa, pb = t[a], t[b]
            if (pa[axis] < value and pb[axis] > value) or (pb[axis] < value and pa[axis] > value):
                q = pa + ((value - pa[axis]) / (pb[axis] - pa[axis])) * (pb - pa)
                hits.append(q[other])
        if len(hits) == 2:
            segments.append(hits)
    if not segments:
        return []
    segments = np.asarray(segments, dtype=np.float64)
    points2 = []
    point_ids: dict[tuple[int, int], int] = {}
    edges = []
    def point_id(q: np.ndarray) -> int:
        key = tuple(np.rint(q * 1e7).astype(np.int64))
        if key not in point_ids:
            point_ids[key] = len(points2)
            points2.append(q)
        return point_ids[key]
    for a, b in segments:
        edges.append((point_id(a), point_id(b)))
    graph = [[] for _ in points2]
    for a, b in edges:
        graph[a].append(b)
        graph[b].append(a)
    seen = np.zeros(len(points2), dtype=bool)
    components = []
    pts_arr = np.asarray(points2)
    for start in range(len(points2)):
        if seen[start]:
            continue
        stack = [start]
        seen[start] = True
        ids = []
        while stack:
            cur = stack.pop()
            ids.append(cur)
            for nxt in graph[cur]:
                if not seen[nxt]:
                    seen[nxt] = True
                    stack.append(nxt)
        if len(ids) < 9:
            continue
        values = pts_arr[ids]
        components.append({"count": len(ids), "center": values.mean(axis=0), "min": values.min(axis=0), "max": values.max(axis=0)})
    components.sort(key=lambda c: c["center"][0])
    return components


def cross_section_contours_y(points: np.ndarray, faces: np.ndarray, y: float) -> list[np.ndarray]:
    """Trace closed X/Z contours at an exact source-Y slice for root support checks."""
    tri = points[faces]
    lo, hi = tri[:, :, 1].min(axis=1), tri[:, :, 1].max(axis=1)
    rows = tri[(lo < y) & (hi > y)]
    segments = []
    for t in rows:
        hits = []
        for a, b in ((0, 1), (1, 2), (2, 0)):
            pa, pb = t[a], t[b]
            if (pa[1] < y < pb[1]) or (pb[1] < y < pa[1]):
                q = pa + ((y - pa[1]) / (pb[1] - pa[1])) * (pb - pa)
                hits.append(q[[0, 2]])
        if len(hits) == 2:
            segments.append(hits)
    if not segments:
        return []
    point_ids: dict[tuple[int, int], int] = {}
    points2: list[np.ndarray] = []
    edges: set[tuple[int, int]] = set()
    def point_id(p: np.ndarray) -> int:
        key = tuple(np.rint(p * 1e7).astype(np.int64))
        if key not in point_ids:
            point_ids[key] = len(points2)
            points2.append(np.asarray(p, dtype=np.float64))
        return point_ids[key]
    for a, b in segments:
        ia, ib = point_id(a), point_id(b)
        if ia != ib:
            edges.add((min(ia, ib), max(ia, ib)))
    neighbors = [[] for _ in points2]
    for a, b in edges:
        neighbors[a].append(b)
        neighbors[b].append(a)
    visited: set[tuple[int, int]] = set()
    loops = []
    for edge in edges:
        if edge in visited:
            continue
        start, prev, cur = edge[0], edge[0], edge[1]
        chain = [start]
        visited.add(edge)
        guard = 0
        while cur != start and guard < len(edges) + 1:
            chain.append(cur)
            options = [n for n in neighbors[cur] if n != prev and (min(cur, n), max(cur, n)) not in visited]
            if not options:
                break
            nxt = options[0]
            visited.add((min(cur, nxt), max(cur, nxt)))
            prev, cur = cur, nxt
            guard += 1
        if cur == start and len(chain) >= 8:
            loops.append(np.asarray([points2[i] for i in chain], dtype=np.float64))
    return loops


def point_inside_polygon_xz(point: np.ndarray, polygon: np.ndarray) -> bool:
    x, z = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, zi = polygon[i]
        xj, zj = polygon[j]
        if ((zi > z) != (zj > z)) and (x < (xj - xi) * (z - zi) / (zj - zi + 1e-30) + xi):
            inside = not inside
        j = i
    return inside


def polygon_boundary_distance(point: np.ndarray, polygon: np.ndarray) -> float:
    best = float("inf")
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
        ab = b - a
        t = np.clip(np.dot(point - a, ab) / max(np.dot(ab, ab), 1e-30), 0, 1)
        best = min(best, float(np.linalg.norm(point - (a + t * ab))))
    return best


def apply_reference_carpal_roots(landmarks_source: dict[str, np.ndarray], ref_landmarks: dict[str, np.ndarray],
                                 source_to_rest: np.ndarray, source_points: np.ndarray, source_faces: np.ndarray,
                                 metrics_out: dict) -> dict[str, dict]:
    """Set CMC/metacarpal pivots from canonical anchors, then require source-volume support.

    This is intentionally a reference-assisted pivot choice: all MCP, PIP, DIP,
    and tip anchors remain estimated from the source geometry. The fitted mesh
    similarity stays fixed; reference CMC points are inverse-mapped into source
    coordinates and must lie inside an exact source-Y cross-section contour.
    """
    inverse = np.linalg.inv(source_to_rest)
    wrist = np.asarray(landmarks_source["wrist"], dtype=np.float64)
    metadata = {}
    for digit in ("pinky", "ring", "middle", "index", "thumb"):
        root_name = "thumb-metacarpal" if digit == "thumb" else f"{digit}-finger-metacarpal"
        mcp_name = "thumb-phalanx-proximal" if digit == "thumb" else f"{digit}-finger-phalanx-proximal"
        provisional = np.asarray(landmarks_source[root_name], dtype=np.float64).copy()
        ref_root = np.asarray(ref_landmarks[root_name], dtype=np.float64)
        source_root = (inverse @ np.asarray([*ref_root, 1.0]))[:3]
        ref_mcp_source = (inverse @ np.asarray([*ref_landmarks[mcp_name], 1.0]))[:3]
        mesh_mcp_source = np.asarray(landmarks_source[mcp_name], dtype=np.float64)
        ref_ray = ref_mcp_source - wrist
        mesh_ray = mesh_mcp_source - wrist
        ref_t = float(np.dot(source_root - wrist, ref_ray) / max(np.dot(ref_ray, ref_ray), 1e-15))
        mesh_t = float(np.dot(source_root - wrist, mesh_ray) / max(np.dot(mesh_ray, mesh_ray), 1e-15))
        loops = cross_section_contours_y(source_points, source_faces, float(source_root[1]))
        containing = [loop for loop in loops if point_inside_polygon_xz(source_root[[0, 2]], loop)]
        if not containing:
            raise ValueError(f"Reference-derived {digit} CMC anchor is outside source cross-section at y={source_root[1]:.5f}; loops={len(loops)}")
        loop = max(containing, key=len)
        boundary_distance = polygon_boundary_distance(source_root[[0, 2]], loop)
        if boundary_distance < .015:
            raise ValueError(f"Reference-derived {digit} CMC anchor is too close to source section boundary: {boundary_distance:.5f} source units")
        landmarks_source[root_name] = source_root
        metadata[digit] = {
            "joint": root_name,
            "referenceRestMeters": ref_root.astype(float).tolist(),
            "sourcePosition": source_root.astype(float).tolist(),
            "provisionalFractionalSourcePosition": provisional.astype(float).tolist(),
            "sourceDeltaFromProvisional": (source_root - provisional).astype(float).tolist(),
            "refRootFractionAlongReferenceWristToMcp": ref_t,
            "refRootProjectionAlongMeshDerivedWristToMcp": mesh_t,
            "sourceSectionY": float(source_root[1]),
            "closedSectionLoopCount": len(loops),
            "rootInsideSourceSection": True,
            "sectionLoopVertexCount": int(len(loop)),
            "sectionBoundsXZ": {"min": loop.min(axis=0).astype(float).tolist(), "max": loop.max(axis=0).astype(float).tolist()},
            "sectionBoundaryDistanceSourceUnits": boundary_distance,
            "sectionBoundaryDistanceFittedMeters": boundary_distance * float(np.cbrt(abs(np.linalg.det(source_to_rest[:3, :3])))),
        }
    metrics_out["metacarpalAnchorMethod"] = "canonical-left-reference CMC/metacarpal points inverse-mapped through the fixed global source-to-rest fit; exact source-Y section containment required"
    metrics_out["referenceAssistedCarpalRootAnchors"] = metadata
    metrics_out["fractionalWristToMcpAnchorsReplaced"] = True
    return metadata


def profile_center(points: np.ndarray, faces: np.ndarray, y: float, x_hint: float) -> np.ndarray:
    comps = cross_section_components(points, faces, 1, y)
    if not comps:
        raise ValueError(f"No Y cross-section contours at y={y:.4f}")
    c = min(comps, key=lambda row: abs(row["center"][0] - x_hint))
    return np.asarray([c["center"][0], y, c["center"][1]], dtype=np.float64)


def track_digit_profiles(points: np.ndarray, faces: np.ndarray, initial: dict[str, dict],
                         y_start: float = .512, y_stop: float = 1.04, step: float = .012) -> dict[str, list[dict]]:
    """Follow distinct source cross-section components until each digit ends."""
    tracks = {}
    for name, comp in initial.items():
        tracks[name] = {"last": comp, "lastY": .50, "previous": None, "lost": 0, "active": True, "rows": [(.50, comp)]}
    for y in np.arange(y_start, y_stop, step):
        comps = cross_section_components(points, faces, 1, float(y))
        if not comps:
            for track in tracks.values():
                if track["active"]:
                    track["lost"] += 1
                    if track["lost"] >= 2:
                        track["active"] = False
            if not any(row["active"] for row in tracks.values()):
                break
            continue
        pairs = []
        for digit, track in tracks.items():
            if not track["active"]:
                continue
            last_center = track["last"]["center"]
            if track["previous"] is None:
                predicted = last_center[0]
            else:
                py, px = track["previous"]
                slope = np.clip((last_center[0] - px) / max(track["lastY"] - py, 1e-6), -1.5, 1.5)
                predicted = last_center[0] + slope * (float(y) - track["lastY"])
            for ci, comp in enumerate(comps):
                dist = abs(float(comp["center"][0]) - predicted)
                if dist <= .095:
                    pairs.append((dist, digit, ci))
        assigned_digits, assigned_comps = set(), set()
        for _, digit, ci in sorted(pairs):
            if digit in assigned_digits or ci in assigned_comps:
                continue
            track = tracks[digit]
            track["previous"] = (track["lastY"], float(track["last"]["center"][0]))
            track["last"], track["lastY"], track["lost"] = comps[ci], float(y), 0
            track["rows"].append((float(y), comps[ci]))
            assigned_digits.add(digit); assigned_comps.add(ci)
        for digit, track in tracks.items():
            if track["active"] and digit not in assigned_digits:
                track["lost"] += 1
                if track["lost"] >= 2:
                    track["active"] = False
        if not any(row["active"] for row in tracks.values()):
            break
    return {name: track["rows"] for name, track in tracks.items()}


def get_rest_target(reference: dict, binary: bytes) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    refs = {}
    ref_nodes = reference["nodes"]
    sk = reference["skins"][0]
    names = [ref_nodes[i]["name"] for i in sk["joints"]]
    if set(names) != set(JOINT_NAMES) or len(names) != len(JOINT_NAMES):
        raise ValueError("reference skin must contain the expected 25 WebXR joints")
    for name in JOINT_NAMES:
        node = next(n for n in ref_nodes if n.get("name") == name)
        refs[name] = np.asarray(node["translation"], dtype=np.float64)
    # Use the reference left skeleton only to set world scale, wrist, and hand plane.
    return refs, {n: refs[n] for n in JOINT_NAMES}


def label_distal_finger_components(points: np.ndarray, faces: np.ndarray, y_cut: float = .50) -> tuple[np.ndarray, dict[int, dict]]:
    """Label welded surface components above the separated four-finger slice."""
    tri_y = points[faces, 1]
    kept_faces = faces[np.all(tri_y >= y_cut, axis=1)]
    if len(kept_faces) < 1000:
        raise ValueError("Too few source triangles lie above the finger-separation slice")
    qpos = np.rint(points * 1e7).astype(np.int64)
    unique, inverse = np.unique(qpos, axis=0, return_inverse=True)
    geom = unique.astype(np.float64) / 1e7
    gf = inverse[kept_faces]
    edges = np.concatenate([gf[:, [0, 1]], gf[:, [1, 2]], gf[:, [2, 0]]], axis=0)
    graph = coo_matrix((np.ones(len(edges), dtype=np.uint8), (edges[:, 0], edges[:, 1])), shape=(len(geom), len(geom))).tocsr()
    graph = graph.maximum(graph.T)
    _, labels = connected_components(graph, directed=False, return_labels=True)
    used = np.unique(gf)
    counts = np.bincount(labels[used], minlength=int(labels.max()) + 1)
    info = {}
    for component in np.flatnonzero(counts >= 20):
        ids = used[labels[used] == component]
        p = geom[ids]
        info[int(component)] = {"count": int(counts[component]), "center": p.mean(axis=0), "min": p.min(axis=0), "max": p.max(axis=0)}
    source_labels = labels[inverse]
    return source_labels, info


def derive_landmarks(source_points: np.ndarray, source_faces: np.ndarray, wrist: np.ndarray, metrics_out: dict | None = None) -> dict[str, np.ndarray]:
    """Estimate joint centers from source cross-sections and visible mesh creases.

    The MCPs are deliberately placed proximal to the first fully separated
    finger sections; they are not aliases for the y=.50 slice. PIP/DIP levels
    are found as local minima of each digit's cross-section width profile.
    These are geometric estimates, documented as such in the evidence.
    """
    profile = cross_section_components(source_points, source_faces, 1, 0.50)
    if len(profile) != 4:
        raise ValueError(f"Expected four separate finger contours at y=.50, found {len(profile)}")
    source_component_labels, component_info = label_distal_finger_components(source_points, source_faces, .50)
    # Source-mesh evidence fixes lateral order: pinky, ring, middle, index.
    digit_x = {name: float(profile[i]["center"][0]) for i, name in enumerate(("pinky", "ring", "middle", "index"))}
    digit_component = {}
    available = {i for i, info in component_info.items() if info["min"][1] <= .55 and info["max"][1] > .62 and info["count"] >= 1000}
    if len(available) < 4:
        raise ValueError(f"Expected at least four connected finger surface components above y=.50, found {len(available)}")
    for name in ("pinky", "ring", "middle", "index"):
        label = min(available, key=lambda i: abs(float(component_info[i]["center"][0]) - digit_x[name]))
        digit_component[name] = int(label)
        available.remove(label)
    if len(set(digit_component.values())) != 4:
        raise ValueError(f"Could not map four separated y=.50 contours to unique mesh components: {digit_component}")
    digit_x_halfwidth = {"pinky": .11, "ring": .09, "middle": .09, "index": .12}
    tri_xyz = source_points[source_faces]
    tri_xmin, tri_xmax = tri_xyz[:, :, 0].min(axis=1), tri_xyz[:, :, 0].max(axis=1)
    tri_ymin, tri_ymax = tri_xyz[:, :, 1].min(axis=1), tri_xyz[:, :, 1].max(axis=1)
    track_faces = source_faces[(tri_xmax >= -.60) & (tri_xmin <= .18) & (tri_ymax >= .49)]
    initial_profiles = {name: profile[i] for i, name in enumerate(("pinky", "ring", "middle", "index"))}
    tracks = track_digit_profiles(source_points, track_faces, initial_profiles)
    phalanx_profile_metrics = {}
    result: dict[str, np.ndarray] = {"wrist": wrist}
    for digit in ("pinky", "ring", "middle", "index"):
        x0 = digit_x[digit]
        if len(tracks[digit]) < 4:
            raise ValueError(f"Source cross-section track for {digit} ends before its distal phalanx")
        last_y, last_comp = tracks[digit][-1]
        component_mask = source_component_labels == digit_component[digit]
        cap_surface = source_points[component_mask]
        ys = cap_surface[:, 1]
        if len(ys) < 8:
            raise ValueError(f"Could not isolate the tracked {digit} fingertip cap")
        ymax = float(ys.max())
        tip_mask = component_mask & (source_points[:, 1] >= ymax - .008)
        # The terminal cap's actual source surface centroid estimates its center.
        tip = source_points[tip_mask].mean(axis=0)
        mcp_y = .395 if digit != "pinky" else .405
        # Extrapolate the isolated digit centerline from three separate source
        # contours into the palm; the whole palm cross-section is a single
        # component and must never supply all four MCP X/Z values.
        line_y = np.asarray([.50, .525, .55], dtype=np.float64)
        line_centers = np.asarray([profile_center(source_points, source_faces, float(yy), x0) for yy in line_y])
        x_slope = np.polyfit(line_y, line_centers[:, 0], 1)[0]
        z_slope = np.polyfit(line_y, line_centers[:, 2], 1)[0]
        mcp_x = float(np.polyfit(line_y, line_centers[:, 0], 1)[1] + x_slope * mcp_y)
        mcp_z_curve = float(np.polyfit(line_y, line_centers[:, 2], 1)[1] + z_slope * mcp_y)
        local_palm = source_points[(np.abs(source_points[:, 1] - mcp_y) < .012) & (np.abs(source_points[:, 0] - mcp_x) < .028)]
        if len(local_palm) < 8:
            raise ValueError(f"No local palm surface support for {digit} MCP at x={mcp_x:.4f}, y={mcp_y:.4f}")
        z_lo, z_hi = np.percentile(local_palm[:, 2], [5, 95])
        mcp = np.array([mcp_x, mcp_y, float((z_lo + z_hi) * .5)], dtype=np.float64)
        if abs(mcp[2] - mcp_z_curve) > .15:
            raise ValueError(f"{digit} MCP centerline extrapolation leaves the local palm surface: localZ={mcp[2]:.4f}, extrapolatedZ={mcp_z_curve:.4f}, support={len(local_palm)}")
        # Track the same isolated contour from the webbing toward the tip and
        # detect the two narrow joint/crease bands from the source silhouette.
        rows = []
        sample_hi = last_y - .018
        halfwidth = digit_x_halfwidth[digit] * .74
        local_mask = ((tri_xmax >= x0 - halfwidth) & (tri_xmin <= x0 + halfwidth) &
                      (tri_ymax >= .49) & (tri_ymin <= sample_hi + .01))
        local_faces = source_faces[local_mask]
        for yy in np.arange(.50, sample_hi, .012):
            comps = cross_section_components(source_points, local_faces, 1, float(yy))
            if not comps:
                continue
            comp = min(comps, key=lambda c: abs(c["center"][0] - x0))
            width = float(comp["max"][0] - comp["min"][0])
            rows.append((float(yy), width, comp["center"].copy()))
        rows = [r for r in rows if r[0] > mcp_y + .05]
        if len(rows) >= 8:
            ys_profile = np.asarray([r[0] for r in rows])
            widths = np.asarray([r[1] for r in rows])
            # A small moving average removes mesh tessellation noise while
            # retaining the circumferential depressions at finger joints.
            smooth = np.convolve(widths, np.ones(3) / 3, mode="same")
            lo_pip, hi_pip = max(0, int(len(rows) * .30)), max(2, int(len(rows) * .64))
            lo_dip, hi_dip = max(0, int(len(rows) * .60)), max(2, int(len(rows) * .91))
            def minimum_in(a: int, b: int, fallback: float) -> tuple[float, bool]:
                a, b = max(a, 2), min(b, len(rows) - 2)
                candidates = [i for i in range(a, b) if smooth[i] <= smooth[i-1] and smooth[i] <= smooth[i+1]]
                if not candidates:
                    return fallback, False
                # Prefer pronounced constrictions while avoiding the rounded tip.
                chosen = min(candidates, key=lambda i: smooth[i])
                return float(ys_profile[chosen]), True
            pip_y, pip_from_width_minimum = minimum_in(lo_pip, hi_pip, .50 + .43 * (ymax - .50))
            dip_y, dip_from_width_minimum = minimum_in(lo_dip, hi_dip, .50 + .73 * (ymax - .50))
            if dip_y <= pip_y + .035:
                pip_y = .50 + .43 * (ymax - .50)
                dip_y = .50 + .73 * (ymax - .50)
                pip_from_width_minimum = False
                dip_from_width_minimum = False
        else:
            pip_y = .50 + .43 * (ymax - .50)
            dip_y = .50 + .73 * (ymax - .50)
            pip_from_width_minimum = False
            dip_from_width_minimum = False
        phalanx_profile_metrics[digit] = {"sourcePipY": float(pip_y), "sourceDipY": float(dip_y),
                                          "pipFromCrossSectionWidthMinimum": bool(pip_from_width_minimum),
                                          "dipFromCrossSectionWidthMinimum": bool(dip_from_width_minimum),
                                          "crossSectionSamples": len(rows), "fallbackBasis": "distance fractions from first separated finger contour to tracked terminal cap when no stable constriction exists"}
        pip = profile_center(source_points, local_faces, pip_y, x0)
        dip = profile_center(source_points, local_faces, dip_y, x0)
        meta = wrist + .60 * (mcp - wrist)
        result[f"{digit}-finger-tip"] = tip
        result[f"{digit}-finger-phalanx-distal"] = dip
        result[f"{digit}-finger-phalanx-intermediate"] = pip
        result[f"{digit}-finger-phalanx-proximal"] = mcp
        result[f"{digit}-finger-metacarpal"] = meta

    # Thumb sections separate on the radial (+X) side by y=.20. Extrapolate
    # its centerline from those distinct sections back to its MCP at y=.18;
    # the lower slice is still joined to the palm and cannot label the thumb.
    thumb_line_y = np.asarray([.20, .225, .25], dtype=np.float64)
    thumb_line = []
    for yy in thumb_line_y:
        comps = cross_section_components(source_points, source_faces, 1, float(yy))
        if len(comps) < 2:
            raise ValueError(f"Thumb is not separately identifiable at source y={yy:.3f}")
        thumb_line.append(max(comps, key=lambda c: float(c["center"][0]))["center"])
    thumb_line = np.asarray(thumb_line)
    thumb_x_coeff = np.polyfit(thumb_line_y, thumb_line[:, 0], 1)
    thumb_z_coeff = np.polyfit(thumb_line_y, thumb_line[:, 1], 1)
    thumb_mcp_y = .18
    thumb_mcp_x = float(np.polyval(thumb_x_coeff, thumb_mcp_y))
    thumb_mcp_z_fit = float(np.polyval(thumb_z_coeff, thumb_mcp_y))
    thumb_root_support = source_points[(np.abs(source_points[:, 1] - thumb_mcp_y) < .02) & (np.abs(source_points[:, 0] - thumb_mcp_x) < .045)]
    if len(thumb_root_support) >= 8:
        zlo, zhi = np.percentile(thumb_root_support[:, 2], [5, 95])
        thumb_mcp_z = float((zlo + zhi) * .5)
    else:
        thumb_mcp_z = thumb_mcp_z_fit
    thumb_mcp = np.array([thumb_mcp_x, thumb_mcp_y, thumb_mcp_z], dtype=np.float64)
    # The thumb terminal cap is the far radial point; its real surface vertices
    # provide tip placement without borrowing any WebXR joint centers.
    tmask = (source_points[:, 0] > .40) & (source_points[:, 1] > .12) & (source_points[:, 1] < .42)
    tpoints = source_points[tmask]
    if len(tpoints) < 20:
        raise ValueError("Could not isolate the thumb surface from source mesh")
    xmax = float(tpoints[:, 0].max())
    cap = tpoints[tpoints[:, 0] >= xmax - .008]
    thumb_tip = cap.mean(axis=0)
    thumb_distal = thumb_mcp + .72 * (thumb_tip - thumb_mcp)
    thumb_meta = wrist + .44 * (thumb_mcp - wrist)
    result["thumb-tip"] = thumb_tip
    result["thumb-phalanx-distal"] = thumb_distal
    result["thumb-phalanx-proximal"] = thumb_mcp
    result["thumb-metacarpal"] = thumb_meta
    if set(result) != set(JOINT_NAMES):
        raise ValueError(f"Landmark set mismatch: {set(JOINT_NAMES) ^ set(result)}")
    mcp_xs = np.asarray([result[f"{d}-finger-phalanx-proximal"][0] for d in ("pinky", "ring", "middle", "index")])
    mcp_spacing = np.diff(mcp_xs)
    if not (np.all(mcp_spacing > .055) and np.all(mcp_spacing < .20)):
        raise ValueError(f"Extrapolated MCP landmarks are not distinct/ordered in palm; x={mcp_xs.tolist()} spacing={mcp_spacing.tolist()}")
    if result["thumb-phalanx-proximal"][0] < result["index-finger-phalanx-proximal"][0] + .15:
        raise ValueError("Thumb MCP is not radially distinct from the index-finger MCP")
    tip_xs = np.asarray([result[f"{d}-finger-tip"][0] for d in ("pinky", "ring", "middle", "index")])
    if not np.all(np.diff(tip_xs) > .06):
        raise ValueError(f"Connected-component fingertip caps violate pinky-to-index lateral order: {tip_xs.tolist()}")
    tip_ys = np.asarray([result[f"{d}-finger-tip"][1] for d in ("pinky", "ring", "middle", "index")])
    if not (tip_ys[0] + .06 < min(tip_ys[1:]) and tip_ys[2] > max(tip_ys[1], tip_ys[3]) + .025):
        raise ValueError(f"Connected-component fingertip lengths are implausible (pinky should be shorter and middle longest): {tip_ys.tolist()}")
    # Every articulated segment needs a meaningful rest direction.
    for digit, names in DIGIT_JOINTS.items():
        lengths = [np.linalg.norm(result[b] - result[a]) for a, b in zip(names[:-1], names[1:])]
        if min(lengths) < .025:
            raise ValueError(f"Degenerate {digit} bone chain segment(s): {lengths}")
    if metrics_out is not None:
        metrics_out.update({"separatedContoursAtY": .50, "separatedContourCount": len(profile),
                            "digitSurfaceComponents": {name: {"componentId": digit_component[name], "componentVertexCount": component_info[digit_component[name]]["count"],
                                "sourceTipY": float(source_points[source_component_labels == digit_component[name], 1].max()),
                                "sourceTipXYZ": result[f"{name}-finger-tip"].astype(float).tolist()} for name in ("pinky", "ring", "middle", "index")},
                            "mcpXSource": {name: float(result[f"{name}-finger-phalanx-proximal"][0]) for name in ("pinky", "ring", "middle", "index")},
                            "mcpSpacingSource": mcp_spacing.astype(float).tolist(),
                            "thumbMcpSource": result["thumb-phalanx-proximal"].astype(float).tolist(),
                            "digitPhalanxProfileEstimates": phalanx_profile_metrics,
                            "metacarpalAnchorMethod": "fractional wrist-to-MCP interpolation; source mesh has no joint/skeleton annotations"})
    return result


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        pivot = np.cross(a, np.array([1.0, 0.0, 0.0]))
        if np.linalg.norm(pivot) < 1e-6:
            pivot = np.cross(a, np.array([0.0, 1.0, 0.0]))
        pivot /= np.linalg.norm(pivot)
        return 2 * np.outer(pivot, pivot) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]], dtype=np.float64)
    return np.eye(3) + vx + vx @ vx / max(1e-12, 1 + c)


def basis_rotation(src_wrist: np.ndarray, src_mid: np.ndarray, src_pinky: np.ndarray, src_index: np.ndarray,
                   dst_wrist: np.ndarray, dst_mid: np.ndarray, dst_pinky: np.ndarray, dst_index: np.ndarray) -> np.ndarray:
    sl = (src_mid - src_wrist); sl /= np.linalg.norm(sl)
    st = src_index - src_pinky; st -= sl * np.dot(st, sl); st /= np.linalg.norm(st)
    sn = np.cross(st, sl); sn /= np.linalg.norm(sn)
    dl = (dst_mid - dst_wrist); dl /= np.linalg.norm(dl)
    dt = dst_index - dst_pinky; dt -= dl * np.dot(dt, dl); dt /= np.linalg.norm(dt)
    dn = np.cross(dt, dl); dn /= np.linalg.norm(dn)
    bs = np.column_stack([st, sl, sn])
    bd = np.column_stack([dt, dl, dn])
    r = bd @ bs.T
    if np.linalg.det(r) < 0.999:
        raise ValueError("Source-to-rest basis is not a proper rotation")
    return r


def quaternion_from_minus_z(direction: np.ndarray) -> np.ndarray:
    """Quaternion [x,y,z,w] rotating local -Z onto direction."""
    v = np.asarray(direction, dtype=np.float64)
    v /= max(np.linalg.norm(v), 1e-12)
    a = np.array([0.0, 0.0, -1.0])
    c = float(np.dot(a, v))
    if c < -0.999999:
        return np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float64)
    q = np.r_[np.cross(a, v), 1.0 + c]
    q /= np.linalg.norm(q)
    return q


def quaternion_from_rotation_matrix(m: np.ndarray) -> np.ndarray:
    """Convert a proper 3x3 rotation matrix to glTF [x,y,z,w]."""
    m = np.asarray(m, dtype=np.float64)
    tr = float(np.trace(m))
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = np.array([(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s,
                      (m[1, 0] - m[0, 1]) / s, .25 * s])
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = np.array([.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s])
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = np.array([(m[0, 1] + m[1, 0]) / s, .25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s])
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = np.array([(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, .25 * s, (m[1, 0] - m[0, 1]) / s])
    return q / np.linalg.norm(q)


def quaternion_from_hand_basis(direction: np.ndarray, dorsal_axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Create a full hinge/dorsal basis: +Y dorsal, +X hinge, -Z forward."""
    direction = normalize_rows(np.asarray(direction, dtype=np.float64)[None, :])[0]
    z_axis = -direction
    y_axis = np.asarray(dorsal_axis, dtype=np.float64)
    y_axis = y_axis - z_axis * np.dot(y_axis, z_axis)
    if np.linalg.norm(y_axis) < 1e-7:
        raise ValueError("dorsal direction is parallel to bone forward axis")
    y_axis /= np.linalg.norm(y_axis)
    x_axis = np.cross(y_axis, z_axis)
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    basis = np.column_stack([x_axis, y_axis, z_axis])
    if np.linalg.det(basis) < .999:
        raise ValueError("bone basis is not right-handed")
    q = quaternion_from_rotation_matrix(basis)
    reconstructed = quat_matrix(q, np.zeros(3))[:3, :3]
    if np.max(np.abs(reconstructed - basis)) > 1e-5:
        raise ValueError("quaternion conversion does not preserve the requested full bone basis")
    return q, y_axis


def quat_matrix(q: np.ndarray, t: np.ndarray) -> np.ndarray:
    x, y, z, w = q
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = np.array([
        [1 - 2*(y*y + z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1 - 2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1 - 2*(x*x+y*y)],
    ])
    m[:3, 3] = t
    return m


def segment_distance_projection(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    v = b - a
    denom = float(np.dot(v, v))
    t = np.clip(((points - a) @ v) / max(denom, 1e-20), 0.0, 1.0)
    closest = a + t[:, None] * v
    d2 = np.sum((points - closest) ** 2, axis=1)
    return d2, t


def legacy_weights_for_vertices(points: np.ndarray, landmarks: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, dict]:
    """Previous threshold-based field, retained for candidate comparisons."""
    n = len(points)
    # Segment candidates are digit-local, preventing foreign finger influence.
    best_d2 = np.full((n, len(DIGITS)), np.inf, dtype=np.float64)
    best_segment = np.zeros((n, len(DIGITS)), dtype=np.int8)
    best_t = np.zeros((n, len(DIGITS)), dtype=np.float64)
    for di, digit in enumerate(DIGITS):
        names = DIGIT_JOINTS[digit]
        for si, (na, nb) in enumerate(zip(names[:-1], names[1:])):
            d2, t = segment_distance_projection(points, landmarks[na], landmarks[nb])
            take = d2 < best_d2[:, di]
            best_d2[take, di] = d2[take]
            best_segment[take, di] = si
            best_t[take, di] = t[take]
    selected = np.argmin(best_d2, axis=1)
    joint_ids = np.zeros((n, 4), dtype=np.uint8)
    w = np.zeros((n, 4), dtype=np.float64)
    digit_mcp = np.zeros(n, dtype=np.int16)
    for di, digit in enumerate(DIGITS):
        mask = selected == di
        digit_mcp[mask] = di
        names = DIGIT_JOINTS[digit]
        seg = best_segment[mask, di]
        alpha = best_t[mask, di]
        j0 = np.asarray([JOINT_NAMES.index(names[int(s)]) for s in seg], dtype=np.uint8)
        j1 = np.asarray([JOINT_NAMES.index(names[int(s)+1]) for s in seg], dtype=np.uint8)
        joint_ids[mask, 0] = j0
        joint_ids[mask, 1] = j1
        w[mask, 0] = 1.0 - alpha
        w[mask, 1] = alpha

    # Blend broad palm tissue into at most two nearby metacarpals and the wrist.
    palm = points[:, 1] < .22
    metacarpals = np.asarray([landmarks[DIGIT_JOINTS[d][0]] for d in DIGITS])
    if palm.any():
        d2 = np.sum((points[palm, None, :] - metacarpals[None, :, :]) ** 2, axis=2)
        two = np.argpartition(d2, 1, axis=1)[:, :2]
        chosen_d = np.take_along_axis(d2, two, axis=1)
        inv = 1.0 / np.maximum(chosen_d, 1e-8)
        inv /= inv.sum(axis=1, keepdims=True)
        y = points[palm, 1]
        # Wrist dominates only near the open boundary; the palm blends toward
        # nearby metacarpals as it approaches the finger roots.
        wrist_mix = np.clip((.02 - y) / (.02 - (CUT_Y + .025)), 0.0, .82)
        wrist_mix = wrist_mix * wrist_mix * (3.0 - 2.0 * wrist_mix)
        for row, vertex_i in enumerate(np.flatnonzero(palm)):
            joint_ids[vertex_i] = 0
            w[vertex_i] = 0.0
            joint_ids[vertex_i, 0] = JOINT_NAMES.index("wrist")
            w[vertex_i, 0] = wrist_mix[row]
            for slot in range(2):
                digit_index = int(two[row, slot])
                joint_ids[vertex_i, slot + 1] = JOINT_NAMES.index(DIGIT_JOINTS[DIGITS[digit_index]][0])
                w[vertex_i, slot + 1] = (1.0 - wrist_mix[row]) * inv[row, slot]
            digit_mcp[vertex_i] = -1

    # Merge duplicate influences and normalize, then quantize with exact byte sum.
    merged_ids = np.zeros_like(joint_ids)
    merged_w = np.zeros_like(w)
    for i in range(n):
        accum = defaultdict(float)
        for j, weight in zip(joint_ids[i], w[i]):
            if weight > 1e-8:
                accum[int(j)] += float(weight)
        top = sorted(accum.items(), key=lambda item: item[1], reverse=True)[:4]
        total = sum(value for _, value in top)
        if total <= 0:
            raise ValueError(f"Vertex {i} has no skin influence")
        for k, (joint, weight) in enumerate(top):
            merged_ids[i, k] = joint
            merged_w[i, k] = weight / total
    scaled = merged_w * 255.0
    quant = np.floor(scaled).astype(np.uint8)
    residual = 255 - quant.sum(axis=1).astype(np.int16)
    for i in range(n):
        if residual[i] > 0:
            order = np.argsort(scaled[i] - quant[i])[::-1]
            quant[i, order[:residual[i]]] += 1
    joint_digit = {}
    for di, digit in enumerate(DIGITS):
        for name in DIGIT_JOINTS[digit]:
            joint_digit[JOINT_NAMES.index(name)] = di
    other_digit = np.zeros(n, dtype=bool)
    for vertex_i in np.flatnonzero(digit_mcp >= 0):
        for joint_i, weight in zip(merged_ids[vertex_i], merged_w[vertex_i]):
            if weight > 1e-5 and int(joint_i) in joint_digit and joint_digit[int(joint_i)] != int(digit_mcp[vertex_i]):
                other_digit[vertex_i] = True
                break
    metrics = {
        "sumMin": float((quant.sum(axis=1) / 255.0).min()),
        "sumMax": float((quant.sum(axis=1) / 255.0).max()),
        "palmVertexCount": int(palm.sum()),
        "nonPalmCrossFingerVertexCount": int(other_digit.sum()),
    }
    return merged_ids, quant, metrics


def dense_weights(joint_ids: np.ndarray, quantized: np.ndarray, joint_count: int = len(JOINT_NAMES)) -> np.ndarray:
    dense = np.zeros((len(joint_ids), joint_count), dtype=np.float64)
    rows = np.repeat(np.arange(len(joint_ids)), joint_ids.shape[1])
    np.add.at(dense, (rows, joint_ids.reshape(-1)), quantized.reshape(-1).astype(np.float64) / 255.0)
    return dense


def compact_weights(dense: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Keep the four strongest influences and quantize them to an exact byte sum."""
    n, joint_count = dense.shape
    joint_ids = np.zeros((n, 4), dtype=np.uint8)
    weights = np.zeros((n, 4), dtype=np.float64)
    for i in range(n):
        selected = sorted(range(joint_count), key=lambda joint: (-dense[i, joint], joint))[:4]
        values = dense[i, selected]
        total = float(values.sum())
        if total <= 0.0 or not np.isfinite(total):
            raise ValueError(f"Vertex {i} has no finite skin influence")
        joint_ids[i] = selected
        weights[i] = values / total
    scaled = weights * 255.0
    quant = np.floor(scaled).astype(np.uint8)
    residual = 255 - quant.sum(axis=1).astype(np.int16)
    for i in range(n):
        if residual[i] > 0:
            order = np.argsort(scaled[i] - quant[i])[::-1]
            quant[i, order[:residual[i]]] += 1
    joint_ids[quant == 0] = 0
    return joint_ids, quant


def graph_heat_smooth(points: np.ndarray, faces: np.ndarray, dense: np.ndarray,
                      steps: int = 2, alpha: float = .18) -> tuple[np.ndarray, int]:
    """Diffuse a small amount over the welded triangle graph, never across UV-only splits."""
    keys = np.rint(points * 1e7).astype(np.int64)
    unique_keys, inverse = np.unique(keys, axis=0, return_inverse=True)
    unique_points = unique_keys.astype(np.float64) / 1e7
    if len(unique_points) == len(points):
        unique_dense = dense.copy()
    else:
        unique_dense = np.zeros((len(unique_points), dense.shape[1]), dtype=np.float64)
        counts = np.bincount(inverse, minlength=len(unique_points)).astype(np.float64)
        np.add.at(unique_dense, inverse, dense)
        unique_dense /= counts[:, None]
    welded_faces = inverse[np.asarray(faces, dtype=np.int64)]
    edge_parts = np.concatenate((welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]), axis=0)
    edge_parts.sort(axis=1)
    edge_pairs = np.unique(edge_parts, axis=0)
    valid = edge_pairs[:, 0] != edge_pairs[:, 1]
    edge_pairs = edge_pairs[valid]
    lengths = np.linalg.norm(unique_points[edge_pairs[:, 0]] - unique_points[edge_pairs[:, 1]], axis=1)
    valid = lengths > 1e-10
    edge_pairs, lengths = edge_pairs[valid], lengths[valid]
    # Inverse-length conductance gives short shared tissue edges slightly more
    # influence while remaining symmetric and independent of UV duplication.
    conductance = 1.0 / np.maximum(lengths, np.median(lengths) * .25)
    rows = np.concatenate((edge_pairs[:, 0], edge_pairs[:, 1]))
    cols = np.concatenate((edge_pairs[:, 1], edge_pairs[:, 0]))
    values = np.concatenate((conductance, conductance))
    adjacency = coo_matrix((values, (rows, cols)), shape=(len(unique_points), len(unique_points))).tocsr()
    degree = np.asarray(adjacency.sum(axis=1)).reshape(-1)
    active = degree > 0
    for _ in range(steps):
        neighbor_mean = unique_dense.copy()
        neighbor_mean[active] = adjacency[active] @ unique_dense / degree[active, None]
        unique_dense = (1.0 - alpha) * unique_dense + alpha * neighbor_mean
        unique_dense /= np.maximum(unique_dense.sum(axis=1, keepdims=True), 1e-15)
    return unique_dense[inverse], int(len(unique_points))


def topological_digit_partition(points: np.ndarray, faces: np.ndarray,
                                landmarks: dict[str, np.ndarray], temperature_source_units: float = .05
                                ) -> tuple[np.ndarray, np.ndarray, dict]:
    """Partition the palm/web from isolated distal seeds using welded-mesh geodesics.

    Four finger seeds are the disconnected components above the documented
    y=.5 source cross-section. The thumb seed is its separate positive-X lobe
    in the y=.2 cross-section range; the wrist seed is the natural cut loop.
    These are fixed anchors only. Elsewhere, multi-source geodesic distance
    creates a continuous soft partition through connected tissue.
    """
    keys = np.rint(points * 1e7).astype(np.int64)
    unique_keys, inverse = np.unique(keys, axis=0, return_inverse=True)
    unique_points = unique_keys.astype(np.float64) / 1e7
    welded_faces = inverse[np.asarray(faces, dtype=np.int64)]
    edge_parts = np.concatenate((welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]), axis=0)
    edge_parts.sort(axis=1)
    edge_pairs = np.unique(edge_parts, axis=0)
    edge_pairs = edge_pairs[edge_pairs[:, 0] != edge_pairs[:, 1]]
    edge_lengths = np.linalg.norm(unique_points[edge_pairs[:, 0]] - unique_points[edge_pairs[:, 1]], axis=1)
    valid = edge_lengths > 1e-10
    edge_pairs, edge_lengths = edge_pairs[valid], edge_lengths[valid]
    rows = np.concatenate((edge_pairs[:, 0], edge_pairs[:, 1]))
    cols = np.concatenate((edge_pairs[:, 1], edge_pairs[:, 0]))
    graph_lengths = np.concatenate((edge_lengths, edge_lengths))
    graph = coo_matrix((graph_lengths, (rows, cols)), shape=(len(unique_points), len(unique_points))).tocsr()

    active = np.flatnonzero(unique_points[:, 1] > .5)
    if len(active) == 0:
        raise ValueError("No isolated distal finger vertices found above source y=.5")
    component_count, component_labels = connected_components(graph[active][:, active], directed=False)
    component_sizes = np.bincount(component_labels, minlength=component_count)
    candidate_components = np.argsort(component_sizes)[::-1]
    candidate_components = [int(i) for i in candidate_components if component_sizes[i] >= 40][:4]
    if len(candidate_components) != 4:
        raise ValueError(f"Expected four isolated digit cores above y=.5; found component sizes {sorted(component_sizes, reverse=True)[:8]}")
    components = []
    for component_id in candidate_components:
        seeds = active[component_labels == component_id]
        components.append((float(unique_points[seeds, 0].mean()), seeds))
    components.sort(key=lambda row: row[0])
    anatomical_order = sorted(DIGITS[:4], key=lambda digit: float(landmarks[DIGIT_JOINTS[digit][0]][0]))
    seed_by_digit = {digit: seeds for digit, (_, seeds) in zip(anatomical_order, components)}

    digit_distances = np.full((len(unique_points), len(DIGITS)), np.inf, dtype=np.float64)
    for di, digit in enumerate(DIGITS):
        chain = DIGIT_JOINTS[digit]
        for name_a, name_b in [("wrist", chain[0]), *zip(chain[:-1], chain[1:])]:
            d2, _ = segment_distance_projection(unique_points, landmarks[name_a], landmarks[name_b])
            digit_distances[:, di] = np.minimum(digit_distances[:, di], d2)
    thumb_mask = ((unique_points[:, 0] > .18) & (unique_points[:, 1] > .08) &
                  (unique_points[:, 1] < .38) &
                  (np.argmin(digit_distances, axis=1) == DIGITS.index("thumb")))
    thumb_seeds = np.flatnonzero(thumb_mask)
    if len(thumb_seeds) < 8:
        raise ValueError(f"Thumb isolated-lobe seed too small: {len(thumb_seeds)} vertices")
    seed_by_digit["thumb"] = thumb_seeds

    loops, _, _ = boundary_loops(unique_points, welded_faces)
    if not loops:
        raise ValueError("Could not locate the natural wrist boundary for weight anchoring")
    wrist_seeds = np.asarray(min(loops, key=lambda loop: float(unique_points[loop, 1].mean())), dtype=np.int64)
    if len(wrist_seeds) < 8:
        raise ValueError(f"Natural wrist boundary seed too small: {len(wrist_seeds)} vertices")
    seed_groups = [seed_by_digit[digit] for digit in DIGITS] + [wrist_seeds]
    class_count = len(seed_groups)
    extra_rows, extra_cols = [], []
    for class_i, seed_vertices in enumerate(seed_groups):
        source_node = len(unique_points) + class_i
        extra_rows.extend([source_node] * len(seed_vertices))
        extra_cols.extend(seed_vertices.tolist())
    extra_rows = np.asarray(extra_rows, dtype=np.int64)
    extra_cols = np.asarray(extra_cols, dtype=np.int64)
    extra_values = np.full(len(extra_rows), 1e-12, dtype=np.float64)
    augmented = coo_matrix((np.concatenate((graph.tocoo().data, extra_values, extra_values)),
                            (np.concatenate((graph.tocoo().row, extra_rows, extra_cols)),
                             np.concatenate((graph.tocoo().col, extra_cols, extra_rows)))),
                           shape=(len(unique_points) + class_count, len(unique_points) + class_count)).tocsr()
    distances = dijkstra(augmented, directed=False,
                         indices=np.arange(len(unique_points), len(unique_points) + class_count))[:, :len(unique_points)]
    if not np.isfinite(distances).all():
        raise ValueError("Some mesh vertices are disconnected from every anatomical seed")
    relative = distances - distances.min(axis=0, keepdims=True)
    scores = np.exp(-relative / max(temperature_source_units, 1e-9))
    probabilities = scores / np.maximum(scores.sum(axis=0, keepdims=True), 1e-15)
    seed_class = np.full(len(unique_points), -1, dtype=np.int8)
    for class_i, seed_vertices in enumerate(seed_groups):
        if np.any(seed_class[seed_vertices] >= 0):
            raise ValueError("Anatomical weight seed regions overlap")
        seed_class[seed_vertices] = class_i
        probabilities[:, seed_vertices] = 0.0
        probabilities[class_i, seed_vertices] = 1.0
    metrics = {"method": "multi-source geodesic softmax on welded mesh graph; fixed isolated distal seeds",
               "temperatureSourceUnits": temperature_source_units,
               "fourFingerCoreComponentSizes": {digit: int(len(seed_by_digit[digit])) for digit in DIGITS[:4]},
               "thumbLobeSeedVertices": int(len(thumb_seeds)), "wristBoundarySeedVertices": int(len(wrist_seeds)),
               "seedVerticesFixedToAnatomicalClass": int(np.count_nonzero(seed_class >= 0)),
               "isolatedCoreYSourceUnits": .5,
               "thumbSeedRegionSourceUnits": {"xGreaterThan": .18, "yGreaterThan": .08, "yLessThan": .38}}
    return probabilities.T[inverse], seed_class[inverse] >= 0, metrics


def weights_for_vertices(points: np.ndarray, landmarks: dict[str, np.ndarray], faces: np.ndarray,
                         sigma_source_units: float = .03, heat_steps: int = 2,
                         heat_alpha: float = .18, topology_temperature: float = .05
                         ) -> tuple[np.ndarray, np.ndarray, dict]:
    """Build continuous bone weights with topologically isolated digit cores.

    Gaussian bone-distance weights distribute influences within a digit chain.
    A geodesic soft partition prevents nearby but disconnected distal fingers
    from influencing one another and fades the digit labels through shared palm
    tissue. The final graph-heat pass is performed on welded geometry.
    """
    if sigma_source_units <= 0 or heat_steps < 0 or not 0 <= heat_alpha < 1:
        raise ValueError("Invalid continuous skin-weight field parameters")
    edges: list[tuple[str, str, str]] = []
    for digit in DIGITS:
        chain = DIGIT_JOINTS[digit]
        edges.append(("wrist", chain[0], digit))
        edges.extend((a, b, digit) for a, b in zip(chain[:-1], chain[1:]))
    segment_distances = np.empty((len(points), len(edges)), dtype=np.float64)
    segment_t = np.empty_like(segment_distances)
    for ei, (name_a, name_b, _) in enumerate(edges):
        segment_distances[:, ei], segment_t[:, ei] = segment_distance_projection(
            points, landmarks[name_a], landmarks[name_b]
        )
    min_distance = segment_distances.min(axis=1, keepdims=True)
    scores = np.exp(-0.5 * (segment_distances - min_distance) / (sigma_source_units ** 2))
    scores = np.maximum(scores, 1e-14)
    dense = np.zeros((len(points), len(JOINT_NAMES)), dtype=np.float64)
    for ei, (name_a, name_b, _) in enumerate(edges):
        ia, ib = JOINT_NAMES.index(name_a), JOINT_NAMES.index(name_b)
        t = segment_t[:, ei]
        dense[:, ia] += scores[:, ei] * (1.0 - t)
        dense[:, ib] += scores[:, ei] * t
    dense /= np.maximum(dense.sum(axis=1, keepdims=True), 1e-15)
    partition, seed_mask, partition_metrics = topological_digit_partition(
        points, faces, landmarks, temperature_source_units=topology_temperature
    )
    partitioned = np.zeros_like(dense)
    for di, digit in enumerate(DIGITS):
        ids = np.asarray([JOINT_NAMES.index(name) for name in DIGIT_JOINTS[digit]], dtype=np.int64)
        within_chain = dense[:, ids]
        within_chain /= np.maximum(within_chain.sum(axis=1, keepdims=True), 1e-15)
        partitioned[:, ids] = partition[:, di, None] * within_chain
    partitioned[:, JOINT_NAMES.index("wrist")] = partition[:, len(DIGITS)]
    fixed_seed_values = partitioned[seed_mask].copy()
    partitioned, welded_vertices = graph_heat_smooth(points, faces, partitioned, steps=heat_steps, alpha=heat_alpha)
    partitioned[seed_mask] = fixed_seed_values
    dense = partitioned
    joint_ids, quant = compact_weights(dense)
    sums = quant.sum(axis=1).astype(np.float64) / 255.0
    metrics = {
        "method": "geodesic topological digit partition times Gaussian within-chain bone weights plus welded graph heat diffusion",
        "sigmaSourceUnits": sigma_source_units,
        "heatSteps": heat_steps,
        "heatAlpha": heat_alpha,
        "topologyPartition": partition_metrics,
        "weldedGraphVertices": welded_vertices,
        "uvDuplicateWeightsIdentical": True,
        "sumMin": float(sums.min()),
        "sumMax": float(sums.max()),
        "palmReferenceVertexCount": int(np.count_nonzero(points[:, 1] < .22)),
    }
    return joint_ids, quant, metrics


def edge_weight_metrics(points: np.ndarray, faces: np.ndarray, joint_ids: np.ndarray,
                        quantized: np.ndarray, landmarks: dict[str, np.ndarray],
                        distance_scale: float) -> dict:
    """Measure actual neighboring skin-field jumps on welded geometry and finger isolation."""
    keys = np.rint(points * 1e7).astype(np.int64)
    unique_keys, inverse = np.unique(keys, axis=0, return_inverse=True)
    dense = dense_weights(joint_ids, quantized)
    unique_dense = np.zeros((len(unique_keys), dense.shape[1]), dtype=np.float64)
    counts = np.bincount(inverse, minlength=len(unique_keys)).astype(np.float64)
    np.add.at(unique_dense, inverse, dense)
    unique_dense /= counts[:, None]
    representatives = np.full(len(unique_keys), len(points), dtype=np.int64)
    np.minimum.at(representatives, inverse, np.arange(len(points), dtype=np.int64))
    seam_equal = bool(np.array_equal(quantized, quantized[representatives[inverse]]))
    welded_faces = inverse[np.asarray(faces, dtype=np.int64)]
    edge_parts = np.concatenate((welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]), axis=0)
    edge_parts.sort(axis=1)
    edge_pairs = np.unique(edge_parts, axis=0)
    edge_pairs = edge_pairs[edge_pairs[:, 0] != edge_pairs[:, 1]]
    delta = np.abs(unique_dense[edge_pairs[:, 0]] - unique_dense[edge_pairs[:, 1]]).sum(axis=1)
    a, b = unique_keys[edge_pairs[:, 0]].astype(np.float64) / 1e7, unique_keys[edge_pairs[:, 1]].astype(np.float64) / 1e7
    edge_lengths_m = np.linalg.norm(a - b, axis=1) * distance_scale
    y0, y1 = a[:, 1], b[:, 1]
    crossing = (np.minimum(y0, y1) < .22) & (np.maximum(y0, y1) >= .22)
    core_crossing = (np.minimum(y0, y1) < .5) & (np.maximum(y0, y1) >= .5)
    thumb_crossing = crossing & (0.5 * (a[:, 0] + b[:, 0]) > .15)
    by_digit = {}
    unique_points = unique_keys.astype(np.float64) / 1e7
    nearest_by_digit = np.full((len(unique_keys), len(DIGITS)), np.inf, dtype=np.float64)
    for di, digit in enumerate(DIGITS):
        chain = DIGIT_JOINTS[digit]
        for na, nb in zip(chain[:-1], chain[1:]):
            d2, _ = segment_distance_projection(unique_points, landmarks[na], landmarks[nb])
            nearest_by_digit[:, di] = np.minimum(nearest_by_digit[:, di], d2)
        d2, _ = segment_distance_projection(unique_points, landmarks["wrist"], landmarks[chain[0]])
        nearest_by_digit[:, di] = np.minimum(nearest_by_digit[:, di], d2)
    digit_joint_ids = {JOINT_NAMES.index(name): di for di, digit in enumerate(DIGITS) for name in DIGIT_JOINTS[digit]}
    digit_weights = np.zeros((len(unique_keys), len(DIGITS)), dtype=np.float64)
    for joint, digit_index in digit_joint_ids.items():
        digit_weights[:, digit_index] += unique_dense[:, joint]
    primary = np.argmin(nearest_by_digit, axis=1)
    foreign = digit_weights.copy()
    foreign[np.arange(len(primary)), primary] = 0.0
    isolated = (unique_keys[:, 1] / 1e7) > .50
    for di, digit in enumerate(DIGITS):
        mask = isolated & (primary == di)
        values = foreign[mask].max(axis=1) if mask.any() else np.asarray([0.0])
        by_digit[digit] = {"vertices": int(mask.sum()), "foreignInfluenceMean": float(values.mean()),
                           "foreignInfluenceP95": float(np.percentile(values, 95)), "foreignInfluenceMax": float(values.max())}
    thumb_region = ((unique_points[:, 0] > .18) & (unique_points[:, 1] > .08) &
                    (unique_points[:, 1] < .38) & (primary == DIGITS.index("thumb")))
    thumb_foreign = foreign[thumb_region].max(axis=1) if thumb_region.any() else np.asarray([0.0])
    by_digit["thumbBaseRegion"] = {"vertices": int(thumb_region.sum()),
                                   "foreignInfluenceMean": float(thumb_foreign.mean()),
                                   "foreignInfluenceP95": float(np.percentile(thumb_foreign, 95)),
                                   "foreignInfluenceMax": float(thumb_foreign.max()),
                                   "regionDefinitionSourceUnits": "x > .18; .08 < y < .38; nearest bone chain is thumb"}
    def summary(mask: np.ndarray) -> dict:
        selected = np.flatnonzero(mask)
        vals = delta[selected]
        lengths = edge_lengths_m[selected]
        gradients = vals / np.maximum(lengths, 1e-12)
        top = selected[np.argsort(vals)[-3:][::-1]] if len(selected) else np.asarray([], dtype=np.int64)
        top_edges = []
        for edge_i in top:
            endpoints = []
            for vertex_i in edge_pairs[edge_i]:
                active_joints = np.argsort(unique_dense[vertex_i])[::-1][:3]
                endpoints.append({"sourcePosition": unique_points[vertex_i].astype(float).tolist(),
                                  "dominantWeights": [{"joint": JOINT_NAMES[int(j)], "weight": float(unique_dense[vertex_i, j])}
                                                      for j in active_joints if unique_dense[vertex_i, j] > 1e-5]})
            top_edges.append({"l1": float(delta[edge_i]), "lengthMeters": float(edge_lengths_m[edge_i]),
                              "l1PerMeter": float(delta[edge_i] / max(edge_lengths_m[edge_i], 1e-12)),
                              "endpoints": endpoints})
        return {"edgeCount": int(len(selected)), "meanL1": float(vals.mean()) if len(vals) else 0.0,
                "p95L1": float(np.percentile(vals, 95)) if len(vals) else 0.0,
                "maxL1": float(vals.max()) if len(vals) else 0.0,
                "maxL1PerMeter": float(gradients.max()) if len(gradients) else 0.0,
                "edgeLengthP95Meters": float(np.percentile(lengths, 95)) if len(lengths) else 0.0,
                "worstEdges": top_edges}
    return {"allWeldedEdges": summary(np.ones(len(delta), dtype=bool)),
            "formerY022PlaneCrossings": summary(crossing),
            "isolatedCoreY050Crossings": summary(core_crossing),
            "thumbBaseFormerPlaneCrossings": summary(thumb_crossing),
            "isolatedFingerRegionYAbove050": by_digit,
            "uvSeamWeightsIdentical": seam_equal,
            "edgeL1Units": "sum absolute difference across 25 normalized joint weights; max possible 2",
            "edgeGradientUnits": "L1 weight change per fitted-rest meter; source coordinates multiplied by one uniform global fit"}


def unique_positions_for_boundaries(pos: np.ndarray, faces: np.ndarray, precision: int = 7) -> tuple[np.ndarray, np.ndarray]:
    key = np.round(pos, precision)
    unique, inv = np.unique(key, axis=0, return_inverse=True)
    return unique, inv[faces]


def boundary_loops(pos: np.ndarray, faces: np.ndarray) -> tuple[list[list[int]], list[int], int]:
    unique_pos, welded_faces = unique_positions_for_boundaries(pos, faces)
    edges = np.concatenate([welded_faces[:, [0, 1]], welded_faces[:, [1, 2]], welded_faces[:, [2, 0]]], axis=0)
    edges.sort(axis=1)
    values, counts = np.unique(edges, axis=0, return_counts=True)
    open_edges = values[counts == 1]
    adj = defaultdict(list)
    for a, b in open_edges:
        adj[int(a)].append(int(b)); adj[int(b)].append(int(a))
    loops = []
    seen = set()
    for start in adj:
        if start in seen:
            continue
        path = [start]
        seen.add(start)
        prev = -1
        cur = start
        while True:
            opts = [v for v in adj[cur] if v != prev]
            if not opts:
                break
            nxt = opts[0]
            if nxt == start:
                break
            if nxt in seen:
                break
            path.append(nxt); seen.add(nxt); prev, cur = cur, nxt
        loops.append(path)
    # Map each welded boundary point to an actual glTF vertex index.
    by_key = {}
    for i, row in enumerate(np.round(pos, 7)):
        by_key.setdefault(tuple(row), i)
    mapped = [[by_key[tuple(np.round(unique_pos[i], 7))] for i in path] for path in loops]
    mapped.sort(key=len, reverse=True)
    return mapped, [v for loop in mapped for v in loop], len(open_edges)


def add_view(data: bytearray, payload: bytes, target: int | None = None) -> int:
    while len(data) % 4:
        data.append(0)
    offset = len(data)
    data.extend(payload)
    view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
    if target is not None:
        view["target"] = target
    return view


def pack_glb(path: Path, pos: np.ndarray, normal: np.ndarray, tangent: np.ndarray, uv: np.ndarray,
             joints: np.ndarray, weights: np.ndarray, faces: np.ndarray, landmarks: dict[str, np.ndarray],
             texture_uris: dict[str, str], image_roughness_uri: str, dorsal_axis: np.ndarray) -> dict:
    n_v = len(pos)
    if n_v > 65535:
        index_dtype, index_component = np.uint32, 5125
    else:
        index_dtype, index_component = np.uint16, 5123
    p = np.asarray(pos, dtype="<f4")
    no_raw = np.clip(np.rint(normal * 32767), -32767, 32767).astype("<i2")
    # KHR_mesh_quantization requires the VEC3 short accessor's per-vertex
    # stride to remain four-byte aligned; pad the fourth short.
    no = np.zeros((n_v, 4), dtype="<i2")
    no[:, :3] = no_raw
    ta = np.column_stack([np.clip(np.rint(tangent[:, :3] * 32767), -32767, 32767), np.sign(tangent[:, 3]) * 32767]).astype("<i2")
    tc = np.clip(np.rint(np.clip(uv, 0.0, 1.0) * 65535), 0, 65535).astype("<u2")
    jj = np.asarray(joints, dtype="u1")
    ww = np.asarray(weights, dtype="u1")
    jj[ww == 0] = 0  # glTF validator warns on nonzero joint ids with zero weight.
    ix = faces.astype(index_dtype).reshape(-1)
    joint_transforms = []
    local_dorsal_dots = []
    bone_frames = {}
    nodes = [{"name": "ImprovedHandMesh", "mesh": 0, "skin": 0}]
    armature_i = 1
    nodes.append({"name": "Armature", "children": list(range(2, 27))})
    joint_node_indices = []
    for name in JOINT_NAMES:
        node_index = len(nodes)
        joint_node_indices.append(node_index)
        anchor = landmarks[name]
        # The flat skeleton stores rest positions in shared mesh coordinates.
        digit_names = next((seq for seq in DIGIT_JOINTS.values() if name in seq), None)
        if name == "wrist":
            direction = landmarks["middle-finger-metacarpal"] - anchor
        elif digit_names:
            i = digit_names.index(name)
            direction = landmarks[digit_names[min(i + 1, len(digit_names) - 1)]] - anchor if i + 1 < len(digit_names) else anchor - landmarks[digit_names[i - 1]]
        else:
            direction = np.array([0, -1, 0], dtype=np.float64)
        q, local_y_world = quaternion_from_hand_basis(direction, dorsal_axis)
        local_dorsal_dots.append(float(np.dot(local_y_world, normalize_rows(np.asarray(dorsal_axis, dtype=np.float64)[None, :])[0])))
        nodes.append({"name": name, "translation": anchor.astype(float).tolist(), "rotation": q.astype(float).tolist()})
        world = quat_matrix(q, anchor)
        bone_frames[name] = {"forward": (-world[:3, 2]).astype(float).tolist(), "dorsal": world[:3, 1].astype(float).tolist(), "hinge": world[:3, 0].astype(float).tolist()}
        joint_transforms.append(np.linalg.inv(world).T.reshape(-1))  # glTF MAT4 column-major
    ibm = np.asarray(joint_transforms, dtype="<f4")
    blob = bytearray()
    views = []
    def put(arr: np.ndarray, target: int | None = 34962) -> int:
        views.append(add_view(blob, arr.tobytes(order="C"), target))
        return len(views) - 1
    bv_pos = put(p)
    bv_norm = put(no)
    views[bv_norm]["byteStride"] = 8
    bv_tan = put(ta)
    bv_uv = put(tc)
    bv_joint = put(jj)
    bv_weight = put(ww)
    bv_index = put(ix, 34963)
    bv_ibm = put(ibm, None)
    accessors = [
        {"bufferView": bv_pos, "componentType": 5126, "count": n_v, "type": "VEC3", "min": p.min(axis=0).tolist(), "max": p.max(axis=0).tolist()},
        {"bufferView": bv_norm, "componentType": 5122, "normalized": True, "count": n_v, "type": "VEC3"},
        {"bufferView": bv_tan, "componentType": 5122, "normalized": True, "count": n_v, "type": "VEC4"},
        {"bufferView": bv_uv, "componentType": 5123, "normalized": True, "count": n_v, "type": "VEC2"},
        {"bufferView": bv_joint, "componentType": 5121, "count": n_v, "type": "VEC4"},
        {"bufferView": bv_weight, "componentType": 5121, "normalized": True, "count": n_v, "type": "VEC4"},
        {"bufferView": bv_index, "componentType": index_component, "count": int(ix.size), "type": "SCALAR", "min": [int(ix.min())], "max": [int(ix.max())]},
        {"bufferView": bv_ibm, "componentType": 5126, "count": 25, "type": "MAT4"},
    ]
    for i, view in enumerate(views):
        views[i] = view
    gltf = {
        "asset": {"version": "2.0", "generator": "PianoMotion Anatomical Improved Hand Builder 1.0"},
        "extensionsUsed": ["KHR_mesh_quantization"],
        "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0,
        "scenes": [{"name": "ImprovedHand", "nodes": [armature_i, 0]}],
        "nodes": nodes,
        "skins": [{"name": "WebXR25JointHand", "inverseBindMatrices": 7, "joints": joint_node_indices}],
        "meshes": [{"name": "AnatomicalImprovedHand", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TANGENT": 2, "TEXCOORD_0": 3, "JOINTS_0": 4, "WEIGHTS_0": 5}, "indices": 6, "material": 0}]}],
        "materials": [{"name": "AnatomicalImprovedSkin", "doubleSided": False, "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 1.0, "metallicRoughnessTexture": {"index": 2}}, "normalTexture": {"index": 1, "scale": 1.0}}],
        "textures": [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1}, {"sampler": 0, "source": 2}],
        "images": [{"uri": texture_uris["baseColor"]}, {"uri": texture_uris["normal"]}, {"uri": image_roughness_uri}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    raw_json = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    raw_json += b" " * ((4 - len(raw_json) % 4) % 4)
    blob += b"\x00" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(raw_json) + 8 + len(blob)
    with path.open("wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(raw_json), b"JSON")); f.write(raw_json)
        f.write(struct.pack("<I4s", len(blob), b"BIN\x00")); f.write(blob)
    return {"path": str(path), "bytes": total, "vertices": int(n_v), "triangles": int(len(faces)), "indexComponentType": index_component,
            "minLocalYDorsalDot": min(local_dorsal_dots), "boneFrames": bone_frames}


def quantize_texture(src_path: Path, out_path: Path, size: int, fmt: str, quality: int = 88, channel: str | None = None) -> None:
    im = Image.open(src_path)
    if channel is not None:
        im = im.getchannel(channel)
    else:
        im = im.convert("RGB")
    if im.size != (size, size):
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    if fmt == "JPEG":
        im.save(out_path, format=fmt, quality=quality, optimize=True, progressive=True, subsampling=0)
    else:
        im.save(out_path, format=fmt, optimize=True)


def quantize_normal_texture(src_path: Path, out_path: Path, size: int, bits: int | None) -> dict:
    """Resize a tangent-space normal map and optionally reduce channel precision.

    The optimized profile retains texel resolution and quantizes all RGB
    channels uniformly. Error is measured as angular difference between
    normalized encoded vectors before and after quantization.
    """
    image = Image.open(src_path).convert("RGB")
    if image.size != (size, size):
        image = image.resize((size, size), Image.Resampling.LANCZOS)
    reference = np.asarray(image, dtype=np.uint8)
    if bits is None or bits >= 8:
        encoded = reference
        used_bits = 8
    else:
        levels = (1 << bits) - 1
        encoded = np.clip(np.rint(np.rint(reference.astype(np.float64) * levels / 255.0) * 255.0 / levels), 0, 255).astype(np.uint8)
        used_bits = bits
    ref_vec = reference.astype(np.float64) / 127.5 - 1.0
    ref_vec /= np.maximum(np.linalg.norm(ref_vec, axis=2, keepdims=True), 1e-12)
    out_vec = encoded.astype(np.float64) / 127.5 - 1.0
    out_vec /= np.maximum(np.linalg.norm(out_vec, axis=2, keepdims=True), 1e-12)
    angle = np.degrees(np.arccos(np.clip(np.sum(ref_vec * out_vec, axis=2), -1.0, 1.0)))
    Image.fromarray(encoded, "RGB").save(out_path, format="PNG", optimize=True)
    return {"bitsPerChannel": used_bits, "width": size, "height": size, "bytes": out_path.stat().st_size,
            "angularErrorDegreesMean": float(angle.mean()), "angularErrorDegreesP95": float(np.percentile(angle, 95)),
            "angularErrorDegreesMax": float(angle.max()), "reference": "same-resolution source normal, resized before quantization"}


def create_textures(source_attrs: dict, gltf: dict, binary: bytes, out_dir: Path, profile: str) -> tuple[dict, dict]:
    texdir = out_dir / "textures"
    texdir.mkdir(parents=True, exist_ok=True)
    source_images = {i.get("name"): i for i in gltf.get("images", [])}
    def extract_image(name: str, filename: str) -> Path:
        image = source_images[name]
        view = gltf["bufferViews"][image["bufferView"]]
        data = binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        path = SCRATCH_DEFAULT / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path
    base = extract_image("base_color", "source-base-color.png")
    normal = extract_image("normal", "source-normal.png")
    mr = extract_image("metallic_roughness", "source-metallic-roughness.png")
    outputs = {
        "high": {"baseColor": "textures/base-color-2048.jpg", "normal": "textures/normal-2048.png", "roughness": "textures/roughness-1024.png"},
        "low": {"baseColor": "textures/base-color-1024.jpg", "normal": "textures/normal-512.png", "roughness": "textures/roughness-512.png"},
    }
    if profile not in ("full", "optimized"):
        raise ValueError(f"Unknown texture profile {profile}")
    optimized = profile == "optimized"
    quantize_texture(base, out_dir / outputs["high"]["baseColor"], 2048, "JPEG", 85 if optimized else 88)
    high_normal = quantize_normal_texture(normal, out_dir / outputs["high"]["normal"], 2048, 6 if optimized else None)
    pack_roughness(mr, out_dir / outputs["high"]["roughness"], 1024, grayscale=optimized)
    quantize_texture(base, out_dir / outputs["low"]["baseColor"], 1024, "JPEG", 85)
    low_normal = quantize_normal_texture(normal, out_dir / outputs["low"]["normal"], 512, 6 if optimized else None)
    pack_roughness(mr, out_dir / outputs["low"]["roughness"], 512, grayscale=optimized)
    stats = {"profile": profile, "baseColorHigh": {"format": "JPEG", "quality": 85 if optimized else 88, "size": [2048, 2048]},
             "baseColorLow": {"format": "JPEG", "quality": 85, "size": [1024, 1024]},
             "normalHigh": high_normal, "normalLow": low_normal,
             "roughnessEncoding": "lossless grayscale PNG; grayscale is replicated by browser image decoding for the green roughness-map channel" if optimized else "lossless RGB glTF metallic-roughness layout with roughness in G"}
    return outputs, stats


def pack_roughness(src_path: Path, out_path: Path, size: int, grayscale: bool = False) -> None:
    """Write glTF metallic-roughness layout: G=roughness, B=metallic=0."""
    source = Image.open(src_path).convert("RGB")
    rough = source.getchannel("G")
    if rough.size != (size, size):
        rough = rough.resize((size, size), Image.Resampling.LANCZOS)
    if grayscale:
        rough.save(out_path, format="PNG", optimize=True)
    else:
        zero = Image.new("L", (size, size), 0)
        Image.merge("RGB", (zero, rough, zero)).save(out_path, format="PNG", optimize=True)


def silhouette_mask(points: np.ndarray, faces: np.ndarray, view_axes: tuple[int, int], bounds: tuple[np.ndarray, np.ndarray], resolution: int = 384) -> np.ndarray:
    """Rasterize projected triangles (not vertex point clouds) into a solid mask."""
    axes = list(view_axes)
    lo, hi = bounds
    spans = np.maximum(hi[axes] - lo[axes], 1e-9)
    scale = (resolution - 2) / float(spans.max())
    center = (hi[axes] + lo[axes]) * .5
    xy = (points[:, axes] - center) * scale + (resolution - 1) * .5
    xy[:, 1] = resolution - 1 - xy[:, 1]
    xy = np.clip(np.rint(xy), 0, resolution - 1).astype(np.int32)
    image = Image.new("1", (resolution, resolution), 0)
    draw = ImageDraw.Draw(image)
    # A simplified 100k-triangle source reference is passed by the caller so
    # this remains a bounded, reproducible raster estimate.
    for tri in np.asarray(faces, dtype=np.int64):
        draw.polygon([tuple(xy[int(i)]) for i in tri], fill=1)
    return np.asarray(image, dtype=bool)


def silhouette_metrics(src_points: np.ndarray, src_faces: np.ndarray, dst_points: np.ndarray, dst_faces: np.ndarray, resolution: int = 384, distance_scale: float = 1.0) -> dict:
    lo = np.minimum(src_points.min(axis=0), dst_points.min(axis=0))
    hi = np.maximum(src_points.max(axis=0), dst_points.max(axis=0))
    reports = {}
    for axis, name in enumerate(("x", "y", "z")):
        axes = tuple(i for i in range(3) if i != axis)
        a = silhouette_mask(src_points, src_faces, axes, (lo, hi), resolution)
        b = silhouette_mask(dst_points, dst_faces, axes, (lo, hi), resolution)
        ea = a & ~binary_erosion(a)
        eb = b & ~binary_erosion(b)
        pa = distance_transform_edt(~ea)[eb]
        pb = distance_transform_edt(~eb)[ea]
        # Input points are in source coordinates. Apply the global similarity
        # scale so the reported distances and pixel size are final rest-frame
        # meters rather than source coordinate units.
        px_scale = float(np.max(hi[list(axes)] - lo[list(axes)]) / (resolution - 2)) * distance_scale
        errs = np.r_[pa, pb] * px_scale
        union = int(np.count_nonzero(a | b))
        iou = float(np.count_nonzero(a & b) / union) if union else 1.0
        reports[f"view_{name}"] = {"resolution": resolution, "pixelScaleMeters": px_scale, "iou": iou, "symmetricMeanMeters": float(errs.mean()) if len(errs) else 0.0, "symmetricP95Meters": float(np.percentile(errs, 95)) if len(errs) else 0.0, "symmetricMaxMeters": float(errs.max()) if len(errs) else 0.0}
    return reports


def validate_glb(path: Path, expected: dict) -> dict:
    gltf, binary = read_glb(path)
    skin = gltf["skins"][0]
    names = [gltf["nodes"][i]["name"] for i in skin["joints"]]
    if names != JOINT_NAMES:
        raise ValueError(f"{path.name}: joint order mismatch")
    prim = gltf["meshes"][0]["primitives"][0]
    pos = accessor(gltf, binary, prim["attributes"]["POSITION"])
    joints = accessor(gltf, binary, prim["attributes"]["JOINTS_0"])
    weights = accessor(gltf, binary, prim["attributes"]["WEIGHTS_0"])
    normals = accessor(gltf, binary, prim["attributes"]["NORMAL"])
    tangents = accessor(gltf, binary, prim["attributes"]["TANGENT"])
    uv = accessor(gltf, binary, prim["attributes"]["TEXCOORD_0"])
    indices = accessor(gltf, binary, prim["indices"]).astype(np.int64)
    if indices.size % 3 or indices.min() < 0 or indices.max() >= len(pos):
        raise ValueError(f"{path.name}: invalid triangle indices")
    if not np.isfinite(pos).all() or not np.isfinite(normals).all() or not np.isfinite(tangents).all() or not np.isfinite(uv).all():
        raise ValueError(f"{path.name}: non-finite vertex attribute")
    weight_acc = gltf["accessors"][prim["attributes"]["WEIGHTS_0"]]
    weight_view = gltf["bufferViews"][weight_acc["bufferView"]]
    weight_offset = weight_view.get("byteOffset", 0) + weight_acc.get("byteOffset", 0)
    raw_weights = np.frombuffer(binary, dtype=np.uint8, count=len(pos) * 4, offset=weight_offset).reshape(-1, 4)
    if not np.all(raw_weights.sum(axis=1) == 255):
        raise ValueError(f"{path.name}: WEIGHTS_0 raw byte sums are not exactly 255")
    sums = weights.sum(axis=1)
    if not np.all(np.abs(sums - 1.0) < 1e-6):
        raise ValueError(f"{path.name}: decoded weights not normalized to 1 within 1e-6")
    if joints.max() >= 25 or joints.min() < 0:
        raise ValueError(f"{path.name}: out-of-range joint index")
    if uv.min() < -1e-5 or uv.max() > 1.00001:
        raise ValueError(f"{path.name}: UV outside normalized range")
    if "KHR_mesh_quantization" not in gltf.get("extensionsRequired", []):
        raise ValueError(f"{path.name}: quantized NORMAL/TANGENT lack required KHR_mesh_quantization")
    nlen = np.linalg.norm(normals, axis=1)
    tlen = np.linalg.norm(tangents[:, :3], axis=1)
    ndott = np.abs(np.sum(normalize_rows(normals) * normalize_rows(tangents[:, :3]), axis=1))
    if nlen.min() < .995 or nlen.max() > 1.005 or tlen.min() < .995 or tlen.max() > 1.005:
        raise ValueError(f"{path.name}: quantized NORMAL/TANGENT lengths out of tolerance")
    if ndott.max() > .015:
        raise ValueError(f"{path.name}: NORMAL and TANGENT are not orthogonal")
    if not np.all(np.isclose(np.abs(tangents[:, 3]), 1.0, atol=1e-6)):
        raise ValueError(f"{path.name}: TANGENT.w must be +1 or -1")
    ibm = accessor(gltf, binary, skin["inverseBindMatrices"]).reshape(25, 4, 4)
    # Rest-pose matrix product must be identity for each joint; the flat nodes
    # store world-space anchors under the identity armature.
    max_bind_error = 0.0
    for node_i, matrix in zip(skin["joints"], ibm):
        n = gltf["nodes"][node_i]
        q = np.asarray(n["rotation"], dtype=np.float64)
        t = np.asarray(n["translation"], dtype=np.float64)
        world = quat_matrix(q, t)
        # Accessor row reshape uses serialized column-major matrices.
        ibm_matrix = matrix.T.astype(np.float64)
        max_bind_error = max(max_bind_error, float(np.abs(world @ ibm_matrix - np.eye(4)).max()))
    if max_bind_error > 1e-5:
        raise ValueError(f"{path.name}: inverse bind matrices fail rest identity ({max_bind_error})")
    faces = indices.reshape(-1, 3)
    loops, boundary_vertices, edge_count = boundary_loops(pos.astype(np.float64), faces)
    return {"vertices": int(len(pos)), "triangles": int(len(faces)), "weightSumMin": float(sums.min()), "weightSumMax": float(sums.max()), "normalLengthMin": float(nlen.min()), "normalLengthMax": float(nlen.max()), "tangentLengthMin": float(tlen.min()), "tangentLengthMax": float(tlen.max()), "maxAbsNormalTangentDot": float(ndott.max()), "uvMin": uv.min(axis=0).astype(float).tolist(), "uvMax": uv.max(axis=0).astype(float).tolist(), "boundaryEdgeCount": int(edge_count), "boundaryLoops": loops, "boundaryVertices": boundary_vertices, "maxBindIdentityError": max_bind_error, "bytes": path.stat().st_size}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE_DEFAULT)
    parser.add_argument("--output", type=Path, default=OUT_DEFAULT)
    parser.add_argument("--evidence", type=Path, default=EVIDENCE_DEFAULT)
    parser.add_argument("--scratch", type=Path, default=SCRATCH_DEFAULT)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--only-lod", type=int, choices=(0, 1, 2), help="build one LOD for early visual review")
    parser.add_argument("--texture-profile", choices=("full", "optimized"), default="optimized",
                        help="optimized (default) retains texture dimensions with 6-bit normals, quality-85 high color, and grayscale roughness; full keeps 8-bit normals and quality-88 high color")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.scratch.mkdir(parents=True, exist_ok=True)
    if not args.source.is_file():
        raise FileNotFoundError(args.source)
    start = time.time()
    targets = [item for item in TARGETS if args.only_lod is None or item[0] == args.only_lod]
    source_hash = hashlib.sha256(args.source.read_bytes()).hexdigest()
    gltf, primitive, binary, raw_attrs, raw_faces, uv_transform = load_source(args.source)
    log(f"source sha256={source_hash} vertices={len(raw_attrs['POSITION'])} triangles={len(raw_faces)} attributes={sorted(raw_attrs)}")
    log(f"source KHR_texture_transform scale={uv_transform['scale']} offset={uv_transform['offset']}")
    clipped_attrs, clipped_faces = clip_mesh_to_wrist(raw_attrs, raw_faces, CUT_Y)
    log(f"clipped y>={CUT_Y}: vertices={len(clipped_attrs['POSITION'])} triangles={len(clipped_faces)}")
    # Confirm source's wrist boundary is a single contour on the negative-Y side.
    wrist_components = cross_section_components(raw_attrs["POSITION"], raw_faces, 1, CUT_Y + 1e-7)
    if len(wrist_components) != 1:
        raise ValueError(f"Expected one forearm contour at the wrist cut, found {len(wrist_components)}")
    wrist = np.asarray([wrist_components[0]["center"][0], CUT_Y, wrist_components[0]["center"][1]])
    if args.inspect_only:
        profiles = {}
        for y in (-.28, .2, .25, .45, .50, .60, .70, .75, .85, .90):
            c = cross_section_components(raw_attrs["POSITION"], raw_faces, 1, y)
            profiles[str(y)] = [{"centerXZ": x["center"].tolist(), "count": x["count"], "boundsXZ": [x["min"].tolist(), x["max"].tolist()]} for x in c]
        (args.scratch / "profiles.json").write_text(json.dumps(profiles, indent=2), encoding="utf-8")
        log("wrote source cross-sections to scratch/improved-assets/profiles.json")
        return 0
    landmark_metrics = {}
    landmarks_source = derive_landmarks(clipped_attrs["POSITION"], clipped_faces, wrist, landmark_metrics)
    ref_path = ROOT / "apps/client/public/models/hands/left.glb"
    ref_gltf, ref_bin = read_glb(ref_path)
    ref_landmarks, _ = get_rest_target(ref_gltf, ref_bin)
    source_mid = landmarks_source["middle-finger-tip"]
    source_pinky = landmarks_source["pinky-finger-metacarpal"]
    source_index = landmarks_source["index-finger-metacarpal"]
    rot = basis_rotation(wrist, source_mid, source_pinky, source_index,
                         ref_landmarks["wrist"], ref_landmarks["middle-finger-tip"],
                         ref_landmarks["pinky-finger-metacarpal"], ref_landmarks["index-finger-metacarpal"])
    source_length = float(np.linalg.norm(source_mid - wrist))
    target_length = float(np.linalg.norm(ref_landmarks["middle-finger-tip"] - ref_landmarks["wrist"]))
    uniform_scale = target_length / source_length
    translate = ref_landmarks["wrist"] - uniform_scale * (rot @ wrist)
    source_pos_all = raw_attrs["POSITION"]
    source_norm_all = raw_attrs["NORMAL"]
    dorsal_mask = ((source_pos_all[:, 1] > .02) & (source_pos_all[:, 1] < .18) &
                   (source_pos_all[:, 2] > .11) & (source_pos_all[:, 0] > -.36) & (source_pos_all[:, 0] < .06))
    if int(dorsal_mask.sum()) < 1000:
        raise ValueError("Could not identify a sufficiently sampled dorsal palm patch")
    source_dorsal = normalize_rows(source_norm_all[dorsal_mask].mean(axis=0)[None, :])[0]
    if source_dorsal[2] < .8:
        raise ValueError(f"Expected source dorsal surface to face local +Z; mean normal={source_dorsal.tolist()}")
    dorsal_rest = normalize_rows((rot @ source_dorsal)[None, :])[0]
    log(f"rest fit scale={uniform_scale:.8f} source wrist-mid={source_length:.6f} source units; target={target_length:.6f}m wrist={wrist.tolist()}")

    # Bake the KHR transform into UVs on the original source vertex stream.
    uv_scale = np.asarray(uv_transform["scale"], dtype=np.float64)
    uv_offset = np.asarray(uv_transform["offset"], dtype=np.float64)
    clipped_attrs["TEXCOORD_0"] = clipped_attrs["TEXCOORD_0"] * uv_scale + uv_offset
    if clipped_attrs["TEXCOORD_0"].min() < -0.002 or clipped_attrs["TEXCOORD_0"].max() > 1.002:
        raise ValueError("Baked KHR_texture_transform UVs exceed expected [0,1] chart bounds")
    source_pos_key = np.rint(clipped_attrs["POSITION"] * 1e7).astype(np.int64)
    source_uv_key = np.rint(clipped_attrs["TEXCOORD_0"] * 1e5).astype(np.int64)
    source_geom_count = len(np.unique(source_pos_key, axis=0))
    source_geom_uv_count = len(np.unique(np.column_stack([source_pos_key, source_uv_key]), axis=0))
    source_uv_seam_dupes = int(source_geom_uv_count - source_geom_count)

    base_pos = clipped_attrs["POSITION"].astype(np.float64)
    geo_pos, geo_faces = weld_geometry(base_pos, clipped_faces)
    log(f"welded simplification input: {len(geo_pos):,} geometric vertices / {len(geo_faces):,} triangles")
    source_loops, _, source_boundary_edges = boundary_loops(geo_pos, geo_faces)
    if len(source_loops) != 1:
        raise ValueError(f"Welded wrist-cut source must have exactly one boundary loop; got {len(source_loops)}")
    for level, target_count in targets:
        log(f"simplifying welded LOD{level} target triangles={target_count} (preserve_border=False)")
        simp_pos, simp_faces, _ = fast_simplification.simplify(
            np.ascontiguousarray(geo_pos.astype(np.float32)), np.ascontiguousarray(geo_faces.astype(np.int32)),
            target_count=target_count, agg=3.0, preserve_border=False, return_collapses=True
        )
        if not 3000 <= len(simp_faces) <= 40000:
            raise ValueError(f"LOD{level} simplifier returned implausible face count {len(simp_faces)}")
        np.savez_compressed(args.scratch / f"simplified-{target_count}.npz", positions=simp_pos, faces=simp_faces)
        loop_data, _, open_edges = boundary_loops(simp_pos, simp_faces)
        if len(loop_data) != 1:
            log(f"LOD{level} simplification yielded {len(loop_data)} boundary loops; retrying with locked border")
            simp_pos, simp_faces, _ = fast_simplification.simplify(
                np.ascontiguousarray(geo_pos.astype(np.float32)), np.ascontiguousarray(geo_faces.astype(np.int32)),
                target_count=target_count, agg=3.0, preserve_border=True, return_collapses=True
            )
        loop_data, _, open_edges = boundary_loops(simp_pos, simp_faces)
        if len(loop_data) != 1:
            raise ValueError(f"LOD{level} must retain one natural wrist boundary loop; found {len(loop_data)}")
        log(f"LOD{level} simplified to {len(simp_pos):,} vertices / {len(simp_faces):,} triangles; wrist boundary vertices={len(loop_data[0])} open edges={open_edges}")
        np.savez_compressed(args.scratch / f"simplified-{target_count}.npz", positions=simp_pos, faces=simp_faces)

    # Keep silhouette raster work bounded while retaining a denser reference
    # than every shipped LOD.
    sil_pos, sil_faces, _ = fast_simplification.simplify(
        np.ascontiguousarray(geo_pos.astype(np.float32)), np.ascontiguousarray(geo_faces.astype(np.int32)),
        target_count=90000, agg=3.0, preserve_border=False, return_collapses=True
    )
    texture_sets, texture_stats = create_textures(raw_attrs, gltf, binary, args.output, args.texture_profile)
    texture_refs = {k: {**v, "flipY": False, "baseColorColorSpace": "srgb", "normalColorSpace": "linear", "roughnessColorSpace": "linear"} for k, v in texture_sets.items()}
    right_gltf, right_bin = read_glb(ROOT / "apps/client/public/models/hands/right.glb")
    right_ref, _ = get_rest_target(right_gltf, right_bin)
    matrix4 = np.vstack([np.column_stack([uniform_scale * rot, translate]), [0, 0, 0, 1]])
    carpal_root_metadata = apply_reference_carpal_roots(
        landmarks_source, ref_landmarks, matrix4, raw_attrs["POSITION"], raw_faces, landmark_metrics
    )
    transformed_landmarks = {name: uniform_scale * (rot @ p) + translate for name, p in landmarks_source.items()}
    right_offset = right_ref["wrist"] - np.array([-transformed_landmarks["wrist"][0], transformed_landmarks["wrist"][1], transformed_landmarks["wrist"][2]])
    manifest = {
        "schemaVersion": 1,
        "modelId": "anatomical-improved",
        "source": {"uri": "hand_standard.glb", "sha256": source_hash, "vertices": int(len(raw_attrs["POSITION"])), "triangles": int(len(raw_faces))},
        "coordinateFrame": {"unit": "meters", "handedness": "right", "boneForwardAxis": "-Z", "normalTextureFlipY": False},
        "jointNames": JOINT_NAMES,
        "textures": texture_refs,
        "hands": {"left": {"lods": []}, "right": {"lods": []}},
        "extras": {
            "sourceToRestMatrix": matrix4.tolist(), "mirrorRightAxis": "X", "rightWristOffset": right_offset.tolist(),
            "boneAxes": {"localX": "hinge", "localY": "dorsal", "localZ": "opposite-forward"},
            "sourceDorsalAxis": source_dorsal.tolist(), "restDorsalAxis": dorsal_rest.tolist(),
            "tangentAttribute": "TANGENT", "tangentW": "preserved on left; negated on mirrored right",
            "textureTransform": {"scale": uv_scale.tolist(), "offset": uv_offset.tolist(), "bakedIntoTexcoord0": True, "vFlipped": False},
            "carpalRootAnchorProfile": {"method": "inverse-reference-left-metacarpal-centers-through-fixed-global-fit",
                                        "meshGeometryUnchangedByAnchorUpdate": True,
                                        "rootsSourceSpace": {name: detail["sourcePosition"] for name, detail in carpal_root_metadata.items()},
                                        "sourceCrossSectionSupport": {name: {"sourceY": detail["sourceSectionY"],
                                                                             "closedLoopCount": detail["closedSectionLoopCount"],
                                                                             "inside": detail["rootInsideSourceSection"],
                                                                             "boundaryDistanceFittedMeters": detail["sectionBoundaryDistanceFittedMeters"]}
                                                                        for name, detail in carpal_root_metadata.items()}},
            "boneFrames": {"left": {}, "right": {}},
            "generation": {"tool": "tools/build_improved_hand_assets.py", "version": "1.0", "simplifier": "fast-simplification 0.2.0",
                       "targets": {str(k): v for k, v in targets}, "weldedPositionSimplification": True,
                       "borderPolicy": "simplify; accept only one natural wrist loop, retry locked border otherwise",
                       "uvRestoration": "source-triangle barycentric interpolation per target corner; split by quantized UV and tangent chart",
                       "weights": "isolated distal component anchors; geodesic soft partition; Gaussian within-chain bone weights; welded graph heat",
                       "carpalRoots": "canonical left CMC/metacarpal positions inverse-mapped into source coordinates after the unchanged global geometry fit; exact source-Y contour containment checked",
                       "weightField": {"sigmaSourceUnits": WEIGHT_SIGMA_SOURCE_UNITS,
                                       "heatSteps": WEIGHT_HEAT_STEPS, "heatAlpha": WEIGHT_HEAT_ALPHA,
                                       "topologyTemperatureSourceUnits": WEIGHT_TOPOLOGY_TEMPERATURE_SOURCE_UNITS},
                       "textureProfile": args.texture_profile}},
    }
    evidence = {"schemaVersion": 1, "modelId": "anatomical-improved", "sourceSha256": source_hash, "checks": {}, "hands": {"left": [], "right": []}}
    evidence["landmarks"] = {name: {"source": landmarks_source[name].astype(float).tolist(), "rest": transformed_landmarks[name].astype(float).tolist(),
                                     "referenceLeft": ref_landmarks[name].astype(float).tolist(), "distanceMeters": float(np.linalg.norm(transformed_landmarks[name] - ref_landmarks[name]))} for name in JOINT_NAMES}
    evidence["landmarkDerivation"] = landmark_metrics
    evidence["scaleFit"] = {"uniformScale": uniform_scale, "sourceWristToMiddleTipSourceUnits": source_length,
                             "targetReferenceWristToMiddleTipMeters": target_length,
                             "fittedWristToMiddleTipMeters": source_length * uniform_scale, "noNonuniformDeformation": True}
    evidence["boneBasis"] = {"localX": "hinge", "localY": "dorsal projected into bone normal plane", "localMinusZ": "forward along next joint",
                              "sourceDorsalNormalMean": source_dorsal.astype(float).tolist(), "sourceDorsalPositiveZDot": float(source_dorsal[2]),
                              "restDorsalAxis": dorsal_rest.astype(float).tolist(), "rightDorsalAxis": [-float(dorsal_rest[0]), float(dorsal_rest[1]), float(dorsal_rest[2])],
                              "minimumLocalYToDorsalDot": {}}
    evidence["wristCut"] = {"sourceY": CUT_Y, "side": "negative-Y forearm; fingers positive-Y", "singleContourComponents": len(wrist_components),
                            "sourceLoopVertices": len(source_loops[0]), "sourceOpenEdges": source_boundary_edges, "sourceLoopCenter": wrist.tolist()}
    evidence["uvRestoration"] = {"sourceGeometricVertices": source_geom_count, "sourceUVSeamDuplicateVertices": source_uv_seam_dupes,
                                 "method": "welded geometry simplification; per-face barycentric source projection; UV chart seed from nearest source face at target face center"}
    evidence["textureEncoding"] = texture_stats
    evidence["silhouetteReference"] = {"proxyTriangles": int(len(sil_faces)), "rasterResolution": 384,
                                        "method": "filled projected triangle masks; symmetric boundary distance transform",
                                        "distanceUnits": "final-rest meters after multiplying source-coordinate pixel scale by global uniform fit"}
    if args.only_lod is None:
        identical = silhouette_metrics(sil_pos, sil_faces, sil_pos, sil_faces, distance_scale=uniform_scale)
        if max(r["symmetricMaxMeters"] for r in identical.values()) > 1e-9:
            raise ValueError("silhouette metric self-check failed for identical meshes")
        damaged = sil_pos.copy()
        moved = (damaged[:, 0] > .0) & (damaged[:, 0] < .15) & (damaged[:, 1] > .68)
        damaged[moved, 0] += .035
        fixture = silhouette_metrics(sil_pos, sil_faces, damaged, sil_faces, distance_scale=uniform_scale)
        if max(r["symmetricP95Meters"] for r in fixture.values()) <= 0:
            raise ValueError("silhouette metric failed moved-finger damage fixture")
        evidence["silhouetteMetricFixtures"] = {"identicalMaxMeters": max(r["symmetricMaxMeters"] for r in identical.values()),
                                                  "movedIndexRegionP95Meters": max(r["symmetricP95Meters"] for r in fixture.values()), "passed": True}

    projection_tree = cKDTree(base_pos)
    for level, target_count in targets:
        saved = np.load(args.scratch / f"simplified-{target_count}.npz")
        simp_pos = saved["positions"].astype(np.float64)
        simp_faces = saved["faces"].astype(np.int64)
        log(f"restoring barycentric attributes for LOD{level}: {len(simp_faces):,} triangles")
        mesh_pos, simp_normal, simp_tangent, simp_uv, simp_faces_out = projected_attributes(
            base_pos, clipped_faces, clipped_attrs, simp_pos, simp_faces, log_fn=log
        )
        wj, ww, weight_metrics = weights_for_vertices(
            mesh_pos, landmarks_source, simp_faces_out,
            sigma_source_units=WEIGHT_SIGMA_SOURCE_UNITS,
            heat_steps=WEIGHT_HEAT_STEPS,
            heat_alpha=WEIGHT_HEAT_ALPHA,
            topology_temperature=WEIGHT_TOPOLOGY_TEMPERATURE_SOURCE_UNITS,
        )
        legacy_j, legacy_w, legacy_metrics = legacy_weights_for_vertices(mesh_pos, landmarks_source)
        weight_metrics["continuousEdgeMetrics"] = edge_weight_metrics(mesh_pos, simp_faces_out, wj, ww, landmarks_source, uniform_scale)
        weight_metrics["legacyThresholdEdgeMetrics"] = edge_weight_metrics(mesh_pos, simp_faces_out, legacy_j, legacy_w, landmarks_source, uniform_scale)
        weight_metrics["legacyThresholdSummary"] = legacy_metrics
        left_pos = uniform_scale * (mesh_pos @ rot.T) + translate
        left_normal = normalize_rows(simp_normal @ rot.T)
        left_tangent = simp_tangent.copy()
        left_tangent[:, :3] = normalize_rows(left_tangent[:, :3] @ rot.T)
        tex = texture_refs["high" if level < 2 else "low"]
        sil = silhouette_metrics(sil_pos, sil_faces, simp_pos, simp_faces, distance_scale=uniform_scale)
        nn = projection_tree.query(simp_pos, k=1)[0]
        for side in ("left", "right"):
            mirrored = side == "right"
            if not mirrored:
                pos_out = left_pos.copy(); normal_out = left_normal.copy(); tangent_out = left_tangent.copy()
                faces_out = simp_faces_out.copy(); lm_out = transformed_landmarks; j_out = wj.copy()
            else:
                pos_out = left_pos.copy(); pos_out[:, 0] *= -1.0; pos_out += right_offset
                normal_out = left_normal.copy(); normal_out[:, 0] *= -1.0
                tangent_out = left_tangent.copy(); tangent_out[:, 0] *= -1.0; tangent_out[:, 3] *= -1.0
                faces_out = simp_faces_out[:, [0, 2, 1]].copy()
                lm_out = {k: np.array([-v[0], v[1], v[2]]) + right_offset for k, v in transformed_landmarks.items()}
                j_out = wj.copy()
                dorsal_right = dorsal_rest.copy(); dorsal_right[0] *= -1.0
                dorsal_right = normalize_rows(dorsal_right[None, :])[0]
            if not mirrored:
                dorsal_side = dorsal_rest
            file_name = f"{side}-lod{level}.glb"
            texture_uris = {"baseColor": tex["baseColor"], "normal": tex["normal"], "roughness": tex["roughness"]}
            packed = pack_glb(args.output / file_name, pos_out, normal_out, tangent_out, simp_uv, j_out, ww, faces_out, lm_out, texture_uris, tex["roughness"], dorsal_side if not mirrored else dorsal_right)
            val = validate_glb(args.output / file_name, packed)
            manifest["extras"]["boneFrames"][side] = packed["boneFrames"]
            evidence["boneBasis"]["minimumLocalYToDorsalDot"][side] = min(evidence["boneBasis"]["minimumLocalYToDorsalDot"].get(side, 1.0), packed["minLocalYDorsalDot"])
            ev = {"level": level, "file": file_name, "bytes": packed["bytes"], "vertices": val["vertices"], "triangles": val["triangles"],
                  "uvSeamSplitVertexCount": int(len(mesh_pos) - len(simp_pos)),
                  "uvMin": val["uvMin"], "uvMax": val["uvMax"], "boundaryEdgeCount": val["boundaryEdgeCount"],
                  "boundaryLoopLengths": [len(x) for x in val["boundaryLoops"]],
                  "projectionDistanceFinalMeters": {"nearestSourceVertexMean": float(nn.mean() * uniform_scale),
                                                     "nearestSourceVertexP95": float(np.percentile(nn, 95) * uniform_scale),
                                                     "nearestSourceVertexMax": float(nn.max() * uniform_scale),
                                                     "sourceCoordinateUnitsScale": uniform_scale},
                  "silhouetteDistance": sil, "weights": weight_metrics, "maxBindIdentityError": val["maxBindIdentityError"],
                  "normalLengthMinMax": [val["normalLengthMin"], val["normalLengthMax"]], "tangentLengthMinMax": [val["tangentLengthMin"], val["tangentLengthMax"]],
                  "maxAbsNormalTangentDot": val["maxAbsNormalTangentDot"], "minLocalYDorsalDot": packed["minLocalYDorsalDot"]}
            evidence["hands"][side].append(ev)
            manifest["hands"][side]["lods"].append({"level": level, "url": file_name, "triangles": val["triangles"], "vertices": val["vertices"],
                "textureSet": "high" if level < 2 else "low", "boundaryVertices": val["boundaryVertices"], "boundaryLoops": val["boundaryLoops"],
                "landmarks": {k: np.asarray(v, dtype=float).tolist() for k, v in lm_out.items()}})
            log(f"{side} LOD{level}: {val['vertices']:,} vertices / {val['triangles']:,} triangles / {packed['bytes']:,} bytes; wrist loops={[len(x) for x in val['boundaryLoops']]}")
    asset_bytes = sum(p.stat().st_size for p in args.output.rglob("*") if p.is_file())
    manifest_path = args.output / "manifest.json"
    if args.only_lod is None:
        if any(len(manifest["hands"][side]["lods"]) != 3 for side in ("left", "right")):
            raise ValueError("full manifest requires all three actual LODs for each hand")
        # Include manifest.json itself in the declared download payload. Iterate
        # to a fixed point in case changing the byte count changes JSON length.
        for _ in range(6):
            manifest["extras"]["assetBytesTotal"] = asset_bytes
            manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            actual_bytes = sum(p.stat().st_size for p in args.output.rglob("*") if p.is_file())
            if actual_bytes == asset_bytes:
                break
            asset_bytes = actual_bytes
        else:
            raise ValueError("manifest asset byte count did not converge")
    else:
        manifest_path = args.scratch / f"draft-lod{args.only_lod}-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    evidence["assetBytesTotal"] = asset_bytes
    evidence["elapsedSeconds"] = time.time() - start
    evidence["checks"] = {
        "sourceHashRecorded": True, "uvTransformBaked": True, "uvsNormalized": True,
        "weightsFiniteNormalizedAndJointBounded": True, "bindMatricesReproduceRest": True,
        "texturesExternalShared": True, "rightMirroringFlipsTangentHandedness": True,
        "totalAssetBytesUnder6MiB": asset_bytes <= 6 * 1024 * 1024 if args.only_lod is None else None,
            "lodTargetsInRange": all(30000 <= x["triangles"] <= 40000 if x["level"] == 0 else 15000 <= x["triangles"] <= 20000 if x["level"] == 1 else 6000 <= x["triangles"] <= 10000 for side in evidence["hands"].values() for x in side),
    }
    evidence["assetPayloadScope"] = "complete-directory-including-manifest" if args.only_lod is None else f"partial-lod-{args.only_lod}-draft-excludes-complete-payload-check"
    manifest_bytes = manifest_path.stat().st_size if args.only_lod is None else 0
    texture_bytes = {set_name: sum((args.output / uri).stat().st_size for uri in descriptors.values())
                     for set_name, descriptors in texture_sets.items()}
    evidence["lazyRequestPayloadBytes"] = {
        str(level): {
            "textureSet": "high" if level < 2 else "low",
            "manifest": manifest_bytes,
            "sharedTextures": texture_bytes["high" if level < 2 else "low"],
            "singleHand": manifest_bytes +
                          (args.output / f"left-lod{level}.glb").stat().st_size +
                          texture_bytes["high" if level < 2 else "low"],
            "bothHands": manifest_bytes +
                         (args.output / f"left-lod{level}.glb").stat().st_size +
                         (args.output / f"right-lod{level}.glb").stat().st_size +
                         texture_bytes["high" if level < 2 else "low"],
        } for level in (0, 1, 2) if args.only_lod is None or level == args.only_lod
    } if args.only_lod is None else {}
    if args.only_lod is None:
        args.evidence.mkdir(parents=True, exist_ok=True)
        (args.evidence / "assets-summary.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        (args.scratch / f"draft-lod{args.only_lod}-evidence.json").write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = [
        "# Anatomical improved hand asset build evidence", "",
        f"Source SHA-256: `{source_hash}`; source mesh: {len(raw_attrs['POSITION']):,} vertices / {len(raw_faces):,} triangles.",
        f"Wrist cut: source Y={CUT_Y} source-coordinate units; the forearm is negative Y, fingers are positive Y. The clipped source has one contour at the cut.",
        f"Uniform scale: {uniform_scale:.8f}; source wrist-to-middle-tip {source_length:.6f} source units; fitted and target reference distance {source_length * uniform_scale:.6f} m. The fit is a single similarity transform, with no nonuniform deformation.",
        f"UV transform baked into TEXCOORD_0: scale `{uv_scale.tolist()}`, offset `{uv_offset.tolist()}`; v is not flipped. Source TANGENT is preserved; the mirrored right hand flips tangent.w and triangle winding.",
        "", "| Hand | LOD | Triangles | Vertices | Bytes | Wrist boundary loops | Nearest source vertex P95 (mm, fitted) | Silhouette symmetric P95 (mm, fitted) |", "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for side, rows in evidence["hands"].items():
        for row in rows:
            p95 = row["projectionDistanceFinalMeters"]["nearestSourceVertexP95"] * 1000.0
            sil95 = max(v["symmetricP95Meters"] for v in row["silhouetteDistance"].values()) * 1000.0
            lines.append(f"| {side} | {row['level']} | {row['triangles']:,} | {row['vertices']:,} | {row['bytes']:,} | {row['boundaryLoopLengths']} | {p95:.3f} | {sil95:.3f} |")
    lines += ["", f"Texture profile: `{args.texture_profile}`; high normal angular error versus its pre-quantization resized pixels: mean `{texture_stats['normalHigh']['angularErrorDegreesMean']:.3f}°`, P95 `{texture_stats['normalHigh']['angularErrorDegreesP95']:.3f}°`, max `{texture_stats['normalHigh']['angularErrorDegreesMax']:.3f}° at {texture_stats['normalHigh']['width']}×{texture_stats['normalHigh']['height']} texels.", "", "Lazy request payload by selected LOD (manifest + shared textures + one or both GLBs):", "", "| LOD | Texture set | Shared textures (B) | One hand total (B) | Both hands total (B) |", "|---:|---|---:|---:|---:|"]
    for level, payload in evidence["lazyRequestPayloadBytes"].items():
        lines.append(f"| {level} | {payload['textureSet']} | {payload['sharedTextures']:,} | {payload['singleHand']:,} | {payload['bothHands']:,} |")
    lines += ["", f"Total output payload (including manifest.json): {asset_bytes:,} bytes ({asset_bytes / 1048576:.2f} MiB). Focused semantic checks: `{json.dumps(evidence['checks'], sort_keys=True)}`.", "", "The unchanged global similarity fit preserves the source mesh geometry and proportions. Wrist, MCP, PIP, DIP, and tip landmarks are estimated from source cross-sections and connected terminal caps; MCP centers for the four fingers are centerline extrapolations into the palm, while PIP/DIP centers use cross-section width minima when stable and a relative-position fallback otherwise. Metacarpal/CMC pivots are reference-root-assisted: canonical left-hand CMC/metacarpal centers are inverse-mapped through the fixed source-to-rest fit, then checked for containment and margin inside exact source-Y contour loops. This is an explicit reference-assisted estimate, not a mesh-derived joint annotation or anatomical ground truth. The original fractional wrist-to-MCP root estimates are recorded alongside the reference-derived positions and source-volume support in the JSON evidence. Reference bone centers also inform wrist placement, orientation, and global scale.", "", "Limits: silhouette distances use filled projected triangles from a simplified 90,000-triangle source proxy and symmetric boundary-distance transforms at 384px; pixel scale is converted to final-rest meters using the global uniform fit. Nearest-source-vertex distances are a dense sampled-surface proximity estimate, not a continuous triangle Hausdorff bound. A reviewer should still inspect a rendered posed hand and animation behavior before accepting the runtime gate.", ""]
    if args.only_lod is None:
        (args.evidence / "assets-summary.md").write_text("\n".join(lines), encoding="utf-8")
    log(f"manifest: {manifest_path}")
    log(f"evidence: {args.evidence / 'assets-summary.md' if args.only_lod is None else args.scratch / f'draft-lod{args.only_lod}-evidence.json'}")
    log(f"total improved folder bytes={asset_bytes} ({asset_bytes / 1048576:.2f} MiB)")
    log(f"build time={time.time() - start:.1f}s")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        log(f"ERROR: {type(exc).__name__}: {exc}")
        raise
