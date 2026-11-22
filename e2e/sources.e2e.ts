import type { ElectronApplication, Page } from "@playwright/test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultCasesFolder, expect, goTo, resize, SAMPLE_CASE, seedCase, test } from "./app.ts";

/*
 * The Sources step as the clinician meets it: pasting texts, adding PDFs through the
 * dialog and by dropping them, opening, editing, renaming and removing sources, in both
 * languages and at a narrow window. Every test works in a temporary home folder or cases
 * folder (see app.ts); the PDFs are invented, made here. The system's file dialog is
 * replaced, so no dialog opens; opening a PDF in the system's viewer is replaced too.
 * With ABA_SCREENSHOTS_DIR set, the tests save screenshots of the step there.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const shots = process.env.ABA_SCREENSHOTS_DIR;

async function screenshot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** An invented PDF: a real header and some bytes, enough for the app's check. */
function inventedPdf(label: string, size = 0): Buffer {
  const body = Buffer.from(`%PDF-1.4\n% Invented test file: ${label}\n%%EOF\n`);
  return size > body.length ? Buffer.concat([body, Buffer.alloc(size - body.length, 0x20)]) : body;
}

function caseData(casesFolder: string) {
  return JSON.parse(readFileSync(path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json"), "utf8"));
}

/** Seeds the invented case (a version 1 data file, as the previous app wrote it) and opens its Sources step. */
async function openSources(launch: (options?: { language?: "en" | "es" }) => Promise<ElectronApplication>, home: string, language: "en" | "es" = "en") {
  const casesFolder = defaultCasesFolder(home);
  seedCase(casesFolder);
  const app = await launch({ language });
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources`);
  await expect(heading(page)).toHaveText(language === "en" ? "Sources" : "Fuentes");
  return { app, page, casesFolder, caseFolder: path.join(casesFolder, SAMPLE_CASE.label) };
}

/** Replaces the system's file dialog: the next choice returns `files`. */
async function stubFileDialog(app: ElectronApplication, files: string[]) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: chosen.length === 0, filePaths: chosen })) as typeof dialog.showOpenDialog;
  }, files);
}

/** Drops files onto the window, as Finder or Explorer would. */
async function dropFiles(page: Page, files: Array<{ name: string; bytes: Buffer }>) {
  await page.evaluate(
    (list) => {
      // The page's own DOM classes (the tests' TypeScript has no DOM types).
      const page = globalThis as unknown as {
        DataTransfer: new () => { items: { add(file: unknown): void } };
        File: new (parts: unknown[], name: string, options: { type: string }) => unknown;
        DragEvent: new (type: string, init: object) => unknown;
        dispatchEvent(event: unknown): boolean;
      };
      const transfer = new page.DataTransfer();
      for (const item of list) transfer.items.add(new page.File([new Uint8Array(item.bytes)], item.name, { type: "application/pdf" }));
      for (const type of ["dragenter", "dragover", "drop"]) page.dispatchEvent(new page.DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    },
    files.map((item) => ({ name: item.name, bytes: [...item.bytes] })),
  );
}

/** A row of the case's sources (the rail lists their names too). */
function sourceRow(page: Page, text: string) {
  return page.getByRole("list", { name: "Sources in this case" }).or(page.getByRole("list", { name: "Fuentes de este caso" })).getByRole("listitem").filter({ hasText: text });
}

function tempFolder(): string {
  return mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-pdfs-"));
}

test("paste a text: saved as it is typed, no Save button, and there after a restart", async ({ launch, home }) => {
  const first = await openSources(launch, home);
  const { casesFolder } = first;
  let { app, page } = first;
  await expect(page.getByRole("heading", { name: "Add this client's sources" })).toBeVisible();
  await screenshot(page, "sources-empty-en");

  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByRole("menuitem", { name: "CDE" }).click();
  await expect(heading(page)).toHaveText("New pasted text");
  // The text area has the focus: paste straight away.
  const text = page.getByRole("textbox", { name: "Text" });
  await expect(text).toBeFocused();
  await page.getByRole("textbox", { name: "Title (optional)" }).fill("CDE, psychologist's report");
  await page.getByLabel("Date (optional)").fill("2026-10-02");
  await text.fill("Invented CDE notes.\nThe child is 4 years old and speaks about 20 single words.");
  await expect(page.getByText("All changes saved").first()).toBeVisible();
  await expect(heading(page)).toHaveText("CDE, psychologist's report");

  // On disk: version 2, one source, the text exactly as typed.
  let data = caseData(casesFolder);
  expect(data.schemaVersion).toBe(2);
  expect(data.sources).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: "text",
      type: "cde",
      addedAt: expect.any(String),
      updatedAt: expect.any(String),
      text: "Invented CDE notes.\nThe child is 4 years old and speaks about 20 single words.",
      title: "CDE, psychologist's report",
      date: "2026-10-02",
    },
  ]);

  // Typing more saves again, and going back keeps it.
  await text.press("End");
  await text.pressSequentially(" More notes.");
  await page.getByRole("link", { name: "Back to sources" }).click();
  await expect(heading(page)).toHaveText("Sources");
  const row = sourceRow(page, "CDE, psychologist's report");
  await expect(row).toContainText("Pasted text · 90 characters · Oct 2, 2026");
  await expect(row).toContainText("Invented CDE notes. The child is 4 years old");
  await expect.poll(() => caseData(casesFolder).sources[0].text).toContain("More notes.");
  // The rail lists the case's sources.
  await expect(page.getByRole("complementary").getByText("CDE, psychologist's report")).toBeVisible();

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources`);
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("textbox", { name: "Text" })).toHaveValue("Invented CDE notes.\nThe child is 4 years old and speaks about 20 single words. More notes.");
  data = caseData(casesFolder);
  expect(data.sources).toHaveLength(1);
});

test("a very long paste stays quick and is saved whole", async ({ launch, home }) => {
  const { page, casesFolder } = await openSources(launch, home);
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByRole("menuitem", { name: "Parent interview" }).click();
  // About 600,000 characters, in paragraphs as a report has them.
  const long = "Invented parent interview notes, one paragraph of a long report that goes on for a while.\n".repeat(6_500);
  const box = page.getByRole("textbox", { name: "Text" });
  let started = Date.now();
  // As a paste leaves it: the whole text in the field at once, then an input event. (Playwright's
  // fill types it through the editor, far slower than a paste; the system clipboard is not used,
  // so a test never changes the user's clipboard.)
  await box.evaluate((field, text) => {
    const area = field as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    area.value = text;
    area.dispatchEvent(new (globalThis as unknown as { InputEvent: new (type: string, init: object) => unknown }).InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  }, long);
  await expect(page.getByText("All changes saved").first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5_000);
  // Typing in it stays quick.
  started = Date.now();
  await box.press("ControlOrMeta+End");
  await box.pressSequentially("More.");
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect.poll(() => caseData(casesFolder).sources[0].text).toBe(`${long}More.`);
  await expect(page.getByText(`${(long.length + 5).toLocaleString("en")} of 1,000,000 characters`)).toBeVisible();
  await page.getByRole("link", { name: "Back to sources" }).click();
  await expect(sourceRow(page, "Parent interview")).toContainText(`${(long.length + 5).toLocaleString("en")} characters`);
});

test("PDFs from the dialog and dropped onto the window are copied as they are; the originals are not touched", async ({ launch, home }) => {
  const { app, page, caseFolder, casesFolder } = await openSources(launch, home);
  const originals = tempFolder();
  try {
    const vineland = path.join(originals, "Vineland-3 report.pdf");
    const basc = path.join(originals, "basc-3-prq.pdf");
    writeFileSync(vineland, inventedPdf("Vineland-3"));
    writeFileSync(basc, inventedPdf("BASC-3"));
    const before = [vineland, basc].map((file) => ({ bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs }));

    await stubFileDialog(app, [vineland, basc]);
    await page.getByRole("button", { name: "Add PDF…" }).click();
    await expect(page.getByText("2 PDFs added.")).toBeVisible();
    await expect(sourceRow(page, "Vineland-3 report.pdf")).toContainText("Vineland-3");
    await expect(sourceRow(page, "basc-3-prq.pdf")).toContainText("BASC-3");
    // Copies in the case's folder, byte for byte; the originals exactly as they were.
    expect(readdirSync(caseFolder).sort()).toEqual(["Vineland-3 report.pdf", "aba-case.json", "basc-3-prq.pdf"]);
    expect(readFileSync(path.join(caseFolder, "Vineland-3 report.pdf"))).toEqual(readFileSync(vineland));
    expect([vineland, basc].map((file) => ({ bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs }))).toEqual(before);
    expect(readdirSync(originals).sort()).toEqual(["Vineland-3 report.pdf", "basc-3-prq.pdf"]);

    // Dropped: a new PDF, a name that tries to leave the folder, the same Vineland again, and a file that is not a PDF.
    await dropFiles(page, [
      { name: "ablls-r.pdf", bytes: inventedPdf("ABLLS-R") },
      { name: "../../outside.pdf", bytes: inventedPdf("outside") },
      { name: "copy of vineland.pdf", bytes: readFileSync(vineland) },
      { name: "notes.docx", bytes: Buffer.from("not a pdf") },
    ]);
    await expect(page.getByText("2 PDFs added.")).toBeVisible();
    await expect(page.getByText("copy of vineland.pdf is already one of this case's sources.")).toBeVisible();
    await expect(page.getByText("notes.docx is not a PDF, so it was not added.")).toBeVisible();
    expect(readdirSync(caseFolder).sort()).toEqual(["Vineland-3 report.pdf", "aba-case.json", "ablls-r.pdf", "basc-3-prq.pdf", "outside.pdf"]);
    expect(readdirSync(casesFolder)).toEqual([SAMPLE_CASE.label]);
    const data = caseData(casesFolder);
    expect(data.sources.map((source: { type: string; file: string }) => [source.type, source.file])).toEqual([
      ["vineland-3", "Vineland-3 report.pdf"],
      ["basc-3", "basc-3-prq.pdf"],
      ["ablls-r", "ablls-r.pdf"],
      ["other", "outside.pdf"],
    ]);
    expect(data.files.map((file: { name: string }) => file.name)).toEqual(["Vineland-3 report.pdf", "ablls-r.pdf", "basc-3-prq.pdf", "outside.pdf"]);

    // Open PDF hands the case's copy to the system's viewer (replaced here).
    const opened = await app.evaluate(({ shell }) => {
      const seen: string[] = [];
      (globalThis as unknown as { opened: string[] }).opened = seen;
      shell.openPath = async (item: string) => {
        seen.push(item);
        return "";
      };
      return true;
    });
    expect(opened).toBe(true);
    await sourceRow(page, "ablls-r.pdf").getByRole("button", { name: "Open PDF" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([path.join(caseFolder, "ablls-r.pdf")]);
    await screenshot(page, "sources-list-en");
  } finally {
    rmSync(originals, { recursive: true, force: true });
  }
});

test("a PDF over the providers' limits is flagged as soon as it is added", async ({ launch, home }) => {
  const { app, page } = await openSources(launch, home);
  const originals = tempFolder();
  try {
    const large = path.join(originals, "large scan.pdf");
    writeFileSync(large, inventedPdf("large", 40_000_000));
    await stubFileDialog(app, [large]);
    await page.getByRole("button", { name: "Add PDF…" }).click();
    await expect(page.getByText("40 MB: too large for ChatGPT to read (it takes PDFs up to about 37.5 MB). Claude can read it. To use ChatGPT, paste the report's text instead.")).toBeVisible();
  } finally {
    rmSync(originals, { recursive: true, force: true });
  }
});

test("removing asks first, keeps the text and the file, and Undo or Restore brings it back", async ({ launch, home }) => {
  const { page, casesFolder, caseFolder } = await openSources(launch, home);
  await dropFiles(page, [{ name: "vineland-3.pdf", bytes: inventedPdf("Vineland-3") }]);
  const row = sourceRow(page, "vineland-3.pdf");
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove “vineland-3.pdf” from this case?" });
  await expect(confirm).toContainText("The PDF stays in the case's folder.");
  // Escape cancels: nothing changes.
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Remove" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("“vineland-3.pdf” was removed from the case.")).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeFocused();
  expect(readdirSync(caseFolder)).toContain("vineland-3.pdf");
  expect(caseData(casesFolder).sources[0].removedAt).toEqual(expect.any(String));
  await page.keyboard.press("Enter");
  await expect(page.getByText("“vineland-3.pdf” is a source again.")).toBeVisible();
  await expect(row).toBeVisible();
  expect(caseData(casesFolder).sources[0].removedAt).toBeUndefined();

  // Removed again: it waits under Removed sources, and Restore brings it back.
  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await page.getByText("Removed sources (1)").click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(sourceRow(page, "vineland-3.pdf").getByRole("button", { name: "Remove" })).toBeVisible();
  expect(readdirSync(caseFolder).sort()).toEqual(["aba-case.json", "vineland-3.pdf"]);
});

test("details: rename, retype and date a source from the keyboard; PDFs put in the folder can be added", async ({ launch, home }) => {
  const { app, page, caseFolder, casesFolder } = await openSources(launch, home);
  writeFileSync(path.join(caseFolder, "iep 2026.pdf"), inventedPdf("IEP"));
  // Opening the case again finds the PDF put in its folder.
  await goTo(page, "/");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources`);
  await expect(page.getByRole("heading", { name: "Also in this case's folder" })).toBeVisible();
  await page.getByRole("button", { name: "Add as a source" }).click();
  const row = sourceRow(page, "iep 2026.pdf");
  await expect(row).toContainText("IEP");
  await expect(page.getByRole("heading", { name: "Also in this case's folder" })).toBeHidden();

  await row.getByRole("button", { name: "Name, type and date" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Name, type and date: “iep 2026.pdf”" })).toBeVisible();
  // Its name follows the title as it is saved.
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title (optional)" }).fill("School IEP");
  await dialog.getByRole("combobox", { name: "Type" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Other" }).click();
  await dialog.getByLabel("Date (optional)").fill("2026-09-15");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const renamed = sourceRow(page, "School IEP");
  await expect(renamed).toContainText("Other");
  await expect(renamed).toContainText("Sep 15, 2026");
  await expect.poll(() => caseData(casesFolder).sources[0]).toMatchObject({ title: "School IEP", type: "other", date: "2026-09-15", file: "iep 2026.pdf" });
  // The file keeps its name on disk.
  expect(readdirSync(caseFolder).sort()).toEqual(["aba-case.json", "iep 2026.pdf"]);
  await app.close();
});

test("in Spanish and at a narrow window: the step fits, and the clinical terms stay English", async ({ launch, home }) => {
  const { app, page, casesFolder } = await openSources(launch, home, "es");
  await resize(app, 520, 760);
  await expect(page.getByRole("heading", { name: "Agrega las fuentes de este cliente" })).toBeVisible();
  await screenshot(page, "sources-empty-es-narrow");
  await page.getByRole("button", { name: "Pegar texto" }).click();
  await expect(page.getByRole("menuitem", { name: "Parent interview" })).toHaveAttribute("lang", "en");
  await page.getByRole("menuitem", { name: "Direct observation" }).click();
  await expect(heading(page)).toHaveText("Nuevo texto pegado");
  await page.getByRole("textbox", { name: "Texto" }).fill("Notas inventadas de una observación directa.");
  await expect(page.getByText("Todos los cambios guardados").first()).toBeVisible();
  await page.getByRole("link", { name: "Volver a las fuentes" }).click();
  await expect(heading(page)).toHaveText("Fuentes");
  await dropFiles(page, [{ name: "basc-3.pdf", bytes: inventedPdf("BASC-3") }]);
  await expect(page.getByText("Se agregó 1 PDF.")).toBeVisible();
  await expect(sourceRow(page, "Direct observation")).toContainText("Texto pegado · 44 caracteres");
  // Nothing spills sideways.
  const overflow = await page.evaluate(() => {
    const { document } = globalThis as unknown as { document: { querySelector(selector: string): { parentElement: { scrollWidth: number; clientWidth: number } } } };
    const scroller = document.querySelector("main").parentElement;
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  await screenshot(page, "sources-list-es-narrow");
  await resize(app, 1280, 820);
  await screenshot(page, "sources-list-es");
  expect(caseData(casesFolder).sources).toHaveLength(2);
});

test("the sources functions refuse hostile input with messages that hold no path", async ({ launch, home }) => {
  const { page, casesFolder } = await openSources(launch, home);
  const before = readFileSync(path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json"), "utf8");
  const errors = await page.evaluate(async (caseId) => {
    const aba = (globalThis as unknown as { aba: Record<string, (...args: unknown[]) => Promise<unknown>> }).aba;
    const attempts: Array<() => Promise<unknown>> = [
      () => aba.addTextSource("../x", { type: "cde", text: "x" }),
      () => aba.addTextSource(caseId, { type: "made-up", text: "x" }),
      () => aba.addTextSource(caseId, { type: "cde", text: "x", extra: 1 }),
      () => aba.addTextSource(caseId, { type: "cde", text: "x".repeat(2_000_001) }),
      () => aba.addTextSource(caseId, { type: "cde", title: "a\nb", text: "x" }),
      () => aba.addTextSource(caseId, { type: "cde", date: "2026-02-30", text: "x" }),
      () => aba.changeSource(caseId, "not-an-id", { title: "x" }),
      () => aba.changeSource(caseId, "5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a11", {}),
      () => aba.addFolderPdf(caseId, "../aba-case.json"),
      () => aba.addDroppedPdf(caseId, { name: "x.pdf", data: "not bytes" }),
      () => aba.readSourceText(caseId, "../../etc/passwd"),
      () => aba.openSourcePdf(caseId, "/etc/passwd"),
    ];
    const messages: string[] = [];
    for (const attempt of attempts) {
      try {
        await attempt();
        messages.push("accepted");
      } catch (error) {
        messages.push(String((error as Error).message));
      }
    }
    return messages;
  }, SAMPLE_CASE.id);
  for (const message of errors) {
    expect(message).toMatch(/Refused:/);
    expect(message).not.toContain(home);
  }
  // Nothing was written.
  expect(readFileSync(path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json"), "utf8")).toBe(before);
});

/** Pastes a new text of a type and waits until it is saved; returns the text area. */
async function newText(page: Page, type: string, text: string) {
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByRole("menuitem", { name: type }).click();
  const area = page.getByRole("textbox", { name: "Text" });
  await area.fill(text);
  await expect(page.getByText("All changes saved").first()).toBeVisible();
  return area;
}

/** Replaces the system's message box: records what it would say and answers with `response`. */
async function stubMessageBox(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, answer) => {
    const shown: string[] = [];
    (globalThis as unknown as { messages: string[] }).messages = shown;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string };
      shown.push(options.message);
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
  return () => app.evaluate(() => [...(globalThis as unknown as { messages: string[] }).messages]);
}

test("pasting first, then giving the title, type and date: nothing is lost and the focus stays (review B1)", async ({ launch, home }) => {
  const { page, casesFolder } = await openSources(launch, home);
  await page.getByRole("button", { name: "Paste text" }).click();
  await page.getByRole("menuitem", { name: "Parent interview" }).click();
  await page.getByRole("textbox", { name: "Text" }).fill("Invented interview notes.");
  // Straight to the title, while the new text is being created.
  const title = page.getByRole("textbox", { name: "Title (optional)" });
  await title.click();
  await title.pressSequentially("Mom interview");
  await expect(title).toHaveValue("Mom interview");
  await expect(title).toBeFocused();
  await page.getByLabel("Date (optional)").fill("2026-10-05");
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "CDE" }).click();
  await expect(heading(page)).toHaveText("Mom interview");
  await expect.poll(() => caseData(casesFolder).sources).toEqual([
    expect.objectContaining({ kind: "text", type: "cde", title: "Mom interview", date: "2026-10-05", text: "Invented interview notes." }),
  ]);
});

test("quitting right after typing keeps what was typed, in a text and in a title (review B2)", async ({ launch, home }) => {
  const first = await openSources(launch, home);
  const { casesFolder } = first;
  let { app, page } = first;
  const area = await newText(page, "CDE", "First part.");
  await area.press("ControlOrMeta+End");
  await area.pressSequentially(" Second part.");
  // Quit within the typing pause, as Cmd+Q or closing the last window on Windows would.
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
  expect(caseData(casesFolder).sources[0].text).toBe("First part. Second part.");

  app = await launch();
  page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources`);
  await sourceRow(page, "CDE").getByRole("button", { name: "Name, type and date" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Title (optional)" }).fill("Psychologist's CDE");
  const closedAgain = app.waitForEvent("close");
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await closedAgain;
  expect(caseData(casesFolder).sources[0].title).toBe("Psychologist's CDE");
});

test("closing the window right after typing keeps what was typed (review B2)", async ({ launch, home }) => {
  const { app, page, casesFolder } = await openSources(launch, home);
  const area = await newText(page, "IEP", "Goals.");
  await area.press("ControlOrMeta+End");
  await area.pressSequentially(" More goals.");
  const closed = page.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  expect(caseData(casesFolder).sources[0].text).toBe("Goals. More goals.");
});

test("a change that cannot be saved is said before the window closes, and on Home after leaving the case (review B2, S2)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFolder } = await openSources(launch, home);
  const area = await newText(page, "CDE", "Saved part.");
  chmodSync(caseFolder, 0o555);
  try {
    // Leaving the case at once: the failure is shown on Home.
    await area.press("ControlOrMeta+End");
    await area.pressSequentially(" Lost part.");
    await page.getByRole("link", { name: "All cases" }).click();
    await expect(heading(page)).toHaveText("Cases");
    await expect(page.getByText("A change to “M.F. sample case” could not be saved.")).toBeVisible();
    await page.getByRole("link", { name: "Open the case to try again" }).click();
    await expect(page.getByText("Your last change could not be saved. Check that the cases folder is available, then try again.")).toBeVisible();

    // Closing now asks; Go back keeps the window.
    const messages = await stubMessageBox(app, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(messages).toEqual(["A change could not be saved"]);
    await expect(heading(page)).toHaveText("Sources");

    // The folder is writable again: Try again saves it, and the window closes without asking.
    chmodSync(caseFolder, 0o755);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("All changes saved").first()).toBeVisible();
    expect(caseData(path.dirname(caseFolder)).sources[0].text).toBe("Saved part. Lost part.");
    const closed = page.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    expect(await messages()).toEqual(["A change could not be saved"]);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("opening a source never hands the system a file that is not a PDF of the case (review S1)", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  const caseFolder = seedCase(casesFolder, SAMPLE_CASE.label, {
    ...SAMPLE_CASE,
    schemaVersion: 2,
    sources: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", kind: "pdf", type: "other", addedAt: SAMPLE_CASE.createdAt, updatedAt: SAMPLE_CASE.createdAt, file: "report.command", bytes: 20 },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", kind: "pdf", type: "other", addedAt: SAMPLE_CASE.createdAt, updatedAt: SAMPLE_CASE.createdAt, file: "fake.pdf", bytes: 20 },
    ],
  });
  writeFileSync(path.join(caseFolder, "report.command"), "#!/bin/sh\necho invented\n");
  writeFileSync(path.join(caseFolder, "fake.pdf"), "#!/bin/sh\necho invented\n");
  const app = await launch();
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  await app.evaluate(({ shell }) => {
    const seen: string[] = [];
    (globalThis as unknown as { opened: string[] }).opened = seen;
    shell.openPath = async (item: string) => {
      seen.push(item);
      return "";
    };
  });
  const answers = await page.evaluate(async (caseId) => {
    const aba = (globalThis as unknown as { aba: Record<string, (...args: unknown[]) => Promise<unknown>> }).aba;
    await aba.openCase(caseId);
    return [await aba.openSourcePdf(caseId, "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"), await aba.openSourcePdf(caseId, "aaaaaaaa-aaaa-4aaa-8aaa-000000000002")];
  }, SAMPLE_CASE.id);
  expect(answers).toEqual([false, false]);
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([]);
});

/** Reloads the window as the View menu's Reload or Force Reload does. */
async function reloadWindow(app: ElectronApplication, page: Page, force = false) {
  await app.evaluate(({ BrowserWindow }, ignoringCache) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (ignoringCache) contents.reloadIgnoringCache();
    else contents.reload();
  }, force);
  await page.waitForEvent("load");
  await expect(heading(page)).toBeVisible();
}

test("a reload or a force reload right after typing keeps what was typed (review round 2, R1)", async ({ launch, home }) => {
  const { app, page, casesFolder } = await openSources(launch, home);
  const area = await newText(page, "CDE", "First part.");
  await area.press("ControlOrMeta+End");
  await area.pressSequentially(" Typed before reload.");
  await reloadWindow(app, page);
  await expect.poll(() => caseData(casesFolder).sources[0].text).toBe("First part. Typed before reload.");
  // The reload comes back to the same text.
  const again = page.getByRole("textbox", { name: "Text" });
  await expect(again).toHaveValue("First part. Typed before reload.");
  await again.focus();
  // The caret at the end (Cmd+End does not move it in a macOS text area).
  await again.evaluate((field) => {
    const area = field as unknown as { value: string; setSelectionRange(start: number, end: number): void };
    area.setSelectionRange(area.value.length, area.value.length);
  });
  await again.pressSequentially(" And before force reload.");
  await reloadWindow(app, page, true);
  await expect.poll(() => caseData(casesFolder).sources[0].text).toBe("First part. Typed before reload. And before force reload.");
});

test("a change that could not be saved is still reported after a reload, and Try again then saves it (review round 2, R1)", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFolder, casesFolder } = await openSources(launch, home);
  const area = await newText(page, "CDE", "Saved part.");
  chmodSync(caseFolder, 0o555);
  try {
    await area.press("ControlOrMeta+End");
    await area.pressSequentially(" Kept after reload.");
    await page.getByRole("link", { name: "All cases" }).click();
    const notice = page.getByText("A change to “M.F. sample case” could not be saved.");
    await expect(notice).toBeVisible();
    await reloadWindow(app, page);
    // The page starts again with nothing in memory: the main process still knows.
    await expect(notice).toBeVisible();
    await page.getByRole("link", { name: "Open the case to try again" }).click();
    await expect(page.getByText("Your last change could not be saved. Check that the cases folder is available, then try again.")).toBeVisible();
    chmodSync(caseFolder, 0o755);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("All changes saved").first()).toBeVisible();
    expect(caseData(casesFolder).sources[0].text).toBe("Saved part. Kept after reload.");
    await page.getByRole("link", { name: "All cases" }).click();
    await expect(notice).toBeHidden();
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});

test("the packaged app's menu has no Reload or developer tools, and keeps Edit (owner's decision)", async ({ app }, testInfo) => {
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  const menu = await app.evaluate(({ Menu }) => {
    const roles: string[] = [];
    const accelerators: string[] = [];
    const walk = (items: Electron.MenuItem[]) => {
      for (const item of items) {
        if (item.role) roles.push(String(item.role).toLowerCase());
        if (item.accelerator) accelerators.push(String(item.accelerator));
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return { roles, accelerators };
  });
  for (const role of ["copy", "paste", "cut", "undo", "selectall"]) expect(menu.roles).toContain(role);
  const developmentOnly = ["reload", "forcereload", "toggledevtools"];
  if (testInfo.project.name === "packaged") {
    for (const role of developmentOnly) expect(menu.roles).not.toContain(role);
    expect(menu.accelerators.filter((key) => /\+R$/i.test(key))).toEqual([]);
    if (process.platform === "darwin") expect(menu.roles).toContain("about");
  } else {
    // A development build keeps them.
    for (const role of developmentOnly) expect(menu.roles).toContain(role);
  }
});
