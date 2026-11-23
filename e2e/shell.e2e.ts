import type { ConsoleMessage, ElectronApplication, Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AbaApi } from "../src/shared/api.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import { defaultCasesFolder, expect, firstScreen, goTo, resize, SAMPLE_CASE, seedCase, test } from "./app.ts";

/*
 * The interface as a user meets it: the screens, the navigation, the language and the
 * layout. The tests start in English (a settings file written into the temporary
 * profile) unless they say otherwise.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
/** The polite live region AppShell fills after each navigation. */
const announcement = (page: Page) => page.locator('p[aria-live="polite"]');

/** Clicks the language the screen is not in (the first-run language follows the system's). */
async function switchToOtherLanguage(page: Page): Promise<{ from: "en" | "es"; to: "en" | "es" }> {
  const from = (await page.locator("html").getAttribute("lang")) === "es" ? "es" : "en";
  const to = from === "es" ? "en" : "es";
  await page.getByRole("button", { name: to === "es" ? "Español" : "English" }).click();
  return { from, to };
}

/** Everything the page logs from now on that mentions the content security policy. */
function watchPolicy(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

async function openApp(app: ElectronApplication): Promise<Page> {
  return firstScreen(app);
}

test("the app opens on Home, the empty list of cases, with what to do next", async ({ app }) => {
  const page = await openApp(app);
  await expect(heading(page)).toHaveText("Cases");
  await expect(page).toHaveTitle("Cases · ABA Workbench");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "No cases yet" })).toBeVisible();
  await expect(page.getByText(/Choose New case to make your first one/)).toBeVisible();

  // "New case" opens its form; Escape closes it and focus returns.
  const newCase = page.getByRole("button", { name: "New case" });
  await newCase.click();
  const dialog = page.getByRole("dialog", { name: "New case" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Label" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newCase).toBeFocused();
});

test("--hidden keeps the built app off the screen, with no Dock icon; the packaged app ignores it", async ({ app }, testInfo) => {
  await openApp(app);
  const shown = () =>
    app.evaluate(({ app: electronApp, BrowserWindow }) => ({
      window: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      dock: process.platform === "darwin" ? (electronApp.dock?.isVisible() ?? false) : null,
    }));
  if (testInfo.project.name === "packaged") {
    await expect.poll(async () => (await shown()).window).toBe(true);
    return;
  }
  // The page has painted (its heading is visible to the page), so a normal start would have shown the window by now.
  expect(await shown()).toEqual({ window: false, dock: process.platform === "darwin" ? false : null });
});

test("the interface loads under the content security policy as written, with its own fonts", async ({ app }, testInfo) => {
  const page = await openApp(app);
  const violations = watchPolicy(page);
  await page.reload();
  await expect(heading(page)).toHaveText("Cases");

  // The built and packaged page carries index.html's policy exactly: the dev server's nonce never reaches a build.
  const source = readFileSync(path.join(import.meta.dirname, "../src/renderer/index.html"), "utf8");
  const written = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(source)?.[1];
  expect(written).toContain("font-src 'self'");
  const served = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(served).toBe(written);
  expect(served).not.toContain("nonce");

  // IBM Plex comes from the app's own files. Fonts load when first used, so ask for each
  // face: the load goes through the policy (font-src 'self') like any other.
  const fonts = await page.evaluate(async () => {
    const doc = (globalThis as unknown as { document: { fonts: { load(font: string): Promise<unknown[]>; check(font: string): boolean } } }).document;
    const loaded = await Promise.all(['16px "IBM Plex Sans"', '600 16px "IBM Plex Sans"', '12px "IBM Plex Mono"'].map((font) => doc.fonts.load(font)));
    return { faces: loaded.map((faces) => faces.length > 0), sans: doc.fonts.check('16px "IBM Plex Sans"'), mono: doc.fonts.check('12px "IBM Plex Mono"') };
  });
  expect(fonts).toEqual({ faces: [true, true, true], sans: true, mono: true });

  // Popups (dialog, tooltip, select) render without inline styles the policy would block.
  await page.getByRole("button", { name: "New case" }).click();
  await page.keyboard.press("Escape");
  await goTo(page, "/settings");
  // The tooltip before the Select, never right after closing it: while a Select is mounted
  // (open, or still closing), Base UI covers the page with an invisible backdrop, and a
  // pointer that arrives while it is there gives the tooltip no mousemove, so it never
  // opens. Base UI gives tooltips no role: the button's own name already says the same.
  await page.getByRole("button", { name: "Español" }).hover();
  await expect(page.locator('[data-slot="tooltip"]')).toHaveText("Español");
  await expect(page.locator('[data-slot="tooltip"]')).toBeVisible();
  await page.getByRole("combobox", { name: "Language" }).click();
  await expect(page.getByRole("option", { name: "Español" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(violations).toEqual([]);

  // The fonts' license travels with them (SIL Open Font License 1.1, condition 2).
  if (testInfo.project.name === "packaged") {
    const resources = await app.evaluate(() => process.resourcesPath);
    const license = readFileSync(path.join(resources, "licenses", "IBM-Plex-OFL.txt"), "utf8");
    expect(license).toMatch(/^Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"/);
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }

  // The development check is linked in a development build only.
  const devLink = page.getByRole("link", { name: /Development check/ });
  if (testInfo.project.name === "packaged") await expect(devLink).toHaveCount(0);
  else await expect(devLink).toBeVisible();
});

test("the navigation reaches every screen", async ({ launch, home }) => {
  seedCase(defaultCasesFolder(home));
  const page = await openApp(await launch());

  await page.getByRole("link", { name: SAMPLE_CASE.label }).click();
  await expect(heading(page)).toHaveText("Sources");
  await expect(page.getByText(`${SAMPLE_CASE.label} · Step 1 of 5`)).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Sources and checks" });
  await expect(rail).toContainText("No sources yet.");

  const steps = page.getByRole("navigation", { name: "Steps of the case" });
  const expected: Array<[string, string]> = [
    ["Case map", "Case map"],
    ["Interventions", "Interventions"],
    ["Report", "Report"],
    ["Review and copy", "Review and copy"],
    ["Sources", "Sources"],
  ];
  for (const [link, title] of expected) {
    await steps.getByRole("link", { name: link }).click();
    await expect(heading(page)).toHaveText(title);
    await expect(steps.getByRole("link", { name: link })).toHaveAttribute("aria-current", "page");
  }

  // The report's sections are listed under its step while she is in the report.
  const sections = page.getByRole("navigation", { name: "Sections" });
  await expect(sections).toHaveCount(0);
  await steps.getByRole("link", { name: "Report" }).click();
  await expect(sections.getByRole("link")).toHaveCount(REPORT_SECTIONS.length);
  for (const section of REPORT_SECTIONS) {
    await sections.getByRole("link", { name: section.title }).click();
    await expect(heading(page)).toHaveText(section.title);
    // The report step stays current while one of its sections is shown.
    await expect(steps.getByRole("link", { name: "Report" })).toHaveAttribute("aria-current", "page");
  }

  // The report's own table reaches the sections too.
  await steps.getByRole("link", { name: "Report" }).click();
  await page.getByRole("main").getByRole("link", { name: "Crisis Plan" }).click();
  await expect(heading(page)).toHaveText("Crisis Plan");

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(heading(page)).toHaveText("Settings");
  await page.getByRole("link", { name: "Cases", exact: true }).click();
  await expect(heading(page)).toHaveText("Cases");

  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/no-such-section`);
  await expect(heading(page)).toHaveText("Report");
  await goTo(page, "/cases/not-a-case/sources");
  await expect(heading(page)).toHaveText("This case was not found");
  await goTo(page, "/nowhere");
  await expect(heading(page)).toHaveText("This screen does not exist");
  await page.getByRole("link", { name: "Go to cases" }).click();
  await expect(heading(page)).toHaveText("Cases");
});

test("switching the language changes the screen and survives a restart", async ({ launch, profile, home }, testInfo) => {
  seedCase(defaultCasesFolder(home));
  let app = await launch();
  let page = await openApp(app);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Español" }).click();

  await expect(heading(page)).toHaveText("Ajustes");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("region", { name: "Idioma de la pantalla" }).getByRole("status")).toHaveText("Guardado. La aplicación se abrirá en español la próxima vez.");
  // The switch reads ES EN, as in the reference.
  await expect(page.getByRole("group", { name: "Idioma de la pantalla" }).getByRole("button")).toHaveText(["ES", "EN"]);
  await expect(page.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
  const chosen = testInfo.project.name === "packaged" ? { casesFolder: defaultCasesFolder(home) } : {};
  expect(JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8"))).toEqual({ version: 1, language: "es", ...chosen });

  // The case map is named in the screen's language.
  await goTo(page, `/cases/${SAMPLE_CASE.id}/case-map`);
  await expect(heading(page)).toHaveText("Mapa del caso");
  await expect(page.getByText(`${SAMPLE_CASE.label} · Paso 2 de 5`)).toBeVisible();

  // Clinical terms and section names stay in English, marked as English.
  await goTo(page, `/cases/${SAMPLE_CASE.id}/interventions`);
  await expect(heading(page)).toHaveText("Interventions");
  await expect(heading(page)).toHaveAttribute("lang", "en");
  await expect(page.getByText(`${SAMPLE_CASE.label} · Paso 3 de 5`)).toBeVisible();
  // The age in Spanish words, under the case's label in the sidebar.
  await expect(page.getByText("4 años 2 meses")).toBeVisible();
  const steps = page.getByRole("navigation", { name: "Pasos del caso" });
  await expect(steps.getByRole("link", { name: "Fuentes" })).toBeVisible();
  await expect(steps.locator('[lang="en"]')).toHaveText(["Interventions"]);
  // The title and the sentence that names the step: both marked English.
  await expect(page.getByRole("main").locator('[lang="en"]')).toHaveText(["Interventions", "Interventions"]);
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report`);
  const sections = page.getByRole("navigation", { name: "Secciones" });
  await expect(sections.locator('[lang="en"]')).toHaveText(REPORT_SECTIONS.map((section) => section.title));

  await app.close();
  app = await launch();
  page = await openApp(app);
  await expect(heading(page)).toHaveText("Casos");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");

  // The sidebar's switch changes it back.
  await page.getByRole("button", { name: "English" }).click();
  await expect(heading(page)).toHaveText("Cases");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("a corrupt settings file does not stop the app, and the next change rewrites it", async ({ launch, profile }, testInfo) => {
  // Without a usable settings file the cases folder is the default one, which the packaged
  // app keeps in the real home folder: built app only.
  test.skip(testInfo.project.name === "packaged", "needs the default cases folder (built app only)");
  const app = await launch({ settingsFile: "{ not json" });
  const page = await openApp(app);
  // The first-run language follows the system's, so either is right here, and the test
  // switches to whichever is not shown.
  await expect(heading(page)).toHaveText(/^(Cases|Casos)$/);
  await goTo(page, "/settings");
  const { to } = await switchToOtherLanguage(page);
  await expect(heading(page)).toHaveText(to === "es" ? "Ajustes" : "Settings");
  expect(JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8"))).toEqual({ version: 1, language: to });
});

test("a language that cannot be saved still changes the screen, and the sidebar says it will not last", async ({ launch, profile }, testInfo) => {
  // No settings file can be read, so the cases folder is the default one: built app only (see above).
  test.skip(testInfo.project.name === "packaged", "needs the default cases folder (built app only)");
  // A folder where settings.json should be: the app reads the defaults and cannot save, on every system.
  const settingsPath = path.join(profile, "settings.json");
  mkdirSync(settingsPath);
  writeFileSync(path.join(settingsPath, "keep"), "");
  let app = await launch();
  let page = await openApp(app);
  const { from, to } = await switchToOtherLanguage(page);
  await expect(page.locator("html")).toHaveAttribute("lang", to);
  const message =
    to === "es"
      ? `Se muestra en español por ahora, pero no se pudo guardar: la próxima vez la aplicación se abrirá en ${from === "en" ? "inglés" : "español"}.`
      : `Shown in English for now, but the choice could not be saved: the app will open in ${from === "es" ? "Spanish" : "English"} next time.`;
  await expect(page.getByRole("status").filter({ hasText: message })).toBeVisible();
  // No temporary file is left next to it.
  expect(readdirSync(profile).filter((name) => name.startsWith("settings.json."))).toEqual([]);

  // Next start: the language that was saved before (here, the system's first-run one).
  await app.close();
  app = await launch();
  page = await openApp(app);
  await expect(page.locator("html")).toHaveAttribute("lang", from);
});

test("after two failed saves, the sidebar and Settings both name the language that was saved", async ({ launch, profile }) => {
  // The saved language is English; then the file cannot be replaced (a folder takes its place).
  const settingsPath = path.join(profile, "settings.json");
  const app = await launch();
  const page = await openApp(app);
  rmSync(settingsPath);
  mkdirSync(settingsPath);
  writeFileSync(path.join(settingsPath, "keep"), "");
  await goTo(page, "/settings");
  await expect(heading(page)).toHaveText("Settings");

  // First failure: Spanish on screen, English next time.
  await page.getByRole("button", { name: "Español" }).click();
  await expect(heading(page)).toHaveText("Ajustes");
  const notSaved = "Se muestra en español por ahora, pero no se pudo guardar: la próxima vez la aplicación se abrirá en inglés.";
  await expect(page.getByRole("status").filter({ hasText: notSaved })).toHaveCount(2);

  // Second failure, from Settings, back to English: English is what was saved, so nothing is pending.
  await page.getByRole("combobox", { name: "Idioma" }).click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(heading(page)).toHaveText("Settings");
  await expect(page.getByRole("status").filter({ hasText: /could not be saved|no se pudo guardar/ })).toHaveCount(0);

  // Third, to Spanish again from Settings: both places say English, the saved one, not the one on screen before.
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Español" }).click();
  await expect(heading(page)).toHaveText("Ajustes");
  await expect(page.getByRole("status").filter({ hasText: notSaved })).toHaveCount(2);
  await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toHaveCount(0);
});

test("moving into and out of a case announces the new screen and puts focus on its title", async ({ launch, home }) => {
  seedCase(defaultCasesFolder(home));
  const page = await openApp(await launch());

  // Home -> case: the link that was followed is gone, so focus goes to the new title.
  await page.getByRole("link", { name: SAMPLE_CASE.label }).click();
  await expect(heading(page)).toHaveText("Sources");
  await expect(announcement(page)).toHaveText("Sources · ABA Workbench");
  await expect(heading(page)).toBeFocused();

  // Inside the case the sidebar stays, and so does the focus, on the link followed.
  const caseMap = page.getByRole("navigation", { name: "Steps of the case" }).getByRole("link", { name: "Case map" });
  await caseMap.click();
  await expect(announcement(page)).toHaveText("Case map · ABA Workbench");
  await expect(caseMap).toBeFocused();

  // Case -> Settings, from the case's sidebar.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(heading(page)).toHaveText("Settings");
  await expect(announcement(page)).toHaveText("Settings · ABA Workbench");
  await expect(heading(page)).toBeFocused();

  // Into the case again and out through "All cases".
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report`);
  await expect(announcement(page)).toHaveText("Report · ABA Workbench");
  await page.getByRole("link", { name: "All cases" }).click();
  await expect(heading(page)).toHaveText("Cases");
  await expect(announcement(page)).toHaveText("Cases · ABA Workbench");
  await expect(heading(page)).toBeFocused();
});

test("the frame: the trial line is on every screen; the header and the rail stay put while a long section scrolls", async ({ launch, home }) => {
  seedCase(defaultCasesFolder(home));
  const app = await launch();
  const page = await openApp(app);
  // The rail sits beside the text from a working area 50rem wide. A runner's screen can be
  // smaller than the window asked for (1024x768 on some), so the page is zoomed out to give
  // it a working area that wide whatever the screen.
  await resize(app, 1280, 820);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(0.75));
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)).toBeGreaterThanOrEqual(1300);
  // One slim line above every screen, Home and Settings included.
  const trial = page.getByRole("complementary", { name: "Trial version" });
  await expect(trial).toContainText("Trial version.");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(heading(page)).toHaveText("Settings");
  await expect(trial).toBeVisible();

  // A long section of hers: only its text scrolls.
  const long = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} of an invented section, written long enough that the section needs scrolling to read it all.`).join("\n\n");
  const saved = await page.evaluate(([id, text]) => (globalThis as unknown as { aba: AbaApi }).aba.saveSectionText(id, "background-information", text, null), [SAMPLE_CASE.id, long] as const);
  expect(saved.outcome).toBe("saved");
  await goTo(page, `/cases/${SAMPLE_CASE.id}/report/background-information`);
  await expect(page.getByTestId("section-view")).toContainText("Paragraph 30");
  const header = page.getByRole("main").locator("header");
  const rail = page.getByRole("complementary", { name: "Sources and checks" });
  // The rail is beside the text, not below it.
  const [textBox, railBox] = [await page.getByTestId("section-view").boundingBox(), await rail.boundingBox()];
  expect(railBox!.x).toBeGreaterThan(textBox!.x + textBox!.width);
  const before = [await header.boundingBox(), await rail.boundingBox()];
  const content = page.locator("[data-region='content']");
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId("section-view")).toContainText("Paragraph 30");
  expect([await header.boundingBox(), await rail.boundingBox()]).toEqual(before);
  await expect(trial).toBeVisible();
});

test("everything works from the keyboard, with the focus always visible", async ({ app }) => {
  const page = await openApp(app);
  const focused = () =>
    page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { activeElement: { textContent: string | null; getAttribute(name: string): string | null } | null } }).document;
      const element = doc.activeElement;
      const style = (globalThis as unknown as { getComputedStyle(element: unknown): { outlineStyle: string; outlineWidth: string } }).getComputedStyle(element);
      return { name: element?.getAttribute("aria-label") ?? element?.textContent?.trim() ?? "", outline: style.outlineStyle !== "none" && style.outlineWidth !== "0px" };
    });

  // The first stop skips the sidebar and lands on the screen's title, inside <main>.
  await page.keyboard.press("Tab");
  expect(await focused()).toEqual({ name: "Skip to content", outline: true });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();

  // From the top again: every stop on the way shows the focus ring.
  await page.reload();
  await expect(heading(page)).toHaveText("Cases");
  await page.keyboard.press("Tab");

  // Every stop on the way shows the focus ring, up to the last control of the screen. How
  // many stops come first depends on the build (a development build also links the
  // development check), so it tabs until "Open Settings", with a cap.
  const stops: string[] = [];
  for (let i = 0; i < 14 && stops.at(-1) !== "Open Settings"; i++) {
    await page.keyboard.press("Tab");
    const stop = await focused();
    expect(stop.outline, `focus ring on "${stop.name}"`).toBe(true);
    stops.push(stop.name);
  }
  expect(stops).toEqual(expect.arrayContaining(["Cases", "Settings", "English", "Español", "What this means", "New case", "Open Settings"]));

  // A link opens with Enter; the Select opens and chooses with the arrow keys.
  await page.getByRole("link", { name: "Open Settings" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Settings");
  await page.getByRole("combobox", { name: "Language" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "Español" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Ajustes");
});

test("a narrow window: the sidebar becomes a Menu panel and nothing spills sideways", async ({ launch, home }) => {
  seedCase(defaultCasesFolder(home));
  const app = await launch();
  const page = await openApp(app);
  const overflows = () =>
    page.evaluate(() => {
      const root = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement;
      return root.scrollWidth > root.clientWidth;
    });

  await resize(app, 520, 760);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).click();
  const panel = page.getByRole("dialog", { name: "Navigation" });
  await expect(panel).toBeVisible();
  await panel.getByRole("link", { name: "Settings" }).click();
  await expect(panel).toBeHidden();
  await expect(heading(page)).toHaveText("Settings");
  expect(await overflows()).toBe(false);

  // Spanish strings are longer: the case workspace, in Spanish, still fits.
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Español" }).click();
  await page.getByRole("dialog", { name: "Navegación" }).getByRole("button", { name: "Cerrar el menú" }).click();
  // The panel slides out before it leaves the page.
  await expect(page.getByRole("dialog")).toBeHidden();
  const inCase = `/cases/${SAMPLE_CASE.id}`;
  for (const address of ["/", `${inCase}/sources`, `${inCase}/report`, `${inCase}/report/discharge-and-service-fading-plan`, "/settings"]) {
    await goTo(page, address);
    await expect(heading(page)).toBeVisible();
    expect(await overflows(), address).toBe(false);
  }
  await page.getByRole("button", { name: "Menú" }).click();
  const casePanel = page.getByRole("dialog", { name: "Navegación" });
  await expect(casePanel.getByRole("navigation", { name: "Pasos del caso" })).toHaveCount(0);
  await casePanel.getByRole("link", { name: "Casos" }).click();
  await expect(casePanel).toBeHidden();
  await expect(heading(page)).toHaveText("Casos");

  // Widening the window with the panel open closes it: the sidebar is back, the Menu button gone.
  await page.getByRole("button", { name: "Menú" }).click();
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeVisible();
  await resize(app, 1280, 820);
  await expect(page.getByRole("dialog", { name: "Navegación" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menú" })).toBeHidden();
});
