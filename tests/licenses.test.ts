import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

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
