import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ICON_FILE, ICON_SIZES, icoMatches } from "../scripts/render-app-icon.mts";
import { installFolder, isSameOrInside } from "../src/main/cases-folder.ts";
import { APP_ID } from "../src/main/paths.ts";

/*
 * The Windows installer and its release (owner's decisions, 2026-11-23): what
 * electron-builder.yml asks of the installer, the icon, the app's identity, the release
 * workflow's safety, and the guard that keeps the cases folder out of the install folder.
 * The installer itself is built, installed, tested and uninstalled on Windows by
 * .github/workflows/release.yml.
 */

const builderConfig = readFileSync("electron-builder.yml", "utf8");
/** The config without its comments, so a word in a comment never passes a check. */
const builderSettings = builderConfig
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The lines of one top-level section of electron-builder.yml (`win:`, `nsis:`). */
function section(name: string): string {
  const match = new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n?|\\n)*)`, "m").exec(builderSettings);
  assert.ok(match, `electron-builder.yml has a ${name} section`);
  return match[1];
}

test("installer: the app's identity is the same in electron-builder.yml and in the app", () => {
  assert.match(builderSettings, new RegExp(`^appId: ${APP_ID.replace(/\./g, "\\.")}$`, "m"));
  assert.equal(APP_ID, "io.github.juliocesar97db.aba-workbench");
});

test("installer: one click, for the current user only, Start menu and Desktop, x64, and never deletes her data", () => {
  const nsis = section("nsis");
  for (const setting of [
    "oneClick: true",
    "perMachine: false",
    "createStartMenuShortcut: true",
    "createDesktopShortcut: true",
    "deleteAppDataOnUninstall: false",
    "shortcutName: ABA Workbench",
    "artifactName: ABA-Workbench-Setup-${version}-windows-${arch}.${ext}",
  ]) {
    assert.match(nsis, new RegExp(`^\\s+${setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), setting);
  }
  // Spanish and English for the installer's own few words.
  assert.match(nsis, /installerLanguages:\n\s+- en_US\n\s+- es_ES/);
  const win = section("win");
  assert.match(win, /- target: nsis\n\s+arch: x64\n/);
  assert.match(win, /icon: packaging\/windows\/icon\.ico/);
  // Nothing publishes or updates itself.
  assert.match(builderSettings, /^publish: null$/m);
});

test("installer: unsigned, and nothing in the config points at a certificate", () => {
  for (const key of ["certificateFile", "certificatePassword", "certificateSubjectName", "certificateSha1", "signtoolOptions", "azureSignOptions", "forceCodeSigning: true", "sign:"]) {
    assert.ok(!builderSettings.includes(key), key);
  }
});

test("icon: the committed .ico is what scripts/render-app-icon.mts draws, with every size Windows asks for", () => {
  const ico = readFileSync(ICON_FILE);
  assert.ok(icoMatches(ico), "run `node scripts/render-app-icon.mts` to rewrite packaging/windows/icon.ico");
  assert.equal(ico.readUInt16LE(2), 1, "an icon file");
  assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  const sizes = ICON_SIZES.map((_, index) => ico.readUInt8(6 + 16 * index) || 256);
  assert.deepEqual(sizes, [...ICON_SIZES]);
  assert.ok(sizes.includes(256) && sizes.includes(16));
});

test("install folder: Windows, macOS and Linux; none when the app runs from the repository", () => {
  assert.equal(installFolder({ isPackaged: false, resourcesPath: "C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs\\aba-workbench\\resources" }, "win32", path.win32), null);
  assert.equal(
    installFolder({ isPackaged: true, resourcesPath: "C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs\\aba-workbench\\resources" }, "win32", path.win32),
    "C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs\\aba-workbench",
  );
  assert.equal(installFolder({ isPackaged: true, resourcesPath: "/Applications/ABA Workbench.app/Contents/Resources" }, "darwin", path.posix), "/Applications/ABA Workbench.app");
  assert.equal(installFolder({ isPackaged: true, resourcesPath: "/opt/aba-workbench/resources" }, "linux", path.posix), "/opt/aba-workbench");
});

test("install folder: a cases folder in it or under it is caught, in any case on Windows; one beside it is not", () => {
  const app = "C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs\\aba-workbench";
  const inside = (folder: string) => isSameOrInside(folder, app, "win32", path.win32);
  assert.equal(inside(app), true);
  assert.equal(inside(`${app}\\`), true);
  assert.equal(inside(`${app}\\resources`), true);
  assert.equal(inside(`${app}\\cases\\Mateo F`), true);
  assert.equal(inside("c:\\users\\ana maría pérez\\appdata\\local\\programs\\ABA-WORKBENCH\\Casos"), true);
  assert.equal(inside(`${app}\\..\\aba-workbench\\cases`), true);
  assert.equal(inside("C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs"), false);
  assert.equal(inside("C:\\Users\\Ana María Pérez\\AppData\\Local\\Programs\\aba-workbench-cases"), false);
  assert.equal(inside("C:\\Users\\Ana María Pérez\\ABA Workbench"), false);
  assert.equal(inside("D:\\aba-workbench"), false);
  // Linux compares with case, as its file systems do.
  assert.equal(isSameOrInside("/opt/ABA-workbench/cases", "/opt/aba-workbench", "linux", path.posix), false);
  assert.equal(isSameOrInside("/opt/aba-workbench/cases", "/opt/aba-workbench", "linux", path.posix), true);
  assert.equal(isSameOrInside("/applications/aba workbench.app/Contents", "/Applications/ABA Workbench.app", "darwin", path.posix), true);
});

const workflowsDir = path.join(".github", "workflows");
const release = readFileSync(path.join(workflowsDir, "release.yml"), "utf8");

/** The lines of one job of the release workflow. */
function job(name: string): string {
  const match = new RegExp(`^  ${name}:\\n((?:(?: {4,}.*)?\\n)*)`, "m").exec(release);
  assert.ok(match, `release.yml has a ${name} job`);
  return match[1];
}

test("workflows: every action is pinned to a full commit SHA", () => {
  for (const file of readdirSync(workflowsDir)) {
    const text = readFileSync(path.join(workflowsDir, file), "utf8");
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${file}: ${action}`);
  }
});

test("release workflow: triggered by a version tag, a pull request or by hand; reads only, except the publish job", () => {
  assert.match(release, /^on:\n {2}pull_request:\n {2}push:\n {4}tags: \["v\*\.\*\.\*"\]\n {2}workflow_dispatch:\n/m);
  assert.match(release, /^permissions:\n {2}contents: read\n/m);
  assert.equal([...release.matchAll(/contents: write/g)].length, 1);
  const publish = job("publish");
  assert.match(publish, /permissions:\n\s+contents: write/);
  assert.match(publish, /needs: installer/);
  assert.match(publish, /if: github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)/);
  assert.match(publish, /--prerelease/);
  assert.match(publish, /--verify-tag/);
  // No secret: the only token is GitHub's own, in the publish job.
  assert.doesNotMatch(release, /secrets\./);
  assert.equal([...release.matchAll(/github\.token/g)].length, 1);
  assert.doesNotMatch(job("installer"), /GH_TOKEN|GITHUB_TOKEN|github\.token|CSC_LINK|WIN_CSC/);
});

test("release workflow: every check passes on windows-2025 before the installer is kept, and only then can it be published", () => {
  const installer = job("installer");
  assert.match(installer, /runs-on: windows-2025/);
  const order = [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm phase0 --mock",
    "pnpm package:windows",
    "-Step onedrive",
    "-Step install",
    "pnpm test:e2e:packaged",
    "-Step spanish",
    "--project=packaged windows-installed.e2e.ts",
    "-Step uninstall",
    "sha256sum",
    "actions/upload-artifact@",
  ];
  const positions = order.map((step) => installer.indexOf(step));
  for (const [index, step] of order.entries()) assert.ok(positions[index] >= 0, `the installer job runs ${step}`);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    "in this order",
  );
  // A tag that is not package.json's version is refused before anything is built.
  assert.ok(installer.indexOf('"v$version"') < installer.indexOf("pnpm lint"));
  // No step is allowed to fail quietly.
  assert.doesNotMatch(release, /continue-on-error/);
});
