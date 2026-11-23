/**
 * Third-party notices: a Vite plugin that lists every package the build actually bundles
 * (main process, PDF reading process, preload and interface), with its version, its
 * declared license and the full text of its license and notice files, in
 * out/licenses/THIRD-PARTY-NOTICES.txt. electron-builder copies it into the packaged app's
 * licenses/ folder, next to the fonts' and PDF.js's licenses. MIT, BSD, ISC and Apache
 * licenses all ask that their text travel with the code.
 *
 * The three builds of one `electron-vite build` run in one process, so the plugin keeps one
 * list for all of them and writes the file again after each.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  /** File name and text of each license or notice file the package ships. */
  files: Array<{ name: string; text: string }>;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:[-._].*)?$/iu;

/** The folder of the package a bundled module comes from, or null when it is the app's own code. */
export function packageRoot(moduleId: string): string | null {
  const file = moduleId.replace(/\\/gu, "/").replace(/^\0/u, "").split("?")[0];
  const at = file.lastIndexOf("/node_modules/");
  if (at === -1) return null;
  const rest = file.slice(at + "/node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return `${file.slice(0, at)}/node_modules/${name}`;
}

/**
 * License texts kept in the repository for packages that ship none in their npm package:
 * licenses/fallback/<package name>.txt, copied from the package's source repository.
 */
// From the repository's root, where every build runs (electron-vite bundles its config elsewhere).
const FALLBACK = path.resolve("licenses", "fallback");

export function readPackage(root: string): BundledPackage | null {
  const manifest = path.join(root, "package.json");
  if (!existsSync(manifest)) return null;
  const json = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string; license?: unknown };
  const license = typeof json.license === "string" ? json.license : JSON.stringify(json.license ?? "UNKNOWN");
  const files = readdirSync(root)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(path.join(root, f), "utf8").replace(/\r\n/gu, "\n").trimEnd() }));
  const name = json.name ?? path.basename(root);
  const fallback = path.join(FALLBACK, `${name.replace("/", "__")}.txt`);
  if (files.length === 0 && existsSync(fallback)) {
    files.push({ name: "LICENSE (from the package's source repository; the npm package ships none)", text: readFileSync(fallback, "utf8").replace(/\r\n/gu, "\n").trimEnd() });
  }
  return { name, version: json.version ?? "", license, files };
}

export function noticesText(packages: BundledPackage[]): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  const sections = sorted.map((p) => {
    const head = `${p.name} ${p.version}\nLicense: ${p.license}`;
    const body = p.files.length
      ? p.files.map((f) => `--- ${f.name} ---\n${f.text}`).join("\n\n")
      : "(The package states this license in its package.json and ships no license file.)";
    return `${"=".repeat(78)}\n${head}\n${"=".repeat(78)}\n${body}`;
  });
  return `Third-party software bundled in ABA Workbench\n\nEach package below is bundled into the app. Its license and notice files follow, as the package ships them.\nThe IBM Plex fonts' license and PDF.js's license are also in this folder as files of their own.\n\n${sections.join("\n\n")}\n`;
}

const bundled = new Map<string, BundledPackage>();

/**
 * `alsoBundled`: packages whose code reaches the output without passing through the module
 * graph (Tailwind's base styles, compiled into the interface's CSS).
 */
export function thirdPartyNotices(outFile: string, alsoBundled: string[] = []): Plugin {
  return {
    name: "aba-third-party-notices",
    apply: "build",
    generateBundle() {
      for (const name of alsoBundled) {
        const root = path.resolve("node_modules", name);
        const info = readPackage(root);
        if (info) bundled.set(root, info);
      }
      for (const id of this.getModuleIds()) {
        const root = packageRoot(id);
        if (!root || bundled.has(root)) continue;
        const info = readPackage(root);
        if (info) bundled.set(root, info);
      }
    },
    closeBundle() {
      const unique = new Map<string, BundledPackage>();
      for (const p of bundled.values()) unique.set(`${p.name}@${p.version}`, p);
      mkdirSync(path.dirname(outFile), { recursive: true });
      writeFileSync(outFile, noticesText([...unique.values()]));
    },
  };
}
