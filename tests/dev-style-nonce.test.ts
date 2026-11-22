import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { addStyleNonce, devStyleNonce } from "../scripts/dev-style-nonce.ts";

const html = readFileSync(path.join(import.meta.dirname, "../src/renderer/index.html"), "utf8");

test("dev style nonce: only style-src gains the nonce; the rest of the policy is untouched", () => {
  const changed = addStyleNonce(html, "abc123==");
  assert.equal(changed.replace(" 'nonce-abc123=='", ""), html);
  assert.match(changed, /style-src 'self' 'nonce-abc123=='; img-src/);
  assert.match(changed, /script-src 'self';/, "scripts get no nonce");
});

test("dev style nonce: refuses a policy whose style-src it does not recognise", () => {
  assert.throws(() => addStyleNonce(html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"), "x"), /Expected/);
  assert.throws(() => addStyleNonce("<html></html>", "x"), /found it 0 times/);
});

test("dev style nonce: applies to the dev server only, never to a build", () => {
  assert.equal(devStyleNonce().apply, "serve");
});
