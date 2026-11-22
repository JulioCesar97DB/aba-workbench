import { requestTooLargeMessage } from "@/lib/limits";
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
  // same answer locally and if the platform limit is ever raised.
  const tooLarge = requestTooLargeMessage(Number(request.headers.get("content-length") ?? 0));
  if (tooLarge) return jsonError(413, "payload_too_large", tooLarge);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "bad_json", "The request body must be JSON.");
  }
  const parsed = parseGenerateBody(raw);
  if (!parsed.ok) return jsonError(400, "bad_request", parsed.error);
  const body = parsed.value;

  const provider = getProvider(body.provider);
  if (!provider) return jsonError(400, "unknown_provider", "provider must be anthropic or openai.");

  const { prompt, rulesVersions } = await buildPrompt(body.section, body.sources);

  return eventStream(request.signal, async (send, signal) => {
    const options = { apiKey, model: body.model, effort: body.effort, maxOutputTokens: body.maxOutputTokens, prompt, signal };
    send("meta", { provider: provider.id, model: body.model, section: body.section, effort: body.effort, mode: body.mode, rulesVersions });

    if (body.mode === "prewarm") {
      const usage = await provider.prewarm(options);
      send("done", { stopReason: "prewarm", servedModel: body.model, usage });
      return;
    }
    for await (const event of provider.generate(options)) {
      const { type, ...data } = event;
      send(type, data);
    }
  });
}
