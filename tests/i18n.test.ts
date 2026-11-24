import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../src/renderer/src/i18n/en.ts";
import { es } from "../src/renderer/src/i18n/es.ts";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(name, value);
    else for (const [k, v] of flatten(value, name)) out.set(k, v);
  }
  return out;
}

const english = flatten(en);
const spanish = flatten(es);

test("strings: English and Spanish have exactly the same keys", () => {
  assert.deepEqual([...spanish.keys()].sort(), [...english.keys()].sort());
});

test("strings: no string is empty", () => {
  for (const [language, strings] of [["en", english], ["es", spanish]] as const) {
    for (const [key, value] of strings) assert.ok(value.trim().length > 0, `${language}: ${key} is empty`);
  }
});

test("strings: each translation keeps the same placeholders and English terms", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
  const terms = (text: string) => [...text.matchAll(/<term>(.*?)<\/term>/g)].map((match) => match[1]).sort();
  for (const [key, value] of english) {
    const translation = spanish.get(key) ?? "";
    assert.deepEqual(placeholders(translation), placeholders(value), `placeholders of ${key}`);
    // The terms inside <term></term> stay in English, so they must match word for word.
    assert.deepEqual(terms(translation), terms(value), `English terms of ${key}`);
  }
});

test("strings: US English spelling, and macOS's own name for its settings pane", () => {
  for (const [key, value] of english) {
    assert.doesNotMatch(value, /\b(recognis|organis|colour|behaviour)/i, `${key} uses US spelling`);
    assert.doesNotMatch(value, /Files and Folders/, `${key}: macOS calls the pane "Files & Folders"`);
  }
  assert.match(en.casesFolder["not-allowed-mac"], /Files & Folders/);
  // Windows' file manager is "Explorador de archivos" in Spanish.
  assert.equal(es.casesFolder.showWindows, "Mostrar en el Explorador de archivos");
});

test("strings: say only what the app controls about where cases go", () => {
  for (const [language, strings] of [["en", english], ["es", spanish]] as const) {
    for (const [key, value] of strings) {
      assert.doesNotMatch(value, /on this computer|en esta computadora/i, `${language}: ${key} promises where the cases stay`);
    }
  }
  // Where the folder is chosen, one plain sentence says a synced folder sends the cases to that service.
  assert.match(en.settings.casesFolderSyncNote, /OneDrive, iCloud, Dropbox or Google Drive/);
  assert.match(es.settings.casesFolderSyncNote, /OneDrive, iCloud, Dropbox o Google Drive/);
  assert.match(en.settings.casesFolderBody, /sends nothing anywhere/);
});

test("strings: the only tag is <term></term>, and it is balanced", () => {
  for (const [language, strings] of [["en", english], ["es", spanish]] as const) {
    for (const [key, value] of strings) {
      const tags = [...value.matchAll(/<\/?([a-z]+)>/g)].map((match) => match[0]);
      assert.ok(tags.every((tag) => tag === "<term>" || tag === "</term>"), `${language}: ${key} has another tag`);
      assert.equal(tags.filter((tag) => tag === "<term>").length, tags.filter((tag) => tag === "</term>").length, `${language}: ${key}`);
    }
  }
});

test("dates: the hint names the date field's order, which follows the computer's region", async () => {
  const { dateFieldOrder } = await import("../src/renderer/src/format.ts");
  assert.deepEqual(dateFieldOrder("en-US"), ["month", "day", "year"]);
  assert.deepEqual(dateFieldOrder("es-MX"), ["day", "month", "year"]);
  assert.deepEqual(dateFieldOrder("en-GB"), ["day", "month", "year"]);
  assert.deepEqual(Object.keys(es.sources.dateParts).sort(), ["day", "month", "year"]);
});

test("strings: the five steps' names in the screen language (owner's decision P1)", () => {
  assert.deepEqual([es.steps.sources, es.steps.caseMap, es.steps.plan, es.steps.report, es.steps.review], ["Documentos", "Mapa del caso", "Plan", "Informe", "Revisión y copia"]);
  assert.deepEqual([en.steps.sources, en.steps.caseMap, en.steps.plan, en.steps.report, en.steps.review], ["Documents", "Case map", "Plan", "Report", "Review and copy"]);
  // "Fuentes" was a researcher's word (audit U16): the screens say "documentos".
  for (const [key, value] of spanish) {
    if (key.startsWith("caseMap.")) continue; // the case map's own strings belong to its pull requests
    assert.doesNotMatch(value, /\bfuentes?\b/i, `es: ${key}`);
  }
});

test("strings: Settings says what the AI does and when anything is sent (audit U12), no longer that drafting comes later", () => {
  assert.equal(es.connections.intro, "La IA redacta el mapa del caso y las secciones. Solo se le envía algo cuando tú lo pides. Conecta una; ChatGPT es la habitual.");
  assert.equal(en.connections.intro, "The AI drafts the case map and the sections. Nothing is sent unless you ask. Connect one; ChatGPT is the usual one.");
  for (const [key, value] of [...english, ...spanish]) assert.doesNotMatch(value, /later version|versión posterior/, key);
});

test("strings: the case map draft's estimate is the measured 10 to 20 minutes, in both languages (owner's decision, 2026-11-23)", () => {
  assert.equal(en.caseMap.ai.time, "It can take 10 to 20 minutes. You review everything before it is used.");
  assert.equal(es.caseMap.ai.time, "Puede tardar de 10 a 20 minutos. Tú revisas todo antes de que se use.");
});
