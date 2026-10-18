# Curved casing smoothing — dev.16, 2026-10-18

Checkout: `C:\Projects\pianomotion-studio`, base `4e51283` plus preserved local dev.14–15 work. No stage/commit/push/deploy.

## Cause and repair

The cheek and outer rim used default `ExtrudeGeometry` curve subdivision (12) and three bevel segments, with separate face normals. Anti-aliasing was already enabled; it could not smooth these geometric facets and discontinuous specular highlights.

`pianoCaseGeometry.ts` samples curves at 64 segments and bevels at eight. It averages neighboring face normals only below a 30-degree crease angle. Exact coincident Float32 positions are grouped, avoiding coarse coordinate buckets merging nearby bevel points. Right-angle seams remain sharp. The factory handles owned geometry cleanup; shared cheeks remain disposed once by the existing scene resource owner.

Only the curved casing cheek/rim meshes use this helper. Keyboard geometry, hands, note timing, musical algorithms, projects, and the previous curved highway fix remain unchanged. The factory is shared by live and fixed/manual scenes. No new dependencies.

GPT-6 Luna Extra High prepared the helper/test and initial browser extension. Both agents reached their usage limit; root completed production wiring, left/right close-up cameras, integration, and independent verification.

## Verification

| Check | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config vitest.config.ts apps/client/src/render3d --maxWorkers=1` | 21/21, 4 files. Smooth normals across curved faces and a retained right-angle seam; existing 88-key/footprint/fixed-scene tests preserved. |
| `npm run typecheck` | PASS. |
| `npm run lint` | PASS. |
| `node node_modules/typescript/bin/tsc -p tests/browser/r3d/tsconfig.json` | PASS, including the real-WebGL harness. |
| Chrome, standard `playwright.config.ts`, `tests/browser/grand-highway.spec.ts` | 1/1 PASS, 24.5 s. |
| Edge, same spec/config | 1/1 PASS, 1.4 min. |
| `npm run build` | PASS, buildId `0af4cee96c6b510a65e176a5`; 258 offline resources / 70.56 MiB. Existing large-chunk warning remains. |

The browser spec checks actual production cheek geometry (>6000 vertices each), finite unit normals, the curved highway tail/bend, strike alignment, and all four fixed cameras. It captures both cheeks together and separate 800×800 details under identical camera/light/environment settings before and after. Root visually confirmed the disappearance of transverse highlight bands on the left cheek. PNGs and reports are adjacent to this file.

`before-chrome.json` is a capture of the old production geometry: its expected failure is the absence of the newly named cheek meshes, not an automated measure of highlight quality. An earlier baseline attempt using npm predev timed out before browser startup; a temporary direct-Vite wrapper captured the baseline. Final Chrome/Edge checks used the normal repository config and startup command. Windows shell timing under concurrent load varied; these elapsed times are not performance benchmarks.

## Acceptance limits

Focused casing/render verification only. Full CI, audio, numerical goldens, stress, and decoded media suites were not repeated for this visual change. Do not interpret preview screenshots or unchanged algorithms as a new full release acceptance.

For a narrow rollback, replace the cheek/rim factory calls in `keyboard3dView.ts` with their previous ExtrudeGeometry construction, then remove the new helper/test. Preserve the independent curved-highway, CI, audio and user changes. No site-data deletion is needed.
