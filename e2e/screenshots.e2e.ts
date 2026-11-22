import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { Language } from "../src/shared/api.ts";
import { expect, goTo, setStubAnswers, stubConnections, test } from "./app.ts";

/*
 * Screenshots of the connection screen in each state and language, for review. Runs only
 * when ABA_SCREENSHOTS names a folder to write them to:
 *   ABA_SCREENSHOTS=/tmp/shots pnpm exec playwright test --project=built e2e/screenshots.e2e.ts
 * The states come from invented credentials files and the faked providers; nothing is sent.
 */
const out = process.env.ABA_SCREENSHOTS;
test.skip(!out, "set ABA_SCREENSHOTS to a folder to take the screenshots");

const HOST_ID = "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10";
const FAR = "2099-01-01T00:00:00.000Z";
const signedIn = (scopes: string[]) => ({
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_screenshot_not_real",
  subject: "screenshot-subject",
  email: "clinician@example.invalid",
  name: "Ana Pérez",
  idToken: "id-token-not-real",
  accessToken: "access-token-not-real",
  refreshToken: "refresh-token-not-real",
  tokenType: "Bearer",
  // Far ahead, so the app never tries to refresh these invented tokens.
  expiresAt: FAR,
  earliestRefreshAt: null,
  scopes,
  savedAt: "2026-11-22T18:00:00.000Z",
});
const PLAN = ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"];
const CLAUDE = { apiKey: "sk-ant-api03-screenshot-not-real", savedAt: "2026-11-22T18:00:00.000Z" };

const STATES: Array<{ name: string; file?: unknown; raw?: string; act?: (page: Page) => Promise<void> }> = [
  { name: "1-not-connected" },
  { name: "2-chatgpt-signing-in", act: async (page) => page.getByTestId("chatgpt-card").getByRole("button").first().click() },
  { name: "3-both-connected", file: { version: 1, hostId: HOST_ID, claude: CLAUDE, chatgpt: signedIn(PLAN) } },
  {
    name: "4-needs-attention-plan-and-key",
    file: { version: 1, hostId: HOST_ID, claude: CLAUDE, chatgpt: signedIn(["openid", "profile", "email", "offline_access"]) },
    act: async (page) => page.getByTestId("claude-card").getByRole("button").first().click(),
  },
  { name: "5-chatgpt-session-ended", file: { version: 1, hostId: HOST_ID, claude: null, chatgpt: { issuer: "https://auth.openai.com", clientId: "oaiapp_x", subject: "s", signedOut: true, sessionEnded: true } } },
  { name: "6-signed-out-saved-account", file: { version: 1, hostId: HOST_ID, claude: null, chatgpt: { issuer: "https://auth.openai.com", clientId: "oaiapp_x", subject: "s", signedOut: true } } },
  { name: "7-damaged-file", raw: "{ damaged" },
];

for (const language of ["en", "es"] as Language[]) {
  for (const state of STATES) {
    test(`${language} ${state.name}`, async ({ launch, profile }) => {
      if (state.file) writeFileSync(path.join(profile, "credentials.json"), JSON.stringify(state.file), { mode: 0o600 });
      if (state.raw) writeFileSync(path.join(profile, "credentials.json"), state.raw, { mode: 0o600 });
      const app = await launch({ language });
      await stubConnections(app, { claudeKey: "not-this-one", jwks: { keys: [] } });
      await setStubAnswers(app, { claudeStatus: 401 });
      const page = await app.firstWindow();
      await goTo(page, "/settings");
      const section = page.getByRole("region", { name: language === "en" ? "AI connection" : "Conexión con la IA" });
      await expect(section).toBeVisible();
      if (state.act) {
        await state.act(page);
        await page.waitForTimeout(400);
      }
      await section.scrollIntoViewIfNeeded();
      mkdirSync(out!, { recursive: true });
      await section.screenshot({ path: path.join(out!, `${language}-${state.name}.png`) });
      if (state.name === "3-both-connected" || state.name === "4-needs-attention-plan-and-key") {
        await page.screenshot({ path: path.join(out!, `${language}-${state.name}-window.png`) });
      }
    });
  }
}
