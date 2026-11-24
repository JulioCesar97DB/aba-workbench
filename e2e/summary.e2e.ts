import type { ElectronApplication, Page } from "@playwright/test";
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

async function writeSection(page: Page, id: string, sectionId: string, text = "Her own invented paragraph.") {
  expect((await call<{ outcome: string }>(page, "saveSectionText", id, sectionId, text, null)).outcome).toBe("saved");
}

/** The clipboard is recorded in the main process, never the system's: a test never changes the user's clipboard. */
async function recordClipboard(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { copied: string[] };
    g.copied = [];
    clipboard.write = async (items) => {
      g.copied.push(await (await items[0].getType("text/plain")).text());
    };
  });
  return () => app.evaluate(() => (globalThis as unknown as { copied: string[] }).copied);
}

async function copySection(page: Page, id: string, sectionId: string, version = 1) {
  expect((await call<{ outcome: string }>(page, "copySection", id, sectionId, version)).outcome).toBe("copied");
}

test("Home: the last case saved to continue, each case's step and progress in words, and Continuar lands on its next thing", async ({ launch }) => {
  const app = await launch();
  await stubDrafting(app, { claudeKey: CLAUDE_KEY });
  const page = await firstScreen(app);
  await call(page, "saveClaudeKey", CLAUDE_KEY);
  await recordClipboard(app);

  const done = await create(page, "Done case");
  await addDocument(page, done);
  for (const section of REPORT_SECTIONS) await writeSection(page, done, section.id);
  // Done means copied (rule 8, T8): each section copied as it is.
  for (const section of REPORT_SECTIONS) await copySection(page, done, section.id);
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
  await expect(card).toContainText("Ready · all 9 sections copied · saved today, ");
  await expect(card).toContainText("Next: The 9 sections are copied");
  // With cases to continue, "New case" is no longer the primary action (§4).
  await expect(page.getByRole("button", { name: "New case" })).not.toHaveClass(/bg-accent/);

  // The order, by last saved, is checked once; every other check finds its row by name.
  const rows = page.getByTestId("case-row");
  await expect(rows.getByTestId("case-name")).toHaveText(["Done case", "Empty case", "Map case"]);
  const row = (name: string) => rows.filter({ has: page.getByTestId("case-name").getByText(name, { exact: true }) });
  await expect(row("Empty case")).toContainText("6 years · Documents · no documents yet");
  await expect(row("Map case")).toContainText("6 years · Case map · 1 of 2 parts approved");
  await expect(row("Done case")).toContainText("6 years · Ready · all 9 sections copied");
  await expect(row("Map case").getByRole("img")).toHaveAccessibleName("The five steps: Documents, done; Case map, in progress; Plan, not in the app yet; Report, not started; Review and copy, not started");
  await expect(row("Done case").getByRole("link", { name: "Open" })).toBeVisible();
  // The card's Continuar says which case it continues, and what comes next (review round 1, M3).
  await expect(card.getByRole("link", { name: "Continue" })).toHaveAccessibleDescription("Done case Next: The 9 sections are copied");
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
  // Revisión y copia is built (UX-7): its state in a sentence, and its button.
  await expect(steps.nth(4)).toContainText("Ninguna sección copiada todavía.");
  await expect(steps.nth(4).getByRole("link", { name: "Empezar · Revisión y copia" })).toBeVisible();
  // Each button names its step to a screen reader.
  await steps.nth(3).getByRole("link", { name: "Seguir · Informe" }).click();
  await expect(heading(page)).toHaveText("Informe");
  await page.goBack();
  await expect(page.getByRole("region", { name: "A mano" })).toContainText("Tus secciones se marcan");
  await expect(page.getByRole("region", { name: "Con la IA" })).toContainText("Borrador de la IA");
});

test("Plan says it comes later and sends her on; the last section's Next step goes to Review and copy", async ({ launch }) => {
  const app = await launch();
  const page = await firstScreen(app);
  const id = await create(page, "Later steps case");
  // Nothing to copy yet: the summary's Review and copy row has no button (UX-7 review round 1, minor 5).
  await goTo(page, `/cases/${id}`);
  await expect(page.getByTestId("summary-steps").getByRole("listitem").nth(4)).toContainText("Nothing to copy yet");
  await expect(page.getByTestId("summary-steps").getByRole("listitem").nth(4).getByRole("link")).toHaveCount(0);
  await goTo(page, `/cases/${id}/interventions`);
  await expect(heading(page)).toHaveText("Plan");
  await expect(page.getByTestId("header-eyebrow")).toHaveText("Step 3 of 5");
  await expect(page.getByTestId("state-chip")).toHaveText("Coming later");
  const card = page.getByRole("region", { name: "This step is not in the app yet" });
  await card.getByRole("link", { name: "Continue with the report" }).click();
  await expect(heading(page)).toHaveText("Report");
  // Only Plan is "Soon" in the sidebar now.
  const steps = page.getByRole("navigation", { name: "Steps of the case" });
  await expect(steps.getByText("Soon", { exact: true })).toHaveCount(1);

  // Every section ready: the last one's "Next step" goes to Review and copy.
  for (const section of REPORT_SECTIONS) await writeSection(page, id, section.id);
  await goTo(page, "/");
  await page.getByRole("link", { name: "Later steps case" }).click();
  await steps.getByRole("link", { name: "Report" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Crisis Plan" }).click();
  const nextStep = page.getByTestId("next-step");
  await expect(nextStep).toContainText("All 9 sections are ready");
  await nextStep.getByRole("link", { name: "Go to Review and copy" }).click();
  await expect(heading(page)).toHaveText("Review and copy");
});

test("Review and copy: the nine sections in order, one primary Copy on the first not copied, marks stored, 9 of 9", async ({ launch }) => {
  const app = await launch();
  const page = await firstScreen(app);
  const copied = await recordClipboard(app);
  const id = await create(page, "Review case");
  await addDocument(page, id);
  const [first, second, third] = REPORT_SECTIONS;
  await writeSection(page, id, first.id, "Background paragraph one.\n\nBackground paragraph two.");
  expect((await call<{ outcome: string }>(page, "approveSection", id, first.id, 1)).outcome).toBe("saved");
  await writeSection(page, id, second.id, "Medical necessity with a gap [MISSING: Vineland-3 percentile].");
  await goTo(page, `/cases/${id}/review`);
  await expect(heading(page)).toHaveText("Review and copy");
  await expect(page.getByTestId("header-eyebrow")).toHaveText("Step 5 of 5");
  await expect(page.getByTestId("coming-later")).toHaveCount(0);

  const list = page.getByTestId("review-list");
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(REPORT_SECTIONS.length);
  await expect(rows.locator("h2 [lang='en']")).toHaveText(REPORT_SECTIONS.map((section) => section.title));
  const row = (index: number) => rows.nth(index);
  await expect(row(0)).toContainText("Approved · 6 words");
  await expect(row(1)).toContainText("Yours · 8 words");
  await expect(row(1).getByTestId("marked-chip")).toHaveText("1 detail to complete");
  await expect(row(2)).toContainText("Not started");
  await expect(row(2).getByRole("link", { name: "Start" })).toBeVisible();
  // One primary: Copy on the first section not copied yet; the other Copy is secondary.
  const copyButtons = list.getByTestId("review-copy");
  await expect(copyButtons).toHaveCount(2);
  await expect(row(0).getByTestId("review-copy")).toHaveClass(/bg-accent/);
  await expect(row(1).getByTestId("review-copy")).not.toHaveClass(/bg-accent/);
  const rail = page.getByRole("complementary");
  await expect(rail.getByTestId("review-progress")).toContainText("0 of 9 copied");
  await expect(rail.getByTestId("before-pasting")).toContainText("Medical Necessity Criteria: complete the marked detail in ABA Matrix or here.");

  // Copy the first: the section screen's copy, marked in the case, and the primary moves on.
  await row(0).getByTestId("review-copy").click();
  await expect(row(0).getByTestId("copied-line")).toHaveText("Copied. Paste it into ABA Matrix, in “Background Information”.");
  await expect(page.getByTestId("review-announcer")).toHaveText("Copied. Paste it into ABA Matrix, in “Background Information”.");
  await expect(row(0).getByTestId("copied-mark")).toHaveText("Copied");
  await expect(row(0).getByTestId("review-copy")).toHaveText("Copy again");
  await expect(row(0).getByTestId("review-copy")).toBeFocused();
  await expect(row(1).getByTestId("review-copy")).toHaveClass(/bg-accent/);
  await expect(rail.getByTestId("review-progress")).toContainText("1 of 9 copied");
  expect(await copied()).toEqual(["Background paragraph one.\n\nBackground paragraph two."]);
  const section = await call<{ section: { copiedVersion: number | null; copied: boolean } }>(page, "getSection", id, first.id);
  expect(section.section).toMatchObject({ copiedVersion: 1, copied: true });
  const steps = page.getByRole("navigation", { name: "Steps of the case" });
  await expect(steps.getByRole("link", { name: /Review and copy/ })).toContainText("1/9");

  // Her text, not approved: copied, with the note of P2 and the marker counted.
  await row(1).getByTestId("review-copy").click();
  await expect(row(1).getByTestId("copied-line")).toHaveText(
    "Copied with 1 detail to complete: look for [MISSING: …] when you paste. Paste it into ABA Matrix, in “Medical Necessity Criteria”. You have not approved it yet: read it through before you paste it.",
  );

  // Read all: every section, read only, in one scroll; and back.
  await page.getByTestId("read-all").click();
  await expect(heading(page)).toHaveText("The whole assessment");
  await expect(page.locator("article")).toHaveCount(REPORT_SECTIONS.length);
  await expect(page.locator(`article[data-section='${first.id}']`)).toContainText("Background paragraph two.");
  await expect(page.locator(`article[data-section='${third.id}']`)).toContainText("Not started yet.");
  await expect(page.locator("main textarea, main input")).toHaveCount(0);
  await page.getByTestId("back-to-review").click();
  await expect(heading(page)).toHaveText("Review and copy");

  // The section screen shows "Copied" from the stored mark.
  await goTo(page, `/cases/${id}/report/${first.id}`);
  await expect(page.getByTestId("state-chip")).toHaveText("Copied");

  // Every section written and copied: 9 of 9, the step done, and "Lo siguiente" says so.
  for (const other of REPORT_SECTIONS.slice(2)) await writeSection(page, id, other.id);
  for (const other of REPORT_SECTIONS.slice(2)) await copySection(page, id, other.id);
  await goTo(page, "/");
  await page.getByRole("link", { name: "Review case" }).click();
  await expect(page.getByTestId("next-thing")).toHaveAttribute("data-kind", "all-ready");
  await steps.getByRole("link", { name: /Review and copy/ }).click();
  await expect(page.getByTestId("review-all-copied")).toHaveText("The 9 sections are copied. You can close the case or go back to any section.");
  await expect(rail.getByTestId("review-progress")).toContainText("9 of 9 copied");
  await expect(list.getByTestId("copied-mark")).toHaveCount(REPORT_SECTIONS.length);
});

/**
 * The copy's answer as when the case could not keep the mark (T8): what was copied is on the
 * clipboard, `marked` is null. Only the screens are under test here: the main process's side
 * (the clipboard first, then the mark, null when its save fails) is tests/sections.test.ts's.
 */
async function marksCannotBeSaved(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("sections:copy");
    ipcMain.handle("sections:copy", async () => ({ outcome: "copied", markers: 1, allMissing: true, marked: null }));
  });
}

test("a copy whose mark cannot be saved says so on both screens, and the section never claims Copied (UX-7 review round 1, S2)", async ({ launch }) => {
  const app = await launch();
  const page = await firstScreen(app);
  const id = await create(page, "Mark case");
  await addDocument(page, id);
  const [first] = REPORT_SECTIONS;
  await writeSection(page, id, first.id, "Background [MISSING: school name].");
  expect((await call<{ outcome: string }>(page, "approveSection", id, first.id, 1)).outcome).toBe("saved");
  await marksCannotBeSaved(app);

  await goTo(page, `/cases/${id}/report/${first.id}`);
  await page.getByRole("button", { name: "Copy for ABA Matrix" }).click();
  await expect(page.getByTestId("copied-line")).toContainText("Copied with 1 detail to complete");
  await expect(page.getByTestId("mark-not-saved")).toHaveText(
    "The app could not save that you copied it, so it will not show as copied. The text is on your clipboard: copy it again later to mark it.",
  );
  await expect(page.getByTestId("mark-not-saved")).toHaveAttribute("role", "alert");
  // Not "Copied": the case does not hold it. The copy itself is done for her: Copy again, and Next step is the primary.
  await expect(page.getByTestId("state-chip")).toHaveText("Approved");
  await expect(page.getByTestId("copy-again")).toBeVisible();
  await expect(page.getByTestId("next-step")).toHaveAttribute("data-primary", "true");

  await goTo(page, `/cases/${id}/review`);
  const row = page.getByTestId("review-list").getByRole("listitem").first();
  await expect(row.getByTestId("copied-mark")).toHaveCount(0);
  await row.getByTestId("review-copy").click();
  await expect(row.getByTestId("copied-line")).toHaveText("Copied with 1 detail to complete: look for [MISSING: …] when you paste. Paste it into ABA Matrix, in “Background Information”.");
  await expect(row.getByTestId("mark-not-saved")).toBeVisible();
  await expect(row.getByTestId("copied-mark")).toHaveCount(0);
});

test("Lo siguiente, rule 7: the first section ready and not copied, in Spanish, to Revisión y copia", async ({ launch }) => {
  const app = await launch({ language: "es" });
  const page = await firstScreen(app);
  await recordClipboard(app);
  const id = await create(page, "Caso para copiar");
  await addDocument(page, id);
  for (const section of REPORT_SECTIONS) await writeSection(page, id, section.id);
  await copySection(page, id, REPORT_SECTIONS[0].id);
  await goTo(page, "/");
  await page.getByRole("link", { name: "Caso para copiar" }).click();
  const next = page.getByRole("region", { name: "Lo siguiente" });
  await expect(next).toContainText("Copia Medical Necessity Criteria a ABA Matrix");
  await expect(next.locator('[lang="en"]')).toHaveText("Medical Necessity Criteria");
  await expect(page.getByTestId("summary-steps").getByRole("listitem").nth(4)).toContainText("1 de 9 secciones copiadas.");
  await next.getByRole("link", { name: "Ir a Revisión y copia" }).click();
  await expect(heading(page)).toHaveText("Revisión y copia");
  await expect(page.getByTestId("review-list").getByRole("listitem").nth(1).getByTestId("review-copy")).toHaveClass(/bg-accent/);
  // No "Pronto" on this step in the sidebar any more.
  const steps = page.getByRole("navigation", { name: "Pasos del caso" });
  await expect(steps.getByText("Pronto", { exact: true })).toHaveCount(1);
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
