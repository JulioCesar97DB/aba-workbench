import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REQUEST_BODY_BYTES, readBodyWithLimit, requestTooLargeMessage } from "../src/lib/limits.ts";
import { parseGenerateBody } from "../src/lib/request.ts";

test("size guard: 4.5 MB passes, one byte more is refused with the paste-the-text message", () => {
  assert.equal(requestTooLargeMessage(MAX_REQUEST_BODY_BYTES), null);
  assert.match(requestTooLargeMessage(MAX_REQUEST_BODY_BYTES + 1) ?? "", /Paste the text/);
  assert.match(requestTooLargeMessage(5_000_000, false) ?? "", /are larger than the 4\.5 MB/);
  assert.match(requestTooLargeMessage(5_000_000) ?? "", /add up to 5\.0 MB, more than the 4\.5 MB/);
});

function chunkedRequest(totalBytes: number): Request {
  const chunk = new Uint8Array(500_000).fill(120);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const size = Math.min(chunk.length, totalBytes - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
  return new Request("http://localhost/api/generate", { method: "POST", body, duplex: "half" } as RequestInit);
}

test("size guard: a chunked body without Content-Length is cut at the limit", async () => {
  const over = await readBodyWithLimit(chunkedRequest(5_000_000));
  assert.equal(over.ok, false);
  const under = await readBodyWithLimit(chunkedRequest(1_000_000));
  assert.ok(under.ok);
  assert.equal(under.text.length, 1_000_000);
});

const valid = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  section: "medical-necessity",
  sources: [{ id: "cde", title: "CDE", kind: "text", text: "notes" }],
};

test("request validation: defaults and rejections", () => {
  const ok = parseGenerateBody(valid);
  assert.ok(ok.ok);
  assert.equal(ok.value.effort, "high");
  assert.equal(ok.value.maxOutputTokens, 32_000);
  assert.equal(ok.value.mode, "generate");

  const bad: Array<[string, unknown]> = [
    ["not an object", "x"],
    ["unknown section", { ...valid, section: "nope" }],
    ["bad effort", { ...valid, effort: "huge" }],
    ["tiny output budget", { ...valid, maxOutputTokens: 10 }],
    ["no sources", { ...valid, sources: [] }],
    ["bad source id", { ...valid, sources: [{ id: "Bad Id", title: "t", kind: "text", text: "x" }] }],
    ["pdf without .pdf name", { ...valid, sources: [{ id: "a", title: "t", kind: "pdf", filename: "a.txt", base64: "QQ==" }] }],
    ["pdf with line breaks", { ...valid, sources: [{ id: "a", title: "t", kind: "pdf", filename: "a.pdf", base64: "QQ==\nQQ==" }] }],
    ["bad mode", { ...valid, mode: "other" }],
  ];
  for (const [name, body] of bad) assert.equal(parseGenerateBody(body).ok, false, name);
});
