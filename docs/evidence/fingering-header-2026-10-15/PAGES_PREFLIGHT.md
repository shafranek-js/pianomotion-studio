# GitHub Pages publication preflight

Date: 2026-10-15. User explicitly authorized commit, push and Pages deployment.
Version: 0.1.0-dev.3. Target: shafranek-js/pianomotion-studio, branch main.

- Local HEAD and origin/main matched before publication work.
- `npm run typecheck`, `npm run lint`: PASS.
- `npm run test:unit`: 397 passed, 27 files.
- `npm run test:python`: 28 passed, including the frozen numerical cases.
- `APP_BASE=/pianomotion-studio/ npm run build`: PASS.
- Project-path build ID: `0dc3a1d914e2a9223d6539e0`.
- All 85 manifest resources checked against their sizes and SHA-256.
- Chrome production preview at `/pianomotion-studio/`: HTTP 200, title
  PianoMotion Studio, real demo Worker analysis rendered a canvas, Fingering
  assignments appeared in the header, version dev.3 visible, no page errors
  or horizontal overflow.
- Prior Chrome/Edge UI acceptance is recorded in VERIFICATION.md.

The repository is private. GitHub rejected `POST /repos/shafranek-js/pianomotion-studio/pages`
with HTTP 422: `Your current plan does not support GitHub Pages for this repository.`
Publication is not confirmed. No repository visibility or subscription change
was authorized at this point; the user was asked to choose the next step.

The workflow builds and uploads the project-path artifact on main pushes.
Its deploy job additionally requires repository Actions variable
`PAGES_ENABLED=true`, and Pages must be enabled in workflow mode. Until the
GitHub restriction is resolved, build checks can run while deployment skips.
The generated legacy public offline-manifest is ignored; the release builder
writes the verified deployment manifest only into dist.

GitHub source references: [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[Pages REST API](https://docs.github.com/en/rest/pages/pages).
The exact action tags in the workflow were verified against their official
GitHub refs. Runtime artifacts and browser traces remain ignored; audit
evidence already prepared for handoff is preserved in the source commit.
