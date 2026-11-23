import assert from "node:assert/strict";
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
  // electron-builder's default window: no background, layout or volume name of our own.
  for (const key of ["background:", "contents:", "window:", "title:"]) assert.ok(!dmg.includes(key), key);
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

test("mac check script: hidden from Finder and hidden at launch, Rosetta required, nothing left behind", () => {
  const script = readFileSync(path.join("scripts", "mac-installer-check.sh"), "utf8");
  assert.match(script, /hdiutil attach -nobrowse -readonly -noautoopen/);
  assert.match(script, /open -g -j -n "\$APP"/);
  assert.match(script, /arch -x86_64 \/usr\/bin\/true \|\| fail/);
  assert.match(script, /arch -x86_64 "\$APP\/Contents\/MacOS\/\$PRODUCT"/);
  assert.match(script, /Signature=adhoc/);
  assert.match(script, /lipo -archs/);
  assert.match(script, /hdiutil detach/);
  assert.match(script, /^set -euo pipefail$/m);
});
