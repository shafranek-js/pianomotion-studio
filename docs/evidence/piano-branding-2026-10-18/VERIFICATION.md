# Piano apron wordmark — dev.17, 2026-10-18

Approved copy: **PIANOMOTION**, with smaller **CONCERT GRAND** centered beneath. Checkout: `C:\Projects\pianomotion-studio`; existing dirty dev.14–16 changes and parallel App/session/waveform/play-along work preserved. No stage, commit, push, or deploy.

`pianoBranding3d.ts` draws tracked serif lettering on a local transparent 2048×512 canvas. Georgia/Times New Roman/system serif is used without a network font dependency. A gold physical material and mipmaps keep the letters legible on the black apron. The 13.2×3.3-inch texture plane is centered at y=-3.46, z=0.952, just in front of the actual apron face at z=0.95; only glyphs are visible, with no plate/frame. It is part of the shared keyboard body, so live and fixed/manual 3D views use it. Existing scene disposal owns geometry/material/texture. Without browser canvas support it returns null.

GPT-6 Luna Extra High implemented the helper/wiring. Root independently reviewed the result, requested the smaller physical size, added browser evidence and synchronized workspace versions, lockfile and release descriptions.

| Check | Result |
| --- | --- |
| Render3d unit regression, one worker | 21/21, 4 files. |
| `npm run typecheck` | PASS on repeat. The initial run intersected concurrent App startup edits and reported two argument-count errors; logo work did not alter that startup logic. |
| Harness `tsc -p tests/browser/r3d/tsconfig.json` | PASS. |
| `npm run lint` | FAIL in concurrent work: unused fixtures binding in App; ref write during PianoPlayer render; prefer-const for play-along onsetTimer. Two related hook-dependency warnings also remain. These changes were preserved, not repaired as part of the wordmark. |
| Scoped ESLint for `keyboard3dView.ts` and `pianoBranding3d.ts` | PASS. |
| `git diff --check` | PASS; Windows line-ending notices only. |
| `npm run build` | PASS, buildId `3980acd74eb6f913b5be3c66`, 258 offline resources / 70.56 MiB. Existing large-chunk warning remains. |
| Chrome standard grand-highway browser spec | 1/1 PASS, 26.9 s. |
| Edge same spec | 1/1 PASS, 53.3 s. |

The real-WebGL browser scenario asserts exact copy, centered front-apron position and visible gold pixels in the wordmark area; it also preserves the curved-screen and smooth-cheek checks. Root inspected the close-up. Images and JSON reports are adjacent. Reproduce with `PIANOMOTION_BROWSER_CHANNEL=chrome` or `msedge`, then `node node_modules/@playwright/test/cli.js test --config playwright.config.ts tests/browser/grand-highway.spec.ts`.

This is focused visual verification of the wordmark. It does not accept the concurrently modified startup, waveform or play-along behavior, or repeat full media/audio/PWA/remote CI. Serif glyph details may vary with installed system fonts outside the verified Windows browsers.

Narrow rollback: remove only `createPianoBrandingMesh` import/call from `keyboard3dView.ts` and its helper. Preserve the earlier casing/highway fixes and all concurrent user work. No storage migration or data removal is involved.
