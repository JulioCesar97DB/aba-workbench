/*
 * De-identification in a worker thread: the main process's event loop stays free while a
 * long text is read, the "preparing" state is set before the work starts, and the thread keeps
 * one set of placeholders across texts. The worker runs from its TypeScript source here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeidentifyThread, deidentify, reidentify, type DeidentifyState } from "../src/main/deidentify/index.ts";
import { REVIEW_SHEET, REVIEW_TODAY } from "./deidentify-adversarial.ts";

const SCRIPT = new URL("../src/main/deidentify/thread.ts", import.meta.url);

test("thread: the same result as in-process, preparing while it works, the event loop free", async () => {
  const thread = new DeidentifyThread(REVIEW_SHEET, { today: REVIEW_TODAY }, SCRIPT);
  const states: DeidentifyState[] = [];
  thread.onState((s) => states.push(s));
  try {
    const text = "Mateo Ficticio Gómez, DOB 03/14/2020, phone (305) 555-0142, lives at 4471 SW 12th Terrace. ".repeat(15_000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const pending = thread.deidentify(text);
    assert.equal(thread.state, "preparing");
    const result = await pending;
    clearInterval(timer);
    assert.equal(thread.state, "idle");
    assert.deepEqual(states, ["preparing", "idle"]);
    assert.equal(result.text, deidentify(text, REVIEW_SHEET, { today: REVIEW_TODAY }).text);
    assert.equal(reidentify(result.text, result.map).text.length > 0, true);
    // The main event loop kept turning while the thread worked.
    assert.ok(ticks > 3, `only ${ticks} ticks while the thread worked`);
    // One set of placeholders across texts.
    const second = await thread.deidentify("Teo called (305) 555-0142.");
    assert.equal(second.text, "[CLIENT NICKNAME] called [PHONE 1].");
  } finally {
    await thread.close();
  }
  assert.equal(thread.state, "closed");
  await assert.rejects(thread.deidentify("x"), /closed/u);
});

test("thread: a text over the limit is refused with the same error, and the thread goes on", async () => {
  const thread = new DeidentifyThread(REVIEW_SHEET, { today: REVIEW_TODAY }, SCRIPT);
  try {
    await assert.rejects(thread.deidentify("a".repeat(2_000_001)), /too long|limit|characters/iu);
    assert.equal(thread.state, "idle");
    assert.equal((await thread.deidentify("Mateo")).text, "[CLIENT]");
  } finally {
    await thread.close();
  }
});

test("thread: a call over its time limit ends the thread and rejects every pending call", async () => {
  const thread = new DeidentifyThread(REVIEW_SHEET, { today: REVIEW_TODAY }, { script: new URL("./deidentify-slow-thread.ts", import.meta.url), timeoutMs: 300 });
  const first = thread.deidentify("Mateo");
  const second = thread.deidentify("Teo");
  await assert.rejects(first, /longer than 300 ms/u);
  await assert.rejects(second, /longer than 300 ms/u);
  assert.equal(thread.state, "closed");
  await assert.rejects(thread.deidentify("x"), /closed/u);
});

test("thread: an idle thread that was never closed does not keep the process alive", () => {
  const script = `
    import { DeidentifyThread } from ${JSON.stringify(new URL("../src/main/deidentify/index.ts", import.meta.url).href)};
    const thread = new DeidentifyThread({ client: { firstName: "Mateo", lastName: "Ficticio" } }, {}, new URL(${JSON.stringify(SCRIPT.href)}));
    const result = await thread.deidentify("Mateo Ficticio");
    console.log(result.text);
  `;
  const dir = mkdtempSync(path.join(tmpdir(), "aba-deidentify-thread-"));
  try {
    const file = path.join(dir, "unclosed.mjs");
    writeFileSync(file, script);
    const started = Date.now();
    // It must end by itself: the time limit only stops a process that hangs.
    const run = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "[CLIENT FULL NAME]");
    assert.ok(Date.now() - started < 15_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
