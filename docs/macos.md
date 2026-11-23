# The Mac disk image and its release

How ABA Workbench reaches a Mac: one universal disk image on the same public GitHub Release as the Windows installer (owner's decisions, 2026-11-23). How she installs it, step by step, is in the README's [Download](../README.md#download) section; how a release is published is in [docs/windows.md](windows.md#publishing-a-release).

## The disk image

`pnpm package:mac` builds it with electron-builder (`electron-builder.yml`, `mac` and `dmg`): `dist/ABA-Workbench-<version>-macos-universal.dmg`. The one that is published is built on macOS by the release workflow. Building it locally needs nothing but a Mac, but it mounts disk images while it works; the workflow's checks start the app, so they run only on a CI runner, never on someone's own Mac.

| What | How |
| --- | --- |
| Kind | A disk image with electron-builder's default window: the app, and a shortcut to Applications to drag it onto. The volume is named "ABA Workbench <version>". |
| Architecture | One universal app, for Apple Silicon (arm64) and Intel (x86_64): electron-builder packages the app for each and merges them with `@electron/universal`. Every executable and library in it has both slices. The two app archives are the same (no native module ships), so they merge as one. |
| Minimum macOS | Electron's own, not overridden: macOS 13 Ventura for Electron 45 (`LSMinimumSystemVersion` 13.0). |
| Icon | `packaging/macos/icon.icns`, the same drawing as the Windows icon, from `scripts/render-app-icon.mts` (`node scripts/render-app-icon.mts` rewrites both; `--check` compares). |
| Identity | `appId: io.github.juliocesar97db.aba-workbench`, the bundle identifier and the signature's identifier. The app's data folder is `~/Library/Application Support/ABA Workbench`. |
| Signing | Ad-hoc only (`mac.identity: "-"`): `codesign --sign -` on every executable, no certificate, no Apple Developer account, no notarization. Apple Silicon runs no app without a signature, so this is what lets it start at all. The hardened runtime is off (`hardenedRuntime: false`): it only matters for notarization, and with an ad-hoc signature its library validation can stop the app from loading its own framework. |
| First start | A downloaded app that is not notarized is blocked the first time. On macOS 15 and later the message says "Apple could not verify…" and she clicks **Done**; on macOS 13 and 14 it says Apple cannot check it for malicious software, with **OK** or **Cancel**. Then she allows it once in System Settings, Privacy & Security, **Open Anyway**, and confirms with **Open Anyway** (on macOS 13 and 14, **Open**) (README). Each new version's download asks once again. |
| Updates | Nothing updates itself: no update feed and no `.blockmap` (`writeUpdateInfo: false`). A newer version is dragged onto Applications over the old one. |
| Uninstalling | Dragging the app to the Trash. Her cases folder (`~/ABA Workbench` or the folder chosen in Settings) and the app's data folder stay. |
| Electron fuses | None for the demo (owner's decision, 2026-11-23), as on Windows. |

`pnpm package` (unpacked, used by `ci.yml`'s packaged window tests) stays the runner's own architecture, `dist/mac-arm64` on Apple Silicon; it gets the same ad-hoc signature. Only `pnpm package:mac` builds the universal app.

## What the release workflow checks

`.github/workflows/release.yml`, job **mac-installer**, shown in GitHub as **Mac installer (build, mount, launch, clean up)**, on `macos-26` (Apple Silicon), on every pull request, tag and manual run. For a tag, the same rules as the Windows job first: the tagged commit is on `dev` or `main`, and the tag is `v` plus `package.json`'s version. Then lint, typecheck, unit tests, `pnpm phase0 --mock`, `pnpm package:mac`, and `scripts/mac-installer-check.sh`, step by step:

The script refuses to run anywhere but a GitHub Actions runner (`GITHUB_ACTIONS`, `CI` and `RUNNER_TEMP` set), and everything it makes is in one folder in `RUNNER_TEMP`, which **mount** makes (refusing one that is already there) and **cleanup** removes. It never touches `/Applications`.

1. **mount**: `hdiutil verify`, then attaches the image read-only, hidden from Finder (`-nobrowse -noautoopen`), checks the volume's name, the app and the Applications shortcut, and copies the app out with `ditto`, as she drags it, into the check's own folder. It notes which of the app's folders outside its profile (the default cases folder `~/ABA Workbench`, which the packaged app always uses, and macOS's saved window state) are absent;
2. **verify**: the bundle identifier and version; `LSMinimumSystemVersion` is 13.0, the version the README and the release notes promise; the app's icon is `packaging/macos/icon.icns`; `codesign --verify --deep --strict`; the signature is ad-hoc, under the app's identifier, with no certificate authority; the app and every helper app are signed ad-hoc without the hardened runtime; the copy is not quarantined; every Mach-O file in the app has arm64 and x86_64 (`lipo -archs`);
3. **launch**: starts it hidden through LaunchServices (`open -g -j -n`) on a temporary profile (`--user-data-dir`), waits for its renderer (a helper app with its own signature), checks the main process and the renderer are still up 15 seconds later, the main process is not translated, and the profile was written, then quits it (SIGTERM, as at logout) and checks nothing of it is left running;
4. **launch-x64**: the same with the x86_64 slice, hidden as well (`open -g -j -n --arch x86_64`), and its main process must run translated by Rosetta (`P_TRANSLATED` in its process flags), as an Intel Mac's code does; the step fails if the runner is not Apple Silicon or Rosetta is missing;
5. **cleanup**, also after a failed step: stops anything left of the app, detaches the image, removes the folders the app made that mount found absent, then the check's folder.

A launch that fails shows the app's log messages and any crash report, stops the app and removes its profile before the step ends.

Then it writes the image's SHA-256 (`shasum -a 256`, the same line as `sha256sum`) and keeps both files with the run (14 days). The **publish** job waits for both installer jobs, checks both SHA-256 files and creates one pre-release with the four files.

What CI cannot show: the Gatekeeper block and "Open Anyway" (the image built on the runner is never quarantined, and the dialog needs a person), an Intel Mac itself (the x86_64 code runs under Rosetta on Apple Silicon), and the window as she sees it (the Playwright window tests run on the unpacked arm64 app in `ci.yml`, not on the universal one).
