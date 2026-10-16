# Built-in MIDI library — dev.6, 2026-10-16

Canonical checkout: `C:\Projects\pianomotion-studio`. Source is the user's `builtin_melodies/midi` directory only. The original MIDI files are read-only. Other notation formats and the private `soundfonts` directory are excluded from the release. Git checkout attributes preserve MIDI bytes.

## Implementation

- 162 MIDI files, 374,059 source bytes; all 162 parse through `mido` without errors (`source-inventory.json`).
- The generator creates deterministic IDs from source filenames and content-addressed assets from SHA-256. It checks headers, paths and collisions, retains exact source bytes, and avoids rewriting unchanged assets during dev startup.
- Catalog/search available from the empty workspace, File menu and Projects panel. Mobile dialog focus, Escape, retry and no-results states are supported. A shared modal-layer correction prevents the Projects sheet from intercepting catalog clicks.
- Selection uses the existing prepare/validate/commit import path, a fresh project UUID and a stable `builtin-<catalog-id>` source namespace. Existing unsaved-change decisions, project persistence, original bytes and editor history semantics remain in force.
- Production release generation embeds the catalog and all MIDI assets in the exact build's hashed offline set; no external catalog server is needed.

## Verification

Full unit suite: **454/454 across 35 files**; typecheck and lint passed. Python: **31 passed**, including all 13 frozen numerical goldens. Native Chrome parity: **15/15**, including all 13 fixtures with zero numerical differences and Worker cancellation/invalid-input checks (`parity-chrome.json`).

Chrome and Edge: **3/3 each** (`chrome-final.json`, `msedge-final.json`). Both open Brahms, play, manually edit fingering, cancel replacement of a dirty project, save/reload and import a portable JSON package in a fresh browser context with unchanged note IDs/manual finger/resource hash. Mobile checks cover search, Escape/return focus, manifest retry, damaged assets, no horizontal overflow and preservation of the current project. Megalovania opens through the actual Worker and plays past the first streaming window with all 88 keys visible. Its normalized score has 1,969 notes; observed preparation times were 12,842 ms (Chrome) and 21,312 ms (Edge), not standardized benchmarks (`browser-metrics.json`).

All **162/162** full-default Python API results pass the actual Node/TypeScript `M1AnalyzeMidiResultSchema`, with source-byte/engine checks and no schema failures (`catalog-contracts.json`). The verifier is `npm run test:catalog` and runs in CI after Python. This exposed missing source-level ambiguity warnings, source IDs leaking into normalized plan diagnostics, and identical serialized pose collisions after rounding. Those are repaired without changing expected numerical goldens. Engine: `60341216864eb0a548fbc66ba2b1848b9bb7b6b2de85c2c1e7f03fbd655bc63a`.

Initial failures are retained in `initial-ui-failures.json` and `intermediate-diagnostic-failure.json`: insufficient cold-start assertion, modal layering and earlier identity failures. They are not counted as passes. A Python-only identity invariant check was insufficient; the final acceptance uses the full shared schema.

Production offline: Chrome **2/2 at `/`** (`offline-root-chrome.json`) and **2/2 at `/pianomotion-studio/`** (`offline-pages-chrome.json`): save, close the page, go offline, restore and open an unvisited built-in melody; additionally restore a stereo Blob bank and its parser/hash Workers. Edge also passed **2/2 at `/pianomotion-studio/`** (`offline-pages-msedge.json`). Both root and project-path builds succeeded; the normal Vite warning about the large application chunk remains.

The final local project-path release is `3e3716833b02ce1fcc26085f`: **251 hash-verified resources, 32,429,129 bytes**, including every MIDI asset and no private SF2/SF3 files (`release-integrity.json`). Git index verification confirms exact bytes for all **162 MIDI files and 12 core modules** (`index-integrity.json`); MIDI attributes disable text conversion. Local dev server restored at `http://127.0.0.1:5173/`; the shell, Vite client, main module, React refresh module and catalog manifest all returned HTTP 200.

## Limits

All files are parsed; this does not mean all 162 pieces have been auditioned. The existing piano normalizer may remove percussion, repair/merge notes and follow its existing first-track tempo-map rules. For example, Megalovania's normalized duration is 304 seconds, whereas the generic merged-track `mido` inventory reports 158.609 seconds. Musical timing parity for noncanonical tempo placement was not changed or established by this catalog work. Original bytes and expected numerical goldens remain unchanged. No license is assigned to user-supplied material. Commit/push/deploy were later explicitly authorized; final live verification is independent of these local checks.
