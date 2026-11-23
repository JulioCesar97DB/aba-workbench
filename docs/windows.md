# The Windows installer and its release

How ABA Workbench reaches a Windows laptop: an installer downloaded from a public GitHub Release (owner's decisions, 2026-11-23). The clinician's own step-by-step guide, in Spanish, is kept outside the repository.

## The installer

`pnpm package:windows` builds it with electron-builder's NSIS target (`electron-builder.yml`, `win` and `nsis`): `dist/ABA-Workbench-Setup-<version>-windows-x64.exe`. It builds on Windows, and on macOS too (electron-builder edits the executable's resources in JavaScript, no Wine), but only the release workflow's build, on Windows, is the one published.

| What | How |
| --- | --- |
| Kind | One click: opening the installer installs and starts the app, with no wizard. |
| Who | The current Windows user only (`perMachine: false`), with no administrator rights. Installed in `%LOCALAPPDATA%\Programs\aba-workbench`; the uninstall entry is in the user's registry (`HKEY_CURRENT_USER`). |
| Shortcuts | Start menu and Desktop, both "ABA Workbench". |
| Architecture | x64 only. Windows on ARM runs it through emulation. |
| Icon | `packaging/windows/icon.ico`, drawn by `scripts/render-app-icon.mts` from the sidebar's colors (`node scripts/render-app-icon.mts` rewrites it; `--check` compares). |
| Identity | `appId: io.github.juliocesar97db.aba-workbench`. The installer derives its uninstall entry and the shortcuts' taskbar ID from it, and the packaged app sets the same ID (`src/main/index.ts`), so a pinned shortcut and the running window are one taskbar button. Changing it would make the next version install beside this one. |
| Signing | None. No certificate is configured anywhere, and the release workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false`; electron-builder logs "no code signing certificate configured, signing is skipped". Windows SmartScreen warns the first time ("Windows protected your PC"): More info, then Run anyway. |
| Languages | The installer's few words (its progress, "ABA Workbench is running", the uninstall question) follow Windows: Spanish or English. |
| Updates | None. No update feed (`publish: null`, so no `latest.yml`) and no `.blockmap`. A newer installer, opened later, replaces the app in place. |
| Electron fuses | None for the demo (owner's decision, 2026-11-23): turning off the inspector fuse would stop Playwright from driving the packaged app, so the packaged window tests could no longer test what ships. |

**Uninstalling never deletes what she made** (owner's decision, 2026-11-23). Settings, Apps, ABA Workbench, Uninstall (or the uninstaller in the install folder) removes the install folder, the two shortcuts and its registry entry. It keeps:

- the cases folder, `%USERPROFILE%\ABA Workbench` or the folder chosen in Settings;
- the app's data folder, `%APPDATA%\ABA Workbench`: settings, `credentials.json`, her standing instructions (`deleteAppDataOnUninstall: false`).

The uninstaller, and every newer installer, deletes the install folder whole. So Settings refuses a cases folder in it or under it ("That folder is inside ABA Workbench's own program folder…", in both languages; `installFolder` and `isSameOrInside` in `src/main/cases-folder.ts`, compared without case on Windows and macOS). The same check covers the `.app` bundle on macOS.

## Publishing a release

`.github/workflows/release.yml`. It runs on every pull request, on a pushed tag `vX.Y.Z`, and by hand (Actions, Release, Run workflow; a manual run needs the file on the default branch).

1. **installer** (`windows-2025`, read-only token): checks that a tag is `v` plus `package.json`'s version (otherwise it stops before building), then lint, typecheck, unit tests, `pnpm phase0 --mock`, `pnpm package:windows`, and on the runner, in order (`scripts/windows-installer-check.ps1`):
   1. moves Documents and Desktop into `%USERPROFILE%\OneDrive` through the call OneDrive's folder backup uses (`SHSetKnownFolderPath`), as on a laptop where OneDrive backs them up;
   2. installs silently as the runner's user, and checks: unsigned installer and app, installed under `%LOCALAPPDATA%\Programs`, the uninstall entry in the user's registry only, both shortcuts opening the app, the writing rules in place, the app not started by a silent install;
   3. runs the packaged window tests (`pnpm test:e2e:packaged`) on the installed app (`ABA_PACKAGED_EXECUTABLE`), each test with its own temporary profile and cases folder;
   4. puts Spanish first in Windows' languages;
   5. starts the installed app as she will (`e2e/windows-installed.e2e.ts`, only with `ABA_INSTALLED_APP_CHECK=1` on a CI runner, since it uses the machine's real folders): no settings file yet, the screen in Spanish, the default cases folder `%USERPROFILE%\ABA Workbench` although Documents and Desktop are in OneDrive, her first case written there, a cases folder inside the install folder refused, a (fake) Claude key saved into `%APPDATA%\ABA Workbench\credentials.json` with one access entry, hers, and the ChatGPT sign-in's listener bound to `127.0.0.1` only (`netstat`);
   6. adds a file of hers to the case and to the app's data folder, uninstalls silently, and checks that the app, its shortcuts and its registry entry are gone while every file in both folders is still there, byte for byte;
   7. writes the installer's SHA-256 and keeps both files with the run (14 days).
2. **publish** (`ubuntu-24.04`), only for a version tag, after **installer** passed: the only job whose token can write (`contents: write`). It checks the SHA-256 and creates a **pre-release** for the existing tag with `gh release create --verify-tag --prerelease`, attaching the installer and its `.sha256`. It never creates a tag and never replaces a release that exists.

Third-party actions are pinned to full commit SHAs (`tests/windows-installer.test.ts` checks every workflow). No secret is used.

To publish, once the change is merged (the owner does this; no worker pushes a tag):

```sh
# package.json's version is the release's: 0.1.0 → tag v0.1.0
git switch dev && git pull
git tag v0.1.0
git push origin v0.1.0
```

The release page then has `ABA-Workbench-Setup-0.1.0-windows-x64.exe` and `ABA-Workbench-Setup-0.1.0-windows-x64.exe.sha256`; the download link to give her is the `.exe`'s. For a later version, raise `version` in `package.json` first, then tag that.

## Windows readiness

What the code does on Windows, and where each is checked.

| Concern | What the app does | Checked |
| --- | --- | --- |
| Default cases folder | `ABA Workbench` in `app.getPath("home")`, the profile folder (`%USERPROFILE%`), which OneDrive's folder backup never moves; Documents and Desktop are not used. | Release workflow, step 5, with Documents and Desktop in OneDrive. |
| A user name with spaces or accents | Paths are built with `node:path`; Node and Electron use Windows' Unicode calls; `icacls` and `whoami` are run with their arguments passed as such, never through a shell. | Every window test's profile, home and cases folder are under a folder named with "Ana María Pérez" (`e2e/app.ts`), on Windows, macOS and Linux, built and packaged, so the credentials file's access list is set under such a path on Windows. The runner's own user name is plain ASCII. |
| Credentials file | One access entry, the user's, nothing inherited (`src/main/owner-only.ts`, `icacls /restore`). | Unit tests on Windows (`tests/credentials.test.ts`); release workflow, step 5, in the real `%APPDATA%`. |
| PDFs | Opened in Windows' default PDF app (`shell.openPath`) after checking it is a PDF of the case; the app has no PDF reader of its own. PDFs go to the AI as files. | Window tests (the system call recorded, not made). Which app opens them is her laptop's choice. |
| ChatGPT sign-in | The system browser; a one-time listener on `127.0.0.1` only, port 1455 or a free one. Windows Defender Firewall asks only when a program listens on a network address, not on the loopback. | Window tests (faked OpenAI); release workflow, step 5 (`netstat`). |
| Screen language | The first start follows Windows' preferred languages (`defaultLanguage`): Spanish if Spanish comes before English. | Unit tests; release workflow, steps 4 and 5. |
| macOS only | The Dock, the app menu, `--hidden`'s Dock handling and the folder-permission texts are each behind a platform check; "Show in Explorer" is the Windows wording. | Reading the code; the window tests run on Windows in `ci.yml` and here. |

Only her laptop can show:

- SmartScreen's warning and its "Run anyway" (Microsoft's reputation service decides what it shows for an unsigned download; an antivirus other than Microsoft Defender may also ask or quarantine).
- That her Windows account can install per user (an organization's policy, AppLocker or Smart App Control, can block unsigned apps).
- Her real OneDrive setup, a user name with accents in the profile folder itself, and the app's look at her screen's scaling.
- Which app opens a PDF.
- The ChatGPT sign-in in her default browser with her own account, and whether her plan allows ABA Workbench (a free account was refused in the owner's test; a paid plan may be needed).
- No firewall prompt at sign-in with her security software.
