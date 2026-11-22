import { getProvider, rankModels, toSafeError } from "@/lib/providers";
import { KEY_HEADER } from "@/lib/request";
import { jsonError } from "@/lib/sse";

/**
 * GET /api/models?provider=anthropic|openai with the key in the x-provider-key header.
 * Returns the provider's live model list, most capable first, and the default pick.
 */
export async function GET(request: Request): Promise<Response> {
  const apiKey = request.headers.get(KEY_HEADER)?.trim();
  if (!apiKey) return jsonError(401, "missing_key", `Send the provider API key in the ${KEY_HEADER} header.`);

  const providerId = new URL(request.url).searchParams.get("provider") ?? "";
  const provider = getProvider(providerId);
  if (!provider) return jsonError(400, "unknown_provider", "provider must be anthropic or openai.");

  try {
    const models = rankModels(provider.id, await provider.listModels(apiKey, request.signal));
    return Response.json(
      { provider: provider.id, defaultModel: models[0]?.id ?? null, models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const safe = toSafeError(error);
    return jsonError(safe.status && safe.status >= 400 ? safe.status : 502, safe.code, safe.message);
  }
}
