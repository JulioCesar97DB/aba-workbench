import { readBodyWithLimit, requestTooLargeMessage } from "@/lib/limits";
import { getProvider } from "@/lib/providers";
import { KEY_HEADER, parseGenerateBody } from "@/lib/request";
import { buildPrompt } from "@/lib/rules";
import { eventStream, jsonError } from "@/lib/sse";

/**
 * Hobby's ceiling (and every plan's default) is 300 seconds; Pro allows up to 800.
 * Streaming does not extend it: the whole response must finish inside this window.
 */
export const maxDuration = 300;

// Nothing in this file logs the request: not the key, not the body, not the sources.
export async function POST(request: Request): Promise<Response> {
  const apiKey = request.headers.get(KEY_HEADER)?.trim();
  if (!apiKey) return jsonError(401, "missing_key", `Send the provider API key in the ${KEY_HEADER} header.`);

  // On Vercel the platform rejects oversized bodies before this runs; this gives the
  // same answer locally, for chunked bodies, and if the platform limit is ever raised.
  const declared = requestTooLargeMessage(Number(request.headers.get("content-length") ?? 0));
  if (declared) return jsonError(413, "payload_too_large", declared);
  const body = await readBodyWithLimit(request);
  if (!body.ok) return jsonError(413, "payload_too_large", requestTooLargeMessage(body.bytesRead, false)!);

  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return jsonError(400, "bad_json", "The request body must be JSON.");
  }
  const parsed = parseGenerateBody(raw);
  if (!parsed.ok) return jsonError(400, "bad_request", parsed.error);
  const input = parsed.value;

  const provider = getProvider(input.provider);
  if (!provider) return jsonError(400, "unknown_provider", "provider must be anthropic or openai.");

  let built: Awaited<ReturnType<typeof buildPrompt>>;
  try {
    built = await buildPrompt(input.section, input.sources);
  } catch {
    return jsonError(500, "rules_error", "The writing rules could not be loaded on the server.");
  }
  const { prompt, rulesVersions } = built;

  return eventStream(request.signal, async (send, signal) => {
    const options = { apiKey, model: input.model, effort: input.effort, maxOutputTokens: input.maxOutputTokens, prompt, signal };
    send("meta", { provider: provider.id, model: input.model, section: input.section, effort: input.effort, mode: input.mode, rulesVersions });

    if (input.mode === "prewarm") {
      const usage = await provider.prewarm(options);
      send("done", { complete: true, stopReason: "prewarm", servedModel: input.model, usage, attempts: null });
      return;
    }
    for await (const event of provider.generate(options)) {
      const { type, ...data } = event;
      send(type, data);
    }
  });
}
