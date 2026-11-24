import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { chmodSync } from "node:fs";
import type { AbaApi } from "../src/shared/api.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import { defaultCasesFolder, expect, firstScreen, goTo, resize, SAMPLE_CASE, seedCase, stubDrafting, test } from "./app.ts";

/*
 * Small windows and polish (UX-8): the rail as a panel below 1024 px with the count of open
 * checks (owner's decision T2), a header of one row that never wraps from 1024 px, the focus
 * ring only after keyboard input (L11), today's notes from a narrow window, and the 1366x768
 * and 1366x690 checks (layout rules 2 and 8). Claude is faked inside the main process
 * (stubDrafting): nothing leaves the computer, and every text is invented.
 */

const CLAUDE_KEY = "sk-ant-api03-e2e-key-not-real-000000000000";
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const rail = (page: Page) => page.locator("[data-region='rail']");
const railToggle = (page: Page) => page.getByTestId("rail-toggle");
const header = (page: Page) => page.getByRole("main").locator("header");

const SOURCE = {
  id: "0d3c6a52-8a3e-4b8f-9d0e-6c1f2a7b5e44",
  kind: "text",
  type: "cde",
  title: "CDE, psychologist's report from the developmental clinic, with the scores of the second visit (invented)",
  addedAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  text: "Invented CDE notes for a child who does not exist. Single-word requests; pulls an adult to the refrigerator.",
};

/** Four paragraphs of hers, about 90 words each. */
const LONG = Array.from(
  { length: 4 },
  (_, index) =>
    `Paragraph ${index + 1} of an invented section. Sofia is a 7-year-old girl who lives with her mother and grandmother; Spanish is the main language at home, and she understands both Spanish and English. The family reports that mornings and bedtime are the hardest parts of the day, when transitions between activities happen quickly and without warning, and that waiting for preferred items is still hard for her at home, at school and in the community.`,
).join("\n\n");

/** The DOM shape the sidebar's measure reads inside the page (the e2e files have no DOM types). */
interface Box {
  top: number;
  bottom: number;
}
interface PageNode {
  parentElement: PageNode | null;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): Box;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<PageNode>;
}

const aba = <T>(page: Page, name: keyof AbaApi, ...args: unknown[]) =>
  page.evaluate(([fn, list]) => (globalThis as unknown as { aba: Record<string, (...x: unknown[]) => Promise<unknown>> }).aba[fn as string](...(list as unknown[])) as Promise<T>, [name, args] as const);

/** Seeds the invented case (one pasted document), starts the app with Claude faked and connected. */
async function start(launch: (options?: { language?: "en" | "es" }) => Promise<ElectronApplication>, home: string, language: "en" | "es", data: Record<string, unknown> = {}) {
  const casesFolder = defaultCasesFolder(home);
  const caseFolder = seedCase(casesFolder, SAMPLE_CASE.label, { ...SAMPLE_CASE, sources: [SOURCE], ...data });
  const app = await launch({ language });
  await stubDrafting(app, { claudeKey: CLAUDE_KEY, consistency: "- Background Information says she lives with her mother and grandmother; this version says she lives with both parents." });
  const page = await firstScreen(app);
  expect(await aba(page, "saveClaudeKey", CLAUDE_KEY)).toEqual({ outcome: "saved" });
  return { app, page, caseFolder };
}

/**
 * Resizes the window and waits for the page to have that size. A runner's screen can be
 * smaller than the window asked for (1024x768 on some): the test is skipped there, since
 * what it measures is the size itself.
 */
async function sized(app: ElectronApplication, page: Page, width: number, height: number) {
  await resize(app, width, height);
  const inner = () => page.evaluate(() => ({ width: (globalThis as unknown as { innerWidth: number }).innerWidth, height: (globalThis as unknown as { innerHeight: number }).innerHeight }));
  await expect.poll(async () => (await inner()).width, { timeout: 5_000 }).toBeLessThanOrEqual(width);
  const got = await inner();
  test.skip(got.width !== width || got.height !== height, `the screen gives a ${got.width}x${got.height} window, not ${width}x${height}`);
}

/** Whether the element's computed outline is drawn (the focus ring). */
const ringOn = (locator: Locator) =>
  locator.evaluate((element) => (globalThis as unknown as { getComputedStyle(element: unknown): { outlineStyle: string } }).getComputedStyle(element).outlineStyle !== "none");

/** The sidebar's scrolling list, measured: its content and its box. */
async function sidebarList(page: Page) {
  return page.getByRole("navigation", { name: /^(Steps of the case|Pasos del caso)$/ }).evaluate((element) => {
    const nav = element as unknown as PageNode;
    const style = (node: PageNode) => (globalThis as unknown as { getComputedStyle(element: unknown): { overflowY: string } }).getComputedStyle(node);
    let list: PageNode | null = nav;
    while (list && !/(auto|scroll)/.test(style(list).overflowY)) list = list.parentElement;
    const box = (list ?? nav).getBoundingClientRect();
    const review = [...nav.querySelectorAll("a")].find((link) => link.getAttribute("href")?.endsWith("/review"));
    return { scroll: list ? list.scrollHeight : 0, client: list ? list.clientHeight : 0, reviewInView: review ? review.getBoundingClientRect().bottom <= box.bottom + 0.5 : false };
  });
}

test("below 1024 px the rail is a panel opened from the header, which says the open checks (T2)", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "es");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/medical-necessity`);
  await page.getByRole("button", { name: "Redactar con la IA" }).click();
  await expect(page.getByTestId("section-checks")).toContainText("Contradice tus secciones", { timeout: 20_000 });

  // From 1024 px: the rail beside the text, the chip and the version menu in the header, no button.
  await sized(app, page, 1024, 700);
  await expect(railToggle(page)).toHaveCount(0);
  await expect(header(page).getByTestId("version-menu")).toBeVisible();
  const [content, beside] = [await page.locator("[data-region='content']").boundingBox(), await rail(page).boundingBox()];
  expect(beside!.x).toBeGreaterThanOrEqual(content!.x + content!.width - 1);
  expect((await header(page).boundingBox())!.height).toBe(64);

  // Below it: the rail is hidden, and "Revisión" with the count of open checks joins the header's actions.
  await sized(app, page, 1000, 700);
  await expect(rail(page)).toBeHidden();
  await expect(railToggle(page)).toHaveAccessibleName(/^Revisión\s*,\s*[1-9]\d* por revisar$/);
  await expect(railToggle(page)).toHaveAttribute("aria-expanded", "false");
  // The header keeps one row of 64 px: the chip and the version menu move to the top of the content.
  expect((await header(page).boundingBox())!.height).toBe(64);
  await expect(page.locator("[data-region='header-extras']").getByTestId("version-menu")).toBeVisible();
  await expect(header(page).getByTestId("version-menu")).toHaveCount(0);

  // Opened, the focus goes into the panel; Escape closes it and gives the focus back to the button.
  await railToggle(page).click();
  await expect(railToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(rail(page)).toHaveAttribute("data-panel", "open");
  await expect(rail(page)).toBeFocused();
  await expect(rail(page)).toContainText("Contradice tus secciones");
  await expect(railToggle(page)).toHaveAttribute("aria-controls", (await rail(page).getAttribute("id"))!);
  await page.keyboard.press("Escape");
  await expect(rail(page)).toBeHidden();
  await expect(railToggle(page)).toBeFocused();

  // "Cerrar" and a press outside close it too.
  await railToggle(page).click();
  await rail(page).getByTestId("rail-close").click();
  await expect(rail(page)).toBeHidden();
  await railToggle(page).click();
  await expect(rail(page)).toBeVisible();
  await heading(page).click();
  await expect(rail(page)).toBeHidden();

  // A navigation starts with it closed, and a wider window puts it beside the content again.
  await railToggle(page).click();
  await expect(rail(page)).toBeVisible();
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/crisis-plan`);
  await expect(heading(page)).toHaveText("Crisis Plan");
  await expect(rail(page)).toBeHidden();
  await railToggle(page).click();
  await expect(rail(page)).toHaveAttribute("data-panel", "open");
  await resize(app, 1280, 820);
  await expect(railToggle(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  await expect(rail(page)).not.toHaveAttribute("data-panel", /.*/);

  // A screen with no rail has no button.
  await resize(app, 1000, 700);
  await goTo(page, "/");
  await expect(heading(page)).toHaveText("Casos");
  await expect(railToggle(page)).toHaveCount(0);
});

test("the header keeps one row from 1024 px down, its long title cut with the whole title as a tooltip", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "en");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/sources/text/${SOURCE.id}`);
  await expect(heading(page)).toHaveText(SOURCE.title);
  for (const [width, height] of [
    [1366, 768],
    [1024, 700],
    [1000, 700],
  ] as const) {
    await resize(app, width, height);
    await expect.poll(() => header(page).evaluate((element) => Math.round(element.getBoundingClientRect().height)), { message: `${width}x${height}` }).toBe(64);
    // Cut, and the whole title is its tooltip once the pointer is on it.
    expect(await heading(page).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.mouse.move(1, 1);
    await heading(page).hover();
    await expect(heading(page)).toHaveAttribute("title", SOURCE.title);
    // The buttons sit on the title's row.
    const [title, back] = [await heading(page).boundingBox(), await page.getByRole("link", { name: "Back to documents" }).boundingBox()];
    expect(Math.abs(title!.y + title!.height / 2 - (back!.y + back!.height / 2))).toBeLessThan(16);
  }
});

test("the focus ring shows after keyboard input only, and a navigation still puts the focus on the title (L11)", async ({ launch, home }) => {
  const { page } = await start(launch, home, "en");
  await goTo(page, `/cases/${SAMPLE_CASE.id}`);
  await expect(heading(page)).toHaveText("Case summary");
  // By mouse: the focus is on the new screen's title, with no ring around it.
  await page.getByRole("link", { name: "All cases" }).click();
  await expect(heading(page)).toHaveText("Cases");
  await expect(heading(page)).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-input", "pointer");
  expect(await ringOn(heading(page))).toBe(false);
  // By keyboard: the same navigation draws the ring, on the title and on every stop after it.
  await page.getByTestId("case-name").first().focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Case summary");
  await expect(heading(page)).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-input", "keyboard");
  expect(await ringOn(heading(page))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await ringOn(page.locator(":focus"))).toBe(true);
  // A Shift-click is a click: no ring after it.
  await page.keyboard.down("Shift");
  await heading(page).click();
  await page.keyboard.up("Shift");
  await expect(page.locator("html")).toHaveAttribute("data-input", "pointer");
});

test("today's notes: the button says what it opens, and closed from a narrow window the focus goes back to the Menu button", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "en");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/crisis-plan`);
  const button = page.getByTestId("notes-open");
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  const panel = page.getByRole("dialog", { name: "Today's notes" });
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();

  // From the Menu panel, which closes as the notes open: the focus goes back to the Menu button.
  await resize(app, 700, 760);
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  await page.getByRole("dialog", { name: "Navigation" }).getByTestId("notes-open").click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
  await expect(page.getByTestId("session-notes")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-notes")).toBeHidden();
  await expect(menu).toBeFocused();
});

test("notes that could not be saved are said on a narrow window's bar, which opens them", async ({ launch, home }) => {
  test.skip(process.platform === "win32", "a read-only folder is made with POSIX permissions");
  const { app, page, caseFolder } = await start(launch, home, "es");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/crisis-plan`);
  await resize(app, 700, 760);
  await expect(page.getByTestId("notes-unsaved-bar")).toHaveCount(0);
  await page.getByRole("button", { name: "Menú" }).click();
  await page.getByRole("dialog", { name: "Navegación" }).getByTestId("notes-open").click();
  const box = page.getByTestId("session-notes");
  chmodSync(caseFolder, 0o555);
  try {
    await box.fill("La mamá dice que la escuela ya aplica el plan (inventado).");
    await box.blur();
    await expect(page.getByRole("alert").filter({ hasText: /No se pudieron guardar tus notas/ }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("dialog", { name: "Notas de hoy" }).getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(box).toBeHidden();
    const bar = page.getByTestId("notes-unsaved-bar");
    await expect(bar).toHaveText("Notas de hoy sin guardar");
    await expect(bar).toHaveAttribute("aria-expanded", "false");
    await bar.click();
    await expect(box).toBeVisible();
    await expect(box).toHaveValue("La mamá dice que la escuela ya aplica el plan (inventado).");
  } finally {
    chmodSync(caseFolder, 0o755);
  }
  await page.getByRole("dialog", { name: "Notas de hoy" }).getByRole("button", { name: "Volver a intentar" }).click();
  await expect(page.getByTestId("notes-unsaved-bar")).toHaveCount(0);
});

test("at 1366x768 the sidebar fits the nine sections and Review and copy, with a case name on two lines", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "es", { label: "Sofía R. · evaluación inicial de la escuela de verano (inventado)" });
  for (const { id } of REPORT_SECTIONS) {
    const saved = await aba<{ outcome: string; section: { currentVersion: number } }>(page, "saveSectionText", SAMPLE_CASE.id, id, `${id}: an invented paragraph of hers.`, null);
    expect(saved.outcome).toBe("saved");
    await aba(page, "approveSection", SAMPLE_CASE.id, id, saved.section.currentVersion);
  }
  await sized(app, page, 1366, 768);
  await goTo(page, `/cases/${SAMPLE_CASE.id}/review`);
  await expect(heading(page)).toHaveText("Revisión y copia");
  await expect(page.getByRole("navigation", { name: "Secciones" }).getByRole("link")).toHaveCount(9);
  const list = await sidebarList(page);
  expect(list.scroll, `sidebar list ${list.scroll}/${list.client}`).toBeLessThanOrEqual(list.client + 1);
  expect(list.reviewInView).toBe(true);
  // A long title is one line, cut, with its whole title as a tooltip; a screen reader reads it whole.
  const discharge = page.getByRole("navigation", { name: "Secciones" }).getByRole("link", { name: /Discharge and Service Fading Plan/ });
  await expect(discharge).toBeVisible();
  const name = page.getByTestId("case-name-line");
  expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await name.hover();
  await expect(name).toHaveAttribute("title", "Sofía R. · evaluación inicial de la escuela de verano (inventado)");
});

test("at 1366x690 (a maximized window on a 1366x768 laptop) a section shows its request box and first two paragraphs", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "es");
  expect((await aba<{ outcome: string }>(page, "saveSectionText", SAMPLE_CASE.id, "background-information", LONG, null)).outcome).toBe("saved");
  await sized(app, page, 1366, 690);
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/background-information`);
  await expect(page.locator("#paragraph-4")).toBeAttached();
  const inView = await page.evaluate(() => {
    const { document: doc, innerHeight: height } = (globalThis as unknown as { document: { querySelector(selector: string): { getBoundingClientRect(): { top: number; bottom: number } } | null; getElementById(id: string): { getBoundingClientRect(): { bottom: number } } | null }; innerHeight: number });
    const content = doc.querySelector("[data-region='content']")!.getBoundingClientRect();
    const footer = doc.querySelector("[data-region='footer']")!.getBoundingClientRect();
    const bottom = (n: number) => doc.getElementById(`paragraph-${n}`)!.getBoundingClientRect().bottom;
    return { footer: footer.top >= 0 && footer.bottom <= height + 0.5, paragraphs: [1, 2].every((n) => bottom(n) <= content.bottom + 0.5) };
  });
  expect(inView).toEqual({ footer: true, paragraphs: true });
  await expect(page.getByRole("textbox", { name: /Pide cambios a la IA/ })).toBeInViewport();
});

test("the version menu works from the keyboard alone", async ({ launch, home }) => {
  const { page } = await start(launch, home, "en");
  await aba(page, "saveSectionText", SAMPLE_CASE.id, "crisis-plan", "First text of hers.", null);
  await aba(page, "saveSectionText", SAMPLE_CASE.id, "crisis-plan", "Second text of hers.", 1);
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/crisis-plan`);
  const menu = page.getByTestId("version-menu");
  await expect(menu).toContainText("Version 2 of 2");
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  const first = page.getByRole("menuitemradio", { name: /^v1 ·/ });
  for (let i = 0; i < 6 && !(await first.evaluate((element) => element === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toContainText("Version 1 of 2");
  await expect(page.getByTestId("section-view")).toContainText("First text of hers.");
});

test("at 1000x700 Home's rows keep their button on the case's line", async ({ launch, home }) => {
  const { app, page } = await start(launch, home, "es", { label: "Sofía R. · evaluación inicial (inventado)" });
  await sized(app, page, 1000, 700);
  await goTo(page, "/");
  const row = page.getByTestId("case-row").first();
  await expect(row).toBeVisible();
  const [name, action] = [await row.getByTestId("case-name").boundingBox(), await row.getByRole("link").last().boundingBox()];
  // The button starts on the name's line, to its right, not on a line of its own below it.
  expect(action!.x).toBeGreaterThan(name!.x + name!.width);
  expect(action!.y).toBeLessThan(name!.y + name!.height);
});
