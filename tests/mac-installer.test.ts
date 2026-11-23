import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decodeIcns, ICNS_FILE, ICNS_IMAGES, icnsMatches } from "../scripts/render-app-icon.mts";

/*
 * The universal Mac disk image (owner's decisions, 2026-11-23): what electron-builder.yml
 * asks of it, its icon, and the release workflow's job that builds it, mounts it, starts
 * the app from it and publishes it with the Windows installer. The image itself is built
 * and checked on macOS by .github/workflows/release.yml (scripts/mac-installer-check.sh).
 */

/** electron-builder.yml without its comments, so a word in a comment never passes a check. */
const builderSettings = readFileSync("electron-builder.yml", "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

function section(name: string): string {
  const match = new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n?|\\n)*)`, "m").exec(builderSettings);
  assert.ok(match, `electron-builder.yml has a ${name} section`);
  return match[1];
}

const release = readFileSync(path.join(".github", "workflows", "release.yml"), "utf8");

function job(name: string): string {
  const match = new RegExp(`^  ${name}:\\n((?:(?: {4,}.*)?\\n)*)`, "m").exec(release);
  assert.ok(match, `release.yml has a ${name} job`);
  return match[1];
}

test("mac: one universal disk image, named like the Windows installer, with no update file", () => {
  const mac = section("mac");
  assert.match(mac, /target:\n\s+- target: dmg\n\s+arch: universal\n/);
  assert.match(mac, /^\s+icon: packaging\/macos\/icon\.icns$/m);
  const dmg = section("dmg");
  assert.match(dmg, /^\s+artifactName: ABA-Workbench-\$\{version\}-macos-\$\{arch\}\.\$\{ext\}$/m);
  assert.match(dmg, /^\s+writeUpdateInfo: false$/m);
  // electron-builder's default window: no background or layout of our own; the volume's name
  // is stated, as electron-builder's default adds the architecture.
  for (const key of ["background:", "contents:", "window:"]) assert.ok(!dmg.includes(key), key);
  assert.match(dmg, /^\s+title: \$\{productName\} \$\{version\}$/m);
});

test("mac: an ad-hoc signature only, without the hardened runtime, notarization or a minimum of our own", () => {
  const mac = section("mac");
  assert.match(mac, /^\s+identity: "-"$/m);
  assert.match(mac, /^\s+hardenedRuntime: false$/m);
  for (const key of ["notarize", "entitlements", "provisioningProfile", "minimumSystemVersion", "CSC_LINK", "forceCodeSigning: true"]) assert.ok(!builderSettings.includes(key), key);
});

test("mac: the package:mac script builds the app, then the disk image, and publishes nothing", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  assert.equal(scripts["package:mac"], "electron-vite build && electron-builder --mac --publish never");
});

test("icon: the committed .icns is what scripts/render-app-icon.mts draws, at every size macOS asks for", () => {
  const icns = readFileSync(ICNS_FILE);
  assert.ok(icnsMatches(icns), "run `node scripts/render-app-icon.mts` to rewrite packaging/macos/icon.icns");
  const images = decodeIcns(icns);
  assert.deepEqual(
    images.map((image) => [image.type, image.size]),
    ICNS_IMAGES.map((image) => [image.type, image.size]),
  );
  assert.deepEqual([...new Set(images.map((image) => image.size))].sort((a, b) => a - b), [16, 32, 64, 128, 256, 512, 1024]);
});

test("release workflow: the Mac job builds, mounts, checks, starts the app on both architectures and cleans up, in order", () => {
  const mac = job("mac-installer");
  assert.match(mac, /name: Mac installer \(build, mount, launch, clean up\)/);
  assert.match(mac, /runs-on: macos-26/);
  const order = [
    "git merge-base --is-ancestor",
    '"v$version"',
    "ABA-Workbench-$version-macos-universal.dmg",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm phase0 --mock",
    "pnpm package:mac",
    "mac-installer-check.sh mount",
    "mac-installer-check.sh verify",
    "mac-installer-check.sh launch\n",
    "mac-installer-check.sh launch-x64",
    "mac-installer-check.sh cleanup",
    "shasum -a 256",
    "actions/upload-artifact@",
  ];
  const positions = order.map((step) => mac.indexOf(step));
  for (const [index, step] of order.entries()) assert.ok(positions[index] >= 0, `the Mac job runs ${step}`);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    "in this order",
  );
  assert.match(mac, /if: github\.ref_type == 'tag'\n\s+run: \|\n\s+for branch in dev main; do/);
  assert.match(mac, /cache: \$\{\{ github\.ref_type != 'tag' \}\}/);
  assert.match(mac, /save-cache: false/);
  assert.match(mac, /name: mac-installer\n/);
  // electron-builder signs nothing in a pull request's build without this: the check would
  // then find an app with no signature at all.
  assert.match(mac, /CSC_FOR_PULL_REQUEST: "true"\n(?:\s+[A-Z_]+: .*\n)*\s+run: \|\n\s+pnpm package:mac/);
});

test("release workflow: one pre-release gets both installers and both SHA-256 files, once both jobs passed", () => {
  const publish = job("publish");
  assert.match(publish, /needs: \[installer, mac-installer\]/);
  assert.match(publish, /name: windows-installer\n/);
  assert.match(publish, /name: mac-installer\n/);
  assert.match(publish, /sha256sum --check --strict/);
  assert.match(publish, /gh release create "\$TAG" "\$INSTALLER" "\$INSTALLER\.sha256" "\$DMG" "\$DMG\.sha256"/);
  assert.match(publish, /Open Anyway/);
  assert.match(publish, /Run anyway/);
});

const checkScript = readFileSync(path.join("scripts", "mac-installer-check.sh"), "utf8");

test("mac check script: refuses to run outside GitHub Actions, before it does anything", () => {
  const guard = /^set -euo pipefail\n\nif \[ "\$\{GITHUB_ACTIONS:-\}" != "true" \] \|\| \[ "\$\{CI:-\}" != "true" \] \|\| \[ -z "\$\{RUNNER_TEMP:-\}" \]; then\n.*\n {2}exit 1\nfi\n/m;
  assert.match(checkScript, guard);
  const firstCommand = checkScript.split("\n").findIndex((line) => /^(hdiutil|open|ditto|rm|mkdir|kill)\b/.test(line.trim()));
  assert.ok(checkScript.indexOf("GITHUB_ACTIONS") < checkScript.split("\n").slice(0, firstCommand).join("\n").length, "the guard comes before any command that acts");
  // Run here, outside CI, it refuses and touches nothing.
  const run = spawnSync("bash", [path.join("scripts", "mac-installer-check.sh"), "cleanup"], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /runs only on a GitHub Actions runner/);
});

test("mac check script: works only in its own folder, never /Applications, and removes only what it made", () => {
  assert.match(checkScript, /^STATE="\$RUNNER_TEMP\/aba-mac-installer-check"$/m);
  assert.match(checkScript, /^APP="\$STATE\/Applications\/\$PRODUCT\.app"$/m);
  assert.doesNotMatch(checkScript, /^[^#]*"\/Applications\/\$PRODUCT/m);
  assert.match(checkScript, /\[ ! -e "\$STATE" \] \|\| fail/);
  // Every rm -rf removes the check's folder, a profile it made, or a folder mount found absent.
  const removals = [...checkScript.matchAll(/rm -rf (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(removals, ['"$LAUNCH_PROFILE";', '"$path"', '"$STATE"']);
  assert.match(checkScript, /if \[ ! -e "\$path" \]; then echo "\$path" >> "\$STATE\/absent-before"; fi/);
});

test("mac check script: hidden from Finder and at both launches, translated under Rosetta, cleaned up on failure", () => {
  assert.match(checkScript, /hdiutil attach -nobrowse -readonly -noautoopen/);
  assert.match(checkScript, /open -g -j -n "\$@" "\$APP" --args/);
  assert.match(checkScript, /launch_and_quit "Native" native ;;/);
  assert.match(checkScript, /launch_and_quit "Intel \(Rosetta\)" translated --arch x86_64\n/);
  assert.match(checkScript, /0x20000/);
  assert.match(checkScript, /arch -x86_64 \/usr\/bin\/true \|\| fail/);
  assert.match(checkScript, /end_launch\(\) \{\n.*\n\s+if \[ "\$status" -ne 0 \]; then show_app_logs; fi\n\s+stop_app\n/);
  assert.match(checkScript, /trap end_launch EXIT/);
  assert.match(checkScript, /hdiutil detach/);
  assert.match(job("mac-installer"), /if: \$\{\{ always\(\) \}\}\n\s+run: \.\/scripts\/mac-installer-check\.sh cleanup/);
});

test("mac check script: checks the minimum macOS, the icon, ad-hoc without the hardened runtime, and both slices", () => {
  assert.match(checkScript, /^MINIMUM_MACOS="13\.0"$/m);
  assert.match(checkScript, /\[ "\$minimum" = "\$MINIMUM_MACOS" \] \|\| fail/);
  assert.match(checkScript, /cmp "\$APP\/Contents\/Resources\/\$icon" packaging\/macos\/icon\.icns/);
  assert.match(checkScript, /Signature=adhoc/);
  assert.match(checkScript, /\*runtime\*/);
  assert.match(checkScript, /lipo -archs/);
});

test("mac: the README and the release notes give the Gatekeeper steps for macOS 13 and 14 and for 15 and later", () => {
  const readme = readFileSync("README.md", "utf8");
  for (const text of [readme, job("publish")]) {
    assert.match(text, /\*\*Done\*\*/);
    assert.match(text, /\*\*OK\*\*/);
    assert.match(text, /\*\*Open Anyway\*\*/);
    assert.match(text, /\*\*Open\*\*/);
    assert.match(text, /macOS 13 and 14/);
  }
});

test("mac: the README's links are this version's release and files", () => {
  const readme = readFileSync("README.md", "utf8");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
  const links = [...readme.matchAll(/https:\/\/github\.com\/JulioCesar97DB\/aba-workbench\/releases\/download\/(v[^/]+)\/(\S+?)\)/g)];
  assert.equal(links.length, 4);
  for (const [, tag, asset] of links) {
    assert.equal(tag, `v${version}`);
    assert.ok(asset.includes(`-${version}-`), asset);
  }
  assert.ok(readme.includes(`ABA-Workbench-${version}-macos-universal.dmg`));
  assert.ok(readme.includes(`ABA-Workbench-Setup-${version}-windows-x64.exe`));
});
