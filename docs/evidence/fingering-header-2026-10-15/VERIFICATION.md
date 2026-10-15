# Fingering assignments in the header — verification

Date: 2026-10-15. Application version: **0.1.0-dev.3**.
Checkout: `C:\Projects\pianomotion-studio`, HEAD `dc7eb963ff793110c586b4e86129cb22282cd452`.
The existing dirty tree was preserved; no staging, commit, push or publication.

## Change

Hand, finger 1–5, Clear, Unplayable and Gliss controls now appear after the mode
switch in the top application header, only in Fingering. At widths <=1599px
the assignment group wraps into additional header rows. Undo/Redo, Step Entry
and Shortcuts retain their contextual toolbar above the scene, aligned right.
The same editor owns all callbacks: a React portal moves only the assignment
controls, preserving editor history, selection, Transport, canvas and Worker.

Root/client/contracts manifests, the workspace dependency and lockfile are
synchronized to dev.3. Musical package format v2 remains unchanged.

## Checks

| Check | Actual result |
|---|---|
| `npm run typecheck` | PASS |
| Scoped ESLint: toolbar, editor, player, shell, studio types | PASS |
| `npm run test:unit -- apps/client/src/editor/editor.test.ts apps/client/src/studio/StudioWorkspace.test.tsx` | 25 passed / 2 files |
| Chrome: editor-m4, stabilization, studio-workspace, update-save-barrier | 11 passed, 0 skipped |
| Chrome: additional responsive breakpoint check | 1 passed, 0 skipped |
| Edge: same four browser files, including extra breakpoints and final alignment | 11 passed, 0 skipped |
| Final Chrome: editor history/playback + responsive case after alignment correction | 2 passed, 0 skipped |
| `npm run build` | PASS; release `e867d9ed75160075461244c1` |
| Scoped `git diff --check` | PASS; Git emitted LF/CRLF normalization notices |
| Local dev server `http://127.0.0.1:5176/` | HTTP 200, client package version dev.3 |

Build retained the existing large-chunk advisory. Engine hash is unchanged:
`83fde5039dd70360c29aa5a3edbb07fc2f024528c76330b42bc55e195cb8fbc7`.

Browser runs were sequential, with `PIANOMOTION_BROWSER_CHANNEL=chrome` or
`msedge` and `playwright.config.ts`. The final Chrome command selected
`six responsive|unified fingering` from studio-workspace and editor-m4.

Responsive coverage: 1920x1080, 1440x900, 1366x768, 1024x768, 768x1024,
390x844; additional header boundaries at widths 320, 560, 900 and 1600
with height 900. Assertions check assignment controls inside the header and
viewport, actual pointer hit testing, no page horizontal overflow, contextual
visibility, 88 keys, framebuffer AA, persistent canvas and one analysis Worker.
Functional scenarios exercise real assignments, replan, Undo/Redo from a focused
header button, live playback, save/package/fresh context, recovery and save aborts.

Root independently inspected desktop, intermediate and mobile screenshots.
Final Edge screenshots: [1920](1920x1080-fingering.png),
[1366](1366x768-fingering.png), [390](390x844-fingering.png),
[Performance](1920x1080-performance.png).

Raw reports: [Chrome 11](chrome-ui-11.json),
[Chrome breakpoints](chrome-header-breakpoints.json),
[Edge 11](edge-ui-11.json), [final Chrome 2](chrome-final-2.json).
The earlier Chrome reports precede the last alignment-only correction; final
Edge and final Chrome reports verify that correction.

This is focused UI verification. Python/goldens, full audio/DSP, media and
production PWA suites were not rerun for this change. Their previous acceptance
and outstanding manual gates remain in the separate audit remediation record.
