# Anatomical (improved): third hand model

Status: implementation and visual correction in progress, 2026-10-23. User authorized the plan and implementation. This is a third selectable model (`anatomical-improved`); preserve `anatomical`, `webxr`, their assets and the current default. No commit or publication is part of this implementation request. Current results and unresolved defects are tracked in [verification evidence](evidence/anatomical-improved/VERIFICATION.md).

## Source and protected work

Source: `C:/Users/pavel/Downloads/hand_standard.glb`. Preserve the original and all existing dirty work. Baseline patch and SHA256 inventory: `scratch/improved-baseline/`. The extracted web checkout is the current repository; desktop sources and environments remain outside this scope.

Confirmed audit findings: source texture UV transforms were lost in the second-model conversion; UVs/weights were transferred by nearest vertices from another mesh; runtime forcibly extends the anatomical wrist boundary by 22–27 mm. The third model must correct those paths without changing the other two models' appearance.

## Sequence and acceptance

1. Inspect source geometry, UV transforms and materials; record source hash and reproducible conversion inputs. Capture fixed-camera baselines.
2. Prepare left/right geometry preserving silhouette, finger webbing, joints, nails and UV seams. Three LOD targets per hand: 30–40k, 15–20k, 6–10k triangles. These are initial targets, not performance evidence.
3. Fit 25 named skeletal anchors to the actual mesh, with correct bind transforms and thumb axes. Constrain weight transfer to anatomical regions; validate normalized finite weights, bone references, rest-pose reconstruction and articulation. Preserve natural wrist geometry.
4. Apply the original texture transform into the final UVs, preserve/rebake surface detail, check tangent handedness when mirroring. Share external 2K color/normal and <=1K material maps; provide lighter 1K maps. Avoid duplicate procedural nails and procedural recoloring in this model.
5. Integrate `anatomical-improved` with persisted settings and localized third option. Lazy-load, handle failure/retry and stale async callbacks, share texture resources and dispose owned geometry/skeleton resources. LOD switches must preserve pose and be stable during video export.
6. Verify both hands in relaxed pose, single finger presses, chords, octaves, scales, thumb under and fast transitions; inspect four cameras and close views. Distinguish mesh/rig defects from upstream MotionPose limitations.
7. Measure identical scenes for all three models: frame time p50/p95, renderer draw calls/triangles/resource counts, repeated switching and loading. Goals: 60fps desktop, 30fps physically tested weaker device and <=6MiB complete improved assets; record actual values and remaining limitations. Mobile viewport emulation does not establish weak-device performance. Verify settings/reload, PWA asset routing, production build and export compatibility.

## Assigned ownership

- `improved_hand_assets` (GPT-6 Luna / xhigh): new conversion pipeline, `public/models/hands/improved/**`, asset evidence. Isolated tooling only.
- `improved_hand_runtime` (GPT-6 Luna / xhigh): hand runtime, new loader/LOD/rig helpers and semantic tests; preserve legacy paths.
- `improved_hand_settings_qa` (GPT-6 Luna / xhigh): settings/i18n and new focused tests/browser harness; run integration checks after assets/runtime are ready.
- Root: integration contracts, documentation, independent review, visual acceptance and focused final checks. Worker handoff is not an accepted gate.

No actual weak-device, memory, deformation or visual acceptance is claimed at initialization.

## Current checkpoint

On 2026-10-23, the checkout was safely fast-forwarded from `9deca23` to upstream `15119abd036d45e8bf4a29cede7aa6dda161b3f2` (dev.23). All 59 local modified/new files were archived outside the checkout before integration; the 51 files outside upstream overlaps retained identical SHA-256 hashes. Local changes in eight overlapping files were reapplied without conflict, and nothing is staged. A fresh posed baseline is required because upstream changed the performance engine. Resume ownership: `hand_assets_resume` (assets), `hand_runtime_resume` (rig), `hand_qa_resume` (browser evidence); root reviews and accepts results.

The reproducible optimized asset package is 5.94 MiB including its manifest. Geometry meets the three LOD budgets, all six GLBs pass format validation, settings persist, and lazy loading/export readiness are integrated. The custom loader's GPU skin-index type mismatch was found by rendered-image review and corrected. Posed image review still rejects thumb-base deformation; pad contact is being measured. Production build, final export/image/performance checks and the remaining articulation matrix follow those corrections. Earlier mechanically passing browser tests do not close the visual gate.
