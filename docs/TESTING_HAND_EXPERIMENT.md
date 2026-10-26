# Testing hand — WebXR kinematics with anatomical appearance

Status: **experimental, not visually accepted**. Existing `WebXR`, `Anatomical (Realistic)` and `Anatomical (improved)` models are untouched. Default remains `Anatomical`.

## Objective

Test the user's desired combination:

- **Motion:** exact WebXR motion targets, wrist trajectory, bone orientations, hover behaviour, per-finger movement and existing note sequencing.
- **Surface:** existing anatomical-improved realistic hand geometry, UVs, normals, fingernails and high-resolution PBR textures.
- **Skinning:** in a one-time runtime initialization pass, sample WebXR's trusted skin weight field onto the anatomical surface, rather than using the anatomical GLB's estimated weights, which have produced palm/wrist spikes and twisted thumb webs.

## Implementation

`settings.handModel = "testing"` is a fourth, opt-in model in all six UI locales.

`testingHandSkin.ts`: builds a spatial index of WebXR **bind-pose vertices**, interpolates the closest reference vertices' `JOINTS_0`/`WEIGHTS_0` onto the anatomical shell, retains at most four influences and normalizes them. It copies the anatomical geometry (positions, UVs, normals and indices) without changing the existing GLB files. Source and target are both transformed into the same **inch-space** when parsed. No CPU skin update is added to the animation loop.

`buildTestingHandRig` makes the WebXR skeleton and inverse bind matrices the deformation rig and installs the anatomical mesh as its skinned surface. That is a deliberate alternative to the improved model's re-estimated carpal anchors and pose-dependent axial length fitting. Regular WebXR motion (including hover and tip correction) remains in effect. Unlike `anatomical-improved`, Testing does not independently solve fingertip contact after the fact.

The detailed hand manifest, shared texture cache, async loading/retry, LOD selection, left/right assets, and deterministic highest-LOD export path are reused, including fallback when loading fails. The original model IDs/assets/default stay unchanged.


## Matched four-model browser evidence (26 October 2026)

The experiment now includes a repeatable Playwright capture of all **four** hand options:
`webxr`, `anatomical`, `anatomical-improved`, and `testing`. Each is
rendered with the **same two-hand MIDI, performance plan, viewport (1280 × 800),
transport positions (0.75, 3.00, 6.00 s)** and all four camera presets
(`concert`, `overhead`, `pov`, `side_arch`).

- 48 full-page PNG reference frames are stored as `testing-ab-<model>-<camera>-<time>s.png` in the CI artifact. A machine-readable JSON attachment records loaded left/right model, LOD, errors, scene/transport time, retained plan ID and screenshot filenames.
- The automation **asserts real WebGL model readiness and no fallback** for both hands, and asserts that the original performance-plan ID and requested transport time survive every model/camera switch.
- Headless frames are **inspection evidence, not a pass criterion for natural movement**. They cannot verify between-frame interpolation, realistic thumb opposition, a real user's device/GPU performance, or exporter parity.
- After inspecting comparable frames, perform interactive playback with alternating chords, octaves/tenths, white/black keys, thumb-under, continuous seeking, and export. Reject visible finger folding/collapse, unnatural nail motion, adjacent-digit penetration, wrist seams or skin shading discontinuities before merging.

GitHub Actions workflow: `.github/workflows/testing-hand-pr.yml`. Test case:
`Testing hand: matched WebGL model and camera evidence` in
`tests/browser/anatomical-improved.spec.ts`.

## Acceptance required (not yet performed)

1. Confirm the `Testing` option persists on refresh, selects correctly, switches back safely, and works with **both hands**.
2. Capture same note/time, camera, skin style and lighting for **WebXR**, **Anatomical (Realistic)**, **Anatomical (improved)** and **Testing**. Use Concert, POV, Overhead and Side Arch with close-ups of all digits.
3. Reject if any angular thumb-web folds, exploding spikes, interpenetrating fingers, plastic gloss, broken fingernails, wrist seams, detached sleeve, incorrect normals or skin inversion appears.
4. Run still poses at neutral, 30/60/90-degree flex, thumb-under, black and white key contacts, octaves and tenths, and continuous musical playback/seek/reverse/repeat.
5. Verify LOD0/1/2 transitions have no hand pose pops, resource leaks or large frame spikes. Log p50/p95 frame times on desktop and actual weaker physical hardware.
6. Verify exported MP4/WebM frames match live Testing and that a model loading error cannot silently switch to another model during export.
7. Track WebXR reference bone orientation vs anatomy mesh bind orientation and distances, particularly at thumb CMC and ulnar wrist. If Testing still deforms unnaturally, next iteration should use a **surface-cage or per-finger geodesic weight transfer**, with manually reviewed cut line and corrective blendshapes; do **not** conceal defects with a material shader.

## Known limitations

- This is a spatial vertex-based approximation, not a verified anatomical retopology or fully sculpted deformation rig.
- Close or overlapping fingers may share neighboring WebXR reference vertices; weight transfer can still leak across anatomical boundaries.
- The source mesh geometry is not yet reprojected onto the WebXR bind axes with per-phalange cage correspondences. Geometric registration between the two rest poses must be verified.
- Face topology and joint crease loops have not been manually accepted.
- Existing asset licensing/provenance restrictions still apply (see `docs/PROVENANCE.md`).

Do not merge to `main` or deploy Testing before a rendered-image review and typecheck/unit/browser gates. This branch is a **research preview** intended for user comparison, not a claim that deformation quality is solved.
