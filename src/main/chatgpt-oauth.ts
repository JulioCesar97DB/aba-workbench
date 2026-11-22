import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { OPENAI_BASE_URL, pinnedFetch } from "../lib/providers/endpoints.ts";
import { OPENAI_ISSUER } from "./credentials.ts";

/*
 * Sign in with ChatGPT for open-source apps that run on the user's computer, as OpenAI
 * documents it (developers.openai.com/siwc/token-sharing-open-source and its pages, read
 * in full on 2026-11-22): dynamic client registration, PKCE (S256), a loopback redirect
 * on 127.0.0.1, the ChatGPT plan scopes, ID-token validation against OpenAI's published
 * keys (jose, owner's decision), rotating refresh tokens and revocation on sign-out.
 * Every request goes to https://auth.openai.com only, never follows a redirect, and never
 * puts a token in a URL; nothing here logs a token. Nothing here imports Electron.
 */

/** OpenAI's endpoints, as its discovery document (auth.openai.com/.well-known/openid-configuration) lists them. */
export const OPENAI_AUTH_BASE = OPENAI_ISSUER;
export const AUTHORIZE_URL = `${OPENAI_AUTH_BASE}/api/accounts/authorize`;
export const TOKEN_URL = `${OPENAI_AUTH_BASE}/api/accounts/oauth/token`;
export const REVOKE_URL = `${OPENAI_AUTH_BASE}/api/accounts/oauth/revoke`;
export const JWKS_URL = `${OPENAI_AUTH_BASE}/.well-known/jwks.json`;

/** The resource every token is for: the public API, where Responses and the model list are. */
export const OPENAI_RESOURCE = OPENAI_BASE_URL;
/** The first-registration entry point. Never saved, never used to exchange a code. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** agent_name_hint: the app's actual name, the same on every installation. */
export const AGENT_NAME = "ABA Workbench";
/** Identity, then ChatGPT plan use. */
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] as const;
/** The scope that lets the app use the user's ChatGPT plan; a valid ID token alone does not. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/auth/callback";

/** Random, URL-safe: state, nonce and the PKCE verifier. 32 bytes give 43 characters. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** The PKCE challenge (S256): the verifier's SHA-256, base64url, no padding. The verifier never leaves the main process but for the code exchange. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Compares a value that came back with the one sent, in constant time. */
export function sameSecret(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One sign-in attempt's values, fresh every time and kept until the callback completes. */
export interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  /** http://127.0.0.1:<port>/auth/callback, exactly the same in the authorization and the exchange. */
  redirectUri: string;
  /** The issued client id, or DYNAMIC_CLIENT_ID for a first registration. */
  clientId: string;
  hostId: string;
}

/** Fresh state, nonce and PKCE verifier (64 characters, inside RFC 7636's 43 to 128). */
export function newAttempt(options: { redirectUri: string; clientId: string; hostId: string; state?: string }): Attempt {
  return { nonce: randomToken(), verifier: randomToken(48), ...options, state: options.state ?? randomToken() };
}

/**
 * The authorize address the system browser opens. A first registration sends
 * dynamic_agent_client and agent_name_hint; a later sign-in sends the issued client id,
 * and the retained ID token and email as hints when the app still has them. `consent`
 * asks OpenAI to show the consent screen again (prompt=consent), for a user who earlier
 * did not allow plan use. It holds an ID token: it is never logged.
 */
export function authorizeUrl(attempt: Attempt, hints: { idToken?: string | null; email?: string | null; consent?: boolean } = {}): string {
  const params = new URLSearchParams({ client_id: attempt.clientId });
  if (attempt.clientId === DYNAMIC_CLIENT_ID) params.set("agent_name_hint", AGENT_NAME);
  params.set("ext_agent_host_id", attempt.hostId);
  if (attempt.clientId !== DYNAMIC_CLIENT_ID && hints.idToken) params.set("id_token_hint", hints.idToken);
  if (attempt.clientId !== DYNAMIC_CLIENT_ID && hints.email) params.set("login_hint", hints.email);
  params.set("response_type", "code");
  params.set("redirect_uri", attempt.redirectUri);
  params.set("scope", SCOPES.join(" "));
  params.set("resource", OPENAI_RESOURCE);
  params.set("state", attempt.state);
  params.set("nonce", attempt.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", pkceChallenge(attempt.verifier));
  if (hints.consent) params.set("prompt", "consent");
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** An issued client id as the callback gives it ("oaiapp_..."): plain characters, never the registration entry point. */
export function isIssuedClientId(value: string | null): value is string {
  return value !== null && value !== DYNAMIC_CLIENT_ID && /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

/** Why an OAuth call failed: `code` is OpenAI's machine-readable error, or "unreachable" when nothing answered. */
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, status: number | null) {
    // Only the code and the status: an error body could echo a token back.
    super(`OpenAI sign-in error: ${code}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

/** Refresh errors that mean the refresh token can never work again: sign in again (errors-and-recovery). */
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(20_000),
  refresh_token: z.string().min(1).max(20_000).optional(),
  id_token: z.string().min(1).max(20_000).optional(),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(366 * 24 * 3600),
  scope: z.string().max(2_000).optional(),
  // The token reference names it but not its form: Unix seconds or an ISO time are read;
  // anything else is ignored rather than failing a sign-in that is otherwise fine.
  earliest_refresh_at: z.union([z.number(), z.string()]).nullish().catch(null),
});

/** A token response, read: times as ISO strings, scopes as a list. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: string;
  earliestRefreshAt: string | null;
  /** Null when the response did not list them. */
  scopes: string[] | null;
}

export function readTokenResponse(body: unknown, now: number): TokenSet | null {
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    idToken: t.id_token ?? null,
    expiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    earliestRefreshAt: readTime(t.earliest_refresh_at),
    scopes: t.scope === undefined ? null : t.scope.split(" ").filter(Boolean),
  };
}

function readTime(value: number | string | null | undefined): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 1e9 && value < 1e11 ? new Date(value * 1000).toISOString() : null;
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}

/** OpenAI's error code from an OAuth error body: {"error": "invalid_grant"} or {"error": {"code": "..."}}. */
export function oauthErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 100);
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code.slice(0, 100);
  return null;
}

/** What the app keeps from a validated ID token. */
export interface Identity {
  subject: string;
  email: string | null;
  /** The account's display name, cleaned for showing (no control or text-direction characters). */
  name: string | null;
}

/** A name to show: NFC, trimmed, no control or text-direction characters, at most 100 characters; null otherwise. */
export function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").replace(/[\p{Cc}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, "").trim();
  if (name === "") return null;
  return [...name].length > 100 ? [...name].slice(0, 100).join("") : name;
}

const JwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.string() })).min(1).max(50) });

/** The calls to OpenAI's auth server. Tests pass a stub fetch, so no network is touched. */
export class OAuthClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private jwks: ReturnType<typeof createLocalJWKSet> | null = null;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    // Resolved per call, so a test that replaces the global fetch is seen.
    this.fetch = pinnedFetch(OPENAI_AUTH_BASE, options.fetch ?? ((input, init) => globalThis.fetch(input, init)));
    this.now = options.now ?? Date.now;
  }

  /** Exchanges the callback's code. Needs the issued client id, the same redirect URI and the PKCE verifier. */
  async exchangeCode(attempt: Attempt, code: string, clientId: string, signal?: AbortSignal): Promise<TokenSet> {
    return this.tokenRequest(
      {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.redirectUri,
      resource: OPENAI_RESOURCE,
      },
      signal,
    );
  }

  /** Standard refresh, with the issued client id; no scope, so the grant is kept. */
  async refresh(clientId: string, refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: OPENAI_RESOURCE });
  }

  /**
   * Ends the renewable session. True when OpenAI confirmed it (an empty 200, also for a
   * token that was already invalid). Throws OAuthError "unreachable" or with the status of
   * a 5xx, which the caller retries; false for any other answer.
   */
  async revoke(clientId: string, refreshToken: string): Promise<boolean> {
    const response = await this.post(REVOKE_URL, { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId });
    await response.body?.cancel();
    if (response.status >= 500) throw new OAuthError("server_error", response.status);
    return response.status === 200;
  }

  /**
   * Validates an ID token: its RS256 signature against OpenAI's published keys, the
   * issuer, the audience (the issued client id), the expiry (5 seconds' tolerance), and,
   * after a sign-in, the nonce sent for that attempt.
   */
  async verifyIdToken(idToken: string, expected: { clientId: string; nonce: string | null }, signal?: AbortSignal): Promise<Identity> {
    const verify = async (keys: ReturnType<typeof createLocalJWKSet>) =>
      jwtVerify(idToken, keys, {
        issuer: OPENAI_ISSUER,
        audience: expected.clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
    // Fetching the keys can fail on its own (no answer, a bad answer): that error passes
    // through as it is, so "could not reach OpenAI" is never reported as a bad token.
    let result;
    try {
      result = await verify(await this.keys(false, signal));
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      // A key OpenAI added since the keys were fetched: fetch them again, once.
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw new OAuthError("invalid_id_token", null);
      const keys = await this.keys(true, signal);
      try {
        result = await verify(keys);
      } catch {
        throw new OAuthError("invalid_id_token", null);
      }
    }
    const claims = result.payload;
    if (expected.nonce !== null && (typeof claims.nonce !== "string" || !sameSecret(expected.nonce, claims.nonce))) throw new OAuthError("invalid_id_token", null);
    if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 500) throw new OAuthError("invalid_id_token", null);
    const email = typeof claims.email === "string" && claims.email.length <= 320 && claims.email.includes("@") ? claims.email : null;
    return { subject: claims.sub, email, name: displayName(claims.name) };
  }

  private async keys(refetch: boolean, signal?: AbortSignal): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.jwks && !refetch) return this.jwks;
    let response: Response;
    try {
      response = await this.fetch(JWKS_URL, { headers: { accept: "application/json" }, signal: withTimeout(signal) });
    } catch {
      throw new OAuthError(signal?.aborted ? "cancelled" : "unreachable", null);
    }
    const body = await response.json().catch(() => null);
    const parsed = JwksSchema.safeParse(body);
    if (!response.ok || !parsed.success) throw new OAuthError("invalid_jwks", response.status);
    this.jwks = createLocalJWKSet(parsed.data as unknown as JSONWebKeySet);
    return this.jwks;
  }

  private async tokenRequest(form: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
    const response = await this.post(TOKEN_URL, form, signal);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new OAuthError(oauthErrorCode(body) ?? (response.status >= 500 ? "server_error" : "token_error"), response.status);
    const tokens = readTokenResponse(body, this.now());
    if (!tokens) throw new OAuthError("invalid_token_response", response.status);
    return tokens;
  }

  private async post(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: withTimeout(signal),
      });
    } catch {
      // The pinned fetch's own refusals (another address, a redirect) count as no answer too.
      throw new OAuthError(signal?.aborted ? "cancelled" : "unreachable", null);
    }
  }
}

/** Every call to OpenAI's auth server gives up after 30 seconds, or when the sign-in is cancelled. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
