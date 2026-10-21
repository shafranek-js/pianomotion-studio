# Code audit — PianoMotion Studio

**Date:** 2026-10-19
**Revision:** `b7d8831` (`main`), package version `0.1.0-dev.22`
**Scope:** `apps/client`, `packages/contracts`, `packages/engine-ts`, `python-core`, `tests`, `tools`, `.github`, repository hygiene
**Method:** static review of all source areas, targeted dynamic checks, and cross-checking documentation against code. Nothing was modified except git-ignored build output; the tracked tree was left clean.

## How this audit was done

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:unit` | **639 passed / 639**, 67 files, 28.3 s |
| `npm run build` | exit 0; `dist` 137.9 MiB, 500 files; main chunk 2 617 kB (819 kB gzip) |
| `npm audit` | 0 advisories (all severities) |
| Live site headers | no CSP, no `X-Frame-Options`, no `nosniff`; `Cache-Control: max-age=600` on the shell |
| Live duplicate assets | `HEAD /pyodide/pyodide.asm.wasm` → 200, `HEAD /textures/skin-realistic.png` → 200 |
| CI history | last completed `Verify studio` run: Chrome 11 failed / 36 passed, Edge 20 failed / 27 passed, 68 and 91 min |
| Python core | read end-to-end; one isolated runtime reproduction (see ENG-2) |

Confidence labels: **verified** — read end-to-end and/or reproduced; **likely** — strong static evidence, not executed; **suspected** — plausible, needs a dedicated check.

## Executive summary

The codebase is stronger than its red CI badge suggests. The numerical core is deterministic and pinned by golden fixtures, the service worker is engineered rather than improvised, contracts perform real validation, and the unit suite is genuine. Dependency risk is zero.

The problems cluster in five areas:

1. **Release engineering.** Deployment is not gated on the suite that fails, the deployed site ships every asset twice (138 MiB instead of 71 MiB), and it carries none of the security headers the repository defines.
2. **CI.** The browser suite fails on `main` on both channels, takes 68–91 minutes, and its configuration — 5 s `expect` timeout against a 40 MiB SoundFont load, UI tests against a dev server, dev-only `/@fs/` harnesses, zero retries, no traces — explains most of the failures without a product regression.
3. **Engine edge cases.** A schema-valid pianist profile with `max_speed: 0` crashes analysis; the exported-MIDI fingering count is computed from a set of array indices; raw MIDI notes outside A0–C8 are produced by the engine but rejected by its own contract.
4. **Client lifecycle.** A corrupt stored record can hang `getProject` forever, a superseded open can leave the UI permanently busy, and the last ≤400 ms of edits are not flushed on `pagehide`.
5. **Licensing.** The fingering engine derives from an upstream project published without a licence; the bundled MIDI library has no recorded provenance.

| Severity | Count | Where |
|---|---|---|
| High | 6 | DEP-1, DEP-2, DEP-3, CI-1, ENG-1, ENG-2 |
| Medium | 35 | release determinism, contracts, client lifecycle, caches, documentation |
| Low | 11 numbered, plus 8 grouped in ENG-14 | cosmetic bugs, robustness, hygiene |
| Info | 2 | SEC-8, SEC-9 |

Two findings deserve emphasis beyond their severity: the missing security headers matter because the app stores entire user projects in IndexedDB, and the export counting bug is user-visible in a feature the README advertises.

---

## 1. Deployment and release

### DEP-1 · High · verified — deployment is not gated on the failing suite

`deploy-pages.yml` runs `typecheck`, `lint`, `test:unit` and `build`; it does **not** run Python tests, catalogue checks, native parity, or any browser suite. On 2026-10-18, commit `9deca23` produced `Deploy GitHub Pages: success` while `Verify studio: failure`.

Impact: `main` both publishes and fails verification. Any regression the browser or parity suites would catch ships unchallenged.

Fix: `workflow_run` on `Verify studio` with `conclusion == success`, or a single workflow where `deploy` `needs` the verify job. Add `timeout-minutes` to both jobs.

### DEP-2 · High · verified — the deployed site has no security headers

`apps/client/public/_headers` defines a CSP, `X-Frame-Options: DENY`, `nosniff` and cache rules. GitHub Pages ignores `_headers`. `index.html` has no `<meta http-equiv="Content-Security-Policy">` fallback, and the release copy of `_headers` is not in the offline manifest.

The headers of the live document:

```text
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: max-age=600
Server: GitHub.com
… no Content-Security-Policy, no X-Frame-Options, no X-Content-Type-Options, no Referrer-Policy
```

A second problem hides inside the policy itself: its paths refer to `/assets/*` and `/pyodide/*`, while the app actually serves `releases/<buildId>/assets/*`. Even on a host that honours `_headers`, the cache rules would not match the deployed paths.

Impact: no containment for a future XSS or a compromised dependency. `connect-src` is unconstrained, so any script in the page can read the IndexedDB project store (MIDI bytes, recordings, profiles) and send it anywhere. Clickjacking is not blocked either, though destructive actions use native `confirm()`.

Fix: publish through a host that honours `_headers` (Cloudflare Pages, Netlify), or add a meta CSP to `index.html`; correct the paths to the release directory. Keep `'wasm-unsafe-eval'` and `blob:` — Pyodide requires them; the meaningful gains are `connect-src`, `object-src`, `base-uri` and `frame-ancestors`.

### DEP-3 · High · verified — every static asset is deployed twice

Vite copies `public/` to the dist root; `tools/build-release.mjs:214-226` then copies the same tree into `releases/<buildId>/`. Nothing removes the root copies, and `generateOfflineManifest()` lists only the release copies.

Measured on a fresh build:

```text
dist total            137.9 MiB, 500 files
  releases/<id>/       70.7 MiB, 257 files   ← what the app loads
  soundfonts/          38.1 MiB              ← duplicate
  pyodide/             21.4 MiB              ← duplicate
  textures/             6.7 MiB              ← duplicate
  models/, builtin-melodies/, icons/, python-core/, m1-fixtures/
```

The duplicates are published: the live site answers 200 for `/pyodide/pyodide.asm.wasm` and `/textures/skin-realistic.png`, while no `apps/client/src` file references those root paths.

Impact: double upload and storage, slower deploys, and root assets that are never invalidated and can serve stale bytes forever.

Fix: after `moveViteAssetsToRelease`, delete from `dist` every public entry except `sw.js`, `offline-manifest.json`, `_headers`, `manifest.webmanifest`, `index.html`.

### DEP-4 · Medium · verified — HTML caching contradicts the deployment assumptions

`_headers` requests `no-store` for `/index.html` and `/sw.js`; GitHub Pages serves the shell with `max-age=600`. A deploy can therefore leave a first-time visitor for up to ten minutes with an `index.html` that points at a release directory which no longer exists (the build emits only the current release).

Fix: same as DEP-2, or a tiny inline bootstrap in `index.html` that detects a missing release asset and reloads once with a cache-busting query.

### DEP-5 · Medium · verified (code) / likely (CI consequence) — the build ID depends on line endings

`tools/build-release.mjs:111-124` hashes `readFile()` of every input — sources, `public/`, `python-core`, `package.json`, `package-lock.json` — with no normalisation. On Windows with `core.autocrlf` the working tree has CRLF; on an Ubuntu runner it has LF. The same commit produces different bytes, hence different `buildId`s.

Impact: the "content-addressed" promise holds only per OS; a build verified on Windows is not the build published from Linux, and the service worker sees a new release for identical content after any re-deploy from a different platform.

Fix: normalise CRLF to LF before hashing (or hash `git cat-file blob` output), and add `* text=auto eol=lf` to `.gitattributes`.

### DEP-6 · Medium · verified — the offline manifest degrades silently

`tools/generate-offline-manifest.mjs:56-76` wraps the `engineVersion` and `runtimeVersion` lookups in `catch {}` and falls back to `"unknown"`; nothing verifies that the required Pyodide runtime, wheels, SoundFont and `python-core` files are present. `build-release.mjs` calls only the melody and SoundFont preparation, relying on npm's `prebuild` hook for Pyodide — so a direct `node tools/build-release.mjs` (which the offline PWA spec does) can produce a manifest for a release without the Python engine.

Impact: a Python-less release passes the build and produces a service worker that caches a broken offline app; the TypeScript engine masks the problem until a user selects Python.

Fix: assert a required asset set before writing the manifest (fail the build otherwise), and build into a staging directory that is renamed atomically.

### DEP-7 · Medium · verified — every build dirties a tracked file

`npm run dev` and `npm run build` rewrite `python-core/handthesia_core/source_manifest.json`. With `core.autocrlf` the checked-out file has CRLF and the generator writes LF, so `git status` reports a modification while `git diff` is empty. Reproduced twice here and restored with `git checkout --`.

Fix: add the file to `.gitattributes` with `text eol=lf`, or stop tracking the generated manifest.

---

## 2. CI and tests

### CI-1 · High · verified — the browser suite is flaky, slow, and explains itself

Last completed run (`39161074876`, commit `9deca23`):

| Channel | Result | Browser step duration |
|---|---|---|
| Chrome | 36 passed, 11 failed | 68 min |
| Edge | 27 passed, 20 failed | 91 min |

Same commit, different failure counts per channel — environment sensitivity, not a deterministic break. Failures are locator/timeout errors in four heavy specs. The configuration explains them:

- **No `expect` timeout in any of the six configs.** Playwright's default is 5 s. `skins-audio-m6.spec.ts:87` waits for the exact text `Active output: MuseScore General v0.2`, which appears only after a 38 MiB SF3 is fetched, hashed twice, parsed and prepared; until then the UI says `Preparing selected output…` (`PianoPlayer.tsx:1852`).
- **UI tests run against `npm run dev`** (`playwright.config.ts:19`), not the production bundle, so Vite transforms on the fly and the dev optimizer runs cold.
- **`stage-environment.spec.ts:72` loads a `/@fs/` harness**, available only in dev, and initialises WebGL with a 30 s `waitForFunction` inside a 90 s test — on software rendering this is a timeout.
- **`practice-stage2.spec.ts` depends on wall-clock behaviour** (`waitForTimeout(50)`, 20 s loop windows, 180/160 ms pause checks) while `retries: 0` and `workers: 1` are configured.
- **Nothing to diagnose with**: no `trace`, `screenshot` or `video`, and only `list` + `json` reporters, so `playwright-report/` — uploaded by `verify.yml:49` — is never generated.

Impact: the only gate is red on `main`, and the feedback loop is over an hour.

Fix, in order: `expect: { timeout: 15_000 }`; `retries: 1` and `trace: "on-first-retry"` for CI; run UI against `vite preview` on the already-built `dist`; split the six groups into parallel jobs; replace the 38 MiB SoundFont default in UI tests with the synth (`output: "synth"`) and wait on `__playerSnapshot` state rather than on text; move GPU-heavy specs to their own longer-timeout job.

### CI-2 · Medium · verified — `tests/` is neither type-checked nor linted

`npm run typecheck` covers `apps/client`, `packages/contracts`, `packages/engine-ts` and `tsconfig.tools.json`; `npm run lint` covers configs, `tools` and those packages. The 8.7k-line `tests/` tree is excluded from both, and the only `tests` tsconfig (`tests/browser/r3d/tsconfig.json`) is invoked by nothing.

Impact: helper drift and typing errors surface only when a spec runs — or never, for skipped specs. "typecheck PASS" says nothing about the tests.

Fix: add a `tests/tsconfig.json` and include `tests` in lint and `npm run ci`.

### CI-3 · Medium · verified — permanent skips hide missing capability

`soundfont-user-banks.spec.ts:265,312` skip when no local banks are found (always, in CI); `soundfont-large.spec.ts:188-189` skips without `PIANOMOTION_TEST_SF2`; `soundfont-stereo.spec.ts:479-484` skips at the end when WebCodecs is unavailable. `tests/browser/README.md` describes them differently.

Impact: "CI green" coexists with untested release-critical paths — including video export, which the README already flags as unaccepted.

Fix: separate CI and local-only groups explicitly; make capability-dependent skips fail in the release group.

### CI-4 · Medium · verified — the archive script is not a clean archive

`tools/archive-web.ps1` excludes `node_modules`, `test-results`, `playwright-report`, `__pycache__`, `.pytest_cache`, `*.pyc`, `.vite-temp` and `*.zip` — but not `.git` (93 MiB), `dist`, `scratch/`, `soundfonts/` or `docs/evidence` (60 MiB of screenshots). It writes directly to the target path with no temp+rename and no post-write verification, and deletes an existing archive first.

Impact: the "source-only" archive carries repository history and local banks; an interrupted run leaves a truncated zip.

Fix: add the missing excludes, write to a temporary file, verify the entry count, then rename.

### CI-5 · Medium · verified — repository weight and ignore drift

126 MiB of tracked content: `docs/` 74 MiB (mirrored `chrome/` and `edge/` screenshots), `assets/soundfonts` 38 MiB. `.git` is 93 MiB. No Git LFS. `.gitignore` lacks `playwright-report/` and `*.log`.

Fix: cache one canonical screenshot set per feature, move historical evidence to release artifacts, add LFS for the SF3 and large PNGs, extend `.gitignore`.

### CI-6 · Low · verified — the CI driver can hang

`tools/ci-verify.mjs:61-77` resolves on `close` but never listens for `error`. If a command cannot be spawned, the promise never settles and the job waits for its timeout.

Fix: `child.once("error", …)` → non-zero result.

### CI-7 · Low · verified — manual exclusion list

`playwright.config.ts:5` excludes 19 specs by filename; the other five configs re-include subsets. A new heavy spec runs in the UI group unless someone remembers to update the list.

Fix: use `testMatch` per config.

### CI-8 · Low · verified — stale evidence upload

`verify.yml` uploads `docs/evidence/audit-repair-2026-10-15/`, a snapshot from three weeks earlier and identical on every run, plus a `playwright-report/` directory that no reporter produces.

---

## 3. Engine and contracts

### ENG-1 · High · verified — a schema-valid profile crashes analysis

Chain, read end-to-end and reproduced in isolation:

1. `packages/contracts` models `PianistProfile.behavior` as `z.record(z.union([finite, string, boolean]))` — any finite number, no range (`contracts/src/index.ts:486-498`).
2. `pianist.from_profile_dto` copies `behavior` verbatim (`pianist.py:375-391`); unlike `Pianist.from_json`, which clamps to the spec (`pianist.py:312-318`), there is no validation.
3. `fingering._apply_preferences` sets `MAX_SPEED = float(p.b("max_speed"))` (`fingering.py:411`).
4. `travel_time` divides by `(max_speed or MAX_SPEED)` (`fingering.py:78-80`).

With `behavior.max_speed = 0`, step 3 sets `MAX_SPEED = 0` and step 4 divides by zero:

```text
>>> MAX_SPEED = 0.0; travel_time(1.0)
ZeroDivisionError: float division by zero
```

`max_speed: -5` silently disables the speed limit; `smoothness: 1e9` was reported by the reviewer to produce an effectively unbounded loop in the hand smoother.

Impact: a profile accepted by the client contract aborts `analyze`/`replan` with an internal error (or hangs the worker), and the failure surfaces as a generic 500 rather than a validation message.

Fix: validate `behavior` against `pianist.BEHAVIOR` (type, min, max, enum) in `_resolve_profile`, clamp in `from_profile_dto` as `from_json` already does, and defensively use `max(0.1, speed)` in `travel_time`/`_gliss_schedule`.

### ENG-2 · High · verified — the exported-MIDI fingering count is computed from array indices

`packages/engine-ts/src/midiLoader.ts:636`:

```ts
marked.add(index.get(`${m[1]!}:${Math.round(toSec(t) * 1000)}`)?.indexOf(n) ?? 0);
```

`index` maps a pitch/time key to an array of candidate notes; `indexOf(n)` is that note's position in the bucket. The set therefore collects small integers (positions, usually 0), not note identities. For a 22-note file the reviewer measured `markedCount = 1`; the UI reports "Exported 1 fingered notes" (`PianoPlayer.tsx:1813`).

Impact: the export result lies to the user about how much fingering was written, and a partial export (ENG-3) looks successful.

Fix: count distinct notes actually written (`noteId`/object identity), or count emitted text events and compare with playable assignments.

### ENG-3 · Medium · likely — unmatched notes are dropped silently on export

`midiLoader.ts:614-616` skips a document note whose `(pitch, time)` does not resolve, and the export still returns success. The reviewer produced 21 of 22 markers from a document shifted by 0.02 s — a schema-valid document.

Impact: partial fingering is silently lost on export; nothing reports the unmatched count.

Fix: collect unmatched note ids and fail or return a diagnostic; assert `markedCount` against playable assignments.

### ENG-4 · Medium · verified — the export request is the only unvalidated engine message

`M1ExportMidiRequestSchema` (`contracts/src/index.ts:1045`) is a plain object of `midiBytes`, `document` and `fingeringPlan`. Unlike `M1ReplanDocumentRequestSchema`, it has no cross-field refinement: a plan from another project or revision, or with assignments to unknown note ids, passes validation.

Impact: the contract guarantees that "a response is applied only for the matching request" do not hold for export; a client bug could export fingers from a stale plan.

Fix: add `fingeringPlanForSong(document)` plus project/revision/engine equality checks, mirroring the replan schema.

### ENG-5 · Medium · verified — the TypeScript engine ignores hand anatomy when splitting hands

`handSplit.ts:377-388` reads `pianist.anatomy["hand_span"]`, a key that does not exist in `DEFAULT_ANATOMY` (which has `mc*/pp*/mp*/dp*` measurements). `k` therefore stays `1.0` for every profile. Python computes the ratio from `hand_span_inches(pianist.anatomy) / hand_span_inches(None)` (`hand_split.py:322-326`).

Impact: for a large- or small-handed profile the TypeScript engine splits hands and plans fingering with default spans, while Python uses the real ones — a parity gap exactly where custom profiles are supposed to matter.

Fix: port `hand_span_inches` ratio.

### ENG-6 · Medium · verified — the raw-pitch contract rejects notes the engine itself produces

`M1RawSourceNoteSchema.pitch` is `min(21).max(108)` (`contracts/src/index.ts:34`), but `identity.ts:289` records `Math.floor(note.pitch)` from the parsed MIDI, i.e. 0–127, and `midiLoader` folds only the normalised notes into A0–C8.

Impact: a valid MIDI containing a note outside the 88-key range yields `status: "loaded"` from the engine and then fails the client's request-aware validation — an import error for a file the pipeline handled correctly.

Fix: allow 0–127 for raw source notes (keep 21–108 for normalised notes), or filter consistently and record what was dropped.

### ENG-7 · Medium · verified — `@ts-nocheck` hides real bugs

Two files opt out of the strict config: `api.ts` (1 086 lines) and `hands.ts` (4 382 lines) — 5 468 lines, about a third of the engine. What it hides:

- `api.ts:108` and `api.ts:749` call `', '.join(missing)` on a JavaScript array (Python-ism). A missing profile field raises `TypeError: join is not a function` instead of the intended `ValueError`. The correct form appears at `api.ts:356` (`missing.join(', ')`).
- `hands.ts:343` calls `time.perf_counter()`, which does not exist in TypeScript. The affected public entry points (`prepare_hands`, `HandAnimator.prepare`) are currently unreachable, so the bug is latent rather than live.

Impact: error paths become confusing crashes; the type checker cannot protect the most delicate numeric code.

Fix: remove `@ts-nocheck` from `api.ts` first (narrower surface), fix the discovered errors, add an error-count ratchet in CI.

### ENG-8 · Medium · verified — cache eviction in the TypeScript hand solver is dead code

`hands.ts:1438` (and 2 880, plus five more sites) does `if (cache.length > 20000) { pyClear(cache) }`, but the caches are plain objects created as `{}` (`hands.ts:386`, `:2217`). `undefined > 20000` is false, so the eviction never runs; the Python original checks `len(cache) > N` and does evict.

Impact: pose caches grow for the whole song. Bounded by song length (the animator is recreated per revision), but on long dense pieces this is tens of megabytes of retained objects in the worker.

Fix: `Object.keys(cache).length`, or use `Map` and its `size`.

### ENG-9 · Medium · likely — copying caches are cleared wholesale, which perturbs poses

Python clears the smoothing caches when they exceed a threshold (`hands.py:1590-1615`, `:2623-2643`). The per-step limiter reads the previous entry (`prev = cache.get(j)`); after a clear, the first ~30 steps (≈0.5 s) run without a speed limit, and the idle-drift history is lost.

Impact: a pose at time `t` depends on what was computed before, so `rawBaseline.selectedPoses` and `initialMotionWindow.poses` — computed in the same response — can disagree at the same `t`; long dense pieces can show a hand snap.

Fix: bounded LRU with deterministic eviction and a fixed lookback instead of `clear()`.

### ENG-10 · Medium · verified — profile state is not fully restored between jobs

`reset_context(p)` sets `_applied = None` and clears `W`, `MAX_SPAN`, `REACH_SCALE`, then calls `apply_pianist(p)` (`fingering.py:393-404`). For `p is None`, `apply_pianist` computes `key = None`, compares it with `_applied` (`None`) and returns immediately (`fingering.py:355-367`) — before restoring `figures.PREFS`, `FINGER_STRENGTH`, `BLACK_EASE`, `RELAXED` or `MAX_SPEED`.

Impact: after a job with a custom pianist, a default-profile job inherits that pianist's figure preferences and finger strengths. `TUNE_DEFAULTS` also stays stale.

Fix: use a unique sentinel instead of `None` for "not applied", or restore the baseline explicitly before the early return.

### ENG-11 · Medium · verified — the animator session cache is single-slot and under-keyed

`python-core/handthesia_core/api.py:16-22` keeps exactly one session, cleared on every store; the key is `(projectId, revision, profileId)` without `profileRevision`, `keyStyle` or geometry, and there is no TTL.

Impact: (a) a motion-window request for another open project or revision raises "No active animator session …"; (b) changing keyboard style returns poses computed under the old style, including rolled-chord decisions; (c) the session retains the song and per-hand caches until the next analysis.

Fix: small LRU keyed by project, revision, profile revision, key style and geometry hash; TTL eviction.

### ENG-12 · Medium · likely — quadratic identity scans in the Python API

`api.py:872` and `:1058-1061` call `source_ids_for([note_id], document_notes)` per source note, scanning all document notes each time. The reviewer measured ~3 s at 10k notes and ~11 s at 20k for the scan alone; the comprehension also shadows `note_id` internally, which happens to work only because the result is used as a length.

Fix: build `noteId → count` once; rewrite `source_ids_for` with an index and without shadowing.

### ENG-13 · Medium · verified — marker parsing can silently erase manual fingering

`midi_loader.read_markers` and the marks loader swallow every exception into `{}` (`midi_loader.py:318-336`), with no entry in `song.cleanup` and no diagnostic.

Impact: a file with hand/finger annotations whose track metadata trips the parser loses all manual fingering without a word; the planner then re-fingers the piece.

Fix: catch specific exceptions, surface the rest as `cleanup`/diagnostics.

### ENG-14 · Low/Medium · verified — several smaller engine defects

| ID | Location | Problem |
|---|---|---|
| ENG-14a | `api.py:160-165` | Source↔normalised fallback matches only by time (±0.005 s), ignoring pitch; can attach a raw note to a different pitch after `_fit_to_piano`. |
| ENG-14b | `hand_split.py:322-326` | Any exception while importing `hands.hand_span_inches` silently falls back to average spans. |
| ENG-14c | `api.py:275-287` | `_dedupe_serialized_motion_poses` throws if two sample times collide after 8-digit rounding; a client sending times <5e-9 apart fails the whole analysis. |
| ENG-14d | `hands.py:1933-1949` | Wide chords are rolled with a fixed step; only the top note is clamped to the next chord, so low notes can sound after it. |
| ENG-14e | `midi_loader.py:346-349` | SMPTE `fps = -(division >> 8)` is off by one when `tpf > 0` (25 → 26); suspected, depends on `pretty_midi` accepting SMPTE. |
| ENG-14f | `midi_loader.py:224-233` | Any 2-byte text `[FRL][1-5]` is treated as fingering, and pending markers are not reset by intervening events; lyrics such as "R1" would be honoured. |
| ENG-14g | `api.ts:151` | Identity comparator sorts arrays as strings; with duplicate signatures TypeScript picks a different primary note than Python. |
| ENG-14h | `cli`/`api.ts:229-231` | `_same_json` uses a 1e-7 tolerance where Python compares exactly. |

---

## 4. Client runtime

### CLI-1 · Medium · verified — a corrupt stored record can hang the app

`getProject` validates the record inside `request.onsuccess` (`projectDb.ts:408-411`):

```ts
request.onsuccess = () => {
  const result = request.result as SavedProject | undefined;
  resolve(result ? validateSavedProject(result) : null);
};
```

If `validateSavedProject` throws, the exception escapes the callback and `resolve` is never called — the promise stays pending forever. The same file's `request.onblocked` only logs a warning (`projectDb.ts:313-315`), so a blocked upgrade (another tab holding the old version) also never settles.

Impact: opening a project stored by an older or partially written version, or upgrading while another tab is open, freezes the open flow and the project list with no error and no timeout.

Fix: wrap the success handler in `try/catch` and reject; reject or time out `onblocked`; add a timeout around the open promise.

### CLI-2 · Medium · verified — the UI can stay permanently busy

`runCandidate` sets `busy` (`App.tsx:371`) and clears it in `finally` only if its operation is still current (`:407-412`). `openSavedProject` starts a **new** operation (`:525`), invalidating the running one, and can then take an early exit — no project, legacy project without geometry — calling `finish(operation)` without ever calling `runCandidate` (`:530-537`). The superseded operation will not clear `busy`; the new one never set it.

Impact: clicking a saved project during an analysis can leave Save, Play and the rail disabled until the page is reloaded (or the developer Cancel button is found).

Fix: make pending state operation-scoped — clear `busy` in every terminal path of the new operation, or derive it from the lifecycle object.

### CLI-3 · Medium · verified — the last edits are not flushed when the page closes

`AutosaveService` debounces for 400 ms (`autosave.ts:474-482`); `PianoPlayer`'s cleanup does not flush, and the only `pagehide`/`visibilitychange` listeners in the client belong to the diagnostics log (`eventLog.ts:126,130`). The agent's `flush()` exists (`autosave.ts:487`).

Impact: closing or backgrounding the tab within the debounce window loses the last edit, and background throttling widens that window. View state and practice state go with it.

Fix: `flush()` on `visibilitychange: hidden` and `pagehide`; flush in the player's unmount cleanup.

### CLI-4 · Medium · verified — startup failures are sticky

`startupRuntimePromiseRef` is created once; if it rejects, the reference is not reset (`App.tsx:186-208,377`), so every later attempt reuses the rejected promise. `PianoScene.create` does not destroy its `Application` if initialisation throws (`pianoScene.ts:230-259`) and has no WebGL context-loss handling.

Impact: one transient failure of the startup manifest or of WebGL leaves the studio unusable until reload, possibly with a leaked renderer.

Fix: reset the promise on failure; `try/finally` around scene creation; listen for `webglcontextlost` and offer retry.

### CLI-5 · Medium · likely — package import/export blocks the main thread

`packageExporter.ts` builds and parses base64 character by character (`:33-47`), verifies payload hashes in pure JS (`:107-137`), validates the package more than once during import (`:214-264`), and parses legacy packages twice.

Impact: multi-second freezes and memory spikes on 16–32 MiB packages.

Fix: validate once, use `crypto.subtle.digest` (already used elsewhere), stream or zip resources.

### CLI-6 · Medium · verified — autosave does redundant work

Each autosave stringifies the document twice and hashes the same MIDI bytes twice (`autosave.ts:136-179,197-219`), and rewrites the full `rawMidiBytes`; `listProjects` reads `getAll()` with full records (`projectDb.ts:426-456`).

Impact: on a 16 MiB project this repeats every 400 ms while editing; the projects panel loads every MIDI blob into memory.

Fix: cache the digest and the serialized descriptor, store bytes once, add a summary store for listings.

### CLI-7 · Medium · suspected — imported audio is session-only but presented as saved

The audio recording and its offset are not part of `SavedProject`, `SessionSnapshot` or the project package (`PianoPlayer.tsx:1628-1667`), and the handler does not mark the project modified. After reload the recording silently disappears while the status can still read "saved".

Fix: persist the recording as a project resource, or mark it clearly as session-only and dirty.

### CLI-8 · Medium · verified — deleting the active project leaves recovery behind

`ProjectsPanel.tsx:55-65` deletes the project row only; the session snapshot and the open player keep referencing the `projectId`.

Impact: after reload, the deleted project is restored from recovery and can be saved again.

Fix: block deletion of the active project, or clear the session snapshot and close the player.

### CLI-9 · Medium · verified — export jobs survive the project switch

`PianoPlayer.tsx:1766-1817` starts a worker job for MIDI/package export without an unmount or generation guard; `terminate()` leaves `runWorkerJob` pending until the 180 s timeout (`workerJob.ts:39`), after which its catch writes a status for the old project.

Fix: abort on unmount and check the generation before writing status or triggering a download.

### CLI-10 · Medium · verified — Web MIDI permission is requested at mount

`webMidiInput.ts:37-63` calls `requestMIDIAccess()` from the player's mount and on entering Play Along, without a user gesture; on refusal it records `prompt` rather than `denied`.

Impact: an unexpected permission prompt on opening a project, repeated silent failures afterwards, and no explanation in the UI.

Fix: request only from an explicit "Connect MIDI" action, store `denied`, and surface the reason.

### CLI-11 · Medium · verified — Play Along resets position on every replan

The `PlayAlongEngine` is recreated whenever `analysis`/`draftPlan` changes and `start()` seeks to the first eligible step (`PianoPlayer.tsx:1156-1274`).

Impact: changing the profile or keyboard geometry during practice jumps the user back to the start of the loop.

Fix: preserve the current step/time across rebuilds.

### CLI-12 · Medium · verified — production test hooks

Three globals are written unconditionally: `__m1LastResult`, `__m1LastError` (`App.tsx:262-263`, `:306-307`, …) and `__playerSnapshot` (`PianoPlayer.tsx:1477-1490`). The first holds the complete analysis result; the snapshot is rebuilt every 70 ms and includes the 88-key geometry and selected notes. The browser suite depends on them (202 references), including preview and offline builds.

Impact: the whole project is readable from the page global scope — in combination with DEP-2 that is a direct path to user data — and the snapshot allocates continuously during playback.

Fix: gate behind an E2E build flag, and keep the snapshot as a mutable ref updated in place rather than re-created by an effect.

### CLI-13 · Medium · verified — playback re-renders the tree ~14 times per second

`PianoPlayer` calls `setCurrentTime` every 70 ms during playback (`PianoPlayer.tsx:1413-1418`); `PianoPlayer`, `StudioShell`, `FingeringEditor` and `PracticePanel` are not memoised, and `getSettings()` clones settings on each render.

Impact: reconciliation of the whole studio at 14 Hz while playing, including the 3D shell; jank on weak hardware.

Fix: move transport time into an external store consumed only by the transport UI, memoise the shell and panels, read settings once.

### CLI-14 · Low · verified — unfinished i18n and focus handling

`StudioTransport.tsx`, `StudioInspector.tsx` and `PracticePanel.tsx` still contain hardcoded English text and `aria-label`s while the app ships six locales; renaming a bookmark returns focus to `<body>`.

Fix: move the strings to dictionaries and restore focus to the rename button.

---

## 5. Security

The external attack surface is small: no backend, no requests outside the app's own origin, no secrets, no dangerous install scripts, and the only `postinstall` entry is the macOS-only `fsevents`. Import validation is genuinely careful — `strictObject` schemas, `__proto__`/`constructor` blockers in both the JSON reviver and a recursive check, safe resource paths, SHA-256 per package resource, size limits, and bounds checks in the SF2 and Ogg parsers. No DOM XSS sink (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`) exists.

What remains:

### SEC-1 · Medium — same as DEP-2

Missing CSP, `nosniff` and frame protection in production. This is the one finding that converts every future injection bug into a data-exfiltration path.

### SEC-2 · Low · verified — the intended CSP is weak

Even where honoured, the policy allows `script-src 'self' blob: 'unsafe-eval'` and `style-src 'unsafe-inline'`, and omits `frame-ancestors`, `form-action`, `frame-src` and `base-uri` (it has `base-uri 'self'`, but not the others). `blob:` in `script-src` exists because the Signalsmith worklet is loaded from a blob; `unsafe-eval` is required by Pyodide.

Fix: ship the worklet as a real file, verify whether `unsafe-eval` is still needed with modern Pyodide, add the missing directives.

### SEC-3 · Low · verified — the Pyodide runtime is not hash-verified

`asset-manifest.json` lists SHA-256 for `pyodide.asm.wasm` (9.6 MiB), `pyodide.mjs`, `python_stdlib.zip` and `pyodide-lock.json`, but `initializeRuntime` uses only `runtime` and `purePythonWheels` (`midi-analysis.worker.ts:500-521`). The runtime version string is checked, the wheels are verified byte-for-byte, and every `python-core` file is verified against the manifest (`:561-573`) — but the wasm and JS runtime files are loaded without comparing their hashes.

Impact: a compromised or partially updated static deployment could run arbitrary wasm/JS in the analysis worker, with access to IndexedDB and the network.

Fix: verify `files[]` hashes before `loadPyodide`, loading `pyodide.mjs` from a verified blob.

### SEC-4 · Low · verified — the service worker does not check message senders

`sw.js:289-304` accepts `SKIP_WAITING`, `PIN_BUILD` and `GET_BUILD_ID` from any client in scope; only `event.source.id` is used.

Impact: a same-origin frame or script can force activation or pin a client to an older build. Low, given no framing protection exists yet.

Fix: validate `event.source`/its URL against the scope.

### SEC-5 · Low · verified — there is no revoke path for a bad release

Navigation always serves the shell of the running build; two builds are retained plus pinned clients (`sw.js:306-362`). After a bad release, clients keep it until they update; caches from other scope prefixes are never cleaned.

Fix: honour a minimum-version/kill-switch record, add a TTL for old caches, clean `pianomotion-*` with foreign scope prefixes.

### SEC-6 · Low · verified — unbounded fields in the document contract

`SongDocument.title` is `z.string()` with no maximum (`contracts/src/index.ts:360`), and note/track/tempo arrays have no upper bounds. The package JSON limit allows 64 MiB (`packageExporter.ts:406`) while the file limit is 32 MiB.

Impact: a hostile package can freeze the UI with a huge title or an enormous note list without exceeding the file limit.

Fix: `.max()` on the title and arrays; align the two limits.

### SEC-7 · Low · likely — decoded audio and sample buffers are unbounded

`audioDecoder.ts:96-148` limits the compressed file to 100 MiB but not the decoded duration, and duplicates the buffer with `slice(0)`. `soundfontSampleProvider.ts:350` allocates `createBuffer(1, frames)` from the sample header with no per-sample cap.

Impact: a long FLAC or a crafted bank can exhaust tab memory (self-DoS).

Fix: cap decoded duration/samples and per-sample frames, and enforce the 256 MiB decode budget.

### SEC-8 · Info — integrity chains do not authenticate the origin

The manifest arrives from the same origin as the worker that validates it, and the `buildId` comes from `sw.js`. This detects partial or corrupted deployments, not a compromised origin. Worth stating explicitly in the architecture docs so nobody over-trusts the chain.

### SEC-9 · Info — fixture manifest and diagnostics

`m1-fixtures/manifest.json` is parsed without a schema and its `fixturePath` goes into a URL (`App.tsx:187-195,471`); only same-origin content can exploit it, and payloads are then hashed. Diagnostics store file names, paths and stack traces in `localStorage` and export them as JSON (`eventLog.ts:16-35,142`) — worth redacting if logs are ever shared publicly.

---

## 6. What is done well

- **The service worker is engineered.** Manifest validation (schema version, build id, safe paths, duplicates, hashes), staging into a temporary cache, per-file size and SHA-256 checks, an atomic commit record as the final write, retention of the current and previous builds, and per-client pinning (`sw.js:59-269`).
- **Contracts validate meaning, not just shape.** Cross-field refinements for plan identity, note references, dispositions, pedal derivation and stale revisions (`packages/contracts`), with 2 test files covering the semantic cases.
- **Numerical work is pinned.** 13 fixtures, documented tolerances (0.001 s, 0.01 white key, 0.001 rad), and a parity command that fails on any difference.
- **Cancellation is designed in**: `AbortSignal` through the open path, request identity checks, generation counters for motion windows.
- **Import hardening**: prototype-pollution guards on both JSON paths, safe resource paths, per-resource SHA-256, explicit 16/32/100 MiB and 1 GiB limits.
- **No `eval`, no `innerHTML`, no `Math.random`, no skipped-without-reason tests, no `TODO`/`FIXME` markers anywhere.**
- **The unit suite passes locally**: 67 files, 639 tests, 28 s; typecheck and lint are clean.

---

## 7. Recommended plan

**P0 — before the next public release**

1. Gate deployment on a green verify run (DEP-1).
2. Stop shipping assets twice (DEP-3) — halves the site.
3. Settle the header story (DEP-2, DEP-4): move to a header-aware host or add a meta CSP; fix the `_headers` paths either way.
4. Fix the profile validation chain (ENG-1) — a valid profile must not crash analysis.
5. Normalise build input hashes (DEP-5) and require the Python assets in the manifest (DEP-6).

**P1 — next iteration**

6. Make the browser suite usable (CI-1): `expect` timeout, retries, traces, preview instead of dev, parallel groups, synth instead of the 38 MiB bank in UI tests.
7. Fix the export count and partial-export silence (ENG-2, ENG-3) and validate the export request (ENG-4).
8. Fix `getProject` and the busy lifecycle (CLI-1, CLI-2) and flush autosave on `pagehide` (CLI-3).
9. Start removing `@ts-nocheck` (ENG-7), beginning with `api.ts`.
10. Type-check and lint `tests/` (CI-2); make capability skips explicit (CI-3).

**P2 — cleanup**

11. Engine parity items: hand-span ratio (ENG-5), raw pitch range (ENG-6), cache eviction (ENG-8), profile restoration (ENG-10), session cache (ENG-11), quadratic scans (ENG-12).
12. Client: startup recovery (CLI-4), package I/O cost (CLI-5), autosave cost (CLI-6), audio persistence (CLI-7), deletion semantics (CLI-8), export guards (CLI-9), Web MIDI gesture (CLI-10), Play Along state (CLI-11), test-hook gating (CLI-12), render frequency (CLI-13).
13. Security hardening: runtime hashes (SEC-3), sender checks (SEC-4), kill switch (SEC-5), array/title limits (SEC-6), decoded-size caps (SEC-7).
14. Repository hygiene (CI-4, CI-5) and documentation drift (DOC-1).
15. Resolve the upstream licensing question (DOC-2).

---

## 8. Documentation and licensing

### DOC-1 · Medium · verified — documentation describes behaviour that no longer exists

- `docs/USER_GUIDE.md` promises drag-and-drop MIDI import and a MediaRecorder → WebM export. The client has no `drop`/`dragover` handlers; export uses WebCodecs + Mediabunny and fails without `VideoEncoder`. It lists four hand skins; the UI has five.
- `docs/ROLLBACK.md` opens with "Current local implementation: 2026-10-16, dev.6" and contains a mojibake em dash (`â€”`), evidence of a wrong-encoding save at some point.
- `tests/fixtures/README.md:3` links to `tools/generate_desktop_baseline.py`, which does not exist.
- The same desktop commit `f8189c02` is recorded as `v1.0.0` in `python-core/handthesia_core/source_manifest.json` and as `v26.1.20` in `tests/fixtures/manifest.json`.
- The README says 163 built-in melodies; `docs/RELEASE_NOTES.md` says 162. The generated catalogue contains 163 (verified by running the preparation step).

Fix: regenerate or retire the stale documents, restore the generator or fix the link, and settle on one desktop version string.

### DOC-2 · Medium · verified — derived work has no upstream licence

`python-core/handthesia_core/fingering.py` and `figures.py` derive from
[V9011N/pygame-piano-animator](https://github.com/V9011N/pygame-piano-animator), which publishes no licence file. The repository's own licence correctly carves that code out, but it also means the computational core and the 163 bundled MIDI files (`builtin_melodies/midi`, no recorded provenance) have no clear distribution terms. The hand textures and `.glb` models in `apps/client/public` are in the same position.

Impact: legal, not technical — it blocks a genuinely public distribution of the engine and the library.

Fix: obtain written permission from the upstream author, replace or document the bundled media, and record the provenance in `docs/licenses/`.

---

## 9. What was not verified

- **The browser suite was not run locally.** It needs Playwright browsers, a dev server and over an hour; the analysis of its health comes from the CI logs of run `39161074876` and from configuration.
- **The Python suite was not completed locally.** The pinned environment targets Python 3.14; a 3.12 virtual environment was created for this audit but the dependency install did not finish in reasonable time, so Python findings are static except for the isolated `travel_time` reproduction.
- **No profiling, fuzzing or penetration testing.** Performance conclusions are static or measured from a real build; security conclusions are code and configuration review.
- **No hardware checks**: audio output, Web MIDI devices, large user SoundFonts and video export codecs were not exercised.
- Findings marked *likely* or *suspected* should be reproduced before being scheduled as work.

## 10. Reproduce the checks

```text
npm ci
npm run typecheck            # exit 0
npm run lint                 # exit 0
npm run test:unit            # 67 files, 639 tests, 28.3 s
npm run build                # dist 137.9 MiB, 500 files; main chunk 2 617 kB (819 kB gzip)
npm audit                    # 0 vulnerabilities

# engine-2, isolated:
python -c "import sys; sys.path.insert(0, 'python-core'); \
  from handthesia_core import fingering; \
  fingering.MAX_SPEED = 0.0; fingering.travel_time(1.0)"
# -> ZeroDivisionError: float division by zero

# deployment:
Invoke-WebRequest -Method Head https://shafranek-js.github.io/pianomotion-studio/
Invoke-WebRequest -Method Head https://shafranek-js.github.io/pianomotion-studio/pyodide/pyodide.asm.wasm
```

## 11. Resolution log

| Date | Finding | Status | Change |
|---|---|---|---|
| 2026-10-20 | ENG-1 | **Fixed** | `pianist.normalize_behavior()` validates and clamps profile behavior at the API boundary (`strict=True` → malformed values raise `ValueError`) and again in `from_profile_dto` (clamps, keeps defaults). `travel_time` and `_apply_preferences` no longer divide by a zero, negative, NaN or infinite speed. Ported to `packages/engine-ts/src/pianist.ts`, `api.ts` and `fingering.ts`. `source_manifest.json` and the TS `EMBEDDED_MANIFEST` regenerated (`engineVersion` `cfb68636…`). Tests: `packages/engine-ts/test/profile-behavior.test.ts` (7) and `test_profile_behavior_is_clamped_and_validated`. |
| 2026-10-20 | DEP-3 | **Fixed** | `tools/build-release.mjs` now calls `pruneDuplicatePublicAssets()` after the release assets are copied: every public entry except `sw.js` and `_headers` is removed from the dist root. Measured build: **70.7 MiB / 261 files** (was 137.9 MiB / 500), root holds only `releases/`, `index.html`, `sw.js`, `offline-manifest.json`, `_headers`. Verified in a production preview: release paths serve the real files, root duplicates are gone, the service worker caches all 258 manifest entries (261 cache records) and the app reloads **offline** with the demo project and no console errors. Live check 2026-10-21 after the manual deploy: `/pyodide/pyodide.asm.wasm` and `/textures/skin-realistic.png` return **404**, release `22cc79118a6c45c7b716be80` is served from `releases/`. |
| 2026-10-20 | DEP-2 | **Partially fixed** | `apps/client/public/_headers` now describes the real deployment (`/releases/*` immutable, `sw.js` and `index.html` no-store; obsolete root paths removed) and adds `form-action 'self'` / `frame-ancestors 'none'`. Because GitHub Pages ignores the file, `tools/build-release.mjs` injects the same policy as a `<meta http-equiv="Content-Security-Policy">` into the built `index.html`, reading it from `_headers` so the two cannot drift; directives invalid in a meta tag are stripped. Verified in production: demo loads, the **Python engine** (Pyodide wasm + `unsafe-eval`) analyses a MIDI fixture with zero CSP violations, and an offline reload renders the demo with zero violations. Live check 2026-10-21: the meta CSP is present, but header-only protections (`frame-ancestors`, X-Frame-Options, nosniff) remain absent because Pages ignores `_headers`; the status is therefore partial, not fixed. |
| 2026-10-20 | CI-1 (partial) | **Fixed** | Shared `playwright.shared.ts` adds a 15 s `expect` timeout (the default 5 s lost against the 38 MiB SoundFont), one retry and trace/screenshot artifacts **in CI only**, and an HTML report per group so `playwright-report/` is actually produced. The dev-server startup budget is 180 s (predev stages 21 MiB of Pyodide). The WebGL harness specs moved to `playwright.gpu.config.ts` / `npm run test:gpu` (240 s tests, own port, own report) and out of the UI group. `verify.yml` was rebuilt around independent jobs: one static job (Python, catalogue, typecheck, lint, Vitest, parity), one Ubuntu build job publishing `dist`, browser jobs per group with the UI suite sharded three ways, and an offline matrix against the built artifact; Chrome runs on PRs, Chrome and Edge on `main`. `dev:test` stages generated assets only when missing, and browser jobs restore them from `actions/cache`. Local verification: UI `bootstrap` 2/2 in 36 s, `grand-highway` 1/1 in 1.6 min, the five tests that failed in CI (`practice-stage2`, `skins-audio-m6`) pass 5/5, and the new `musical-loading` spec 4/4. Shard split of the 45 UI tests: 16/14/15. **Not done:** the UI group still runs against `npm run dev` (not the built bundle), because many specs import `/src/…` modules and `/@fs/` harnesses and a production preview would register the service worker and cache 70 MiB per context; that migration needs a dedicated plan. |
| 2026-10-21 | ENG-2 | **Fixed** | `save_fingered_midi_bytes()` counted `indexOf(n)` inside the matched bucket, so every single-note bucket contributed `0` and `markedCount` was bounded by the widest bucket (1 for the 22-note fixture). It now stores the matched note object in a `Set<object>` and returns its size, matching Python's `id(n)`. Regression `packages/engine-ts/test/midi-markers.test.ts`: the 22-note fixture returns `markedCount` 22 with 22 `0x01` marker events and unchanged note-on tick/pitch pairs; a synthetic file with two notes in one bucket returns 2 unique marked notes while writing 3 markers, so neither bucket indexes nor marker-event counts satisfy it. Reverting the fix makes both tests fail (`markedCount` 1), which proves the test catches the original defect. |
| 2026-10-21 | ENG-3 | **Fixed** | Export diagnostics now carry stable document noteIds. `save_fingered_midi_bytes()` tracks which source notes received a marker and returns `diagnostics: [{ code: "unmatched-document-note", noteId, message }]` for the rest (TS and Python). `M1ExportMidiResultSchema` gains `diagnostics`; both workers forward it; the UI turns a partial export into a `warning` status that names the unmatched noteIds. Regression: the valid 22-note fixture returns empty diagnostics and a byte-identical export (SHA-256 `7e64b9b8…`, same as after ENG-2, 22 markers); shifting one document note by 0.02 s returns `markedCount` 21, 21 markers and exactly one diagnostic with that noteId; the multi-note bucket case returns 2 unique marked notes, 3 markers and a diagnostic for the second note. Python `test_export.py` covers the empty and shifted cases. `engineVersion` regenerated to `8aa119fe…`. |
| 2026-10-21 | ENG-4 | **Fixed** | `M1ExportMidiRequestSchema` now rejects an inconsistent export before any worker runs: `document.projectId`/`revision` must match the request, the plan's `projectId`, `inputRevision` and `engineVersion` must match, and the existing document-relative plan check (`fingeringPlanForSong`) is reused for unknown, missing and duplicate assignments, hand consistency and explicit glissando runs. A previously calculated plan is accepted when its `planId` differs from the export `requestId`; the request `midiBytes` are not compared with the document, so the shifted-note case stays ENG-3. Regression `packages/engine-ts/test/export-request.test.ts` covers the valid request, document identity, plan identity/engineVersion, unknown/missing/duplicate assignments and hand mismatch, asserting explicit issue paths. The valid export is still the ENG-2/ENG-3 baseline (SHA-256 `7e64b9b8…`, 22 markers, empty diagnostics). |
| 2026-10-20 | ENG-7 (partial) | **Fixed** | The two `', '.join(...)` calls in `engine-ts/src/api.ts` now use `Array.prototype.join`, so a missing profile/option field raises the intended `ValueError` instead of `TypeError`. |
| 2026-10-20 | DEP-1 | **Fixed (process changed)** | `deploy-pages.yml` no longer publishes on every push. It is triggered by a completed **Verify studio** run on `main`, builds only when that run succeeded, and keeps `PAGES_ENABLED` as the second gate; a manual dispatch remains an explicit override. The stale `docs/evidence` upload and the one-off `clean-obsolete-pr-runs.yml` were removed, and `npm run ci` is documented as the local sequential sweep rather than the CI definition. Correction 2026-10-21: the workflow still rebuilds on Ubuntu and does not promote the locally verified artifact, so it does not prove that the published bytes equal the tested ones. |
| 2026-10-20 | — | Housekeeping | Removed a literal NUL byte from `engine-ts/src/api.ts` (it made the file binary to git and to editors) and replaced it with `\u0000`, which produces the same runtime string. The file is now text; its one-time diff also normalises CRLF to LF. |
| 2026-10-21 | CI-1 / DEP-1 (superseded) | **Replaced** | Hosted verification was abandoned after three runs: the Windows runners could not sustain the acceptance suites (61-minute wall, 9 red groups, two jobs cancelled at their timeout, while the same specs pass locally — PWA 11/11, GPU 5/5, builtin-melodies/player 4/4, audit-session 3/3). `verify.yml` and `verify-loading-fast.yml` were removed; `npm run ci:local` is the gate, with profile `pr` (Python, catalogue, typecheck, lint, Vitest, parity, build, 13-scenario smoke) and profile `full` (all browser groups, shards, separate ports, logs in `.ci-local/`). `deploy-pages.yml` is now manual `workflow_dispatch` only and publishes a build verified on the machine. The 1 GiB SoundFont persistence case skips when browser storage cannot hold it, and its sparse fixtures are cleaned up. |
| 2026-10-21 | SEC-7 | **Partially refuted** | The SoundFont half is refuted: `soundfontSampleProvider.ts` already enforces a 256 MiB sample-cache budget with preflight and reservation, so sample buffers are not unbounded. The imported-audio half remains open: `audioDecoder.ts` only rejects a compressed input above 100 MiB (`MAX_AUDIO_FILE_SIZE_BYTES`, lines 6/96/107) and then calls `decodeAudioData` without a decoded-PCM or duration budget, so the decoded buffer can exceed the input size. A codec's internal RSS is still unmeasured. |
| 2026-10-21 | ENG-14e | **Refuted** | `midi_loader.py` unpacks SMPTE division with `struct.unpack('>h')`, so the division is signed; the arithmetic right shift yields the signed high byte and there is no 25→26 off-by-one. |
| 2026-10-21 | CI-4 | **Corrected** | In this checkout `.git` is hidden and the archive enumeration (without `-Force`) does not include it; the "93 MiB .git in the archive" observation does not apply here. Missing explicit excludes remain a risk on filesystems that surface the directory. |
| 2026-10-21 | CI-6 | **Corrected** | An unhandled child `error` in `ci-local.mjs`/`ci-verify.mjs` normally crashes Node; it does not leave the parent waiting for a timeout. The missing handler is still worth fixing. |
| 2026-10-21 | DEP-5 | **Clarified** | Different checkout bytes legitimately produce different build IDs; the requirement must explicitly define which inputs are canonicalised, and mechanically normalising only hash inputs can make different outputs look identical. |

## 12. Errata after the independent review (2026-10-21)

The review is recorded in [CODE_AUDIT_REVIEW_2026-10-21.md](CODE_AUDIT_REVIEW_2026-10-21.md). It confirms several mechanisms but corrects overstatements; the resolution log above now reflects those corrections, while the findings themselves remain the historical record.

- **DEP-2 / SEC-1** — the meta CSP is present in the deployed `index.html`, but it cannot replace `frame-ancestors`, X-Frame-Options or nosniff. Status is partial, not fixed.
- **DEP-3** — the builder prunes root duplicates, and the live site now returns 404 for `/pyodide/pyodide.asm.wasm` and `/textures/skin-realistic.png`; release `22cc79118a6c45c7b716be80` is served from `releases/`.
- **DEP-1** — Pages rebuilds on Ubuntu and does not publish the locally verified artifact; it does not inspect the local SHA or dirty state.
- **SEC-7** — partially refuted: the SoundFont sample cache already has a 256 MiB budget with preflight and reservation, but an imported audio recording is only bounded by its 100 MiB compressed input; the decoded PCM/duration budget is still missing.
- **ENG-14e** — refuted: `struct.unpack('>h')` divides signed values; there is no 25→26 off-by-one.
- **CI-4** — corrected for this checkout: `.git` is hidden and the archive enumeration does not include it; missing explicit excludes remain a risk elsewhere.
- **CI-6** — corrected: an unhandled `spawn` error crashes the process instead of leaving it to time out.
- **CI-8** — corrected: the gap between 2026-10-15 and 2026-10-19 is four days, not three weeks.
- **CI-1 / CI-3** — a single local pass and conditional skips are not a release matrix; the local gate needs an explicit browser/codec/device policy and visible skips.
- The severe-looking totals in section 1 count duplicate hypotheses and environment-dependent observations; they are not a defect score.

