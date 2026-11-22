import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runDevCheckGeneration } from "../src/main/dev-check.ts";
import { GenerationRegistry, MAX_RUNNING_PER_WINDOW } from "../src/main/generations.ts";
import { resolveHomeFolder, resolveRendererFile, resolveRulesDir } from "../src/main/paths.ts";
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
const ID2 = "7a2d3e4f-9b5c-4d6e-8f9a-1b2c3d4e5f60";
const ID3 = "8b3e4f50-ac6d-4e7f-9a0b-2c3d4e5f6071";
const WINDOW = 1;
const OTHER_WINDOW = 2;
const slow = () => events(Array.from({ length: 100 }, (_, i) => ({ type: "text", delta: String(i) })), 5);

test("generations: events go out in order under their id, then exactly one finished", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  const list: GenerationEvent[] = [{ type: "status", phase: "writing" }, { type: "text", delta: "Hello" }];
  assert.equal(registry.start(WINDOW, ID, () => events(list), emit), "started");
  assert.equal(registry.start(WINDOW, ID, () => events(list), emit), "invalid-id", "an id already running");
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
    assert.equal(registry.start(WINDOW, id, () => events([]), () => {}), "invalid-id", id);
  }
});

test("generations: cancel stops the stream and reports finished with cancelled; only the owner can cancel", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  registry.start(WINDOW, ID, slow, emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.cancel(OTHER_WINDOW, ID), false, "another window cannot cancel it");
  assert.equal(registry.cancel(WINDOW, ID), true);
  await finished;
  assert.ok(updates.length < 50, `${updates.length} updates`);
  assert.deepEqual(updates.at(-1)?.event, { type: "finished", cancelled: true });
  assert.equal(registry.cancel(WINDOW, ID), false, "no longer running");
});

test("generations: when the page goes away (reload, crash, close) they stop and send nothing more", async () => {
  const registry = new GenerationRegistry();
  const mine = recorder();
  const theirs = recorder();
  registry.start(WINDOW, ID, slow, mine.emit);
  registry.start(OTHER_WINDOW, ID2, () => events([{ type: "text", delta: "x" }], 40), theirs.emit);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = mine.updates.length;
  assert.equal(registry.orphan(WINDOW), 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(mine.updates.length, before, "not even a finished update goes to the page that replaced it");
  assert.equal(registry.countFor(WINDOW), 0);
  await theirs.finished;
  assert.deepEqual(theirs.updates.at(-1)?.event, { type: "finished", cancelled: false }, "other windows are untouched");
});

test(`generations: at most ${MAX_RUNNING_PER_WINDOW} at once per window; a finished or orphaned one frees its place`, async () => {
  const registry = new GenerationRegistry();
  assert.equal(MAX_RUNNING_PER_WINDOW, 2);
  assert.equal(registry.start(WINDOW, ID, slow, () => {}), "started");
  assert.equal(registry.start(WINDOW, ID2, slow, () => {}), "started");
  assert.equal(registry.start(WINDOW, ID3, slow, () => {}), "busy");
  assert.equal(registry.start(OTHER_WINDOW, ID3, () => events([]), () => {}), "started", "the limit is per window");
  registry.orphan(WINDOW);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = recorder();
  assert.equal(registry.start(WINDOW, "9c4f5061-bd7e-4f80-8b1c-3d4e5f607182", () => events([]), again.emit), "started");
  await again.finished;
});

test("generations: a failure in the stream becomes a generic error, then finished", async () => {
  const registry = new GenerationRegistry();
  const { updates, finished, emit } = recorder();
  // eslint-disable-next-line require-yield
  async function* broken(): AsyncGenerator<GenerationEvent> {
    throw new Error("/Users/someone/secret/path");
  }
  registry.start(WINDOW, ID, broken, emit);
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

test("home folder: --home-folder stands in for it in development only; the packaged app ignores it", () => {
  const home = "/Users/ana";
  assert.equal(resolveHomeFolder({ isPackaged: false, override: "/tmp/test-home", home }, path.posix), "/tmp/test-home");
  assert.equal(resolveHomeFolder({ isPackaged: true, override: "/tmp/test-home", home }, path.posix), home);
  // Not given, or not an absolute path: the real home folder.
  assert.equal(resolveHomeFolder({ isPackaged: false, override: "", home }, path.posix), home);
  assert.equal(resolveHomeFolder({ isPackaged: false, override: "relative/home", home }, path.posix), home);
  assert.equal(resolveHomeFolder({ isPackaged: false, override: "D:\\test-home", home: "C:\\Users\\Ana" }, path.win32), "D:\\test-home");
  assert.equal(resolveHomeFolder({ isPackaged: true, override: "D:\\test-home", home: "C:\\Users\\Ana" }, path.win32), "C:\\Users\\Ana");
});
