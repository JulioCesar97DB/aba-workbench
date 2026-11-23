import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { CapturedRequest } from "./helpers.ts";

/*
 * OpenAI's auth server and the ChatGPT model list, faked for tests: a signing key of
 * its own, ID tokens signed with it, and a fetch that answers the token, revocation, JWKS
 * and model-list addresses. No network is touched and no real account is involved.
 */

export const ISSUED_CLIENT_ID = "oaiapp_test_client_not_real";
export const SUBJECT = "user-subject-not-real";

export interface FakeOpenAI {
  fetch: typeof fetch;
  calls: Array<CapturedRequest & { form: URLSearchParams | null }>;
  /** Signs an ID token; claims override the defaults. */
  idToken(claims: Record<string, unknown>, options?: { key?: "own" | "other"; kid?: string }): Promise<string>;
  /** What the token endpoint answers next (one entry per call; the last repeats). */
  tokenAnswers: Array<(form: URLSearchParams) => Response | Promise<Response>>;
  revokeAnswers: Array<() => Response>;
  modelsAnswer: (authorization: string | null) => Response;
  jwks: { keys: JWK[] };
}

let keys: Promise<{ own: CryptoKey; other: CryptoKey; jwk: JWK }> | null = null;
function signingKeys() {
  keys ??= (async () => {
    const own = await generateKeyPair("RS256", { extractable: true });
    const other = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(own.publicKey)), kid: "test-key-1", alg: "RS256", use: "sig" };
    return { own: own.privateKey, other: other.privateKey, jwk };
  })();
  return keys;
}

export async function fakeOpenAI(now: () => number = Date.now): Promise<FakeOpenAI> {
  const { own, other, jwk } = await signingKeys();
  const fake: FakeOpenAI = {
    calls: [],
    jwks: { keys: [jwk] },
    tokenAnswers: [],
    revokeAnswers: [() => new Response(null, { status: 200 })],
    modelsAnswer: () => Response.json({ models: [{ slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list" }] }),
    async idToken(claims, options = {}) {
      const seconds = Math.floor(now() / 1000);
      return new SignJWT({ email: "clinician@example.invalid", name: "Test Clinician", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test-key-1" })
        .setIssuer((claims.iss as string) ?? "https://auth.openai.com")
        .setAudience((claims.aud as string | string[]) ?? [ISSUED_CLIENT_ID])
        .setSubject((claims.sub as string) ?? SUBJECT)
        .setIssuedAt(seconds)
        .setExpirationTime((claims.exp as number) ?? seconds + 3600)
        .sign(options.key === "other" ? other : own);
    },
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const raw = typeof init?.body === "string" ? init.body : null;
      const form = raw !== null && !raw.startsWith("{") ? new URLSearchParams(raw) : null;
      const headers = new Headers(init?.headers);
      fake.calls.push({ url, headers, body: null, form });
      if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json(fake.jwks);
      if (url === "https://auth.openai.com/api/accounts/oauth/token") {
        const answer = fake.tokenAnswers.length > 1 ? fake.tokenAnswers.shift()! : fake.tokenAnswers[0];
        if (!answer) return Response.json({ error: "invalid_request" }, { status: 400 });
        return answer(form ?? new URLSearchParams());
      }
      if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
        const answer = fake.revokeAnswers.length > 1 ? fake.revokeAnswers.shift()! : fake.revokeAnswers[0];
        return answer();
      }
      if (url === "https://api.openai.com/v1/models") return fake.modelsAnswer(headers.get("authorization"));
      return new Response("not faked", { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}

/** A token endpoint answer, as OpenAI's token reference describes it. */
export function tokenResponse(fields: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: "access-token-not-real",
    refresh_token: "refresh-token-not-real",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
    ...fields,
  });
}
