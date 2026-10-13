# Desktop baseline evidence — 2026-10-13

This evidence captures the desktop implementation at commit `f8189c021d9235005fb35faa2c8cfbc09a3768a0` (`v26.1.20`) for web migration tasks W001/W004/W005 M0. `source-sha.txt` records the commit; `web/tests/fixtures/manifest.json` records desktop module hashes, MIDI source and fixture hashes, the generator hash, and the `learned_weights.json` provenance hash. Each golden's provenance records the explicitly applied default-profile hash, `fingering.py` hash, and bundled font hashes.

## Isolated desktop test run

The full desktop pytest suite ran once in `C:\Users\pavel\AppData\Local\Temp\handthesia-m0-20261013-codex`, an isolated Python 3.14.0 venv. The app's active `.venv` was not modified. `desktop-venv.lock.txt` records the active app environment before testing; `test-environment.lock.txt` freezes the isolated test environment, including pip. The run used dummy SDL video and audio drivers and pytest's temporary profile fixture.

Result: **148 collected, 148 passed, 0 failed, 0 skipped, 0 xfailed, 0 xpassed** in 40.64 seconds. There were no failure details. The exact module output is in [`pytest.log`](pytest.log), and the machine-readable result is in [`pytest-results.json`](pytest-results.json).

Reproduce the test run in the isolated venv with `python -m pytest -ra`, setting `SDL_VIDEODRIVER=dummy` and `SDL_AUDIODRIVER=dummy` in that process. Reproduce the fixture/golden files with `python web/tools/generate_desktop_baseline.py`; verify byte-for-byte determinism with `python web/tools/generate_desktop_baseline.py --check`. The recorded check result is [`reproducibility.log`](reproducibility.log). The standalone generator sets dummy SDL before desktop imports, directs `paths.DATA_DIR` and the pianist profile/settings store to a disposable temporary directory, and explicitly applies `pianist.default_pianist()`, realistic keys, and the bundled Source Sans Pro font. It uses the repository source tree only for read-only application code and assets.

The default fingering weights are the actual runtime constants `fingering.py::LEARNED_W`. The hashed `learned_weights.json` file is recorded only as provenance; `fingering.py` does not load it at runtime. No arbitrary replacement weights or cached user profile are used.

## Fixture and golden results

The fixture index contains 13 files: three byte-exact copies of tracked MIDIs and ten locally synthesized SMFs. Across those inputs, PrettyMIDI decoded 827 source notes and desktop normalization returned 826 notes; 79 selected paired or single-hand poses include complete numerical bones, joints, and crossing layers. Ten inputs loaded, one intentionally truncated input was repaired, and two invalid inputs were rejected. These counts and per-fixture outputs are in [`golden-index.json`](golden-index.json) and [`web/tests/fixtures/manifest.json`](../../../tests/fixtures/manifest.json).

Observed desktop behaviors to carry into M1 review:

- Two notes with the same pitch and onset on separate tracks are merged by desktop sanitation. The golden retains both decoded-note ordinal IDs in `sourceNoteIds`, records `identityLosses`, and shows the surviving note inheriting the second track's `L5`/left-hand marker. Desktop currently has no raw SMF event identity mapping; the fixture IDs must not be read as such.
- In the crossing/wide-chord case, the six-note chord has one note with no assigned finger. It remains in normalized notes and assignments, but only 13 of 14 normalized notes produce performance events. Paired pose samples pass through `hands.arrange_crossing`; both hands' layer and all skeleton coordinates are stored.
- The explicit gliss markers produce a six-note gliss run after the initial manually fingered notes. In the contradictory-label fixture, the low notes on the track named `Right Hand` remain assigned to R and the high notes on the track named `Left Hand` remain assigned to L; the explicit track names win over conventional register expectations.
- The truncated MIDI is repaired and yields a `Song`, but `loaded`/`repaired` is only a loader outcome. It does not establish that the UI accepts a playable project. The empty and non-MIDI files are rejected.

These are observed desktop outputs, not fixes or correctness claims. All desktop pytest tests passed, but the duplicate-note identity collapse and the missing raw-SMF note-event mapping remain explicit M1 risks. No desktop code or tests were changed. Pyodide, browser parity, and browser performance remain unverified; no roadmap gate is marked complete here.
