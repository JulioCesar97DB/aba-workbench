# aba-workbench

A workbench for ABA professionals. First tool: draft the initial assessment section by section, to paste into ABA Matrix.

It is a desktop app for macOS and Windows (Electron, with a React interface built by Vite), running on the user's own computer. Status: the interface has its base screens, in Spanish and English: the list of cases (empty: creating cases is the next task), a case workspace whose five steps are placeholders, and Settings with the screen language. No AI connection yet. This repository only uses invented data.

Requirements: Node.js 24 or later; pnpm comes from the `packageManager` field in `package.json`.

License: Apache License 2.0 (see [LICENSE](LICENSE)). The IBM Plex fonts the interface ships are under the SIL Open Font License 1.1 ([licenses/IBM-Plex-OFL.txt](licenses/IBM-Plex-OFL.txt)).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs the dependencies. Electron's own binary (about 100 MB) is downloaded the first time the app starts. |
| `pnpm dev` | Opens the desktop window, with the interface reloading on save. `pnpm dev --watch` also rebuilds and restarts the app when the main process or the preload changes. |
| `pnpm build` | Builds the main process, the preload and the interface into `out/`. |
| `pnpm preview` | Starts the built app from `out/`. |
| `pnpm package` | Builds, then packages an unpacked app for the current platform into `dist/` (`dist/mac-arm64/ABA Workbench.app`, `dist/win-unpacked/ABA Workbench.exe`). No installer and no signing yet. |
| `pnpm test:e2e` | Builds the app and drives its window with Playwright: it opens on Home, the navigation reaches every screen, the language changes and survives a restart, the keyboard and a narrow window work, and the development check's mock generation streams to completion. Needs a display (`xvfb-run` on a Linux machine without one). `pnpm test:e2e:packaged` runs the same tests on the app from `pnpm package`. |
| `pnpm lint` / `pnpm typecheck` | ESLint; TypeScript for the Node side and for the interface, separately. |
| `pnpm test` | Unit tests (`node:test`): the provider layer, the rules, the spending cap, the main process's logic (the settings file included), both languages having the same strings, and the design tokens' contrast. No keys, no network, no window. |
| `pnpm phase0 --mock` | The Phase 0 run on the mock provider: no key, no cost. Without `--mock` it calls the real providers with the keys in `.env.phase0` (see [docs/phase0/REPORT.md](docs/phase0/REPORT.md)). |

## Layout

| Path | What it holds |
| --- | --- |
| `src/main/` | The main process: the window, security settings, the app:// protocol, the IPC handlers and the settings file. |
| `src/preload/` | The preload script: exposes the interface's only functions as `window.aba`. |
| `src/shared/` | The typed contract between the interface and the main process (`api.ts`), and the report's sections. |
| `src/renderer/` | The interface (React, Tailwind, Base UI, React Router, react-i18next). Tokens in `src/renderer/src/styles/tokens.css`, components in `src/renderer/src/components/`, strings in `src/renderer/src/i18n/`. |
| `src/lib/` | The Phase 0 provider layer (Claude, OpenAI, mock), pricing, prompt building and rules loading. Runs only in the main process and in scripts. |
| `rules/` | The writing rules sent to the model, versioned Markdown ([rules/README.md](rules/README.md)). Shipped next to the packaged app. |
| `fixtures/cases/` | Two invented cases. |
| `licenses/` | Licenses of what ships inside the app: the IBM Plex fonts' SIL Open Font License ([licenses/README.md](licenses/README.md)). Copied into the packaged app. |
| `scripts/` | `phase0.mts` and its spending cap, the fixture PDF renderer, and the dev server's style nonce (`dev-style-nonce.ts`). |
| `tests/` | Unit tests. |
| `e2e/` | Window tests (Playwright, Electron). |

How the processes fit together, what the interface may call and how the app is hardened: [docs/desktop.md](docs/desktop.md). How the interface is organized, where the design tokens and components live, and how to add a string in both languages: [docs/interface.md](docs/interface.md).

## Dependencies

Every package is a devDependency on purpose: electron-vite bundles everything that is not in `dependencies` into the build, so the provider SDKs and Zod end up inside the main-process bundle, the interface's libraries and fonts inside the interface's, and the packaged app ships no `node_modules`. A package that cannot be bundled (a native module, say) would go in `dependencies`.
