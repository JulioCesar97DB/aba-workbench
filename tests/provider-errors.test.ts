import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { isPdfPageLimitError } from "../src/lib/limits.ts";
import { toProviderError as anthropicError } from "../src/lib/providers/anthropic.ts";
import { toProviderError as openaiError } from "../src/lib/providers/openai.ts";

const headers = new Headers();

test("Claude 413 request_too_large: the size limit and what to do", () => {
  const error = anthropicError(
    Anthropic.APIError.generate(413, { type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } }, undefined, headers),
  );
  assert.equal(error?.code, "request_too_large");
  assert.match(error?.message ?? "", /128 MB/);
  assert.match(error?.message ?? "", /Remove a PDF, or paste the text/);
});

test("Claude PDF page limit: explained, with Claude's own words kept", () => {
  const error = anthropicError(
    Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "A maximum of 600 PDF pages may be provided." } }, undefined, headers),
  );
  assert.equal(error?.code, "too_many_pdf_pages");
  assert.match(error?.message ?? "", /more pages than Claude accepts in one request \(600 for the models this app uses\)/);
  assert.match(error?.message ?? "", /Remove a PDF, or paste the text/);
  assert.match(error?.message ?? "", /A maximum of 600 PDF pages may be provided/);
});

test("Claude page-limit matching: only refusals shaped like a limit", () => {
  const limitShaped = ["A maximum of 600 PDF pages may be provided.", "The PDF exceeds the page limit.", "Too many PDF pages in this request", "PDFs may have at most 100 pages"];
  const other = ["PDF could not be parsed (page 3)", "The PDF on page 2 is encrypted", "max_tokens: too large", "Invalid page token"];
  for (const message of limitShaped) assert.equal(isPdfPageLimitError(message), true, message);
  for (const message of other) assert.equal(isPdfPageLimitError(message), false, message);
  const parse = anthropicError(
    Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "PDF could not be parsed (page 3)" } }, undefined, headers),
  );
  assert.equal(parse?.code, "bad_request");
  assert.match(parse?.message ?? "", /PDF could not be parsed \(page 3\)/);
});

test("other Claude 400s still pass Claude's message on", () => {
  const error = anthropicError(
    Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } }, undefined, headers),
  );
  assert.equal(error?.code, "bad_request");
  assert.match(error?.message ?? "", /max_tokens: too large/);
});

test("OpenAI 413: the files limit and what to do", () => {
  const error = openaiError(OpenAI.APIError.generate(413, { error: { message: "Request too large" } }, undefined, headers));
  assert.equal(error?.code, "request_too_large");
  assert.match(error?.message ?? "", /50 MB of files/);
  assert.match(error?.message ?? "", /Remove a PDF, or paste the text/);
});
