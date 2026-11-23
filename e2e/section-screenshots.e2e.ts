import path from "node:path";
import type { Page } from "@playwright/test";
import type { AbaApi, Language } from "../src/shared/api.ts";
import { defaultCasesFolder, expect, firstScreen, goTo, SAMPLE_CASE, seedCase, setDraftingSpeed, stubDrafting, test } from "./app.ts";

/*
 * Screenshots of the section workspace in each state and language, for review. Runs only
 * when ABA_SCREENSHOTS names a folder to write them to:
 *   ABA_SCREENSHOTS=/tmp/shots pnpm exec playwright test --project=built e2e/section-screenshots.e2e.ts
 * The case is invented and Claude is faked inside the main process; nothing is sent.
 */
const out = process.env.ABA_SCREENSHOTS;
test.skip(!out, "set ABA_SCREENSHOTS to a folder to take the screenshots");

const CLAUDE_KEY = "sk-ant-api03-screenshot-key-not-real-0000000";
const SOURCES = [
  { id: "0d3c6a52-8a3e-4b8f-9d0e-6c1f2a7b5e44", kind: "text", type: "cde", addedAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", text: "Invented CDE notes." },
  { id: "1e4d7b63-9b4f-4c9a-8e1f-7d2a3b8c6f55", kind: "text", type: "parent-interview", addedAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", text: "Invented interview notes." },
  { id: "2f5e8c74-ac50-4dab-9f20-8e3b4c9d7a66", kind: "text", type: "direct-observation", addedAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", text: "Invented observation notes." },
];

for (const language of ["en", "es"] as Language[]) {
  test(`the section workspace in every state (${language})`, async ({ launch, home }) => {
    const es = language === "es";
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out!, `${language}-${name}.png`) });
    seedCase(defaultCasesFolder(home), SAMPLE_CASE.label, { ...SAMPLE_CASE, label: "Mateo F. (invented)", sources: SOURCES });
    const app = await launch({ language });
    await stubDrafting(app, { claudeKey: CLAUDE_KEY, consistency: "- Background Information says he lives with his parents and an older brother; this version says he is an only child." });
    const page = await firstScreen(app);
    await page.evaluate((key) => (globalThis as unknown as { aba: AbaApi }).aba.saveClaudeKey(key), CLAUDE_KEY);
    const section = (id: string) => goTo(page, `/cases/${SAMPLE_CASE.id}/report/${id}`);

    // Not started.
    await section("background-information");
    await expect(page.getByRole("button", { name: es ? /Ya la escribí/ : /I already wrote it/ })).toBeVisible();
    await shot(page, "01-not-started");

    // Hers: pasted from ABA Matrix.
    await page.getByRole("button", { name: es ? /Ya la escribí/ : /I already wrote it/ }).click();
    await page.getByTestId("section-text").fill("Mateo is a 4-year-old boy who lives at home with his mother, father and older brother. Spanish and English are spoken at home.\n\nHe was diagnosed with Autism Spectrum Disorder by a developmental pediatrician, as documented in the CDE. He attends a VPK program five mornings a week and receives speech therapy once a week.");
    await page.getByTestId("notes-open").click();
    await page.getByTestId("session-notes").fill(es ? "La mamá confirmó hoy que la escuela ya aplica el plan de comunicación." : "The mother confirmed today that the school started the communication plan.");
    await page.getByTestId("session-notes").blur();
    await shot(page, "02-pasting-hers");
    await page.getByRole("button", { name: es ? "Listo, dejarla así" : "Done, keep it as it is" }).click();
    await expect(page.getByTestId("section-view")).toBeVisible();
    await shot(page, "03-hers");

    // Drafting: the text streams in.
    await section("medical-necessity");
    await page.getByTestId("section-instructions").fill(es ? "Cada área con su puntaje, un ejemplo de casa y uno de la escuela. Cerrar con por qué ABA y dónde." : "Each area with its score, one example from home and one from school. Close with why ABA and where.");
    await setDraftingSpeed(app, 25);
    await page.getByRole("button", { name: es ? /Redactarla con la IA/ : /Draft it with the AI/ }).click();
    await expect(page.getByTestId("streaming-text")).toContainText("Vineland-3");
    await shot(page, "04-writing");
    await setDraftingSpeed(app, 0);

    // Drafted, checked against her section (a contradiction found), a paragraph marked.
    await expect(page.getByTestId("section-checks")).toContainText(es ? "1 contradicción" : "1 contradiction", { timeout: 20_000 });
    await page.getByTestId("section-view").getByRole("button").nth(1).click();
    await page.getByLabel(es ? "Cambiar este párrafo" : "Change this paragraph").fill(es ? "explica qué significan los puntajes para la familia" : "explain what the scores mean for the family");
    await shot(page, "05-drafted-paragraph-marked");
    await page.getByRole("button", { name: es ? "Cambiar" : "Change", exact: true }).click();
    await expect(page.getByRole("button", { name: es ? "Versión 2" : "Version 2" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await page.getByLabel(es ? "Pide cambios con tus palabras" : "Ask for changes in your own words").fill(es ? "más corto y menciona la escuela" : "shorter, and mention the school");
    await page.getByRole("button", { name: es ? "Crear versión 3" : "Create version 3" }).click();
    await expect(page.getByRole("button", { name: es ? "Versión 3" : "Version 3" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(page.getByTestId("section-checks")).toContainText(es ? "contradicción" : "contradiction", { timeout: 20_000 });
    // Let the version buttons' color transition finish.
    await page.waitForTimeout(400);
    await shot(page, "06-drafted-v3");

    // Approved and copied.
    await page.getByRole("button", { name: es ? "Aprobar" : "Approve", exact: true }).click();
    await page.getByRole("button", { name: es ? "Copiar para ABA Matrix" : "Copy for ABA Matrix" }).click();
    await expect(page.getByRole("status").filter({ hasText: es ? "Copiada" : "Copied" })).toBeVisible();
    await shot(page, "07-approved-copied");

    // Stopped.
    await section("crisis-plan");
    await setDraftingSpeed(app, 300);
    await page.getByRole("button", { name: es ? /Redactarla con la IA/ : /Draft it with the AI/ }).click();
    await page.getByRole("button", { name: es ? "Detener" : "Stop" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await shot(page, "08-stopped");
    await setDraftingSpeed(app, 0);

    // The report's sections with their states.
    await goTo(page, `/cases/${SAMPLE_CASE.id}/report`);
    await shot(page, "09-report");

    // The model choice in Settings.
    await goTo(page, "/settings");
    await page.getByRole("button", { name: es ? "Cambiar" : "Change" }).click();
    await shot(page, "10-settings-model");

    // No AI connected.
    await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.removeClaudeKey());
    await section("risk-assessment");
    await shot(page, "11-no-ai-connected");
  });
}
