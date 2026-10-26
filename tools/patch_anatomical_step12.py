#!/usr/bin/env python3
"""
Patch script to apply Step 1 (mesh joint warping) and Step 2 (analytical phalanx skin weights)
to tools/build_anatomical_glb.py.
"""

def patch():
    path = 'tools/build_anatomical_glb.py'
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Add get_finger_column and col_arr_geom before Step 7
    s_before_step7 = '''print("7. Calibrating Straight Central Bone Axes in Undeformed Mesh...")'''
    
    s_col_def = '''def get_finger_column(x_val, y_val, z_val):
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

print("7. Calibrating Straight Central Bone Axes and Warping Sculpted Joints...")'''

    assert s_before_step7 in content, "Step 7 marker not found"
    content = content.replace(s_before_step7, s_col_def, 1)

    # 2. Replace Step 7 finger calibration and warping logic
    target_step7_fingers = '''bones_l_calib = {}
bones_l_calib['wrist'] = bones_l['wrist'].copy()

# Anatomical DIP joint offset from physical surface fingertip (meters)
l3_anat = {'index': 0.0160, 'middle': 0.0170, 'ring': 0.0165, 'pinky': 0.0150}
# Runtime MotionPose calibrated segment lengths (meters) to match lenRatio ≈ 1.000 in orientBone
L_DIST_POSE = {'index': 0.01918, 'middle': 0.02024, 'ring': 0.02024, 'pinky': 0.01811}
L_INTER_POSE = {'index': 0.02450, 'middle': 0.02876, 'ring': 0.02769, 'pinky': 0.01917}
L_PROX_POSE = {'index': 0.04261, 'middle': 0.04793, 'ring': 0.04474, 'pinky': 0.03515}
L_META_POSE = {'index': 0.07149, 'middle': 0.07058, 'ring': 0.06745, 'pinky': 0.04963}

# Fingers 2..5 (index, middle, ring, pinky)
for f in ['index', 'middle', 'ring', 'pinky']:
    vf = v_simp_aligned_l[vert_domains == f]
    ym = v_simp[vert_domains == f, 1]
    y0 = ym.min()
    y1 = ym.max()
    
    c20 = vf[np.abs(ym - (y0 + 0.20 * (y1 - y0))) < 0.015].mean(axis=0)
    c70 = vf[np.abs(ym - (y0 + 0.70 * (y1 - y0))) < 0.015].mean(axis=0)
    u_shaft = c70 - c20
    u_shaft /= np.linalg.norm(u_shaft)
    
    s_tip = np.max((vf - c20) @ u_shaft)
    m_tip_surf = c20 + s_tip * u_shaft
    
    b_prox = bones_l[f + '-finger-phalanx-proximal']
    b_meta = bones_l[f + '-finger-metacarpal']
    
    m_dip = m_tip_surf - l3_anat[f] * u_shaft

    # Relocate joint pivots to ~58% depth (toward dorsal surface, axis 2 = Z)
    slice_dip = vf[np.abs((vf - m_dip) @ u_shaft) < 0.006]
    if len(slice_dip) > 0:
        z_min_dip, z_max_dip = slice_dip[:, 2].min(), slice_dip[:, 2].max()
        m_dip[2] = z_min_dip + 0.58 * (z_max_dip - z_min_dip)

    m_tip = m_dip + L_DIST_POSE[f] * u_shaft
    m_pip = m_dip - L_INTER_POSE[f] * u_shaft
    m_mcp = m_pip - L_PROX_POSE[f] * u_shaft

    u_meta = b_prox - b_meta
    u_meta /= np.linalg.norm(u_meta)
    m_meta = m_mcp - L_META_POSE[f] * u_meta
    
    bones_l_calib[f + '-finger-metacarpal'] = m_meta
    bones_l_calib[f + '-finger-phalanx-proximal'] = m_mcp
    bones_l_calib[f + '-finger-phalanx-intermediate'] = m_pip
    bones_l_calib[f + '-finger-phalanx-distal'] = m_dip
    bones_l_calib[f + '-finger-tip'] = m_tip

    # Distal fingertip taper applied STRICTLY to v_simp_aligned_l (12021 manifold vertices)
    vf_mask = (vert_domains == f)
    vf_indices = np.where(vf_mask)[0]
    dist_len = L_DIST_POSE[f]
    for vi in vf_indices:
        v_pt = v_simp_aligned_l[vi]
        axial_proj = np.dot(v_pt - m_dip, u_shaft)
        if axial_proj > 0.35 * dist_len:
            s_taper = np.clip((axial_proj - 0.35 * dist_len) / (0.65 * dist_len), 0.0, 1.0)
            taper_factor = 1.0 - 0.15 * s_taper
            p_axial = m_dip + axial_proj * u_shaft
            r_radial = v_pt - p_axial
            v_simp_aligned_l[vi] = p_axial + taper_factor * r_radial'''

    replacement_step7_fingers = '''bones_l_calib = {}
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

    # Target bone positions exactly aligned with warped creases
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
    finger_z_bounds[f] = (float(vf_final[:, 2].min()), float(vf_final[:, 2].max()))'''

    assert target_step7_fingers in content, "target_step7_fingers not found"
    content = content.replace(target_step7_fingers, replacement_step7_fingers, 1)

    # 3. Update thumb in Step 7 to register u_shaft_f and finger_z_bounds
    target_step7_thumb = '''bones_l_calib['thumb-metacarpal'] = m_th_meta
bones_l_calib['thumb-phalanx-proximal'] = m_th_mcp
bones_l_calib['thumb-phalanx-distal'] = m_th_dip
bones_l_calib['thumb-tip'] = m_th_dip + 0.0300 * u_th

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
        v_simp_aligned_l[vi] = p_axial + taper_factor * r_radial'''

    replacement_step7_thumb = '''bones_l_calib['thumb-metacarpal'] = m_th_meta
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
finger_z_bounds['thumb'] = (float(v_th_final[:, 2].min()), float(v_th_final[:, 2].max()))'''

    assert target_step7_thumb in content, "target_step7_thumb not found"
    content = content.replace(target_step7_thumb, replacement_step7_thumb, 1)

    # 4. Remove duplicate get_finger_column in Step 8
    target_step8_col_def = '''def get_finger_column(x_val, y_val, z_val):
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

col_arr_geom = np.array([get_finger_column(x_m_geom[k], y_m_geom[k], v_simp_aligned_l[k, 2]) for k in range(n_geom)])'''

    replacement_step8_col_def = '''# col_arr_geom already initialized before Step 7'''

    assert target_step8_col_def in content, "target_step8_col_def not found"
    content = content.replace(target_step8_col_def, replacement_step8_col_def, 1)

    # 5. In Step 8 item 2 and item 3: add Step 2 analytical phalanx weights & smooth web fade
    target_step8_transitions = '''        w_factor = s_y * s_x
        w_p = interp_w[p_jid]
        if w_p > 0:
            trans = (1.0 - w_factor) * w_p
            interp_w[p_jid] -= trans
            interp_w[m_jid] += trans

    # 3. Thumb inner fold (1st web space) smooth transition from metacarpal to proximal phalanx
    if f_col == 'thumb' and y_m_i > 0.06:
        t_th = np.clip((x_m_i - 0.14) / (0.28 - 0.14), 0.0, 1.0)
        s_th = t_th * t_th * (3.0 - 2.0 * t_th)
        w_th_p = interp_w[22] # thumb-phalanx-proximal
        if w_th_p > 0:
            trans = (1.0 - s_th) * w_th_p
            interp_w[22] -= trans
            interp_w[23] += trans # thumb-metacarpal

    # Column isolation: zero out phalanges of other fingers, transfer to their metacarpal'''

    replacement_step8_transitions = '''        t_web_h = np.clip((y_m_i - y_w) / 0.035, 0.0, 1.0)
        s_web_fade = t_web_h * t_web_h * (3.0 - 2.0 * t_web_h)
        s_x_eff = s_x + s_web_fade * (1.0 - s_x)
        w_factor = s_y * s_x_eff
        w_p = interp_w[p_jid]
        w_m = interp_w[m_jid]
        total_mp = w_p + w_m
        interp_w[p_jid] = w_factor * total_mp
        interp_w[m_jid] = (1.0 - w_factor) * total_mp

    # 3. Thumb inner fold (1st web space) smooth transition from metacarpal to proximal phalanx
    if f_col == 'thumb' and y_m_i > 0.06:
        t_th = np.clip((x_m_i - 0.14) / (0.28 - 0.14), 0.0, 1.0)
        s_th = t_th * t_th * (3.0 - 2.0 * t_th)
        w_th_p = interp_w[22] # thumb-phalanx-proximal
        if w_th_p > 0:
            trans = (1.0 - s_th) * w_th_p
            interp_w[22] -= trans
            interp_w[23] += trans # thumb-metacarpal

    # Step 2: Analytical distribution of phalanx skin weights centered strictly at m_pip and m_dip (Δs = 0.000 mm)
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

    # Column isolation: zero out phalanges of other fingers, transfer to their metacarpal'''

    assert target_step8_transitions in content, "target_step8_transitions not found"
    content = content.replace(target_step8_transitions, replacement_step8_transitions, 1)

    # 6. Reduce Laplacian iterations for phalanx preservation
    target_laplacian = '''for iter_idx in range(15):
    # Smooth each finger's bones within its own column on continuous surface
    for f, phal_jids in FINGER_PHALANGES.items():
        f_bone_jids = phal_jids + [FINGER_METAS[f]]
        mask_f, A_norm_f = A_norm_fingers[f]
        W_f = W_geom[mask_f, :][:, f_bone_jids]
        W_f_smooth = 0.6 * W_f + 0.4 * (A_norm_f @ W_f)
        W_geom[np.ix_(mask_f, f_bone_jids)] = W_f_smooth

    # Smooth palm and metacarpal bones across transition zones on continuous surface
    W_p = W_geom[mask_palm, :][:, palm_meta_jids]
    W_p_smooth = 0.6 * W_p + 0.4 * (A_norm_p @ W_p)
    W_geom[np.ix_(mask_palm, palm_meta_jids)] = W_p_smooth'''

    replacement_laplacian = '''for iter_idx in range(4):
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
    W_geom[np.ix_(mask_palm, palm_meta_jids)] = W_p_smooth'''

    assert target_laplacian in content, "target_laplacian not found"
    content = content.replace(target_laplacian, replacement_laplacian, 1)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

    print("Successfully patched tools/build_anatomical_glb.py!")

if __name__ == '__main__':
    patch()
