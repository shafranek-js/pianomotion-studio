# Live GitHub Pages verification

Date: 2026-10-15. Version: **0.1.0-dev.3**.
URL: https://shafranek-js.github.io/pianomotion-studio/

The user explicitly authorized public repository visibility after the private
plan rejected Pages. The repository is now public; Pages uses workflow mode,
HTTPS is enforced, and Actions variable `PAGES_ENABLED` is true.

[Deployment 38762695870](https://github.com/shafranek-js/pianomotion-studio/actions/runs/38762695870)
succeeded at source commit `07cae1c4c37406cd08ae5983ac886145f418fb29`.
Build completed in 38 seconds, deployment in 50 seconds. The preflight's HTTP
422 is historical and has been resolved through the authorized visibility change.

## Independently checked on the published site

- HTTPS HTTP 200; title PianoMotion Studio; displayed version dev.3.
- Live build ID `a8ca51923d2a070431201243`.
- Engine `83fde5039dd70360c29aa5a3edbb07fc2f024528c76330b42bc55e195cb8fbc7`.
- All 85 release manifest resources fetched from Pages and verified against
  size and SHA-256. The cloud build ID can differ from the local build ID
  because byte-level build inputs include platform checkout line endings.
- Chrome: real demo analysis rendered the scene; assignment controls appeared
  in the header in Fingering; no page errors or page horizontal overflow.
- Edge: real demo rendered; selected a note, assigned Finger 4 through the
  header, used Undo, switched modes without replacing the canvas, and used
  Play/Pause. No page errors.

Reports: [Chrome](live-verification.json), [Edge](live-edge-verification.json).
Screenshots: [Chrome](live-chrome.png), [Edge](live-edge.png).

## Separate Windows CI correction

Previous Verify run 38744216820 stopped on a Python source hash mismatch before
later suites. Its Windows checkout converted LF source bytes to CRLF.
`.gitattributes` now requires LF for the 12 `python-core/handthesia_core/*.py`
modules. Independent `git -c core.autocrlf=true checkout-index` into a temporary
ignored directory preserved all 12 exact manifest hashes with this attribute.
The focused canonical source-manifest Python test passed (1 passed, 27 deselected).

This follow-up changes CI attributes and documentation only; application version
remains dev.3. Full Windows Verify will run again after the follow-up push;
no claim of its completion is made here. Previous hardware/listening and load
limitations in the audit acceptance record remain separate from publication.
