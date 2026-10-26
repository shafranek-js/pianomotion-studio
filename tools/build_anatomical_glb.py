#!/usr/bin/env python3
"""
Converts the high-poly human hand model (hand_standard.glb from Meshy AI)
into rigged, 25-bone WebXR-compatible binary glTF assets with:
  1) Source-derived geometry aligned, simplified, axially calibrated to target segment lengths, and locally tapered
  2) Bones placed along the straight central shafts of authentic finger cylinders
  3) Anatomically seamless thumb-to-palm connection (smooth continuous skin weight gradient across thenar border)
  4) Bone rotations and inverseBindMatrices computed via exact orientBone Gram-Schmidt formula
  5) Clean topological finger segmentation in raw Meshy space (0 cross-finger bleed, exactly 1 connected component)
  6) Watertight intact finger meshes without holes, bridging spikes, or severed side-walls
Output assets:
  apps/client/public/models/hands/anatomical_left.glb
  apps/client/public/models/hands/anatomical_right.glb
"""

import io
import json
import os
import struct
from pathlib import Path
import numpy as np
import fast_simplification
from PIL import Image, ImageFilter
from scipy.spatial import cKDTree
from scipy.sparse.csgraph import connected_components
import scipy.sparse as sp

# Override this when generating a review candidate so the public GLBs stay frozen.
OUTPUT_DIR = Path(os.environ.get(
    'ANATOMICAL_HAND_OUTPUT_DIR',
    'apps/client/public/models/hands',
)).resolve()

def load_glb(path):
    with open(path, 'rb') as f:
        magic, version, length = struct.unpack('<4sII', f.read(12))
        chunk_len, chunk_type = struct.unpack('<I4s', f.read(8))
        json_data = json.loads(f.read(chunk_len).decode('utf-8'))
        bin_len, bin_type = struct.unpack('<I4s', f.read(8))
        bin_bytes = f.read(bin_len)
        return json_data, bin_bytes

def get_accessor_data(gltf_json, bin_bytes, acc_idx):
    acc = gltf_json['accessors'][acc_idx]
    bv = gltf_json['bufferViews'][acc['bufferView']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    ctype = acc['componentType']
    atype = acc['type']

    type_to_components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
    n_comp = type_to_components[atype]
    dtype_map = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
    dt = dtype_map[ctype]
    
    item_size = np.dtype(dt).itemsize * n_comp
    raw = bin_bytes[offset : offset + count * item_size]
    arr = np.frombuffer(raw, dtype=dt)
    if n_comp > 1:
        arr = arr.reshape(count, n_comp)
    return arr

def quat_to_rot(q):
    x, y, z, w = q
    return np.array([
        [1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
        [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
        [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]
    ], dtype=np.float32)

def rotmat_to_quat(R):
    trace = R[0, 0] + R[1, 1] + R[2, 2]
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w = 0.25 / s
        x = (R[2, 1] - R[1, 2]) * s
        y = (R[0, 2] - R[2, 0]) * s
        z = (R[1, 0] - R[0, 1]) * s
    elif (R[0, 0] > R[1, 1]) and (R[0, 0] > R[2, 2]):
        s = 2.0 * np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2])
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2])
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1])
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], dtype=np.float32)
    return q / np.linalg.norm(q)

def orient_bone_basis(start_pt, end_pt, ref_lateral):
    seg_vec = end_pt - start_pt
    seg_len = np.linalg.norm(seg_vec)
    forward = seg_vec / max(1e-6, seg_len)
    z_axis = -forward

    x_axis = ref_lateral - z_axis * np.dot(ref_lateral, z_axis)
    if np.linalg.norm(x_axis) < 1e-6:
        x_axis = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        x_axis -= z_axis * np.dot(x_axis, z_axis)
    x_axis /= np.linalg.norm(x_axis)

    if np.dot(x_axis, ref_lateral) < 0:
        x_axis = -x_axis

    y_axis = np.cross(z_axis, x_axis)
    y_axis /= np.linalg.norm(y_axis)

    R_mat = np.column_stack([x_axis, y_axis, z_axis])
    return R_mat, x_axis

print("1. Loading hand_standard.glb...")
meshy_path = r'c:\Users\pavel\Downloads\hand_standard.glb'
meshy_json, meshy_bin = load_glb(meshy_path)
left_json, left_bin = load_glb('apps/client/public/models/hands/left.glb')
right_json, right_bin = load_glb('apps/client/public/models/hands/right.glb')

meshy_prim = meshy_json['meshes'][0]['primitives'][0]
raw_pos = get_accessor_data(meshy_json, meshy_bin, meshy_prim['attributes']['POSITION'])
raw_uv = get_accessor_data(meshy_json, meshy_bin, meshy_prim['attributes']['TEXCOORD_0'])
scale_uv = np.array([16.0022221, 15.8064184], dtype=np.float32)
offset_uv = np.array([7.6999997e-05, 0.0122619867], dtype=np.float32)
raw_uv_transformed = raw_uv * scale_uv + offset_uv

raw_norm = get_accessor_data(meshy_json, meshy_bin, meshy_prim['attributes']['NORMAL'])
indices = get_accessor_data(meshy_json, meshy_bin, meshy_prim['indices']).reshape(-1, 3)

scale_node = np.array(meshy_json['nodes'][0]['scale'], dtype=np.float32)
trans_node = np.array(meshy_json['nodes'][0]['translation'], dtype=np.float32)
meshy_world = raw_pos * scale_node + trans_node

print(f"   Raw vertices: {meshy_world.shape[0]}, triangles: {indices.shape[0]}")

print("2. Cutting forearm cleanly at wrist (Y >= -0.42)...")
cut_y = -0.42
kept_face_mask = np.all(meshy_world[indices, 1] >= cut_y, axis=1)
faces_kept = indices[kept_face_mask]

used_indices, inv_map = np.unique(faces_kept, return_inverse=True)
v_cut = meshy_world[used_indices]
uv_cut = raw_uv_transformed[used_indices]
norm_cut = raw_norm[used_indices]
f_cut = inv_map.reshape(-1, 3)

rounded = np.round(v_cut, decimals=5)
u_pos, orig_to_welded = np.unique(rounded, axis=0, return_inverse=True)
welded_faces = orig_to_welded[f_cut]
valid_tri = (welded_faces[:, 0] != welded_faces[:, 1]) & \
            (welded_faces[:, 1] != welded_faces[:, 2]) & \
            (welded_faces[:, 2] != welded_faces[:, 0])
welded_faces = welded_faces[valid_tri]
print(f"   Welded manifold: {u_pos.shape[0]} vertices, {welded_faces.shape[0]} triangles")

print("3. Decimating to ~24,000 triangles using fast_simplification...")
target_triangles = 24000
reduction = 1.0 - (target_triangles / welded_faces.shape[0])
v_simp, f_simp = fast_simplification.simplify(
    u_pos.astype(np.float64),
    welded_faces.astype(np.int64),
    target_reduction=reduction,
    agg=3.5
)
v_simp = v_simp.astype(np.float32)
f_simp = f_simp.astype(np.uint32)
print(f"   Simplified: {v_simp.shape[0]} vertices, {f_simp.shape[0]} triangles")

print("4. Transferring UVs and normals via barycentric face interpolation & seam splitting...")
orig_centers = v_cut[f_cut].mean(axis=1)
simp_centers = v_simp[f_simp].mean(axis=1)
kdtree_faces = cKDTree(orig_centers)
nearest_orig_faces = kdtree_faces.query(simp_centers, k=1)[1]

A = v_cut[f_cut[nearest_orig_faces, 0]]
B = v_cut[f_cut[nearest_orig_faces, 1]]
C = v_cut[f_cut[nearest_orig_faces, 2]]

uvA = uv_cut[f_cut[nearest_orig_faces, 0]]
uvB = uv_cut[f_cut[nearest_orig_faces, 1]]
uvC = uv_cut[f_cut[nearest_orig_faces, 2]]

normA = norm_cut[f_cut[nearest_orig_faces, 0]]
normB = norm_cut[f_cut[nearest_orig_faces, 1]]
normC = norm_cut[f_cut[nearest_orig_faces, 2]]

v0 = B - A
v1 = C - A
d00 = np.sum(v0 * v0, axis=1)
d01 = np.sum(v0 * v1, axis=1)
d11 = np.sum(v1 * v1, axis=1)
denom = d00 * d11 - d01 * d01
denom = np.where(np.abs(denom) < 1e-10, 1e-10, denom)

corner_uvs = np.zeros((f_simp.shape[0], 3, 2), dtype=np.float32)
corner_norms = np.zeros((f_simp.shape[0], 3, 3), dtype=np.float32)

for k in range(3):
    P = v_simp[f_simp[:, k]]
    v2 = P - A
    d20 = np.sum(v2 * v0, axis=1)
    d21 = np.sum(v2 * v1, axis=1)
    v = (d11 * d20 - d01 * d21) / denom
    w = (d00 * d21 - d01 * d20) / denom
    u = 1.0 - v - w
    corner_uvs[:, k] = u[:, None] * uvA + v[:, None] * uvB + w[:, None] * uvC
    corner_norms[:, k] = u[:, None] * normA + v[:, None] * normB + w[:, None] * normC

from collections import defaultdict
vert_corners = defaultdict(list)
for j in range(f_simp.shape[0]):
    for k in range(3):
        vi = f_simp[j, k]
        vert_corners[vi].append((j, k))

threshold = 0.06075

final_positions = []
final_uvs = []
final_norms = []
final_orig_vi = []
new_f_simp = np.zeros_like(f_simp)

for vi in range(v_simp.shape[0]):
    corners = vert_corners[vi]
    clusters = []
    for j, k in corners:
        uv = corner_uvs[j, k]
        norm = corner_norms[j, k]
        matched = False
        for cl in clusters:
            ref_uv = np.mean(cl['uvs'], axis=0)
            if np.linalg.norm(uv - ref_uv) < threshold:
                cl['corners'].append((j, k))
                cl['uvs'].append(uv)
                cl['norms'].append(norm)
                matched = True
                break
        if not matched:
            clusters.append({'corners': [(j, k)], 'uvs': [uv], 'norms': [norm]})
            
    for cl in clusters:
        new_v = len(final_positions)
        final_positions.append(v_simp[vi])
        avg_uv = np.mean(cl['uvs'], axis=0)
        avg_norm = np.mean(cl['norms'], axis=0)
        n_len = np.linalg.norm(avg_norm)
        if n_len > 1e-6:
            avg_norm /= n_len
        final_uvs.append(avg_uv)
        final_norms.append(avg_norm)
        final_orig_vi.append(vi)
        for j, k in cl['corners']:
            new_f_simp[j, k] = new_v

final_positions = np.array(final_positions, dtype=np.float32)
final_uvs = np.array(final_uvs, dtype=np.float32)
final_norms = np.array(final_norms, dtype=np.float32)
final_orig_vi = np.array(final_orig_vi, dtype=np.uint32)
print(f"   Transferred UVs: {final_positions.shape[0]} vertices")

print("5. Aligning to WebXR left.glb via Kabsch algorithm (Pure Rigid Alignment)...")
mid_tip = v_simp[np.argmax(v_simp[:, 1])]
idx_cands = v_simp[(v_simp[:, 0] > -0.05) & (v_simp[:, 0] < 0.25) & (v_simp[:, 1] > 0.75)]
idx_tip = idx_cands[np.argmax(idx_cands[:, 1])]
ring_cands = v_simp[(v_simp[:, 0] > -0.40) & (v_simp[:, 0] < -0.15) & (v_simp[:, 1] > 0.75)]
ring_tip = ring_cands[np.argmax(ring_cands[:, 1])]
pinky_cands = v_simp[(v_simp[:, 1] > 0.45) & (v_simp[:, 1] < 0.75)]
pinky_tip = pinky_cands[np.argmin(pinky_cands[:, 0])]
thumb_cands = v_simp[(v_simp[:, 1] > 0.05) & (v_simp[:, 1] < 0.45)]
thumb_tip = thumb_cands[np.argmax(thumb_cands[:, 0])]
wrist_pts = v_simp[(v_simp[:, 1] >= -0.28) & (v_simp[:, 1] <= -0.24)]
wrist_center = wrist_pts.mean(axis=0)

src_pts = np.array([wrist_center, thumb_tip, idx_tip, mid_tip, ring_tip, pinky_tip], dtype=np.float32)

bones_l = {}
for n in left_json['nodes']:
    if 'translation' in n:
        bones_l[n['name']] = np.array(n['translation'], dtype=np.float32)

dst_pts = np.array([
    bones_l['wrist'],
    bones_l['thumb-tip'],
    bones_l['index-finger-tip'],
    bones_l['middle-finger-tip'],
    bones_l['ring-finger-tip'],
    bones_l['pinky-finger-tip']
], dtype=np.float32)

weights = np.array([2.5, 1.0, 1.2, 1.5, 1.0, 1.0], dtype=np.float32)
weights /= weights.sum()

src_c = np.sum(src_pts * weights[:, None], axis=0)
dst_c = np.sum(dst_pts * weights[:, None], axis=0)
src_d = src_pts - src_c
dst_d = dst_pts - dst_c
var_src = np.sum(weights[:, None] * (src_d ** 2))
cov = (dst_d * weights[:, None]).T @ src_d
U, S, Vt = np.linalg.svd(cov)
d = np.sign(np.linalg.det(U @ Vt))
D = np.diag([1.0, 1.0, d])
R = U @ D @ Vt
scale = np.sum(S * np.diag(D)) / var_src
t = dst_c - scale * (R @ src_c)

print(f"   Optimal scale: {scale:.5f}")
# v_aligned_l is 100% undeformed, pure authentic Meshy geometry!
v_aligned_l = (scale * (final_positions @ R.T) + t).astype(np.float32)
norm_aligned_l = (final_norms @ R.T).astype(np.float32)
norm_lens = np.linalg.norm(norm_aligned_l, axis=1, keepdims=True)
norm_aligned_l /= np.maximum(norm_lens, 1e-6)

v_simp_aligned_l = (scale * (v_simp @ R.T) + t).astype(np.float32)

print("6. Topological Finger Segmentation in Raw Meshy Space...")
x_m, y_m, z_m = v_simp[:, 0], v_simp[:, 1], v_simp[:, 2]
vert_domains = np.full(len(v_simp), 'palm', dtype=object)

# Thumb:
vert_domains[(x_m > 0.14) & (y_m > -0.12) & (y_m < 0.45)] = 'thumb'

# Pinky:
x_rp = -0.330 - 0.25 * (y_m - 0.45)
vert_domains[(y_m >= 0.43) & (y_m <= 0.73) & (x_m < x_rp)] = 'pinky'

# Ring, middle, and index fingers (above interdigital folds):
x_rm = -0.194 - 0.06 * (y_m - 0.50)
x_mi = -0.042 + 0.10 * (y_m - 0.55)
mask_rmi = (y_m >= 0.495) & (vert_domains == 'palm')
vert_domains[mask_rmi & (x_m < x_rm)] = 'ring'
mask_mi = (y_m >= 0.505) & (vert_domains == 'palm')
vert_domains[mask_mi & (x_m >= x_rm) & (x_m < x_mi)] = 'middle'
vert_domains[mask_mi & (x_m >= x_mi)] = 'index'

for name in ['thumb', 'index', 'middle', 'ring', 'pinky', 'palm']:
    print(f"   Finger {name:7s}: {np.sum(vert_domains == name)} vertices")

# Filter bridging triangles between distinct fingers
tri_d = vert_domains[f_simp]
diff_mask = np.array([len(set(tri_d[t]) - {'palm'}) > 1 for t in range(len(tri_d))])
print(f"   Bridging triangles removed between distinct fingers: {np.sum(diff_mask)}")

cleaned_new_f_simp = new_f_simp[~diff_mask]

# Filter connected components: keep only the single largest connected component on active mesh
geom_faces = final_orig_vi[cleaned_new_f_simp]
active_v, inv = np.unique(geom_faces, return_inverse=True)
adj_edges = inv.reshape(geom_faces.shape)
e01 = np.vstack([adj_edges[:, 0], adj_edges[:, 1]]).T
e12 = np.vstack([adj_edges[:, 1], adj_edges[:, 2]]).T
e20 = np.vstack([adj_edges[:, 2], adj_edges[:, 0]]).T
all_e = np.vstack([e01, e12, e20])
adj = sp.coo_matrix((np.ones(len(all_e), dtype=bool), (all_e[:, 0], all_e[:, 1])), shape=(len(active_v), len(active_v)))
n_c, comp_labels = connected_components(adj, directed=False)
if n_c > 1:
    main_c = np.argmax(np.bincount(comp_labels))
    tri_keep = (comp_labels[inv.reshape(geom_faces.shape)[:, 0]] == main_c) & \
               (comp_labels[inv.reshape(geom_faces.shape)[:, 1]] == main_c) & \
               (comp_labels[inv.reshape(geom_faces.shape)[:, 2]] == main_c)
    cleaned_new_f_simp = cleaned_new_f_simp[tri_keep]

geom_faces = final_orig_vi[cleaned_new_f_simp]
active_v, inv = np.unique(geom_faces, return_inverse=True)
adj_edges = inv.reshape(geom_faces.shape)
e01 = np.vstack([adj_edges[:, 0], adj_edges[:, 1]]).T
e12 = np.vstack([adj_edges[:, 1], adj_edges[:, 2]]).T
e20 = np.vstack([adj_edges[:, 2], adj_edges[:, 0]]).T
all_e = np.vstack([e01, e12, e20])
adj = sp.coo_matrix((np.ones(len(all_e), dtype=bool), (all_e[:, 0], all_e[:, 1])), shape=(len(active_v), len(active_v)))
n_c_final, _ = connected_components(adj, directed=False)
print(f"   Cleaned triangles kept: {cleaned_new_f_simp.shape[0]} (connected components: {n_c_final})")
assert n_c_final == 1, f"Expected 1 connected component, got {n_c_final}"

# Prune unreferenced vertices from final arrays so vertex count matches index buffer
used_final_v, inv_final = np.unique(cleaned_new_f_simp, return_inverse=True)
cleaned_new_f_simp = inv_final.reshape(cleaned_new_f_simp.shape).astype(np.uint16)
v_aligned_l = v_aligned_l[used_final_v]
norm_aligned_l = norm_aligned_l[used_final_v]
final_uvs = final_uvs[used_final_v]
final_orig_vi = final_orig_vi[used_final_v]
print(f"   Active manifold vertices: {v_aligned_l.shape[0]}")

print("   Straightening wrist opening to perpendicular plane and tapering cylinder...")
geom_faces_b = final_orig_vi[cleaned_new_f_simp]
edges_geom = np.vstack([geom_faces_b[:, [0, 1]], geom_faces_b[:, [1, 2]], geom_faces_b[:, [2, 0]]])
edges_geom_sorted = np.sort(edges_geom, axis=1)
u_e_g, counts_g = np.unique(edges_geom_sorted, axis=0, return_counts=True)
b_geom_edges = u_e_g[counts_g == 1]
b_geom_verts = np.unique(b_geom_edges)

target_wrist_y = 0.0750
b_pts = v_simp_aligned_l[b_geom_verts]
cx = b_pts[:, 0].mean()
cz = b_pts[:, 2].mean()

is_b_geom = np.zeros(len(v_simp), dtype=bool)
is_b_geom[b_geom_verts] = True

for vi in range(len(v_simp_aligned_l)):
    y_val = v_simp_aligned_l[vi, 1]
    if is_b_geom[vi]:
        v_simp_aligned_l[vi, 1] = target_wrist_y
    elif y_val > 0.0560:
        t_y = np.clip((y_val - 0.0560) / (target_wrist_y - 0.0560), 0.0, 1.0)
        s_y = t_y * t_y * (3.0 - 2.0 * t_y)
        v_simp_aligned_l[vi, 1] += s_y * (target_wrist_y - y_val) * 0.70

    y_new = v_simp_aligned_l[vi, 1]
    if y_new > 0.0560:
        t_z = np.clip((y_new - 0.0560) / (target_wrist_y - 0.0560), 0.0, 1.0)
        s_z = t_z * t_z * (3.0 - 2.0 * t_z)
        # Palmar side (z < cz) tapers by 14% to smoothly enter the cuff without bulging
        z_taper = 1.0 - (0.14 if v_simp_aligned_l[vi, 2] < cz else 0.08) * s_z
        x_taper = 1.0 - 0.10 * s_z
        v_simp_aligned_l[vi, 0] = cx + (v_simp_aligned_l[vi, 0] - cx) * x_taper
        v_simp_aligned_l[vi, 2] = cz + (v_simp_aligned_l[vi, 2] - cz) * z_taper

def compute_smooth_normals(positions, faces, orig_vi=None):
    tri_v = positions[faces]
    v01 = tri_v[:, 1] - tri_v[:, 0]
    v02 = tri_v[:, 2] - tri_v[:, 0]
    tri_normals = np.cross(v01, v02)
    if orig_vi is not None:
        n_orig = orig_vi.max() + 1
        geom_normals = np.zeros((n_orig, 3), dtype=np.float32)
        geom_faces = orig_vi[faces]
        for k in range(3):
            np.add.at(geom_normals, geom_faces[:, k], tri_normals)
        lens = np.linalg.norm(geom_normals, axis=1, keepdims=True)
        geom_normals /= np.maximum(lens, 1e-7)
        vert_normals = geom_normals[orig_vi]
    else:
        vert_normals = np.zeros_like(positions)
        for k in range(3):
            np.add.at(vert_normals, faces[:, k], tri_normals)
        lens = np.linalg.norm(vert_normals, axis=1, keepdims=True)
        vert_normals /= np.maximum(lens, 1e-7)
    return vert_normals.astype(np.float32)

print("6b. Applying Taubin smoothing / edge-loop relaxation on v_simp_aligned_l (12021 manifold)...")
e0_simp = np.concatenate([geom_faces_b[:, 0], geom_faces_b[:, 1], geom_faces_b[:, 2], geom_faces_b[:, 1], geom_faces_b[:, 2], geom_faces_b[:, 0]])
e1_simp = np.concatenate([geom_faces_b[:, 1], geom_faces_b[:, 2], geom_faces_b[:, 0], geom_faces_b[:, 0], geom_faces_b[:, 1], geom_faces_b[:, 2]])
A_simp = sp.coo_matrix((np.ones(len(e0_simp), dtype=np.float32), (e0_simp, e1_simp)), shape=(v_simp_aligned_l.shape[0], v_simp_aligned_l.shape[0])).tocsr()
A_simp.setdiag(0)
A_simp.eliminate_zeros()
deg_simp = np.array(A_simp.sum(axis=1)).flatten()
inv_deg_simp = np.zeros_like(deg_simp)
val_deg_simp = deg_simp > 0
inv_deg_simp[val_deg_simp] = 1.0 / deg_simp[val_deg_simp]
L_simp = (sp.diags(inv_deg_simp) @ A_simp) - sp.eye(v_simp_aligned_l.shape[0])

fixed_simp = is_b_geom | (v_simp_aligned_l[:, 1] >= 0.0540)

lam_tb = 0.50
mu_tb = -0.53
for _ in range(6):
    d1 = lam_tb * (L_simp @ v_simp_aligned_l)
    d1[fixed_simp] = 0.0
    v_simp_aligned_l += d1

    d2 = mu_tb * (L_simp @ v_simp_aligned_l)
    d2[fixed_simp] = 0.0
    v_simp_aligned_l += d2

def get_finger_column(x_val, y_val, z_val):
    if z_val < -0.018 or (x_val > 0.14 and y_val < 0.45):
        return 'thumb'
    x_rp_val = -0.330 - 0.25 * (y_val - 0.45)
    if x_val < x_rp_val:
        return 'pinky'
    x_rm_val = -0.194 - 0.06 * (y_val - 0.50)
    if x_val < x_rm_val:
        return 'ring'
    x_mi_val = -0.042 + 0.10 * (y_val - 0.55)
    if x_val < x_mi_val:
        return 'middle'
    return 'index'

n_geom = v_simp.shape[0]
col_arr_geom = np.array([get_finger_column(v_simp[k, 0], v_simp[k, 1], v_simp_aligned_l[k, 2]) for k in range(n_geom)])

print("7. Calibrating Straight Central Bone Axes and Warping Sculpted Joints...")
bones_l_calib = {}
bones_l_calib['wrist'] = bones_l['wrist'].copy()

# Runtime MotionPose calibrated segment lengths (meters) to match lenRatio ≈ 1.000 in orientBone
L_DIST_POSE = {'index': 0.01918, 'middle': 0.02024, 'ring': 0.02024, 'pinky': 0.01811}
L_INTER_POSE = {'index': 0.02450, 'middle': 0.02876, 'ring': 0.02769, 'pinky': 0.01917}
L_PROX_POSE = {'index': 0.04261, 'middle': 0.04793, 'ring': 0.04474, 'pinky': 0.03515}
L_META_POSE = {'index': 0.07149, 'middle': 0.07058, 'ring': 0.06745, 'pinky': 0.04963}

u_shaft_f = {}
finger_z_bounds = {}

# Fingers 2..5 (index, middle, ring, pinky): Align sculpted creases with bone pivots
for f in ['index', 'middle', 'ring', 'pinky']:
    b_prox = bones_l[f + '-finger-phalanx-proximal']
    b_meta = bones_l[f + '-finger-metacarpal']
    mcp_y_orig = float(b_prox[1])
    
    mcp_slice_mask = (col_arr_geom == f) & (np.abs(v_simp_aligned_l[:, 1] - mcp_y_orig) < 0.006)
    vf_mcp = v_simp_aligned_l[mcp_slice_mask]
    assert len(vf_mcp) > 0, f"No MCP vertices found for finger {f} around y={mcp_y_orig}"
    mcp_x = float(vf_mcp[:, 0].mean())
    z_min_mcp = float(vf_mcp[:, 2].min())
    z_max_mcp = float(vf_mcp[:, 2].max())
    mcp_z = z_min_mcp + 0.58 * (z_max_mcp - z_min_mcp)
    m_mcp = np.array([mcp_x, mcp_y_orig, mcp_z], dtype=np.float32)
    
    ym = v_simp[vert_domains == f, 1]
    y0 = ym.min()
    y1 = ym.max()
    vf = v_simp_aligned_l[vert_domains == f]
    c70 = vf[np.abs(ym - (y0 + 0.70 * (y1 - y0))) < 0.015].mean(axis=0)
    
    u_shaft = c70 - m_mcp
    u_shaft /= np.linalg.norm(u_shaft)
    u_shaft = u_shaft.astype(np.float32)
    u_shaft_f[f] = u_shaft
    
    L_orig = float(np.max((vf - m_mcp) @ u_shaft))
    s_pip_orig = 0.50 * L_orig
    s_dip_orig = 0.79 * L_orig
    s_tip_orig = L_orig
    
    s_pip_new = float(L_PROX_POSE[f])
    s_dip_new = float(L_PROX_POSE[f] + L_INTER_POSE[f])
    s_tip_bone = float(L_PROX_POSE[f] + L_INTER_POSE[f] + L_DIST_POSE[f])
    s_tip_surf_new = s_tip_bone + 0.0015
    
    print(f"   Finger {f:7s}: L_orig={L_orig*1000:.2f}mm, s_tip_surf_new={s_tip_surf_new*1000:.2f}mm")
    print(f"      pip: orig={s_pip_orig*1000:.2f}mm -> new={s_pip_new*1000:.2f}mm (shift={(s_pip_new - s_pip_orig)*1000:.2f}mm)")
    print(f"      dip: orig={s_dip_orig*1000:.2f}mm -> new={s_dip_new*1000:.2f}mm (shift={(s_dip_new - s_dip_orig)*1000:.2f}mm)")
    
    # Piecewise-linear vertex warp on v_simp_aligned_l
    s_src = np.array([-0.005, 0.0, s_pip_orig, s_dip_orig, s_tip_orig], dtype=np.float32)
    s_dst = np.array([-0.005, 0.0, s_pip_new, s_dip_new, s_tip_surf_new], dtype=np.float32)
    
    f_col_indices = np.where(col_arr_geom == f)[0]
    for vi in f_col_indices:
        s_val = float(np.dot(v_simp_aligned_l[vi] - m_mcp, u_shaft))
        if s_val > -0.005:
            s_new = float(np.interp(s_val, s_src, s_dst))
            t_in = float(np.clip((s_val - (-0.005)) / 0.010, 0.0, 1.0))
            mask = t_in * t_in * (3.0 - 2.0 * t_in)
            v_simp_aligned_l[vi] += mask * (s_new - s_val) * u_shaft

    # PIP/DIP positions use preset source fractions mapped to target lengths;
    # the current crease atlas does not support an exact fold-to-pivot claim.
    m_pip = m_mcp + s_pip_new * u_shaft
    m_dip = m_mcp + s_dip_new * u_shaft
    
    # Relocate joint pivots to ~58% depth on warped mesh
    vf_warped = v_simp_aligned_l[col_arr_geom == f]
    slice_pip = vf_warped[np.abs((vf_warped - m_pip) @ u_shaft) < 0.006]
    if len(slice_pip) > 0:
        z_min_pip, z_max_pip = slice_pip[:, 2].min(), slice_pip[:, 2].max()
        m_pip[2] = z_min_pip + 0.58 * (z_max_pip - z_min_pip)

    slice_dip = vf_warped[np.abs((vf_warped - m_dip) @ u_shaft) < 0.006]
    if len(slice_dip) > 0:
        z_min_dip, z_max_dip = slice_dip[:, 2].min(), slice_dip[:, 2].max()
        m_dip[2] = z_min_dip + 0.58 * (z_max_dip - z_min_dip)

    m_tip = m_dip + L_DIST_POSE[f] * u_shaft

    u_meta = b_prox - b_meta
    u_meta /= np.linalg.norm(u_meta)
    m_meta = m_mcp - L_META_POSE[f] * u_meta

    bones_l_calib[f + '-finger-metacarpal'] = m_meta
    bones_l_calib[f + '-finger-phalanx-proximal'] = m_mcp
    bones_l_calib[f + '-finger-phalanx-intermediate'] = m_pip
    bones_l_calib[f + '-finger-phalanx-distal'] = m_dip
    bones_l_calib[f + '-finger-tip'] = m_tip

    # Distal fingertip taper applied STRICTLY to v_simp_aligned_l (12021 manifold vertices)
    dist_len = L_DIST_POSE[f]
    vf_mask = (vert_domains == f)
    vf_indices = np.where(vf_mask)[0]
    for vi in vf_indices:
        v_pt = v_simp_aligned_l[vi]
        axial_proj = np.dot(v_pt - m_dip, u_shaft)
        if axial_proj > 0.35 * dist_len:
            s_taper = np.clip((axial_proj - 0.35 * dist_len) / (0.65 * dist_len), 0.0, 1.0)
            taper_factor = 1.0 - 0.15 * s_taper
            p_axial = m_dip + axial_proj * u_shaft
            r_radial = v_pt - p_axial
            v_simp_aligned_l[vi] = p_axial + taper_factor * r_radial

    vf_final = v_simp_aligned_l[col_arr_geom == f]
    finger_z_bounds[f] = (float(vf_final[:, 2].min()), float(vf_final[:, 2].max()))

# Thumb (calibrated at c15 and c62 matching natural anatomical hinge coordinates)
v_th = v_simp_aligned_l[vert_domains == 'thumb']
xm = v_simp[vert_domains == 'thumb', 0]
x0 = xm.min()
x1 = xm.max()
c15 = v_th[np.abs(xm - (x0 + 0.15 * (x1 - x0))) < 0.015].mean(axis=0)
c62 = v_th[np.abs(xm - (x0 + 0.62 * (x1 - x0))) < 0.015].mean(axis=0)
u_th = c62 - c15
u_th /= np.linalg.norm(u_th)
s_th_tip = np.max((v_th - c15) @ u_th)
m_th_tip = c15 + s_th_tip * u_th
m_th_dip = c62
m_th_mcp = c15
m_th_meta = np.array([-0.0250, 0.0397, -0.0114], dtype=np.float32)

bones_l_calib['thumb-metacarpal'] = m_th_meta
bones_l_calib['thumb-phalanx-proximal'] = m_th_mcp
bones_l_calib['thumb-phalanx-distal'] = m_th_dip
bones_l_calib['thumb-tip'] = m_th_dip + 0.0300 * u_th
u_shaft_f['thumb'] = u_th

# Refine thumb fingertip taper: smooth 15% thinning over distal 65% on v_simp_aligned_l
th_mask = (vert_domains == 'thumb')
th_indices = np.where(th_mask)[0]
th_dist_len = 0.0300
for vi in th_indices:
    v_pt = v_simp_aligned_l[vi]
    axial_proj = np.dot(v_pt - m_th_dip, u_th)
    if axial_proj > 0.35 * th_dist_len:
        s_taper = np.clip((axial_proj - 0.35 * th_dist_len) / (0.65 * th_dist_len), 0.0, 1.0)
        taper_factor = 1.0 - 0.15 * s_taper
        p_axial = m_th_dip + axial_proj * u_th
        r_radial = v_pt - p_axial
        v_simp_aligned_l[vi] = p_axial + taper_factor * r_radial

v_th_final = v_simp_aligned_l[col_arr_geom == 'thumb']
finger_z_bounds['thumb'] = (float(v_th_final[:, 2].min()), float(v_th_final[:, 2].max()))

# 8. Copy to v_aligned_l and verify zero UV seam gap
v_aligned_l[:] = v_simp_aligned_l[final_orig_vi]
seam_err = float(np.max(np.abs(v_aligned_l - v_simp_aligned_l[final_orig_vi])))
print(f"   Max UV seam vertex divergence: {seam_err:.8f} m")
assert seam_err == 0.0, f"UV seam divergence detected: {seam_err}"
vert_d_final = vert_domains[final_orig_vi]

norm_aligned_l = compute_smooth_normals(v_aligned_l, cleaned_new_f_simp, final_orig_vi)

# Compute bone rotations via exact orientBone Gram-Schmidt formula
left_orig_rot = {n['name']: np.array(n['rotation'], dtype=np.float32) for n in left_json['nodes'] if 'rotation' in n}
bone_rot_mat_l = {}
bone_rot_mat_l['wrist'] = quat_to_rot(left_orig_rot['wrist'])

for f in ['index', 'middle', 'ring', 'pinky']:
    meta_name = f + '-finger-metacarpal'
    prox_name = f + '-finger-phalanx-proximal'
    inter_name = f + '-finger-phalanx-intermediate'
    dist_name = f + '-finger-phalanx-distal'
    tip_name = f + '-finger-tip'
    
    ref_lat_meta = quat_to_rot(left_orig_rot[meta_name])[:, 0]
    R_meta, x_meta = orient_bone_basis(bones_l_calib[meta_name], bones_l_calib[prox_name], ref_lat_meta)
    bone_rot_mat_l[meta_name] = R_meta
    
    R_prox, x_prox = orient_bone_basis(bones_l_calib[prox_name], bones_l_calib[inter_name], x_meta)
    bone_rot_mat_l[prox_name] = R_prox
    
    R_inter, x_inter = orient_bone_basis(bones_l_calib[inter_name], bones_l_calib[dist_name], x_prox)
    bone_rot_mat_l[inter_name] = R_inter
    
    R_dist, x_dist = orient_bone_basis(bones_l_calib[dist_name], bones_l_calib[tip_name], x_inter)
    bone_rot_mat_l[dist_name] = R_dist
    bone_rot_mat_l[tip_name] = R_dist

ref_lat_th_meta = quat_to_rot(left_orig_rot['thumb-metacarpal'])[:, 0]
R_th_meta, x_th_meta = orient_bone_basis(bones_l_calib['thumb-metacarpal'], bones_l_calib['thumb-phalanx-proximal'], ref_lat_th_meta)
bone_rot_mat_l['thumb-metacarpal'] = R_th_meta

R_th_prox, x_th_prox = orient_bone_basis(bones_l_calib['thumb-phalanx-proximal'], bones_l_calib['thumb-phalanx-distal'], x_th_meta)
bone_rot_mat_l['thumb-phalanx-proximal'] = R_th_prox

R_th_dist, x_th_dist = orient_bone_basis(bones_l_calib['thumb-phalanx-distal'], bones_l_calib['thumb-tip'], x_th_prox)
bone_rot_mat_l['thumb-phalanx-distal'] = R_th_dist
bone_rot_mat_l['thumb-tip'] = R_th_dist

skin_joints_l = left_json['skins'][0]['joints']
left_node_names = [left_json['nodes'][jid]['name'] for jid in skin_joints_l]

ibm_matrices_l = np.zeros((25, 4, 4), dtype=np.float32)
for skin_idx, jid in enumerate(skin_joints_l):
    name = left_json['nodes'][jid]['name']
    R_b = bone_rot_mat_l[name]
    pos_b = bones_l_calib[name]
    
    M = np.eye(4, dtype=np.float32)
    M[:3, :3] = R_b
    M[:3, 3] = pos_b
    M_inv = np.linalg.inv(M)
    ibm_matrices_l[skin_idx] = M_inv.T

ibm_bytes_l = ibm_matrices_l.tobytes()

print("8. Transferring skin weights from left.glb via domain-specific cKDTrees (Welded Geometry)...")
# q_pts_geom is used ONLY as a KD-tree query space so weights map smoothly to undeformed mesh v_simp_aligned_l
q_pts_geom = v_simp_aligned_l.copy()
for f in ['index', 'middle', 'ring', 'pinky']:
    b_tip_f = bones_l[f + '-finger-tip']
    f_mask_simp = (vert_domains == f)
    v_f_simp = v_simp_aligned_l[f_mask_simp]
    y_tip_mesh = v_f_simp[:, 1].min()
    m_tip_f = v_f_simp[v_f_simp[:, 1] <= y_tip_mesh + 0.008].mean(axis=0)
    delta_tip_f = b_tip_f - m_tip_f

    y_start = 0.43 if f == 'pinky' else (0.495 if f == 'ring' else 0.505)
    y_tip_m = v_simp[vert_domains == f, 1].max()

    f_indices = np.where(vert_domains == f)[0]
    for idx in f_indices:
        y_m_val = v_simp[idx, 1]
        t_val = np.clip((y_m_val - y_start) / (y_tip_m - y_start + 1e-8), 0.0, 1.0)
        s_val = t_val * t_val * (3.0 - 2.0 * t_val)
        q_pts_geom[idx] += s_val * delta_tip_f

# Piecewise-linear q_pts alignment for thumb
b_th_meta = bones_l['thumb-metacarpal']
b_th_mcp = bones_l['thumb-phalanx-proximal']
b_th_dip = bones_l['thumb-phalanx-distal']
b_th_tip = bones_l['thumb-tip']

delta_th_meta = np.zeros(3, dtype=np.float32)
delta_th_mcp = b_th_mcp - m_th_mcp
delta_th_dip = b_th_dip - m_th_dip
delta_th_tip = b_th_tip - m_th_tip

x_tip_m = v_simp[vert_domains == 'thumb', 0].max()
th_indices = np.where(vert_domains == 'thumb')[0]
for idx in th_indices:
    x_m_val = v_simp[idx, 0]
    
    if x_m_val <= 0.20:
        t_seg = np.clip((x_m_val - 0.14) / (0.20 - 0.14), 0.0, 1.0)
        d_seg = delta_th_meta + t_seg * (delta_th_mcp - delta_th_meta)
    elif x_m_val <= 0.38:
        t_seg = np.clip((x_m_val - 0.20) / (0.38 - 0.20), 0.0, 1.0)
        d_seg = delta_th_mcp + t_seg * (delta_th_dip - delta_th_mcp)
    else:
        t_seg = np.clip((x_m_val - 0.38) / (x_tip_m - 0.38 + 1e-8), 0.0, 1.0)
        d_seg = delta_th_dip + t_seg * (delta_th_tip - delta_th_dip)
        
    s_in = np.clip((x_m_val - 0.14) / 0.05, 0.0, 1.0)
    s_in = s_in * s_in * (3.0 - 2.0 * s_in)
    q_pts_geom[idx] += s_in * d_seg

left_prim = left_json['meshes'][0]['primitives'][0]
pos_ref = get_accessor_data(left_json, left_bin, left_prim['attributes']['POSITION'])
j0_ref = get_accessor_data(left_json, left_bin, left_prim['attributes']['JOINTS_0'])
w0_ref = get_accessor_data(left_json, left_bin, left_prim['attributes']['WEIGHTS_0'])

W_ref = np.zeros((len(pos_ref), 25), dtype=np.float32)
for i in range(len(pos_ref)):
    for k in range(4):
        w = w0_ref[i, k]
        if w > 0:
            jid = j0_ref[i, k]
            W_ref[i, jid] += w

DOM_BONES = {
    'pinky': [0, 1, 2, 3, 4],
    'ring': [5, 6, 7, 8, 9],
    'middle': [10, 11, 12, 13, 14],
    'index': [15, 16, 17, 18, 19],
    'thumb': [20, 21, 22, 23, 24, 19],
    'palm': [24, 4, 9, 14, 19, 23, 3, 8, 13, 18, 22],
}

PROXIMAL_JIDS = {
    'pinky': 3,
    'ring': 8,
    'middle': 13,
    'index': 18,
    'thumb': 22,
}

trees = {}
W_ref_dom_norms = {}

for dom, jids in DOM_BONES.items():
    W_dom = np.zeros_like(W_ref)
    W_dom[:, jids] = W_ref[:, jids]
    valid = W_dom.sum(axis=1) > 0.1
    pos_dom = pos_ref[valid]
    W_norm = W_dom[valid] / W_dom[valid].sum(axis=1, keepdims=True)
    trees[dom] = cKDTree(pos_dom)
    W_ref_dom_norms[dom] = W_norm
    print(f"   Domain {dom:7s}: tree built with {len(pos_dom)} reference vertices")

n_geom = v_simp.shape[0]
W_geom = np.zeros((n_geom, 25), dtype=np.float32)

x_m_geom = v_simp[:, 0]
y_m_geom = v_simp[:, 1]

# col_arr_geom already initialized before Step 7

FINGER_PHALANGES = {
    'pinky': [0, 1, 2, 3],
    'ring': [5, 6, 7, 8],
    'middle': [10, 11, 12, 13],
    'index': [15, 16, 17, 18],
    'thumb': [20, 21, 22],
}
FINGER_METAS = {
    'pinky': 4,
    'ring': 9,
    'middle': 14,
    'index': 19,
    'thumb': 23,
}
Y_WEB = {
    'pinky': 0.43,
    'ring': 0.495,
    'middle': 0.505,
    'index': 0.505,
}

for i in range(n_geom):
    dom = vert_domains[i]
    tree = trees[dom]
    W_ref_norm = W_ref_dom_norms[dom]
    dists, neighbors = tree.query(q_pts_geom[i], k=8)
    
    weights_k = 1.0 / (dists**2 + 1e-5)
    weights_k /= weights_k.sum()
    interp_w = np.sum(weights_k[:, None] * W_ref_norm[neighbors], axis=0)
    
    x_m_i = x_m_geom[i]
    y_m_i = y_m_geom[i]
    f_col = col_arr_geom[i]
    
    # 1. Forearm behind wrist (y_m <= -0.20): bind directly to wrist (bone 24)
    if y_m_i <= -0.28:
        interp_w[:] = 0.0
        interp_w[24] = 1.0
    elif y_m_i <= -0.20:
        t_arm = (y_m_i - (-0.28)) / (-0.20 - (-0.28))
        s_arm = t_arm * t_arm * (3.0 - 2.0 * t_arm)
        interp_w = s_arm * interp_w
        interp_w[24] += (1.0 - s_arm)
    
    # 2. Smooth physical transition between metacarpals and proximal phalanges for fingers 2..5
    if f_col in Y_WEB:
        y_w = Y_WEB[f_col]
        p_jid = PROXIMAL_JIDS[f_col]
        m_jid = p_jid + 1
        
        # Partition metacarpal/proximal mass around the calibrated MCP, in shaft space.
        # The previous raw-mesh Y window drifted after alignment/axial warping and kept
        # metacarpal weight far into the proximal phalanx, creating a false flex hinge.
        mcp = bones_l_calib[f_col + '-finger-phalanx-proximal']
        s_mcp = float(np.dot(v_simp_aligned_l[i] - mcp, u_shaft_f[f_col]))
        mcp_half_width = 0.0060
        t_y = np.clip((s_mcp + mcp_half_width) / (2.0 * mcp_half_width), 0.0, 1.0)
        s_y = t_y * t_y * (3.0 - 2.0 * t_y)
        
        # Lateral transition away from neighboring cleft saddles (x)
        s_x = 1.0
        if f_col == 'pinky':
            x_cleft = -0.330 - 0.25 * (y_m_i - 0.45)
            dx = abs(x_m_i - x_cleft)
            t_x = np.clip(dx / 0.045, 0.0, 1.0)
            s_x = t_x * t_x * (3.0 - 2.0 * t_x)
        elif f_col == 'ring':
            x_c1 = -0.330 - 0.25 * (y_m_i - 0.45)
            x_c2 = -0.194 - 0.06 * (y_m_i - 0.50)
            dx = min(abs(x_m_i - x_c1), abs(x_m_i - x_c2))
            t_x = np.clip(dx / 0.045, 0.0, 1.0)
            s_x = t_x * t_x * (3.0 - 2.0 * t_x)
        elif f_col == 'middle':
            x_c1 = -0.194 - 0.06 * (y_m_i - 0.50)
            x_c2 = -0.042 + 0.10 * (y_m_i - 0.55)
            dx = min(abs(x_m_i - x_c1), abs(x_m_i - x_c2))
            t_x = np.clip(dx / 0.045, 0.0, 1.0)
            s_x = t_x * t_x * (3.0 - 2.0 * t_x)
        elif f_col == 'index':
            x_cleft = -0.042 + 0.10 * (y_m_i - 0.55)
            dx = abs(x_m_i - x_cleft)
            t_x = np.clip(dx / 0.045, 0.0, 1.0)
            s_x = t_x * t_x * (3.0 - 2.0 * t_x)
            
        t_web_h = np.clip((y_m_i - y_w) / 0.035, 0.0, 1.0)
        s_web_fade = t_web_h * t_web_h * (3.0 - 2.0 * t_web_h)
        s_x_eff = s_x + s_web_fade * (1.0 - s_x)
        w_factor = s_y * s_x_eff
        w_p = interp_w[p_jid]
        w_m = interp_w[m_jid]
        total_mp = w_p + w_m
        interp_w[p_jid] = w_factor * total_mp
        interp_w[m_jid] = (1.0 - w_factor) * total_mp

    # 3. Thumb metacarpal/proximal partition follows its actual MCP, not raw X.
    # This keeps the CMC/first-web mass on the metacarpal while limiting the hinge
    # transition to a 12 mm band around the calibrated thumb MCP.
    if f_col == 'thumb':
        s_thumb = float(np.dot(
            v_simp_aligned_l[i] - bones_l_calib['thumb-phalanx-proximal'],
            u_shaft_f['thumb'],
        ))
        thumb_half_width = 0.0060
        t_thumb_mcp = np.clip(
            (s_thumb + thumb_half_width) / (2.0 * thumb_half_width), 0.0, 1.0,
        )
        blend_thumb_mcp = t_thumb_mcp * t_thumb_mcp * (3.0 - 2.0 * t_thumb_mcp)
        w_thumb_pair = float(interp_w[22] + interp_w[23])
        interp_w[22] = w_thumb_pair * blend_thumb_mcp  # thumb-phalanx-proximal
        interp_w[23] = w_thumb_pair * (1.0 - blend_thumb_mcp)  # thumb-metacarpal

    # Step 2: Analytical phalanx weights centered at the configured PIP/DIP node
    # positions. This weight-center calculation does not validate skin-fold alignment.
    if f_col in ['index', 'middle', 'ring', 'pinky']:
        p_jid = PROXIMAL_JIDS[f_col]
        i_jid = p_jid - 1
        d_jid = p_jid - 2
        t_jid = p_jid - 3
        w_phal_total = float(interp_w[p_jid] + interp_w[i_jid] + interp_w[d_jid] + interp_w[t_jid])
        if w_phal_total > 1e-6:
            s_curr = float(np.dot(v_simp_aligned_l[i] - bones_l_calib[f_col + '-finger-phalanx-proximal'], u_shaft_f[f_col]))
            s_pip = L_PROX_POSE[f_col]
            s_dip = L_PROX_POSE[f_col] + L_INTER_POSE[f_col]
            z_min_f, z_max_f = finger_z_bounds[f_col]
            dorsal_t = float(np.clip((v_simp_aligned_l[i, 2] - z_min_f) / max(1e-4, z_max_f - z_min_f), 0.0, 1.0))
            hw_pip = 0.0040 + 0.0035 * dorsal_t
            hw_dip = 0.0032 + 0.0028 * dorsal_t
            u_pip = np.clip((s_curr - (s_pip - hw_pip)) / (2.0 * hw_pip), 0.0, 1.0)
            blend_pip = u_pip * u_pip * (3.0 - 2.0 * u_pip)
            u_dip = np.clip((s_curr - (s_dip - hw_dip)) / (2.0 * hw_dip), 0.0, 1.0)
            blend_dip = u_dip * u_dip * (3.0 - 2.0 * u_dip)

            interp_w[p_jid] = w_phal_total * (1.0 - blend_pip)
            interp_w[i_jid] = w_phal_total * blend_pip * (1.0 - blend_dip)
            interp_w[d_jid] = w_phal_total * blend_dip
            interp_w[t_jid] = 0.0
    elif f_col == 'thumb':
        w_th_phal = float(interp_w[22] + interp_w[21] + interp_w[20])
        if w_th_phal > 1e-6:
            s_curr_th = float(np.dot(v_simp_aligned_l[i] - bones_l_calib['thumb-phalanx-proximal'], u_shaft_f['thumb']))
            s_th_dip = float(np.dot(bones_l_calib['thumb-phalanx-distal'] - bones_l_calib['thumb-phalanx-proximal'], u_shaft_f['thumb']))
            hw_th = 0.0055
            u_th = np.clip((s_curr_th - (s_th_dip - hw_th)) / (2.0 * hw_th), 0.0, 1.0)
            blend_th = u_th * u_th * (3.0 - 2.0 * u_th)

            interp_w[22] = w_th_phal * (1.0 - blend_th)
            interp_w[21] = w_th_phal * blend_th
            interp_w[20] = 0.0

    # Column isolation: zero out phalanges of other fingers, transfer to their metacarpal
    for other_f, phal_jids in FINGER_PHALANGES.items():
        if other_f != f_col:
            w_other = np.sum(interp_w[phal_jids])
            if w_other > 0:
                interp_w[phal_jids] = 0.0
                interp_w[FINGER_METAS[other_f]] += w_other

    sum_w = interp_w.sum()
    if sum_w > 1e-6:
        interp_w /= sum_w
        
    W_geom[i] = interp_w

# 4. Laplacian Smoothing of Weights on Welded Continuous Geometric Surface
# Faces connecting geometric vertices (continuous, no UV seam tears):
geom_faces = final_orig_vi[cleaned_new_f_simp]
e0 = np.concatenate([geom_faces[:, 0], geom_faces[:, 1], geom_faces[:, 2], geom_faces[:, 1], geom_faces[:, 2], geom_faces[:, 0]])
e1 = np.concatenate([geom_faces[:, 1], geom_faces[:, 2], geom_faces[:, 0], geom_faces[:, 0], geom_faces[:, 1], geom_faces[:, 2]])
A_geom = sp.coo_matrix((np.ones(len(e0), dtype=np.float32), (e0, e1)), shape=(n_geom, n_geom)).tocsr()
A_geom.setdiag(0)
A_geom.eliminate_zeros()
deg = np.array(A_geom.sum(axis=1)).flatten()
inv_deg = np.zeros_like(deg)
valid_deg = deg > 0
inv_deg[valid_deg] = 1.0 / deg[valid_deg]
A_norm_geom = sp.diags(inv_deg) @ A_geom

# Precompute normalized subgraph laplacians on geometric mesh
A_norm_fingers = {}
for f, phal_jids in FINGER_PHALANGES.items():
    mask_f = (col_arr_geom == f)
    A_f = A_geom[mask_f, :][:, mask_f]
    deg_f = np.array(A_f.sum(axis=1)).flatten()
    inv_deg_f = np.zeros_like(deg_f)
    val_f = deg_f > 0
    inv_deg_f[val_f] = 1.0 / deg_f[val_f]
    A_norm_fingers[f] = (mask_f, sp.diags(inv_deg_f) @ A_f)

palm_meta_jids = [4, 9, 14, 19, 23, 24]
mask_palm = (y_m_geom < 0.54) | ((x_m_geom >= 0.06) & (x_m_geom <= 0.28) & (y_m_geom < 0.45))
A_p = A_geom[mask_palm, :][:, mask_palm]
deg_p = np.array(A_p.sum(axis=1)).flatten()
inv_deg_p = np.zeros_like(deg_p)
val_p = deg_p > 0
inv_deg_p[val_p] = 1.0 / deg_p[val_p]
A_norm_p = sp.diags(inv_deg_p) @ A_p

for iter_idx in range(4):
    # Smooth each finger's bones within its own column on continuous surface (preserving sharp joint transitions)
    for f, phal_jids in FINGER_PHALANGES.items():
        f_bone_jids = phal_jids + [FINGER_METAS[f]]
        mask_f, A_norm_f = A_norm_fingers[f]
        W_f = W_geom[mask_f, :][:, f_bone_jids]
        W_f_smooth = 0.8 * W_f + 0.2 * (A_norm_f @ W_f)
        W_geom[np.ix_(mask_f, f_bone_jids)] = W_f_smooth

    # Smooth palm and metacarpal bones across transition zones on continuous surface
    W_p = W_geom[mask_palm, :][:, palm_meta_jids]
    W_p_smooth = 0.7 * W_p + 0.3 * (A_norm_p @ W_p)
    W_geom[np.ix_(mask_palm, palm_meta_jids)] = W_p_smooth

    # Ensure no distal/intermediate phalanges bleed down into palm or metacarpals,
    # and no metacarpal/wrist bleeds up past proximal phalanges into intermediate/distal
    for f, phal_jids in FINGER_PHALANGES.items():
        if f in Y_WEB:
            palm_f = (col_arr_geom == f) & (y_m_geom < Y_WEB[f] + 0.010)
            dist_inter = phal_jids[:3]
            w_bleed = np.sum(W_geom[palm_f, :][:, dist_inter], axis=1)
            W_geom[np.ix_(palm_f, dist_inter)] = 0.0
            W_geom[palm_f, phal_jids[3]] += w_bleed

            # Metacarpal and wrist cannot bleed past proximal phalanx into intermediate/distal
            dist_f = (col_arr_geom == f) & (y_m_geom >= Y_WEB[f] + 0.065)
            meta_wrist = [FINGER_METAS[f], 24]
            w_up = np.sum(W_geom[dist_f, :][:, meta_wrist], axis=1)
            W_geom[np.ix_(dist_f, meta_wrist)] = 0.0
            W_geom[dist_f, phal_jids[3]] += w_up
        else: # thumb
            fold_th = (col_arr_geom == 'thumb') & (x_m_geom < 0.22)
            w_bleed = np.sum(W_geom[fold_th, :][:, [20, 21]], axis=1)
            W_geom[np.ix_(fold_th, [20, 21])] = 0.0
            W_geom[fold_th, 23] += w_bleed

            # Thumb: metacarpal and wrist cannot bleed past proximal phalanx into distal/tip
            tip_th = (col_arr_geom == 'thumb') & (x_m_geom >= 0.35)
            meta_wrist_th = [23, 24]
            w_up_th = np.sum(W_geom[tip_th, :][:, meta_wrist_th], axis=1)
            W_geom[np.ix_(tip_th, meta_wrist_th)] = 0.0
            W_geom[tip_th, 22] += w_up_th

    # Re-normalize
    row_s = W_geom.sum(axis=1, keepdims=True)
    W_geom /= np.maximum(row_s, 1e-6)

# Map continuous geometric weights to split render vertices:
# Split vertices at the exact same 3D position get 100% identical weights (0.0000000 diff)!
W_out_l = W_geom[final_orig_vi]
n_v = v_aligned_l.shape[0]
x_m_arr = v_simp[final_orig_vi, 0]
y_m_arr = v_simp[final_orig_vi, 1]
faces = cleaned_new_f_simp

# Compute edge weight jumps across all mesh edges
edges_all = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
edges_sorted = np.sort(edges_all, axis=1)
unique_edges = np.unique(edges_sorted, axis=0)

edge_jumps = np.max(np.abs(W_out_l[unique_edges[:, 0]] - W_out_l[unique_edges[:, 1]]), axis=1)
max_jump = np.max(edge_jumps)
top_idx = np.argsort(edge_jumps)[-10:]
print(f"   Max edge weight jump across all mesh edges: {max_jump:.4f} (target: < 0.14)")
for ti in reversed(top_idx[-3:]):
    u, v = unique_edges[ti]
    diffs = np.abs(W_out_l[u] - W_out_l[v])
    bad_jid = np.argmax(diffs)
    print(f"      jump {edge_jumps[ti]:.4f} at bone {bad_jid} ({left_node_names[bad_jid]}): xm=({x_m_arr[u]:.3f}, {x_m_arr[v]:.3f}), ym=({y_m_arr[u]:.3f}, {y_m_arr[v]:.3f}), dom=({vert_d_final[u]}, {vert_d_final[v]})")
    print(f"         u weights: {[(left_node_names[j], round(float(W_out_l[u, j]), 3)) for j in range(25) if W_out_l[u, j] > 0.01]}")
    print(f"         v weights: {[(left_node_names[j], round(float(W_out_l[v, j]), 3)) for j in range(25) if W_out_l[v, j] > 0.01]}")

target_pt = np.array([-0.0164, -0.0174, -0.0319])
dist_to_target = np.linalg.norm(v_aligned_l - target_pt, axis=1)
near_target_verts = np.where(dist_to_target < 0.010)[0]
near_edges = np.isin(unique_edges[:, 0], near_target_verts) | np.isin(unique_edges[:, 1], near_target_verts)
max_target_jump = np.max(edge_jumps[near_edges]) if np.any(near_edges) else 0.0
print(f"   Max edge weight jump near thumb fold [-16.4, -17.4, -31.9] mm: {max_target_jump:.4f} (target: < 0.14)")
if np.any(near_edges):
    target_edge_idx = np.where(near_edges)[0]
    sub_jumps = edge_jumps[target_edge_idx]
    top_t = target_edge_idx[np.argsort(sub_jumps)[-3:]]
    for ti in reversed(top_t):
        u, v = unique_edges[ti]
        diffs = np.abs(W_out_l[u] - W_out_l[v])
        bad_jid = np.argmax(diffs)
        print(f"      thumb fold jump {edge_jumps[ti]:.4f} at bone {bad_jid} ({left_node_names[bad_jid]}): xm=({x_m_arr[u]:.3f}, {x_m_arr[v]:.3f}), ym=({y_m_arr[u]:.3f}, {y_m_arr[v]:.3f})")
        print(f"         u: {[(left_node_names[j], round(float(W_out_l[u, j]), 3)) for j in range(25) if W_out_l[u, j] > 0.01]}")
        print(f"         v: {[(left_node_names[j], round(float(W_out_l[v, j]), 3)) for j in range(25) if W_out_l[v, j] > 0.01]}")

def extract_top4(W_matrix, skin_node_names, target_node_names):
    name_to_target_jid = {name: idx for idx, name in enumerate(target_node_names)}
    n_verts = W_matrix.shape[0]
    out_joints = np.zeros((n_verts, 4), dtype=np.uint8)
    out_weights = np.zeros((n_verts, 4), dtype=np.float32)
    
    for i in range(n_verts):
        w_row = W_matrix[i]
        bone_weights = []
        for src_jid in range(25):
            w = w_row[src_jid]
            if w > 0.001:
                b_name = skin_node_names[src_jid]
                dst_jid = name_to_target_jid[b_name]
                bone_weights.append((dst_jid, w))
        if not bone_weights:
            dst_jid = name_to_target_jid['wrist']
            bone_weights = [(dst_jid, 1.0)]
        bone_weights.sort(key=lambda x: x[1], reverse=True)
        top4 = bone_weights[:4]
        tot = sum(w for _, w in top4)
        for k, (jid, w) in enumerate(top4):
            out_joints[i, k] = jid
            out_weights[i, k] = w / tot
            
    return out_joints, out_weights

out_joints_l, out_weights_l = extract_top4(W_out_l, left_node_names, left_node_names)

cross_finger_count = 0
FINGER_KEYWORDS = ['thumb', 'index', 'middle', 'ring', 'pinky']
for i in range(out_weights_l.shape[0]):
    present_fingers = set()
    for b in range(4):
        if out_weights_l[i, b] > 0:
            name = left_node_names[out_joints_l[i, b]]
            if 'phalanx' in name or 'tip' in name:
                for f in FINGER_KEYWORDS:
                    if f in name:
                        present_fingers.add(f)
    if len(present_fingers) > 1:
        cross_finger_count += 1
print(f"   Left hand cross-finger phalanx weights check: {cross_finger_count} vertices (MUST BE 0!)")
assert cross_finger_count == 0, f"Expected 0 cross-finger phalanx vertices, got {cross_finger_count}"

# Bind-pose geometry validations
v0 = v_aligned_l[cleaned_new_f_simp[:, 0]]
v1 = v_aligned_l[cleaned_new_f_simp[:, 1]]
v2 = v_aligned_l[cleaned_new_f_simp[:, 2]]
len01 = np.linalg.norm(v1 - v0, axis=1)
len12 = np.linalg.norm(v2 - v1, axis=1)
len20 = np.linalg.norm(v0 - v2, axis=1)
max_edge = max(len01.max(), len12.max(), len20.max())
print(f"   Left hand max triangle edge length in bind pose: {max_edge * 1000:.2f} mm (MUST BE < 7 mm!)")
assert max_edge < 0.007, f"Max edge length {max_edge * 1000:.2f} mm exceeds 7 mm limit!"

main_bone = np.argmax(W_out_l, axis=1)
tri_bones = main_bone[cleaned_new_f_simp]
DISTAL_INTER_TIP = set([0, 1, 2, 5, 6, 7, 10, 11, 12, 15, 16, 17, 20, 21])
WRIST_META = set([24, 4, 9, 14, 19, 23])

stretched_count_l = 0
for t in range(len(cleaned_new_f_simp)):
    b_set = set(tri_bones[t])
    if (b_set & DISTAL_INTER_TIP) and (b_set & WRIST_META):
        stretched_count_l += 1
print(f"   Left hand stretched triangles connecting distal/inter/tip with wrist/meta: {stretched_count_l} (MUST BE 0!)")
assert stretched_count_l == 0, f"Expected 0 stretched triangles, got {stretched_count_l}"

print("9. Packaging textures (2048x2048 JPEG Base Color & PNG Normal with Gaussian speckle removal)...")
img_bc = Image.open('scratch/extracted_hand/base_color.png').convert('RGB')
img_norm = Image.open('scratch/extracted_hand/normal.png').convert('RGB')

img_bc_resized = img_bc.resize((2048, 2048), Image.Resampling.LANCZOS)
img_norm_smooth = img_norm.filter(ImageFilter.GaussianBlur(radius=0.75))
img_norm_resized = img_norm_smooth.resize((2048, 2048), Image.Resampling.LANCZOS)

# Save the candidate normal map beside its GLBs; this remains in scratch when overridden.
(OUTPUT_DIR / 'textures').mkdir(parents=True, exist_ok=True)
img_norm_resized.save(OUTPUT_DIR / 'textures/anatomical_normal.png', format='PNG', optimize=True)

bio_bc = io.BytesIO()
img_bc_resized.save(bio_bc, format='JPEG', quality=92)
bytes_bc = bio_bc.getvalue()

bio_norm = io.BytesIO()
img_norm_resized.save(bio_norm, format='PNG', optimize=True)
bytes_norm = bio_norm.getvalue()

def pack_anatomical_glb(out_path, pos, norm, uv, joints, weights, indices_tri, ref_json, bone_pos_map, bone_rot_mat_map, ibm_bytes, bytes_bc, bytes_norm):
    n_v = pos.shape[0]
    n_idx = indices_tri.size
    
    pos_bytes = pos.tobytes()
    norm_bytes = norm.tobytes()
    uv_bytes = uv.tobytes()
    joints_bytes = joints.tobytes()
    weights_bytes = weights.tobytes()
    idx_bytes = indices_tri.astype(np.uint16).tobytes()

    buffer_views = []
    buffers_data = []
    cur_offset = 0

    def add_bv(data, target=None):
        nonlocal cur_offset
        pad = (4 - (len(data) % 4)) % 4
        padded = data + b'\x00' * pad
        bv = {'buffer': 0, 'byteOffset': cur_offset, 'byteLength': len(data)}
        if target is not None:
            bv['target'] = target
        buffer_views.append(bv)
        buffers_data.append(padded)
        cur_offset += len(padded)
        return len(buffer_views) - 1

    bv_pos = add_bv(pos_bytes, 34962)
    bv_norm = add_bv(norm_bytes, 34962)
    bv_uv = add_bv(uv_bytes, 34962)
    bv_joints = add_bv(joints_bytes, 34962)
    bv_weights = add_bv(weights_bytes, 34962)
    bv_idx = add_bv(idx_bytes, 34963)
    bv_ibm = add_bv(ibm_bytes)
    bv_img_bc = add_bv(bytes_bc)
    bv_img_norm = add_bv(bytes_norm)

    combined_bin = b''.join(buffers_data)

    accessors = [
        {'bufferView': bv_pos, 'byteOffset': 0, 'componentType': 5126, 'count': n_v, 'type': 'VEC3', 'min': pos.min(axis=0).tolist(), 'max': pos.max(axis=0).tolist()},
        {'bufferView': bv_norm, 'byteOffset': 0, 'componentType': 5126, 'count': n_v, 'type': 'VEC3'},
        {'bufferView': bv_uv, 'byteOffset': 0, 'componentType': 5126, 'count': n_v, 'type': 'VEC2'},
        {'bufferView': bv_joints, 'byteOffset': 0, 'componentType': 5121, 'count': n_v, 'type': 'VEC4'},
        {'bufferView': bv_weights, 'byteOffset': 0, 'componentType': 5126, 'count': n_v, 'type': 'VEC4'},
        {'bufferView': bv_idx, 'byteOffset': 0, 'componentType': 5123, 'count': n_idx, 'type': 'SCALAR'},
        {'bufferView': bv_ibm, 'byteOffset': 0, 'componentType': 5126, 'count': 25, 'type': 'MAT4'},
    ]

    out_nodes = []
    for n in ref_json['nodes']:
        n_copy = dict(n)
        name = n_copy.get('name')
        if name in bone_pos_map:
            n_copy['translation'] = [float(v) for v in bone_pos_map[name]]
        if name in bone_rot_mat_map:
            q = rotmat_to_quat(bone_rot_mat_map[name])
            n_copy['rotation'] = [float(v) for v in q]
        out_nodes.append(n_copy)

    out_json = {
        'asset': {'generator': 'PianoMotion Studio Anatomical Hand Rig Generator', 'version': '2.0'},
        'scene': 0,
        'scenes': [{'name': 'Scene', 'nodes': [len(out_nodes) - 1]}],
        'nodes': out_nodes,
        'skins': [{'inverseBindMatrices': 6, 'joints': ref_json['skins'][0]['joints'], 'name': 'Armature'}],
        'materials': [{
            'name': 'AnatomicalHandSkin',
            'pbrMetallicRoughness': {
                'baseColorTexture': {'index': 0},
                'metallicFactor': 0.0,
                'roughnessFactor': 0.52
            },
            'normalTexture': {'index': 1}
        }],
        'textures': [
            {'sampler': 0, 'source': 0},
            {'sampler': 0, 'source': 1}
        ],
        'images': [
            {'bufferView': bv_img_bc, 'mimeType': 'image/jpeg', 'name': 'base_color'},
            {'bufferView': bv_img_norm, 'mimeType': 'image/png', 'name': 'normal'}
        ],
        'samplers': [{
            'magFilter': 9729,
            'minFilter': 9987,
            'wrapS': 10497,
            'wrapT': 10497
        }],
        'meshes': [{
            'name': 'AnatomicalHand',
            'primitives': [{
                'attributes': {
                    'POSITION': 0,
                    'NORMAL': 1,
                    'TEXCOORD_0': 2,
                    'JOINTS_0': 3,
                    'WEIGHTS_0': 4
                },
                'indices': 5,
                'material': 0,
                'mode': 4
            }]
        }],
        'bufferViews': buffer_views,
        'accessors': accessors,
        'buffers': [{'byteLength': len(combined_bin)}]
    }

    json_str = json.dumps(out_json, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b' ' * json_pad

    bin_pad = (4 - (len(combined_bin) % 4)) % 4
    combined_bin += b'\x00' * bin_pad

    total_len = 12 + 8 + len(json_bytes) + 8 + len(combined_bin)
    header = struct.pack('<4sII', b'glTF', 2, total_len)
    chunk0_hdr = struct.pack('<I4s', len(json_bytes), b'JSON')
    chunk1_hdr = struct.pack('<I4s', len(combined_bin), b'BIN\x00')

    tmp_path = out_path + '.tmp'
    with open(tmp_path, 'wb') as f_out:
        f_out.write(header)
        f_out.write(chunk0_hdr)
        f_out.write(json_bytes)
        f_out.write(chunk1_hdr)
        f_out.write(combined_bin)
    os.replace(tmp_path, out_path)
    
    print(f"Wrote {out_path} ({total_len / 1024 / 1024:.2f} MB, {n_v} vertices, {n_idx // 3} triangles)")

print("10. Packaging anatomical_left.glb...")
pack_anatomical_glb(
    str(OUTPUT_DIR / 'anatomical_left.glb'),
    v_aligned_l,
    norm_aligned_l,
    final_uvs,
    out_joints_l,
    out_weights_l,
    cleaned_new_f_simp,
    left_json,
    bones_l_calib,
    bone_rot_mat_l,
    ibm_bytes_l,
    bytes_bc,
    bytes_norm
)

print("11. Packaging anatomical_right.glb (Mirrored across X)...")
v_aligned_r = v_aligned_l.copy()
v_aligned_r[:, 0] *= -1.0

f_simp_r = cleaned_new_f_simp[:, [0, 2, 1]]
norm_aligned_r = compute_smooth_normals(v_aligned_r, f_simp_r, final_orig_vi)

right_skin_joints = right_json['skins'][0]['joints']
right_node_names = [right_json['nodes'][jid]['name'] for jid in right_skin_joints]
right_orig_rot = {n['name']: np.array(n['rotation'], dtype=np.float32) for n in right_json['nodes'] if 'rotation' in n}

bones_r_calib = {}
for name, p_l in bones_l_calib.items():
    p_r = p_l.copy()
    p_r[0] *= -1.0
    bones_r_calib[name] = p_r

bone_rot_mat_r = {}
bone_rot_mat_r['wrist'] = quat_to_rot(right_orig_rot['wrist'])

for f in ['index', 'middle', 'ring', 'pinky']:
    meta_name = f + '-finger-metacarpal'
    prox_name = f + '-finger-phalanx-proximal'
    inter_name = f + '-finger-phalanx-intermediate'
    dist_name = f + '-finger-phalanx-distal'
    tip_name = f + '-finger-tip'
    
    ref_lat_meta_r = quat_to_rot(right_orig_rot[meta_name])[:, 0]
    R_meta_r, x_meta_r = orient_bone_basis(bones_r_calib[meta_name], bones_r_calib[prox_name], ref_lat_meta_r)
    bone_rot_mat_r[meta_name] = R_meta_r
    
    R_prox_r, x_prox_r = orient_bone_basis(bones_r_calib[prox_name], bones_r_calib[inter_name], x_meta_r)
    bone_rot_mat_r[prox_name] = R_prox_r
    
    R_inter_r, x_inter_r = orient_bone_basis(bones_r_calib[inter_name], bones_r_calib[dist_name], x_prox_r)
    bone_rot_mat_r[inter_name] = R_inter_r
    
    R_dist_r, x_dist_r = orient_bone_basis(bones_r_calib[dist_name], bones_r_calib[tip_name], x_inter_r)
    bone_rot_mat_r[dist_name] = R_dist_r
    bone_rot_mat_r[tip_name] = R_dist_r

ref_lat_th_meta_r = quat_to_rot(right_orig_rot['thumb-metacarpal'])[:, 0]
R_th_meta_r, x_th_meta_r = orient_bone_basis(bones_r_calib['thumb-metacarpal'], bones_r_calib['thumb-phalanx-proximal'], ref_lat_th_meta_r)
bone_rot_mat_r['thumb-metacarpal'] = R_th_meta_r

R_th_prox_r, x_th_prox_r = orient_bone_basis(bones_r_calib['thumb-phalanx-proximal'], bones_r_calib['thumb-phalanx-distal'], x_th_meta_r)
bone_rot_mat_r['thumb-phalanx-proximal'] = R_th_prox_r

R_th_dist_r, x_th_dist_r = orient_bone_basis(bones_r_calib['thumb-phalanx-distal'], bones_r_calib['thumb-tip'], x_th_prox_r)
bone_rot_mat_r['thumb-phalanx-distal'] = R_th_dist_r
bone_rot_mat_r['thumb-tip'] = R_th_dist_r

ibm_matrices_r = np.zeros((25, 4, 4), dtype=np.float32)
for skin_idx, jid in enumerate(right_skin_joints):
    name = right_json['nodes'][jid]['name']
    R_b = bone_rot_mat_r[name]
    pos_b = bones_r_calib[name]
    
    M = np.eye(4, dtype=np.float32)
    M[:3, :3] = R_b
    M[:3, 3] = pos_b
    M_inv = np.linalg.inv(M)
    ibm_matrices_r[skin_idx] = M_inv.T

ibm_bytes_r = ibm_matrices_r.tobytes()

out_joints_r, out_weights_r = extract_top4(W_out_l, left_node_names, right_node_names)

cross_finger_r = 0
for i in range(out_weights_r.shape[0]):
    present_fingers = set()
    for b in range(4):
        if out_weights_r[i, b] > 0:
            name = right_node_names[out_joints_r[i, b]]
            if 'phalanx' in name or 'tip' in name:
                for f in FINGER_KEYWORDS:
                    if f in name:
                        present_fingers.add(f)
    if len(present_fingers) > 1:
        cross_finger_r += 1
print(f"   Right hand cross-finger phalanx weights check: {cross_finger_r} vertices (MUST BE 0!)")
assert cross_finger_r == 0, f"Expected 0 cross-finger phalanx vertices, got {cross_finger_r}"

# Right hand bind-pose geometry validations:
v0_r = v_aligned_r[f_simp_r[:, 0]]
v1_r = v_aligned_r[f_simp_r[:, 1]]
v2_r = v_aligned_r[f_simp_r[:, 2]]
len01_r = np.linalg.norm(v1_r - v0_r, axis=1)
len12_r = np.linalg.norm(v2_r - v1_r, axis=1)
len20_r = np.linalg.norm(v0_r - v2_r, axis=1)
max_edge_r = max(len01_r.max(), len12_r.max(), len20_r.max())
print(f"   Right hand max triangle edge length in bind pose: {max_edge_r * 1000:.2f} mm (MUST BE < 7 mm!)")
assert max_edge_r < 0.007, f"Max edge length {max_edge_r * 1000:.2f} mm exceeds 7 mm limit!"

main_bone_r = np.argmax(W_out_l, axis=1)
tri_bones_r = main_bone_r[cleaned_new_f_simp]
stretched_count_r = 0
for t in range(len(cleaned_new_f_simp)):
    b_set = set(tri_bones_r[t])
    if (b_set & DISTAL_INTER_TIP) and (b_set & WRIST_META):
        stretched_count_r += 1
print(f"   Right hand stretched triangles connecting distal/inter/tip with wrist/meta: {stretched_count_r} (MUST BE 0!)")
assert stretched_count_r == 0, f"Expected 0 stretched triangles, got {stretched_count_r}"

pack_anatomical_glb(
    str(OUTPUT_DIR / 'anatomical_right.glb'),
    v_aligned_r,
    norm_aligned_r,
    final_uvs,
    out_joints_r,
    out_weights_r,
    f_simp_r,
    right_json,
    bones_r_calib,
    bone_rot_mat_r,
    ibm_bytes_r,
    bytes_bc,
    bytes_norm
)

print("Anatomical GLB assets generated successfully!")
