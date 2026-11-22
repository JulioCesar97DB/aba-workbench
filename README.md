# aba-workbench

A workbench for ABA professionals. First tool: draft the initial assessment section by section, to paste into ABA Matrix.

It is a desktop app for macOS and Windows (Electron, with a React interface built by Vite), running on the user's own computer. Status: the interface has its base screens, in Spanish and English. Cases are real: Home lists the cases in the cases folder and creates new ones, a case opens into its workspace, and Settings has the screen language, the cases folder and the AI connection: sign in with ChatGPT (the user's own ChatGPT plan, no API key) and paste a Claude API key, each checked with a free call. The workspace's first step, Sources, is built: pasted texts and PDFs, saved as they change; the other four steps are still placeholders, and no section is drafted with the AI connection yet. This repository only uses invented data.

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
| `pnpm test:e2e` | Builds the app and drives its window with Playwright: it opens on Home, a case is created, listed, and opened again after a restart, unreadable folders show as such, the cases folder changes in Settings, a case's sources are pasted, added from the dialog and by dropping PDFs, edited, removed and restored, the navigation reaches every screen, the language changes and survives a restart, the keyboard and a narrow window work, ChatGPT sign-in and the Claude key work on the AI connection screen with both providers faked, and the development check's mock generation streams to completion. Every test uses a temporary home folder or cases folder, never the real ones. Needs a display (`xvfb-run` on a Linux machine without one). `pnpm test:e2e:packaged` runs the same tests on the app from `pnpm package`. |
| `pnpm lint` / `pnpm typecheck` | ESLint; TypeScript for the Node side and for the interface, separately. |
| `pnpm test` | Unit tests (`node:test`): the provider layer, the rules, the spending cap, the main process's logic (the settings file, the case data file, folder names, durable writes, the cases folder, a case's sources, the credentials file and the ChatGPT sign-in included), both languages having the same strings, macOS's permission texts, and the design tokens' contrast. No keys, no network, no window. |
| `pnpm phase0 --mock` | The Phase 0 run on the mock provider: no key, no cost. Without `--mock` it calls the real providers with the keys in `.env.phase0` (see [docs/phase0/REPORT.md](docs/phase0/REPORT.md)). |

## Layout

| Path | What it holds |
| --- | --- |
| `src/main/` | The main process: the window, security settings, the app:// protocol, the IPC handlers, the settings file, the cases (`cases.ts`, `case-file.ts`, `case-folder-name.ts`, `cases-folder.ts`, `durable-write.ts`), a case's sources (`case-sources.ts`, `case-pdfs.ts`), and the AI connections (`connections.ts`, `credentials.ts`, `owner-only.ts`, `claude-key.ts`, `chatgpt-oauth.ts`, `oauth-callback.ts`, `chatgpt-session.ts`). |
| `src/preload/` | The preload script: exposes the interface's only functions as `window.aba`. |
| `src/shared/` | The typed contract between the interface and the main process (`api.ts`, `sources.ts`), and the report's sections. |
| `src/renderer/` | The interface (React, Tailwind, Base UI, React Router, react-i18next). Tokens in `src/renderer/src/styles/tokens.css`, components in `src/renderer/src/components/`, strings in `src/renderer/src/i18n/`. |
| `src/lib/` | The provider layer (Claude, OpenAI with an API key or the ChatGPT sign-in, mock), pricing, prompt building and rules loading. Runs only in the main process and in scripts. |
| `rules/` | The writing rules sent to the model, versioned Markdown ([rules/README.md](rules/README.md)). Shipped next to the packaged app. |
| `fixtures/cases/` | Two invented cases. |
| `packaging/macos/` | What macOS shows when the app first asks to open a protected folder the user chose (Documents, Desktop, Downloads, a drive, a cloud storage folder), in each language (`<language>.lproj/InfoPlist.strings`). |
| `licenses/` | Licenses of what ships inside the app: the IBM Plex fonts' SIL Open Font License ([licenses/README.md](licenses/README.md)). Copied into the packaged app. |
| `scripts/` | `phase0.mts` and its spending cap, the fixture PDF renderer, and the dev server's style nonce (`dev-style-nonce.ts`). |
| `tests/` | Unit tests. |
| `e2e/` | Window tests (Playwright, Electron). |

## Where cases live

Each case is a folder inside the cases folder: `ABA Workbench` in the user's home folder by default (`~/ABA Workbench` on macOS and Linux, `%USERPROFILE%\ABA Workbench` on Windows), or the folder chosen in Settings. The default is outside Documents on purpose: iCloud's "Desktop & Documents Folders" and OneDrive's folder backup often sync Documents, and the home folder itself is not synced by either (owner's decision, 2026-11-22; sources in [docs/desktop.md](docs/desktop.md#where)). The app makes the default folder when the first case is created, and never makes any other.

ABA Workbench sends nothing anywhere. If the cases folder is one that a cloud service syncs (OneDrive, iCloud, Dropbox, Google Drive), that service copies the cases; Settings says so where the folder is chosen.

```text
ABA Workbench/
├── Mateo F. initial assessment/   one case: its folder is named from its label
│   ├── aba-case.json              the case's data, its pasted texts included (below)
│   ├── vineland-3.pdf             its PDFs, copied in as they are: never converted or embedded
│   └── basc-3-prq.pdf
└── Sofía R. reassessment/
    └── aba-case.json
```

`aba-case.json` is JSON with a schema version, read back through Zod and written durably (a crash or a power cut leaves the old file or the new one, never half of either). Version 2 adds the case's sources: each pasted text lives in this file, and each PDF source names its copy in the folder.

```json
{
  "schemaVersion": 2,
  "id": "5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10",
  "label": "Mateo F. initial assessment",
  "clientAge": { "years": 4, "months": 2 },
  "createdAt": "2026-11-21T09:00:00.000Z",
  "updatedAt": "2026-11-21T09:12:00.000Z",
  "files": [{ "name": "vineland-3.pdf", "bytes": 182344, "modifiedAt": "2026-11-21T09:12:00.000Z" }],
  "sources": [
    {
      "id": "0d3c6a52-8a3e-4b8f-9d0e-6c1f2a7b5e44",
      "kind": "text",
      "type": "cde",
      "title": "CDE, psychologist's report",
      "date": "2026-10-02",
      "addedAt": "2026-11-21T09:05:00.000Z",
      "updatedAt": "2026-11-21T09:10:00.000Z",
      "text": "…the text as pasted…"
    },
    {
      "id": "6e2b1f0a-5c4d-4e3f-8a2b-1c0d9e8f7a65",
      "kind": "pdf",
      "type": "vineland-3",
      "addedAt": "2026-11-21T09:12:00.000Z",
      "updatedAt": "2026-11-21T09:12:00.000Z",
      "file": "vineland-3.pdf",
      "bytes": 182344
    }
  ]
}
```

A source removed from the case keeps its entry, with `"removedAt"`, and its PDF stays in the folder: nothing is deleted. A version 1 file (from before sources) reads as version 2 with no sources. Later phases add their own keys and raise the version, with a migration from the one before. A file from a newer version of the app is shown as unreadable and never written to; keys this version does not know are kept when it saves. The full rules (the schema, the versioning, the folder names, unreadable folders, the macOS permission) are in [docs/desktop.md](docs/desktop.md#cases).

## AI connections

ChatGPT connects with **Sign in with ChatGPT**: the user signs in in the system browser and allows ABA Workbench to use their own ChatGPT plan, with no API key, through OpenAI's flow for open-source apps that run on the user's computer. Claude connects with an **API key** the user pastes (Anthropic does not let other apps offer Claude.ai sign-in); it is checked with Anthropic before it is saved. Both live in `credentials.json` in the app's own data folder, readable by the user only, never sent to the interface, never logged. How each connection works step by step, the file's format, and exactly what goes to each provider and what never does: [docs/connections.md](docs/connections.md).

How the processes fit together, what the interface may call and how the app is hardened: [docs/desktop.md](docs/desktop.md). How the interface is organized, where the design tokens and components live, and how to add a string in both languages: [docs/interface.md](docs/interface.md).

## Dependencies

Every package is a devDependency on purpose: electron-vite bundles everything that is not in `dependencies` into the build, so the provider SDKs, Zod and jose (which verifies ChatGPT's ID tokens) end up inside the main-process bundle, the interface's libraries and fonts inside the interface's, and the packaged app ships no `node_modules`. A package that cannot be bundled (a native module, say) would go in `dependencies`.
