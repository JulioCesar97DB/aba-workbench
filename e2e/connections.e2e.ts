import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { AbaApi } from "../src/shared/api.ts";
import { connectionStubLog, expect, firstScreen, goTo, setStubAnswers, stubConnections, test } from "./app.ts";

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

test("Settings: the AI connection comes first, with the model in one line; then the language, the cases folder and About", async ({ app }) => {
  const page = await firstScreen(app);
  await openSettings(page);
  // The order she needs them in (owner's decision U12).
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["AI connection", "Screen language", "Cases folder", "About"]);
  const section = page.getByRole("region", { name: "AI connection" });
  await expect(section).toContainText("The AI drafts the case map and the sections. Nothing is sent unless you ask. Connect one; ChatGPT is the usual one.");
  await expect(section).toContainText("Model: the most capable (recommended)");
  const change = section.getByRole("button", { name: "Change", exact: true });
  await expect(change).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("combobox")).toHaveCount(0);
  await change.click();
  await expect(change).toHaveAttribute("aria-expanded", "true");
  await section.getByRole("combobox", { name: "Claude" }).click();
  await page.getByRole("option", { name: /about half the cost/ }).click();
  await expect(page.getByText("Saved. The next request uses it.")).toBeVisible();
  // Each provider by name once they differ.
  await expect(section).toContainText("Model: the most capable (recommended) for ChatGPT · about half the cost for Claude");
});

test("ChatGPT: sign in through the system browser, see the account, survive a restart, sign out", async ({ launch, profile }) => {
  const { jwks } = await signingKey();
  let app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  let page = await firstScreen(app);
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");
  await expect(card.getByText("Not connected")).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("AI not connected");

  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await expect(card.getByText("Finish signing in in your browser.", { exact: false })).toBeVisible();
  const authorize = await completeSignIn(app);
  expect(authorize.origin + authorize.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  // OpenAI's guidelines: once, after the first sign-in with plan use.
  const welcome = page.getByRole("dialog", { name: "You're using your ChatGPT plan" });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(welcome).toBeHidden();
  // The dialog closes at once; the main process saves that it was seen just after.
  await expect.poll(() => JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8")).chatgptWelcomeShown).toBe(true);
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chatgpt-account")).toHaveText("Signed in as Test Clinician");
  await expect(page.getByTestId("ai-status")).toHaveText("ChatGPT connected");

  // The interface never holds a token: not in the page, not in what window.aba returns.
  const html = await page.content();
  for (const secret of [TOKENS.access, TOKENS.refresh, CLIENT_ID, "clinician@example.invalid"]) expect(html).not.toContain(secret);
  expect(JSON.stringify(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.getConnections()))).toBe(JSON.stringify({ chatgpt: { state: "connected", displayName: "Test Clinician", showWelcome: false }, claude: { state: "not-connected" }, problem: null }));

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

  // A restart keeps the sign-in, and the welcome is not shown again.
  await app.close();
  app = await launch();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  page = await firstScreen(app);
  await openSettings(page);
  await expect(page.getByTestId("chatgpt-account")).toHaveText("Signed in as Test Clinician");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // From the keyboard: the button that had focus goes away, and focus lands on the card's heading.
  await page.getByTestId("chatgpt-card").getByRole("button", { name: "Sign out" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chatgpt-card").getByRole("heading", { name: "ChatGPT" })).toBeFocused();
  await expect(page.getByTestId("chatgpt-message")).toHaveText("Signed out. Your ChatGPT sign-in was removed from ABA Workbench.");
  await expect(page.getByTestId("chatgpt-card").getByText("Not connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use a different ChatGPT account" })).toBeVisible();
  const revoke = (await connectionStubLog(app)).requests.find((r) => r.url.endsWith("/oauth/revoke"));
  expect(new URLSearchParams(revoke!.body!).get("token")).toBe(TOKENS.refresh);
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after.chatgpt).toEqual({ issuer: "https://auth.openai.com", clientId: CLIENT_ID, subject: SUBJECT, signedOut: true });
});

test("ChatGPT: access denied says what happened, a paid plan as a possibility, and offers Claude; a plan scope not granted needs attention", async ({ app, profile }) => {
  const { jwks } = await signingKey();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  const page = await firstScreen(app);
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
  await expect(page.getByTestId("chatgpt-message")).toHaveText(
    "ChatGPT did not allow ABA Workbench to use this account's plan, so nothing was saved. Access may not have been allowed in the browser, or a paid ChatGPT plan, such as Plus or Pro, may be needed. You can sign in again, or connect Claude with an API key instead.",
  );
  await expect(card.getByText("Not connected")).toBeVisible();
  const saved = existsSync(path.join(profile, "credentials.json")) ? JSON.parse(readFileSync(path.join(profile, "credentials.json"), "utf8")) : null;
  expect(saved?.chatgpt ?? null).toEqual(saved?.chatgpt ? { issuer: "https://auth.openai.com", clientId: CLIENT_ID, signedOut: true } : null);

  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app, { scope: "openid profile email offline_access" });
  await expect(card.getByText("Needs attention")).toBeVisible();
  await expect(page.getByTestId("chatgpt-attention")).toContainText("ChatGPT did not allow ABA Workbench to use this account's plan.");
  await expect(page.getByTestId("chatgpt-attention")).toContainText("a paid ChatGPT plan, such as Plus or Pro, may be needed");
  await expect(page.getByTestId("chatgpt-attention")).toContainText("connect Claude with an API key instead");
  await expect(page.getByTestId("ai-status")).toHaveText("AI connection needs attention");
  await expect(card.getByRole("button", { name: "Sign in again and allow" })).toBeVisible();
});

test("ChatGPT: an account that cannot use its plan, then a session revoked elsewhere, each say what to do", async ({ app, profile }) => {
  const { jwks } = await signingKey();
  await stubConnections(app, { claudeKey: CLAUDE_KEY, jwks });
  const page = await firstScreen(app);
  await openSettings(page);
  const card = page.getByTestId("chatgpt-card");
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app);
  await page.getByRole("button", { name: "Got it" }).click();
  // OpenAI says this account cannot use its plan in apps: it needs attention, plainly, and stays so after a restart.
  await setStubAnswers(app, { chatgptModelsStatus: 403 });
  await card.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByTestId("chatgpt-attention")).toHaveText(
    "ChatGPT did not allow ABA Workbench to use this account's plan. A paid ChatGPT plan, such as Plus or Pro, may be needed, or the account's workspace or a policy may not allow it. You can sign out and sign in with another ChatGPT account, or connect Claude with an API key instead.",
  );
  await expect(card.getByRole("button", { name: "Check connection" })).toHaveCount(0);
  expect(JSON.parse(readFileSync(path.join(profile, "credentials.json"), "utf8")).chatgpt.planNotEligible).toBe(true);
  await expect(page.getByTestId("ai-status")).toHaveText("AI connection needs attention");
  await setStubAnswers(app, { chatgptModelsStatus: 200 });
  await card.getByRole("button", { name: "Sign out" }).click();
  await card.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await completeSignIn(app);
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
  const page = await firstScreen(app);
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
  let page = await firstScreen(app);
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
  page = await firstScreen(app);
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
  const page = await firstScreen(app);
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
  const page = await firstScreen(app);
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
  const page = await firstScreen(app);
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Conexión con la IA" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar con ChatGPT" })).toBeVisible();
  await expect(page.getByLabel("Clave de API de Claude")).toBeVisible();
  await expect(page.getByTestId("ai-status")).toHaveText("IA sin conectar");
});

test("ChatGPT: the plan welcome always closes, and says so when the settings file cannot remember it", async ({ launch, profile }) => {
  const credentials = {
    version: 1,
    hostId: "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10",
    claude: null,
    chatgpt: {
      issuer: "https://auth.openai.com",
      clientId: CLIENT_ID,
      subject: SUBJECT,
      email: null,
      name: "Test Clinician",
      idToken: "id-token-not-real",
      accessToken: "access-token-not-real",
      refreshToken: "refresh-token-not-real",
      tokenType: "Bearer",
      // Far ahead, so the app never tries to refresh these invented tokens.
      expiresAt: "2099-01-01T00:00:00.000Z",
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct", "openid"],
      savedAt: "2026-11-22T18:00:00.000Z",
    },
  };
  writeFileSync(path.join(profile, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  const app = await launch();
  const page = await firstScreen(app);
  // A folder where settings.json should be: no save can succeed from now on.
  rmSync(path.join(profile, "settings.json"));
  mkdirSync(path.join(profile, "settings.json"));
  await openSettings(page);
  const welcome = page.getByRole("dialog", { name: "You're using your ChatGPT plan" });
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(welcome).toBeHidden();
  await expect(page.getByTestId("chatgpt-message")).toHaveText("ABA Workbench could not remember that you saw this, so it may show again next time.");
  await expect(page.getByTestId("chatgpt-card").getByText("Connected", { exact: true })).toBeVisible();
});
