import { openaiProvider } from "../lib/providers/openai.ts";
import { toSafeError } from "../lib/providers/index.ts";
import type { Provider } from "../lib/providers/types.ts";
import type {
  ChatGptConnection,
  ChatGptSignInResult,
  ChatGptSignOutResult,
  CheckConnectionResult,
  Language,
  RemoveConnectionResult,
} from "../shared/api.ts";
import { DYNAMIC_CLIENT_ID, PLAN_SCOPE, OAuthClient, OAuthError, TERMINAL_REFRESH_ERRORS, authorizeUrl, isIssuedClientId, newAttempt, randomToken, type Attempt, type TokenSet } from "./chatgpt-oauth.ts";
import { OPENAI_ISSUER, isSignedIn, type ChatGptRecord, type ChatGptSignedIn, type CredentialsStore } from "./credentials.ts";
import { startCallbackListener, type CallbackAnswer, type CallbackListener } from "./oauth-callback.ts";

/*
 * Sign in with ChatGPT, from the button to a working token: one attempt at a time, the
 * tokens refreshed before they expire, sign-out that ends the session with OpenAI, and the
 * states the interface shows. The steps follow OpenAI's documentation
 * (developers.openai.com/siwc/token-sharing-open-source, read 2026-11-22); docs/connections.md
 * lists them. Every step that fails is logged by name with OpenAI's error code, never with
 * a token, a code or an email. Nothing here imports Electron: the browser is opened through
 * `openBrowser`.
 */

/** How long a sign-in waits for the browser to come back (OpenAI's website example expires attempts after 10 minutes). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** A token this close to its expiry is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** After a refresh that could not reach OpenAI, the next try. */
export const REFRESH_RETRY_MS = 5 * 60_000;
/** The refresh timer never fires sooner than this after the last one, whatever the token's lifetime. */
export const MIN_REFRESH_DELAY_MS = 30_000;
/** Sign-out's revocation: tries, and the pause before each retry (network failures and 5xx only). */
export const REVOKE_RETRY_DELAYS_MS = [1_000, 3_000];

export function hasPlanScope(record: ChatGptSignedIn): boolean {
  return record.scopes.includes(PLAN_SCOPE);
}

/** When the token should be refreshed: REFRESH_MARGIN_MS before it expires, not before earliestRefreshAt unless it has expired. */
export function refreshDueAt(record: Pick<ChatGptSignedIn, "expiresAt" | "earliestRefreshAt">): number {
  const expires = Date.parse(record.expiresAt);
  const due = expires - REFRESH_MARGIN_MS;
  const earliest = record.earliestRefreshAt ? Date.parse(record.earliestRefreshAt) : Number.NEGATIVE_INFINITY;
  return Math.min(Math.max(due, earliest), expires);
}

/** What is left of a registration once its tokens go: the client id and the account, to sign in again to it. */
function signedOut(record: ChatGptRecord, sessionEnded: boolean): ChatGptRecord {
  return {
    issuer: OPENAI_ISSUER,
    clientId: record.clientId,
    ...(record.subject ? { subject: record.subject } : {}),
    signedOut: true,
    ...(sessionEnded ? { sessionEnded: true as const } : {}),
  };
}

/** The ChatGPT sign-in is not there, or cannot be used: `reason` says which. */
export class NotSignedIn extends Error {
  readonly reason: "not-connected" | "plan-not-allowed" | "plan-not-eligible" | "session-ended" | "unreachable";
  constructor(reason: NotSignedIn["reason"]) {
    super(`ChatGPT: ${reason}`);
    this.name = "NotSignedIn";
    this.reason = reason;
  }
}

interface Pending {
  otherPort: boolean;
  cancel: () => void;
}

export class ChatGptSession {
  private pending: Pending | null = null;
  /** The refresh running now: every caller waits on the same one, so a rotating token is never used twice. */
  private refreshing: Promise<string> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set when OpenAI said this account cannot use its plan in apps
   * (subscription_sharing_user_not_eligible), until the next sign-in or sign-out. OpenAI
   * asks apps not to repeat the request or loop through sign-in for it.
   */
  private notEligible = false;

  private readonly store: CredentialsStore;
  private readonly oauth: OAuthClient;
  private readonly openai: Provider;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly language: () => Promise<Language>;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly preferredPort: number | undefined;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    store: CredentialsStore;
    openBrowser: (url: string) => Promise<void>;
    /** The screen language, for the page the browser shows when it comes back. */
    language: () => Promise<Language>;
    onChange: () => void;
    oauth?: OAuthClient;
    openai?: Provider;
    now?: () => number;
    timeoutMs?: number;
    preferredPort?: number;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.store = options.store;
    this.openBrowser = options.openBrowser;
    this.language = options.language;
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.oauth = options.oauth ?? new OAuthClient({ now: this.now });
    this.openai = options.openai ?? openaiProvider;
    this.timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    this.preferredPort = options.preferredPort;
    this.log = options.log ?? ((message) => console.warn(message));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The state to show for what the file holds. `welcomeShown`: "You're using your ChatGPT plan" was already dismissed. */
  state(record: ChatGptRecord | null, options: { welcomeShown?: boolean } = {}): ChatGptConnection {
    if (this.pending) return { state: "signing-in", otherPort: this.pending.otherPort };
    if (record === null) return { state: "not-connected", savedAccount: false };
    if (!isSignedIn(record)) {
      return record.sessionEnded ? { state: "needs-attention", reason: "session-ended", displayName: null } : { state: "not-connected", savedAccount: true };
    }
    if (!hasPlanScope(record)) return { state: "needs-attention", reason: "plan-not-allowed", displayName: record.name };
    if (this.notEligible) return { state: "needs-attention", reason: "plan-not-eligible", displayName: record.name };
    if (this.store.hasUnsavedChange) return { state: "needs-attention", reason: "not-saved", displayName: record.name };
    return { state: "connected", displayName: record.name, showWelcome: options.welcomeShown === false };
  }

  /**
   * One sign-in: a fresh state, nonce and PKCE verifier, the listener started, then the
   * browser opened at OpenAI's authorize page. It waits for the one valid callback, the
   * cancel button or the timeout, whichever comes first; cancelling also stops the code
   * exchange and the key fetch that follow the callback.
   */
  async signIn(): Promise<ChatGptSignInResult> {
    if (this.pending) return { outcome: "already-signing-in" };
    // Claimed before the first await, so a second click cannot start a second attempt.
    const abort = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => (cancel = () => resolve("cancelled")));
    this.pending = {
      otherPort: false,
      cancel: () => {
        abort.abort();
        cancel();
      },
    };
    let listener: CallbackListener | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const read = await this.store.read();
      if (!read.ok) return { outcome: "credentials-problem", problem: read.problem };
      // The host id is saved before its first use, and never changes.
      let hostId: string;
      try {
        hostId = await this.store.hostId();
      } catch (error) {
        this.log(`ChatGPT sign-in: the credentials file could not be saved (${errorCode(error)}).`);
        return { outcome: "not-saved" };
      }
      const record = read.credentials?.chatgpt ?? null;
      const registration = record ? { clientId: record.clientId, subject: record.subject ?? null } : null;
      const signedIn = isSignedIn(record) ? record : null;

      // The listener starts before the browser opens; the redirect URI names its port.
      const state = randomToken();
      const language = await this.language().catch((): Language => "en");
      listener = await startCallbackListener({
        state,
        language: () => language,
        preferredPort: this.preferredPort,
        onRefused: (refusal) => this.log(`ChatGPT sign-in: a request to the callback address was refused (${refusal}).`),
      });
      if (!listener) {
        this.log("ChatGPT sign-in: no local port could be opened for the callback.");
        return { outcome: "port-in-use" };
      }
      if (!listener.onPreferredPort) this.log(`ChatGPT sign-in: port 1455 is taken; listening on port ${listener.port}.`);
      const attempt = newAttempt({ redirectUri: listener.redirectUri, clientId: registration?.clientId ?? DYNAMIC_CLIENT_ID, hostId, state });
      this.pending.otherPort = !listener.onPreferredPort;
      this.onChange();

      try {
        // Asking again for a user who did not allow plan use: show the consent screen.
        await this.openBrowser(authorizeUrl(attempt, { idToken: signedIn?.idToken, email: signedIn?.email, consent: signedIn !== null && !hasPlanScope(signedIn) }));
      } catch (error) {
        this.log(`ChatGPT sign-in: the browser could not be opened (${errorCode(error)}).`);
        return { outcome: "failed" };
      }
      const timedOut = new Promise<"timed-out">((resolve) => (timer = setTimeout(() => resolve("timed-out"), this.timeoutMs)));
      const answer = await Promise.race([listener.answer, cancelled, timedOut]);
      if (answer === "cancelled" || answer === "timed-out") {
        this.log(`ChatGPT sign-in: ${answer === "cancelled" ? "cancelled in the app" : "no answer from the browser in time"}.`);
        return { outcome: answer };
      }
      this.log(`ChatGPT sign-in: the callback arrived (${answer.kind === "code" ? "with a code" : `with error ${answer.error}`}).`);
      const result = await this.finishSignIn(attempt, answer, registration, abort.signal);
      if (abort.signal.aborted) return { outcome: "cancelled" };
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      await listener?.close();
      this.pending = null;
      this.onChange();
      this.schedule();
    }
  }

  /** Stops the sign-in waiting for the browser, or exchanging the code; nothing is saved. */
  cancelSignIn(): void {
    this.pending?.cancel();
  }

  private async finishSignIn(
    attempt: Attempt,
    answer: CallbackAnswer,
    registration: { clientId: string; subject: string | null } | null,
    signal: AbortSignal,
  ): Promise<ChatGptSignInResult> {
    // A client id OpenAI issued in this callback is kept before anything else can fail,
    // so a retry reuses it rather than registering another app (OpenAI's sign-in page).
    if (registration === null && isIssuedClientId(answer.clientId)) await this.keepRegistration(answer.clientId);

    if (answer.kind === "error") {
      // Nothing is exchanged or saved. access_denied: the user did not allow it, or the
      // account has no plan apps can use; OpenAI's answer does not say which.
      this.log(`ChatGPT sign-in: OpenAI ended the attempt with "${answer.error}"${answer.description ? `: ${answer.description}` : ""}.`);
      return { outcome: answer.error === "access_denied" ? "access-denied" : "failed" };
    }
    // A first registration gets its client id from the callback; a later sign-in keeps its
    // own, and a callback naming another is refused rather than replacing it.
    let clientId: string;
    if (registration === null) {
      if (!isIssuedClientId(answer.clientId)) {
        this.log("ChatGPT sign-in: the first registration's callback had no issued client id.");
        return { outcome: "failed" };
      }
      clientId = answer.clientId;
    } else {
      if (answer.clientId !== null && answer.clientId !== registration.clientId) {
        this.log("ChatGPT sign-in: the callback named another client id than the saved one; refused.");
        return { outcome: "failed" };
      }
      clientId = registration.clientId;
    }

    let tokens: TokenSet;
    try {
      tokens = await this.oauth.exchangeCode(attempt, answer.code, clientId, signal);
    } catch (error) {
      this.log(`ChatGPT sign-in: the code exchange failed (${oauthCode(error)}).`);
      return { outcome: isUnreachable(error) ? "unreachable" : "failed" };
    }
    if (!tokens.refreshToken || !tokens.idToken) {
      this.log(`ChatGPT sign-in: the token response had no ${tokens.idToken ? "refresh token" : "ID token"}.`);
      if (tokens.refreshToken) await this.revokeQuietly(clientId, tokens.refreshToken);
      return { outcome: "failed" };
    }
    let identity;
    try {
      identity = await this.oauth.verifyIdToken(tokens.idToken, { clientId, nonce: attempt.nonce }, signal);
    } catch (error) {
      this.log(`ChatGPT sign-in: the ID token check failed (${oauthCode(error)}).`);
      await this.revokeQuietly(clientId, tokens.refreshToken);
      return { outcome: isUnreachable(error) ? "unreachable" : "failed" };
    }
    // The same account as before, or nothing changes (and the new session is ended).
    if (registration?.subject && identity.subject !== registration.subject) {
      this.log("ChatGPT sign-in: the browser signed in to another account than the saved one; nothing changed.");
      await this.revokeQuietly(clientId, tokens.refreshToken);
      return { outcome: "different-account" };
    }

    // The token response's scopes decide plan use; the callback's when the response lists none.
    const scopes = tokens.scopes ?? (answer.scope ? answer.scope.split(/[ +]/).filter(Boolean) : []);
    const record: ChatGptSignedIn = {
      issuer: OPENAI_ISSUER,
      clientId,
      subject: identity.subject,
      email: identity.email,
      name: identity.name,
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: "Bearer",
      expiresAt: tokens.expiresAt,
      earliestRefreshAt: tokens.earliestRefreshAt,
      scopes,
      savedAt: new Date(this.now()).toISOString(),
    };
    try {
      await this.store.update((current) => ({ ...current, chatgpt: record }));
    } catch (error) {
      this.log(`ChatGPT sign-in: the sign-in could not be saved (${errorCode(error)}).`);
      await this.revokeQuietly(clientId, tokens.refreshToken);
      return { outcome: "not-saved" };
    }
    this.notEligible = false;
    if (!hasPlanScope(record)) {
      this.log(`ChatGPT sign-in: signed in, but the plan scope was not granted (scopes: ${scopes.join(" ") || "none"}).`);
      return { outcome: "plan-not-allowed" };
    }
    this.log("ChatGPT sign-in: signed in with plan use allowed.");
    return { outcome: "signed-in" };
  }

  /** Saves a registration whose first sign-in has not finished: its client id only. */
  private async keepRegistration(clientId: string): Promise<void> {
    try {
      await this.store.update((current) => ({ ...current, chatgpt: { issuer: OPENAI_ISSUER, clientId, signedOut: true } }));
    } catch (error) {
      this.log(`ChatGPT sign-in: the issued client id could not be saved (${errorCode(error)}).`);
    }
  }

  /** Ends a session the app will not keep (best effort: its failure changes nothing for the user). */
  private async revokeQuietly(clientId: string, refreshToken: string): Promise<void> {
    await this.oauth.revoke(clientId, refreshToken).catch(() => false);
  }

  /**
   * A token that works for plan use, refreshed first when it expires within
   * REFRESH_MARGIN_MS (or always, with `force`). A refresh OpenAI refuses for good ends
   * the session: the tokens are removed and the connection needs a new sign-in.
   */
  async accessToken(force = false): Promise<string> {
    await this.retryUnsaved();
    const read = await this.store.read();
    const record = read.ok ? (read.credentials?.chatgpt ?? null) : null;
    if (!isSignedIn(record)) throw new NotSignedIn(record && !isSignedIn(record) && record.sessionEnded ? "session-ended" : "not-connected");
    if (!hasPlanScope(record)) throw new NotSignedIn("plan-not-allowed");
    const now = this.now();
    const expired = Date.parse(record.expiresAt) <= now;
    // Not yet due (refreshDueAt never waits past the expiry, whatever earliest_refresh_at says).
    if (!force && now < refreshDueAt(record)) return record.accessToken;
    this.refreshing ??= this.refresh(record).finally(() => {
      this.refreshing = null;
    });
    try {
      return await this.refreshing;
    } catch (error) {
      // OpenAI could not be reached: a token that has not expired yet still works.
      if (error instanceof NotSignedIn && error.reason === "unreachable" && !expired) return record.accessToken;
      throw error;
    }
  }

  private async refresh(record: ChatGptSignedIn): Promise<string> {
    let tokens: TokenSet;
    try {
      tokens = await this.oauth.refresh(record.clientId, record.refreshToken);
    } catch (error) {
      this.log(`ChatGPT: the token refresh failed (${oauthCode(error)}).`);
      if (error instanceof OAuthError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
        // The refresh token can never work again, so there is nothing left to revoke.
        await this.endSession(record);
        throw new NotSignedIn("session-ended");
      }
      // A network failure or a server error: the tokens are kept, and tried again later.
      throw new NotSignedIn("unreachable");
    }
    let name = record.name;
    let email = record.email;
    let idToken = record.idToken;
    if (tokens.idToken) {
      // A new ID token replaces the old one only if it is valid and names the same account.
      const identity = await this.oauth.verifyIdToken(tokens.idToken, { clientId: record.clientId, nonce: null }).catch(() => null);
      if (identity && identity.subject === record.subject) {
        idToken = tokens.idToken;
        name = identity.name ?? name;
        email = identity.email ?? email;
      }
    }
    // The access token, its expiry, the scopes and the rotating refresh token, saved together.
    const next: ChatGptSignedIn = {
      ...record,
      name,
      email,
      idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? record.refreshToken,
      expiresAt: tokens.expiresAt,
      earliestRefreshAt: tokens.earliestRefreshAt,
      scopes: tokens.scopes ?? record.scopes,
      savedAt: new Date(this.now()).toISOString(),
    };
    try {
      await this.store.update((current) => ({ ...current, chatgpt: next }));
    } catch (error) {
      // OpenAI has replaced the old refresh token: the new one must not be lost. It is kept
      // in memory, used from now on, written at the next chance, and the interface says so.
      this.log(`ChatGPT: the refreshed sign-in could not be saved (${errorCode(error)}); it is kept until it can be.`);
      this.store.keepUnsaved((current) => ({ ...current, chatgpt: next }));
      this.onChange();
    }
    if (hasPlanScope(next) !== hasPlanScope(record)) this.onChange();
    this.schedule();
    return next.accessToken;
  }

  /** Writes a refreshed sign-in that could not be saved before; tells the interface when it worked. */
  private async retryUnsaved(): Promise<void> {
    if (!this.store.hasUnsavedChange) return;
    if (await this.store.saveUnsaved()) {
      this.log("ChatGPT: the refreshed sign-in is saved now.");
      this.onChange();
    }
  }

  /** The session ended on OpenAI's side: its tokens are removed; the registration stays, to sign in again. */
  private async endSession(record: ChatGptRecord): Promise<void> {
    this.cancelTimer();
    try {
      await this.store.update((current) => ({ ...current, chatgpt: signedOut(record, true) }));
    } catch (error) {
      this.log(`ChatGPT: the ended session could not be saved (${errorCode(error)}).`);
      this.store.keepUnsaved((current) => ({ ...current, chatgpt: signedOut(record, true) }));
    }
    this.onChange();
  }

  /**
   * The free check: the account's model list with the current token. A 401 gets one
   * forced refresh and one more try. Only a refresh OpenAI refuses for good ends the
   * session; a 401 after a refresh that worked keeps the tokens (the session is alive) and
   * is reported as an error. OpenAI saying the account cannot use its plan marks it so.
   */
  async check(): Promise<CheckConnectionResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await this.accessToken(attempt > 0);
      } catch (error) {
        if (!(error instanceof NotSignedIn)) throw error;
        if (error.reason === "unreachable") return { outcome: "unreachable" };
        return { outcome: error.reason === "session-ended" ? "rejected" : "not-connected" };
      }
      try {
        await this.openai.listModels({ kind: "chatgpt", accessToken: token }, AbortSignal.timeout(20_000));
        if (this.notEligible) {
          this.notEligible = false;
          this.onChange();
        }
        return { outcome: "working" };
      } catch (error) {
        const safe = toSafeError(error);
        this.log(`ChatGPT: the connection check failed (${safe.code}${safe.status === null ? "" : `, HTTP ${safe.status}`}).`);
        if (safe.code === "chatgpt_not_eligible") {
          this.notEligible = true;
          this.onChange();
          return { outcome: "not-eligible" };
        }
        if (safe.code === "chatgpt_signed_out" && attempt === 0) continue;
        return { outcome: safe.status === null ? "unreachable" : "provider-error" };
      }
    }
    return { outcome: "provider-error" };
  }

  /**
   * Sign-out (owner's decision, 2026-11-22): requests stop, the refresh token is revoked
   * with OpenAI (retried on a network failure or a 5xx), then the access, refresh and ID
   * tokens, the email and the name are removed; the issued client id, the account and the
   * host id stay, so the next sign-in returns to the same registration. When OpenAI could
   * not confirm the revocation, the tokens are removed anyway and the user is told.
   */
  async signOut(): Promise<ChatGptSignOutResult> {
    const read = await this.store.read();
    if (!read.ok) return { outcome: "credentials-problem", problem: read.problem };
    const record = read.credentials?.chatgpt ?? null;
    if (!isSignedIn(record)) return { outcome: "signed-out", revocationConfirmed: true };
    this.cancelTimer();
    // A refresh running now would save a new refresh token after this one is revoked.
    await this.refreshing?.catch(() => undefined);
    const current = await this.store.read();
    const latest = current.ok && isSignedIn(current.credentials?.chatgpt ?? null) ? (current.credentials!.chatgpt as ChatGptSignedIn) : record;
    let confirmed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        confirmed = await this.oauth.revoke(latest.clientId, latest.refreshToken);
        break;
      } catch {
        const pause = REVOKE_RETRY_DELAYS_MS[attempt];
        if (pause === undefined) break;
        await this.sleep(pause);
      }
    }
    if (!confirmed) this.log("ChatGPT sign-out: OpenAI did not confirm the revocation.");
    try {
      await this.store.update((credentials) => ({ ...credentials, chatgpt: signedOut(latest, false) }));
    } catch (error) {
      this.log(`ChatGPT sign-out: it could not be saved (${errorCode(error)}).`);
      return { outcome: "not-saved" };
    }
    this.notEligible = false;
    this.onChange();
    return { outcome: "signed-out", revocationConfirmed: confirmed };
  }

  /** "Use a different ChatGPT account": forgets a signed-out registration, so the next sign-in registers again. */
  async forgetAccount(): Promise<RemoveConnectionResult> {
    const read = await this.store.read();
    if (!read.ok) return { outcome: "credentials-problem", problem: read.problem };
    const record = read.credentials?.chatgpt ?? null;
    if (isSignedIn(record)) throw new Error("Refused: sign out of ChatGPT first.");
    if (record !== null) {
      try {
        await this.store.update((credentials) => ({ ...credentials, chatgpt: null }));
      } catch (error) {
        this.log(`ChatGPT: the account could not be forgotten (${errorCode(error)}).`);
        return { outcome: "not-saved" };
      }
    }
    this.onChange();
    return { outcome: "removed" };
  }

  /**
   * While the app runs, the token is refreshed before it expires, so the session stays
   * alive (each refresh token lasts 30 days) and a session ended elsewhere shows within the
   * hour. A refresh that could not reach OpenAI, or could not be saved, is tried again
   * later. Never sooner than MIN_REFRESH_DELAY_MS, so a token with a very short life cannot
   * make it call OpenAI in a loop.
   */
  schedule(): void {
    this.cancelTimer();
    void this.store.read().then((read) => {
      const record = read.ok ? (read.credentials?.chatgpt ?? null) : null;
      if (this.pending || !isSignedIn(record) || !hasPlanScope(record)) return;
      const due = this.store.hasUnsavedChange ? this.now() + REFRESH_RETRY_MS : refreshDueAt(record);
      const delay = Math.min(Math.max(MIN_REFRESH_DELAY_MS, due - this.now()), 2 ** 31 - 1);
      this.cancelTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.accessToken().then(
          () => this.schedule(),
          (error: unknown) => {
            if (error instanceof NotSignedIn && error.reason === "unreachable") {
              this.timer = setTimeout(() => this.schedule(), REFRESH_RETRY_MS);
              this.timer.unref?.();
            }
          },
        );
      }, delay);
      this.timer.unref?.();
    });
  }

  /** Stops the refresh timer (sign-out, tests). */
  cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A file error's code, for the log: never its message, which holds the path. */
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "error";
}

/** OpenAI's error code and status, for the log: never a body, which could echo a token. */
function oauthCode(error: unknown): string {
  return error instanceof OAuthError ? `${error.code}${error.status === null ? "" : `, HTTP ${error.status}`}` : "unexpected error";
}

function isUnreachable(error: unknown): boolean {
  return error instanceof OAuthError && (error.code === "unreachable" || error.code === "server_error");
}
