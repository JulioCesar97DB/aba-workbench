import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAnthropicProvider } from "../src/lib/providers/anthropic.ts";
import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL, pinnedFetch, removeEnvHeaders } from "../src/lib/providers/endpoints.ts";
import { createOpenAIProvider } from "../src/lib/providers/openai.ts";
import { options, stubFetch, type CapturedRequest } from "./helpers.ts";

/** Every environment variable the SDKs read that could move a request or add to it. */
const HOSTILE_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://attacker.invalid",
  ANTHROPIC_CUSTOM_HEADERS: "x-extra: injected\nX-Other-Header: also injected",
  ANTHROPIC_AUTH_TOKEN: "token-from-env",
  ANTHROPIC_API_KEY: "key-from-env",
  ANTHROPIC_OPEN_TELEMETRY: "true",
  ANTHROPIC_OPEN_TELEMETRY_PROPAGATION: "true",
  ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE: "content",
  ANTHROPIC_PROFILE: "someone-else",
  ANTHROPIC_ORGANIZATION_ID: "org-from-env",
  ANTHROPIC_WORKSPACE_ID: "workspace-from-env",
  ANTHROPIC_LOG: "debug",
  OPENAI_BASE_URL: "https://attacker.invalid/v1",
  OPENAI_CUSTOM_HEADERS: "x-extra: injected\nX-Other-Header: also injected",
  OPENAI_API_KEY: "key-from-env",
  OPENAI_ADMIN_KEY: "admin-key-from-env",
  OPENAI_ORG_ID: "org-from-env",
  OPENAI_PROJECT_ID: "project-from-env",
  OPENAI_LOG: "debug",
};

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function assertClean(calls: CapturedRequest[], baseURL: string) {
  assert.ok(calls.length > 0);
  for (const { url, headers } of calls) {
    assert.ok(url.startsWith(`${baseURL}/`), url);
    const all = JSON.stringify([...headers.entries()]);
    for (const leaked of ["injected", "token-from-env", "key-from-env", "admin-key-from-env", "org-from-env", "project-from-env", "workspace-from-env", "traceparent"]) {
      assert.doesNotMatch(all, new RegExp(leaked, "i"), `${url}: ${leaked}`);
    }
    assert.match(headers.get("authorization") ?? headers.get("x-api-key") ?? "", /test-key-not-real/);
  }
}

const anthropicMessage = { id: "msg_w", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "max_tokens", stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
const openaiResponse = { id: "resp_w", object: "response", model: "gpt-6.2-sol", status: "completed", output: [], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1 } };

test("Claude: no environment variable moves the request, adds a header or replaces the key", async () => {
  const { fetchStub, calls } = stubFetch(({ url }) =>
    url.includes("/v1/models") ? Response.json({ data: [], has_more: false, first_id: null, last_id: null }) : Response.json(anthropicMessage),
  );
  await withEnv(HOSTILE_ENV, async () => {
    const provider = createAnthropicProvider({ fetch: fetchStub });
    await provider.listModels({ kind: "api-key", apiKey: "test-key-not-real" }, new AbortController().signal);
    await provider.prewarm(options("claude-opus-5-5"));
  });
  assert.equal(calls.length, 2);
  assertClean(calls, ANTHROPIC_BASE_URL);
});

test("OpenAI: no environment variable moves the request, adds a header or replaces the key", async () => {
  const { fetchStub, calls } = stubFetch(({ url }) => (url.includes("/models") ? Response.json({ object: "list", data: [] }) : Response.json(openaiResponse)));
  await withEnv(HOSTILE_ENV, async () => {
    const provider = createOpenAIProvider({ fetch: fetchStub });
    await provider.listModels({ kind: "api-key", apiKey: "test-key-not-real" }, new AbortController().signal);
    await provider.prewarm(options("gpt-6.2-sol"));
  });
  assert.equal(calls.length, 2);
  assertClean(calls, OPENAI_BASE_URL);
  for (const { headers } of calls) {
    assert.equal(headers.get("openai-organization"), null);
    assert.equal(headers.get("openai-project"), null);
  }
});

test("the pinned fetch sends only under the official address", async () => {
  const { fetchStub, calls } = stubFetch(() => new Response("ok"));
  const pinned = pinnedFetch(ANTHROPIC_BASE_URL, fetchStub);
  await pinned(`${ANTHROPIC_BASE_URL}/v1/messages`);
  for (const url of ["https://attacker.invalid/v1/messages", "https://api.anthropic.com.attacker.invalid/v1", "http://api.anthropic.com/v1/messages", "https://api.anthropic.com"]) {
    await assert.rejects(pinned(url), /official address/, url);
  }
  assert.equal(calls.length, 1);
});

test("custom-header variables are parsed into removals, as the SDKs parse them", () => {
  assert.deepEqual(removeEnvHeaders("OPENAI_CUSTOM_HEADERS", { OPENAI_CUSTOM_HEADERS: "a: 1\nB-Two : x:y\nnot a header" }), { a: null, "B-Two": null });
  assert.deepEqual(removeEnvHeaders("ANTHROPIC_CUSTOM_HEADERS", {}), {});
});

/** A local HTTP server that records every request it gets. */
async function recordingServer(answer: (path: string) => { status: number; headers?: Record<string, string> }) {
  const received: { method: string; path: string; headers: Record<string, unknown>; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body });
      const { status, headers } = answer(request.url ?? "");
      response.writeHead(status, headers).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive connections would otherwise hold the server open.
      server.closeAllConnections();
    });
  return { origin, received, close };
}

test("the pinned fetch never follows a redirect: the other host receives nothing", { timeout: 10_000 }, async () => {
  const elsewhere = await recordingServer(() => ({ status: 200 }));
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      const pinnedHost = await recordingServer(() => ({ status, headers: { location: `${elsewhere.origin}/stolen` } }));
      try {
        const pinned = pinnedFetch(`${pinnedHost.origin}/v1`);
        await assert.rejects(
          pinned(`${pinnedHost.origin}/v1/messages`, { method: "POST", headers: { "x-api-key": "test-key-not-real" }, body: '{"pdf":"BASE64-PDF-DATA"}' }),
          /redirect, which the app never follows/,
          String(status),
        );
        assert.equal(pinnedHost.received.length, 1, String(status));
      } finally {
        await pinnedHost.close();
      }
    }
    assert.deepEqual(elsewhere.received, [], "neither the body nor the key reached the other host");
  } finally {
    await elsewhere.close();
  }
});

test("the pinned fetch passes ordinary answers through, errors included", async () => {
  const pinnedHost = await recordingServer((path) => ({ status: path.endsWith("/missing") ? 404 : 200 }));
  try {
    const pinned = pinnedFetch(`${pinnedHost.origin}/v1`);
    assert.equal((await pinned(`${pinnedHost.origin}/v1/models`)).status, 200);
    assert.equal((await pinned(`${pinnedHost.origin}/v1/missing`)).status, 404);
  } finally {
    await pinnedHost.close();
  }
});
