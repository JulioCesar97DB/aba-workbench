import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { AbaApi } from "../src/shared/api.ts";
import { connectionStubLog, expect, goTo, setStubAnswers, stubConnections, test } from "./app.ts";

/*
 * The AI connections in Settings, with both providers faked inside the main process
 * (stubConnections): no request leaves the computer and no real account is involved.
 * The test plays the browser: it reads the authorize address the app asked the system
 * browser to open, and sends the callback OpenAI would send.
 */

const CLAUDE_KEY = "sk-ant-api03-e2e-key-not-real-000000000000";
const CLIENT_ID = "oaiapp_e2e_client_not_real";
const SUBJECT = "e2e-subject-not-real";
const TOKENS = { access: "e2e-access-token-not-real", refresh: "e2e-refresh-token-not-real" };

let signing: Promise<{ key: CryptoKey; jwks: { keys: JWK[] } }> | null = null;
function signingKey() {
  signing ??= generateKeyPair("RS256", { extractable: true }).then(async ({ privateKey, publicKey }) => ({
    key: privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "e2e-key", alg: "RS256", use: "sig" }] },
  }));
  return signing;
}

async function idToken(nonce: string, claims: Record<string, unknown> = {}) {
  const { key } = await signingKey();
  return new SignJWT({ nonce, email: "clinician@example.invalid", name: "Test Clinician", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
    .setIssuer("https://auth.openai.com")
    .setAudience([CLIENT_ID])
    .setSubject(SUBJECT)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

/** A GET as the browser sends it when OpenAI redirects back. */
function browserGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function openSettings(page: Page) {
  await goTo(page, "/settings");
  await expect(page.locator("#page-title")).toHaveText(/Settings|Ajustes/);
}

/** Waits for the authorize address the app opened, then answers as OpenAI would after the user allows. */
async function completeSignIn(app: Parameters<typeof connectionStubLog>[0], options: { scope?: string; callback?: (url: URL) => URL } = {}) {
  let authorize: URL | null = null;
  await expect.poll(async () => {
    const opened = (await connectionStubLog(app)).opened;
    authorize = opened.length ? new URL(opened.at(-1)!) : null;
    return authorize?.searchParams.get("state") ?? null;
  }).not.toBeNull();
  const params = authorize!.searchParams;
  await setStubAnswers(app, {
    token: {
      access_token: TOKENS.access,
      refresh_token: TOKENS.refresh,
      id_token: await idToken(params.get("nonce")!),
      token_type: "Bearer",
      expires_in: 3600,
      scope: options.scope ?? "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
    },
  });
  let back = new URL(params.get("redirect_uri")!);
  back.searchParams.set("code", "e2e-code-not-real");
  back.searchParams.set("state", params.get("state")!);
  if (params.get("client_id") === "dynamic_agent_client") back.searchParams.set("client_id", CLIENT_ID);
  if (options.callback) back = options.callback(back);
  expect(await browserGet(back.href)).toBe(200);
  return authorize!;
}

test("ChatGPT: sign in through the system browser, see the account, survive a restart, sign out", async ({ launch, profile }) => {
  const { jwks } = await signingKey();
  let app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  let page = await app.firstWindow();
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");
  await expect(card.getByText("Not connected")).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("AI not connected");

  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(card.getByText("Finish signing in in your browser.", { exact: false })).toBeVisible();
  const authorize = await completeSignIn(app);
  expect(authorize.origin + authorize.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  // OpenAI's guidelines: once, after the first sign-in.
  const welcome = page.getByRole("dialog", { name: "You're using your ChatGPT plan" });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chatgpt-account")).toHaveText("Signed in as Test Clinician");
  await expect(page.getByTestId("ai-status")).toHaveText("ChatGPT connected");

  // The interface never holds a token: not in the page, not in what window.aba returns.
  const html = await page.content();
  for (const secret of [TOKENS.access, TOKENS.refresh, CLIENT_ID, "clinician@example.invalid"]) expect(html).not.toContain(secret);
  expect(JSON.stringify(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.getConnections()))).toBe(JSON.stringify({ chatgpt: { state: "connected", displayName: "Test Clinician" }, claude: { state: "not-connected" }, problem: null }));

  // The credentials file: owner-only, in the profile, holding the tokens.
  const file = path.join(profile, "credentials.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.chatgpt.accessToken).toBe(TOKENS.access);
  expect(saved.chatgpt.clientId).toBe(CLIENT_ID);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

  await card.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("chatgpt-message")).toHaveText("The connection works.");
  const models = (await connectionStubLog(app)).requests.find((r) => r.url === "https://api.openai.com/v1/models");
  expect(models?.authorization).toBe(`Bearer ${TOKENS.access}`);

  // A restart keeps the sign-in.
  await app.close();
  app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  page = await app.firstWindow();
  await openSettings(page);
  await expect(page.getByTestId("chatgpt-account")).toHaveText("Signed in as Test Clinician");

  await page.getByTestId("chatgpt-card").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("chatgpt-message")).toHaveText("Signed out. Your ChatGPT sign-in was removed from ABA Workbench.");
  await expect(page.getByTestId("chatgpt-card").getByText("Not connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a different ChatGPT account" })).toBeVisible();
  const revoke = (await connectionStubLog(app)).requests.find((r) => r.url.endsWith("/oauth/revoke"));
  expect(new URLSearchParams(revoke!.body!).get("token")).toBe(TOKENS.refresh);
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.chatgpt).toEqual({ issuer: "https://auth.openai.com", clientId: CLIENT_ID, subject: SUBJECT, signedOut: true });
});

test("ChatGPT: a declined plan permission needs attention and offers the alternatives; a declined sign-in saves nothing", async ({ app, profile }) => {
  const { jwks } = await signingKey();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  const page = await app.firstWindow();
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");

  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app, {
    callback: (url) => {
      const declined = new URL(url.origin + url.pathname);
      declined.searchParams.set("error", "access_denied");
      declined.searchParams.set("state", url.searchParams.get("state")!);
      return declined;
    },
  });
  await expect(page.getByTestId("chatgpt-message")).toContainText("You declined in the browser, so nothing was saved.");
  expect(existsSync(path.join(profile, "credentials.json")) ? JSON.parse(readFileSync(path.join(profile, "credentials.json"), "utf8")).chatgpt : null).toBeNull();

  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app, { scope: "openid profile email offline_access" });
  await expect(card.getByText("Needs attention")).toBeVisible();
  await expect(card.getByText("did not allow ABA Workbench to use your ChatGPT plan", { exact: false }).first()).toBeVisible();
  await expect(card.getByText("connect Claude with an API key instead", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("AI connection needs attention");
  await expect(card.getByRole("button", { name: "Sign in again and allow" })).toBeVisible();
});

test("ChatGPT: a session revoked elsewhere shows as needing a new sign-in", async ({ app }) => {
  const { jwks } = await signingKey();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  const page = await app.firstWindow();
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app);
  await page.getByRole("button", { name: "Got it" }).click();
  // ChatGPT refuses the token, and the refresh token too.
  await setStubAnswers(app, { chatgptModelsStatus: 401, token: { error: "refresh_token_invalidated" }, tokenStatus: 400 });
  await card.getByRole("button", { name: "Check connection" }).click();
  await expect(card.getByText("Your ChatGPT sign-in has ended", { exact: false })).toBeVisible();
  await expect(card.getByText("Needs attention")).toBeVisible();
  await expect(card.getByRole("button", { name: "Sign in again" })).toBeVisible();
});

test("ChatGPT: cancelling the sign-in stops listening for the browser", async ({ app }) => {
  const { jwks } = await signingKey();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  const page = await app.firstWindow();
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect.poll(async () => (await connectionStubLog(app)).opened.length).toBe(1);
  const redirect = new URL(new URL((await connectionStubLog(app)).opened[0]).searchParams.get("redirect_uri")!);
  await card.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(page.getByTestId("chatgpt-message")).toHaveText("Sign-in cancelled. Nothing was saved.");
  await expect(browserGet(redirect.href + "?code=late&state=x")).rejects.toThrow(/ECONNREFUSED/);
});

test("Claude: a wrong key says so, a good key connects and is kept, removing it forgets it", async ({ launch, profile }) => {
  const { jwks } = await signingKey();
  let app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  let page = await app.firstWindow();
  await openSettings(page);
  const card = page.getByTestId("claude-card");
  const field = card.getByLabel("Claude API key");

  await field.fill("sk-proj-an-openai-key");
  await card.getByRole("button", { name: "Check and save" }).click();
  await expect(card.getByText("This is not a Claude API key. Claude keys start with sk-ant-.")).toBeVisible();
  expect((await connectionStubLog(app)).requests).toEqual([]);

  await field.fill("sk-ant-api03-wrong-key");
  await card.getByRole("button", { name: "Check and save" }).click();
  await expect(card.getByText("Anthropic did not accept this key.", { exact: false })).toBeVisible();
  expect(existsSync(path.join(profile, "credentials.json"))).toBe(false);

  await field.fill(` ${CLAUDE_KEY}\n`);
  await card.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByTestId("claude-message")).toHaveText("Key saved. Claude is connected.");
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("Claude connected");
  expect(await page.content()).not.toContain(CLAUDE_KEY);
  const file = path.join(profile, "credentials.json");
  expect(JSON.parse(readFileSync(file, "utf8")).claude.apiKey).toBe(CLAUDE_KEY);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

  await app.close();
  app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  page = await app.firstWindow();
  await openSettings(page);
  await expect(page.getByTestId("claude-card").getByText("A key is saved in ABA Workbench.")).toBeVisible();
  // Anthropic no longer accepts it (deleted in the Console): it needs attention.
  await setStubAnswers(app, { claudeStatus: 401 });
  await page.getByTestId("claude-card").getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("claude-card").getByText("Needs attention")).toBeVisible();
  await page.getByTestId("claude-card").getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByTestId("claude-message")).toHaveText("Key removed from ABA Workbench.");
  await expect(page.getByTestId("ai-status")).toHaveText("AI not connected");
  expect(JSON.parse(readFileSync(file, "utf8")).claude).toBeNull();
});

test("a damaged credentials file shows both as not connected, is never overwritten, and Start over sets it aside", async ({ launch, profile }) => {
  const file = path.join(profile, "credentials.json");
  writeFileSync(file, "{ damaged", { mode: 0o600 });
  const app = await launch();
  const page = await app.firstWindow();
  await openSettings(page);
  await expect(page.getByTestId("credentials-problem")).toContainText("the file that keeps them is damaged");
  await expect(page.getByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled();
  expect(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.saveClaudeKey("sk-ant-api03-anything"))).toEqual({ outcome: "credentials-problem", problem: "damaged" });
  expect(readFileSync(file, "utf8")).toBe("{ damaged");

  await page.getByRole("button", { name: "Start over…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start over with your connections?" });
  await dialog.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByTestId("credentials-problem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled();
  const aside = readdirSync(profile).filter((name) => name.startsWith("credentials.json.unreadable-"));
  expect(aside).toHaveLength(1);
  expect(readFileSync(path.join(profile, aside[0]), "utf8")).toBe("{ damaged");
});

test("the connection functions refuse hostile input and return no secret", async ({ app }) => {
  const page = await app.firstWindow();
  const results = await page.evaluate(async () => {
    const attempt = (call: () => Promise<unknown>) => call().then((value) => ({ value }), (error: Error) => ({ error: error.message }));
    const aba = (globalThis as unknown as { aba: Record<string, (...args: unknown[]) => Promise<unknown>> }).aba;
    return {
      number: await attempt(() => aba.saveClaudeKey(42)),
      object: await attempt(() => aba.saveClaudeKey({ key: "sk-ant-x" })),
      huge: await attempt(() => aba.saveClaudeKey("sk-ant-" + "x".repeat(5000))),
      forget: await attempt(() => aba.forgetChatGptAccount()),
      startOver: await attempt(() => aba.startOverConnections()),
    };
  });
  expect(results.number).toEqual({ error: expect.stringContaining("Refused: the key must be text") });
  expect(results.object).toEqual({ error: expect.stringContaining("Refused: the key must be text") });
  expect(results.huge).toEqual({ error: expect.stringContaining("Refused: the key must be text") });
  expect(results.forget).toEqual({ value: { outcome: "removed" } });
  expect(results.startOver).toEqual({ value: { outcome: "not-needed" } });
});

test("the connection screen in Spanish", async ({ launch }) => {
  const app = await launch({ language: "es" });
  const page = await app.firstWindow();
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Conexión con la IA" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar con ChatGPT" })).toBeVisible();
  await expect(page.getByLabel("Clave de API de Claude")).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("IA sin conectar");
});
