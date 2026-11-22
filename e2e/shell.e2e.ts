import type { ConsoleMessage, ElectronApplication, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import { expect, goTo, resize, test } from "./app.ts";

/*
 * The interface as a user meets it: the screens, the navigation, the language and the
 * layout. The tests start in English (a settings file written into the temporary
 * profile) unless they say otherwise.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

/** Everything the page logs from now on that mentions the content security policy. */
function watchPolicy(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

async function openApp(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await expect(heading(page)).toBeVisible();
  return page;
}

test("the app opens on Home, the empty list of cases, with what to do next", async ({ app }) => {
  const page = await openApp(app);
  await expect(heading(page)).toHaveText("Cases");
  await expect(page).toHaveTitle("Cases · ABA Workbench");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "No cases yet" })).toBeVisible();
  await expect(page.getByText(/Creating and opening cases arrives in the next version/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Preview a case" })).toBeVisible();

  // "New case" explains, in a dialog, that cases arrive next; Escape closes it and focus returns.
  const newCase = page.getByRole("button", { name: "New case" });
  await newCase.click();
  const dialog = page.getByRole("dialog", { name: "New case" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Creating cases arrives in the next version");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newCase).toBeFocused();
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

  // IBM Plex comes from the app's own files.
  const fonts = await page.evaluate(async () => {
    const doc = (globalThis as unknown as { document: { fonts: { ready: Promise<unknown>; check(font: string): boolean } } }).document;
    await doc.fonts.ready;
    return { sans: doc.fonts.check('16px "IBM Plex Sans"'), mono: doc.fonts.check('12px "IBM Plex Mono"') };
  });
  expect(fonts).toEqual({ sans: true, mono: true });

  // Popups (dialog, select, tooltip) render without inline styles the policy would block.
  await page.getByRole("button", { name: "New case" }).click();
  await page.keyboard.press("Escape");
  await goTo(page, "/settings");
  await page.getByRole("combobox", { name: "Language" }).click();
  await expect(page.getByRole("option", { name: "Español" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Base UI gives tooltips no role: the button's own name already says the same.
  await page.getByRole("button", { name: "Español" }).hover();
  await expect(page.locator('[data-slot="tooltip"]')).toHaveText("Español");
  await expect(page.locator('[data-slot="tooltip"]')).toBeVisible();
  expect(violations).toEqual([]);

  // The development check is linked in a development build only.
  const devLink = page.getByRole("link", { name: /Development check/ });
  if (testInfo.project.name === "packaged") await expect(devLink).toHaveCount(0);
  else await expect(devLink).toBeVisible();
});

test("the navigation reaches every screen", async ({ app }) => {
  const page = await openApp(app);

  await page.getByRole("link", { name: "Preview a case" }).click();
  await expect(heading(page)).toHaveText("Sources");
  await expect(page.getByText("Case preview · Step 1 of 5")).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Sources and checks" });
  await expect(rail).toContainText("No sources yet.");

  const steps = page.getByRole("navigation", { name: "Steps of the case" });
  const expected: Array<[string, string]> = [
    ["Behaviors", "Behaviors"],
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

  const sections = page.getByRole("navigation", { name: "Sections" });
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

  await goTo(page, "/cases/preview/report/no-such-section");
  await expect(heading(page)).toHaveText("Report");
  await goTo(page, "/cases/not-a-case/sources");
  await expect(heading(page)).toHaveText("This case was not found");
  await goTo(page, "/nowhere");
  await expect(heading(page)).toHaveText("This screen does not exist");
  await page.getByRole("link", { name: "Go to cases" }).click();
  await expect(heading(page)).toHaveText("Cases");
});

test("switching the language changes the screen and survives a restart", async ({ launch, profile }) => {
  let app = await launch();
  let page = await openApp(app);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Español" }).click();

  await expect(heading(page)).toHaveText("Ajustes");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("status")).toHaveText("Guardado. La aplicación se abrirá en Español la próxima vez.");
  await expect(page.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
  expect(JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8"))).toEqual({ version: 1, language: "es" });

  // Clinical terms and section names stay in English, marked as English.
  await goTo(page, "/cases/preview/behaviors");
  await expect(heading(page)).toHaveText("Behaviors");
  await expect(heading(page)).toHaveAttribute("lang", "en");
  await expect(page.getByText("Caso de muestra · Paso 2 de 5")).toBeVisible();
  const steps = page.getByRole("navigation", { name: "Pasos del caso" });
  await expect(steps.getByRole("link", { name: "Fuentes" })).toBeVisible();
  await expect(steps.locator('[lang="en"]')).toHaveText(["Behaviors", "Interventions"]);
  const sections = page.getByRole("navigation", { name: "Secciones" });
  await expect(sections.locator('[lang="en"]')).toHaveText(REPORT_SECTIONS.map((section) => section.title));
  await expect(page.getByRole("main").locator('[lang="en"]')).toHaveText("Behaviors");

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

test("a corrupt settings file does not stop the app, and the next change rewrites it", async ({ launch, profile }) => {
  const app = await launch({ settingsFile: "{ not json" });
  const page = await openApp(app);
  // The first-run language follows the system's, so either is right here.
  await expect(heading(page)).toHaveText(/^(Cases|Casos)$/);
  await goTo(page, "/settings");
  await page.getByRole("button", { name: "Español" }).click();
  await expect(heading(page)).toHaveText("Ajustes");
  expect(JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8"))).toEqual({ version: 1, language: "es" });
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

  // The first stop skips the sidebar.
  await page.keyboard.press("Tab");
  expect(await focused()).toEqual({ name: "Skip to content", outline: true });

  // Every stop on the way shows the focus ring.
  const stops: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const stop = await focused();
    expect(stop.outline, `focus ring on "${stop.name}"`).toBe(true);
    stops.push(stop.name);
  }
  expect(stops).toEqual(expect.arrayContaining(["Cases", "Settings", "English", "Español", "New case", "Preview a case", "Open Settings"]));

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

test("a narrow window: the sidebar becomes a Menu panel and nothing spills sideways", async ({ app }) => {
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
  for (const address of ["/", "/cases/preview/sources", "/cases/preview/report", "/cases/preview/report/discharge-and-service-fading-plan", "/settings"]) {
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
