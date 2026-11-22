import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createOpenAIProvider } from "../src/lib/providers/openai.ts";
import { DYNAMIC_CLIENT_ID, OAuthClient, authorizeUrl, newAttempt, pkceChallenge, readTokenResponse } from "../src/main/chatgpt-oauth.ts";
import { ChatGptSession, REFRESH_MARGIN_MS, refreshDueAt } from "../src/main/chatgpt-session.ts";
import { CREDENTIALS_FILE_NAME, CredentialsStore } from "../src/main/credentials.ts";
import { checkCallbackRequest, startCallbackListener, type Refusal } from "../src/main/oauth-callback.ts";
import { fakeOpenAI, ISSUED_CLIENT_ID, SUBJECT, tokenResponse, type FakeOpenAI } from "./fake-openai.ts";

/** A GET as a browser's top-level navigation sends it: no Origin (Node's fetch would add Sec-Fetch-Mode: cors). */
function browserGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" };

test("PKCE: the challenge is the verifier's SHA-256 in base64url without padding (RFC 7636's example)", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const attempt = newAttempt({ redirectUri: "http://127.0.0.1:1455/auth/callback", clientId: DYNAMIC_CLIENT_ID, hostId: "urn:uuid:x" });
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(pkceChallenge(attempt.verifier), createHash("sha256").update(attempt.verifier).digest("base64url"));
  const other = newAttempt({ redirectUri: attempt.redirectUri, clientId: DYNAMIC_CLIENT_ID, hostId: "urn:uuid:x" });
  assert.notEqual(other.state, attempt.state, "state is fresh for every attempt");
  assert.notEqual(other.nonce, attempt.nonce);
  assert.notEqual(other.verifier, attempt.verifier);
});

test("authorize address: first registration and a later sign-in, as OpenAI's docs list the parameters", () => {
  const attempt = newAttempt({ redirectUri: "http://127.0.0.1:1455/auth/callback", clientId: DYNAMIC_CLIENT_ID, hostId: "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10" });
  const first = new URL(authorizeUrl(attempt, { idToken: "ignored", email: "ignored@example.invalid" }));
  assert.equal(first.origin + first.pathname, "https://auth.openai.com/api/accounts/authorize");
  const p = first.searchParams;
  assert.equal(p.get("client_id"), "dynamic_agent_client");
  assert.equal(p.get("agent_name_hint"), "ABA Workbench");
  assert.equal(p.get("ext_agent_host_id"), "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(p.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(p.get("resource"), "https://api.openai.com/v1");
  assert.equal(p.get("state"), attempt.state);
  assert.equal(p.get("nonce"), attempt.nonce);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("code_challenge"), pkceChallenge(attempt.verifier));
  assert.equal(p.has("id_token_hint"), false, "no hints on a first registration");
  assert.equal(p.has("login_hint"), false);
  assert.equal(p.has("prompt"), false, "consent is not forced on an ordinary sign-in");
  assert.equal(first.href.includes(attempt.verifier), false, "the verifier never leaves");

  const again = newAttempt({ redirectUri: "http://127.0.0.1:54321/auth/callback", clientId: ISSUED_CLIENT_ID, hostId: "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10" });
  const later = new URL(authorizeUrl(again, { idToken: "id.token.hint", email: "clinician@example.invalid", consent: true })).searchParams;
  assert.equal(later.get("client_id"), ISSUED_CLIENT_ID);
  assert.equal(later.has("agent_name_hint"), false);
  assert.equal(later.get("id_token_hint"), "id.token.hint");
  assert.equal(later.get("login_hint"), "clinician@example.invalid");
  assert.equal(later.get("prompt"), "consent", "asking again after a declined plan permission");
});

test("token response: expiry from expires_in, scopes as a list, earliest_refresh_at in either form", () => {
  const now = Date.parse("2026-11-22T18:00:00Z");
  const set = readTokenResponse({ access_token: "a", refresh_token: "r", id_token: "i", token_type: "bearer", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct", earliest_refresh_at: 1795370400 }, now);
  assert.deepEqual(set, { accessToken: "a", refreshToken: "r", idToken: "i", expiresAt: "2026-11-22T19:00:00.000Z", earliestRefreshAt: new Date(1795370400 * 1000).toISOString(), scopes: ["openid", "chatgpt.tokens.use.direct"] });
  assert.equal(readTokenResponse({ access_token: "a", token_type: "Bearer", expires_in: 3600, earliest_refresh_at: "2026-11-22T18:30:00Z" }, now)?.earliestRefreshAt, "2026-11-22T18:30:00.000Z");
  assert.equal(readTokenResponse({ access_token: "a", token_type: "mac", expires_in: 3600 }, now), null);
  assert.equal(readTokenResponse({ token_type: "Bearer", expires_in: 3600 }, now), null);
});

test("ID token: signature, issuer, audience, expiry and nonce are all checked", async () => {
  const fake = await fakeOpenAI();
  const oauth = new OAuthClient({ fetch: fake.fetch });
  const ok = await oauth.verifyIdToken(await fake.idToken({ nonce: "n-1" }), { clientId: ISSUED_CLIENT_ID, nonce: "n-1" });
  assert.deepEqual(ok, { subject: SUBJECT, email: "clinician@example.invalid", name: "Test Clinician" });
  const bad: Array<[string, Promise<string>, string]> = [
    ["another key", fake.idToken({ nonce: "n-1" }, { key: "other" }), "n-1"],
    ["wrong issuer", fake.idToken({ nonce: "n-1", iss: "https://attacker.invalid" }), "n-1"],
    ["wrong audience", fake.idToken({ nonce: "n-1", aud: "oaiapp_someone_else" }), "n-1"],
    ["expired", fake.idToken({ nonce: "n-1", exp: Math.floor(Date.now() / 1000) - 60 }), "n-1"],
    ["wrong nonce", fake.idToken({ nonce: "n-2" }), "n-1"],
    ["no nonce", fake.idToken({}), "n-1"],
    ["unknown key id", fake.idToken({ nonce: "n-1" }, { kid: "not-published" }), "n-1"],
  ];
  for (const [name, token, nonce] of bad) {
    await assert.rejects(oauth.verifyIdToken(await token, { clientId: ISSUED_CLIENT_ID, nonce }), { code: "invalid_id_token" }, name);
  }
  await assert.rejects(oauth.verifyIdToken("not.a.jwt", { clientId: ISSUED_CLIENT_ID, nonce: null }), { code: "invalid_id_token" });
  const name = await oauth.verifyIdToken(await fake.idToken({ nonce: "n", name: "Ana\u{202e}\u{7} Pérez" }), { clientId: ISSUED_CLIENT_ID, nonce: "n" });
  assert.equal(name.name, "Ana Pérez", "control and text-direction characters are dropped from the name shown");
});

test("callback checks: method, host, path, other origins, state", () => {
  const expected = { port: 1455, state: "the-state" };
  const ok = { method: "GET", url: "/auth/callback?code=c&state=the-state", headers: { host: "127.0.0.1:1455", ...NAVIGATE } as Record<string, string> };
  assert.equal(checkCallbackRequest(ok, expected).ok, true);
  const refused: Array<[Refusal, { method?: string; url?: string; headers?: Record<string, string> }]> = [
    ["method", { method: "POST" }],
    ["host", { headers: { host: "localhost:1455" } }],
    ["host", { headers: { host: "evil.example:1455" } }],
    ["host", { headers: { host: "127.0.0.1:1456" } }],
    ["path", { url: "/callback?code=c&state=the-state" }],
    ["path", { url: "/auth/callback/x?code=c&state=the-state" }],
    ["cross-origin", { headers: { ...ok.headers, origin: "https://evil.example" } }],
    ["cross-origin", { headers: { ...ok.headers, "sec-fetch-mode": "cors" } }],
    ["cross-origin", { headers: { ...ok.headers, "sec-fetch-mode": "no-cors" } }],
    ["cross-origin", { headers: { ...ok.headers, "sec-fetch-dest": "image" } }],
    ["state", { url: "/auth/callback?code=c&state=another" }],
    ["state", { url: "/auth/callback?code=c" }],
    ["state", { url: "/auth/callback?code=c&state=the-state&state=the-state" }],
  ];
  for (const [refusal, change] of refused) {
    const request = { ...ok, ...change, headers: change.headers ?? ok.headers };
    assert.deepEqual(checkCallbackRequest(request, expected), { ok: false, refusal }, JSON.stringify(change));
  }
});

test("callback listener: wrong state, another origin and a replay are refused; only the first valid answer counts", async () => {
  const refusals: Refusal[] = [];
  const listener = await startCallbackListener({ state: "s3cret", language: () => "en", preferredPort: 0, onRefused: (r) => refusals.push(r) });
  assert.ok(listener);
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const base = listener.redirectUri;
  assert.equal((await browserGet(base + "?code=stolen&state=guess")).status, 400);
  assert.equal((await browserGet(base + "?code=stolen&state=s3cret", { origin: "https://evil.example", "sec-fetch-mode": "cors" })).status, 400);
  assert.equal((await browserGet(base + "?code=stolen&state=s3cret", { host: "attacker.example" })).status, 400, "a DNS-rebinding page sends its own name");
  const good = await browserGet(base + "?code=the-code&state=s3cret&client_id=" + ISSUED_CLIENT_ID, NAVIGATE);
  assert.equal(good.status, 200);
  assert.match(good.body, /You can close this tab/);
  assert.equal(good.headers["cache-control"], "no-store");
  assert.equal(good.headers["referrer-policy"], "no-referrer");
  assert.match(String(good.headers["content-security-policy"]), /default-src 'none'/);
  assert.deepEqual(await listener.answer, { kind: "code", code: "the-code", clientId: ISSUED_CLIENT_ID, scope: null });
  // A replay of the same callback, and a second one, are never accepted.
  assert.equal((await browserGet(base + "?code=the-code&state=s3cret")).status, 410);
  assert.equal((await browserGet(base + "?code=other&state=s3cret")).status, 410);
  await listener.close();
  await assert.rejects(browserGet(base + "?code=the-code&state=s3cret"), /ECONNREFUSED/, "closed: nothing listens any more");
  assert.deepEqual(refusals, ["state", "cross-origin", "host", "used", "used"]);
});

test("callback listener: when the preferred port is taken, a port the system picks", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const taken = (blocker.address() as AddressInfo).port;
  try {
    const listener = await startCallbackListener({ state: "s", language: () => "en", preferredPort: taken });
    assert.ok(listener);
    assert.notEqual(listener.port, taken);
    assert.equal(listener.onPreferredPort, false);
    await listener.close();
  } finally {
    blocker.close();
  }
});

/** A session against the fake OpenAI, with a browser that allows by default. */
async function setup(t: { after: (fn: () => Promise<void> | void) => void }, options: { now?: () => number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "aba-chatgpt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = options.now ?? Date.now;
  const fake = await fakeOpenAI(now);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  const store = new CredentialsStore(file, { log: () => undefined, restrict: async () => undefined });
  const opened: URL[] = [];
  let browser = async (url: URL) => {
    const p = url.searchParams;
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", "code-not-real");
    back.searchParams.set("state", p.get("state")!);
    if (p.get("client_id") === DYNAMIC_CLIENT_ID) back.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await browserGet(back.href, NAVIGATE);
  };
  const session = new ChatGptSession({
    store,
    oauth: new OAuthClient({ fetch: fake.fetch, now }),
    openai: createOpenAIProvider({ fetch: fake.fetch }),
    openBrowser: async (url) => {
      opened.push(new URL(url));
      setImmediate(() => void browser(new URL(url)).catch(() => undefined));
    },
    language: async () => "en",
    onChange: () => undefined,
    now,
    preferredPort: 0,
    timeoutMs: 2_000,
    sleep: async () => undefined,
    log: () => undefined,
  });
  t.after(() => session.cancelTimer());
  /** The exchange answers with tokens whose ID token carries the nonce of the last authorize address. */
  const exchangeAnswers = (fields: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) => async () =>
    tokenResponse({ id_token: await fake.idToken({ nonce: opened.at(-1)!.searchParams.get("nonce"), ...claims }), ...fields });
  return { fake: fake as FakeOpenAI, store, file, session, opened, setBrowser: (next: typeof browser) => (browser = next), exchangeAnswers };
}

const saved = async (file: string) => JSON.parse(await readFile(file, "utf8"));

test("sign-in: first registration end to end, then a check with the model list", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  assert.deepEqual(await s.session.signIn(), { outcome: "signed-in", firstTime: true });
  const exchange = s.fake.calls.find((c) => c.url.endsWith("/oauth/token"))!;
  const authorize = s.opened[0].searchParams;
  assert.equal(exchange.form?.get("grant_type"), "authorization_code");
  assert.equal(exchange.form?.get("client_id"), ISSUED_CLIENT_ID, "the issued id, never dynamic_agent_client");
  assert.equal(exchange.form?.get("code"), "code-not-real");
  assert.equal(exchange.form?.get("redirect_uri"), authorize.get("redirect_uri"), "the exact same redirect URI");
  assert.equal(exchange.form?.get("resource"), "https://api.openai.com/v1");
  assert.equal(pkceChallenge(exchange.form!.get("code_verifier")!), authorize.get("code_challenge"));
  assert.equal(exchange.form?.has("client_secret"), false);

  const file = await saved(s.file);
  assert.equal(file.hostId, authorize.get("ext_agent_host_id"), "the host id was saved before it was sent");
  assert.equal(file.chatgpt.clientId, ISSUED_CLIENT_ID);
  assert.equal(file.chatgpt.subject, SUBJECT);
  assert.equal(file.chatgpt.accessToken, "access-token-not-real");
  assert.equal(file.chatgpt.refreshToken, "refresh-token-not-real");
  assert.ok(file.chatgpt.scopes.includes("chatgpt.tokens.use.direct"));
  assert.deepEqual(s.session.state(file.chatgpt), { state: "connected", displayName: "Test Clinician" });

  assert.deepEqual(await s.session.check(), { outcome: "working" });
  const models = s.fake.calls.find((c) => c.url === "https://api.openai.com/v1/models")!;
  assert.equal(models.headers.get("authorization"), "Bearer access-token-not-real");
});

test("sign-in: a later sign-in reuses the issued client id and host id, with the hints; another account changes nothing", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  const hostId = s.opened[0].searchParams.get("ext_agent_host_id");
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  assert.deepEqual(await s.session.signIn(), { outcome: "signed-in", firstTime: false });
  const second = s.opened[1].searchParams;
  assert.equal(second.get("client_id"), ISSUED_CLIENT_ID);
  assert.equal(second.get("ext_agent_host_id"), hostId);
  assert.equal(second.has("agent_name_hint"), false);
  assert.ok(second.get("id_token_hint"));
  assert.equal(second.get("login_hint"), "clinician@example.invalid");

  const before = await readFile(s.file, "utf8");
  s.fake.tokenAnswers = [s.exchangeAnswers({ access_token: "someone-elses-token" }, { sub: "another-person" })];
  assert.deepEqual(await s.session.signIn(), { outcome: "different-account" });
  assert.equal(await readFile(s.file, "utf8"), before, "the saved sign-in is untouched");
});

test("sign-in: the user declines, cancels, or closes the browser: nothing is saved", async (t) => {
  const s = await setup(t);
  s.setBrowser(async (url) => {
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", url.searchParams.get("state")!);
    await browserGet(back.href);
  });
  assert.deepEqual(await s.session.signIn(), { outcome: "declined" });
  assert.equal(s.fake.calls.filter((c) => c.url.endsWith("/oauth/token")).length, 0, "no code is exchanged");

  s.setBrowser(async () => undefined); // the user closed the browser
  const pending = s.session.signIn();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(s.session.state(null), { state: "signing-in", otherPort: false });
  assert.deepEqual(await s.session.signIn(), { outcome: "already-signing-in" });
  s.session.cancelSignIn();
  assert.deepEqual(await pending, { outcome: "cancelled" });
  assert.deepEqual(await s.session.signIn(), { outcome: "timed-out" });

  const read = await s.store.read();
  assert.ok(read.ok);
  assert.equal(read.credentials?.chatgpt, null);
  assert.deepEqual(s.session.state(null), { state: "not-connected", savedAccount: false });
});

test("sign-in: a callback with the wrong state is ignored, the right one still completes", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  s.setBrowser(async (url) => {
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "forged");
    back.searchParams.set("state", "forged-state");
    assert.equal((await browserGet(back.href)).status, 400);
    back.searchParams.set("code", "code-not-real");
    back.searchParams.set("state", url.searchParams.get("state")!);
    back.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await browserGet(back.href);
  });
  assert.deepEqual(await s.session.signIn(), { outcome: "signed-in", firstTime: true });
  assert.equal(s.fake.calls.find((c) => c.url.endsWith("/oauth/token"))?.form?.get("code"), "code-not-real");
});

test("sign-in: a registration without an issued client id, an ID token that fails, or invalid_grant save nothing", async (t) => {
  const s = await setup(t);
  s.setBrowser(async (url) => {
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "c");
    back.searchParams.set("state", url.searchParams.get("state")!);
    await browserGet(back.href);
  });
  assert.deepEqual(await s.session.signIn(), { outcome: "failed" }, "registration incomplete");
  const s2 = await setup(t);
  s2.fake.tokenAnswers = [async () => tokenResponse({ id_token: await s2.fake.idToken({ nonce: "not-this-attempts" }) })];
  assert.deepEqual(await s2.session.signIn(), { outcome: "failed" }, "nonce mismatch");
  s2.fake.tokenAnswers = [() => Response.json({ error: "invalid_grant" }, { status: 400 })];
  assert.deepEqual(await s2.session.signIn(), { outcome: "failed" }, "invalid_grant: the code is discarded");
  assert.equal((await saved(s2.file)).chatgpt, null);
});

test("sign-in: declining the plan permission keeps the sign-in but needs attention; asking again forces consent", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers({ scope: "openid profile email offline_access" })];
  assert.deepEqual(await s.session.signIn(), { outcome: "plan-not-allowed" });
  assert.deepEqual(s.session.state((await saved(s.file)).chatgpt), { state: "needs-attention", reason: "plan-not-allowed", displayName: "Test Clinician" });
  assert.deepEqual(await s.session.check(), { outcome: "not-connected" }, "no request is made for plan use without the permission");
  assert.equal(s.fake.calls.filter((c) => c.url.includes("api.openai.com")).length, 0);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  assert.deepEqual(await s.session.signIn(), { outcome: "signed-in", firstTime: false });
  assert.equal(s.opened[1].searchParams.get("prompt"), "consent");
  assert.equal(s.opened[1].searchParams.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", "the complete scope set again");
});

test("refresh: before expiry, with the issued client id; the rotating refresh token and the rest are replaced together", async (t) => {
  let clock = Date.parse("2026-11-22T18:00:00Z");
  const s = await setup(t, { now: () => clock });
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  assert.equal(refreshDueAt((await saved(s.file)).chatgpt), Date.parse("2026-11-22T19:00:00Z") - REFRESH_MARGIN_MS);
  assert.equal(await s.session.accessToken(), "access-token-not-real", "not near expiry: no refresh");
  assert.equal(s.fake.calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);

  clock = Date.parse("2026-11-22T18:56:00Z");
  s.fake.tokenAnswers = [() => tokenResponse({ access_token: "access-2", refresh_token: "refresh-2" })];
  const [a, b] = await Promise.all([s.session.accessToken(), s.session.accessToken()]);
  assert.equal(a, "access-2");
  assert.equal(b, "access-2");
  const refreshes = s.fake.calls.filter((c) => c.form?.get("grant_type") === "refresh_token");
  assert.equal(refreshes.length, 1, "two callers, one refresh: a rotating token is never used twice");
  assert.equal(refreshes[0].form?.get("client_id"), ISSUED_CLIENT_ID);
  assert.equal(refreshes[0].form?.get("refresh_token"), "refresh-token-not-real");
  assert.equal(refreshes[0].form?.get("resource"), "https://api.openai.com/v1");
  assert.equal(refreshes[0].form?.has("scope"), false, "no scope: the grant is kept");
  const after = (await saved(s.file)).chatgpt;
  assert.equal(after.accessToken, "access-2");
  assert.equal(after.refreshToken, "refresh-2");
  assert.equal(after.expiresAt, "2026-11-22T19:56:00.000Z");
});

test("refresh: earliest_refresh_at is respected while the token is still valid", async (t) => {
  let clock = Date.parse("2026-11-22T18:00:00Z");
  const s = await setup(t, { now: () => clock });
  s.fake.tokenAnswers = [s.exchangeAnswers({ expires_in: 600, earliest_refresh_at: "2026-11-22T18:08:00Z" })];
  await s.session.signIn();
  clock = Date.parse("2026-11-22T18:06:00Z"); // inside the 5-minute margin, before the earliest refresh
  assert.equal(await s.session.accessToken(), "access-token-not-real");
  assert.equal(s.fake.calls.filter((c) => c.form?.get("grant_type") === "refresh_token").length, 0);
});

test("refresh: a network failure keeps the tokens; an unusable refresh token ends the session, which then needs a new sign-in", async (t) => {
  let clock = Date.parse("2026-11-22T18:00:00Z");
  const s = await setup(t, { now: () => clock });
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  clock = Date.parse("2026-11-22T18:58:00Z");
  s.fake.tokenAnswers = [() => new Response("", { status: 503 })];
  assert.equal(await s.session.accessToken(), "access-token-not-real", "not expired yet: the current token still works");
  assert.equal((await saved(s.file)).chatgpt.refreshToken, "refresh-token-not-real", "kept");
  for (const code of ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]) {
    clock = Date.parse("2026-11-22T18:00:00Z");
    const s2 = await setup(t, { now: () => clock });
    s2.fake.tokenAnswers = [s2.exchangeAnswers()];
    await s2.session.signIn();
    clock = Date.parse("2026-11-22T18:58:00Z");
    s2.fake.tokenAnswers = [() => Response.json({ error: code }, { status: 400 })];
    await assert.rejects(s2.session.accessToken(), { reason: "session-ended" }, code);
    const record = (await saved(s2.file)).chatgpt;
    assert.deepEqual(record, { issuer: "https://auth.openai.com", clientId: ISSUED_CLIENT_ID, subject: SUBJECT, signedOut: true, sessionEnded: true }, code);
    assert.deepEqual(s2.session.state(record as never), { state: "needs-attention", reason: "session-ended", displayName: null });
    assert.deepEqual(await s2.session.check(), { outcome: "rejected" });
  }
});

test("check: a revoked session (401 again after a refresh) needs a new sign-in", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers(), () => tokenResponse({ access_token: "access-2" })];
  await s.session.signIn();
  s.fake.modelsAnswer = () => Response.json({ detail: "Unauthorized" }, { status: 401 });
  assert.deepEqual(await s.session.check(), { outcome: "rejected" });
  assert.equal(s.fake.calls.filter((c) => c.form?.get("grant_type") === "refresh_token").length, 1, "one forced refresh first");
  const record = (await saved(s.file)).chatgpt;
  assert.equal(record.sessionEnded, true);
  assert.equal("accessToken" in record, false);
});

test("sign-out: revokes the refresh token, removes the tokens, email and name, keeps the client id, subject and host id", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  const hostId = (await saved(s.file)).hostId;
  assert.deepEqual(await s.session.signOut(), { outcome: "signed-out", revocationConfirmed: true });
  const revoke = s.fake.calls.find((c) => c.url.endsWith("/oauth/revoke"))!;
  assert.equal(revoke.form?.get("token"), "refresh-token-not-real");
  assert.equal(revoke.form?.get("token_type_hint"), "refresh_token");
  assert.equal(revoke.form?.get("client_id"), ISSUED_CLIENT_ID);
  const file = await saved(s.file);
  assert.equal(file.hostId, hostId);
  assert.deepEqual(file.chatgpt, { issuer: "https://auth.openai.com", clientId: ISSUED_CLIENT_ID, subject: SUBJECT, signedOut: true });
  assert.doesNotMatch(JSON.stringify(file), /token-not-real|clinician@|Test Clinician/);
  assert.deepEqual(s.session.state(file.chatgpt), { state: "not-connected", savedAccount: true });

  // The next sign-in returns to the same registration, without the ID token hint.
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  assert.equal(s.opened[1].searchParams.get("client_id"), ISSUED_CLIENT_ID);
  assert.equal(s.opened[1].searchParams.has("id_token_hint"), false);
});

test("sign-out: when OpenAI cannot confirm (5xx), it retries, then signs out here and says so", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  s.fake.revokeAnswers = [() => new Response("", { status: 503 })];
  assert.deepEqual(await s.session.signOut(), { outcome: "signed-out", revocationConfirmed: false });
  assert.equal(s.fake.calls.filter((c) => c.url.endsWith("/oauth/revoke")).length, 3, "three tries");
  assert.equal((await saved(s.file)).chatgpt.signedOut, true);
});

test("use a different account: forgets the signed-out registration; refused while signed in", async (t) => {
  const s = await setup(t);
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  await assert.rejects(s.session.forgetAccount(), /Refused: sign out of ChatGPT first/);
  await s.session.signOut();
  assert.deepEqual(await s.session.forgetAccount(), { outcome: "removed" });
  const file = await saved(s.file);
  assert.equal(file.chatgpt, null);
  assert.match(file.hostId, /^urn:uuid:/, "the host id stays: it belongs to this computer");
  s.fake.tokenAnswers = [s.exchangeAnswers()];
  await s.session.signIn();
  assert.equal(s.opened.at(-1)!.searchParams.get("client_id"), DYNAMIC_CLIENT_ID, "a new registration");
});

test("sign-in: no port at all means port-in-use, and nothing opens", async (t) => {
  const s = await setup(t);
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server) {
    setImmediate(() => this.emit("error", Object.assign(new Error("in use"), { code: "EADDRINUSE" })));
    return this;
  } as typeof listen;
  try {
    assert.deepEqual(await s.session.signIn(), { outcome: "port-in-use" });
  } finally {
    net.Server.prototype.listen = listen;
  }
  assert.equal(s.opened.length, 0);
});
