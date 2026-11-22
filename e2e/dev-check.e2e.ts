import type { AbaApi, GenerationUpdate } from "../src/shared/api.ts";
import type { Page } from "@playwright/test";
import { expect, goTo, test } from "./app.ts";

/** window.aba inside the page; typed by hand because the e2e code has no DOM types. */
type InPage = { aba: AbaApi; crypto: { randomUUID(): string } };

/**
 * The development check is linked from the sidebar in development builds only; in a
 * packaged app it is still there, at #/dev-check, which these tests open directly.
 */
async function openDevCheck(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await goTo(page, "/dev-check");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Development check");
}

test("the development check is reachable, in English, at #/dev-check", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
  await expect(page).toHaveTitle("Development check · ABA Workbench");
  await expect(page.getByText(/^Development check, version \d+\.\d+\.\d+\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run mock generation" })).toBeEnabled();
});

test("the interface has window.aba and no Node.js", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
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
    api: [
      "cancelGeneration",
      "chooseCasesFolder",
      "createCase",
      "getAppInfo",
      "getCasesFolder",
      "getSettings",
      "listCases",
      "onGenerationUpdate",
      "openCase",
      "setLanguage",
      "showCasesFolder",
      "showUnreadableFolder",
      "startMockGeneration",
    ],
    require: "undefined",
    process: "undefined",
    popupBlocked: true,
  });
});

test("a mock generation streams to completion, with the rules found", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
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

test("a navigation the app blocks leaves the running generation alone", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
  // All in the page: Playwright would otherwise wait for a navigation that never finishes.
  const result = await page.evaluate(
    () =>
      new Promise<{ types: string[]; textBeforeBlock: number; urlAfter: string }>((resolve) => {
        const inPage = globalThis as unknown as InPage & { location: { href: string; assign(url: string): void } };
        const id = inPage.crypto.randomUUID();
        const types: string[] = [];
        let textBeforeBlock = 0;
        let blocked = false;
        const stop = inPage.aba.onGenerationUpdate((update) => {
          if (update.generationId !== id) return;
          types.push(update.event.type);
          if (update.event.type === "text" && !blocked) {
            textBeforeBlock++;
            blocked = true;
            // Each of these is blocked by the app (src/main/security.ts).
            inPage.location.href = "https://example.com/";
            inPage.location.assign("file:///etc/hosts");
          }
          if (update.event.type === "finished") {
            stop();
            resolve({ types, textBeforeBlock, urlAfter: inPage.location.href });
          }
        });
        void inPage.aba.startMockGeneration(id);
        // Without a "finished", show what did arrive rather than hang until the test times out.
        setTimeout(() => resolve({ types, textBeforeBlock, urlAfter: inPage.location.href }), 10_000);
      }),
  );
  expect(result.textBeforeBlock).toBe(1);
  expect(result.urlAfter).not.toMatch(/example\.com|^file:/);
  expect(result.types.filter((type) => type === "text").length).toBeGreaterThan(10);
  expect(result.types.slice(-2)).toEqual(["done", "finished"]);
});

test("a reload stops the running generation: nothing more arrives for it", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
  const oldId = await page.evaluate(async () => {
    const { aba, crypto } = globalThis as unknown as InPage;
    const id = crypto.randomUUID();
    await aba.startMockGeneration(id);
    return id;
  });
  // Mid-stream: the mock thinks for 0.3 s, then writes for about 2 s.
  await page.waitForTimeout(600);
  await page.reload();
  // The address is in the hash, so the reload comes back to the same screen.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Development check");

  // Listen for longer than the old generation would have taken to finish.
  const arrived = await page.evaluate(
    (id) =>
      new Promise<GenerationUpdate[]>((resolve) => {
        const { aba } = globalThis as unknown as InPage;
        const seen: GenerationUpdate[] = [];
        const stop = aba.onGenerationUpdate((update) => {
          if (update.generationId === id) seen.push(update);
        });
        setTimeout(() => {
          stop();
          resolve(seen);
        }, 3_000);
      }),
    oldId,
  );
  expect(arrived).toEqual([]);
});

test("a window runs at most two generations at once", async ({ app }) => {
  const page = await app.firstWindow();
  await openDevCheck(page);
  const results = await page.evaluate(async () => {
    const { aba, crypto } = globalThis as unknown as InPage;
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const settled = await Promise.allSettled(ids.map((id) => aba.startMockGeneration(id)));
    await Promise.all(ids.map((id) => aba.cancelGeneration(id)));
    return settled.map((result) => (result.status === "fulfilled" ? "started" : String(result.reason)));
  });
  expect(results.slice(0, 2)).toEqual(["started", "started"]);
  expect(results[2]).toMatch(/2 generations are already running in this window/);
});
