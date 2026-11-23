import type { ElectronApplication, Page } from "@playwright/test";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { AbaApi } from "../src/shared/api.ts";
import { defaultCasesFolder, draftingStubLog, expect, firstScreen, goTo, holdAnswers, pauseDrafting, SAMPLE_CASE, seedCase, setDraftingFailures, setDraftingSpeed, stubDrafting, test } from "./app.ts";

/*
 * The report's sections as the clinician meets them: drafting one with the AI, changing
 * one paragraph, asking for changes in her own words, going back to a version, approving
 * and copying it; picking up a section she already wrote; stopping a draft. Claude is
 * faked inside the main process (stubDrafting): no request leaves the computer, and the
 * text is invented. Every test works in a temporary home folder (see app.ts).
 * With ABA_SCREENSHOTS_DIR set, the tests save screenshots of each state there.
 */

const CLAUDE_KEY = "sk-ant-api03-e2e-key-not-real-000000000000";
const shots = process.env.ABA_SCREENSHOTS_DIR;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function screenshot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

const SOURCE = {
  id: "0d3c6a52-8a3e-4b8f-9d0e-6c1f2a7b5e44",
  kind: "text",
  type: "cde",
  title: "CDE, invented",
  addedAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  text: "Invented CDE notes for a child who does not exist. Single-word requests; pulls an adult to the refrigerator.",
};

/** Seeds the invented case with one pasted source, starts the app with Claude faked and connected, and opens a section. */
async function openSection(launch: (options?: { language?: "en" | "es" }) => Promise<ElectronApplication>, home: string, sectionId: string, language: "en" | "es" = "en", stub: { msPerChunk?: number; consistency?: string } = {}) {
  const casesFolder = defaultCasesFolder(home);
  seedCase(casesFolder, SAMPLE_CASE.label, { ...SAMPLE_CASE, sources: [SOURCE] });
  const app = await launch({ language });
  await stubDrafting(app, { claudeKey: CLAUDE_KEY, ...stub });
  const page = await firstScreen(app);
  const saved = await page.evaluate((key) => (globalThis as unknown as { aba: AbaApi }).aba.saveClaudeKey(key), CLAUDE_KEY);
  expect(saved).toEqual({ outcome: "saved" });
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/${sectionId}`);
  return { app, page, caseFile: path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json") };
}

/** A section as the case's data file holds it (none before the case is first saved with sections). */
const sectionData = (caseFile: string, id: string) => (JSON.parse(readFileSync(caseFile, "utf8")).sections ?? {})[id];
/**
 * Opens today's notes from the foot of the sidebar (owner's decision T4), unless they are
 * open already. A panel still sliding closed (Escape, a press outside) is not open: Base UI
 * marks it data-closed at once, so the helper waits for it to be gone, then opens it again.
 */
async function openNotes(page: Page) {
  const box = page.getByTestId("session-notes");
  const panel = box.locator("xpath=ancestor::*[@role='dialog'][1]");
  if ((await box.isVisible()) && (await panel.getAttribute("data-open")) !== null) return box;
  await expect(box).toBeHidden();
  await page.getByTestId("notes-open").click();
  await expect(panel).toHaveAttribute("data-open", "");
  await expect(box).toBeVisible();
  return box;
}

const sidebarItem = (page: Page, title: string, language: "en" | "es" = "en") => page.getByRole("navigation", { name: language === "en" ? "Sections" : "Secciones" }).getByRole("link", { name: new RegExp(title.replace("/", "\\/")) });

test("draft a section, change one paragraph, ask for changes, go back, approve and copy for ABA Matrix", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "medical-necessity");
  await expect(heading(page)).toHaveText("Medical Necessity Criteria");
  // The slim line above every screen; its explanation opens from it.
  await expect(page.getByTestId("not-ready-notice")).toContainText("Trial version.");
  await page.getByTestId("not-ready-notice").getByRole("button", { name: "What this means" }).click();
  await expect(page.getByRole("dialog", { name: "Not ready for real client data yet" })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "How do you want to start this section?" })).toBeVisible();
  await screenshot(page, "section-1-start-en");

  await setDraftingSpeed(app, 15);
  await page.getByRole("button", { name: /Draft it with the AI/ }).click();
  await expect(page.getByTestId("streaming-text")).toContainText("Medical necessity for ABA services");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await screenshot(page, "section-2-writing-en");
  await setDraftingSpeed(app, 0);

  const view = page.getByTestId("section-view");
  await expect(view).toContainText("ABA will teach functional communication requests", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Version 1" })).toHaveAttribute("aria-pressed", "true");
  const checks = page.getByTestId("section-checks");
  await expect(checks).toContainText("1 marked");
  await expect(checks).toContainText("Nothing to compare yet");
  await expect(sidebarItem(page, "Medical Necessity Criteria")).toContainText("v1");

  // Mark the second paragraph and ask for a change to it alone.
  const paragraphs = view.getByRole("button");
  const before = await paragraphs.allTextContents();
  await paragraphs.nth(1).click();
  await page.getByLabel("Change this paragraph").fill("explain what the score means for the family");
  await screenshot(page, "section-3-paragraph-en");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  const after = await view.getByRole("button").allTextContents();
  expect(after[0]).toBe(before[0]);
  expect(after[2]).toBe(before[2]);
  expect(after[1]).toContain("well below those of most children his age");
  await expect(page.getByText(/v2: paragraph 2: “explain what the score means for the family”/)).toBeVisible();

  // Ask for changes in her own words.
  await page.getByLabel("Ask for changes in your own words").fill("mention that the school started the communication plan");
  await page.getByRole("button", { name: "Create version 3" }).click();
  await expect(page.getByRole("button", { name: "Version 3" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await expect(view).toContainText("The school reports that his communication plan is now in place.");
  await screenshot(page, "section-4-versions-en");

  // Back to version 1: nothing is lost.
  await page.getByRole("button", { name: "Version 1" }).click();
  await expect(view).not.toContainText("well below");
  expect(sectionData(caseFile, "medical-necessity").versions.map((v: { kind: string }) => v.kind)).toEqual(["draft", "paragraph", "change"]);

  // Approve version 3 and copy it.
  await page.getByRole("button", { name: "Version 3" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(sidebarItem(page, "Medical Necessity Criteria")).toContainText("Approved");
  await page.getByRole("button", { name: "Copy for ABA Matrix" }).click();
  await expect(page.getByText("Copied version 3. 1 marker is still to resolve before you paste.")).toBeVisible();
  const copied = await app.evaluate(async ({ clipboard }) => clipboard.readText());
  expect(copied).toContain("The school reports that his communication plan is now in place.");
  expect(copied.split("\n\n")).toHaveLength(3);
  await screenshot(page, "section-5-approved-en");

  const stored = sectionData(caseFile, "medical-necessity");
  expect(stored.approvedVersion).toBe(3);
  expect(stored.versions[0].generation.deidentified).toBe(false);
  expect(JSON.parse(readFileSync(caseFile, "utf8")).schemaVersion).toBe(4);
  // Every request went to the faked Claude: the draft and two changes (no check: no other section of hers yet).
  const log = await draftingStubLog(app);
  expect(log.requests.filter((r) => r.url.includes("/v1/messages"))).toHaveLength(3);
});

test("pick up a section she already wrote, improve it, and draft another that builds on it (Spanish)", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "background-information", "es");
  // The slim line above every screen, in Spanish; its explanation opens from it.
  await expect(page.getByTestId("not-ready-notice")).toContainText("Versión de prueba.");
  await page.getByTestId("not-ready-notice").getByRole("button", { name: "Qué significa" }).click();
  await expect(page.getByRole("dialog", { name: "Todavía no está lista para datos reales de clientes" })).toBeVisible();
  await page.getByRole("button", { name: "Entendido" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: /Ya la escribí/ }).click();
  const herText = "The child is a 4-year-old boy who lives at home with his parents.\n\nSpanish and English are spoken at home.";
  await page.getByTestId("section-text").fill(herText);
  await screenshot(page, "section-6-paste-es");
  await page.getByRole("button", { name: "Listo, dejarla así" }).click();
  await expect(page.getByTestId("section-view")).toContainText("Spanish and English are spoken at home.");
  await expect(sidebarItem(page, "Background Information", "es")).toContainText("Tuya");
  expect(sectionData(caseFile, "background-information").versions[0]).toMatchObject({ number: 1, kind: "hers", text: herText });

  // Her standing instructions and today's notes.
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/medical-necessity`);
  await page.getByTestId("section-instructions").fill("Cada área con su puntaje, un ejemplo de casa y uno de la escuela.");
  await (await openNotes(page)).fill("La mamá confirmó hoy que la escuela ya aplica el plan de comunicación.");
  await page.getByTestId("session-notes").blur();
  await page.getByRole("button", { name: /Redactarla con la IA/ }).click();
  const view = page.getByTestId("section-view");
  await expect(view).toContainText("ABA will teach", { timeout: 20_000 });
  await expect(page.getByTestId("section-checks")).toContainText("Sin contradicciones", { timeout: 20_000 });
  await screenshot(page, "section-7-draft-es");
  const log = await draftingStubLog(app);
  const bodies = log.requests.filter((r) => r.url.includes("/v1/messages")).map((r) => r.body ?? "");
  expect(bodies[0]).toContain("<her-sections>");
  expect(bodies[0]).toContain("The child is a 4-year-old boy who lives at home with his parents.");
  expect(bodies[0]).toContain("Cada área con su puntaje");
  expect(bodies[0]).toContain("La mamá confirmó hoy");
  expect(bodies[1]).toContain("Consistency check");

  // Improve hers: a new version beside it; hers stays.
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/background-information`);
  await expect(page.getByTestId("section-view")).toContainText("Spanish and English are spoken at home.");
  await page.getByLabel("Pide cambios con tus palabras").fill("más formal");
  await page.getByRole("button", { name: "Crear versión 2" }).click();
  await expect(page.getByRole("button", { name: "Versión 2" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await screenshot(page, "section-8-versions-es");
  const versions = sectionData(caseFile, "background-information").versions;
  expect(versions[0].text).toBe(herText);
  expect(versions).toHaveLength(2);
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report`);
  await screenshot(page, "section-9-report-es");
});

test("a failed request says what went wrong and offers Try again, which sends the same request again", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan");
  await setDraftingFailures(app, 1);
  await page.getByRole("button", { name: /Draft it with the AI/ }).click();
  const failure = page.getByRole("alert").filter({ hasText: "The AI could not finish" });
  await expect(failure).toContainText("The AI could not finish and nothing was saved; your versions are unchanged. The AI refused this request. If it happens again, try the other AI; the technical details say why.");
  await expect(failure.getByRole("link", { name: "Open Settings" })).toHaveCount(0);
  // The provider's own words wait under "Technical details", in English (owner's decision T11).
  const details = failure.getByTestId("section-error-details");
  await expect(details).toBeHidden();
  await failure.getByText("Technical details", { exact: true }).click();
  await expect(details).toContainText("stubbed failure");
  await expect(details).toHaveAttribute("lang", "en");
  await screenshot(page, "section-10-failed-en");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("section-view")).toContainText("ABA will teach", { timeout: 20_000 });
  await expect(failure).toHaveCount(0);
  expect(sectionData(caseFile, "crisis-plan").versions.map((v: { kind: string }) => v.kind)).toEqual(["draft"]);
  const log = await draftingStubLog(app);
  const drafts = log.requests.filter((r) => r.url.includes("/v1/messages")).map((r) => r.body ?? "");
  expect(drafts).toHaveLength(2);
  expect(drafts[1]).toBe(drafts[0]);
});

test("a key the provider no longer accepts says so in Spanish, with its way out in Settings", async ({ launch, home }) => {
  const { app, page } = await openSection(launch, home, "crisis-plan", "es");
  await setDraftingFailures(app, 1, 401);
  await page.getByRole("button", { name: /Redactarla con la IA/ }).click();
  const failure = page.getByRole("alert").filter({ hasText: "La IA no pudo terminar" });
  await expect(failure).toContainText("La IA no pudo terminar y no se guardó nada; tus versiones siguen igual. La conexión con la IA ya no funciona. Vuelve a conectarla en Ajustes.");
  // The provider's words stay under "Detalles técnicos" until she opens it.
  await expect(failure.getByTestId("section-error-details")).toBeHidden();
  await expect(failure.getByText("Detalles técnicos", { exact: true })).toBeVisible();
  await failure.getByRole("link", { name: "Abrir Ajustes" }).click();
  await expect(page.locator("#page-title")).toHaveText("Ajustes");
});

test("stopping a draft saves nothing and says so; without an AI connected, drafting points to Settings", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan", "en", { msPerChunk: 200 });
  await page.getByRole("button", { name: /Draft it with the AI/ }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped. Nothing was saved; your versions are unchanged.")).toBeVisible();
  // She can start again, either way.
  await expect(page.getByRole("button", { name: /Draft it with the AI/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /I already wrote it/ })).toBeVisible();
  expect(sectionData(caseFile, "crisis-plan")).toBeUndefined();

  await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.removeClaudeKey());
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/risk-assessment`);
  await expect(page.getByText("To draft with the AI, connect ChatGPT or Claude in Settings.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Draft it with the AI/ })).toBeDisabled();
  void app;
});

test("her edits, instructions and notes survive a restart; the file keeps every version", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "generalization-and-maintenance");
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Generalization paragraph.\n\nMaintenance paragraph.");
  await page.getByRole("button", { name: "Done, keep it as it is" }).click();
  await page.getByRole("button", { name: "Edit the text" }).click();
  await page.getByTestId("section-text").fill("Generalization paragraph, edited.\n\nMaintenance paragraph.");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("section-view")).toContainText("edited.");
  await page.getByTestId("section-instructions").fill("Two paragraphs, examples from this child's goals.");
  await (await openNotes(page)).fill("Invented note.");
  await page.getByTestId("session-notes").blur();
  await expect(page.getByText("Remembered for all your cases.")).toBeVisible();
  await app.close();

  const again = await launch();
  const page2 = await firstScreen(again);
  await goTo(page2, `/cases/${SAMPLE_CASE.id}/report/generalization-and-maintenance`);
  await expect(page2.getByTestId("section-view")).toContainText("Generalization paragraph, edited.");
  await expect(page2.getByRole("button", { name: "Version 1" })).toBeVisible();
  await expect(page2.getByTestId("section-instructions")).toHaveValue("Two paragraphs, examples from this child's goals.");
  await expect(await openNotes(page2)).toHaveValue("Invented note.");
  expect(sectionData(caseFile, "generalization-and-maintenance").versions.map((v: { kind: string }) => v.kind)).toEqual(["hers", "edited"]);
});

test("today's notes: closed right after typing, opened again and added to, nothing is lost; a new session archives them", async ({ launch, home }) => {
  const { page, caseFile } = await openSection(launch, home, "crisis-plan");
  const notes = await openNotes(page);
  await notes.fill("The mother said the school changes its schedule.");
  // Closed at once, inside the typing pause: the same box opens again on the same text (UX-1 review, S1).
  await page.keyboard.press("Escape");
  await expect(notes).toBeHidden();
  await openNotes(page);
  await expect(notes).toHaveValue("The mother said the school changes its schedule.");
  // The caret is after what she wrote, so typing at once adds to it (UX-1 review, M5).
  await page.keyboard.type(" Call on Monday.");
  // A press outside closes the panel too, and still reaches what was pressed.
  await heading(page).click();
  await expect(notes).toBeHidden();
  await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("The mother said the school changes its schedule. Call on Monday.");
  await expect(page.getByTestId("notes-open")).toContainText("Today's notes");

  // A new session keeps today's notes in the case and empties the box; nothing is deleted.
  await openNotes(page);
  await expect(page.getByText("Today's notes are kept in the case; the AI stops using them.")).toBeVisible();
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(notes).toHaveValue("");
  await expect.poll(() => caseJson(caseFile).sessionNotes).toBeUndefined();
  expect(caseJson(caseFile).sessionNotesArchive.map((archived: { text: string }) => archived.text)).toEqual(["The mother said the school changes its schedule. Call on Monday."]);
  await notes.fill("A new day.");
  await notes.blur();
  await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("A new day.");
  expect(caseJson(caseFile).sessionNotesArchive).toHaveLength(1);
});

test("today's notes: a save that fails is said on the notes button on every screen of the case until it is saved", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  const button = page.getByTestId("notes-open");
  chmodSync(caseFolder, 0o555);
  try {
    const notes = await openNotes(page);
    await notes.fill("Not saved yet.");
    await page.keyboard.press("Escape");
    await expect(button).toContainText("Not saved");
    // On the case map, which shows no list of failures of its own, the button still says so.
    await goTo(page, `/cases/${SAMPLE_CASE.id}/case-map`);
    await expect(button).toContainText("Not saved");
    // In the panel: what she typed, and Try again.
    await openNotes(page);
    await expect(notes).toHaveValue("Not saved yet.");
    // The box saves when it loses focus: leave it while the folder is still read-only, so
    // that save fails too and Try again stays (otherwise the click itself would save it).
    await notes.blur();
    const panel = page.getByRole("dialog", { name: "Today's notes" });
    await expect(panel.getByRole("alert")).toBeVisible();
    chmodSync(caseFolder, 0o755);
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("Not saved yet.");
    await expect(button).not.toContainText("Not saved");
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

/* Review round 1 */

async function reloadWindow(app: ElectronApplication, page: Page) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page.waitForEvent("load");
  await expect(heading(page)).toBeVisible();
}

test("B3: what she typed in a section that could not be saved is still there after a reload, and Try again saves it", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  chmodSync(caseFolder, 0o555);
  try {
    await page.getByTestId("section-text").fill("Typed while the folder refused.");
    await page.getByTestId("section-text").blur();
    const notice = page.getByText("What you typed in this section could not be saved. It is kept");
    await expect(notice).toBeVisible();
    await reloadWindow(app, page);
    // The page starts again with nothing in memory: the main process still has the text and the failure.
    await expect(notice).toBeVisible();
    chmodSync(caseFolder, 0o755);
    // The editor is open again with what she typed (review round 2): Try again saves it, and she can go on.
    await expect(page.getByTestId("section-text")).toHaveValue("Typed while the folder refused.");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(notice).toBeHidden();
    expect(sectionData(caseFile, "crisis-plan").versions[0].text).toBe("Typed while the folder refused.");
    await page.getByRole("button", { name: "Done, keep it as it is" }).click();
    await expect(page.getByTestId("section-view")).toContainText("Typed while the folder refused.");
    expect(sectionData(caseFile, "crisis-plan").versions).toHaveLength(1);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("M3 and M6: lines pasted with single line breaks can become paragraphs; the copy says which version it copied", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "environmental-changes");
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Para one.\nPara two.\nPara three.");
  await expect(page.getByTestId("lines-notice")).toBeVisible();
  await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
  await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("section-view").getByRole("button")).toHaveCount(3);
  const versions = sectionData(caseFile, "environmental-changes").versions;
  expect(versions.map((v: { text: string }) => v.text)).toEqual(["Para one.\nPara two.\nPara three.", "Para one.\n\nPara two.\n\nPara three."]);

  // Approve version 2, look back at version 1, copy: the message says so plainly.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Version 1, yours" }).click();
  await page.getByRole("button", { name: "Copy for ABA Matrix" }).click();
  await expect(page.getByText("Copied version 1. Paste it into ABA Matrix. Version 2 is the approved one.")).toBeVisible();
  expect(await app.evaluate(async ({ clipboard }) => clipboard.readText())).toBe("Para one.\nPara two.\nPara three.");
  await expect(page.getByRole("button", { name: "Version 2, approved" })).toBeVisible();
});

/*
 * M6 on a slow disk (the Windows runner, dev run 45149934208): she approves version 2,
 * then picks version 1 and copies it before the answers are back. The main process does
 * each call in the order she made them; only the answers come back late: the approval's,
 * or every one of them. The clipboard is recorded, never the system's.
 */
const SLOW_ANSWERS = {
  "the approval's answer": ["sections:approve"],
  "every answer": ["sections:approve", "sections:set-current", "sections:copy"],
};
for (const [late, channels] of Object.entries(SLOW_ANSWERS)) {
  test(`M6 on a slow disk, ${late} late: approve, then version 1 at once; she stays on version 1, and the copy names the approved version`, async ({ launch, home }) => {
    const { app, page, caseFile } = await openSection(launch, home, "environmental-changes");
    await app.evaluate(({ clipboard }) => {
      const g = globalThis as unknown as { copied: string[] };
      g.copied = [];
      clipboard.write = async (items) => {
        g.copied.push(await (await items[0].getType("text/plain")).text());
      };
    });
    await page.getByRole("button", { name: /I already wrote it/ }).click();
    await page.getByTestId("section-text").fill("Para one.\nPara two.\nPara three.");
    await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
    await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true");

    const releases: Array<() => Promise<void>> = [];
    for (const channel of channels) releases.push(await holdAnswers(app, channel));
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: "Version 1, yours" }).click();
    await page.getByRole("button", { name: "Copy for ABA Matrix" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { copied: string[] }).copied)).toEqual(["Para one.\nPara two.\nPara three."]);

    for (const release of releases) await release();
    // One more call to the main process: its answer comes after the held ones, so the screen has had them.
    await page.evaluate(([caseId, sectionId]) => (globalThis as unknown as { aba: AbaApi }).aba.getSection(caseId, sectionId as "environmental-changes"), [SAMPLE_CASE.id, "environmental-changes"]);
    await expect(page.getByRole("button", { name: "Version 2, approved" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Version 1, yours" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Copied version 1. Paste it into ABA Matrix. Version 2 is the approved one.")).toBeVisible();
    expect(sectionData(caseFile, "environmental-changes")).toMatchObject({ approvedVersion: 2, currentVersion: 1 });
  });
}

/*
 * Answers that come back out of order (review of PR #15, B1 and N1): the main process
 * saves each change in the order she made it, but the answers can come back in another
 * order (each is read again after its save, outside the case's queue). An older snapshot
 * that comes back last must change nothing on screen: not the approval, not the versions.
 */

/** The section with two versions: hers with single line breaks (1), and each line a paragraph (2, shown). */
async function twoVersions(launch: Parameters<typeof openSection>[0], home: string) {
  const opened = await openSection(launch, home, "environmental-changes");
  const { page } = opened;
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Para one.\nPara two.\nPara three.");
  await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
  await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true");
  return opened;
}

/** One more call to the main process: its answer comes after every answer released before it, so the screen has had them. */
async function settle(page: Page) {
  await page.evaluate(([caseId, sectionId]) => (globalThis as unknown as { aba: AbaApi }).aba.getSection(caseId, sectionId as "environmental-changes"), [SAMPLE_CASE.id, "environmental-changes"]);
}

test("out of order: version 1, then Approve at once, the version's answer last; the approval stays shown", async ({ launch, home }) => {
  const { app, page, caseFile } = await twoVersions(launch, home);
  const release = await holdAnswers(app, "sections:set-current");
  await page.getByRole("button", { name: "Version 1, yours" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo approval" })).toBeVisible();
  expect(sectionData(caseFile, "environmental-changes")).toMatchObject({ approvedVersion: 1, currentVersion: 1 });

  await release();
  await settle(page);
  await expect(page.getByRole("button", { name: "Undo approval" })).toBeVisible();
  // The badge beside the text, and the section's line in the sidebar.
  await expect(page.locator("#content").getByText("Approved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Version 1, approved" })).toHaveAttribute("aria-pressed", "true");
  await expect(sidebarItem(page, "Environmental Changes")).toContainText("Approved");
});

test("out of order: Approve version 1, then each line a paragraph at once, the approval's answer last; version 3 stays, unapproved", async ({ launch, home }) => {
  const { app, page, caseFile } = await twoVersions(launch, home);
  await page.getByRole("button", { name: "Version 1, yours" }).click();
  await expect(page.getByRole("button", { name: "Version 1, yours" })).toHaveAttribute("aria-pressed", "true");
  await settle(page);
  const release = await holdAnswers(app, "sections:approve");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
  await expect(page.getByRole("button", { name: "Version 3" })).toHaveAttribute("aria-pressed", "true");
  // The new version took the approval away (she approves again).
  const stored = sectionData(caseFile, "environmental-changes");
  expect(stored.versions).toHaveLength(3);
  expect(stored.approvedVersion ?? null).toBeNull();

  await release();
  await settle(page);
  await expect(page.getByRole("button", { name: "Version 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Version \d/ })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(page.locator("#content").getByText("Approved", { exact: true })).toHaveCount(0);
  await expect(sidebarItem(page, "Environmental Changes")).not.toContainText("Approved");
});

test("out of order: version 1, then ask for changes; the version's answer after the new version is saved never hides it", async ({ launch, home }) => {
  const { app, page, caseFile } = await twoVersions(launch, home);
  const release = await holdAnswers(app, "sections:set-current");
  await page.getByRole("button", { name: "Version 1, yours" }).click();
  await page.getByLabel("Ask for changes in your own words").fill("mention that the school started the communication plan");
  await page.getByRole("button", { name: "Create version 3" }).click();
  await expect(page.getByRole("button", { name: "Version 3" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  expect(sectionData(caseFile, "environmental-changes")).toMatchObject({ currentVersion: 3 });

  await release();
  await settle(page);
  await expect(page.getByRole("button", { name: "Version 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Version \d/ })).toHaveCount(3);
  await expect(page.getByTestId("section-view")).toContainText("The school reports that his communication plan is now in place.");
});

/*
 * A check's save that overtakes her answer (review 2 of PR #15, R2-1): during "Check
 * again" she picks version 1 and makes a new version from it; the check saves after her
 * change, and its news comes back before her answer. Her answer is then older than the
 * snapshot shown, yet what she just did must be shown: the new version, with her text.
 */

/**
 * Environmental Changes with three versions, the third "Could not be checked" (her
 * Background Information is there to compare), Check again held running (the faked
 * Claude paused), and version 1 shown. Returns what lets the check finish.
 */
async function checkingAgain(launch: Parameters<typeof openSection>[0], home: string) {
  const opened = await openSection(launch, home, "background-information", "en", { consistency: "Maybe." });
  const { app, page } = opened;
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Her own background text.");
  await page.getByRole("button", { name: "Done, keep it as it is" }).click();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/environmental-changes`);
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Para one.\nPara two.\nPara three.");
  await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
  await expect(page.getByRole("button", { name: "Version 2" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Ask for changes in your own words").fill("mention that the school started the communication plan");
  await page.getByRole("button", { name: "Create version 3" }).click();
  await expect(page.getByTestId("section-checks")).toContainText("Could not be checked", { timeout: 20_000 });

  const finishCheck = await pauseDrafting(app);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("section-checks")).toContainText("Checking");
  await page.getByRole("button", { name: "Version 1, yours" }).click();
  await expect(page.getByRole("button", { name: "Version 1, yours" })).toHaveAttribute("aria-pressed", "true");
  return { ...opened, finishCheck };
}

/**
 * Her new version 4 is on disk, then the check ends and saves after it. Her answer is held,
 * so only the check's news can bring version 4 into the version bar.
 */
async function checkSavedAfterHer(page: Page, caseFile: string, finishCheck: () => Promise<void>) {
  await expect.poll(() => sectionData(caseFile, "environmental-changes").versions.length).toBe(4);
  expect(sectionData(caseFile, "environmental-changes")).toMatchObject({ currentVersion: 4 });
  await finishCheck();
  await expect(page.getByRole("button", { name: /^Version \d/ })).toHaveCount(4, { timeout: 20_000 });
}

test("check overtakes: during a check, version 1 then each line a paragraph; the new version is shown", async ({ launch, home }) => {
  const { app, page, caseFile, finishCheck } = await checkingAgain(launch, home);
  const release = await holdAnswers(app, "sections:save-text");
  await page.getByRole("button", { name: "Treat each line as a paragraph" }).click();
  await checkSavedAfterHer(page, caseFile, finishCheck);
  await expect(page.getByTestId("section-checks")).not.toContainText("Checking");

  await release();
  await settle(page);
  // She asked for each line as a paragraph: the file shows version 4; so must the screen.
  await expect(page.getByRole("button", { name: "Version 4" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("lines-notice")).toHaveCount(0);
});

test("check overtakes: during a check, she edits version 1's text; after Done her edit is what the screen shows", async ({ launch, home }) => {
  const { app, page, caseFile, finishCheck } = await checkingAgain(launch, home);
  await page.getByRole("button", { name: "Edit the text" }).click();
  const release = await holdAnswers(app, "sections:save-text");
  await page.getByTestId("section-text").fill("Para one.\n\nPara two, edited by her.\n\nPara three.");
  await checkSavedAfterHer(page, caseFile, finishCheck);
  expect(sectionData(caseFile, "environmental-changes").versions[3].text).toBe("Para one.\n\nPara two, edited by her.\n\nPara three.");

  await release();
  await settle(page);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /^Version 4/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("section-view")).toContainText("Para two, edited by her.");
});

/* Review round 2: B3, the kept text goes back in its box */

/** Puts the caret at the end of a text area (Cmd+End does not move it in a macOS text area). */
async function caretAtEnd(field: ReturnType<Page["getByTestId"]>) {
  await field.focus();
  await field.evaluate((element) => {
    const area = element as unknown as { value: string; setSelectionRange(start: number, end: number): void };
    area.setSelectionRange(area.value.length, area.value.length);
  });
}

const caseJson = (caseFile: string) => JSON.parse(readFileSync(caseFile, "utf8"));

test("B3 round 2, notes: after a reload the kept notes are back in the box, and typing after Try again builds on them", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  const notes = await openNotes(page);
  await notes.fill("Saved note.");
  await notes.blur();
  await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("Saved note.");
  chmodSync(caseFolder, 0o555);
  try {
    await notes.fill("Saved note. Pre-reload addition the mother told me.");
    await notes.blur();
    const alert = page.getByText("Your notes for this session could not be saved. They are kept");
    await expect(alert).toBeVisible();
    await reloadWindow(app, page);
    await expect(alert).toBeVisible();
    await expect(await openNotes(page)).toHaveValue("Saved note. Pre-reload addition the mother told me.");
    chmodSync(caseFolder, 0o755);
    await page.getByRole("alert").filter({ hasText: "Your notes for this session" }).getByRole("button", { name: "Try again" }).click();
    await expect(alert).toBeHidden();
    expect(caseJson(caseFile).sessionNotes.text).toBe("Saved note. Pre-reload addition the mother told me.");
    // Pressing Try again, outside the notes panel, closed it: it opens again on the saved notes.
    const box = await openNotes(page);
    await caretAtEnd(box);
    await box.pressSequentially(" Later.");
    await box.blur();
    await expect.poll(() => caseJson(caseFile).sessionNotes.text).toBe("Saved note. Pre-reload addition the mother told me. Later.");
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("B3 round 2, section text: after a reload the editor reopens with her correction, and her next keystroke builds on it", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Hers v1.");
  await page.getByRole("button", { name: "Done, keep it as it is" }).click();
  await expect(page.getByTestId("section-view")).toContainText("Hers v1.");
  await page.getByRole("button", { name: "Edit the text" }).click();
  chmodSync(caseFolder, 0o555);
  try {
    await page.getByTestId("section-text").fill("Hers v1. A long correction of the dates, typed before the reload.");
    await page.getByTestId("section-text").blur();
    const alert = page.getByText("What you typed in this section could not be saved. It is kept");
    await expect(alert).toBeVisible();
    await reloadWindow(app, page);
    await expect(alert).toBeVisible();
    // The editor is open again, with her correction, not the text on disk.
    const editor = page.getByTestId("section-text");
    await expect(editor).toHaveValue("Hers v1. A long correction of the dates, typed before the reload.");
    chmodSync(caseFolder, 0o755);
    await caretAtEnd(editor);
    await editor.pressSequentially(" Small fix.");
    await editor.blur();
    await expect(alert).toBeHidden();
    await expect
      .poll(() => sectionData(caseFile, "crisis-plan").versions.map((v: { kind: string; text: string }) => [v.kind, v.text]))
      .toEqual([
        ["hers", "Hers v1."],
        ["edited", "Hers v1. A long correction of the dates, typed before the reload. Small fix."],
      ]);
    expect(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.listFailedSaves())).toEqual([]);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("B3 round 2, instructions: after a reload the kept instructions are back in the box; Try again saves them and typing builds on them", async ({ launch, home, profile }) => {
  const { app, page } = await openSection(launch, home, "medical-necessity");
  const instructionsFile = path.join(profile, "instructions.json");
  // A folder where the file goes: the app cannot read or write its instructions until it is gone.
  mkdirSync(instructionsFile);
  try {
    const box = page.getByTestId("section-instructions");
    await box.fill("Each area with its score.");
    await box.blur();
    const alert = page.getByText("Your instructions for a section could not be saved. They are kept");
    await expect(alert).toBeVisible();
    await reloadWindow(app, page);
    await expect(alert).toBeVisible();
    await expect(page.getByTestId("section-instructions")).toHaveValue("Each area with its score.");
    rmSync(instructionsFile, { recursive: true, force: true });
    await page.getByRole("alert").filter({ hasText: "Your instructions" }).getByRole("button", { name: "Try again" }).click();
    await expect(alert).toBeHidden();
    const again = page.getByTestId("section-instructions");
    await caretAtEnd(again);
    await again.pressSequentially(" One example from home.");
    await again.blur();
    await expect.poll(() => JSON.parse(readFileSync(instructionsFile, "utf8")).sections["medical-necessity"].text).toBe("Each area with its score. One example from home.");
  } finally {
    rmSync(instructionsFile, { recursive: true, force: true });
  }
});

/* Review round 3: R3-1 */

test("R3-1: deleting text while saves fail never brings the older text back over what she saved (no reload)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  const notes = await openNotes(page);
  await notes.fill("Start.");
  await notes.blur();
  await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("Start.");
  chmodSync(caseFolder, 0o555);
  try {
    await notes.fill("Mother said A. Teacher said C.");
    await notes.blur();
    await expect(page.getByText("Your notes for this session could not be saved. They are kept")).toBeVisible();
    await notes.fill("Mother said A.");
    await notes.blur();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.listFailedSaves().then((list) => list.map((item) => item.text)))).toEqual(["Mother said A."]);
    chmodSync(caseFolder, 0o755);
    await notes.fill("Mother said A. Grandmother said D.");
    await notes.blur();
    await expect.poll(() => caseJson(caseFile).sessionNotes.text).toBe("Mother said A. Grandmother said D.");
    // The box keeps what she saved: no older snapshot comes back.
    await page.waitForTimeout(300);
    await expect(notes).toHaveValue("Mother said A. Grandmother said D.");
    await caretAtEnd(notes);
    await notes.pressSequentially("!");
    await notes.blur();
    await expect.poll(() => caseJson(caseFile).sessionNotes.text).toBe("Mother said A. Grandmother said D.!");
    expect(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.listFailedSaves())).toEqual([]);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("R3-1: deleting text while saves fail, then a reload: the box shows her newest text and builds on it", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFile } = await openSection(launch, home, "crisis-plan");
  const caseFolder = path.dirname(caseFile);
  const notes = await openNotes(page);
  await notes.fill("Start.");
  await notes.blur();
  await expect.poll(() => caseJson(caseFile).sessionNotes?.text).toBe("Start.");
  chmodSync(caseFolder, 0o555);
  try {
    await notes.fill("Mother said A. Teacher said C.");
    await notes.blur();
    await notes.fill("Mother said A.");
    await notes.blur();
    const alert = page.getByText("Your notes for this session could not be saved. They are kept");
    await expect(alert).toBeVisible();
    await reloadWindow(app, page);
    const box = await openNotes(page);
    await expect(box).toHaveValue("Mother said A.");
    chmodSync(caseFolder, 0o755);
    await caretAtEnd(box);
    await box.pressSequentially(" Grandmother said D.");
    await box.blur();
    await expect.poll(() => caseJson(caseFile).sessionNotes.text).toBe("Mother said A. Grandmother said D.");
    await expect(alert).toBeHidden();
    await page.waitForTimeout(300);
    await expect(box).toHaveValue("Mother said A. Grandmother said D.");
    await caretAtEnd(box);
    await box.pressSequentially("!");
    await box.blur();
    await expect.poll(() => caseJson(caseFile).sessionNotes.text).toBe("Mother said A. Grandmother said D.!");
    expect(await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.listFailedSaves())).toEqual([]);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

/* Review round 4: R4-1 */

test("R4-1: Stop pressed at once, 25 rounds on one screen: the screen and the file always agree", async ({ launch, home }) => {
  const { page, caseFile } = await openSection(launch, home, "background-information");
  // Her own Background Information, so every draft of Medical Necessity is followed by a check.
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Her own background text.");
  await page.getByRole("button", { name: "Done, keep it as it is" }).click();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/medical-necessity`);
  await expect(heading(page)).toHaveText("Medical Necessity Criteria");
  const versionsOnDisk = () => (sectionData(caseFile, "medical-necessity")?.versions ?? []).length;
  const stopOrSkip = page.getByRole("button", { name: /^(Stop|Skip the check)$/ });
  const stoppedMessage = page.getByText("Stopped. Nothing was saved; your versions are unchanged.");
  const tally = { saved: 0, stopped: 0 };
  // The section has loaded: it asks how to start it.
  await expect(page.getByRole("heading", { name: "How do you want to start this section?" })).toBeVisible();
  for (let round = 1; round <= 25; round++) {
    const before = versionsOnDisk();
    if (before > 0) await page.getByLabel("Ask for changes in your own words").fill(`round ${round}`);
    // The request, then Stop at once, from inside the page: 0 to 4 ms apart, changing each
    // round, so the Stop lands while preparing, while writing, during the save or after it.
    await page.evaluate(async (delay) => {
      type Button = { textContent: string | null; click(): void };
      const buttons = () => [...(globalThis as unknown as { document: { querySelectorAll(selector: string): Iterable<Button> } }).document.querySelectorAll("button")];
      buttons()
        .find((button) => /Draft it with the AI|^Create version/.test(button.textContent ?? ""))
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, delay));
      for (let tries = 0; tries < 200; tries++) {
        const stop = buttons().find((button) => /^(Stop|Skip the check)$/.test((button.textContent ?? "").trim()));
        if (stop) {
          stop.click();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }, round % 5);
    await expect(stopOrSkip).toHaveCount(0, { timeout: 10_000 });
    const after = versionsOnDisk();
    expect(after === before || after === before + 1, `round ${round}: at most one version`).toBe(true);
    // What the screen shows is what the file holds.
    await expect(page.getByRole("group", { name: "Versions" }).getByRole("button")).toHaveCount(after);
    if (after > before) await expect(stoppedMessage, `round ${round}: a saved version is never called not saved`).toHaveCount(0);
    else if (await stoppedMessage.isVisible()) expect(after, `round ${round}`).toBe(before);
    tally[after > before ? "saved" : "stopped"]++;
  }
  // Both outcomes happen over the rounds (the Stop lands before, during or after the write); each one agreed.
  console.log(`R4-1 rounds: ${tally.saved} saved, ${tally.stopped} stopped`);
});

test("L-1: Skip pressed while Check again is still being prepared stops the check", async ({ launch, home, }) => {
  const { app, page, caseFile } = await openSection(launch, home, "background-information", "en", { consistency: "Maybe." });
  await page.getByRole("button", { name: /I already wrote it/ }).click();
  await page.getByTestId("section-text").fill("Her own background text.");
  await page.getByRole("button", { name: "Done, keep it as it is" }).click();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/medical-necessity`);
  await page.getByRole("button", { name: /Draft it with the AI/ }).click();
  await expect(page.getByTestId("section-checks")).toContainText("Could not be checked", { timeout: 20_000 });
  const before = sectionData(caseFile, "medical-necessity").versions[0].consistency.checkedAt;
  // A slow answer: a Skip that reaches the main process stops it before it ends.
  await setDraftingSpeed(app, 300);
  const clicked = await page.evaluate(async () => {
    type Button = { textContent: string | null; click(): void };
    const buttons = () => [...(globalThis as unknown as { document: { querySelectorAll(selector: string): Iterable<Button> } }).document.querySelectorAll("button")];
    buttons().find((button) => (button.textContent ?? "").trim() === "Check again")?.click();
    // As soon as Skip is drawn, while the check is still being prepared.
    for (let tries = 0; tries < 200; tries++) {
      const skip = buttons().find((button) => (button.textContent ?? "").trim() === "Skip the check");
      if (skip) {
        skip.click();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return false;
  });
  expect(clicked).toBe(true);
  await expect(page.getByRole("button", { name: "Skip the check" })).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(sectionData(caseFile, "medical-necessity").versions[0].consistency.checkedAt).toBe(before);
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
});
