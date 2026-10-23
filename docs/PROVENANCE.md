# Provenance and redistribution status

This document records what is known about material that did **not** originate in
this repository. It does not grant permission, and it does not replace a legal
review. The project's own [LICENSE](../LICENSE) deliberately excludes these
parts; unknown status must not be described as a licence.

## Upstream engine

| Item | Location | Origin | Documented permission |
|---|---|---|---|
| Hand/fingering engine and TS port | `python-core/handthesia_core/`, `packages/engine-ts/` | Derived from [V9011N/pygame-piano-animator](https://github.com/V9011N/pygame-piano-animator), commit `f8189c021d9235005fb35faa2c8cfbc09a3768a0` | **Not established.** The upstream repository publishes no licence file; no written permission is recorded in this checkout. `LICENSE` excludes this code from the project's MIT grant. |

The desktop version string for that source is `v26.1.20`, matching
`tests/fixtures/manifest.json` and `python-core/handthesia_core/source_manifest.json`.

## Bundled media

| Item | Location | Origin | Documented permission |
|---|---|---|---|
| Built-in MIDI library (163 files) | `builtin_melodies/midi/` | Not established per file; the generated catalogue and hashes live in `apps/client/public/builtin-melodies/manifest.json` | **Not established.** The files are not covered by the project's MIT grant. |
| Hand textures | `apps/client/public/` | Not established per asset | **Not established.** |
| `.glb` hand/scene models | `apps/client/public/` | Not established per asset | **Not established.** |
| MuseScore General v0.2 | `apps/client/public/` / notices | MuseScore General | **MIT**, recorded in [`MuseScore_General_License.md`](licenses/MuseScore_General_License.md). |

Third-party software notices are recorded in `docs/evidence/licenses-2026-10-13.md`,
`docs/evidence/licenses-2026-10-15.md`, and `apps/client/public/notices/`.
They do not establish rights for the upstream engine or the media above.

## Release gate

A public distribution of the engine, the built-in MIDI library, the hand
textures, or the `.glb` models needs one of:

1. written permission from the relevant rights holder, recorded here; or
2. replacement with material whose licence and provenance are recorded here; or
3. removal of the material from the distributed package.

The repository can be built and tested locally without resolving these items.
Their unresolved status is a release/legal gate, not a claim that a violation
has occurred, and not a technical blocker for the current local build.
