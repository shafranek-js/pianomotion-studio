# W002 Web bootstrap evidence

Date: 2026-10-13  
Scope: M0 / W002 only. This records the toolchain bootstrap and its checks; it does not close G0 or establish Python/browser parity.

## Runtime and selected versions

The existing local runtime was Node.js `v24.14.0` with npm `11.9.0`. No global Node or Python packages were changed. Direct dependencies are exact-pinned in the workspace manifests and resolved in `package-lock.json`:

| Area | Package | Version |
|---|---|---:|
| UI | `react`, `react-dom` | `19.3.0` |
| UI primitives | `@radix-ui/react-dialog` | `1.3.1` |
| Scene engine | `pixi.js` | `8.22.0` |
| Contracts | `zod` | `4.6.7` |
| Dev server/build | `vite` | `8.3.4` |
| React transform | `@vitejs/plugin-react` | `6.1.2` |
| TypeScript | `typescript` | `6.0.3` |
| React types | `@types/react`, `@types/react-dom` | `19.3.0` |
| Node types | `@types/node` | `26.6.5` |
| Lint | `eslint`, `@eslint/js` | `10.12.0`, `10.0.1` |
| Lint plugins | `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals` | `8.71.2`, `7.1.1`, `0.5.7`, `17.13.0` |
| Unit tests | `vitest` | `5.0.4` |
| Browser tests | `@playwright/test` | `1.64.0` |

Versions were checked against current npm registry metadata on this date with `npm view <package> version` and verified after installation with `npm ls --depth=0`. The React, Vite, TypeScript, Vitest, Playwright, PixiJS, and Radix documentation consulted was:

- [React 19.3 release](https://react.dev/blog/2026/09/09/react-19-3)
- [Vite supported releases](https://vite.dev/releases) and [Vite 8 announcement](https://vite.dev/blog/announcing-vite8.html)
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [Vitest 5 announcement](https://vitest.dev/blog/vitest-5)
- [Playwright release notes](https://playwright.dev/docs/release-notes) and [browser installation](https://playwright.dev/docs/browsers)
- [PixiJS v8 guides](https://pixijs.com/8.x/guides)
- [Radix Dialog documentation](https://www.radix-ui.com/primitives/docs/components/dialog)
- [Zod npm metadata](https://www.npmjs.com/package/zod)

Vite `8.3.4` requires Node `^20.19.0 || >=22.12.0`; Vitest `5.0.4` requires Node `^22.12.0 || ^24.0.0 || >=26.0.0`; the existing Node `24.14.0` satisfies both. Vite 8 is accepted by the selected Vitest and React plugin peer ranges. TypeScript `7.0.2` was the registry `latest`, but was not selected because current `typescript-eslint@8.71.2` declares `typescript <6.1.0`; TypeScript `6.0.3` is the newest compatible 6.0 release. The selected Radix Dialog peer range includes React 19.

The single `npm install --no-audit --no-fund` completed successfully and reported `added 218 packages in 11m`. The lockfile contains both `@handthesia/client` and `@handthesia/contracts`, including `zod@4.6.7`.

## What the commands check

| Command | Check performed |
|---|---|
| `npm run dev` | Starts the Vite development server for `apps/client`. |
| `npm run typecheck` | Type-checks the app and Vite config via the app project references, the contracts source/tests via `packages/contracts/tsconfig.json`, and the root Vitest/Playwright configs. |
| `npm run lint` | Runs ESLint on app and contracts source/tests and the web tool configs. |
| `npm run test:unit` | Runs Vitest test/spec files under `apps/**` and `packages/**`; this includes the semantic contracts suite. |
| `npm run test:parity` | Explicitly exits `2` with a pending message. Python-to-browser parity is not implemented and this is not a passing suite. |
| `npm run test:browser` | Starts this checkout's Vite server on `127.0.0.1:4173` with stale-server reuse disabled, then runs the Chromium bootstrap smoke. |
| `npm run build` | Produces the client production bundle with Vite. |

The browser smoke verifies the page title and heading, checks that the page visibly states that the MIDI player is not implemented, and fails on browser `pageerror` events. A screenshot captured from the same checkout is at `C:\Users\pavel\.codex\visualizations\2026\10\13\01a134bd-3548-7483-bf3b-27bf94b721c4\handthesia-bootstrap.png` (1365×900).

## Results

| Check | Result |
|---|---|
| `npm install --no-audit --no-fund` | Passed, exit `0`; 218 packages added. |
| `npm ls --depth=0` | Passed; direct package versions match the table above, including both npm workspaces. |
| `npm run typecheck` | Passed, exit `0`, after the contract owner's third-review fixes. |
| `npm run lint` | Passed, exit `0`, after the contract owner's third-review fixes. |
| `npm run build` | Passed, exit `0`; Vite transformed 16 modules. JS bundle 220.48 kB (68.99 kB gzip); CSS 1.53 kB (0.77 kB gzip). |
| `npm run test:parity` | Expected pending result, exit `2`; no parity suite is claimed. |
| `npm run test:browser` | Passed, exit `0`; 1 Chromium test passed in 6.6 seconds after installing Chromium `156.0.8078.4` via the local Playwright CLI. The first attempt could not launch because no Playwright browser was installed. |
| `npm run test:unit` | Passed, exit `0`; 1 test file and 11 semantic contracts tests passed. |

The screen is an honest workspace status page, not a MIDI player simulation. MIDI import, playback, note rendering, hand animation, Pyodide execution, desktop parity, performance, release licensing, and independent acceptance remain outside W002 or unverified.
