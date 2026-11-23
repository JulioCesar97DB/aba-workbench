/*
 * What a failed AI request means for her, by kind (owner's decision T11). The screen says
 * the failure in a sentence of her language and what to do; the provider's own text, in
 * English, is only under "Technical details". No React here, so tests/ai-errors.test.ts
 * can check that every error code the app makes has its kind.
 */

export const AI_ERROR_KINDS = ["signIn", "connection", "busy", "tooLarge", "notAllowed", "caseFiles", "other"] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/**
 * Every code a failed request can carry (src/lib/providers/*.ts, src/lib/generate.ts,
 * src/main/), with its kind. A code missing here reads as "other"; the test lists the codes
 * in the source so a new one is not forgotten.
 */
export const AI_ERROR_CODES: Record<string, AiErrorKind> = {
  // The saved sign-in or key no longer works: connect again in Settings.
  invalid_key: "signIn",
  chatgpt_signed_out: "signIn",
  unsupported_credential: "signIn",
  // The provider could not be reached, or the connection dropped.
  connection_failed: "connection",
  timeout: "connection",
  stream_error: "connection",
  // The provider is busy, or a usage limit was reached: wait and try again.
  rate_limited: "busy",
  chatgpt_usage_limit: "busy",
  chatgpt_unavailable: "busy",
  provider_unavailable: "busy",
  // The case's documents are too large to send together.
  request_too_large: "tooLarge",
  too_many_pdf_pages: "tooLarge",
  // The account or the model is not allowed: another model or the other AI.
  forbidden: "notAllowed",
  chatgpt_not_allowed: "notAllowed",
  model_not_found: "notAllowed",
  // The case's documents could not be read before sending.
  prepare_failed: "caseFiles",
  // Anything else: try again in a moment.
  bad_request: "other",
  bad_response: "other",
  provider_error: "other",
  internal_error: "other",
  rules_error: "other",
  blocked_endpoint: "other",
  blocked_redirect: "other",
  cancelled: "other",
  chatgpt_unsupported: "other",
};

export function aiErrorKind(code: string): AiErrorKind {
  return Object.hasOwn(AI_ERROR_CODES, code) ? AI_ERROR_CODES[code] : "other";
}

/** The kinds whose way out is in Settings, so the message links there. */
export function aiErrorNeedsSettings(kind: AiErrorKind): boolean {
  return kind === "signIn" || kind === "notAllowed";
}
