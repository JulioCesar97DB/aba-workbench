import { ProviderError } from "./types.ts";

/*
 * Where each provider's requests may go, and nowhere else. The SDKs read their base URL,
 * extra headers and other settings from environment variables when the client is not
 * given them; a desktop app inherits the user's environment, so each client is given
 * every one of them explicitly (anthropic.ts, openai.ts), and its fetch refuses any
 * other destination. Environment variables the SDKs read (checked in @anthropic-ai/sdk
 * 1.12.0 and openai 7.62.0, 2026-11-22) and how each is neutralised:
 *
 *   ANTHROPIC_BASE_URL, OPENAI_BASE_URL          baseURL given; fetch pinned to it
 *   ANTHROPIC_CUSTOM_HEADERS, OPENAI_CUSTOM_HEADERS
 *                                                each header they name is set to null,
 *                                                which the SDKs treat as "remove"
 *   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,      apiKey given: the SDKs then read none
 *   OPENAI_API_KEY, ANTHROPIC_PROFILE,            of the key, token or credential-file
 *   ANTHROPIC_CONFIG_DIR, ANTHROPIC_IDENTITY_*,   variables
 *   ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_WORKSPACE_ID,
 *   ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_SCOPE
 *   OPENAI_ADMIN_KEY, OPENAI_ORG_ID,              given as null
 *   OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET,
 *   ANTHROPIC_WEBHOOK_SIGNING_KEY
 *   ANTHROPIC_OPEN_TELEMETRY*                     openTelemetry: false (no spans, no
 *                                                trace headers)
 *   ANTHROPIC_LOG, OPENAI_LOG                     logLevel: "off"
 * Not used by this project's calls: ANTHROPIC_WORK_*, ANTHROPIC_ENVIRONMENT_*,
 * ANTHROPIC_SESSION_ID and HOSTNAME (Anthropic's agent workers), OPENAI_ENDPOINT and
 * OPENAI_API_VERSION (the Azure client).
 */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The headers a custom-headers variable would add, each set to null so the SDK removes
 * it. Parsed as the SDKs parse it: one "name: value" per line.
 */
export function removeEnvHeaders(variable: "ANTHROPIC_CUSTOM_HEADERS" | "OPENAI_CUSTOM_HEADERS", env: NodeJS.ProcessEnv = process.env): Record<string, null> {
  const removals: Record<string, null> = {};
  for (const line of env[variable]?.trim().split("\n") ?? []) {
    const colon = line.indexOf(":");
    if (colon >= 0) removals[line.substring(0, colon).trim()] = null;
  }
  return removals;
}

/**
 * A fetch that sends requests only under `baseURL` and never follows a redirect: a
 * redirect would re-send the request (the case's documents, and on some hops the key) to
 * wherever it points, and the providers' APIs never legitimately redirect. Anything else
 * is refused before it is sent, and a redirect answer is refused when it arrives.
 */
export function pinnedFetch(baseURL: string, inner: typeof fetch = fetch): typeof fetch {
  const prefix = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(prefix)) {
      throw new ProviderError("blocked_endpoint", "The request was stopped: it was not going to the provider's official address.");
    }
    const response = await inner(input, { ...init, redirect: "manual" });
    // Node's fetch returns the 3xx itself; a browser-style fetch reports "opaqueredirect".
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ProviderError("blocked_redirect", "The request was stopped: the provider answered with a redirect, which the app never follows.");
    }
    return response;
  }) as typeof fetch;
}
