import assert from "node:assert/strict";
import { test } from "node:test";
import { measureRequest, PROVIDER_REQUEST_LIMITS, requestTooLargeMessage } from "../src/lib/limits.ts";
import type { PromptParts } from "../src/lib/providers/types.ts";

function prompt(pdfBytes: number[], textChars = 0): PromptParts {
  return {
    system: "RULES",
    task: "TASK",
    sources: [
      ...(textChars ? [{ id: "notes", title: "Notes", kind: "text" as const, text: "x".repeat(textChars) }] : []),
      ...pdfBytes.map((bytes, i) => ({ id: `pdf-${i}`, title: "Report", kind: "pdf" as const, filename: "report.pdf", base64: Buffer.alloc(bytes).toString("base64") })),
    ],
  };
}

const size = (requestBytes: number, fileBytes: number, encodedFileBytes = Math.ceil(fileBytes / 3) * 4) => ({ requestBytes, fileBytes, encodedFileBytes });

test("size: PDFs are counted at their file size and as sent; the request at its JSON size", () => {
  const measured = measureRequest(prompt([1_000, 2_001]));
  assert.equal(measured.fileBytes, 3_001);
  assert.equal(measured.encodedFileBytes, Buffer.alloc(1_000).toString("base64").length + Buffer.alloc(2_001).toString("base64").length);
  assert.ok(measured.requestBytes > 4_000 && measured.requestBytes < 4_400, String(measured.requestBytes));
});

test("size: Claude's limit is on the whole request, 128 MB", () => {
  const { maxBytes } = PROVIDER_REQUEST_LIMITS.anthropic;
  assert.equal(maxBytes, 128_000_000);
  assert.equal(requestTooLargeMessage("anthropic", size(maxBytes, 0)), null);
  const message = requestTooLargeMessage("anthropic", size(131_200_000, 0)) ?? "";
  assert.match(message, /This request is 131\.2 MB/);
  assert.match(message, /128 MB/);
  assert.match(message, /Remove a PDF, or paste the text/);
  // Base64 makes a PDF a third larger: about 96 MB of PDFs already fills the request.
  assert.equal(requestTooLargeMessage("anthropic", measureRequest(prompt([60_000_000]))), null);
  assert.notEqual(requestTooLargeMessage("anthropic", measureRequest(prompt([50_000_000, 50_000_000]))), null);
});

test("size: OpenAI's limit is on the files as sent (base64), 50 MB together", () => {
  const { maxBytes } = PROVIDER_REQUEST_LIMITS.openai;
  assert.equal(maxBytes, 50_000_000);
  // 37.5 MB of PDF is 50 MB of base64: it fits; one more byte of PDF does not.
  assert.equal(requestTooLargeMessage("openai", measureRequest(prompt([37_500_000]))), null);
  assert.notEqual(requestTooLargeMessage("openai", measureRequest(prompt([37_500_003]))), null);
  assert.equal(requestTooLargeMessage("openai", size(500_000_000, 1, maxBytes)), null, "the rest of the request does not count");
  // The reviewer's case: 40 MB of PDFs, over the limit only once encoded.
  const message = requestTooLargeMessage("openai", size(0, 40_000_000, 53_333_336)) ?? "";
  assert.equal(
    message,
    "The PDFs in this request are 40.0 MB; sent to OpenAI they become 53.3 MB, over its 50 MB limit for files in one request. Remove a PDF, or paste the text of a report instead of attaching its PDF.",
  );
  assert.match(message, /Remove a PDF, or paste the text/);
});

test("size: the mock provider has no limit; every real provider has one with its source", () => {
  assert.equal(requestTooLargeMessage("mock", size(1e12, 1e12, 1e12)), null);
  for (const [provider, limit] of Object.entries(PROVIDER_REQUEST_LIMITS)) {
    assert.match(limit.source, /^https:\/\//, provider);
    assert.match(limit.checkedOn, /^\d{4}-\d{2}-\d{2}$/, provider);
  }
  assert.equal(PROVIDER_REQUEST_LIMITS.anthropic.maxPdfPages, 600);
});
