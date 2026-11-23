import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createAnthropicProvider } from "../src/lib/providers/anthropic.ts";
import { ChatGptSession } from "../src/main/chatgpt-session.ts";
import { checkClaudeKeyShape } from "../src/main/claude-key.ts";
import { ConnectionService } from "../src/main/connections.ts";
import { CREDENTIALS_FILE_NAME, CredentialsStore } from "../src/main/credentials.ts";
import type { Connections } from "../src/shared/api.ts";
import { stubFetch } from "./helpers.ts";

const GOOD_KEY = "sk-ant-api03-test-key-not-real-0000000000";
const MODELS = { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null };

/**
 * A credentials file in a temporary folder: `key` is saved first, `damaged` writes a
 * file the app cannot read, `failWrites` makes every save fail.
 */
async function credentials(t: TestContext, options: { key?: string; damaged?: boolean; failWrites?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "aba-connections-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  if (options.damaged) await writeFile(file, "{ not the whole file");
  if (options.key) await new CredentialsStore(file, { log: () => undefined, restrict: async () => undefined }).update((c) => ({ ...c, claude: { apiKey: options.key!, savedAt: "2026-11-22T18:00:00.000Z" } }));
  const backend = new CredentialsStore(file, {
    log: () => undefined,
    restrict: async () => {
      if (options.failWrites) throw new Error("EACCES: /Users/someone/Library/credentials.json");
    },
  });
  const state = {
    get key(): Promise<string | null> {
      return readFile(file, "utf8").then((text) => JSON.parse(text).claude?.apiKey ?? null, () => null);
    },
    files: () => readdir(dir),
    file,
  };
  return { backend, state };
}

/** Anthropic, stubbed: every key but GOOD_KEY gets 401. */
function anthropic(answer?: (key: string) => Response) {
  return stubFetch(({ headers }) => {
    const key = (headers.get("x-api-key") ?? headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (answer) return answer(key);
    return key === GOOD_KEY ? Response.json(MODELS) : Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
  });
}

function service(backend: CredentialsStore, fetchStub: typeof fetch, logged: unknown[] = []) {
  const changes: Connections[] = [];
  const chatgpt = new ChatGptSession({ store: backend, openBrowser: async () => undefined, language: async () => "en", onChange: () => undefined, log: () => undefined });
  const connections = new ConnectionService({
    store: backend,
    chatgpt,
    claude: createAnthropicProvider({ fetch: fetchStub }),
    onChange: (c) => changes.push(c),
    log: (...args) => logged.push(...args),
  });
  return { connections, changes };
}

const NOT_CONNECTED = { chatgpt: { state: "not-connected", savedAccount: false }, claude: { state: "not-connected" }, problem: null };

test("Claude key shape: trimmed, one run of visible characters, starting with sk-ant-", () => {
  assert.deepEqual(checkClaudeKeyShape(`  ${GOOD_KEY}\n`), { ok: true, key: GOOD_KEY });
  assert.deepEqual(checkClaudeKeyShape("   "), { ok: false, problem: "empty" });
  for (const bad of ["sk-proj-an-openai-key", "sk-ant-with space", "sk-ant-ñ", `sk-ant-${"x".repeat(400)}`, "SK-ANT-UPPER", "hello"]) {
    assert.deepEqual(checkClaudeKeyShape(bad), { ok: false, problem: "not-a-claude-key" }, bad);
  }
});

test("Claude key: an accepted key is saved and the state becomes connected; the interface never sees it", async (t) => {
  const { backend, state } = await credentials(t);
  const { fetchStub, calls } = anthropic();
  const { connections, changes } = service(backend, fetchStub);
  assert.deepEqual((await connections.get()).claude, { state: "not-connected" });
  assert.deepEqual(await connections.saveClaudeKey(` ${GOOD_KEY} `), { outcome: "saved" });
  assert.equal(await state.key, GOOD_KEY);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/, "a free call: the model list");
  assert.deepEqual(await connections.get(), { ...NOT_CONNECTED, claude: { state: "connected" } });
  assert.equal(changes.length, 1);
  assert.doesNotMatch(JSON.stringify(changes), /sk-ant/);
});

test("Claude key: a wrong key is not saved and says so; text that is not a key is never sent", async (t) => {
  const { backend, state } = await credentials(t);
  const { fetchStub, calls } = anthropic();
  const { connections } = service(backend, fetchStub);
  assert.deepEqual(await connections.saveClaudeKey("sk-ant-api03-wrong"), { outcome: "rejected" });
  assert.deepEqual(await connections.saveClaudeKey("sk-proj-openai-key"), { outcome: "not-a-key", problem: "not-a-claude-key" });
  assert.deepEqual(await connections.saveClaudeKey(""), { outcome: "not-a-key", problem: "empty" });
  assert.equal(calls.length, 1, "only the key shaped like a Claude key reached Anthropic");
  assert.equal(await state.key, null);
  assert.deepEqual(await state.files(), [], "no file was written");
});

test("Claude key: no internet, or another error from Anthropic, saves nothing", async (t) => {
  const { backend, state } = await credentials(t);
  const offline = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await service(backend, offline.fetchStub).connections.saveClaudeKey(GOOD_KEY), { outcome: "unreachable" });
  const failing = anthropic(() => Response.json({ type: "error", error: { type: "api_error", message: "Internal" } }, { status: 500 }));
  assert.deepEqual(await service(backend, failing.fetchStub).connections.saveClaudeKey(GOOD_KEY), { outcome: "provider-error" });
  assert.equal(await state.key, null);
});

test("Claude key: hostile input is refused before anything looks at it", async (t) => {
  const { backend } = await credentials(t);
  const { fetchStub, calls } = anthropic();
  const { connections } = service(backend, fetchStub);
  for (const input of [undefined, null, 42, { key: GOOD_KEY }, [GOOD_KEY], "x".repeat(1001)]) {
    await assert.rejects(connections.saveClaudeKey(input), /^Error: Refused: the key must be text/);
  }
  assert.equal(calls.length, 0);
});

test("Claude key: a file that cannot be written says not saved, and the log holds no key", async (t) => {
  const logged: unknown[] = [];
  const { backend } = await credentials(t, { failWrites: true });
  const { connections } = service(backend, anthropic().fetchStub, logged);
  assert.deepEqual(await connections.saveClaudeKey(GOOD_KEY), { outcome: "not-saved" });
  assert.deepEqual((await connections.get()).claude, { state: "not-connected" });
  assert.doesNotMatch(logged.map(String).join(" "), /sk-ant|\/Users\//, "no key and no path in the log");
});

test("an unreadable credentials file is reported, never written, and set aside only by Start over", async (t) => {
  const { backend, state } = await credentials(t, { damaged: true });
  const { fetchStub, calls } = anthropic();
  const { connections, changes } = service(backend, fetchStub);
  assert.deepEqual(await connections.get(), { ...NOT_CONNECTED, problem: "damaged" });
  assert.deepEqual(await connections.saveClaudeKey(GOOD_KEY), { outcome: "credentials-problem", problem: "damaged" });
  assert.deepEqual(await connections.removeClaudeKey(), { outcome: "credentials-problem", problem: "damaged" });
  assert.deepEqual(await connections.signInToChatGpt(), { outcome: "credentials-problem", problem: "damaged" });
  assert.equal(calls.length, 0);
  assert.equal(await readFile(state.file, "utf8"), "{ not the whole file", "never overwritten");
  assert.deepEqual(await connections.startOver(), { outcome: "started-over" });
  assert.deepEqual(await connections.get(), NOT_CONNECTED);
  assert.deepEqual(changes.at(-1), NOT_CONNECTED);
  const files = await state.files();
  assert.equal(files.length, 1);
  assert.match(files[0], /^credentials\.json\.unreadable-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.deepEqual(await connections.startOver(), { outcome: "not-needed" });
  assert.deepEqual(await connections.saveClaudeKey(GOOD_KEY), { outcome: "saved" });
});

test("Claude key: a check of a key Anthropic no longer accepts marks it as needing attention; a new key clears it", async (t) => {
  let revoked = false;
  const { backend } = await credentials(t, { key: GOOD_KEY });
  const { fetchStub } = anthropic((key) => (key === GOOD_KEY && !revoked ? Response.json(MODELS) : Response.json({ type: "error", error: { type: "authentication_error", message: "x" } }, { status: 401 })));
  const { connections, changes } = service(backend, fetchStub);
  assert.deepEqual(await connections.checkClaudeKey(), { outcome: "working" });
  assert.equal(changes.length, 0, "nothing changed");
  revoked = true;
  assert.deepEqual(await connections.checkClaudeKey(), { outcome: "rejected" });
  assert.deepEqual((await connections.get()).claude, { state: "needs-attention", reason: "key-rejected" });
  assert.deepEqual(changes.at(-1)?.claude, { state: "needs-attention", reason: "key-rejected" });
  revoked = false;
  assert.deepEqual(await connections.saveClaudeKey(GOOD_KEY), { outcome: "saved" });
  assert.deepEqual((await connections.get()).claude, { state: "connected" });
});

test("Claude key: removing it forgets it; checking with none saved says not connected", async (t) => {
  const { backend, state } = await credentials(t, { key: GOOD_KEY });
  const { fetchStub, calls } = anthropic();
  const { connections, changes } = service(backend, fetchStub);
  assert.deepEqual(await connections.removeClaudeKey(), { outcome: "removed" });
  assert.equal(await state.key, null);
  assert.doesNotMatch(await readFile(state.file, "utf8"), /sk-ant/, "gone from the file");
  assert.deepEqual(changes.at(-1)?.claude, { state: "not-connected" });
  assert.deepEqual(await connections.checkClaudeKey(), { outcome: "not-connected" });
  assert.equal(calls.length, 0);
});

test("ChatGPT welcome: shown once plan use is allowed, until it is dismissed", async (t) => {
  const { backend } = await credentials(t);
  await backend.update((c) => ({
    ...c,
    chatgpt: {
      issuer: "https://auth.openai.com",
      clientId: "oaiapp_x",
      subject: "s",
      email: null,
      name: null,
      idToken: "i",
      accessToken: "a",
      refreshToken: "r",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      savedAt: "2026-11-22T18:00:00.000Z",
    },
  }));
  const { connections, changes } = service(backend, anthropic().fetchStub);
  assert.deepEqual((await connections.get()).chatgpt, { state: "connected", displayName: null, showWelcome: true });
  await connections.dismissChatGptWelcome();
  assert.deepEqual((await connections.get()).chatgpt, { state: "connected", displayName: null, showWelcome: false });
  assert.deepEqual(changes.at(-1)?.chatgpt, { state: "connected", displayName: null, showWelcome: false });
});

test("ChatGPT welcome: dismissed for this run even when that cannot be saved, and the error says so", async (t) => {
  const { backend } = await credentials(t);
  await backend.update((c) => ({
    ...c,
    chatgpt: {
      issuer: "https://auth.openai.com",
      clientId: "oaiapp_x",
      subject: "s",
      email: null,
      name: null,
      idToken: "i",
      accessToken: "a",
      refreshToken: "r",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      savedAt: "2026-11-22T18:00:00.000Z",
    },
  }));
  let shown = false;
  const changes: Connections[] = [];
  const connections = new ConnectionService({
    store: backend,
    chatgpt: new ChatGptSession({ store: backend, openBrowser: async () => undefined, language: async () => "en", onChange: () => undefined, log: () => undefined }),
    claude: createAnthropicProvider({ fetch: anthropic().fetchStub }),
    // Like SettingsStore.markChatGptWelcomeShown when the file cannot be written.
    welcome: {
      shown: async () => shown,
      markShown: async () => {
        shown = true;
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    },
    onChange: (c) => changes.push(c),
    log: () => undefined,
  });
  assert.deepEqual((await connections.get()).chatgpt, { state: "connected", displayName: null, showWelcome: true });
  await assert.rejects(connections.dismissChatGptWelcome(), /EACCES/);
  assert.deepEqual((await connections.get()).chatgpt, { state: "connected", displayName: null, showWelcome: false });
  assert.deepEqual(changes.at(-1)?.chatgpt, { state: "connected", displayName: null, showWelcome: false }, "the interface is told, so the dialog closes");
});
