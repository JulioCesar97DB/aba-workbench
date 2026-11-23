import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import electronBinary from "electron";
import type { Language } from "../src/shared/api.ts";

const root = path.resolve(import.meta.dirname, "..");

/**
 * The executable `pnpm package` leaves in dist/ for this system: mac-arm64/ or mac/ on
 * macOS, win-unpacked/ (win-arm64-unpacked/) on Windows, linux-unpacked/ on Linux.
 */
function packagedExecutable(dist = path.join(root, "dist")): string {
  const candidates: string[] = [];
  for (const dir of existsSync(dist) ? readdirSync(dist) : []) {
    if (process.platform === "darwin" && /^mac/.test(dir)) candidates.push(path.join(dist, dir, "ABA Workbench.app", "Contents", "MacOS", "ABA Workbench"));
    if (process.platform === "win32" && /^win.*unpacked$/.test(dir)) candidates.push(path.join(dist, dir, "ABA Workbench.exe"));
    if (process.platform === "linux" && /^linux.*unpacked$/.test(dir)) candidates.push(path.join(dist, dir, "aba-workbench"));
  }
  const found = candidates.filter((file) => existsSync(file));
  if (found.length !== 1) throw new Error(`Expected one packaged app in ${dist}, found ${found.length}. Run \`pnpm package\` first.`);
  return found[0];
}

export interface LaunchOptions {
  /**
   * Written to the profile's settings file before the app starts, unless the profile
   * already has one (a restart keeps what the app saved). The default, "en", keeps the
   * tests independent of the machine's languages; null starts with no settings file.
   */
  language?: Language | null;
  /** Raw contents for the settings file instead (a corrupt file, say). */
  settingsFile?: string;
  /**
   * A cases folder chosen in Settings, written into the settings file with the language.
   * The packaged app, which never takes --home-folder, gets <home>/ABA Workbench (made
   * empty) when none is given, so it never falls back to the real home folder.
   */
  casesFolder?: string;
  /** More command-line options. */
  extraArgs?: string[];
}

interface Fixtures {
  /** A temporary profile (--user-data-dir), shared by every launch in the test and removed after it. */
  profile: string;
  /**
   * A temporary folder that stands in for the home folder. The built app takes it as its
   * home (--home-folder, development only), so its default cases folder is
   * <home>/ABA Workbench; the packaged app ignores that option and is given
   * <home>/ABA Workbench as its chosen cases folder instead. No test touches the real home folder.
   */
  home: string;
  /** Starts the app on the test's profile; call it again after closing to restart. */
  launch: (options?: LaunchOptions) => Promise<ElectronApplication>;
  /** The app, started once with the default options. */
  app: ElectronApplication;
}

/** The app under test, started with a temporary profile so a run leaves nothing behind. */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  profile: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-"));
    try {
      await use(userDataDir);
    } finally {
      // Windows can keep the profile's files locked for a moment after the app exits.
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use) => {
    const folder = mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-home-"));
    try {
      await use(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  launch: async ({ profile, home }, use, testInfo) => {
    const started: ElectronApplication[] = [];
    const packaged = testInfo.project.name === "packaged";
    await use(async ({ language = "en", settingsFile, casesFolder, extraArgs = [] }: LaunchOptions = {}) => {
      const settingsPath = path.join(profile, "settings.json");
      let chosen = casesFolder;
      if (packaged && chosen === undefined) {
        chosen = defaultCasesFolder(home);
        mkdirSync(chosen, { recursive: true });
      }
      if (settingsFile !== undefined) writeFileSync(settingsPath, settingsFile);
      else if (language !== null && !existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify({ version: 1, language, ...(chosen ? { casesFolder: chosen } : {}) }));
      const args = [`--user-data-dir=${profile}`, `--home-folder=${home}`, ...extraArgs];
      // Never point the window at a dev server.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
      const app =
        testInfo.project.name === "packaged"
          ? await electron.launch({ executablePath: packagedExecutable(), args, env })
          : await electron.launch({ args: [root, ...args], cwd: root, env });
      started.push(app);
      // The tests drive the window with Playwright's own input, sent straight to the page.
      // The computer's real pointer must not reach it: a person moving the mouse over a test
      // window (the windows open mid-screen) moves the hover the tests rely on, and closed a
      // tooltip a test was waiting for. Each window lets the real mouse pass through.
      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        const ignore = (window: Electron.BrowserWindow) => window.setIgnoreMouseEvents(true);
        BrowserWindow.getAllWindows().forEach(ignore);
        electronApp.on("browser-window-created", (_event, window) => ignore(window));
      });
      return app;
    });
    for (const app of started) await app.close().catch(() => undefined);
  },
  app: async ({ launch }, use) => {
    await use(await launch());
  },
});

/** The default cases folder for a test's home folder (in the packaged app, the chosen one: see LaunchOptions). */
export function defaultCasesFolder(home: string): string {
  return path.join(home, "ABA Workbench");
}

/** An invented case, as the app writes it. */
export const SAMPLE_CASE = {
  id: "5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10",
  label: "M.F. sample case",
  clientAge: { years: 4, months: 2 },
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

/** Writes a case's folder and data file into `casesFolder` (made if needed), before the app starts. */
export function seedCase(casesFolder: string, folderName = SAMPLE_CASE.label, data: Record<string, unknown> = SAMPLE_CASE): string {
  const folder = path.join(casesFolder, folderName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "aba-case.json"), JSON.stringify({ schemaVersion: 1, files: [], ...data }, null, 2));
  return folder;
}

/**
 * Replaces the system's folder dialog: the next choices return `folder` (null: the user
 * cancels). A test never sees a real dialog.
 */
export async function stubFolderDialog(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => (chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  }, folder);
}

/**
 * Replaces "Show in Finder / Explorer": records what would be shown instead of opening a
 * window. With `fail`, opening a folder answers as the system does when it cannot.
 */
export async function stubFileManager(app: ElectronApplication, { fail = false } = {}): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }, failing) => {
    const shown: string[] = [];
    (globalThis as unknown as { shownInFileManager: string[] }).shownInFileManager = shown;
    shell.showItemInFolder = (item: string) => {
      shown.push(item);
    };
    shell.openPath = async (item: string) => {
      shown.push(item);
      return failing ? "The folder could not be opened." : "";
    };
  }, fail);
  return () => app.evaluate(() => [...(globalThis as unknown as { shownInFileManager: string[] }).shownInFileManager]);
}

/**
 * Starts another copy of the app on the same profile, outside Playwright, and waits for it
 * to end: its exit code, or "still running" (it is then stopped) after `timeoutMs`.
 */
export async function startSecondCopy(project: string, profile: string, home: string, timeoutMs = 20_000): Promise<number | null | "still running"> {
  const args = [`--user-data-dir=${profile}`, `--home-folder=${home}`];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
  const child =
    project === "packaged"
      ? spawn(packagedExecutable(), args, { env, stdio: "ignore" })
      : spawn(electronBinary as unknown as string, [root, ...args], { cwd: root, env, stdio: "ignore" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("still running");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Shows a screen by its address (the part after #), as a link inside the app would. */
export async function goTo(page: Page, address: string): Promise<void> {
  await page.evaluate((hash) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = hash;
  }, address);
}

/** Resizes the window's content area. */
export async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
}

/** What the faked providers saw: the addresses the system browser was asked to open, and each request. */
export interface ConnectionStubLog {
  opened: string[];
  requests: Array<{ url: string; method: string; authorization: string | null; body: string | null }>;
}

/**
 * Replaces, inside the app's main process, every way out to the AI providers: the system
 * browser (shell.openExternal only records the address) and fetch, which answers
 * Anthropic's model list, OpenAI's sign-in endpoints and ChatGPT's model list from what the
 * test gives, and refuses anything else, so no test can reach a real provider. The ID
 * token the token endpoint returns is set by the test with setTokenAnswer, once it knows
 * the nonce the app sent.
 */
export async function stubConnections(app: ElectronApplication, options: { claudeKey: string; jwks: unknown }): Promise<void> {
  await app.evaluate(({ shell }, { claudeKey, jwks }) => {
    const g = globalThis as unknown as {
      connectionStub: { opened: string[]; requests: unknown[]; token: unknown; tokenStatus: number; claudeStatus: number | null; chatgptModelsStatus: number; revokeStatus: number };
      fetch: typeof fetch;
    };
    g.connectionStub = { opened: [], requests: [], token: null, tokenStatus: 200, claudeStatus: null, chatgptModelsStatus: 200, revokeStatus: 200 };
    const stub = g.connectionStub;
    shell.openExternal = async (url: string) => {
      stub.opened.push(url);
    };
    g.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? headers.get("x-api-key");
      stub.requests.push({ url, method: init?.method ?? "GET", authorization, body: typeof init?.body === "string" ? init.body : null });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        const key = (authorization ?? "").replace(/^Bearer /, "");
        if (stub.claudeStatus !== null) return json({ type: "error", error: { type: "api_error", message: "stubbed" } }, stub.claudeStatus);
        return key === claudeKey
          ? json({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null })
          : json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
      }
      if (url === "https://auth.openai.com/.well-known/jwks.json") return json(jwks);
      if (url === "https://auth.openai.com/api/accounts/oauth/token") return json(stub.token ?? { error: "invalid_grant" }, stub.token ? stub.tokenStatus : 400);
      if (url === "https://auth.openai.com/api/accounts/oauth/revoke") return new Response(null, { status: stub.revokeStatus });
      if (url === "https://api.openai.com/v1/models") {
        if (stub.chatgptModelsStatus === 200) return json({ models: [{ slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" }] });
        // 403: what OpenAI answers for an account that cannot use its plan in apps.
        if (stub.chatgptModelsStatus === 403) return json({ error: { message: "not eligible", type: "invalid_request_error", code: "subscription_sharing_user_not_eligible", param: null } }, 403);
        return json({ detail: "Unauthorized" }, stub.chatgptModelsStatus);
      }
      throw new Error(`The test refused a request to ${new URL(url).host}: no test reaches a real provider.`);
    }) as typeof fetch;
  }, options);
}

/** What the faked providers have seen so far. */
export function connectionStubLog(app: ElectronApplication): Promise<ConnectionStubLog> {
  return app.evaluate(() => {
    const stub = (globalThis as unknown as { connectionStub: ConnectionStubLog }).connectionStub;
    return { opened: [...stub.opened], requests: [...stub.requests] };
  });
}

/** Sets what the faked token endpoint answers, and with which status; and the other faked answers. */
export async function setStubAnswers(
  app: ElectronApplication,
  answers: { token?: unknown; tokenStatus?: number; claudeStatus?: number | null; chatgptModelsStatus?: number; revokeStatus?: number },
): Promise<void> {
  await app.evaluate((_electron, next) => {
    Object.assign((globalThis as unknown as { connectionStub: object }).connectionStub, next);
  }, answers);
}

/** What the faked Claude saw for each request of the section workspace. */
export interface DraftingStubLog {
  requests: Array<{ url: string; body: string | null }>;
}

/**
 * Replaces, inside the app's main process, every way out to the AI providers with a fake
 * Claude that drafts invented text: its model list accepts `claudeKey`, and each request
 * to /v1/messages streams back, as Anthropic's server-sent events, an answer fitting the
 * request (a draft, a whole-text change, one paragraph, an improvement, or a consistency
 * check). `msPerChunk` slows the stream so a test can stop it. Anything else is refused,
 * so no test can reach a real provider.
 */
export async function stubDrafting(app: ElectronApplication, options: { claudeKey: string; msPerChunk?: number; consistency?: string }): Promise<void> {
  await app.evaluate((_electron, { claudeKey, msPerChunk, consistency }) => {
    const g = globalThis as unknown as { draftingStub: { requests: Array<{ url: string; body: string | null }>; msPerChunk: number }; fetch: typeof fetch };
    g.draftingStub = { requests: [], msPerChunk: msPerChunk ?? 0 };
    const stub = g.draftingStub;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const DRAFT = [
      "Medical necessity for ABA services was established through the CDE, the Vineland-3 Comprehensive Parent/Caregiver Interview, the caregiver interview and direct observation, which show deficits in communication, daily living skills and social participation.",
      "On the Vineland-3, the child obtained an Adaptive Behavior Composite of 68 [MISSING: percentile rank, not on the score report]; Communication was 66 and Daily Living Skills 70.",
      "In communication, the CDE describes single-word requests. His mother reports that he pulls an adult to the refrigerator instead of asking. ABA will teach functional communication requests to replace crying.",
    ];
    const answerFor = (task: string): string => {
      if (task.includes("Consistency check")) return consistency ?? "NO CONTRADICTIONS";
      if (task.includes("Paragraph change request")) return "On the Vineland-3, the child obtained an Adaptive Behavior Composite of 68, which means that his everyday skills are well below those of most children his age [MISSING: percentile rank, not on the score report].";
      if (task.includes("Change request")) return [DRAFT[0], DRAFT[1], `${DRAFT[2]} The school reports that his communication plan is now in place.`].join("\n\n");
      if (task.includes("Improve request")) return "The child is a 4-year-old boy who lives at home with his mother, father and older brother; Spanish and English are spoken at home.\n\nHe was diagnosed with Autism Spectrum Disorder, as documented in the CDE.";
      return DRAFT.join("\n\n");
    };
    g.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : null;
      stub.requests.push({ url, body });
      const headers = new Headers(init?.headers);
      const key = (headers.get("authorization") ?? headers.get("x-api-key") ?? "").replace(/^Bearer /, "");
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        return key === claudeKey
          ? json({ data: [{ type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null })
          : json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
      }
      if (url.startsWith("https://api.anthropic.com/v1/messages")) {
        const request = JSON.parse(body ?? "{}") as { model: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
        const task = request.messages[0].content.at(-1)?.text ?? "";
        const text = answerFor(task);
        const usage = { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0 };
        const events: Array<[string, unknown]> = [
          ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ...(text.match(/[^ ]+ */g) ?? []).map((piece): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }]),
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 600 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        const encoder = new TextEncoder();
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const [event, data] of events) {
              if (signal?.aborted) break;
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              if (stub.msPerChunk > 0) await new Promise((resolve) => setTimeout(resolve, stub.msPerChunk));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`The test refused a request to ${new URL(url).host}: no test reaches a real provider.`);
    }) as typeof fetch;
  }, options);
}

export function draftingStubLog(app: ElectronApplication): Promise<DraftingStubLog> {
  return app.evaluate(() => ({ requests: [...(globalThis as unknown as { draftingStub: DraftingStubLog }).draftingStub.requests] }));
}

export async function setDraftingSpeed(app: ElectronApplication, msPerChunk: number): Promise<void> {
  await app.evaluate((_electron, ms) => {
    (globalThis as unknown as { draftingStub: { msPerChunk: number } }).draftingStub.msPerChunk = ms;
  }, msPerChunk);
}

export { expect } from "@playwright/test";
