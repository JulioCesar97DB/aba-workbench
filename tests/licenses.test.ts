import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { noticesText, packageRoot, readPackage } from "../scripts/third-party-notices.ts";

/*
 * The IBM Plex fonts ship under the SIL Open Font License 1.1, whose condition 2 asks
 * every copy to carry the copyright notice and the license. The packaged window test
 * checks the file is in the app; these check the repository's copy and its packaging.
 */
const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const ofl = read("licenses/IBM-Plex-OFL.txt");

/** The license itself, from its title on, without trailing spaces: the part every copy shares word for word. */
function licenseBody(text: string): string {
  const start = text.indexOf("SIL OPEN FONT LICENSE Version 1.1");
  assert.ok(start >= 0, "no OFL 1.1 title");
  return text
    .slice(start)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

test("font license: the repository carries IBM's notice and the full OFL 1.1", () => {
  assert.match(ofl, /^Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"/);
  for (const part of ["PREAMBLE", "DEFINITIONS", "PERMISSION & CONDITIONS", "TERMINATION", "DISCLAIMER"]) assert.ok(ofl.includes(part), part);
});

test("font license: it is the license the shipped font packages carry", () => {
  for (const pkg of ["@fontsource/ibm-plex-sans", "@fontsource/ibm-plex-mono"]) {
    assert.equal(licenseBody(read(`node_modules/${pkg}/LICENSE`)), licenseBody(ofl), pkg);
  }
});

test("font license: electron-builder copies it into the packaged app", () => {
  const config = read("electron-builder.yml");
  assert.match(config, /- from: licenses\n\s+to: licenses\n/);
});

test("PDF.js license: the repository carries the Apache License 2.0 exactly as the pdfjs-dist package does", () => {
  const shipped = read("licenses/PDF.js-Apache-2.0.txt");
  assert.equal(shipped, read("node_modules/pdfjs-dist/LICENSE"));
  assert.match(shipped, /Apache License\s+Version 2\.0, January 2004/);
  assert.ok(shipped.includes("4. Redistribution."));
});

test("PDF.js license: electron-builder copies every .txt of licenses/ into the packaged app", () => {
  const config = read("electron-builder.yml");
  assert.match(config, /- from: licenses\n\s+to: licenses\n\s+filter:\n\s+- "\*\.txt"/);
});

test("third-party notices: a bundled module is traced to its package, and the package's license text is written out", () => {
  assert.equal(packageRoot("/x/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js"), "/x/node_modules/.pnpm/react@19.3.0/node_modules/react");
  assert.equal(packageRoot("C:\\app\\node_modules\\@base-ui\\react\\esm\\index.js"), "C:/app/node_modules/@base-ui/react");
  assert.equal(packageRoot("/x/src/main/index.ts"), null);
  const packages = ["react", "zod", "pdfjs-dist"].map((name) => readPackage(path.join(root, "node_modules", name))!);
  const text = noticesText(packages);
  for (const p of packages) {
    assert.ok(p.files.length > 0, p.name);
    assert.ok(text.includes(`${p.name} ${p.version}\nLicense: ${p.license}`), p.name);
    assert.ok(text.includes(p.files[0].text.split("\n")[0]), p.name);
  }
  assert.match(text, /MIT License/);
  assert.match(text, /Apache License/);
});

test("third-party notices: every build writes them and electron-builder copies them into the app", () => {
  const vite = read("electron.vite.config.ts");
  assert.equal((vite.match(/thirdPartyNotices\(NOTICES/g) ?? []).length, 3);
  assert.match(read("electron-builder.yml"), /- from: out\/licenses\n\s+to: licenses\n/);
});

test("third-party notices: a package that ships no license file gets the text from its source repository", () => {
  const dir = readdirSync(path.join(root, "node_modules", ".pnpm")).find((d) => d.startsWith("standardwebhooks@"))!;
  const info = readPackage(path.join(root, "node_modules", ".pnpm", dir, "node_modules", "standardwebhooks"))!;
  assert.equal(info.license, "MIT");
  assert.match(info.files[0].text, /^The MIT License\n\nCopyright \(c\) 2023 Svix/);
});
