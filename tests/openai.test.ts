import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAIProvider, normalizeUsage } from "../src/lib/providers/openai.ts";
import { collect, options, PDF_BASE64, sseResponse, stubFetch } from "./helpers.ts";

const usage = {
  input_tokens: 12_000,
  input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 7_000 },
  output_tokens: 3_000,
  output_tokens_details: { reasoning_tokens: 2_000 },
  total_tokens: 15_000,
};

function finalResponse(status: string, extra: Record<string, unknown> = {}) {
  return { id: "resp_test", object: "response", model: "gpt-6.2-sol", status, output: [], usage, ...extra };
}

function stream(events: Array<[string, unknown]>) {
  return sseResponse(events.map(([type, data], i) => [type, { type, sequence_number: i, ...(data as object) }]));
}

const textDelta: [string, unknown] = ["response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "Text", logprobs: [] }];

test("OpenAI request: developer rules, explicit breakpoints, store false, effort, PDF intact", async () => {
  for (const model of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
    const { fetchStub, calls } = stubFetch(() => stream([textDelta, ["response.completed", { response: finalResponse("completed") }]]));
    await collect(createOpenAIProvider({ fetch: fetchStub }), { ...options(model), effort: "medium" });
    const { url, headers, body } = calls[0];
    assert.match(url, /\/v1\/responses$/);
    assert.equal(headers.get("authorization"), "Bearer test-key-not-real");
    assert.ok(body);
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.instructions, undefined, "rules never go in top-level instructions");
    assert.deepEqual(body.reasoning, { effort: "medium" });
    assert.equal(body.max_output_tokens, 32_000);
    assert.deepEqual(body.prompt_cache_options, { mode: "explicit", ttl: "30m" });

    const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepEqual(input.map((m) => m.role), ["developer", "user", "user"]);
    assert.equal(input[0].content[0].text, "RULES");
    assert.deepEqual(input[0].content[0].prompt_cache_breakpoint, { mode: "explicit" });
    assert.deepEqual(input[1].content.at(-1), { type: "input_text", text: "</sources>", prompt_cache_breakpoint: { mode: "explicit" } });
    const breakpoints = input.flatMap((m) => m.content).filter((part) => part.prompt_cache_breakpoint);
    assert.equal(breakpoints.length, 2, "rules and sources only");
    assert.deepEqual(input[2].content, [{ type: "input_text", text: "SECTION RULES AND REQUEST" }]);
    const file = input[1].content.find((part) => part.type === "input_file")!;
    assert.equal(file.filename, "vineland-3.pdf");
    assert.equal(file.file_data, `data:application/pdf;base64,${PDF_BASE64}`, "the PDF bytes reach the provider unchanged");
  }
});

test("OpenAI: completed is complete; usage is normalized", async () => {
  const { fetchStub } = stubFetch(() => stream([textDelta, ["response.completed", { response: finalResponse("completed") }]]));
  const events = await collect(createOpenAIProvider({ fetch: fetchStub }), options("gpt-6.2-sol"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, true);
  assert.equal(done.servedModel, "gpt-6.2-sol");
  assert.deepEqual(done.usage, { uncachedInputTokens: 1_000, cacheWriteTokens: 7_000, cacheReadTokens: 4_000, outputTokens: 3_000, reasoningTokens: 2_000 });
});

test("OpenAI: a refusal tells the client to discard and is not complete", async () => {
  const { fetchStub } = stubFetch(() =>
    stream([
      ["response.refusal.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "I can't help with that." }],
      ["response.completed", { response: finalResponse("completed") }],
    ]),
  );
  const events = await collect(createOpenAIProvider({ fetch: fetchStub }), options("gpt-6.2-sol"));
  const refusal = events.find((e) => e.type === "refusal");
  assert.ok(refusal && refusal.type === "refusal");
  assert.equal(refusal.discard, true);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, false);
  assert.equal(done.stopReason, "refusal");
});

test("OpenAI: an incomplete response (output limit) is not complete", async () => {
  const { fetchStub } = stubFetch(() =>
    stream([textDelta, ["response.incomplete", { response: finalResponse("incomplete", { incomplete_details: { reason: "max_output_tokens" } }) }]]),
  );
  const events = await collect(createOpenAIProvider({ fetch: fetchStub }), options("gpt-6.2-astra"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.complete, false);
  assert.equal(done.stopReason, "max_output_tokens");
});

test("OpenAI pre-warm: prewarm flag, no section request, no streaming", async () => {
  const { fetchStub, calls } = stubFetch(() => Response.json(finalResponse("completed")));
  await createOpenAIProvider({ fetch: fetchStub }).prewarm(options("gpt-6.2-sol"));
  const body = calls[0].body!;
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit", ttl: "30m", prewarm: true });
  assert.equal(body.stream, undefined);
  assert.equal((body.input as unknown[]).length, 2);
});

test("OpenAI usage: input_tokens includes cached reads and writes", () => {
  assert.deepEqual(normalizeUsage(usage as never), {
    uncachedInputTokens: 1_000,
    cacheWriteTokens: 7_000,
    cacheReadTokens: 4_000,
    outputTokens: 3_000,
    reasoningTokens: 2_000,
  });
  assert.equal(normalizeUsage(undefined).outputTokens, 0);
});
