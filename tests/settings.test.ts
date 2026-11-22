import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { defaultLanguage, readStoredSettings, serializeSettings, SETTINGS_FILE_NAME, SettingsStore } from "../src/main/settings.ts";
import type { Settings } from "../src/shared/api.ts";

const DEFAULTS: Settings = { language: "es" };
const folders: string[] = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function tempFile(contents?: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-settings-test-"));
  folders.push(folder);
  const file = path.join(folder, SETTINGS_FILE_NAME);
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

test("settings file: no file is a first run, with the defaults and no complaint", () => {
  assert.deepEqual(readStoredSettings(null, DEFAULTS), { settings: DEFAULTS, problem: null });
});

test("settings file: a current file is used whole", () => {
  assert.deepEqual(readStoredSettings(serializeSettings({ language: "en" }), DEFAULTS), { settings: { language: "en" }, problem: null });
});

test("settings file: a corrupt file falls back to the defaults", () => {
  for (const text of ["", "{", "not json", '{"language": "en"', String.fromCharCode(0, 1)]) {
    assert.deepEqual(readStoredSettings(text, DEFAULTS), { settings: DEFAULTS, problem: "unreadable" }, JSON.stringify(text));
  }
  for (const text of ["null", "42", '"en"', "[]", '["en"]']) {
    assert.deepEqual(readStoredSettings(text, DEFAULTS), { settings: DEFAULTS, problem: "invalid" }, text);
  }
});

test("settings file: an outdated or foreign file keeps what it can and fills in the rest", () => {
  // No version (an older file): its language is still used, and it is flagged for rewriting.
  assert.deepEqual(readStoredSettings('{"language":"en"}', DEFAULTS), { settings: { language: "en" }, problem: "invalid" });
  // A language this version does not have, or not a string.
  assert.deepEqual(readStoredSettings('{"version":1,"language":"fr"}', DEFAULTS), { settings: DEFAULTS, problem: "invalid" });
  assert.deepEqual(readStoredSettings('{"version":1,"language":["en"]}', DEFAULTS), { settings: DEFAULTS, problem: "invalid" });
  // Language codes are exact: the file only ever holds what serializeSettings writes.
  assert.deepEqual(readStoredSettings('{"version":1,"language":"EN"}', DEFAULTS), { settings: DEFAULTS, problem: "invalid" });
  // Unknown keys (from an older or newer version) are dropped, not an error.
  assert.deepEqual(readStoredSettings('{"version":1,"language":"en","theme":"dark"}', DEFAULTS), { settings: { language: "en" }, problem: null });
  // Another version's file: what is understood is kept.
  assert.deepEqual(readStoredSettings('{"version":2,"language":"en"}', DEFAULTS), { settings: { language: "en" }, problem: "invalid" });
});

test("settings file: the first-run language follows the system's preferred languages", () => {
  assert.equal(defaultLanguage(["es-US", "en-US"]), "es");
  assert.equal(defaultLanguage(["es-419"]), "es");
  assert.equal(defaultLanguage(["en-GB", "es"]), "en");
  assert.equal(defaultLanguage(["fr-FR", "es-MX"]), "es");
  assert.equal(defaultLanguage(["fr-FR", "de"]), "en");
  assert.equal(defaultLanguage([]), "en");
  assert.equal(defaultLanguage(["ES_es"]), "es");
});

test("settings store: saves the language, reads it back after a restart, leaves no temporary file", async () => {
  const file = tempFile();
  const logged: string[] = [];
  const store = new SettingsStore(file, () => DEFAULTS, (message) => logged.push(message));
  assert.deepEqual(await store.get(), DEFAULTS);
  assert.deepEqual(await store.setLanguage("en"), { language: "en" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, language: "en" });
  assert.deepEqual(readdirSync(path.dirname(file)), [SETTINGS_FILE_NAME]);

  const restarted = new SettingsStore(file, () => DEFAULTS, (message) => logged.push(message));
  assert.deepEqual(await restarted.get(), { language: "en" });
  assert.deepEqual(logged, []);
});

test("settings store: a corrupt file is replaced by the next save", async () => {
  const file = tempFile("{ corrupt");
  const logged: string[] = [];
  const store = new SettingsStore(file, () => DEFAULTS, (message) => logged.push(message));
  assert.deepEqual(await store.get(), DEFAULTS);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /not valid JSON/);
  await store.setLanguage("en");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, language: "en" });
});

test("settings store: refuses anything but a known language, and changes nothing", async () => {
  const file = tempFile(serializeSettings({ language: "en" }));
  const store = new SettingsStore(file, () => DEFAULTS, () => undefined);
  for (const bad of ["fr", "EN", "", null, undefined, 1, { language: "es" }, ["es"]]) {
    await assert.rejects(store.setLanguage(bad), /Refused: unknown language/, JSON.stringify(bad));
  }
  assert.deepEqual(await store.get(), { language: "en" });
  assert.equal(readFileSync(file, "utf8"), serializeSettings({ language: "en" }));
});

test("settings store: quick changes are saved in order, the last one wins", async () => {
  const file = tempFile();
  const store = new SettingsStore(file, () => DEFAULTS, () => undefined);
  const results = await Promise.all([store.setLanguage("en"), store.setLanguage("es"), store.setLanguage("en")]);
  assert.deepEqual(results.map((settings) => settings.language), ["en", "es", "en"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, language: "en" });
});

test("settings store: a save that cannot replace the file leaves no temporary file behind", async () => {
  // A folder where the file should be: reading falls back to the defaults, and the
  // rename over it fails on every system.
  const file = tempFile();
  mkdirSync(file);
  writeFileSync(path.join(file, "keep"), "");
  const store = new SettingsStore(file, () => DEFAULTS, () => undefined);
  assert.deepEqual(await store.get(), DEFAULTS);
  await assert.rejects(store.setLanguage("en"));
  assert.deepEqual(readdirSync(path.dirname(file)), [SETTINGS_FILE_NAME]);
  assert.deepEqual(await store.get(), DEFAULTS);
});

test("settings store: a failed save keeps the settings in use as they were", async () => {
  // The settings file's folder would have to be inside a file, so the save fails.
  const notAFolder = tempFile("a file, not a folder");
  const store = new SettingsStore(path.join(notAFolder, SETTINGS_FILE_NAME), () => DEFAULTS, () => undefined);
  await assert.rejects(store.setLanguage("en"));
  assert.deepEqual(await store.get(), DEFAULTS);
  // The store still works after a failure.
  await assert.rejects(store.setLanguage("en"));
});
