import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AI_ERROR_CODES, AI_ERROR_KINDS, aiErrorKind, aiErrorNeedsSettings } from "../src/renderer/src/ai-errors.ts";
import { en } from "../src/renderer/src/i18n/en.ts";
import { es } from "../src/renderer/src/i18n/es.ts";

/*
 * A failed AI request in her words (owner's decision T11): each error code the app can
 * send to the section screen has a kind, and each kind a sentence in both languages.
 */

const root = path.join(import.meta.dirname, "..");

function sourceFiles(folder: string): string[] {
  return readdirSync(path.join(root, folder), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(root, folder, name));
}

/** Every error code written in the main process and the shared generation code. */
function codesInSource(): Set<string> {
  const codes = new Set<string>();
  for (const file of [...sourceFiles("src/lib"), ...sourceFiles("src/main")]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/new ProviderError\(\s*"([a-z_]+)"/g)) codes.add(match[1]);
    for (const match of text.matchAll(/type: "error", code: "([a-z_]+)"/g)) codes.add(match[1]);
  }
  return codes;
}

test("AI errors: every error code in the source has its kind", () => {
  const codes = codesInSource();
  assert.ok(codes.size > 10, `found only ${codes.size} codes: the pattern no longer matches the source`);
  for (const code of codes) assert.ok(Object.hasOwn(AI_ERROR_CODES, code), `${code} has no kind in src/renderer/src/ai-errors.ts`);
});

test("AI errors: an unknown code reads as other, never as a provider's words", () => {
  assert.equal(aiErrorKind("something_new"), "other");
  assert.equal(aiErrorKind("toString"), "other");
  assert.equal(aiErrorKind("invalid_key"), "signIn");
  assert.equal(aiErrorKind("chatgpt_usage_limit"), "busy");
  assert.equal(aiErrorKind("request_too_large"), "tooLarge");
  assert.equal(aiErrorKind("connection_failed"), "connection");
  assert.equal(aiErrorKind("prepare_failed"), "caseFiles");
});

test("AI errors: each kind has a sentence in both languages, and those with a way out in Settings say so", () => {
  for (const kind of AI_ERROR_KINDS) {
    assert.ok(en.section.failedWhy[kind], `en: ${kind}`);
    assert.ok(es.section.failedWhy[kind], `es: ${kind}`);
    if (aiErrorNeedsSettings(kind)) {
      assert.match(en.section.failedWhy[kind], /Settings/);
      assert.match(es.section.failedWhy[kind], /Ajustes/);
    }
  }
  assert.deepEqual(Object.keys(en.section.failedWhy).sort(), [...AI_ERROR_KINDS].sort());
  // The proposal's sentence (§7), with no room for the provider's text.
  assert.equal(es.section.failed, "La IA no pudo terminar y no se guardó nada; tus versiones siguen igual.");
  assert.doesNotMatch(en.section.failed, /\{\{/);
});
