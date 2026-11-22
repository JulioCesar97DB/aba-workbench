# The desktop app

How aba-workbench is put together since it moved from a hosted Next.js site to a desktop app (2026-11-22). Electron with a React interface built by Vite; electron-vite builds it and electron-builder packages it. Versions: see `package.json`.

## Processes

- **Main process** (`src/main/`, Node.js). Owns the window and everything with access to the computer: the provider layer in `src/lib/`, the rules files, and later the cases folder and the credentials file. Keys and tokens will live here and in that file, never in the interface.
- **Preload** (`src/preload/index.ts`). Runs sandboxed before the interface loads and exposes `window.aba`: the functions below and nothing else.
- **Interface** (`src/renderer/`, React). Runs sandboxed, without Node.js. It can reach the main process only through `window.aba`. ESLint refuses imports of `electron`, `node:*` or main-process code in it (types excepted).

`pnpm phase0` runs the same provider layer from a plain Node script, through the same function the app uses (`runGeneration` in `src/lib/generate.ts`), with no window and no server.

## What the interface can call

Defined in `src/shared/api.ts`, exposed by the preload, answered in `src/main/ipc.ts`:

| Function | What it does |
| --- | --- |
| `getAppInfo()` | The app's name and version. |
| `startMockGeneration(generationId)` | Development check: runs the mock provider (no AI call, no key, no cost) with the real prompt builder and rules. The interface picks the id, a UUID. |
| `cancelGeneration(generationId)` | Stops a running generation. |
| `onGenerationUpdate(listener)` | Receives each generation's events (meta, status, text, done, error...) and a final `finished`; returns the function that unsubscribes. |

Rules for adding to it: one narrow function per action, plain data in and out, no generic "invoke anything", and never a key, a token or a file path the user did not choose. Each handler first checks that the message comes from the top frame of the app's own window, showing the app's own origin.

## Security settings

Following Electron's security checklist (https://www.electronjs.org/docs/latest/tutorial/security):

- Context isolation on, sandbox on (also forced app-wide with `app.enableSandbox()`), no Node.js integration in the interface.
- A content security policy in `src/renderer/index.html`: only the app's own scripts, styles and images; no inline scripts, no eval, no outside connections, no frames.
- Navigation, redirects, new windows and `<webview>` are blocked for every page (`src/main/security.ts`).
- Every permission request and check (camera, microphone, notifications, devices...) is denied.
- The built interface is served from `app://aba-workbench/` rather than `file://` (`src/main/protocol.ts`); only files inside the built interface can be reached through it.
- IPC senders are validated (see above). Errors that reach the interface carry a safe message, never a path, a key or a request body.
- A packaged app ignores `ELECTRON_RENDERER_URL`, so an environment variable cannot point its window at another page.

Not done yet, by decision: Electron fuses, code signing, installers, automatic updates.

## Where the rules are found

`src/main/paths.ts` decides: in development and in `pnpm preview`, the repository's `rules/` (next to `package.json`); in a packaged app, the `rules` folder that electron-builder copies into the app's resources folder (`ABA Workbench.app/Contents/Resources/rules` on macOS, `resources\rules` next to the `.exe` on Windows). A packaged build reads each rules file once; `pnpm dev` re-reads them on every generation, so edits show at once. Rules files parse with LF or CRLF line endings, and `.gitattributes` checks them out with LF everywhere.

## Packaging

`pnpm package` runs `electron-vite build` and `electron-builder --dir` with `electron-builder.yml`: an unpacked app for the current platform and architecture in `dist/`, unsigned, with the default Electron icon. The app archive holds only `out/` and `package.json`; the provider SDKs are bundled into `out/main/index.js`.

## macOS and Windows

The code builds paths with `node:path` and URLs with `node:url`; the only platform branches are Electron's usual ones in `src/main/index.ts` (on macOS the app stays open with no window; the Dock icon reopens one), each marked. `tests/main-process.test.ts` checks the rules folder and the app:// path checks with Windows paths as well as macOS ones. Everything here was run on macOS (Apple silicon) only; nothing has been run on Windows yet.

## Size of a request

The 4.5 MB cap on a request (`src/lib/limits.ts`) came from Vercel and has no reason left in a desktop app. What replaces it is open with the owner; until then it stays a plain function with its limit in one place.
