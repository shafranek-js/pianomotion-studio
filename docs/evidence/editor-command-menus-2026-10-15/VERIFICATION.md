# Editor command menus and Auto-advance — 2026-10-15

Version: **0.1.0-dev.4**. Checkout: `C:\Projects\pianomotion-studio`. Scope: removal of the secondary scene toolbar, Edit/Help menus, header Auto-advance, responsive layout and shared editor history. Project format remains v2; musical algorithms and numerical expectations are unchanged.

## Automatic checks

| Check | Actual result |
|---|---|
| `npm run typecheck` | PASS; repeated after the final Escape fix |
| `npm run lint` | PASS; StudioShell scoped lint repeated after the final fix |
| `npm run test:unit` | 401 passed, 27 files |
| Editor semantic unit subset | 27 passed; includes numeric-only advance and same-finger confirmation without revision/history |
| Chrome changed UI scope | Initial 13: 11 passed, 2 failed; after fixes final focused 3/3 passed |
| Edge changed UI scope | Final 13/13 passed, no skips |
| `APP_BASE=/pianomotion-studio/ npm run build` | PASS; local buildId `811ecc641a1122adab59fff1`, 85 release resources, 30.41 MiB |
| `git diff --check` | PASS |

Machine reports: [Chrome final focused](chrome-final-3.json), [Edge final full scope](edge-final-13.json), [mobile keyboard scroll](short-window-scroll.json). Chrome's successful initial scenarios and final focused rerun are separate executions, not a claimed final full-suite run. Full audit/PWA/media/Python suites were not rerun for this UI-only change. Vite retains its existing large-chunk advisory.

## Functional evidence

- Real Pyodide Worker opens the example. Canvas, history and editor session survive Performance/Fingering changes. No visible secondary toolbar or empty reserved row remains.
- Undo/Redo share keyboard and Edit menu history. They are disabled before loading a project and outside Fingering. Help is available in both modes, including the empty state.
- Auto-advance is initially Off, appears only in Fingering and advances only for a numeric finger assignment. Hand/Clear/Unplayable/Gliss do not advance. Confirming an existing finger advances without replan, new revision or extra history.
- Modal focus blocks editing/playback shortcuts. Escape closes Help, returns focus to its trigger and leaves the previously open Projects panel open.
- Responsive checks cover 1920×1080, 1440×900, 1366×768, 1024×768, 768×1024, 390×844 and widths 320/560/900/1600 at height 900: no horizontal page overflow; header actions remain reachable. On short/narrow screens the editor retains its useful minimum height in a vertically scrollable workspace. A PageDown from the focused canvas reveals all 88 keys at 390×844.

Review found and corrected the 900 px header overflow and Escape propagation to an underlying panel. A browser test was also corrected to keep focus inside the dialog instead of triggering native Space activation of its Close button.

Visually inspected screenshots: [desktop Fingering](1920x1080-fingering.png), [1366 Fingering](1366x768-fingering.png), [phone top](390x844-fingering.png), [phone keyboard after PageDown](390x844-keyboard-after-pagedown.png), [Help dialog](shortcuts-dialog.png). [Performance](1920x1080-performance.png) is retained for comparison.

## Windows checkout and deployment boundary

The previous remote Windows Verify run `38763404607` passed Python/typecheck/lint/unit and stopped at the invalid MIDI fixture checksum before browser suites. The deliberately invalid text-like fixture is now marked `-text`; a fresh `core.autocrlf=true` checkout preserves SHA-256 `f6cc269372b52065d55bb49b1013257393ffd33b5c587f424ffa94cf9b249c5c`. Fixture bytes and goldens are unchanged.

Pages runs typecheck/lint/unit/build independently of the heavier Windows verification workflow. Check [Pages deployment](https://github.com/shafranek-js/pianomotion-studio/actions/workflows/deploy-pages.yml), [Windows verification](https://github.com/shafranek-js/pianomotion-studio/actions/workflows/verify.yml) and the live status-bar version for remote outcomes. These local checks do not claim full release, hardware/listening or load acceptance.
