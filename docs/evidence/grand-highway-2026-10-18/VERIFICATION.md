# Grand piano note surface — dev.15, 2026-10-18

Checkout: C:\Projects\pianomotion-studio. Base HEAD: 4e51283 (user dev.13), with pre-existing uncommitted dev.14 browser/audio fixes preserved. No stage, commit, push or deployment.

## Implementation

The former rectangular 28-inch deck ended near world Z=-33.2, before the curved tail, and extended past the right bentside. A shared model-space contour now drives the inner rim, cavity floor and note deck. Two Bezier spans use 64 segments each. The open front reaches the unchanged key strike plane Z=-5.2. The outer body silhouette is unchanged; inner wall thickness is reduced from 1.35 to 1.20 inches to give all 88 full note widths clearance.

Full-width lane bounds are prepared once per pitch. Note bars retain their front edge and time-to-Z mapping; their rear end is trimmed to the lane's common interior range. This is conservative rectangular bar trimming, not per-pixel shader clipping. The deck itself follows the curved geometry. Live and fixed/manual export scenes share these classes.

Owners: grand_highway (GPT-6 Luna Extra High) — geometry and unit tests; grand_visual (GPT-6 Luna Extra High) — real WebGL harness/spec; root — independent review, integration, versions, documentation and verification.

## Verification

| Command / scenario | Result |
| --- | --- |
| node node_modules/vitest/vitest.mjs run --config vitest.config.ts apps/client/src/render3d --maxWorkers=1 | 20/20, 3 files. New footprint tests: shared floor/deck, upward normals, all 88 full lane rectangles, C8 clipping. Final type-only test repair separately rechecked 3/3. |
| npm run typecheck | PASS after repairing the new test's BufferAttribute union handling. |
| node node_modules/typescript/bin/tsc -p tests/browser/r3d/tsconfig.json | PASS, includes the new browser harness. |
| npm run lint | PASS. |
| npm run build | PASS, buildId 0370314f0957ca509cd92d9f, 258 offline resources / 70.56 MiB. Existing large-chunk warning remains. |
| PIANOMOTION_BROWSER_CHANNEL=chrome + playwright.config.ts grand-highway.spec.ts | 1/1 PASS, 20.0 s. |
| PIANOMOTION_BROWSER_CHANNEL=msedge + playwright.config.ts grand-highway.spec.ts | 1/1 PASS, 17.4 s. |
| git diff --check | No whitespace errors; existing Windows line-ending warnings only. |

The browser scenario uses actual Three.js/WebGL. It confirms a deck ray hit at (-8,-41), beyond the former rectangular rear end, and no hit at (22,-24), outside the right bend. Long center/C8 bars remain at the strike plane while their rear lengths differ. It captures a complete grand view and four fixed-camera views: concert, overhead, POV and side arch. Root inspected Chrome images visually. Reports and images are stored beside this document.

## Limits and recovery

This is focused geometry/render acceptance, not a new full CI, audio, numerical-parity or decoded-media acceptance. No musical algorithm, timing plan, hand rig or saved project format was changed. The supplied test scene uses deterministic notes and no hand motion. Existing wider results remain in ../ci-adaptation-2026-10-18/VERIFICATION.md and must not be presented as rerun for dev.15.

To undo only this feature, restore keyboard3dView.ts/fallingNotes3dView.ts geometry from base and remove their new shared footprint import/module; leave the independent SoundFont clock and browser-CI changes intact. Do not clear IndexedDB or reset the dirty checkout. Version/manifests/release descriptions must be adjusted together if preparing a different release.
