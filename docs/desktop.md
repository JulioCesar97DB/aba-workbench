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

A generation belongs to the page that started it, and only that page can cancel it. When the page goes away (a reload, a navigation, a renderer crash, the window closing), its generations stop and nothing more is sent for them: once real providers are connected, a generation nobody can see would otherwise keep spending. A window runs at most two generations at once (`MAX_RUNNING_PER_WINDOW` in `src/main/generations.ts`); a third is refused.

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
- The provider SDKs are pinned to their official addresses (`https://api.anthropic.com`, `https://api.openai.com/v1`). A desktop app inherits the user's environment, and the SDKs read their base URL, extra headers, credentials, organization and telemetry settings from environment variables when not given them; each client is given every one of them explicitly, and its fetch refuses any other address. `src/lib/providers/endpoints.ts` lists each variable and how it is neutralised; `tests/endpoints.test.ts` sets them all and checks where the requests go and what they carry. Outside the SDKs, Node's own settings (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, proxy variables) still apply until Electron fuses are decided.

Not done yet, by decision: Electron fuses, code signing, installers, automatic updates.

## Where the rules are found

`src/main/paths.ts` decides: in development and in `pnpm preview`, the repository's `rules/` (next to `package.json`); in a packaged app, the `rules` folder that electron-builder copies into the app's resources folder (`ABA Workbench.app/Contents/Resources/rules` on macOS, `resources\rules` next to the `.exe` on Windows). A packaged build reads each rules file once; `pnpm dev` re-reads them on every generation, so edits show at once. Rules files parse with LF or CRLF line endings, and `.gitattributes` checks them out with LF everywhere.

## Packaging

`pnpm package` runs `electron-vite build` and `electron-builder --dir` with `electron-builder.yml`: an unpacked app for the current platform and architecture in `dist/`, unsigned, with the default Electron icon. The app archive holds only `out/` and `package.json`; the provider SDKs are bundled into `out/main/index.js`.

## macOS and Windows

The code builds paths with `node:path` and URLs with `node:url`; the only platform branches are Electron's usual ones in `src/main/index.ts` (on macOS the app stays open with no window; the Dock icon reopens one), each marked. `tests/main-process.test.ts` checks the rules folder and the app:// path checks with Windows paths as well as macOS ones. Locally everything was run on macOS (Apple silicon) only; CI runs every check, the window tests included, on Windows and Linux as well.

## Size of a request

Before anything is sent, `runGeneration` checks the request against its provider's documented limit (`src/lib/limits.ts`, one entry per provider next to its source; checked 2026-11-22). Over the limit, the generation ends with a `request_too_large` error whose message gives the request's size, the limit, and what to do: remove a PDF, or paste the text of a report instead of attaching its PDF. `pnpm phase0` runs the same check for every case before it spends anything.

| Provider | Documented limit | What is counted |
| --- | --- | --- |
| Claude | 128 MB per Messages request ([request size limits](https://platform.claude.com/docs/en/api/overview#request-size-limits), [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)) | The whole request: rules, sources with PDFs as base64, section request. |
| OpenAI | 50 MB of files per request, each file under 50 MB ([file inputs](https://developers.openai.com/api/docs/guides/file-inputs)) | The PDFs as sent, in base64. The page does not say whether a base64 file counts at its file size or its encoded size, so the stricter reading is used: about 37.5 MB of PDF fills it. The message gives both sizes in that order ("are 40.0 MB; sent to OpenAI they become 53.3 MB, over its 50 MB limit"), so it does not seem to contradict itself. |

Megabytes are decimal (1,000,000 bytes); the pages do not say which, and decimal is the smaller.

**Claude's page limit.** Claude reads at most 600 PDF pages in one request, or 100 when the request's context window is under 1M tokens; both models this project uses (Opus 5.5, Fable 5.2) have 1M-token windows, so 600 applies. Pages are not counted before sending: a reliable count needs a PDF parser (in current PDFs the page objects usually sit inside compressed object streams, and a regex count can also double-count pages kept from earlier revisions). Instead, when Claude refuses a request with an error shaped like that limit (it names PDFs and pages, and a word such as "maximum", "exceed" or "too many"), the message says Claude accepts 600 pages per request for the models this app uses, says what to do, and keeps Claude's own words. Anthropic's documentation does not give the exact wording of that error, so any other refusal keeps Claude's message as it is. A 413 from either provider gets the same kind of message.

The 4.5 MB cap that Phase 0 had was Vercel's request limit; it no longer exists (owner's decision, 2026-11-22).

## Tests

- `pnpm test`: unit tests with `node:test`, no window, no keys, no network. They cover the provider layer, the rules, the size limits, the spending cap and the main process's logic (rules folder, app:// paths, IPC sender checks, the generation registry).
- `pnpm test:e2e`: builds the app and drives its window with Playwright's Electron support (`e2e/`): the app starts, the development check shows, the interface has `window.aba` and no Node.js, a mock generation streams to completion with the rules found, a reload mid-stream stops the generation (nothing more arrives for it), and a third generation at once is refused. Each test starts the app with a temporary profile. It needs a display; on a Linux machine without one, run it under `xvfb-run`.
- `pnpm test:e2e:packaged`: the same tests against the unpacked app from `pnpm package`.

No test calls a real provider: the only generation the interface can start is the mock.

## Continuous integration

`.github/workflows/ci.yml` runs the same steps on Linux (`ubuntu-24.04`), Windows (`windows-2025`) and macOS (`macos-26`), with `fail-fast` off: install, lint, typecheck, unit tests, build, `pnpm phase0 --mock` and the window tests. On Linux the window tests run under `xvfb-run`, after a step that lets Chromium's sandbox use unprivileged user namespaces (Ubuntu 24.04 restricts them through AppArmor). No secrets; the token can only read the repository. It does not package the app.
