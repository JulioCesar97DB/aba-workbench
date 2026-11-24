import type { Page } from "@playwright/test";
import { expect, firstScreen, goTo, stubDrafting, test } from "./app.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";

/*
 * The case summary, "Lo siguiente" and Home (UX-5; owner's proposal §4 and §6, decisions T6,
 * T7, P3, P7, P8). Cases are made through the app's own calls, in a temporary home folder;
 * Claude is faked inside the main process and only for its connection state. Invented data
 * only.
 */

const CLAUDE_KEY = "sk-ant-api03-summary-e2e-key-not-real-000000";
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

const call = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (globalThis as unknown as { aba: Record<string, (...x: unknown[]) => Promise<unknown>> }).aba[f as string](...(a as unknown[])) as Promise<T>, [fn, args] as const);

async function create(page: Page, label: string): Promise<string> {
  return (await call<{ case: { id: string } }>(page, "createCase", { label, clientAge: { years: 6 } })).case.id;
}

async function addDocument(page: Page, id: string, type = "cde") {
  expect((await call<{ outcome: string }>(page, "addTextSource", id, { type, title: null, date: null, text: "Invented notes for this test." })).outcome).toBe("saved");
}

async function addMapPart(page: Page, id: string, part: "caregivers" | "behaviors", fields: Record<string, string>, approve: boolean) {
  const item = JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value, check: null }])));
  const added = await call<{ outcome: string; version: number }>(page, "addMapItem", id, part, "items", item, null);
  expect(added.outcome).toBe("saved");
  if (approve) expect((await call<{ outcome: string }>(page, "approveMapPart", id, part, added.version)).outcome).toBe("saved");
}

async function writeSection(page: Page, id: string, sectionId: string) {
  expect((await call<{ outcome: string }>(page, "saveSectionText", id, sectionId, "Her own invented paragraph.", null)).outcome).toBe("saved");
}

test("Home: the last case saved to continue, each case's step and progress in words, and Continuar lands on its next thing", async ({ launch }) => {
  const app = await launch();
  await stubDrafting(app, { claudeKey: CLAUDE_KEY });
  const page = await firstScreen(app);
  await call(page, "saveClaudeKey", CLAUDE_KEY);

  const done = await create(page, "Done case");
  await addDocument(page, done);
  for (const section of REPORT_SECTIONS) await writeSection(page, done, section.id);
  const mapCase = await create(page, "Map case");
  await addDocument(page, mapCase);
  await addMapPart(page, mapCase, "caregivers", { role: "Mother" }, true);
  await addMapPart(page, mapCase, "behaviors", { name: "Invented behavior" }, false);
  await create(page, "Empty case");
  // Saved last (a moment later, so no two times are the same): the one to continue and the
  // first listed, although it was made first (owner's decision on review round 1, S1).
  await page.waitForTimeout(20);
  await addDocument(page, done, "iep");

  await goTo(page, "/settings");
  await goTo(page, "/");
  await expect(heading(page)).toHaveText("Cases");
  const card = page.getByRole("region", { name: "Pick up where you left off" });
  await expect(card).toContainText("Done case");
  await expect(card).toContainText("Ready · all 9 sections ready · saved today, ");
  await expect(card).toContainText("Next: The 9 sections are ready");
  // With cases to continue, "New case" is no longer the primary action (§4).
  await expect(page.getByRole("button", { name: "New case" })).not.toHaveClass(/bg-accent/);

  // The order, by last saved, is checked once; every other check finds its row by name.
  const rows = page.getByTestId("case-row");
  await expect(rows.getByTestId("case-name")).toHaveText(["Done case", "Empty case", "Map case"]);
  const row = (name: string) => rows.filter({ has: page.getByTestId("case-name").getByText(name, { exact: true }) });
  await expect(row("Empty case")).toContainText("6 years · Documents · no documents yet");
  await expect(row("Map case")).toContainText("6 years · Case map · 1 of 2 parts approved");
  await expect(row("Done case")).toContainText("6 years · Ready · all 9 sections ready");
  await expect(row("Map case").getByRole("img")).toHaveAccessibleName("The five steps: Documents, done; Case map, in progress; Plan, not in the app yet; Report, not started; Review and copy, not in the app yet");
  await expect(row("Done case").getByRole("link", { name: "Open" })).toBeVisible();
  // The card's Continuar says which case it continues, and what comes next (review round 1, M3).
  await expect(card.getByRole("link", { name: "Continue" })).toHaveAccessibleDescription("Done case Next: The 9 sections are ready");
  // No AI card: one is connected.
  await expect(page.getByTestId("connect-ai-home")).toHaveCount(0);

  // Continuar goes straight to the next thing: the map's first part with content not approved.
  await row("Map case").getByRole("link", { name: "Continue" }).click();
  await expect(heading(page)).toHaveText("Case map");
  expect(page.url()).toContain(`#/cases/${mapCase}/case-map?part=behaviors`);

  // The case's name opens its summary, which names the same next thing.
  await page.getByTestId("case-summary-link").click();
  await expect(heading(page)).toHaveText("Case summary");
  const next = page.getByTestId("next-thing");
  await expect(next).toHaveAttribute("data-kind", "approve-map");
  await expect(next).toContainText("Approve “Behaviors and groups” in the case map");

  // A done case's "Open" goes to its summary.
  await page.getByRole("link", { name: "All cases" }).click();
  await row("Done case").getByRole("link", { name: "Open" }).click();
  await expect(heading(page)).toHaveText("Case summary");
  await expect(page.getByTestId("next-thing")).toHaveAttribute("data-kind", "all-ready");
});

test("the case summary in Spanish: Lo siguiente, the five steps in sentences, the legend, section titles in English", async ({ launch }) => {
  const app = await launch({ language: "es" });
  const page = await firstScreen(app);
  const id = await create(page, "Caso inventado");
  await goTo(page, `/cases/${id}`);
  await expect(heading(page)).toHaveText("Resumen del caso");
  const next = page.getByRole("region", { name: "Lo siguiente" });
  await expect(next).toContainText("Agrega los documentos del cliente");
  await next.getByRole("link", { name: "Agregar los documentos" }).click();
  await expect(heading(page)).toHaveText("Documentos");

  await addDocument(page, id);
  await addDocument(page, id, "direct-observation");
  await addDocument(page, id, "direct-observation");
  await writeSection(page, id, "background-information");
  // The case is read again when it is opened again.
  await goTo(page, "/");
  await page.getByRole("link", { name: "Caso inventado" }).click();
  await expect(heading(page)).toHaveText("Resumen del caso");
  await expect(next).toContainText("Empieza Medical Necessity Criteria");
  await expect(next.locator('[lang="en"]')).toHaveText("Medical Necessity Criteria");

  const steps = page.getByTestId("summary-steps").getByRole("listitem");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText("3 documentos: CDE, Direct observation (2).");
  await expect(steps.nth(0).locator('[lang="en"]')).toHaveText(["CDE", "Direct observation"]);
  await expect(steps.nth(1)).toContainText("Sin empezar. La IA puede armarlo con tus documentos, o lo escribes tú.");
  await expect(steps.nth(2)).toContainText("Pronto");
  await expect(steps.nth(2).getByRole("link")).toHaveCount(0);
  await expect(steps.nth(3)).toContainText("1 de 9 secciones listas: 1 tuya.");
  await expect(steps.nth(4).getByRole("link")).toHaveCount(0);
  // Each button names its step to a screen reader.
  await steps.nth(3).getByRole("link", { name: "Seguir · Informe" }).click();
  await expect(heading(page)).toHaveText("Informe");
  await page.goBack();
  await expect(page.getByRole("region", { name: "A mano" })).toContainText("Tus secciones se marcan");
  await expect(page.getByRole("region", { name: "Con la IA" })).toContainText("Borrador de la IA");
});

test("Plan and Review and copy say they come later and send her on; the last section's Next step skips Review and copy", async ({ launch }) => {
  const app = await launch();
  const page = await firstScreen(app);
  const id = await create(page, "Later steps case");
  await goTo(page, `/cases/${id}/interventions`);
  await expect(heading(page)).toHaveText("Plan");
  await expect(page.getByTestId("header-eyebrow")).toHaveText("Step 3 of 5");
  await expect(page.getByTestId("state-chip")).toHaveText("Coming later");
  const card = page.getByRole("region", { name: "This step is not in the app yet" });
  await card.getByRole("link", { name: "Continue with the report" }).click();
  await expect(heading(page)).toHaveText("Report");

  await goTo(page, `/cases/${id}/review`);
  await expect(heading(page)).toHaveText("Review and copy");
  await page.getByRole("region", { name: "This step is not in the app yet" }).getByRole("link", { name: "See the case summary" }).click();
  await expect(heading(page)).toHaveText("Case summary");

  // Every section ready: the last one's "Next step" goes to the summary, not to Review and copy.
  for (const section of REPORT_SECTIONS) await writeSection(page, id, section.id);
  await goTo(page, "/");
  await page.getByRole("link", { name: "Later steps case" }).click();
  await page.getByRole("navigation", { name: "Steps of the case" }).getByRole("link", { name: "Report" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Crisis Plan" }).click();
  const nextStep = page.getByTestId("next-step");
  await expect(nextStep).toContainText("All 9 sections are ready");
  await nextStep.getByRole("link", { name: "See the case summary" }).click();
  await expect(heading(page)).toHaveText("Case summary");
});

test("Home with no case: what a case is and New case; Connect the AI while none is connected", async ({ launch }) => {
  const app = await launch({ language: "es" });
  await stubDrafting(app, { claudeKey: CLAUDE_KEY });
  const page = await firstScreen(app);
  const empty = page.getByRole("region", { name: "Todavía no hay casos" });
  await expect(empty).toContainText("Un caso reúne los documentos de un cliente y su evaluación.");
  const connect = page.getByRole("region", { name: "Conecta la IA para que pueda redactar" });
  await expect(connect.getByRole("link", { name: "Conectar ChatGPT" })).toHaveAttribute("href", "#/settings");
  // The empty card's button opens the same form as the header's.
  await empty.getByRole("button", { name: "Nuevo caso" }).click();
  await expect(page.getByRole("dialog", { name: "Nuevo caso" })).toBeVisible();
  await page.keyboard.press("Escape");

  await call(page, "saveClaudeKey", CLAUDE_KEY);
  await goTo(page, "/settings");
  await goTo(page, "/");
  await expect(empty).toBeVisible();
  await expect(connect).toHaveCount(0);
});
