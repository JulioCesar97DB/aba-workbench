import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultCasesFolder, expect, goTo, SAMPLE_CASE, seedCase, startSecondCopy, stubFileManager, stubFolderDialog, test } from "./app.ts";

/*
 * Cases as a user meets them: creating one, finding it in the list, opening it after a
 * restart, folders that are not cases, and changing the cases folder. Every test works
 * in a temporary home folder (--home-folder, built app) or a temporary cases folder
 * chosen in the profile (packaged app); none touches the real home folder or Documents.
 * Only invented cases.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

async function openApp(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  return page;
}

async function createCase(page: Page, label: string, age?: { years?: string; months?: string }, words = { newCase: "New case", label: "Label", years: "Years", months: "Months", create: "Create case" }) {
  await page.getByRole("button", { name: words.newCase }).click();
  const dialog = page.getByRole("dialog", { name: words.newCase });
  await dialog.getByRole("textbox", { name: words.label }).fill(label);
  if (age?.years !== undefined) await dialog.getByRole("textbox", { name: words.years }).fill(age.years);
  if (age?.months !== undefined) await dialog.getByRole("textbox", { name: words.months }).fill(age.months);
  await dialog.getByRole("button", { name: words.create }).click();
  await expect(dialog).toBeHidden();
}

function snapshot(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return `${path.relative(folder, full)}:${entry.isFile() ? readFileSync(full, "utf8") : "dir"}`;
    })
    .sort();
}

test("create a case, see it in the list, restart the app and open it again", async ({ launch, home }, testInfo) => {
  const casesFolder = defaultCasesFolder(home);
  let app = await launch();
  let page = await openApp(app);
  // The default folder (built app): nothing is made in the home folder until the first case.
  if (testInfo.project.name === "built") expect(readdirSync(home)).toEqual([]);

  await createCase(page, "R.T. initial assessment", { years: "5", months: "3" });
  // The new case opens on its first step, with its label and age in the sidebar.
  await expect(heading(page)).toHaveText("Sources");
  await expect(page.getByText("R.T. initial assessment · Step 1 of 5")).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Steps of the case" }).locator("xpath=ancestor::div[@data-surface='nav'][1]");
  await expect(sidebar.getByText("R.T. initial assessment", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("5 years 3 months")).toBeVisible();

  // On disk: its folder, named from the label, holding only its data file.
  expect(readdirSync(casesFolder)).toEqual(["R.T. initial assessment"]);
  const caseFolder = path.join(casesFolder, "R.T. initial assessment");
  expect(readdirSync(caseFolder)).toEqual(["aba-case.json"]);
  const data = JSON.parse(readFileSync(path.join(caseFolder, "aba-case.json"), "utf8"));
  expect(data).toEqual({
    schemaVersion: 1,
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    label: "R.T. initial assessment",
    clientAge: { years: 5, months: 3 },
    createdAt: expect.any(String),
    updatedAt: data.createdAt,
    files: [],
  });

  await page.getByRole("link", { name: "All cases" }).click();
  await expect(heading(page)).toHaveText("Cases");
  const row = page.getByRole("row", { name: /R\.T\. initial assessment/ });
  await expect(row).toContainText("5 years 3 months");

  await app.close();
  app = await launch();
  page = await openApp(app);
  await page.getByRole("link", { name: "R.T. initial assessment" }).click();
  await expect(heading(page)).toHaveText("Sources");
  await expect(page.getByText("R.T. initial assessment · Step 1 of 5")).toBeVisible();
  expect(page.url()).toContain(`#/cases/${data.id}/sources`);
});

test("the form checks the label and the age, in Spanish too, and two cases with one label get two folders", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  const page = await openApp(await launch({ language: "es" }));
  const words = { newCase: "Nuevo caso", label: "Nombre", years: "Años", months: "Meses", create: "Crear caso" };
  await page.getByRole("button", { name: words.newCase }).click();
  const dialog = page.getByRole("dialog", { name: words.newCase });
  await dialog.getByRole("textbox", { name: words.months }).fill("12");
  await dialog.getByRole("button", { name: words.create }).click();
  await expect(dialog.getByText("Escribe un nombre para el caso.")).toBeVisible();
  await expect(dialog.getByText("Los meses deben ser un número entero del 0 al 11.")).toBeVisible();
  // Focus goes to the first field to fix.
  await expect(dialog.getByRole("textbox", { name: words.label })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(existsSync(casesFolder) ? readdirSync(casesFolder) : []).toEqual([]);

  await createCase(page, "Ana", { months: "8" }, words);
  await expect(page.getByText("8 meses", { exact: true })).toBeVisible();
  await goTo(page, "/");
  await createCase(page, "ana", undefined, words);
  await expect(page.getByText("Edad sin indicar")).toBeVisible();
  await goTo(page, "/");
  expect(readdirSync(casesFolder).sort()).toEqual(["Ana", "ana 2"]);
  // Newest first.
  await expect(page.getByRole("main").getByRole("table").first().getByRole("rowheader")).toHaveText(["ana", "Ana"]);
});

test("folders that are not cases show plainly as unreadable and are never changed", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  seedCase(casesFolder);
  mkdirSync(path.join(casesFolder, "Scans to sort"));
  writeFileSync(path.join(casesFolder, "Scans to sort", "notes.txt"), "the user's own file");
  mkdirSync(path.join(casesFolder, "Broken"));
  writeFileSync(path.join(casesFolder, "Broken", "aba-case.json"), "{ half a fi");
  seedCase(casesFolder, "From the future", { ...SAMPLE_CASE, id: "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", schemaVersion: 7, drafts: {} });
  // A copied folder: the same id under a later name.
  seedCase(casesFolder, "M.F. sample case copy", SAMPLE_CASE);
  const before = snapshot(casesFolder);

  const app = await launch();
  const shown = await stubFileManager(app);
  const page = await openApp(app);
  await expect(page.getByRole("link", { name: SAMPLE_CASE.label })).toBeVisible();
  const group = page.getByRole("region", { name: "Folders that could not be opened" });
  await expect(group.getByRole("rowheader")).toHaveText(["Broken", "From the future", "M.F. sample case copy", "Scans to sort"]);
  await expect(group.getByRole("row", { name: /Broken/ })).toContainText("Damaged: its aba-case.json file cannot be read.");
  await expect(group.getByRole("row", { name: /M\.F\. sample case copy/ })).toContainText("A copy of another case.");
  await expect(group.getByRole("row", { name: /From the future/ })).toContainText("Made by a newer version of ABA Workbench.");
  await expect(group.getByRole("row", { name: /Scans to sort/ })).toContainText("Not a case: it has no aba-case.json file.");

  const showLabel = process.platform === "darwin" ? "Show in Finder" : process.platform === "win32" ? "Show in Explorer" : "Show in file manager";
  await group.getByRole("row", { name: /Broken/ }).getByRole("button", { name: showLabel }).click();
  await expect.poll(shown).toEqual([path.join(casesFolder, "Broken")]);

  // The newer version's case cannot be opened by its address either, and stays as it was.
  await goTo(page, "/cases/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/sources");
  await expect(heading(page)).toHaveText("This case was not found");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources`);
  await expect(heading(page)).toHaveText("Sources");
  expect(snapshot(casesFolder)).toEqual(before);
});

test("a PDF put into the case's folder shows when the case is opened again, and the case is saved", async ({ launch, home }) => {
  const caseFolder = seedCase(defaultCasesFolder(home));
  const app = await launch();
  const page = await openApp(app);
  await page.getByRole("link", { name: SAMPLE_CASE.label }).click();
  const rail = page.getByRole("complementary", { name: "Sources and checks" });
  await expect(rail).toContainText("None yet. PDFs you put in the case's folder show here.");

  writeFileSync(path.join(caseFolder, "vineland-3.pdf"), "%PDF-1.4 invented test file");
  await page.getByRole("link", { name: "All cases" }).click();
  await page.getByRole("link", { name: SAMPLE_CASE.label }).click();
  await expect(rail.getByRole("listitem")).toHaveText(["vineland-3.pdf"]);
  const data = JSON.parse(readFileSync(path.join(caseFolder, "aba-case.json"), "utf8"));
  expect(data.files).toEqual([{ name: "vineland-3.pdf", bytes: 27, modifiedAt: statSync(path.join(caseFolder, "vineland-3.pdf")).mtime.toISOString() }]);
  expect(data.updatedAt > SAMPLE_CASE.updatedAt).toBe(true);
  expect(data.createdAt).toBe(SAMPLE_CASE.createdAt);
  expect(readdirSync(caseFolder).sort()).toEqual(["aba-case.json", "vineland-3.pdf"]);
  await page.getByRole("link", { name: "All cases" }).click();
  await expect(page.getByRole("row", { name: new RegExp(SAMPLE_CASE.label.replace(/\./g, "\\.")) }).getByRole("cell").last()).toHaveText("1");
});

test("change the cases folder in Settings; it is remembered, and the list follows it", async ({ launch, home, profile }, testInfo) => {
  seedCase(defaultCasesFolder(home));
  const other = path.join(home, "Elsewhere", "My cases");
  mkdirSync(other, { recursive: true });
  let app = await launch();
  let page = await openApp(app);
  await expect(page.getByRole("link", { name: SAMPLE_CASE.label })).toBeVisible();

  await goTo(page, "/settings");
  const section = page.getByRole("region", { name: "Cases folder" });
  await expect(section.getByTestId("cases-folder-path")).toHaveText(defaultCasesFolder(home));
  // The built app takes it as its default; the packaged app was given it as a chosen folder.
  await expect(section.getByText("Default", { exact: true })).toHaveCount(testInfo.project.name === "built" ? 1 : 0);
  await expect(section.getByText("If OneDrive, iCloud, Dropbox or Google Drive syncs this folder, your cases are copied to that service.")).toBeVisible();

  // Cancelling the dialog changes nothing.
  await stubFolderDialog(app, null);
  await section.getByRole("button", { name: "Choose another folder…" }).click();
  await expect(section.getByTestId("cases-folder-path")).toHaveText(defaultCasesFolder(home));

  // A folder that is gone is refused.
  await stubFolderDialog(app, path.join(home, "gone"));
  await section.getByRole("button", { name: "Choose another folder…" }).click();
  await expect(section.getByRole("status")).toContainText("That folder cannot be used, so the cases folder did not change.");
  await expect(section.getByTestId("cases-folder-path")).toHaveText(defaultCasesFolder(home));

  await stubFolderDialog(app, other);
  await section.getByRole("button", { name: "Choose another folder…" }).click();
  await expect(section.getByRole("status")).toHaveText("Saved. New cases go in this folder.");
  await expect(section.getByTestId("cases-folder-path")).toHaveText(other);
  await expect(section.getByText("Default", { exact: true })).toHaveCount(0);
  expect(JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8"))).toEqual({ version: 1, language: "en", casesFolder: other });

  await page.getByRole("link", { name: "Cases", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No cases yet" })).toBeVisible();
  await createCase(page, "In the new folder");
  expect(readdirSync(other)).toEqual(["In the new folder"]);

  await app.close();
  app = await launch();
  page = await openApp(app);
  await expect(page.getByRole("link", { name: "In the new folder" })).toBeVisible();
  await expect(page.getByRole("link", { name: SAMPLE_CASE.label })).toHaveCount(0);
});

test("a cases folder that is missing is reported, never made again, and another can be chosen", async ({ launch, home }) => {
  const unplugged = path.join(home, "External drive", "Cases");
  const app = await launch({ casesFolder: unplugged });
  const page = await openApp(app);
  await expect(page.getByRole("heading", { name: "Your cases folder cannot be used" })).toBeVisible();
  await expect(page.getByText(/The cases folder was not found/)).toBeVisible();
  await expect(page.getByText(unplugged)).toBeVisible();
  expect(readdirSync(home)).toEqual([]);

  // Creating a case says why it cannot, and makes nothing.
  await page.getByRole("button", { name: "New case" }).click();
  const dialog = page.getByRole("dialog", { name: "New case" });
  await dialog.getByRole("textbox", { name: "Label" }).fill("Ana");
  await dialog.getByRole("button", { name: "Create case" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The cases folder was not found");
  await page.keyboard.press("Escape");
  expect(readdirSync(home)).toEqual([]);

  const chosen = path.join(home, "Found");
  mkdirSync(chosen);
  await stubFolderDialog(app, chosen);
  await page.getByRole("button", { name: "Choose another folder…" }).click();
  await expect(page.getByRole("heading", { name: "No cases yet" })).toBeVisible();
});

test("the interface's functions refuse hostile input and say nothing about the disk", async ({ app, home }) => {
  const page = await openApp(app);
  const results = await page.evaluate(async () => {
    const aba = (globalThis as unknown as { aba: Record<string, (...args: unknown[]) => Promise<unknown>> }).aba;
    const attempt = (call: () => Promise<unknown>) => call().then((value) => ({ ok: true, value }), (error: Error) => ({ ok: false, message: error.message }));
    return {
      pathId: await attempt(() => aba.openCase("../../../etc/passwd")),
      objectId: await attempt(() => aba.openCase({ id: "x" })),
      hugeLabel: await attempt(() => aba.createCase({ label: "x".repeat(5_000_000) })),
      extraKey: await attempt(() => aba.createCase({ label: "Ana", folder: "/tmp" })),
      wrongType: await attempt(() => aba.createCase("Ana")),
      badAge: await attempt(() => aba.createCase({ label: "Ana", clientAge: { years: -1 } })),
      traversal: await attempt(() => aba.showUnreadableFolder("../..")),
      unknownCase: await attempt(() => aba.openCase("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d")),
    };
  });
  for (const key of ["pathId", "objectId", "hugeLabel", "extraKey", "wrongType", "badAge", "traversal"] as const) {
    const result = results[key] as { ok: boolean; message: string };
    expect(result.ok, key).toBe(false);
    expect(result.message, key).toContain("Refused:");
    expect(result.message, key).not.toContain(home);
    expect(result.message.length, key).toBeLessThan(400);
  }
  expect(results.unknownCase).toEqual({ ok: true, value: { outcome: "not-found" } });
  const casesFolder = defaultCasesFolder(home);
  expect(existsSync(casesFolder) ? readdirSync(casesFolder) : []).toEqual([]);
});

test("the packaged app on macOS says why it may ask for a protected folder, in English and Spanish, and never claims Documents", async ({ app }, testInfo) => {
  test.skip(testInfo.project.name !== "packaged" || process.platform !== "darwin", "macOS packaged app only");
  const resources = await app.evaluate(() => process.resourcesPath);
  const plist = readFileSync(path.join(resources, "..", "Info.plist"), "utf8");
  expect(plist).toContain("<key>NSDocumentsFolderUsageDescription</key>");
  expect(plist).toContain("<key>NSFileProviderDomainUsageDescription</key>");
  expect(plist).toContain("ABA Workbench keeps your cases in the folder you chose in Settings.");
  expect(plist).not.toContain("inside Documents");
  for (const language of ["es", "es_419"]) {
    const strings = readFileSync(path.join(resources, `${language}.lproj`, "InfoPlist.strings"), "utf8");
    expect(strings).toContain("la carpeta que elegiste en Ajustes");
    expect(strings).not.toContain("Documentos");
  }
  expect(readFileSync(path.join(resources, "en.lproj", "InfoPlist.strings"), "utf8")).toContain("the folder you chose in Settings");
});

test("a second start of the app on the same profile quits and leaves the first one as it was", async ({ launch, home, profile }, testInfo) => {
  seedCase(defaultCasesFolder(home));
  const app = await launch();
  const page = await openApp(app);
  await expect(page.getByRole("link", { name: SAMPLE_CASE.label })).toBeVisible();
  // Two copies would each have their own save queue and could overwrite each other's saves.
  expect(await startSecondCopy(testInfo.project.name, profile, home)).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await page.getByRole("link", { name: SAMPLE_CASE.label }).click();
  await expect(heading(page)).toHaveText("Sources");
});

test("Settings says so when the cases folder cannot be shown or checked", async ({ app }) => {
  const page = await openApp(app);
  await stubFileManager(app, { fail: true });
  await goTo(page, "/settings");
  const section = page.getByRole("region", { name: "Cases folder" });
  // The default folder exists once a case is made; make one so "Show" is available.
  await goTo(page, "/");
  await page.getByRole("button", { name: "New case" }).click();
  await page.getByRole("dialog", { name: "New case" }).getByRole("textbox", { name: "Label" }).fill("Ana");
  await page.getByRole("dialog", { name: "New case" }).getByRole("button", { name: "Create case" }).click();
  await expect(heading(page)).toHaveText("Sources");
  await goTo(page, "/settings");
  const showLabel = process.platform === "darwin" ? "Show in Finder" : process.platform === "win32" ? "Show in Explorer" : "Show in file manager";
  await section.getByRole("button", { name: showLabel }).click();
  await expect(section.getByRole("status")).toHaveText("The cases folder could not be shown. It may have been moved, or it is not available.");

  // The main process cannot answer where the cases are: Settings says so instead of showing nothing.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cases-folder:get");
    ipcMain.handle("cases-folder:get", () => {
      throw new Error("Simulated failure");
    });
  });
  await goTo(page, "/");
  await goTo(page, "/settings");
  await expect(section.getByRole("status")).toHaveText("Where your cases are kept could not be checked. Try again in a moment.");
});

test("--home-folder moves the default cases folder in development only; the packaged app ignores it", async ({ launch, home }, testInfo) => {
  // The folder is also the chosen one, so neither app ever looks at the real home folder.
  // Settings shows "Default" only when the chosen folder is the default: the built app
  // takes <home> as its home, so it is; the packaged app ignores the option, so it is not.
  const casesFolder = defaultCasesFolder(home);
  mkdirSync(casesFolder, { recursive: true });
  const app = await launch({ casesFolder, extraArgs: [`--home-folder=${home}`] });
  const page = await openApp(app);
  await goTo(page, "/settings");
  const section = page.getByRole("region", { name: "Cases folder" });
  await expect(section.getByTestId("cases-folder-path")).toHaveText(casesFolder);
  await expect(section.getByText("Default", { exact: true })).toHaveCount(testInfo.project.name === "packaged" ? 0 : 1);
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(testInfo.project.name === "packaged");
});

test("a case whose creation was cut short is finished on Home, or shown as unfinished; nothing is deleted", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  mkdirSync(casesFolder, { recursive: true });
  const then = new Date(Date.now() - 2 * 60_000);
  // Complete: the crash came after the save was flushed, before the rename.
  const complete = JSON.stringify({ schemaVersion: 1, files: [], ...SAMPLE_CASE, label: "Finished after a crash" }, null, 2);
  mkdirSync(path.join(casesFolder, "Finished after a crash"));
  writeFileSync(path.join(casesFolder, "Finished after a crash", "aba-case.json.4242.tmp"), complete);
  utimesSync(path.join(casesFolder, "Finished after a crash", "aba-case.json.4242.tmp"), then, then);
  // Partial: the crash came before the save was flushed.
  mkdirSync(path.join(casesFolder, "Cut short"));
  writeFileSync(path.join(casesFolder, "Cut short", "aba-case.json.4243.tmp"), complete.slice(0, 40));
  utimesSync(path.join(casesFolder, "Cut short", "aba-case.json.4243.tmp"), then, then);

  const page = await openApp(await launch());
  await expect(page.getByRole("link", { name: "Finished after a crash" })).toBeVisible();
  const group = page.getByRole("region", { name: "Folders that could not be opened" });
  await expect(group.getByRole("row", { name: /Cut short/ })).toContainText("A case that was not finished being created");
  expect(readdirSync(path.join(casesFolder, "Finished after a crash"))).toEqual(["aba-case.json"]);
  expect(readFileSync(path.join(casesFolder, "Finished after a crash", "aba-case.json"), "utf8")).toBe(complete);
  expect(readdirSync(path.join(casesFolder, "Cut short"))).toEqual(["aba-case.json.4243.tmp"]);
  await page.getByRole("link", { name: "Finished after a crash" }).click();
  await expect(heading(page)).toHaveText("Sources");
});
