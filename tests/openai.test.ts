import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicProvider } from "../src/lib/providers/anthropic.ts";
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

const chatgpt = { kind: "chatgpt", accessToken: "chatgpt-access-token-not-real" } as const;

test("ChatGPT sign-in: the token is the bearer; stream and store false; no fields the flow refuses", async () => {
  const { fetchStub, calls } = stubFetch(() => stream([textDelta, ["response.completed", { response: finalResponse("completed") }]]));
  const events = await collect(createOpenAIProvider({ fetch: fetchStub }), { ...options("gpt-6.2-sol"), credential: chatgpt });
  assert.equal(calls.length, 1, "no retries");
  const { url, headers, body } = calls[0];
  assert.equal(url, "https://api.openai.com/v1/responses", "the public Responses endpoint, never ChatGPT's backend-api");
  assert.equal(headers.get("authorization"), "Bearer chatgpt-access-token-not-real");
  assert.ok(body);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.ok(Array.isArray(body.input));
  // developers.openai.com/siwc/token-sharing-open-source/preview-limitations
  for (const field of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id", "instructions"]) {
    assert.equal(field in body, false, field);
  }
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" }, "no ttl: it replaces prompt_cache_retention");
  const roles = (body.input as Array<{ role: string }>).map((m) => m.role);
  assert.equal(roles.includes("system"), false, "system messages are rejected in this flow");
  assert.equal(events.at(-1)?.type, "done");
});

test("ChatGPT sign-in: the model list is models[] with slug and display_name, visibility list only, in the server's order", async () => {
  const { fetchStub, calls } = stubFetch(() =>
    Response.json({
      models: [
        { slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" },
        { slug: "internal-model", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list", extra: true },
      ],
    }),
  );
  const models = await createOpenAIProvider({ fetch: fetchStub }).listModels(chatgpt, new AbortController().signal);
  assert.deepEqual(models, [
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", createdAt: null },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", createdAt: null },
  ]);
  assert.equal(calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(calls[0].headers.get("authorization"), "Bearer chatgpt-access-token-not-real");
});

test("ChatGPT sign-in: a model list in another shape is refused, not guessed at", async () => {
  const { fetchStub } = stubFetch(() => Response.json({ object: "list", data: [{ id: "gpt-6.2-sol" }] }));
  await assert.rejects(createOpenAIProvider({ fetch: fetchStub }).listModels(chatgpt, new AbortController().signal), /model list this app does not understand/);
});

test("API key: the model list still comes from data[] and the request keeps its output limit", async () => {
  const { fetchStub } = stubFetch(() => Response.json({ object: "list", data: [{ id: "gpt-6.2-sol", object: "model", created: 1790000000, owned_by: "openai" }, { id: "gpt-image-2", object: "model", created: 1, owned_by: "openai" }] }));
  const models = await createOpenAIProvider({ fetch: fetchStub }).listModels({ kind: "api-key", apiKey: "test-key-not-real" }, new AbortController().signal);
  assert.deepEqual(models.map((m) => m.id), ["gpt-6.2-sol"]);
});

test("ChatGPT sign-in: OpenAI's plan errors become their own messages, the token never in them", async () => {
  const cases: Array<[number, unknown, RegExp, string]> = [
    [429, { error: { message: "limit", type: "usage", code: "subscription_sharing_usage_limit_exceeded", param: null } }, /usage limit was reached/, "chatgpt_usage_limit"],
    [403, { error: { message: "no", type: "x", code: "subscription_sharing_user_not_eligible", param: null } }, /cannot use its plan/, "chatgpt_not_eligible"],
    [400, { error: { message: "no", type: "x", code: "subscription_sharing_unsupported_capability", param: "tools[0]" } }, /does not support part of this request \(tools\[0\]\)/, "chatgpt_unsupported"],
    [401, { detail: "Unauthorized" }, /Sign in again in Settings/, "chatgpt_signed_out"],
    [403, { detail: "Region not allowed" }, /policy or permission check/, "chatgpt_not_allowed"],
    [503, { detail: "Direct routing unavailable" }, /not available just now/, "chatgpt_unavailable"],
  ];
  for (const [status, body, message, code] of cases) {
    const { fetchStub, calls } = stubFetch(() => Response.json(body, { status }));
    const provider = createOpenAIProvider({ fetch: fetchStub });
    const error = await collect(provider, { ...options("gpt-6.2-sol"), credential: chatgpt }).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    assert.ok(error, String(status));
    assert.equal(error.code, code, String(status));
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /chatgpt-access-token-not-real/);
    assert.equal(calls.length, 1, `${status}: not retried`);
  }
});

test("ChatGPT sign-in: a usage limit after the stream began ends the generation with that message", async () => {
  const { fetchStub } = stubFetch(() =>
    stream([
      textDelta,
      ["response.failed", { response: finalResponse("failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }) }],
    ]),
  );
  await assert.rejects(collect(createOpenAIProvider({ fetch: fetchStub }), { ...options("gpt-6.2-sol"), credential: chatgpt }), { code: "chatgpt_usage_limit" });
});

test("ChatGPT sign-in: pre-warming (a request that does not stream) is refused before anything is sent", async () => {
  const { fetchStub, calls } = stubFetch(() => Response.json(finalResponse("completed")));
  await assert.rejects(createOpenAIProvider({ fetch: fetchStub }).prewarm({ ...options("gpt-6.2-sol"), credential: chatgpt }), { code: "chatgpt_unsupported" });
  assert.equal(calls.length, 0);
});

test("Claude refuses a ChatGPT sign-in before anything is sent", async () => {
  const { fetchStub, calls } = stubFetch(() => Response.json({}));
  await assert.rejects(createAnthropicProvider({ fetch: fetchStub }).listModels(chatgpt, new AbortController().signal), { code: "unsupported_credential" });
  assert.equal(calls.length, 0);
});
