import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicProvider, readUsage } from "../src/lib/providers/anthropic.ts";
import { collect, options, PDF_BASE64, sseResponse, stubFetch } from "./helpers.ts";

const usage = { input_tokens: 50, output_tokens: 1, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 };

function messageStart(model = "claude-opus-5-5") {
  return ["message_start", {
    type: "message_start",
    message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage },
  }] as [string, unknown];
}

function textStream(stopReason: string, stopDetails: unknown = null) {
  return sseResponse([
    messageStart(),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial text" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 900 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

test("Claude request: adaptive thinking, effort, fallbacks, two cache breakpoints, PDF intact", async () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-2"]) {
    const { fetchStub, calls } = stubFetch(() => textStream("end_turn"));
    await collect(createAnthropicProvider({ fetch: fetchStub }), options(model));
    assert.equal(calls.length, 1);
    const { url, headers, body } = calls[0];
    assert.match(url, /\/v1\/messages/);
    assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
    // SDK 1.x sends the key as a bearer token; either way it must be the per-request key.
    assert.match(headers.get("authorization") ?? headers.get("x-api-key") ?? "", /test-key-not-real/);
    assert.ok(body);
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 32_000);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.equal(body.fallbacks, "default");
    assert.equal("betas" in body, false, "betas travel as a header, not in the body");

    const system = body.system as Array<Record<string, unknown>>;
    assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    const marked = content.filter((block) => block.cache_control);
    assert.equal(marked.length, 1, "exactly one breakpoint in the messages (end of sources)");
    assert.equal(content.at(-1)!.text, "SECTION RULES AND REQUEST");
    assert.equal(content.at(-1)!.cache_control, undefined, "the section request is never cached");
    assert.deepEqual(content.at(-2)!.cache_control, { type: "ephemeral" });
    const pdf = content.find((block) => block.type === "document") as { source: { data: string; media_type: string } };
    assert.equal(pdf.source.media_type, "application/pdf");
    assert.equal(pdf.source.data, PDF_BASE64, "the PDF bytes reach the provider unchanged");
  }
});

test("Claude: a clean finish is complete and reports the serving model", async () => {
  const { fetchStub } = stubFetch(() => textStream("end_turn"));
  const events = await collect(createAnthropicProvider({ fetch: fetchStub }), options("claude-opus-5-5"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, true);
  assert.equal(done.servedModel, "claude-opus-5-5");
  assert.equal(done.usage.cacheWriteTokens, 3000);
  assert.equal(events.some((e) => e.type === "refusal"), false);
});

test("Claude: a refusal tells the client to discard the text and is not complete", async () => {
  const { fetchStub } = stubFetch(() => textStream("refusal", { type: "refusal", category: "bio", explanation: "declined" }));
  const events = await collect(createAnthropicProvider({ fetch: fetchStub }), options("claude-opus-5-5"));
  const refusal = events.find((e) => e.type === "refusal");
  assert.ok(refusal && refusal.type === "refusal");
  assert.equal(refusal.discard, true);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, false);
  assert.equal(done.stopReason, "refusal");
});

test("Claude: hitting max_tokens is not complete", async () => {
  const { fetchStub } = stubFetch(() => textStream("max_tokens"));
  const events = await collect(createAnthropicProvider({ fetch: fetchStub }), options("claude-fable-5-2"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, false);
  assert.equal(done.stopReason, "max_tokens");
});

test("Claude pre-warm: max_tokens 0, same settings, sources but no section request", async () => {
  const { fetchStub, calls } = stubFetch(() =>
    Response.json({ id: "msg_w", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "max_tokens", stop_sequence: null, stop_details: null, usage }),
  );
  const result = await createAnthropicProvider({ fetch: fetchStub }).prewarm(options("claude-opus-5-5"));
  const body = calls[0].body!;
  assert.equal(body.max_tokens, 0);
  assert.equal(body.stream, undefined);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "high" });
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assert.notEqual(content.at(-1)!.text, "SECTION RULES AND REQUEST");
  assert.deepEqual(content.at(-1)!.cache_control, { type: "ephemeral" });
  assert.equal(result.cacheWriteTokens, 3000);
});

test("Claude usage: with a fallback, attempts are listed per model and summed", () => {
  const { usage: total, attempts } = readUsage(
    {
      usage: {
        input_tokens: 20, output_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        iterations: [
          { type: "message", model: null, input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, cache_creation: null },
          { type: "fallback_message", model: "claude-opus-5", input_tokens: 20, output_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000, cache_creation: null },
        ],
      },
    } as never,
    "claude-fable-5-2",
  );
  assert.ok(attempts);
  assert.deepEqual(attempts.map((a) => [a.model, a.fallback]), [["claude-fable-5-2", false], ["claude-opus-5", true]]);
  assert.equal(total.outputTokens, 750);
  assert.equal(total.cacheWriteTokens, 3000);
  assert.equal(total.cacheReadTokens, 3000);
});
