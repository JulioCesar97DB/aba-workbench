import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * macOS shows a usage description when the app first opens Documents (or the Desktop,
 * Downloads, an external or a network drive). The English text is in electron-builder.yml
 * (mac.extendInfo), and each language's in packaging/macos/<language>.lproj/InfoPlist.strings.
 */

const KEYS = [
  "NSDocumentsFolderUsageDescription",
  "NSDesktopFolderUsageDescription",
  "NSDownloadsFolderUsageDescription",
  "NSRemovableVolumesUsageDescription",
  "NSNetworkVolumesUsageDescription",
];

function fromBuilderConfig(): Map<string, string> {
  const yml = readFileSync("electron-builder.yml", "utf8");
  return new Map([...yml.matchAll(/^ {4}(NS\w+UsageDescription): "([^"]+)"$/gm)].map((match) => [match[1], match[2]]));
}

function fromStrings(language: string): Map<string, string> {
  const text = readFileSync(`packaging/macos/${language}.lproj/InfoPlist.strings`, "utf8");
  return new Map([...text.matchAll(/^"(\w+)" = "([^"]+)";$/gm)].map((match) => [match[1], match[2]]));
}

test("macOS usage descriptions: every protected place the cases folder may be in has one", () => {
  assert.deepEqual([...fromBuilderConfig().keys()].sort(), [...KEYS].sort());
});

test("macOS usage descriptions: English matches the plist, Spanish has the same keys, none is empty", () => {
  assert.deepEqual(fromStrings("en"), fromBuilderConfig());
  const spanish = fromStrings("es");
  assert.deepEqual([...spanish.keys()].sort(), [...KEYS].sort());
  for (const [key, value] of spanish) {
    assert.ok(value.trim().length > 20, key);
    assert.notEqual(value, fromBuilderConfig().get(key), `${key} is translated`);
  }
  // A Mac set to Latin American Spanish (es-419) looks in es_419.lproj first: the same words.
  assert.deepEqual(fromStrings("es_419"), spanish);
  // The documents one speaks of Documents in each language.
  assert.match(fromBuilderConfig().get("NSDocumentsFolderUsageDescription") ?? "", /Documents/);
  assert.match(spanish.get("NSDocumentsFolderUsageDescription") ?? "", /Documentos/);
});
