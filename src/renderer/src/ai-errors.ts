/*
 * What a failed AI request means for her, by kind (owner's decision T11). The screen says
 * the failure in a sentence of her language and what to do; the provider's own text, in
 * English, is only under "Technical details". No React here, so tests/ai-errors.test.ts
 * can check that every error code the app makes has its kind.
 */

export const AI_ERROR_KINDS = ["signIn", "plan", "connection", "busy", "limit", "tooLarge", "notAllowed", "refused", "caseFiles", "appFiles", "other"] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/**
 * Every code a failed request can carry (src/lib/providers/*.ts with OpenAI's ChatGPT
 * table, src/lib/generate.ts, src/main/), with its kind. A code missing here reads as
 * "other"; tests/ai-errors.test.ts reads the error tables and the source, so a new code
 * without a kind fails it. Each sentence says only what the code tells us.
 */
export const AI_ERROR_CODES: Record<string, AiErrorKind> = {
  // The saved sign-in or key no longer works, or the sign-in did not allow plan use: sign in or connect again in Settings.
  invalid_key: "signIn",
  chatgpt_signed_out: "signIn",
  chatgpt_not_authorized: "signIn",
  unsupported_credential: "signIn",
  // ChatGPT refused the account's plan: a paid plan may be needed; another account or Claude in Settings.
  chatgpt_not_eligible: "plan",
  chatgpt_not_allowed: "plan",
  // The provider could not be reached, or the connection dropped.
  connection_failed: "connection",
  timeout: "connection",
  stream_error: "connection",
  // The provider is busy just now: wait a few minutes.
  chatgpt_unavailable: "busy",
  provider_unavailable: "busy",
  // A usage limit (the plan's, or a key's rate or quota): wait a while, check the usage, or use the other AI.
  rate_limited: "limit",
  chatgpt_usage_limit: "limit",
  // The case's documents are too large to send together.
  request_too_large: "tooLarge",
  too_many_pdf_pages: "tooLarge",
  // An API key not allowed to use the model: another model or the other AI.
  forbidden: "notAllowed",
  model_not_found: "notAllowed",
  // The provider refused this request as it is: sending it again fails again.
  bad_request: "refused",
  // The case's documents could not be read before sending.
  prepare_failed: "caseFiles",
  // The app's own writing rules could not be loaded.
  rules_error: "appFiles",
  // Anything else: try again in a moment.
  bad_response: "other",
  provider_error: "other",
  internal_error: "other",
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
  return kind === "signIn" || kind === "plan" || kind === "notAllowed";
}
