import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AI_ERROR_CODES, AI_ERROR_KINDS, aiErrorCanRetry, aiErrorKind, aiErrorNeedsSettings } from "../src/renderer/src/ai-errors.ts";
import { en } from "../src/renderer/src/i18n/en.ts";
import { es } from "../src/renderer/src/i18n/es.ts";
import { CHATGPT_ERRORS } from "../src/lib/providers/openai.ts";

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

/**
 * Every error code the main process and the shared generation code can make: the codes
 * written where an error is made, every `code: "…"` of the providers' error tables, and
 * OpenAI's ChatGPT table itself (review round 1, B1: two of its codes had no kind).
 */
function codesInSource(): Set<string> {
  const codes = new Set<string>(Object.values(CHATGPT_ERRORS).map((entry) => entry.code));
  for (const file of [...sourceFiles("src/lib"), ...sourceFiles("src/main")]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/new ProviderError\(\s*"([a-z_]+)"/g)) codes.add(match[1]);
    for (const match of text.matchAll(/type: "error", code: "([a-z_]+)"/g)) codes.add(match[1]);
    if (file.includes(`${path.sep}providers${path.sep}`)) for (const match of text.matchAll(/\bcode: "([a-z_]+)"/g)) codes.add(match[1]);
  }
  return codes;
}

test("AI errors: every error code in the source and in the error tables has its kind", () => {
  const codes = codesInSource();
  assert.ok(codes.size > 20, `found only ${codes.size} codes: the patterns no longer match the source`);
  for (const code of ["chatgpt_not_eligible", "chatgpt_not_authorized", "chatgpt_usage_limit"]) assert.ok(codes.has(code), `the ChatGPT table's ${code} was not read`);
  for (const code of codes) assert.ok(Object.hasOwn(AI_ERROR_CODES, code), `${code} has no kind in src/renderer/src/ai-errors.ts`);
});

test("AI errors: an unknown code reads as other, never as a provider's words", () => {
  assert.equal(aiErrorKind("something_new"), "other");
  assert.equal(aiErrorKind("toString"), "other");
  assert.equal(aiErrorKind("invalid_key"), "signIn");
  assert.equal(aiErrorKind("chatgpt_usage_limit"), "limit");
  assert.equal(aiErrorKind("rate_limited"), "limit");
  assert.equal(aiErrorKind("chatgpt_unavailable"), "busy");
  assert.equal(aiErrorKind("chatgpt_not_eligible"), "plan");
  assert.equal(aiErrorKind("chatgpt_not_allowed"), "plan");
  assert.equal(aiErrorKind("chatgpt_not_authorized"), "signIn");
  assert.equal(aiErrorKind("bad_request"), "refused");
  assert.equal(aiErrorKind("rules_error"), "appFiles");
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
  // A refused plan says what we know, never as fact (template item 52): a paid plan "may be needed".
  assert.match(en.section.failedWhy.plan, /^ChatGPT did not allow ABA Workbench to use this account's plan\. A paid ChatGPT plan, such as Plus or Pro, may be needed\./);
  assert.match(es.section.failedWhy.plan, /Puede hacer falta un plan de pago de ChatGPT/);
  // A usage limit is not "a few minutes" (review round 1, S2).
  for (const text of [en.section.failedWhy.limit, en.section.failedWhy.busy]) assert.doesNotMatch(text, /limit.*few minutes|few minutes.*limit/);
  assert.doesNotMatch(es.section.failedWhy.busy, /límite/);
  // The proposal's sentence (§7), with no room for the provider's text.
  assert.equal(es.section.failed, "La IA no pudo terminar y no se guardó nada; tus versiones siguen igual.");
  assert.doesNotMatch(en.section.failed, /\{\{/);
});

test("Try again is offered only where sending the same request again can work (UX-2 follow-up)", () => {
  const retry = AI_ERROR_KINDS.filter((kind) => aiErrorCanRetry(kind));
  assert.deepEqual(retry.sort(), ["busy", "caseFiles", "connection", "limit", "other", "refused"]);
  // A way out in Settings is never also a retry: one button, the one that can work.
  for (const kind of AI_ERROR_KINDS) assert.ok(!(aiErrorCanRetry(kind) && aiErrorNeedsSettings(kind)), kind);
});
