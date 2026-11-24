import type { ElectronApplication, Page } from "@playwright/test";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultCasesFolder, expect, firstScreen, goTo, newCaseButton, seedCase, test } from "./app.ts";

/*
 * A half-done assessment (UX-6; owner's proposal §4 "Nuevo caso", "4 · Informe" and "Picking
 * up a half-done assessment", decisions T9 and T10): "¿Cómo empiezas?" in New case, the line
 * on Documentos, "Pegar lo que ya escribiste" on the report, and the screen that saves each
 * pasted section as her version. Cases are made in a temporary home folder. No AI. Invented
 * data only.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

const call = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (globalThis as unknown as { aba: Record<string, (...x: unknown[]) => Promise<unknown>> }).aba[f as string](...(a as unknown[])) as Promise<T>, [fn, args] as const);

const row = (page: Page, sectionId: string) => page.locator(`[data-testid='paste-row'][data-section='${sectionId}']`);

async function openRow(page: Page, sectionId: string) {
  const box = row(page, sectionId).getByTestId("paste-box");
  if (!(await box.isVisible())) await row(page, sectionId).getByRole("button", { expanded: false }).click();
  await expect(box).toBeVisible();
  return box;
}

function caseData(home: string, label: string) {
  const folder = path.join(defaultCasesFolder(home), label);
  return { folder, read: () => JSON.parse(readFileSync(path.join(folder, "aba-case.json"), "utf8")) };
}

async function createCase(page: Page, label: string, start: "From scratch" | "I already wrote parts in ABA Matrix") {
  await newCaseButton(page).click();
  const dialog = page.getByRole("dialog", { name: "New case" });
  await dialog.getByRole("textbox", { name: "Label" }).fill(label);
  const group = dialog.getByRole("radiogroup", { name: "How are you starting?" });
  // "From scratch" is chosen when the form opens.
  await expect(group.getByRole("radio", { name: "From scratch" })).toBeChecked();
  await expect(group.getByRole("radio", { name: "From scratch" })).toHaveAccessibleDescription("You add the client's documents and follow the steps.");
  if (start !== "From scratch") await group.getByRole("radio", { name: start }).click();
  await expect(group.getByRole("radio", { name: start })).toBeChecked();
  await dialog.getByRole("button", { name: "Create case" }).click();
  await expect(dialog).toBeHidden();
}

test("New case: how she starts decides where she lands, and nothing about it is stored", async ({ launch, home }) => {
  const app = await launch();
  const page = await firstScreen(app);

  // From scratch: Documentos, with no line about her sections; the report's paste card waits under the sections.
  await createCase(page, "Scratch case", "From scratch");
  await expect(heading(page)).toHaveText("Documents");
  await expect(page.getByTestId("half-done-banner")).toHaveCount(0);
  const scratchId = page.url().match(/cases\/([^/]+)\/sources$/)![1];
  await goTo(page, `/cases/${scratchId}/report`);
  await expect(page.getByTestId("paste-card")).toBeVisible();
  await expect(page.getByTestId("paste-card")).not.toHaveAttribute("data-first", "true");
  await expect(page.getByTestId("paste-card").getByRole("link", { name: "Paste the sections" })).not.toHaveClass(/bg-accent/);

  // I already wrote parts: Documentos too, with the line and its way to the paste screen; the card comes first on the report.
  await goTo(page, "/");
  await createCase(page, "Parts case", "I already wrote parts in ABA Matrix");
  await expect(heading(page)).toHaveText("Documents");
  const banner = page.getByTestId("half-done-banner");
  await expect(banner).toContainText("After adding the documents, paste the sections you already have.");
  const id = page.url().match(/cases\/([^/]+)\/sources$/)![1];
  await goTo(page, `/cases/${id}/report`);
  await expect(page.getByTestId("paste-card")).toHaveAttribute("data-first", "true");
  // First, before the table, and the screen's primary.
  await expect(page.getByTestId("paste-card").getByRole("link", { name: "Paste the sections" })).toHaveClass(/bg-accent/);
  await goTo(page, `/cases/${id}/sources`);
  await banner.getByRole("link", { name: "Paste the sections" }).click();
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  expect(page.url()).toMatch(new RegExp(`#/cases/${id}/report/paste$`));

  // Not stored (T9): the data files are a new case's, and after a restart the case is like any other.
  for (const label of ["Scratch case", "Parts case"]) {
    const data = caseData(home, label).read();
    expect(Object.keys(data).sort()).toEqual(["clientAge", "createdAt", "files", "id", "label", "schemaVersion", "sections", "sources", "updatedAt"]);
    expect(data.sections).toEqual({});
  }
  await app.close();
  const again = await firstScreen(await launch());
  await goTo(again, `/cases/${id}/sources`);
  await expect(heading(again)).toHaveText("Documents");
  await expect(again.getByTestId("half-done-banner")).toHaveCount(0);
  await goTo(again, `/cases/${id}/report`);
  await expect(again.getByTestId("paste-card")).not.toHaveAttribute("data-first", "true");
});

test("Paste what you already wrote: each filled box becomes her version of its section, one save each", async ({ launch, home }) => {
  const app = await launch();
  const page = await firstScreen(app);
  await createCase(page, "Paste case", "I already wrote parts in ABA Matrix");
  const id = page.url().match(/cases\/([^/]+)\/sources$/)![1];
  const { read } = caseData(home, "Paste case");
  // One section is hers already: what she pastes there is a new version, the earlier one stays.
  expect((await call<{ outcome: string }>(page, "saveSectionText", id, "crisis-plan", "Her earlier crisis plan.", null)).outcome).toBe("saved");

  await goTo(page, `/cases/${id}/report`);
  await page.getByTestId("paste-card").getByRole("link", { name: "Paste the sections" }).click();
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  // The nine sections, collapsed, in ABA Matrix's order, their titles in English.
  const rows = page.getByTestId("paste-row");
  await expect(rows).toHaveCount(9);
  await expect(page.getByTestId("paste-box")).toHaveCount(0);
  await expect(rows.locator("[lang='en']")).toHaveText([
    "Background Information",
    "Medical Necessity Criteria",
    "Strengths and Weaknesses",
    "Environmental Changes",
    "Family/Caregiver Involvement",
    "Generalization and Maintenance",
    "Discharge and Service Fading Plan",
    "Risk Assessment",
    "Crisis Plan",
  ]);
  await expect(row(page, "crisis-plan").getByTestId("state-chip")).toHaveAttribute("data-state", "hers");
  const save = page.getByTestId("bulk-paste-save");
  await expect(save).toBeDisabled();

  // Opening a row puts the focus in its box, named for its section.
  await row(page, "background-information").getByRole("button", { expanded: false }).click();
  await expect(page.getByRole("textbox", { name: "Your text for Background Information" })).toBeFocused();
  await page.getByRole("textbox", { name: "Your text for Background Information" }).fill("First paragraph.\n\nSecond paragraph.");
  await expect(row(page, "background-information")).toContainText("2 paragraphs · 4 words.");
  await (await openRow(page, "risk-assessment")).fill("Invented risk assessment.");
  // Only spaces: not counted, not saved.
  await (await openRow(page, "environmental-changes")).fill("   \n  ");
  const crisis = await openRow(page, "crisis-plan");
  await expect(row(page, "crisis-plan")).toContainText("This section already has text in the app: what you paste becomes a new version, and the earlier ones stay.");
  await crisis.fill("Her crisis plan from ABA Matrix.");
  await expect(save).toHaveText("Save 3 sections");

  // Leaving the screen and coming back keeps what the boxes hold (while the app runs).
  await goTo(page, `/cases/${id}/report`);
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(row(page, "risk-assessment").getByTestId("paste-box")).toHaveValue("Invented risk assessment.");
  await expect(save).toHaveText("Save 3 sections");

  await save.click();
  await expect(page.getByTestId("bulk-paste-result")).toHaveText("3 sections saved as yours.");
  for (const section of ["background-information", "risk-assessment", "crisis-plan"]) {
    await expect(row(page, section)).toHaveAttribute("data-outcome", "saved");
    await expect(row(page, section).getByTestId("state-chip")).toHaveAttribute("data-state", "hers");
    await expect(row(page, section).getByRole("link", { name: "Open the section" })).toBeVisible();
  }
  await expect(save).toBeDisabled();
  // Nothing waits: "Next step" to the report is the screen's primary now.
  await expect(page.getByTestId("next-step")).toHaveAttribute("data-primary", "true");

  // On disk: each as she pasted it, one version of hers each; the earlier crisis plan stays as version 1.
  const data = read();
  expect(data.sections["background-information"].versions.map((v: { text: string }) => v.text)).toEqual(["First paragraph.\n\nSecond paragraph."]);
  expect(data.sections["risk-assessment"].versions.map((v: { text: string }) => v.text)).toEqual(["Invented risk assessment."]);
  expect(data.sections["crisis-plan"].versions.map((v: { text: string }) => v.text)).toEqual(["Her earlier crisis plan.", "Her crisis plan from ABA Matrix."]);
  expect(data.sections["environmental-changes"]).toBeUndefined();
  // Hers, through the section's own save with the "pasted" flag: always "hers", also over an earlier one (review B1).
  expect(data.sections["background-information"].versions[0].kind).toBe("hers");
  expect(data.sections["crisis-plan"].versions.map((v: { kind: string; basedOn?: number }) => [v.kind, v.basedOn])).toEqual([
    ["hers", undefined],
    ["hers", 1],
  ]);

  // The sidebar's sections say so, the section's own screen shows it as hers, and the case no longer waits for her sections.
  await row(page, "background-information").getByRole("link", { name: "Open the section" }).click();
  await expect(heading(page)).toHaveText("Background Information");
  await expect(page.getByTestId("state-chip").first()).toHaveAttribute("data-state", "hers");
  await expect(page.getByTestId("section-view")).toContainText("Second paragraph.");
  await goTo(page, `/cases/${id}/sources`);
  await expect(page.getByTestId("half-done-banner")).toHaveCount(0);
  await goTo(page, `/cases/${id}/report`);
  await expect(page.getByTestId("paste-card")).not.toHaveAttribute("data-first", "true");
});

/** A case whose sections have an AI draft each, written into its data file before the app starts. Invented. */
function seedDraftedCase(home: string, label: string, id: string, sectionIds: string[] = ["background-information"]) {
  const at = "2026-11-20T10:00:00.000Z";
  const generation = {
    provider: "anthropic",
    requestedModel: "invented-model",
    servedModel: "invented-model",
    effort: "medium",
    rulesVersions: {},
    sourcesUsed: [],
    sectionsUsed: [],
    deidentified: false,
    usage: { uncachedInputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: null },
    costUsd: null,
  };
  const sections = Object.fromEntries(
    sectionIds.map((sectionId) => [sectionId, { currentVersion: 1, approvedVersion: null, versions: [{ number: 1, kind: "draft", createdAt: at, text: `An invented AI draft of ${sectionId}.`, generation }] }]),
  );
  const folder = seedCase(defaultCasesFolder(home), label, { schemaVersion: 4, id, label, createdAt: at, updatedAt: at, sources: [], sections });
  return { folder, read: () => JSON.parse(readFileSync(path.join(folder, "aba-case.json"), "utf8")) };
}

test("Paste what you already wrote: a text pasted over an AI draft is hers, so the AI and the case map use it (review B1, the owner's decision)", async ({ launch, home }) => {
  // A case whose Background Information has an AI draft, written into its data file before the app starts. Invented.
  const id = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  const { read } = seedDraftedCase(home, "Drafted case", id);
  const page = await firstScreen(await launch());
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  await expect(row(page, "background-information").getByTestId("state-chip")).toHaveAttribute("data-state", "drafted");
  const box = await openRow(page, "background-information");
  await expect(row(page, "background-information")).toContainText("This section already has text in the app: what you paste becomes a new version, and the earlier ones stay.");
  await box.fill("Her background from ABA Matrix.");
  await page.getByTestId("bulk-paste-save").click();
  await expect(page.getByTestId("bulk-paste-result")).toHaveText("1 section saved as yours.");
  await expect(row(page, "background-information")).toHaveAttribute("data-outcome", "saved");
  await expect(row(page, "background-information").getByTestId("state-chip")).toHaveAttribute("data-state", "hers");

  // On disk: a new version of hers, not a correction of the draft; it still says what it replaced, and the draft stays.
  const versions = read().sections["background-information"].versions;
  expect(versions.map((v: { number: number; kind: string; basedOn?: number; text: string }) => [v.number, v.kind, v.basedOn, v.text])).toEqual([
    [1, "draft", undefined, "An invented AI draft of background-information."],
    [2, "hers", 1, "Her background from ABA Matrix."],
  ]);
  expect(versions[1].generation).toBeUndefined();
  expect(versions[1].fromApproved).toBeUndefined();

  // The section's own screen shows it as written by her, not corrected.
  await row(page, "background-information").getByRole("link", { name: "Open the section" }).click();
  await expect(heading(page)).toHaveText("Background Information");
  await expect(page.getByTestId("state-chip").first()).toHaveAttribute("data-state", "hers");
  await expect(page.getByTestId("section-view")).toContainText("Her background from ABA Matrix.");
  await expect(page.getByTestId("version-line")).toContainText("v2: yours");
});

async function failNextSaveOf(app: ElectronApplication, caseFolder: string, sectionId: string) {
  // The case folder refuses only that one save: the others before and after it are saved.
  await app.evaluate(
    ({ ipcMain }, [folder, failing]) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const fs = process.getBuiltinModule("node:fs");
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const original = handlers.get("sections:save-text");
      if (!original) throw new Error("No handler for sections:save-text");
      let used = false;
      ipcMain.removeHandler("sections:save-text");
      ipcMain.handle("sections:save-text", async (event, ...args) => {
        if (used || args[1] !== failing) return original(event, ...args);
        used = true;
        fs.chmodSync(folder, 0o555);
        try {
          return await original(event, ...args);
        } finally {
          fs.chmodSync(folder, 0o755);
        }
      });
    },
    [caseFolder, sectionId] as const,
  );
}

test("Paste what you already wrote: a box that could not be saved keeps its text, says so, survives a reload, and Try again saves it", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const app = await launch({ language: "es" });
  const page = await firstScreen(app);
  const id = (await call<{ case: { id: string } }>(page, "createCase", { label: "Caso que falla", clientAge: null })).case.id;
  const { folder, read } = caseData(home, readdirSync(defaultCasesFolder(home))[0]);
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Pegar lo que ya escribiste");
  await (await openRow(page, "background-information")).fill("Background que se guarda.");
  await (await openRow(page, "medical-necessity")).fill("Medical necessity que falla.");
  await (await openRow(page, "crisis-plan")).fill("Crisis plan que se guarda.");
  await failNextSaveOf(app, folder, "medical-necessity");
  await page.getByTestId("bulk-paste-save").click();

  // The failure does not stop the others; the box keeps her text, edged and said in words.
  await expect(page.getByTestId("bulk-paste-result")).toHaveText("No se pudo guardar 1 sección: su texto sigue en su caja. Vuelve a intentarlo.");
  await expect(row(page, "medical-necessity")).toHaveAttribute("data-outcome", "failed");
  await expect(row(page, "medical-necessity").getByRole("alert")).toContainText("No se pudo guardar. Tu texto sigue aquí.");
  await expect(row(page, "medical-necessity").getByTestId("paste-box")).toHaveValue("Medical necessity que falla.");
  await expect(row(page, "background-information")).toHaveAttribute("data-outcome", "saved");
  await expect(row(page, "crisis-plan")).toHaveAttribute("data-outcome", "saved");
  expect(read().sections["medical-necessity"]).toBeUndefined();
  await expect(page.getByTestId("bulk-paste-save")).toHaveText("Guardar 1 sección");

  // A reload with the folder still refusing: the page starts with nothing in memory, the main process kept the text.
  chmodSync(folder, 0o555);
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
    await page.waitForEvent("load");
    await expect(heading(page)).toHaveText("Pegar lo que ya escribiste");
    await expect(row(page, "medical-necessity").getByTestId("paste-box")).toHaveValue("Medical necessity que falla.");
    await expect(row(page, "medical-necessity")).toHaveAttribute("data-outcome", "failed");
    // The two saved before are not put back.
    await expect(row(page, "background-information").getByTestId("paste-box")).toHaveCount(0);
  } finally {
    chmodSync(folder, 0o755);
  }
  await row(page, "medical-necessity").getByRole("button", { name: "Volver a intentar" }).click();
  await expect(page.getByTestId("bulk-paste-result")).toHaveText("1 sección guardada como tuya.");
  await expect(row(page, "medical-necessity")).toHaveAttribute("data-outcome", "saved");
  // The button went with the row: the focus is on the row's own button (review round 1, minor 3).
  await expect(row(page, "medical-necessity").getByRole("button", { expanded: false })).toBeFocused();
  const data = read();
  expect(data.sections["medical-necessity"].versions.map((v: { text: string }) => v.text)).toEqual(["Medical necessity que falla."]);
  expect(data.sections["background-information"].versions).toHaveLength(1);
  expect(data.sections["crisis-plan"].versions).toHaveLength(1);
  // Nothing is left unsaved.
  expect(await call<unknown[]>(page, "listFailedSaves")).toEqual([]);
});

test("Paste what you already wrote: boxes left unsaved are saved on a reload and on quitting, one version of hers each (review round 1, S2)", async ({ launch, home }) => {
  let app = await launch();
  let page = await firstScreen(app);
  await createCase(page, "Close case", "I already wrote parts in ABA Matrix");
  const id = page.url().match(/cases\/([^/]+)\/sources$/)![1];
  const { read } = caseData(home, "Close case");
  // An approved section says, before she saves, that a paste takes its approval away (review round 1, S3).
  expect((await call<{ outcome: string }>(page, "saveSectionText", id, "medical-necessity", "Her approved text.", null)).outcome).toBe("saved");
  expect((await call<{ outcome: string }>(page, "approveSection", id, "medical-necessity", 1)).outcome).toBe("saved");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page.waitForEvent("load");
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  await openRow(page, "medical-necessity");
  await expect(row(page, "medical-necessity")).toContainText("This section is approved: what you paste becomes a new version, and you will need to approve it again.");
  // The rail, not the trial bar (also a complementary landmark): review round 2, B1.
  await expect(page.locator("[data-region='rail']")).toContainText("What you leave in the boxes is also saved if you close the app.");

  // Two boxes filled, "Save" never pressed, then a reload.
  await (await openRow(page, "background-information")).fill("Background left in its box.");
  await (await openRow(page, "risk-assessment")).fill("Risk assessment left in its box.");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload());
  await page.waitForEvent("load");
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  let data = read();
  expect(data.sections["background-information"].versions.map((v: { kind: string; text: string }) => [v.kind, v.text])).toEqual([["hers", "Background left in its box."]]);
  expect(data.sections["risk-assessment"].versions.map((v: { kind: string; text: string }) => [v.kind, v.text])).toEqual([["hers", "Risk assessment left in its box."]]);
  // The approved section was not touched: nothing was pasted in its box.
  expect(data.sections["medical-necessity"].approvedVersion).toBe(1);
  expect(await call<unknown[]>(page, "listFailedSaves")).toEqual([]);
  // Saved once: after the reload the boxes are empty and nothing shows as not saved.
  await expect(page.getByTestId("paste-box")).toHaveCount(0);
  await expect(page.locator("[data-testid='paste-row'][data-outcome='failed']")).toHaveCount(0);
  await goTo(page, `/cases/${id}/sources`);
  await expect(page.getByTestId("half-done-banner")).toHaveCount(0);

  // One more box, then she quits the app.
  await goTo(page, `/cases/${id}/report/paste`);
  await (await openRow(page, "crisis-plan")).fill("Crisis plan left in its box.");
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
  data = read();
  expect(data.sections["crisis-plan"].versions.map((v: { kind: string; text: string }) => [v.kind, v.text])).toEqual([["hers", "Crisis plan left in its box."]]);
  expect(data.sections["background-information"].versions).toHaveLength(1);

  app = await launch();
  page = await firstScreen(app);
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  await expect(page.getByTestId("paste-box")).toHaveCount(0);
  await expect(row(page, "crisis-plan").getByTestId("state-chip")).toHaveAttribute("data-state", "hers");
});

test("Paste what you already wrote: a box not saved here and then saved newer on the section's own screen never comes back (review round 1, S1)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const app = await launch();
  const page = await firstScreen(app);
  await createCase(page, "Stale case", "I already wrote parts in ABA Matrix");
  const id = page.url().match(/cases\/([^/]+)\/sources$/)![1];
  const { folder, read } = caseData(home, "Stale case");
  await goTo(page, `/cases/${id}/report/paste`);
  await (await openRow(page, "background-information")).fill("Older text, not saved.");
  await failNextSaveOf(app, folder, "background-information");
  await page.getByTestId("bulk-paste-save").click();
  await expect(row(page, "background-information")).toHaveAttribute("data-outcome", "failed");

  // On the section's own screen the kept text is in its editor; she changes it there, and that newer text is saved.
  await goTo(page, `/cases/${id}/report/background-information`);
  await expect(heading(page)).toHaveText("Background Information");
  const editor = page.getByTestId("section-text");
  await expect(editor).toHaveValue("Older text, not saved.");
  await editor.fill("Newer text, saved on the section's screen.");
  await page.getByTestId("section-done").click();
  await expect(page.getByTestId("section-view")).toContainText("Newer text, saved on the section's screen.");
  expect(await call<unknown[]>(page, "listFailedSaves")).toEqual([]);
  // A section of hers saved on its own screen also ends the wait for her sections (review round 1, minor 9).
  await goTo(page, `/cases/${id}/sources`);
  await expect(page.getByTestId("half-done-banner")).toHaveCount(0);

  // Back on the paste screen: the box is empty, nothing shows as not saved, and Save has nothing to put back.
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  await expect(row(page, "background-information")).not.toHaveAttribute("data-outcome", "failed");
  await expect(row(page, "background-information").getByTestId("paste-box")).toHaveCount(0);
  await expect(page.getByTestId("bulk-paste-save")).toBeDisabled();
  expect(read().sections["background-information"].versions.map((v: { text: string }) => v.text)).toEqual(["Newer text, saved on the section's screen."]);
});

test("Paste what you already wrote: a pasted box not saved stays hers when the section's own screen saves it (review round 2, S1)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const id = "8d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
  const { folder, read } = seedDraftedCase(home, "Kept paste case", id);
  const app = await launch();
  const page = await firstScreen(app);
  await goTo(page, `/cases/${id}/report/paste`);
  await expect(heading(page)).toHaveText("Paste what you already wrote");
  await (await openRow(page, "background-information")).fill("Her pasted background, not saved yet.");
  await failNextSaveOf(app, folder, "background-information");
  await page.getByTestId("bulk-paste-save").click();
  await expect(row(page, "background-information")).toHaveAttribute("data-outcome", "failed");
  expect((await call<Array<{ pasted: boolean }>>(page, "listFailedSaves")).map((item) => item.pasted)).toEqual([true]);

  // The section's own screen puts the kept text back, as hers, not as a correction of the draft; she leaves without typing.
  await goTo(page, `/cases/${id}/report/background-information`);
  await expect(heading(page)).toHaveText("Background Information");
  await expect(page.getByTestId("section-text")).toHaveValue("Her pasted background, not saved yet.");
  await expect(page.getByTestId("state-chip").first()).toHaveAttribute("data-state", "hers");
  await goTo(page, `/cases/${id}/report`);
  await expect.poll(async () => (await call<unknown[]>(page, "listFailedSaves")).length).toBe(0);
  expect(read().sections["background-information"].versions.map((v: { kind: string; basedOn?: number; text: string }) => [v.kind, v.basedOn, v.text])).toEqual([
    ["draft", undefined, "An invented AI draft of background-information."],
    ["hers", 1, "Her pasted background, not saved yet."],
  ]);
});

test("Paste what you already wrote: a hand edit of an AI draft not saved on the section's screen is never put in a box here (review round 2, S1)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const id = "9e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
  const { folder, read } = seedDraftedCase(home, "Kept edit case", id, ["medical-necessity"]);
  const page = await firstScreen(await launch());
  await goTo(page, `/cases/${id}/report/medical-necessity`);
  await expect(heading(page)).toHaveText("Medical Necessity Criteria");
  await page.getByRole("button", { name: "Edit by hand" }).click();
  chmodSync(folder, 0o555);
  try {
    await page.getByTestId("section-text").fill("The AI draft, half edited by hand.");
    await expect.poll(async () => (await call<Array<{ pasted: boolean; editing: number | null }>>(page, "listFailedSaves")).map((item) => [item.pasted, item.editing])).toEqual([[false, null]]);
    // On the paste screen (leaving the section saves again, and fails again): no box shows her edit, and nothing is offered to save.
    await goTo(page, `/cases/${id}/report/paste`);
    await expect(heading(page)).toHaveText("Paste what you already wrote");
    await expect(row(page, "medical-necessity")).not.toHaveAttribute("data-outcome", "failed");
    await expect(row(page, "medical-necessity").getByTestId("paste-box")).toHaveCount(0);
    await expect(page.getByTestId("bulk-paste-save")).toBeDisabled();
  } finally {
    chmodSync(folder, 0o755);
  }
  // Try again saves it as what it is: her edit of the draft, which the other sections do not build on until she approves it.
  const [kept] = await call<Array<{ id: string }>>(page, "listFailedSaves");
  expect((await call<{ outcome: string }>(page, "retryFailedSave", kept.id)).outcome).toBe("saved");
  expect(read().sections["medical-necessity"].versions.map((v: { kind: string; text: string }) => [v.kind, v.text])).toEqual([
    ["draft", "An invented AI draft of medical-necessity."],
    ["edited", "The AI draft, half edited by hand."],
  ]);
});
