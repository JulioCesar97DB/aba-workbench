# The desktop app

How aba-workbench is put together since it moved from a hosted Next.js site to a desktop app (2026-11-22). Electron with a React interface built by Vite; electron-vite builds it and electron-builder packages it. Versions: see `package.json`.

## Processes

- **Main process** (`src/main/`, Node.js). Owns the window and everything with access to the computer: the provider layer in `src/lib/`, the rules files, the cases folder (every file operation on a case), and later the credentials file. Keys and tokens will live here and in that file, never in the interface.
- **Preload** (`src/preload/index.ts`). Runs sandboxed before the interface loads and exposes `window.aba`: the functions below and nothing else.
- **Interface** (`src/renderer/`, React; organized as described in [interface.md](interface.md)). Runs sandboxed, without Node.js. It can reach the main process only through `window.aba`. ESLint refuses imports of `electron`, `node:*` or main-process code in it (types excepted).

`pnpm phase0` runs the same provider layer from a plain Node script, through the same function the app uses (`runGeneration` in `src/lib/generate.ts`), with no window and no server.

## What the interface can call

Defined in `src/shared/api.ts`, exposed by the preload, answered in `src/main/ipc.ts`:

| Function | What it does |
| --- | --- |
| `getAppInfo()` | The app's name and version, and `developmentBuild`: true when it runs from the repository (not packaged), which shows the development check's link. |
| `getSettings()` | The saved screen language, or the default. (The cases folder's path is in the settings file too, but only `getCasesFolder` shows it.) |
| `setLanguage(language)` | Saves the screen language, `"en"` or `"es"`; anything else is refused. Returns the settings as saved. |
| `getCasesFolder()` | Where the cases are: the folder's path as text to show, whether it is the default, and whether it can be used (`ready`, `not-created-yet`, `missing`, `not-a-folder`, `not-allowed`, `not-writable`). |
| `chooseCasesFolder()` | Opens the system's folder dialog. A folder chosen there that can be used becomes the cases folder and is saved in the settings file; one that cannot is refused and nothing changes. Takes no argument. |
| `showCasesFolder()` | Opens the cases folder in Finder or Explorer. |
| `listCases()` | The cases in the cases folder, newest first, and the folders there that cannot be opened, with the reason. |
| `createCase({ label, clientAge })` | Makes a case's folder and data file. The label must pass `checkCaseLabel`; the age is `{ years, months? }` or nothing. |
| `openCase(caseId)` | Reads a case by its id, and saves its list of PDFs if the folder's PDFs changed. |
| `showUnreadableFolder(folderName)` | Shows a folder Home lists as unreadable in Finder or Explorer, selected. |
| `startMockGeneration(generationId)` | Development check: runs the mock provider (no AI call, no key, no cost) with the real prompt builder and rules. The interface picks the id, a UUID. |
| `cancelGeneration(generationId)` | Stops a running generation. |
| `onGenerationUpdate(listener)` | Receives each generation's events (meta, status, text, done, error...) and a final `finished`; returns the function that unsubscribes. |

A generation belongs to the page that started it, and only that page can cancel it. When the page goes away (a reload or another navigation that actually happens, a renderer crash, the window closing), its generations stop and nothing more is sent for them: once real providers are connected, a generation nobody can see would otherwise keep spending. A navigation the app blocks (a link, a dropped file) leaves the page, and its generations, where they are; only a navigation that commits (`did-navigate`) counts. A window runs at most two generations at once (`MAX_RUNNING_PER_WINDOW` in `src/main/generations.ts`); a third is refused.

Rules for adding to it: one narrow function per action, plain data in and out, no generic "invoke anything", and never a key, a token or a file path the user did not choose. Each handler first checks that the message comes from the top frame of the app's own window, showing the app's own origin.

No function takes a path. A case is named by its id (a UUID, checked with `isCaseId`), an unreadable folder by its name inside the cases folder (one plain name, no separators, `.` or `..`), and a new cases folder only ever comes from the system's dialog, which the main process opens. Every argument is checked again in the main process with Zod, whatever the interface checked: wrong types, unknown keys, huge strings (capped before anything else looks at them) and paths are refused with a message that starts with "Refused:" and holds nothing from the disk. Expected outcomes (a missing folder, a damaged case) come back as values the interface explains; anything unexpected reaches it as a fixed sentence, with the details only in the main process's log. The cases folder's path is the one path the interface receives, as text to show the user where their cases are (owner's decision, 2026-11-22); nothing accepts it back.

## Security settings

Following Electron's security checklist (https://www.electronjs.org/docs/latest/tutorial/security):

- Context isolation on, sandbox on (also forced app-wide with `app.enableSandbox()`), no Node.js integration in the interface.
- A content security policy in `src/renderer/index.html`: only the app's own scripts, styles, images and fonts; no inline scripts or styles, no eval, no outside connections, no frames. Two changes made with the interface's base (owner's decision, 2026-11-22): `font-src 'self'`, so the IBM Plex fonts that ship inside the app can load (nothing comes from the network); and, under `pnpm dev` only, `scripts/dev-style-nonce.ts` adds a nonce, new on each run, to `style-src`, because Vite's dev server injects stylesheets as `<style>` elements. A built or packaged app carries the policy exactly as written in `index.html`; a window test checks it, and `tests/dev-style-nonce.test.ts` checks the plugin applies to the dev server only. Base UI's own inline styles are turned off (`CSPProvider`), so they need no exception.
- Navigation, redirects, new windows and `<webview>` are blocked for every page (`src/main/security.ts`). The interface moves between screens with React Router, which keeps the address in the URL's hash: a hash change stays inside the page and is not a navigation, so it is not blocked and does not stop a running generation.
- Every permission request and check (camera, microphone, notifications, devices...) is denied.
- The built interface is served from `app://aba-workbench/` rather than `file://` (`src/main/protocol.ts`); only files inside the built interface can be reached through it.
- IPC senders are validated (see above). Errors that reach the interface carry a safe message, never a path, a key or a request body.
- A packaged app ignores `ELECTRON_RENDERER_URL`, so an environment variable cannot point its window at another page.
- The provider SDKs are pinned to their official addresses (`https://api.anthropic.com`, `https://api.openai.com/v1`). A desktop app inherits the user's environment, and the SDKs read their base URL, extra headers, credentials, organization and telemetry settings from environment variables when not given them; each client is given every one of them explicitly. Its fetch sends nothing outside the official address and never follows a redirect: a redirect would re-send the request, documents included, to wherever it points, so a redirect answer is refused. `src/lib/providers/endpoints.ts` lists each variable and how it is neutralised; `tests/endpoints.test.ts` sets them all and checks where the requests go and what they carry. Outside the SDKs, Node's own settings (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, proxy variables) still apply until Electron fuses are decided.

Not done yet, by decision: Electron fuses, code signing, installers, automatic updates.

## Where the rules are found

`src/main/paths.ts` decides: in development and in `pnpm preview`, the repository's `rules/` (next to `package.json`); in a packaged app, the `rules` folder that electron-builder copies into the app's resources folder (`ABA Workbench.app/Contents/Resources/rules` on macOS, `resources\rules` next to the `.exe` on Windows). A packaged build reads each rules file once; `pnpm dev` re-reads them on every generation, so edits show at once. Rules files parse with LF or CRLF line endings, and `.gitattributes` checks them out with LF everywhere.

## The settings file

`src/main/settings.ts` keeps the user's settings in `settings.json` in the app's data folder (`app.getPath("userData")`: `~/Library/Application Support/ABA Workbench` on macOS, `%APPDATA%\ABA Workbench` on Windows, `~/.config/ABA Workbench` on Linux). It holds the screen language and, once the user has chosen one in Settings, the cases folder: `{ "version": 1, "language": "es", "casesFolder": "/Users/ana/Casos" }`. The default cases folder is not written, so it follows Documents. Only the main process reads or writes it; the interface asks through `getSettings`, `setLanguage`, `getCasesFolder` and `chooseCasesFolder`. A cases folder in the file that is not an absolute path is ignored, never guessed at.

- Read back through Zod, field by field: a missing file means a first run (the language follows the system's preferred languages, Spanish or else English); a file that is not JSON, or holds a value this version does not know, falls back to the defaults for what it cannot use and keeps the rest. The main-process log says so; the next change rewrites the file whole.
- Written durably (`src/main/durable-write.ts`, shared with the cases): a temporary file next to it, flushed to the disk (`datasync`), renamed over it, then the folder flushed so the rename itself survives a power cut (on macOS and Linux; Windows cannot open a folder for that, and NTFS journals the rename). A crash or a power cut mid-save leaves the old file or the new one, never half of either. A failed save removes the temporary file and reports a safe message to the interface, which still shows the chosen language for the session and says it was not saved. Saves run one after another.
- When a language cannot be saved, the interface asks the main process which language is saved (the one the app will open in next time) rather than assuming it is the one that was on screen, and the sidebar and Settings read the same state (`src/renderer/src/language.tsx`), so after several failures in a row both name the right language.
- `tests/settings.test.ts` covers a first run, a corrupt file, an outdated one, refused values, the cases folder (kept, refused when not absolute, not written when it is the default), quick successive saves, a save that cannot replace the file (no temporary file left) and a failed save.

## Cases

Each case is a folder inside the cases folder, holding its data file, `aba-case.json`, and its PDFs as they are (never converted or embedded). Only the main process touches them (`src/main/cases.ts`); the interface names a case by its id.

### Where

The cases folder is `Documents/ABA Workbench` (`app.getPath("documents")`) unless the user chose another in Settings, through the system's folder dialog; the choice is saved in the settings file. `src/main/cases-folder.ts` checks it before use and reports one of: `ready`; `not-created-yet` (the default, not made yet, inside a Documents folder that exists); `missing` (a chosen folder that is gone, an unplugged drive say, or no Documents folder); `not-a-folder`; `not-allowed` (the system refuses to let the app look inside: on macOS, the answer to the Documents prompt was no); `not-writable`. On macOS and Linux "writable" is the permission bits; on Windows, where access rights and Controlled folder access decide, it is checked by making one empty file and removing it at once.

The app never creates a folder in a place the user did not expect. The default folder is made, one level only, inside an existing Documents folder, when the first case is created. A chosen folder that has gone missing is reported, with a way to choose another, and is never made again.

The window tests start the app with `--documents-folder=<a temporary folder>`, which moves where the default cases folder goes (it must be an absolute path), so no test reads or writes the real Documents folder. It only changes the default; a folder chosen in Settings wins. It is a command-line switch rather than an environment variable so nothing inherits it by accident; anyone who can pass it could equally edit the settings file.

### The data file

`src/main/case-file.ts`. Schema version 1 holds what Phase 1 needs and no more:

| Key | What it holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `id` | A version 4 UUID, lowercase, made when the case is created. The interface uses it in the case's address (`#/cases/<id>/sources`). |
| `label` | What the user typed: Unicode NFC, no spaces at either end, 1 to 100 characters, no control or text-direction characters (`checkCaseLabel` in `src/shared/api.ts`). |
| `clientAge` | `{ "years": 0-120, "months": 0-11 }`, `months` optional; left out when the user gave no age. |
| `createdAt`, `updatedAt` | ISO 8601 in UTC. `updatedAt` moves on every save, always forward (a millisecond past the last one if the clock says otherwise). |
| `files` | The PDFs at the top of the case's folder: `{ name, bytes, modifiedAt }`, by name. Hidden files and links are left out. Opening a case refreshes the list and saves the case if it changed. |

Later phases add their own top-level keys (sources, behaviors, drafts) and raise `schemaVersion`.

**Versioning.** `CASE_SCHEMA_VERSION` is the version this app writes. Reading a file: a higher version (a newer app wrote it) is unreadable as "newer-version" and never written to; a lower one is migrated in memory, one version at a time (`MIGRATIONS[n]` turns version n into n+1; there are none yet), and written in the current version only when the case is next saved; a missing step, or a version that is not a positive whole number, makes it damaged. A key this version does not know (at the top or on a file entry) is kept as it is when the case is saved. To change the shape: raise `CASE_SCHEMA_VERSION`, add the step to `MIGRATIONS`, update the schema, and add a test that an old file migrates.

**Saving.** Every write goes through `writeFileDurably` (see the settings file above). Saves of one case run one after another. `CaseLibrary.update(id, change)` is the save later phases use: it reads the case as on disk, applies the change, moves `updatedAt` and writes it durably. There is no editing screen in this phase (owner's decision, 2026-11-22): a case is saved when it is created, and when opening it finds its PDFs changed.

### Folder names

`src/main/case-folder-name.ts`, from the label (owner's decision, 2026-11-22): Unicode NFC; the characters Windows forbids (`< > : " / \ | ? *`) and control characters become `-`; runs of spaces collapse to one; dots and spaces at the start and at the end go; at most 60 characters, cut between whole characters; an empty result becomes `Case`; a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`, also with superscript digits, any case, with or without an extension) gets ` case` after it. A name already in the cases folder, compared ignoring case and Unicode form (as macOS and Windows do), gets ` 2`, ` 3` and so on. The folder is made with an exclusive create, so an existing folder is never touched, even one that appears between the check and the create; if the data file then cannot be written, the new empty folder is removed.

### Unreadable folders

`listCases` reads every folder at the top of the cases folder (hidden folders and loose files are left out). A folder it cannot open as a case is listed below the cases, under "Folders that could not be opened", with the reason in plain words and a "Show in Finder" ("Show in Explorer" on Windows) button (owner's decision, 2026-11-22): `not-a-case` (no `aba-case.json`), `damaged` (not JSON, a value missing or wrong, a data file larger than 5 MB, a folder or a link in its place), `newer-version`, `duplicate` (the same id as a case listed before it, by folder name: a copied folder), `cannot-read` (the system refused). The app never changes such a folder; one bad folder never hides the others.

### macOS's permission to open Documents

macOS asks the user before an app opens Documents (and the Desktop, Downloads, an external or a network drive). The packaged app's `Info.plist` carries `NSDocumentsFolderUsageDescription` and the four others in plain words (`electron-builder.yml`, `mac.extendInfo`), and `packaging/macos/<language>.lproj/InfoPlist.strings` gives them in English and Spanish (`es` and `es_419`, which a Mac set to Latin American Spanish looks in first); `tests/packaging.test.ts` keeps them in step and the packaged window tests check they ship. If the user says no, reading the folder fails with `EPERM`: Home and Settings say ABA Workbench is not allowed to open the cases folder, how to allow it (System Settings, Privacy & Security, Files and Folders), and offer to choose another folder. A folder chosen in the dialog is one the user picked, so macOS lets the app open it.

## Packaging

`pnpm package` runs `electron-vite build` and `electron-builder --dir` with `electron-builder.yml`: an unpacked app for the current platform and architecture in `dist/`, unsigned, with the default Electron icon. The app archive holds only `out/` and `package.json`; the provider SDKs and Zod are bundled into `out/main/index.js`, and the interface, with its fonts, is in `out/renderer/`. Next to the archive, in the resources folder, are `rules/` and `licenses/` (the IBM Plex fonts' SIL Open Font License, which must travel with them; the packaged window tests check it is there).

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

- `pnpm test`: unit tests with `node:test`, no window, no keys, no network. They cover the provider layer, the rules, the size limits, the spending cap, the main process's logic (rules folder, app:// paths, IPC sender checks, the generation registry, the settings file), the cases (`tests/cases.test.ts`: the data file's schema, every kind of damaged and newer file, the version migration chain, folder names, durable writes, the cases folder's states, creating, listing, opening and saving, and hostile input), macOS's permission texts (`tests/packaging.test.ts`), both languages having the same strings, the design tokens' contrast and the dev server's style nonce.
- `pnpm test:e2e`: builds the app and drives its window with Playwright's Electron support (`e2e/`). `shell.e2e.ts`: the app opens on Home; the built page carries the content security policy as written and loads its own fonts, with no policy violation while dialogs, selects and tooltips open; the navigation reaches every screen; switching the language changes the screen, marks English terms, and survives a restart; a corrupt settings file does not stop the app; a language that cannot be saved still changes the screen and says so; moving into and out of a case announces the new screen and keeps the focus on it; in the packaged app, the fonts' license is in the resources folder; the keyboard reaches everything with a visible focus ring; a narrow window swaps the sidebar for a Menu panel and nothing spills sideways. `cases.e2e.ts`: a case is created from Home (its folder and data file on disk), listed, and opened again after a restart; the form checks the label and the age, in Spanish too; two cases with one label get two folders, newest first; folders that are not cases, damaged, from a newer version or copied show as unreadable and are left exactly as they were; a PDF put into a case's folder shows when it is opened again and the case is saved; the cases folder changes in Settings and is remembered; a missing cases folder is reported, not made, and another can be chosen; the interface's functions refuse hostile input with messages that hold no path; the packaged macOS app carries its permission texts. The folder dialog and Finder are replaced in these tests, so no window opens. `dev-check.e2e.ts`: the interface has `window.aba` and no Node.js, a mock generation streams to completion with the rules found, a navigation the app blocks leaves a running generation alone, a reload mid-stream stops it (nothing more arrives for it), and a third generation at once is refused. Each test starts the app with a temporary profile, with English written into its settings file unless the test says otherwise, and with a temporary Documents folder (`--documents-folder`), so no test touches the real one. It needs a display; on a Linux machine without one, run it under `xvfb-run`.
- `pnpm test:e2e:packaged`: the same tests against the unpacked app from `pnpm package`.

No test calls a real provider: the only generation the interface can start is the mock.

## Continuous integration

`.github/workflows/ci.yml` runs the same steps on Linux (`ubuntu-24.04`), Windows (`windows-2025`) and macOS (`macos-26`), with `fail-fast` off: install, lint, typecheck, unit tests, build, `pnpm phase0 --mock` and the window tests. On Linux the window tests run under `xvfb-run`, after a step that lets Chromium's sandbox use unprivileged user namespaces (Ubuntu 24.04 restricts them through AppArmor). Then `pnpm package` assembles the unpacked app on each system, and the window tests run again on it (`pnpm test:e2e:packaged`). No installer, no signing, no secrets; the token can only read the repository.
