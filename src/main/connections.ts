import { z } from "zod";
import type { Provider } from "../lib/providers/types.ts";
import {
  MAX_API_KEY_INPUT_LENGTH,
  type ChatGptSignInResult,
  type ChatGptSignOutResult,
  type CheckConnectionResult,
  type ClaudeConnection,
  type Connections,
  type RemoveConnectionResult,
  type SaveClaudeKeyResult,
  type StartOverResult,
} from "../shared/api.ts";
import type { ChatGptSession } from "./chatgpt-session.ts";
import { checkClaudeKeyShape, verifyClaudeKey } from "./claude-key.ts";
import type { CredentialsStore } from "./credentials.ts";

/*
 * The AI connections, as the interface sees them: Claude with a pasted API key, ChatGPT
 * with Sign in with ChatGPT (src/main/chatgpt-session.ts). This is the only place that
 * turns what the credentials file holds into states; the interface never receives a key
 * or a token. Nothing here imports Electron, so it is unit-tested with the providers stubbed.
 */

/** Checked before anything else looks at it: a string, and not a huge one. */
const KeyInput = z.string().max(MAX_API_KEY_INPUT_LENGTH);

export class ConnectionService {
  /**
   * Set when Anthropic refused the saved key on a check, until the key is replaced or
   * removed. Kept for this session only: the next start shows the key as connected
   * again until a check or a request says otherwise.
   */
  private claudeKeyRejected = false;
  /** Saves and removals of the key run one after another. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly store: CredentialsStore;
  private readonly chatgpt: ChatGptSession;
  private readonly welcome: { shown(): Promise<boolean>; markShown(): Promise<void> };
  private readonly claude: Provider;
  private readonly notify: (connections: Connections) => void;
  private readonly log: (message: string) => void;

  constructor(options: {
    store: CredentialsStore;
    chatgpt: ChatGptSession;
    /** Whether "You're using your ChatGPT plan" was dismissed (kept in the settings file). */
    welcome?: { shown(): Promise<boolean>; markShown(): Promise<void> };
    /** The Claude provider; tests pass one with a stub fetch. */
    claude: Provider;
    /** Told the new state after every change, to pass on to the interface. */
    onChange?: (connections: Connections) => void;
    /** The main process's log. Never given a key or a token. */
    log?: (message: string) => void;
  }) {
    this.store = options.store;
    this.chatgpt = options.chatgpt;
    this.welcome = options.welcome ?? memoryWelcome();
    this.claude = options.claude;
    this.notify = options.onChange ?? (() => undefined);
    this.log = options.log ?? ((message) => console.error(message));
  }

  async get(): Promise<Connections> {
    const saved = await this.store.read();
    if (!saved.ok) return { chatgpt: this.chatgpt.state(null), claude: { state: "not-connected" }, problem: saved.problem };
    const welcomeShown = await this.welcome.shown().catch(() => true);
    return {
      chatgpt: this.chatgpt.state(saved.credentials?.chatgpt ?? null, { welcomeShown }),
      claude: this.claudeState(saved.credentials?.claude?.apiKey ?? null),
      problem: null,
    };
  }

  /** Tells the interface the current state (the ChatGPT session calls it after each change). */
  async changed(): Promise<void> {
    this.notify(await this.get());
  }

  /**
   * The key the user pasted: its shape is checked first (nothing is sent for text that is
   * not a Claude key), then Anthropic is asked for its model list with it, and the key is
   * saved only if Anthropic accepted it.
   */
  saveClaudeKey(input: unknown): Promise<SaveClaudeKeyResult> {
    const parsed = KeyInput.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error(`Refused: the key must be text of at most ${MAX_API_KEY_INPUT_LENGTH} characters.`));
    const shape = checkClaudeKeyShape(parsed.data);
    if (!shape.ok) return Promise.resolve({ outcome: "not-a-key", problem: shape.problem });
    return this.serial(async (): Promise<SaveClaudeKeyResult> => {
      const saved = await this.store.read();
      if (!saved.ok) return { outcome: "credentials-problem", problem: saved.problem };
      const verdict = await verifyClaudeKey(shape.key, this.claude);
      if (verdict !== "accepted") return { outcome: verdict };
      try {
        await this.store.update((current) => ({ ...current, claude: { apiKey: shape.key, savedAt: new Date().toISOString() } }));
      } catch (error) {
        this.log(`The Claude key could not be saved in the credentials file (${errorCode(error)}).`);
        return { outcome: "not-saved" };
      }
      this.claudeKeyRejected = false;
      await this.changed();
      return { outcome: "saved" };
    });
  }

  /** Checks the saved key with the same free call. A refusal marks the connection as needing attention. */
  async checkClaudeKey(): Promise<CheckConnectionResult> {
    const saved = await this.store.read();
    const key = saved.ok ? (saved.credentials?.claude?.apiKey ?? null) : null;
    if (key === null) return { outcome: "not-connected" };
    const verdict = await verifyClaudeKey(key, this.claude);
    const rejected = verdict === "rejected";
    if (rejected !== this.claudeKeyRejected && (verdict === "accepted" || rejected)) {
      this.claudeKeyRejected = rejected;
      await this.changed();
    }
    return { outcome: verdict === "accepted" ? "working" : verdict };
  }

  removeClaudeKey(): Promise<RemoveConnectionResult> {
    return this.serial(async (): Promise<RemoveConnectionResult> => {
      const saved = await this.store.read();
      if (!saved.ok) return { outcome: "credentials-problem", problem: saved.problem };
      if (saved.credentials?.claude) {
        try {
          await this.store.update((current) => ({ ...current, claude: null }));
        } catch (error) {
          this.log(`The Claude key could not be removed from the credentials file (${errorCode(error)}).`);
          return { outcome: "not-saved" };
        }
      }
      this.claudeKeyRejected = false;
      await this.changed();
      return { outcome: "removed" };
    });
  }

  signInToChatGpt(): Promise<ChatGptSignInResult> {
    return this.chatgpt.signIn();
  }

  cancelChatGptSignIn(): void {
    this.chatgpt.cancelSignIn();
  }

  checkChatGpt(): Promise<CheckConnectionResult> {
    return this.chatgpt.check();
  }

  signOutOfChatGpt(): Promise<ChatGptSignOutResult> {
    return this.chatgpt.signOut();
  }

  forgetChatGptAccount(): Promise<RemoveConnectionResult> {
    return this.chatgpt.forgetAccount();
  }

  /**
   * "Got it" on "You're using your ChatGPT plan": never shown again on this computer.
   * When that cannot be saved it is still dismissed for this run, and the error reaches
   * the interface, which says it may show again next time.
   */
  async dismissChatGptWelcome(): Promise<void> {
    try {
      await this.welcome.markShown();
    } finally {
      await this.changed();
    }
  }

  /**
   * "Start over" (owner's decision, 2026-11-22): only when the credentials file cannot be
   * used. It is renamed aside, never deleted, and both connections start empty.
   */
  async startOver(): Promise<StartOverResult> {
    const saved = await this.store.read();
    if (saved.ok) return { outcome: "not-needed" };
    if (!(await this.store.startOver())) return { outcome: "not-saved" };
    this.claudeKeyRejected = false;
    await this.changed();
    return { outcome: "started-over" };
  }

  private claudeState(key: string | null): ClaudeConnection {
    if (key === null) return { state: "not-connected" };
    return this.claudeKeyRejected ? { state: "needs-attention", reason: "key-rejected" } : { state: "connected" };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** For tests: the welcome flag in memory. */
function memoryWelcome() {
  let shown = false;
  return {
    shown: async () => shown,
    markShown: async () => {
      shown = true;
    },
  };
}

/** A file error's code, for the log: never its message, which holds the path. */
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? "error";
}
