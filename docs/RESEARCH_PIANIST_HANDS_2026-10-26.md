# Realistic pianist hands — research and engineering plan (2026-10-26)

**Status:** evidence-backed research and design; does **not** certify Testing as visually or anatomically accepted. Testing remains opt-in, PR #9 stays draft. **Never import third-party hand scans, motion recordings, checkpoints, or MANO meshes into the MIT repo without a separate license review.**

## 1. Executive decision

We currently have two distinct subsystems that must remain separate:

1. **Pianist motion / control:** keep WebXR's user-approved timing, trajectories, hover, finger articulation and 25 named bones as the motion oracle. Later improve *pianist phrasing* against recorded hand/MIDI data.
2. **Surface deformation:** the realistic anatomical mesh must have a compatible calibrated rest rig, geodesically/segment-aware skinning and *pose-space correctives*. Re-weighting it against the nearest WebXR surface samples alone is not a complete rigging solution.

**Do not** replace WebXR motion with a heavy neural model or add generic global skin-weight smoothing to Testing. Such smoothing has already reduced stretch in some samples but worsened local collapse and is disabled.

### Current failure evidence (experimental LOD2, synthetic matched pose)

- WebXR's **bone world matrices match Testing's** in the pose-parity test.
- Digit-aware weights remove wrong-finger influence in high-confidence digit regions.
- Yet Testing still reaches max triangle area ratio ~61.45 (left), ~15.93 (right) and max edge stretch ~30.76 / ~10.65 in a synthetic pose; WebXR ~8.29 / ~2.13 max area and ~8.21 / ~2.81 edge stretch in the *same pose*. This is a diagnostic, not a claim about real-score motion.
- Direct spatial weight transfer suffers from differences in bind shape/phalange lengths, and our previous global topology smoothing introduced new collapse.
- A full 4-model × 4-camera × 3-time browser test exceeded its 12-minute case timeout while waiting for nested `requestAnimationFrame` on headless Chromium. Partial PNGs of WebXR and Anatomical **do not validate Testing**.

## 2. Relevant prior art, verified

| Resource | What it contains | Use in PianoMotion | Status / constraints |
|---|---|---|---|
| **FürElise** (SIGGRAPH Asia 2024, Stanford) | ~10 hours of 3D motion from 15 expert pianists, 153 pieces, 21 joints × 3 for *each hand* per frame, synchronized MIDI/key events, MANO parameters | Gold-standard examples for transitions, thumb-under, hand shape and key timing; offline *reference-only* benchmarks | Dataset **CC BY-NC 4.0**; ~44 GB full download; don't bundle files or derived MANO meshes into the released app. Paper: https://for-elise.github.io/ ; dataset docs: https://huggingface.co/datasets/rcwang/for_elise/blob/main/README.md |
| **PianoMotion10M** (ICLR 2025) | 116 h of overhead video, ~10M annotated piano hand poses, released baseline | Motion statistics, smoothness and position fidelity; compare piano passages and 2D projected landmarks | Code repo advertises **Apache-2.0**, dataset terms require separate inspection; https://github.com/agnJason/PianoMotion10M |
| **SKY-Piano** (2026-era research project) | 11 h multimodal piano performances, motion/4-camera video/MIDI/MusicXML; 7 professional and 12 amateur performers | Compare expert/amateur wrist and finger motion and synchronize contact timings | Verify actual download availability and licensing before use: https://joonhyungbae.github.io/skypiano/ |
| **MUSIC** (SIGGRAPH 2026) | Muscle-driven, physics-based bimanual piano control with a musculoskeletal hand and note-event goals | Conceptual guide for separating slow global coordination from fast finger actuation | Heavy offline RL simulation; *not* a practical browser runtime dependency: https://pei-xu.github.io/MUSIC |
| **MANO** (SIGGRAPH Asia 2017) | Statistical hand shape + pose-dependent non-rigid correctives; scans and pose synergies | Architecture for **pose blendshapes** / shape-dependent rigging, NOT a drop-in replacement for our licensed realistic mesh | MANO license is non-commercial, personal/non-transferable, explicitly **no redistribution** without permission: https://mano.is.tue.mpg.de/license.html |
| **OpenSim hand/wrist model** | 22 rigid bodies / 23 independent DoFs, including thumb CMC opposition, finger MCP flexion/abduction, PIP/DIP flexion and wrist deviation | Anatomical joints, calibration & feasible-pose checks, with artist-tuned ranges | Reference paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC10650739/ |
| **Blender Preserve Volume** | Quaternion-based skinning to mitigate joint volume collapse | Offline comparison of LBS vs DQS during rig authoring | Blender feature does **not imply** that exported glTF runs DQS in Three.js; require visual/export check: https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/armature.html |
| **Blender Studio Pose Shape Keys** | Author masked corrective shapes per bent finger and drive by individual bone pose | Strongest practical authoring technique for MCP/PIP/DIP, thumb web and wrist folds | Author **our own** correctives from **our own** geometry; bake morph targets into glTF, drive weights explicitly in Three.js: https://studio.blender.org/tools/addons/pose_shape_keys |
| **Three.js SkinnedMesh** | 4 joint indices/weights per vertex + regular GPU skinning | Live deformation engine and deterministic asset loader | Stock SkinnedMesh does not itself give MANO-like pose corrections; DQS is an open feature request: https://threejs.org/docs/pages/SkinnedMesh.html ; https://github.com/mrdoob/three.js/issues/20324 |

## 3. Root-cause hypotheses: isolate before making changes

**A. Misregistration of bind spaces** — The anatomical mesh was aligned by a *single global similarity transform*, whereas real bones and WebXR joint centers differ in local lengths, rotation frames and radial extents. Nearest WebXR surface vertices may belong to the wrong longitudinal phalanx section even when the finger label is correct.

**B. Wrong joint/skin partition along each finger** — Existing digit-awareness prevents index/middle confusion but not index-PIP/index-DIP confusion; abrupt 4-bone pruning can put large weight gradients across a single triangle.

**C. Incomplete anatomical hinge model** — A single finger orientation from the MotionPose is not a sufficient description of thumb CMC opposition, palmar arch and the changing distribution of skin volume near MCP/PIP/DIP. The useful WebXR global movement does not guarantee the derived realistic surface shape.

**D. Skeleton segment scaling** — The WebXR runtime clamps longitudinal lengths in its non-anatomical branch, whereas the realistic mesh was fitted to a different rest hand. The same bone matrix can yield different *relative* vertex motion and stretch.

**E. Geometry** — LOD simplification may remove joint-edge loops. We must compare LOD0 (~35k tris) to LOD2 (~8k) in identical posed positions and preserve silhouettes, nails and wrist cut.

## 4. Recommended architecture (no new model switches)

```text
MIDI / note and fingering plan
         |
  Existing WebXR motion (preserve)
         |
  HandPose / 25 named bones
         |--------------------------+
         |                          |
  Native WebXR renderer       Testing realistic renderer
                              |
                      Rig calibrated in Blender
                        - wrist + CMC/MCP/PIP/DIP
                        - consistent bone orientation/rest
                        - 4-weight geodesic/segment assignment
                        - joint deformation loops in surface
                              |
                      GPU skinning + authored correctives
                        - PIP/DIP knuckle pads
                        - MCP palm arch
                        - thumb CMC/webbing
                        - wrist/forearm seam
                              |
                      Contact QA vs depressed key surface
```

- Keep the user's *one* Testing option; no secondary public research switches.
- **Offline** Blender/Codex rig generation and pose QA; **online** Three.js receives only efficient glTF/GLB meshes, skin weights, morph targets and compact calibration data.
- Each corrective is authored against the exact *same* mesh topology and mirrored/validated for both hands. Blendshape influence is a calibrated function of local joint rotation, not a direct replacement of skeleton motion.
- Validate LOD0/1/2 separately (correction displacements must map across LOD topology); never apply LOD0 deltas naively to LOD2 vertex indices.
- Keep existing Classic/Anatomical/Improved/WebXR models available and unchanged; Testing has explicit fallback and its model ID remains visible in diagnostics.

## 5. Concrete ordered work packages

**P0 — registration and deform evidence**
1. Implement an offline **per-bone bind-frame registration** experiment using both rigs' named bone bind transforms; compare with current nearest-vertex transfer and report body-part metrics on *both hands / all LODs*. No runtime switch until objective improvement.
2. Fix browser evidence by **bounded time waits rather than nested requestAnimationFrame**, shard captures by model/view or reduce frame count, write PNGs/JSON incrementally, and **never claim success from incomplete captures**.
3. Label each triangle/vertex by anatomical segment using bone metadata, track worst 1% triangles' centroids in bone-local coordinates, and produce targeted review frames (thumb web, PIP/DIP, wrist), rather than applying global smoothing.
4. Derive 21 comparable anatomical landmarks from MotionPose chains and introduce an **optional offline** benchmark against selected synchronized motion data. Do not load MANO/PianoMotion datasets at runtime.

**P1 — Blender deform rig on existing photoreal hand**
5. Fit a **true articulated anatomical rest armature** to *our* own realistic high-resolution hand: thumb CMC opposition+flexion, MCP abduction/flexion, each PIP/DIP hinge; palm arch/ulnar carpal support; explicit left/right and joint-roll validation.
6. Build finger-local skin weights with geodesic barriers and 4 influences/vertex; retain crease edge loops. Compare LBS and Blender DQS *offline* (GLB/Three.js must be retested, DQS is not a guaranteed export property).
7. Author **pose-space corrective shapes** for MCP/PIP/DIP bends at 0°, 30°, 60°, 90°, thumb-under/opposition and wrist extension. Explicitly correct palmar fat-pad volume and dorsal skin creases. Export as glTF morph targets, run a small deterministic per-bone influence driver in Three.js.
8. Add fingertip pad contact checks for white/black key-top + depression and fall back to proven WebXR motion, rather than forcing non-physical contact by scaling fingertip bone lengths.

**P2 — piano-specific quality**
9. Establish a small reference corpus: scales/ascending thumb-under, chromatic passages, octave and tenth stretches, rapid repeated notes, black-key alternations, trills, legato, overlapping hold/release, two-hand crossing and wide leaps. Use FürElise MIDI+motion *only where separately licensed*.
10. Validate left/right symmetry, biomechanical DoFs, finger tip continuity (velocity/acceleration/jerk), hand/wrist anticipatory motion and collision with neighbouring fingers and key geometry; inspect at 0.5× and natural speed.
11. Lock all regression and visual gates, verify 30/60 fps deterministic video export, cached LOD switching and user preferences.

## 6. Acceptance gates and failure response

Each evaluation uses identical MIDI, fingering plan, camera, timeline position, hand size and lighting, with named output files.

- **Structural:** valid GLB bind inverses, correct left/right handedness, finite normalized weights, 4 influences, no missing joint, no flipped triangles, real textures, unbroken nails/wrist.
- **Surface:** count >2x edge stretch, <0.5x edge compression, area <0.25x and >2x; track P50/P95/P99 per finger/joint, worst 20 triangles and compare to WebXR baseline. These are **diagnostic thresholds**, not universal anatomical laws; no unconditional success from passing them.
- **Motion:** preservation of WebXR 25 world matrices when Testing selects the same MotionPose; realistic expert-motion plausibility checked separately.
- **Contact:** measured pad-to-key-top gap on actual moving/depressed key, strike/release alignment, no permanent penetration or detached fingers.
- **Visual:** 4 cameras, both hands and at least 3 real active note times, thumb-under and bends at 0°/30°/60°/90°, plus continuous playback (stills alone insufficient).
- **Release:** written human acceptance based on rendered evidence, no commit of source MANO assets or restricted dataset, no merge/deploy before green CI and explicit QA.

## 7. Source-license decision

- This repository's permissive license does not automatically extend to external human-motion datasets or scanned-hand templates.
- **FürElise CC BY-NC 4.0** may serve as a separately stored, optional *noncommercial research reference*; do not redistribute original captures. Verify compatibility before any derivative assets or trained models are released.
- **MANO** requires accepting strict licensing, including no redistribution; study the *method*, not copy the model. Even noncommercial use is not authorization to publish its assets here.
- Check the underlying license for **PianoMotion10M videos/dataset separately** from the Apache-2.0 code.
- Do not assume computer-generated assets built with a GPL authoring add-on inherit the add-on's code license; inspect the add-on and source asset terms before distribution.

## 8. Readings

- FürElise paper: https://arxiv.org/abs/2410.05791 ; data: https://huggingface.co/datasets/rcwang/for_elise/blob/main/README.md
- PianoMotion10M, ICLR 2025: https://proceedings.iclr.cc/paper_files/paper/2025/hash/812c6e27edecd771cc494eb4a06e8927-Abstract-Conference.html
- SKY-Piano: https://joonhyungbae.github.io/skypiano/
- MUSIC, SIGGRAPH 2026: https://pei-xu.github.io/MUSIC
- MANO methodology/licensing: https://mano.is.tue.mpg.de/ ; https://mano.is.tue.mpg.de/license.html
- OpenSim model: https://pmc.ncbi.nlm.nih.gov/articles/PMC10650739/
- Blender Pose Shape Keys: https://studio.blender.org/tools/addons/pose_shape_keys
- Blender Preserve Volume: https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/armature.html
- Three.js DQS issue: https://github.com/mrdoob/three.js/issues/20324
