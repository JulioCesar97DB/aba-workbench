# aba-workbench

A workbench for ABA professionals. First tool: draft the initial assessment section by section, to paste into ABA Matrix.

It is a desktop app for macOS and Windows (Electron, with a React interface built by Vite), running on the user's own computer. Status: the move from the Phase 0 Next.js site to the desktop app is done; the only screen is a development check. This repository only uses invented data.

Requirements: Node.js 24 or later; pnpm comes from the `packageManager` field in `package.json`.

License: Apache License 2.0 (see [LICENSE](LICENSE)).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs the dependencies. Electron's own binary (about 100 MB) is downloaded the first time the app starts. |
| `pnpm dev` | Opens the desktop window, with the interface reloading on save. `pnpm dev --watch` also rebuilds and restarts the app when the main process or the preload changes. |
| `pnpm build` | Builds the main process, the preload and the interface into `out/`. |
| `pnpm preview` | Starts the built app from `out/`. |
| `pnpm package` | Builds, then packages an unpacked app for the current platform into `dist/` (`dist/mac-arm64/ABA Workbench.app`, `dist/win-unpacked/ABA Workbench.exe`). No installer and no signing yet. |
| `pnpm lint` / `pnpm typecheck` | ESLint; TypeScript for the Node side and for the interface, separately. |
| `pnpm test` | Unit tests (`node:test`): the provider layer, the rules, the spending cap and the main process's logic. No keys, no network, no window. |
| `pnpm phase0 --mock` | The Phase 0 run on the mock provider: no key, no cost. Without `--mock` it calls the real providers with the keys in `.env.phase0` (see [docs/phase0/REPORT.md](docs/phase0/REPORT.md)). |

## Layout

| Path | What it holds |
| --- | --- |
| `src/main/` | The main process: the window, security settings, the app:// protocol and the IPC handlers. |
| `src/preload/` | The preload script: exposes the interface's only functions as `window.aba`. |
| `src/shared/api.ts` | The typed contract between the interface and the main process. |
| `src/renderer/` | The interface (React). Today a single development-check screen. |
| `src/lib/` | The Phase 0 provider layer (Claude, OpenAI, mock), pricing, prompt building and rules loading. Runs only in the main process and in scripts. |
| `rules/` | The writing rules sent to the model, versioned Markdown ([rules/README.md](rules/README.md)). Shipped next to the packaged app. |
| `fixtures/cases/` | Two invented cases. |
| `scripts/` | `phase0.mts` and its spending cap, and the fixture PDF renderer. |
| `tests/` | Unit tests. |

How the processes fit together, what the interface may call and how the app is hardened: [docs/desktop.md](docs/desktop.md).

## Dependencies

Every package is a devDependency on purpose: electron-vite bundles everything that is not in `dependencies` into the build, so the provider SDKs end up inside the main-process bundle and the packaged app ships no `node_modules`. A package that cannot be bundled (a native module, say) would go in `dependencies`.
