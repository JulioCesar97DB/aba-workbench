import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloseGuard, createQuitWait, SAVE_WAIT_MS, withTimeout, type CloseGuardOptions } from "../src/main/close-guard.ts";

/* The window's close waits for the interface's saves (src/main/close-guard.ts). */

function harness(overrides: Partial<CloseGuardOptions> = {}) {
  const calls: string[] = [];
  let quitting = false;
  const options: CloseGuardOptions = {
    flush: async () => ({ ok: true }),
    idle: async () => true,
    ask: async () => "close",
    close: () => calls.push("close"),
    quit: () => calls.push("quit"),
    isQuitting: () => quitting,
    cancelQuit: () => {
      quitting = false;
      calls.push("cancel-quit");
    },
    isDestroyed: () => false,
    ...overrides,
  };
  const guard = createCloseGuard(options);
  const close = () => {
    let prevented = false;
    guard({ preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { calls, close, setQuitting: (value: boolean) => (quitting = value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("close guard: the first close waits for the saves, then closes for real", async () => {
  let flushed = false;
  const { calls, close } = harness({
    flush: async () => {
      await settle();
      flushed = true;
      return { ok: true };
    },
  });
  assert.equal(close(), true);
  assert.deepEqual(calls, []);
  // A second close while saving is held back too, and starts nothing new.
  assert.equal(close(), true);
  await settle();
  await settle();
  assert.equal(flushed, true);
  assert.deepEqual(calls, ["close"]);
  // The guard's own close goes through.
  assert.equal(close(), false);
});

test("close guard: when quitting, it quits once the saves are done", async () => {
  const { calls, close, setQuitting } = harness();
  setQuitting(true);
  close();
  await settle();
  assert.deepEqual(calls, ["quit"]);
});

test("close guard: a change that could not be saved asks first; Go back keeps the window and ends the quit", async () => {
  const asked: string[] = [];
  let answer: "stay" | "close" = "stay";
  const { calls, close, setQuitting } = harness({
    flush: async () => ({ ok: false }),
    ask: async (problem) => {
      asked.push(problem);
      return answer;
    },
  });
  setQuitting(true);
  close();
  await settle();
  assert.deepEqual(asked, ["failed"]);
  assert.deepEqual(calls, ["cancel-quit"]);
  // Asked again on the next close; Close anyway closes.
  answer = "close";
  assert.equal(close(), true);
  await settle();
  assert.deepEqual(asked, ["failed", "failed"]);
  assert.deepEqual(calls, ["cancel-quit", "close"]);
});

test("close guard: an interface that does not answer, or case work that does not finish, is said to be still saving", async () => {
  for (const overrides of [{ flush: async () => "timeout" as const }, { idle: async () => false }, { flush: async () => Promise.reject(new Error("x")) }]) {
    const asked: string[] = [];
    const { close } = harness({
      ...overrides,
      ask: async (problem) => {
        asked.push(problem);
        return "close";
      },
    });
    close();
    await settle();
    assert.deepEqual(asked, ["timeout"]);
  }
});

test("close guard: a crashed page has nothing to save: the window closes without asking", async () => {
  const asked: string[] = [];
  const { calls, close } = harness({
    flush: async () => "gone",
    ask: async (problem) => {
      asked.push(problem);
      return "stay";
    },
  });
  close();
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ["close"]);
});

test("close guard: withTimeout gives the fallback when the work is too slow", async () => {
  assert.equal(await withTimeout(new Promise(() => undefined), 5, "late"), "late");
  assert.equal(await withTimeout(Promise.resolve("on time"), 1000, "late"), "on time");
});

test("close guard: one deadline for both waits, so she waits at most SAVE_WAIT_MS before being asked (review S5)", async () => {
  assert.equal(SAVE_WAIT_MS, 5_000);
  const given: number[] = [];
  let clock = 0;
  const { close } = harness({
    timeoutMs: 100,
    now: () => clock,
    flush: async (ms) => {
      given.push(ms);
      clock += 70; // the interface's saves took 70 of the 100
      return { ok: true };
    },
    idle: async (ms) => {
      given.push(ms);
      return true;
    },
  });
  close();
  await settle();
  assert.deepEqual(given, [100, 30]);
});

test("quit wait: every wait finishes before the quit, however many there are (review S6)", async () => {
  const done: string[] = [];
  const quits: string[] = [];
  const later = (name: string, ms: number) => new Promise<void>((resolve) => setTimeout(() => (done.push(name), resolve()), ms));
  let pending: Array<Promise<unknown>> = [later("cases", 5), later("credentials", 30)];
  const onQuit = createQuitWait(() => pending, () => quits.push(`quit after ${done.join(", ")}`));
  let prevented = false;
  onQuit({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(quits, ["quit after cases, credentials"]);
  // The quit that follows goes through.
  pending = [later("again", 1)];
  let preventedAgain = false;
  onQuit({ preventDefault: () => (preventedAgain = true) });
  assert.equal(preventedAgain, false);
  // Nothing to wait for: nothing is held.
  const idle = createQuitWait(() => [], () => quits.push("never"));
  let held = false;
  idle({ preventDefault: () => (held = true) });
  assert.equal(held, false);
});
