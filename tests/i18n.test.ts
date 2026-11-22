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

test("strings: the only tag is <term></term>, and it is balanced", () => {
  for (const [language, strings] of [["en", english], ["es", spanish]] as const) {
    for (const [key, value] of strings) {
      const tags = [...value.matchAll(/<\/?([a-z]+)>/g)].map((match) => match[0]);
      assert.ok(tags.every((tag) => tag === "<term>" || tag === "</term>"), `${language}: ${key} has another tag`);
      assert.equal(tags.filter((tag) => tag === "<term>").length, tags.filter((tag) => tag === "</term>").length, `${language}: ${key}`);
    }
  }
});
