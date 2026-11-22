import { anthropicProvider } from "../lib/providers/anthropic.ts";
import { toSafeError } from "../lib/providers/index.ts";
import type { Provider } from "../lib/providers/types.ts";

/*
 * The Claude key the user pastes in Settings. Anthropic does not let other apps offer
 * Claude.ai sign-in, so Claude connects with an API key from the user's Anthropic Console
 * account. The key is checked with a free call (the model list) before it is saved, and
 * it is never logged, never put in an error, and never sent anywhere but Anthropic's
 * official address (src/lib/providers/endpoints.ts). Nothing here imports Electron.
 */

/** Every Claude API key starts with this ("sk-ant-api03-..." today). */
export const CLAUDE_KEY_PREFIX = "sk-ant-";
/** Far longer than any real key; a longer text is not a key. */
const MAX_KEY_LENGTH = 400;

export type ClaudeKeyShape = { ok: true; key: string } | { ok: false; problem: "empty" | "not-a-claude-key" };

/**
 * Whether the pasted text is shaped like a Claude key, before anything is sent: spaces
 * and line breaks at either end are dropped (a copy often takes them), and what is left
 * must be one run of visible ASCII characters starting with sk-ant-. Another provider's
 * key (OpenAI's sk-proj-..., say) is not sent to Anthropic.
 */
export function checkClaudeKeyShape(raw: string): ClaudeKeyShape {
  const key = raw.trim();
  if (key === "") return { ok: false, problem: "empty" };
  if (!key.startsWith(CLAUDE_KEY_PREFIX) || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    return { ok: false, problem: "not-a-claude-key" };
  }
  return { ok: true, key };
}

/** What Anthropic said about a key. */
export type KeyVerdict = "accepted" | "rejected" | "unreachable" | "provider-error";

/** How long a check may take before it counts as "could not reach Anthropic". */
export const KEY_CHECK_TIMEOUT_MS = 20_000;

/**
 * Asks Anthropic for its model list with the key: free, and it fails with 401 for a key
 * that is not valid (403 for one that may not list models, which cannot be used either).
 */
export async function verifyClaudeKey(key: string, provider: Provider = anthropicProvider, timeoutMs = KEY_CHECK_TIMEOUT_MS): Promise<KeyVerdict> {
  try {
    await provider.listModels({ kind: "api-key", apiKey: key }, AbortSignal.timeout(timeoutMs));
    return "accepted";
  } catch (error) {
    const safe = toSafeError(error);
    if (safe.code === "invalid_key" || safe.code === "forbidden") return "rejected";
    // No answer at all: a connection error, a timeout, or the pinned fetch's refusal.
    if (safe.status === null) return "unreachable";
    return "provider-error";
  }
}
