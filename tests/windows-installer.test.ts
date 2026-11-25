import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ICON_FILE, ICON_SIZES, icoMatches } from "../scripts/render-app-icon.mts";
import { CaseLibrary } from "../src/main/cases.ts";
import { installFolder, isInsideOnDisk, isSameOrInside, win32Canonical, type FolderLookup } from "../src/main/cases-folder.ts";
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

test("install folder: Win32 drops trailing dots and spaces from each name, and so does the comparison", () => {
  assert.equal(win32Canonical("C:\\Programs\\aba-workbench.\\Casos. \\"), "C:\\Programs\\aba-workbench\\Casos\\");
  assert.equal(win32Canonical("C:\\a\\..\\b\\.\\c"), "C:\\a\\..\\b\\.\\c");
  const app = "C:\\Users\\Ana\\AppData\\Local\\Programs\\aba-workbench";
  for (const folder of [`${app}.\\Casos`, `${app} \\Casos`, `${app}..\\Casos`, `${app}. .`]) assert.equal(isSameOrInside(folder, app, "win32", path.win32), true, folder);
  // Only Windows reads names that way.
  assert.equal(isSameOrInside("/opt/aba-workbench./cases", "/opt/aba-workbench", "linux", path.posix), false);
});

/** A temporary install folder and a place beside it, removed after the test. */
function sandbox(t: { after: (fn: () => void) => void }) {
  // Its real path at once: macOS's temporary folder is itself behind a link (/var -> /private/var).
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aba-install-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Programs", "aba-workbench");
  mkdirSync(path.join(app, "resources"), { recursive: true });
  mkdirSync(path.join(root, "Ana"), { recursive: true });
  return { root, app };
}

test("install folder: a link to it or into it is caught by its real path; a folder beside it is not", { skip: process.platform === "win32" }, async (t) => {
  const { root, app } = sandbox(t);
  symlinkSync(path.join(app, "resources"), path.join(root, "Ana", "Casos"));
  symlinkSync(root, path.join(root, "Ana", "up"));
  const cases: Array<[string, boolean]> = [
    [path.join(root, "Ana", "Casos"), true],
    [path.join(root, "Ana", "Casos", "not made yet"), true],
    [path.join(root, "Ana", "up", "Programs", "aba-workbench", "Casos"), true],
    [path.join(root, "Ana", "up", "Programs"), false],
    [path.join(root, "Ana"), false],
    [path.join(root, "Ana", "ABA Workbench"), false],
  ];
  for (const [folder, inside] of cases) assert.equal(await isInsideOnDisk(folder, app), inside, folder);
});

test("install folder: a junction, an 8.3 short name, a trailing dot and \\\\localhost\\C$ all reach it, and all are caught (Windows)", { skip: process.platform !== "win32" }, async (t) => {
  const { root, app } = sandbox(t);
  // A junction, as mklink /J makes, from her folder into the install folder.
  symlinkSync(path.join(app, "resources"), path.join(root, "Ana", "Casos"), "junction");
  assert.equal(await isInsideOnDisk(path.join(root, "Ana", "Casos"), app), true, "junction");
  assert.equal(await isInsideOnDisk(path.join(root, "Ana", "Casos", "not made yet"), app), true, "under a junction");
  // The name with a trailing dot that Win32 drops.
  assert.equal(await isInsideOnDisk(`${app}.\\resources`, app), true, "trailing dot");
  // The 8.3 short name, when the volume makes them.
  // Verbatim: Node would otherwise escape the quotes cmd needs around the path.
  const short = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${app}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
  if (short.toLowerCase() !== app.toLowerCase() && existsSync(short)) {
    assert.notEqual(path.basename(short).toLowerCase(), "aba-workbench", short);
    assert.equal(await isInsideOnDisk(path.join(short, "Casos"), app), true, `8.3 name ${short}`);
  } else {
    t.diagnostic(`This volume makes no 8.3 short names (${short}); that case was not exercised.`);
  }
  // The same folder through this computer's administrative share, when it is open.
  const unc = `\\\\localhost\\${app[0]}$${app.slice(2)}`;
  if (existsSync(unc)) assert.equal(await isInsideOnDisk(path.join(unc, "resources"), app), true, unc);
  else t.diagnostic(`${unc} is not reachable here; that case was not exercised.`);
  assert.equal(await isInsideOnDisk(path.join(root, "Ana"), app), false, "beside it");
});

test("install folder: a name its real path does not unify (subst, a network path) is caught by volume and file number; a number 0 is never trusted", async () => {
  // Paths as this system resolves them ("/X" is "D:\X" on Windows), since the walk uses its path module.
  const at = (folder: string) => path.resolve(folder);
  const folders: Record<string, { dev: bigint; ino: bigint }> = {
    [at("/Programs/aba-workbench")]: { dev: 7n, ino: 42n },
    [at("/X")]: { dev: 7n, ino: 42n },
    [at("/X/Casos")]: { dev: 7n, ino: 43n },
    [at("/Y")]: { dev: 7n, ino: 44n },
    [at("/")]: { dev: 7n, ino: 1n },
  };
  const lookup = (ids = folders): FolderLookup => ({
    realpath: async (folder) => {
      if (!(folder in ids)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return folder;
    },
    identity: async (folder) => {
      const id = ids[folder];
      if (!id) throw new Error("missing");
      return id;
    },
  });
  const app = at("/Programs/aba-workbench");
  assert.equal(await isInsideOnDisk(at("/X/Casos"), app, process.platform, lookup()), true);
  assert.equal(await isInsideOnDisk(at("/X/Casos/not made yet"), app, process.platform, lookup()), true);
  assert.equal(await isInsideOnDisk(at("/Y"), app, process.platform, lookup()), false);
  const noNumbers = Object.fromEntries(Object.entries(folders).map(([key, id]) => [key, { dev: id.dev, ino: 0n }]));
  assert.equal(await isInsideOnDisk(at("/X/Casos"), app, process.platform, lookup(noNumbers)), false);
  // An install folder that cannot be read leaves only the text comparison.
  assert.equal(await isInsideOnDisk(at("/X/Casos"), at("/Gone"), process.platform, lookup()), false);
  assert.equal(await isInsideOnDisk(at("/Gone/Casos"), at("/Gone"), process.platform, lookup()), true);
});

test("install folder: a cases folder already saved in the settings inside it is reported, never listed, read or written", async (t) => {
  const { app } = sandbox(t);
  const folder = path.join(app, "Casos");
  const lib = new CaseLibrary({ location: async () => ({ folder, isDefault: false }), log: () => undefined, insideApp: (candidate) => isInsideOnDisk(candidate, app) });
  assert.equal((await lib.folderInfo()).state, "inside-app");
  assert.deepEqual((await lib.list()).cases, []);
  assert.deepEqual(await lib.create({ label: "Invented case" }), { outcome: "folder-problem", problem: "inside-app" });
  assert.equal(existsSync(folder), false, "nothing made in the install folder");
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
  assert.match(publish, /needs: \[installer, mac-installer\]/);
  assert.match(publish, /if: github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)/);
  assert.match(publish, /--verify-tag/);
  // No secret: the only token is GitHub's own, in the publish job.
  assert.doesNotMatch(release, /secrets\./);
  assert.equal([...release.matchAll(/github\.token/g)].length, 1);
  for (const name of ["installer", "mac-installer"]) assert.doesNotMatch(job(name), /GH_TOKEN|GITHUB_TOKEN|github\.token|CSC_LINK|WIN_CSC/);
});

test("release workflow: a plain vX.Y.Z tag publishes a normal release marked Latest; a tag with a suffix, a pre-release", () => {
  const publish = job("publish");
  // The flags and title come from the tag, in one block the release command uses.
  const block = /^( +)if \[\[ "\$TAG" =~ .*\n(?:\1 .*\n|\1else\n)*\1fi\n/m.exec(publish);
  assert.ok(block, "the block that decides the release's kind");
  assert.match(publish, /gh release create "\$TAG" [^\n]*\\\n\s+--verify-tag \\\n\s+"\$\{kind\[@\]\}" \\\n\s+--title "\$title" \\\n\s+--notes-file notes\.md/);
  const script = block[0].replace(new RegExp(`^${block[1]}`, "gm"), "");
  const kindOf = (tag: string): string => {
    const run = spawnSync("bash", ["-c", `${script}printf '%s|' "\${kind[@]}"; printf '%s' "$title"`], { env: { PATH: process.env.PATH ?? "", TAG: tag }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  assert.equal(kindOf("v0.3.0"), "--latest|ABA Workbench 0.3.0 (Windows and Mac)");
  assert.equal(kindOf("v10.20.30"), "--latest|ABA Workbench 10.20.30 (Windows and Mac)");
  for (const tag of ["v0.3.0-beta.1", "v0.3.0-rc.2", "v1.0.0-alpha"]) {
    assert.equal(kindOf(tag), `--prerelease|--latest=false|ABA Workbench ${tag.slice(1)} (Windows and Mac, pre-release)`);
  }
});

test("release workflow: every check passes on windows-2025 before the installer is kept, and only then can it be published", () => {
  const installer = job("installer");
  assert.match(installer, /runs-on: windows-2025/);
  const order = [
    "git merge-base --is-ancestor",
    '"v$version"',
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm phase0 --mock",
    "pnpm package:windows",
    "-Step onedrive",
    "-Step install",
    'test -n "$ABA_PACKAGED_EXECUTABLE"',
    "pnpm test:e2e:packaged",
    "-Step spanish",
    "--project=packaged windows-installed.e2e.ts",
    "-Step reinstall",
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
  // Before anything is built, a tag run refuses a commit that is on neither dev nor main,
  // and a tag that is not package.json's version (both in the order above).
  assert.match(installer, /if: github\.ref_type == 'tag'\n\s+run: \|\n\s+for branch in dev main; do/);
  assert.match(installer, /fetch-depth: \$\{\{ github\.ref_type == 'tag' && '0' \|\| '1' \}\}/);
  // A tag run installs its dependencies fresh, never from a cache another run wrote.
  assert.match(installer, /cache: \$\{\{ github\.ref_type != 'tag' \}\}/);
  assert.match(installer, /save-cache: false/);
  // No step is allowed to fail quietly.
  assert.doesNotMatch(release, /continue-on-error/);
});
