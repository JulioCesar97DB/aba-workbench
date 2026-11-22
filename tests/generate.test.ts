import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { runGeneration, type GenerationEvent, type GenerationRequest } from "../src/lib/generate.ts";
import { mockProvider } from "../src/lib/providers/mock.ts";
import type { Provider } from "../src/lib/providers/types.ts";

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    provider: mockProvider,
    apiKey: "",
    model: "mock-echo",
    section: "medical-necessity",
    effort: "high",
    maxOutputTokens: 32_000,
    mode: "generate",
    sources: [{ id: "notes", title: "Notes", kind: "text", text: "Invented notes." }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const all: GenerationEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** A provider that fails the test if anything is sent to it. */
function providerThatMustNotBeCalled(id: Provider["id"]): Provider {
  const fail = () => {
    throw new Error("the provider was called");
  };
  return { id, listModels: fail, generate: fail, prewarm: fail };
}

test("generation: meta with the rules versions first, then the provider's events to a complete done", async () => {
  const events = await collect(runGeneration(request()));
  const meta = events[0];
  assert.equal(meta.type, "meta");
  assert.deepEqual(Object.keys(meta.type === "meta" ? meta.rulesVersions : {}).sort(), ["assessment", "instruments", "payer-florida-molina", "section-medical-necessity"]);
  assert.ok(events.some((e) => e.type === "text"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.type === "done" && done.complete, true);
});

test("generation: pre-warm reports a done with stopReason prewarm and no text", async () => {
  const events = await collect(runGeneration(request({ mode: "prewarm" })));
  assert.deepEqual(events.map((e) => e.type), ["meta", "done"]);
  assert.equal(events[1].type === "done" && events[1].stopReason, "prewarm");
});

test("generation: rules that cannot be read give a rules_error that does not name the folder", async () => {
  const missing = path.join(process.cwd(), "no-such-rules-folder");
  const events = await collect(runGeneration(request({ rulesDir: missing, provider: providerThatMustNotBeCalled("anthropic") })));
  assert.equal(events.length, 1);
  const [error] = events;
  assert.equal(error.type, "error");
  assert.equal(error.type === "error" && error.code, "rules_error");
  assert.doesNotMatch(JSON.stringify(error), /no-such-rules-folder/);
});

test("generation: an unexpected failure becomes a safe error event; nothing is reported after a cancel", async () => {
  const failing: Provider = {
    ...mockProvider,
    id: "anthropic",
    // eslint-disable-next-line require-yield
    async *generate() {
      throw new Error("socket closed while sending key sk-secret");
    },
  };
  const events = await collect(runGeneration(request({ provider: failing })));
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  assert.doesNotMatch(JSON.stringify(error), /sk-secret/);

  const controller = new AbortController();
  controller.abort();
  const afterCancel = await collect(runGeneration(request({ provider: failing, signal: controller.signal })));
  assert.deepEqual(afterCancel.map((e) => e.type), ["meta"]);
});
