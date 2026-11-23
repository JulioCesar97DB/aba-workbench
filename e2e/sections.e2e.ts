import type { ElectronApplication, Page } from "@playwright/test";
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AbaApi } from "../src/shared/api.ts";
import { defaultCasesFolder, draftingStubLog, expect, goTo, SAMPLE_CASE, seedCase, setDraftingSpeed, stubDrafting, test } from "./app.ts";

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
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  const saved = await page.evaluate((key) => (globalThis as unknown as { aba: AbaApi }).aba.saveClaudeKey(key), CLAUDE_KEY);
  expect(saved).toEqual({ outcome: "saved" });
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/${sectionId}`);
  return { app, page, caseFile: path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json") };
}

/** A section as the case's data file holds it (none before the case is first saved with sections). */
const sectionData = (caseFile: string, id: string) => (JSON.parse(readFileSync(caseFile, "utf8")).sections ?? {})[id];
const sidebarItem = (page: Page, title: string, language: "en" | "es" = "en") => page.getByRole("navigation", { name: language === "en" ? "Sections" : "Secciones" }).getByRole("link", { name: new RegExp(title.replace("/", "\\/")) });

test("draft a section, change one paragraph, ask for changes, go back, approve and copy for ABA Matrix", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "medical-necessity");
  await expect(heading(page)).toHaveText("Medical Necessity Criteria");
  await expect(page.getByTestId("not-ready-notice")).toContainText("Not ready for real client data yet");
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
  expect(JSON.parse(readFileSync(caseFile, "utf8")).schemaVersion).toBe(3);
  // Every request went to the faked Claude: the draft and two changes (no check: no other section of hers yet).
  const log = await draftingStubLog(app);
  expect(log.requests.filter((r) => r.url.includes("/v1/messages"))).toHaveLength(3);
});

test("pick up a section she already wrote, improve it, and draft another that builds on it (Spanish)", async ({ launch, home }) => {
  const { app, page, caseFile } = await openSection(launch, home, "background-information", "es");
  await expect(page.getByText("Todavía no está lista para datos reales de clientes")).toBeVisible();
  await page.getByRole("button", { name: /Ya la escribí/ }).click();
  const herText = "The child is a 4-year-old boy who lives at home with his parents.\n\nSpanish and English are spoken at home.";
  await page.getByTestId("section-text").fill(herText);
  await screenshot(page, "section-6-paste-es");
  await page.getByRole("button", { name: "Dejarla así" }).click();
  await expect(page.getByTestId("section-view")).toContainText("Spanish and English are spoken at home.");
  await expect(sidebarItem(page, "Background Information", "es")).toContainText("Tuya");
  expect(sectionData(caseFile, "background-information").versions[0]).toMatchObject({ number: 1, kind: "hers", text: herText });

  // Her standing instructions and today's notes.
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/medical-necessity`);
  await page.getByTestId("section-instructions").fill("Cada área con su puntaje, un ejemplo de casa y uno de la escuela.");
  await page.getByTestId("session-notes").fill("La mamá confirmó hoy que la escuela ya aplica el plan de comunicación.");
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
  await page.getByRole("button", { name: "Keep it as it is" }).click();
  await page.getByRole("button", { name: "Edit the text" }).click();
  await page.getByTestId("section-text").fill("Generalization paragraph, edited.\n\nMaintenance paragraph.");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("section-view")).toContainText("edited.");
  await page.getByTestId("section-instructions").fill("Two paragraphs, examples from this child's goals.");
  await page.getByTestId("session-notes").fill("Invented note.");
  await page.getByTestId("session-notes").blur();
  await expect(page.getByText("Remembered for all your cases.")).toBeVisible();
  await app.close();

  const again = await launch();
  const page2 = await again.firstWindow();
  await expect(heading(page2)).toBeVisible();
  await goTo(page2, `/cases/${SAMPLE_CASE.id}/report/generalization-and-maintenance`);
  await expect(page2.getByTestId("section-view")).toContainText("Generalization paragraph, edited.");
  await expect(page2.getByRole("button", { name: "Version 1" })).toBeVisible();
  await expect(page2.getByTestId("section-instructions")).toHaveValue("Two paragraphs, examples from this child's goals.");
  await expect(page2.getByTestId("session-notes")).toHaveValue("Invented note.");
  expect(sectionData(caseFile, "generalization-and-maintenance").versions.map((v: { kind: string }) => v.kind)).toEqual(["hers", "edited"]);
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
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(notice).toBeHidden();
    await expect(page.getByTestId("section-view")).toContainText("Typed while the folder refused.");
    expect(sectionData(caseFile, "crisis-plan").versions[0].text).toBe("Typed while the folder refused.");
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
