# The Windows installer and its release

How ABA Workbench reaches a Windows laptop: an installer downloaded from a public GitHub Release (owner's decisions, 2026-11-23). The clinician's own step-by-step guide, in Spanish, is kept outside the repository.

## The installer

`pnpm package:windows` builds it with electron-builder's NSIS target (`electron-builder.yml`, `win` and `nsis`): `dist/ABA-Workbench-Setup-<version>-windows-x64.exe`. The installer that is published is built on Windows, by the release workflow. On macOS, `dist/win-unpacked` builds reliably, but the installer step depends on electron-builder's bundled macOS `makensis`, an x86_64 program: it made the installer from this repository's working folder, and failed with exit code -1 in fresh clones under a long path. So a macOS build of the installer is a local experiment at most.

| What | How |
| --- | --- |
| Kind | One click: opening the installer installs and starts the app, with no wizard. |
| Who | The current Windows user only (`perMachine: false`), with no administrator rights. Installed in `%LOCALAPPDATA%\Programs\aba-workbench`; the uninstall entry is in the user's registry (`HKEY_CURRENT_USER`). |
| Shortcuts | Start menu and Desktop, both "ABA Workbench". |
| Architecture | x64 only. Windows on ARM runs it through emulation. |
| Icon | `packaging/windows/icon.ico`, drawn by `scripts/render-app-icon.mts` from the sidebar's colors (`node scripts/render-app-icon.mts` rewrites it; `--check` compares). |
| Identity | `appId: io.github.juliocesar97db.aba-workbench`. The installer derives its uninstall entry and the shortcuts' taskbar ID from it, and the packaged app sets the same ID (`src/main/index.ts`), so a pinned shortcut and the running window are one taskbar button. Changing it would make the next version install beside this one. |
| Signing | None. No certificate is configured anywhere, and the release workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false`; electron-builder logs "no code signing certificate configured, signing is skipped". Windows SmartScreen warns when each newly downloaded installer is opened, a later version's included ("Windows protected your PC"): More info, then Run anyway. |
| Languages | The installer's few words (its progress, "ABA Workbench is running", the uninstall question) follow Windows: Spanish or English. |
| Updates | Nothing updates itself: no update feed (`publish: null`, so no `latest.yml`) and no `.blockmap`. A newer installer, opened later, first runs the installed app's own uninstaller with `--updated` (which removes the install folder only), then installs; the release workflow runs that path and checks her files. |
| Electron fuses | None for the demo (owner's decision, 2026-11-23): turning off the inspector fuse would stop Playwright from driving the packaged app, so the packaged window tests could no longer test what ships. |

**Uninstalling never deletes what she made** (owner's decision, 2026-11-23). Settings, Apps, ABA Workbench, Uninstall (or the uninstaller in the install folder) removes the install folder, the two shortcuts and its registry entry. It keeps:

- the cases folder, `%USERPROFILE%\ABA Workbench` or the folder chosen in Settings;
- the app's data folder, `%APPDATA%\ABA Workbench`: settings, `credentials.json`, her standing instructions (`deleteAppDataOnUninstall: false`).

The uninstaller, and every newer installer, deletes the install folder whole. So the packaged app never keeps cases in it or under it, by any name (`installFolder` and `isInsideOnDisk` in `src/main/cases-folder.ts`):

- **As text**, without case on Windows and macOS, and on Windows with each name read as Win32 reads it (trailing dots and spaces dropped: `aba-workbench.\Casos` is `aba-workbench\Casos`).
- **By real path** (`fs.realpath.native`, which resolves symbolic links, junctions and 8.3 short names such as `ABA-WO~1`). A folder not made yet is resolved through the deepest part that exists.
- **By identity**: every folder from the real path up to its root is compared with the install folder by volume and file number (`stat` with `bigint`), which also catches names a real path does not unify (`\\localhost\C$\…`, a `subst` drive). A file number of 0 is never trusted.

A folder chosen in Settings or on Home is refused ("That folder is inside ABA Workbench's own program folder…"). A folder the settings already name (saved by hand, or by a version without this check) is checked whenever the app looks at the cases folder, at start first: Home and Settings report it (state `inside-app`, "The cases folder is inside ABA Workbench's own program folder…", in both languages), and nothing lists, reads or writes it. The same check covers the `.app` bundle on macOS. Tests: `tests/windows-installer.test.ts` (text, links, a junction, an 8.3 name, a trailing dot and `\\localhost\C$` on Windows, identity, a folder already in the settings) and `e2e/cases.e2e.ts` (the packaged app, a link from the home folder, a folder already in the settings).

## Publishing a release

`.github/workflows/release.yml`. It runs on every pull request, on a pushed tag `vX.Y.Z`, and by hand (Actions, Release, Run workflow; a manual run needs the file on the default branch).

1. **installer** (`windows-2025`, read-only token). For a tag, before anything is built: the tagged commit must be on `dev` or `main` (`git merge-base --is-ancestor`, with the full history fetched for tag runs only), and the tag must be `v` plus `package.json`'s version. A tag run installs its dependencies fresh, never from a cache another run wrote; pull requests restore `ci.yml`'s cache. Then lint, typecheck, unit tests, `pnpm phase0 --mock`, `pnpm package:windows`, and on the runner, in order (`scripts/windows-installer-check.ps1`):
   1. moves Documents and Desktop into `%USERPROFILE%\OneDrive` through the call OneDrive's folder backup uses (`SHSetKnownFolderPath`), as on a laptop where OneDrive backs them up;
   2. installs silently as the runner's user, and checks: unsigned installer and app, installed under `%LOCALAPPDATA%\Programs`, the uninstall entry in the user's registry only, both shortcuts opening the app, the writing rules in place, the app not started by a silent install;
   3. runs the packaged window tests (`pnpm test:e2e:packaged`) on the installed app (`ABA_PACKAGED_EXECUTABLE`, which the step requires, so the tests cannot fall back to `dist/win-unpacked`), each test with its own temporary profile and cases folder;
   4. puts Spanish first in Windows' languages;
   5. starts the installed app as she will (`e2e/windows-installed.e2e.ts`, only with `ABA_INSTALLED_APP_CHECK=1` on a CI runner, since it uses the machine's real folders): no settings file yet, the screen in Spanish, the default cases folder `%USERPROFILE%\ABA Workbench` although Documents and Desktop are in OneDrive, her first case written there, a cases folder inside the install folder refused, a (fake) Claude key saved into `%APPDATA%\ABA Workbench\credentials.json` with one access entry, hers, and the ChatGPT sign-in's listener bound to `127.0.0.1` only (`netstat`);
   6. the update path: adds a file of hers to the case and to the app's data folder, records every file in both, runs the same installer again over the installed app (which first runs the installed app's own uninstaller, as every later version's installer does), and checks that this uninstaller ran (a file it put in the install folder is gone), that the app and its shortcuts are back and every file in both folders is still there, byte for byte;
   7. uninstalls silently, and checks that the app, its shortcuts and its registry entry are gone while every file in both folders is still there, byte for byte;
   8. writes the installer's SHA-256 and keeps both files with the run (14 days).
2. **mac-installer** (`macos-26`, read-only token): the universal Mac disk image, built, mounted, started on both architectures and cleaned up ([docs/macos.md](macos.md#what-the-release-workflow-checks)).
3. **publish** (`ubuntu-24.04`), only for a version tag, after **installer** and **mac-installer** passed: the only job whose token can write (`contents: write`). It checks both SHA-256 files and creates a **pre-release** for the existing tag with `gh release create --verify-tag --prerelease`, attaching the Windows installer, the Mac disk image and their `.sha256`. It never creates a tag and never replaces a release that exists.

Third-party actions are pinned to full commit SHAs (`tests/windows-installer.test.ts` checks every workflow). No secret is used.

What gates publishing: this workflow's own checks, on Windows and macOS, and the rule that the tagged commit is on `dev` or `main`, whose commits `ci.yml` has checked on Linux, Windows and macOS (a pull request merges only once it passes). This workflow does not wait for `ci.yml`, so tag a commit whose `ci.yml` run passed. Recommended for the owner, in the repository's settings: a tag ruleset (Settings, Rules, Rulesets, New tag ruleset, target `v*`) that lets only the owner create, update or delete version tags.

If publishing fails halfway (a network error while `gh release create` uploads), a partial release can be left for the tag, and a re-run then fails because the release exists. Delete that release on its page (the tag stays), then re-run the failed jobs.

To publish, once the change is merged (the owner does this; no worker pushes a tag):

```sh
# package.json's version is the release's: 0.1.1 → tag v0.1.1
git switch dev && git pull
git tag v0.1.1
git push origin v0.1.1
```

The release page then has `ABA-Workbench-Setup-0.1.1-windows-x64.exe`, `ABA-Workbench-0.1.1-macos-universal.dmg` and a `.sha256` for each; the download link to give her is her system's file, as in the README's [Download](../README.md#download) section. For a later version, raise `version` in `package.json` first, then tag that, and change the README's links to the new version.

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
