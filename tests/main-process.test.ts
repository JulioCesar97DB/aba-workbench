import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runDevCheckGeneration } from "../src/main/dev-check.ts";
import { GenerationRegistry } from "../src/main/generations.ts";
import { resolveRendererFile, resolveRulesDir } from "../src/main/paths.ts";
import { isTrustedFrame } from "../src/main/trust.ts";
import type { GenerationEvent } from "../src/lib/generation-events.ts";
import type { GenerationUpdate } from "../src/shared/api.ts";

// The modules tested here are the main process's logic; they import nothing from Electron.

test("rules folder: the repository's in development, the resources folder when packaged (macOS and Windows)", () => {
  const dev = resolveRulesDir({ isPackaged: false, resourcesPath: "/unused", appPath: process.cwd() });
  assert.ok(existsSync(path.join(dev, "assessment.md")), dev);

  assert.equal(
    resolveRulesDir({ isPackaged: true, resourcesPath: "/Applications/ABA Workbench.app/Contents/Resources", appPath: "/x/app.asar" }, path.posix),
    "/Applications/ABA Workbench.app/Contents/Resources/rules",
  );
  assert.equal(
    resolveRulesDir({ isPackaged: true, resourcesPath: "C:\\Program Files\\ABA Workbench\\resources", appPath: "C:\\x\\app.asar" }, path.win32),
    "C:\\Program Files\\ABA Workbench\\resources\\rules",
  );
});

test("app:// files: only files inside the built interface, on macOS and Windows", () => {
  const posixRoot = "/app/out/renderer";
  assert.equal(resolveRendererFile(posixRoot, "/", path.posix), "/app/out/renderer/index.html");
  assert.equal(resolveRendererFile(posixRoot, "/assets/index-abc.js", path.posix), "/app/out/renderer/assets/index-abc.js");
  for (const bad of ["/../main/index.js", "/%2e%2e/main/index.js", "/assets/%2e%2e/%2e%2e/secret", "/%E0%A4%A", "/a%00b"]) {
    assert.equal(resolveRendererFile(posixRoot, bad, path.posix), null, bad);
  }

  const winRoot = "C:\\app\\out\\renderer";
  assert.equal(resolveRendererFile(winRoot, "/assets/index-abc.js", path.win32), "C:\\app\\out\\renderer\\assets\\index-abc.js");
  for (const bad of ["/..%5Cmain%5Cindex.js", "/%5C..%5C..%5Csecret", "/C:/Windows/win.ini", "/D:%5Cdata"]) {
    assert.equal(resolveRendererFile(winRoot, bad, path.win32), null, bad);
  }
});

test("IPC senders: only the top frame showing the app's own origin", () => {
  const origin = "app://aba-workbench";
  assert.equal(isTrustedFrame({ origin, parent: null }, origin), true);
  assert.equal(isTrustedFrame(null, origin), false);
  assert.equal(isTrustedFrame({ origin, parent: {} }, origin), false, "a child frame");
  assert.equal(isTrustedFrame({ origin: "https://example.com", parent: null }, origin), false);
  assert.equal(isTrustedFrame({ origin: "null", parent: null }, origin), false, "an opaque origin");
});

async function* events(list: GenerationEvent[], pauseMs = 0): AsyncGenerator<GenerationEvent> {
  for (const event of list) {
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    yield event;
  }
}

function recorder() {
  const updates: GenerationUpdate[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => (resolveFinished = resolve));
  const emit = (update: GenerationUpdate) => {
    updates.push(update);
    if (update.event.type === "finished") resolveFinished();
  };
  return { updates, finished, emit };
}

const ID = "6f1c1d2e-8a4b-4c3d-9e8f-0a1b2c3d4e5f";

test("generations: events go out in order under their id, then exactly one finished", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  const list: GenerationEvent[] = [{ type: "status", phase: "writing" }, { type: "text", delta: "Hello" }];
  assert.equal(registry.start(ID, () => events(list), emit), true);
  assert.equal(registry.start(ID, () => events(list), emit), false, "an id already running");
  await finished;
  assert.deepEqual(updates, [
    { generationId: ID, event: list[0] },
    { generationId: ID, event: list[1] },
    { generationId: ID, event: { type: "finished", cancelled: false } },
  ]);
  assert.equal(registry.size, 0);
});

test("generations: ids that are not UUIDs are refused", () => {
  const registry = new GenerationRegistry();
  for (const id of ["", "1", "../x", ID.toUpperCase(), `${ID}x`]) {
    assert.equal(registry.start(id, () => events([]), () => {}), false, id);
  }
});

test("generations: cancel stops the stream and reports finished with cancelled", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  const many: GenerationEvent[] = Array.from({ length: 100 }, (_, i) => ({ type: "text", delta: String(i) }));
  registry.start(ID, () => events(many, 5), emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.cancel(ID), true);
  await finished;
  assert.ok(updates.length < 50, `${updates.length} updates`);
  assert.deepEqual(updates.at(-1)?.event, { type: "finished", cancelled: true });
  assert.equal(registry.cancel(ID), false, "no longer running");
});

test("generations: a failure in the stream becomes a generic error, then finished", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  // eslint-disable-next-line require-yield
  async function* broken(): AsyncGenerator<GenerationEvent> {
    throw new Error("/Users/someone/secret/path");
  }
  registry.start(ID, broken, emit);
  await finished;
  assert.equal(updates[0].event.type, "error");
  assert.doesNotMatch(JSON.stringify(updates), /secret/);
  assert.deepEqual(updates.at(-1)?.event, { type: "finished", cancelled: false });
});

test("development check: the mock streams through the real rules to a complete done", async () => {
  const seen: GenerationEvent[] = [];
  const rulesDir = resolveRulesDir({ isPackaged: false, resourcesPath: "", appPath: process.cwd() });
  for await (const event of runDevCheckGeneration({ rulesDir, signal: new AbortController().signal, msPerTextDelta: 0 })) seen.push(event);
  assert.equal(seen[0].type, "meta");
  assert.ok(seen.filter((e) => e.type === "text").length > 10);
  assert.equal(seen.at(-1)?.type, "done");
  const text = seen.map((e) => (e.type === "text" ? e.delta : "")).join("");
  assert.match(text, /MOCK OUTPUT/);
});
