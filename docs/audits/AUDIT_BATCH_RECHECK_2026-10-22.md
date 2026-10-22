# Independent recheck of B1–B6 — 2026-10-22

Review of the working tree, without product edits, commit, push or deployment. The previous independent report remains unchanged.

## Verdict

- **B1 accepted:** both ProjectsPanel instances receive the App deletion callback. The active-project deletion browser regression passed independently, including reload.
- **B2 partially fixed:** conditional recovery deletion is atomic and protects another project's snapshot. A concurrent manual-save completion can still remove the deleted project's autosave block; see below.
- **B3 accepted:** package preparation and its download/status commit use the shared export generation scope.
- **B4 accepted:** real grid and idle paths use the 4000-entry cap. As in Python, checking before insertion can temporarily permit 4001 entries; the next cache miss clears them.
- **B5/B6 remain open:** new checks reject the original empty-inventory probes, but still accept incomplete inventories. The current complete artifact passing does not establish verifier completeness.

## Remaining findings

### B2 — stale manual-save completion re-enables deleted recovery

`PianoPlayer.tsx` saves the project, schedules and flushes recovery, then calls `onProjectSaved` (around lines 1718–1764). App's callback unconditionally calls `allowProject(projectId)` (line 900). `clearProjectRecovery` blocks the project and waits for recovery writes, but does not invalidate the manual save operation.

An admissible order is: manual save A starts; its project write commits; deletion removes A and blocks recovery A while the save continuation is pending; the old continuation finishes and calls `onProjectSaved(A)`; autosave A is enabled again. A subsequent edit can recreate recovery for the deleted row. The passing browser regression does not overlap save and delete.

Use a per-project deletion/save generation or coordinate save/delete ownership. A save begun before deletion must not re-enable recovery; a deliberate save begun after deletion may recreate the project. Add a regression that delays the old save completion across deletion. This finding is based on source ordering, not a browser reproduction of that overlap.

### B5 — release verification accepts missing runtime and core files

An isolated copy of the actual current dist was made with three entries and their files removed:

```text
releases/726bdb4948d3d62bfb4c6a89/pyodide/pyodide.mjs
releases/726bdb4948d3d62bfb4c6a89/pyodide/pyodide.asm.mjs
releases/726bdb4948d3d62bfb4c6a89/python-core/handthesia_core/hands.py
```

The offline inventory and totalBytes were updated consistently; remaining bytes and hashes were unchanged. `verifyReleaseDist` accepted the broken release: **255 files, 72,652,731 bytes**. Packaged runtime/core manifests still reference the absent files.

The fixed required-entry subset in `tools/verify-release-dist.mjs` (around lines 108–115) is insufficient. Cross-check the complete packaged runtime/core inventories against the offline manifest and actual files. Add a negative regression removing a required file from both disk and the offline manifest, while leaving its source inventory reference intact.

### B6 — preflight accepts an unpinned and incomplete staged runtime/core

An isolated staged tree used actual file bytes and valid sizes/hashes, but its manifests were reduced to the four explicitly required Pyodide files and seven explicitly required core files. Runtime metadata was changed to version `0.0.0-not-the-pin`; purePythonWheels was empty. Core omitted modules including pianist, figures, geometry, glissando and progress, while retaining the original engineVersion.

`assertReleaseAssets` accepted this tree. Thus metadata strings and a syntactically valid engineVersion are checked, but the declared pinned version and complete module/package inventory are not established. Compare against trusted pinned runtime expectations and the complete core inventory, including its content identity. Add negative tests for a non-pinned version and a reduced, otherwise valid inventory. Adding only the three filenames from B5 would leave the general completeness defect.

## Evidence and limits

Independently executed:

- Release verifier/preflight focused tests: **7 passed / 2 files**.
- Real and helper hands-cache tests: **4 passed / 2 files**.
- Storage, autosave lifecycle, export scope and package base64 focused tests: **38 passed / 4 files**. B3 was additionally checked in its actual PianoPlayer call path; no package-export browser scenario was run.
- Active-project-delete Playwright scenario: **1 passed**, Chrome, isolated port 4287.
- `npm run verify:release`: **258 files, 74,126,047 bytes**, build `726bdb4948d3d62bfb4c6a89`.
- `git diff --check`: exit 0.
- B5/B6 negative probes described above: both incorrectly accepted. Probes used isolated temporary trees; original public/dist were not modified.

Existing gate logs were inspected, not rerun: final static log reports **728 tests / 93 files**, Python **38 passed, 1 skipped**, and native parity PASS. The earlier full gate includes 11 passing smoke tests. These logged suite results do not cover the newly identified counterexamples.

## Second recheck after deletion epochs and shared inventory

The findings above describe the earlier tree. Current verdict: **B2 and B5 accepted; B6 partially fixed**. B1/B3/B4 were not reopened.

B2: the save epoch is captured before the first asynchronous save step in PianoPlayer and passed back to App. Deletion increments the same project registry; App gates `allowProject` on that epoch. This closes the previously identified stale-save recovery re-enabling race. Tests cover a save before deletion, after deletion, and crossing a second deletion. No delayed-manual-save browser scenario was independently run. Saved/warning status ordering is not protected by this epoch and remains a UI limitation distinct from recovery blocking.

B5: packaged runtime/core inventories are now cross-checked against offline entries, and those entries against disk sizes/hashes. The new complete synthetic release test rejects the previously omitted core/runtime paths. The complete required runtime/core lists are shared with preflight.

B6: pinned metadata, wheels and complete core inventory checks address the earlier counterexample. However, runtime file descriptors still do not require size/hash fields: `requireFile` compares a size only when `Number.isSafeInteger(expected.sizeBytes)` and hashes only when `expected.sha256` is truthy. An independent probe used `makeValidStagedTree`, verified it first, then removed both fields from the `pyodide/pyodide.mjs` descriptor and replaced that file with `corrupted-runtime`. **assertReleaseAssets accepted it.** The probe used an isolated temporary tree and cleaned it up; original public/dist were unchanged.

Require every Pyodide files entry to contain a positive safe-integer size and a 64-hex SHA-256 before reading its file. Add regressions for missing/malformed descriptors and changed bytes. This is a preflight gap; the stricter dist verifier does not thereby become bypassed.

Independent commands: focused verifier/preflight/epoch tests **12 passed / 3 files**; `verify:release` passed for build **99947abb985b2c7cc3a69291**, **258 files / 74,126,500 bytes**; `git diff --check` passed. Existing static log `.ci-local/2026-10-22T03-35-40-420Z/static.log` confirms **733 tests / 94 files**, Python **38 passed, 1 skipped**, native parity PASS. Full gate and browser were not rerun for this second recheck. Product code, commits, push and deployment were untouched.

## Final B6 descriptor recheck

**B6 accepted.** Every Pyodide files entry now requires a string path, positive safe-integer sizeBytes and 64-hex sha256 before file validation. The previous missing-fields bypass is closed.

Independently executed `release-assets.test.ts`: **6/6 passed**. Additional isolated probes all rejected: both size/hash absent, hash alone absent, fractional size, and corrupted bytes with the original length and valid unchanged descriptor (hash mismatch). The valid staged fixture passed before mutation. Temporary probe files were removed; public/dist were unchanged.

`verify:release` passed again: build **99947abb985b2c7cc3a69291**, **258 files / 74,126,500 bytes**. `git diff --check` passed. The reported 734-test full suite was not independently rerun, nor was the full PR gate. B1–B5 were not reopened; all six requested findings are now accepted within the evidence and limitations recorded above. Only this report was edited during the final review; no commit/push/deploy.
