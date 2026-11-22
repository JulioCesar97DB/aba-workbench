import { expect, test } from "./app.ts";

test("the app starts and shows the development check", async ({ app }) => {
  const page = await app.firstWindow();
  await expect(page).toHaveTitle("ABA Workbench");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ABA Workbench");
  await expect(page.getByText(/^Development check, version \d+\.\d+\.\d+\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run mock generation" })).toBeEnabled();
});

test("the interface has window.aba and no Node.js", async ({ app }) => {
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ABA Workbench");
  const seen = await page.evaluate(() => {
    // Runs in the interface. Typed by hand: the e2e code is compiled without DOM types.
    const inPage = globalThis as unknown as { aba: object; open(url: string): unknown; require?: unknown; process?: unknown };
    return {
      api: Object.keys(inPage.aba).sort(),
      require: typeof inPage.require,
      process: typeof inPage.process,
      popupBlocked: inPage.open("https://example.com") === null,
    };
  });
  expect(seen).toEqual({
    api: ["cancelGeneration", "getAppInfo", "onGenerationUpdate", "startMockGeneration"],
    require: "undefined",
    process: "undefined",
    popupBlocked: true,
  });
});

test("a mock generation streams to completion, with the rules found", async ({ app }) => {
  const page = await app.firstWindow();
  const status = page.getByText(/^Status:/);
  const output = page.locator("pre");

  await page.getByRole("button", { name: "Run mock generation" }).click();

  // Streaming: part of the text is on screen while the generation is still writing.
  await expect(output).toContainText("MOCK OUTPUT");
  await expect(status).toHaveText("Status: Writing");
  const partial = (await output.textContent()) ?? "";

  await expect(status).toHaveText(/^Status: Done \(\d+ output tokens\)$/, { timeout: 30_000 });
  const final = (await output.textContent()) ?? "";
  expect(final.length).toBeGreaterThan(partial.length);
  expect(final).toContain("Rules sent as the cached prefix");
  await expect(page.getByText(/^Rules: /)).toHaveText(/^Rules: assessment \S+, payer-florida-molina \S+, instruments \S+, section-medical-necessity \S+$/);
  await expect(page.getByRole("button", { name: "Run mock generation" })).toBeEnabled();
});
