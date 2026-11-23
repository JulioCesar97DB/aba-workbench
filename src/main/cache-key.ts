import { createHash } from "node:crypto";

/*
 * The prompt-cache key of a case (owner's decision, 2026-11-23): on the ChatGPT route every
 * request of one case sends the same `prompt_cache_key`, so OpenAI routes them to where
 * that case's rules and sources are cached. A key goes to OpenAI with each request, so it
 * must say nothing about the client: it is a hash of the case's internal id (a random
 * UUID the app made), never of the client's name, the case's folder name or anything she
 * wrote. The fixed prefix inside the hash keeps it from matching a plain hash of the id
 * used anywhere else.
 */

const DOMAIN = "aba-workbench prompt-cache key v1:";

/** "aba-" and 32 base64url characters: the same for every request of one case, different for each case. */
export function caseCacheKey(caseId: string): string {
  return `aba-${createHash("sha256").update(DOMAIN + caseId).digest("base64url").slice(0, 32)}`;
}
