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
import { DYNAMIC_CLIENT_ID, PLAN_SCOPE, OAuthClient, OAuthError, TERMINAL_REFRESH_ERRORS, authorizeUrl, isIssuedClientId, newAttempt, randomToken, type Attempt } from "./chatgpt-oauth.ts";
import { OPENAI_ISSUER, isSignedIn, type ChatGptRecord, type ChatGptSignedIn, type CredentialsStore } from "./credentials.ts";
import { startCallbackListener, type CallbackAnswer, type CallbackListener } from "./oauth-callback.ts";

/*
 * Sign in with ChatGPT, from the button to a working token: one attempt at a time, the
 * tokens refreshed before they expire, sign-out that ends the session with OpenAI, and the
 * states the interface shows. The steps follow OpenAI's documentation
 * (developers.openai.com/siwc/token-sharing-open-source, read 2026-11-22); docs/desktop.md
 * lists them. Nothing here imports Electron: the browser is opened through `openBrowser`.
 */

/** How long a sign-in waits for the browser to come back (OpenAI's website example expires attempts after 10 minutes). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** A token this close to its expiry is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** After a refresh that could not reach OpenAI, the next try. */
export const REFRESH_RETRY_MS = 5 * 60_000;
/** Sign-out's revocation: tries, and the pause before each retry (network failures and 5xx only). */
export const REVOKE_RETRY_DELAYS_MS = [1_000, 3_000];

export function hasPlanScope(record: ChatGptSignedIn): boolean {
  return record.scopes.includes(PLAN_SCOPE);
}

/** When the token should be refreshed: REFRESH_MARGIN_MS before it expires, never before earliestRefreshAt. */
export function refreshDueAt(record: Pick<ChatGptSignedIn, "expiresAt" | "earliestRefreshAt">): number {
  const due = Date.parse(record.expiresAt) - REFRESH_MARGIN_MS;
  const earliest = record.earliestRefreshAt ? Date.parse(record.earliestRefreshAt) : Number.NEGATIVE_INFINITY;
  return Math.max(due, earliest);
}

/** What is left of a registration once its tokens go: the client id and the account, to sign in again to it. */
function signedOut(record: ChatGptRecord, sessionEnded: boolean): ChatGptRecord {
  return { issuer: OPENAI_ISSUER, clientId: record.clientId, subject: record.subject, signedOut: true, ...(sessionEnded ? { sessionEnded: true as const } : {}) };
}

/** The ChatGPT sign-in is not there, or cannot be used: `reason` says which. */
export class NotSignedIn extends Error {
  readonly reason: "not-connected" | "plan-not-allowed" | "session-ended" | "unreachable";
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

  /** The state to show for what the file holds. */
  state(record: ChatGptRecord | null): ChatGptConnection {
    if (this.pending) return { state: "signing-in", otherPort: this.pending.otherPort };
    if (record === null) return { state: "not-connected", savedAccount: false };
    if (!isSignedIn(record)) {
      return record.sessionEnded ? { state: "needs-attention", reason: "session-ended", displayName: null } : { state: "not-connected", savedAccount: true };
    }
    return hasPlanScope(record) ? { state: "connected", displayName: record.name } : { state: "needs-attention", reason: "plan-not-allowed", displayName: record.name };
  }

  /**
   * One sign-in: a fresh state, nonce and PKCE verifier, the listener started, then the
   * browser opened at OpenAI's authorize page. It waits for the one valid callback, the
   * cancel button or the timeout, whichever comes first.
   */
  async signIn(): Promise<ChatGptSignInResult> {
    if (this.pending) return { outcome: "already-signing-in" };
    // Claimed before the first await, so a second click cannot start a second attempt.
    let cancel!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => (cancel = () => resolve("cancelled")));
    this.pending = { otherPort: false, cancel };
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
        this.log(`The credentials file could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
        return { outcome: "not-saved" };
      }
      const record = read.credentials?.chatgpt ?? null;
      const registration = record ? { clientId: record.clientId, subject: record.subject } : null;
      const signedIn = isSignedIn(record) ? record : null;

      // The listener starts before the browser opens; the redirect URI names its port.
      const state = randomToken();
      const language = await this.language().catch((): Language => "en");
      listener = await startCallbackListener({ state, language: () => language, preferredPort: this.preferredPort });
      if (!listener) return { outcome: "port-in-use" };
      const attempt = newAttempt({ redirectUri: listener.redirectUri, clientId: registration?.clientId ?? DYNAMIC_CLIENT_ID, hostId, state });
      this.pending.otherPort = !listener.onPreferredPort;
      this.onChange();

      try {
        // Asking again for a user who did not allow plan use: show the consent screen.
        await this.openBrowser(authorizeUrl(attempt, { idToken: signedIn?.idToken, email: signedIn?.email, consent: signedIn !== null && !hasPlanScope(signedIn) }));
      } catch {
        return { outcome: "failed" };
      }
      const timedOut = new Promise<"timed-out">((resolve) => (timer = setTimeout(() => resolve("timed-out"), this.timeoutMs)));
      const answer = await Promise.race([listener.answer, cancelled, timedOut]);
      if (answer === "cancelled" || answer === "timed-out") return { outcome: answer };
      return await this.finishSignIn(attempt, answer, registration);
    } finally {
      if (timer) clearTimeout(timer);
      await listener?.close();
      this.pending = null;
      this.onChange();
      this.schedule();
    }
  }

  /** Stops the sign-in waiting for the browser; nothing is saved. */
  cancelSignIn(): void {
    this.pending?.cancel();
  }

  private async finishSignIn(attempt: Attempt, answer: CallbackAnswer, registration: { clientId: string; subject: string } | null): Promise<ChatGptSignInResult> {
    if (answer.kind === "error") {
      // The user said no (or OpenAI ended the attempt): nothing is exchanged or saved.
      return { outcome: answer.error === "access_denied" ? "declined" : "failed" };
    }
    // A first registration gets its client id from the callback; a later sign-in keeps its
    // own, and a callback naming another is refused rather than replacing it.
    let clientId: string;
    if (registration === null) {
      if (!isIssuedClientId(answer.clientId)) return { outcome: "failed" };
      clientId = answer.clientId;
    } else {
      if (answer.clientId !== null && answer.clientId !== registration.clientId) return { outcome: "failed" };
      clientId = registration.clientId;
    }

    let tokens;
    let identity;
    try {
      tokens = await this.oauth.exchangeCode(attempt, answer.code, clientId);
      if (!tokens.refreshToken || !tokens.idToken) return { outcome: "failed" };
      identity = await this.oauth.verifyIdToken(tokens.idToken, { clientId, nonce: attempt.nonce });
    } catch (error) {
      return { outcome: error instanceof OAuthError && error.code === "unreachable" ? "unreachable" : "failed" };
    }
    // The same account as before, or nothing changes.
    if (registration !== null && identity.subject !== registration.subject) return { outcome: "different-account" };

    // The token response's scopes decide plan use; the callback's when the response lists none.
    const scopes = tokens.scopes ?? (answer.scope ? answer.scope.split(/[ +]/).filter(Boolean) : []);
    const nowIso = new Date(this.now()).toISOString();
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
      savedAt: nowIso,
    };
    try {
      await this.store.update((current) => ({ ...current, chatgpt: record }));
    } catch (error) {
      this.log(`The ChatGPT sign-in could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      return { outcome: "not-saved" };
    }
    if (!hasPlanScope(record)) return { outcome: "plan-not-allowed" };
    return { outcome: "signed-in", firstTime: registration === null };
  }

  /**
   * A token that works for plan use, refreshed first when it expires within
   * REFRESH_MARGIN_MS (or always, with `force`). A refresh OpenAI refuses for good ends
   * the session: the tokens are removed and the connection needs a new sign-in.
   */
  async accessToken(force = false): Promise<string> {
    const read = await this.store.read();
    const record = read.ok ? (read.credentials?.chatgpt ?? null) : null;
    if (!isSignedIn(record)) throw new NotSignedIn(record && !isSignedIn(record) && record.sessionEnded ? "session-ended" : "not-connected");
    if (!hasPlanScope(record)) throw new NotSignedIn("plan-not-allowed");
    const now = this.now();
    const expired = Date.parse(record.expiresAt) <= now;
    if (!force && now < refreshDueAt(record)) return record.accessToken;
    if (!force && !expired && record.earliestRefreshAt && now < Date.parse(record.earliestRefreshAt)) return record.accessToken;
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
    let tokens;
    try {
      tokens = await this.oauth.refresh(record.clientId, record.refreshToken);
    } catch (error) {
      if (error instanceof OAuthError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
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
      // The new refresh token is lost if it is not saved; the old one has been replaced.
      this.log(`The refreshed ChatGPT sign-in could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    const wasAllowed = hasPlanScope(record);
    if (hasPlanScope(next) !== wasAllowed) this.onChange();
    this.schedule();
    return next.accessToken;
  }

  /** The session ended on OpenAI's side: its tokens are removed; the registration stays, to sign in again. */
  private async endSession(record: ChatGptRecord): Promise<void> {
    this.cancelTimer();
    try {
      await this.store.update((current) => ({ ...current, chatgpt: signedOut(record, true) }));
    } catch (error) {
      this.log(`The ended ChatGPT session could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    this.onChange();
  }

  /**
   * The free check: the account's model list with the current token. A 401 gets one
   * forced refresh and one more try; a second 401 confirms the session is gone.
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
        return { outcome: "working" };
      } catch (error) {
        const safe = toSafeError(error);
        if (safe.code === "chatgpt_signed_out") {
          if (attempt === 0) continue;
          const read = await this.store.read();
          const record = read.ok ? (read.credentials?.chatgpt ?? null) : null;
          if (record) await this.endSession(record);
          return { outcome: "rejected" };
        }
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
    try {
      await this.store.update((credentials) => ({ ...credentials, chatgpt: signedOut(latest, false) }));
    } catch (error) {
      this.log(`The ChatGPT sign-out could not be saved (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      return { outcome: "not-saved" };
    }
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
        this.log(`The ChatGPT account could not be forgotten (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
        return { outcome: "not-saved" };
      }
    }
    this.onChange();
    return { outcome: "removed" };
  }

  /**
   * While the app runs, the token is refreshed before it expires, so the session stays
   * alive (each refresh token lasts 30 days) and a session ended elsewhere shows within the
   * hour. A refresh that could not reach OpenAI is tried again later.
   */
  schedule(): void {
    this.cancelTimer();
    void this.store.read().then((read) => {
      const record = read.ok ? (read.credentials?.chatgpt ?? null) : null;
      if (this.pending || !isSignedIn(record) || !hasPlanScope(record)) return;
      const delay = Math.min(Math.max(0, refreshDueAt(record) - this.now()), 2 ** 31 - 1);
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
