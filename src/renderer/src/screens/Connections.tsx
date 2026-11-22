import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ChatGptConnection, ChatGptSignInResult, CheckConnectionResult, ClaudeConnection, CredentialsProblem, SaveClaudeKeyResult } from "../../../shared/api.ts";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { StatusBadge, type StatusTone } from "../components/StatusBadge.tsx";
import { TextField } from "../components/TextField.tsx";
import { useConnections } from "../connections.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/*
 * The AI connections in Settings, on one screen (owner's decision): sign in to or out of
 * ChatGPT; paste, check or remove the Claude key. Each shows its state in words. The
 * screen only ever learns states and the account's display name: a pasted key goes to the
 * main process and is never sent back.
 */

type Message = { text: string; problem: boolean } | null;

/** The status line under a card: always rendered, so a screen reader announces each new message. */
function StatusLine({ message, testId }: { message: Message; testId: string }) {
  return (
    <p role="status" data-testid={testId} className={message?.problem ? "max-w-measure text-sm font-medium text-danger" : "max-w-measure text-sm text-fg-muted"}>
      {message?.text}
    </p>
  );
}

function Card({ title, badge, children, testId }: { title: string; badge: { label: string; tone: StatusTone } | null; children: ReactNode; testId: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid={testId} className="flex flex-col gap-2.5 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-base font-semibold">
          {title}
        </h3>
        {badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : null}
      </div>
      {children}
    </section>
  );
}

function useBadge() {
  const { t } = useTranslation();
  return (state: ChatGptConnection["state"] | ClaudeConnection["state"]): { label: string; tone: StatusTone } => {
    if (state === "connected") return { label: t("connections.connected"), tone: "success" };
    if (state === "needs-attention") return { label: t("connections.needsAttention"), tone: "warning" };
    if (state === "signing-in") return { label: t("connections.signingIn"), tone: "accent" };
    return { label: t("connections.notConnected"), tone: "neutral" };
  };
}

export function ConnectionsSection() {
  const { t } = useTranslation();
  const { connections, failed } = useConnections();
  const problem = connections?.problem ?? null;
  return (
    <SettingsSection heading={t("connections.heading")}>
      <p className="max-w-measure text-fg-muted">{t("connections.intro")}</p>
      {failed ? <p className="max-w-measure text-sm font-medium text-danger">{t("connections.failed")}</p> : null}
      {problem ? <CredentialsProblemNotice problem={problem} /> : null}
      <div className="flex flex-col gap-3">
        <ChatGptCard connection={connections?.chatgpt ?? null} blocked={problem !== null || connections === null} />
        <ClaudeCard connection={connections?.claude ?? null} blocked={problem !== null || connections === null} />
      </div>
    </SettingsSection>
  );
}

/** The credentials file could not be used: say so, and offer to set it aside after a confirmation. */
function CredentialsProblemNotice({ problem }: { problem: CredentialsProblem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  async function startOver() {
    setOpen(false);
    const result = await window.aba.startOverConnections().catch(() => null);
    if (result?.outcome === "started-over" || result?.outcome === "not-needed") setMessage({ text: t("connections.startedOver"), problem: false });
    else setMessage({ text: t("connections.startOverFailed"), problem: true });
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-warning-subtle p-4" data-testid="credentials-problem">
      <p className="max-w-measure font-medium text-warning">{t(`connections.${problem}`)}</p>
      <div>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title={t("connections.startOverTitle")}
          trigger={<Button>{t("connections.startOver")}</Button>}
        >
          <DialogDescription className="mt-2 text-fg-muted">{t("connections.startOverBody")}</DialogDescription>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <DialogClose render={<Button />}>{t("connections.startOverCancel")}</DialogClose>
            <Button variant="primary" onClick={() => void startOver()}>
              {t("connections.startOverConfirm")}
            </Button>
          </div>
        </Dialog>
      </div>
      <StatusLine message={message} testId="credentials-problem-message" />
    </div>
  );
}

function checkMessage(t: ReturnType<typeof useTranslation>["t"], provider: "chatgpt" | "claude", result: CheckConnectionResult | null): Message {
  if (result === null) return { text: t("connections.failed"), problem: true };
  switch (result.outcome) {
    case "working":
      return { text: t(`${provider}.checkWorking`), problem: false };
    case "rejected":
      // The card now says it needs attention, and why: saying it twice is noise.
      return null;
    case "unreachable":
      return { text: t(`${provider}.checkUnreachable`), problem: true };
    case "provider-error":
      return { text: t(`${provider}.checkProviderError`), problem: true };
    case "not-connected":
      return null;
  }
}

const SIGN_IN_MESSAGES: Record<Exclude<ChatGptSignInResult["outcome"], "credentials-problem">, { key: string; problem: boolean }> = {
  "signed-in": { key: "chatgpt.resultSignedIn", problem: false },
  "plan-not-allowed": { key: "chatgpt.planNotAllowed", problem: true },
  declined: { key: "chatgpt.resultDeclined", problem: true },
  cancelled: { key: "chatgpt.resultCancelled", problem: false },
  "timed-out": { key: "chatgpt.resultTimedOut", problem: true },
  "port-in-use": { key: "chatgpt.resultPortInUse", problem: true },
  "different-account": { key: "chatgpt.resultDifferentAccount", problem: true },
  unreachable: { key: "chatgpt.resultUnreachable", problem: true },
  failed: { key: "chatgpt.resultFailed", problem: true },
  "already-signing-in": { key: "chatgpt.resultAlreadySigningIn", problem: false },
  "not-saved": { key: "chatgpt.resultNotSaved", problem: true },
};

function ChatGptCard({ connection, blocked }: { connection: ChatGptConnection | null; blocked: boolean }) {
  const { t } = useTranslation();
  const badge = useBadge();
  const [busy, setBusy] = useState<"checking" | "signing-out" | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [welcome, setWelcome] = useState(false);
  const state = connection?.state ?? null;

  async function signIn() {
    setMessage(null);
    const result = await window.aba.signInToChatGpt().catch(() => null);
    if (result === null) return setMessage({ text: t("connections.failed"), problem: true });
    if (result.outcome === "credentials-problem") return setMessage(null);
    const { key, problem } = SIGN_IN_MESSAGES[result.outcome];
    setMessage({ text: t(key as "chatgpt.resultSignedIn"), problem });
    // OpenAI's guidelines: say once, after the first sign-in, that the app uses the ChatGPT plan.
    if (result.outcome === "signed-in" && result.firstTime) setWelcome(true);
  }

  async function check() {
    setBusy("checking");
    setMessage(null);
    setMessage(checkMessage(t, "chatgpt", await window.aba.checkChatGpt().catch(() => null)));
    setBusy(null);
  }

  async function signOut() {
    setBusy("signing-out");
    setMessage(null);
    const result = await window.aba.signOutOfChatGpt().catch(() => null);
    setBusy(null);
    if (result?.outcome === "signed-out") {
      setMessage(result.revocationConfirmed ? { text: t("chatgpt.resultSignedOut"), problem: false } : { text: t("chatgpt.resultSignedOutNotConfirmed"), problem: true });
    } else if (result?.outcome !== "credentials-problem") {
      setMessage({ text: t("connections.failed"), problem: true });
    }
  }

  async function forget() {
    const result = await window.aba.forgetChatGptAccount().catch(() => null);
    setMessage(result?.outcome === "removed" ? { text: t("chatgpt.differentAccountDone"), problem: false } : { text: t("chatgpt.differentAccountFailed"), problem: true });
  }

  const manageUsage = (
    <Button variant="secondary" disabled={blocked} focusableWhenDisabled onClick={() => void window.aba.openChatGptUsage().catch(() => undefined)}>
      {t("chatgpt.manageUsage")}
    </Button>
  );
  const differentAccount = (
    <Button variant="secondary" size="sm" disabled={blocked} focusableWhenDisabled onClick={() => void forget()} className="self-start">
      {t("chatgpt.differentAccount")}
    </Button>
  );

  let body: ReactNode;
  if (connection?.state === "signing-in") {
    body = (
      <>
        <p className="max-w-measure font-medium">{t("chatgpt.waiting")}</p>
        {connection.otherPort ? <p className="max-w-measure text-sm text-warning">{t("chatgpt.otherPort")}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void window.aba.cancelChatGptSignIn()}>{t("chatgpt.cancel")}</Button>
        </div>
      </>
    );
  } else if (connection?.state === "connected") {
    body = (
      <>
        {connection.displayName ? <p className="font-medium" data-testid="chatgpt-account">{t("chatgpt.signedInAs", { name: connection.displayName })}</p> : <p className="font-medium">{t("chatgpt.signedIn")}</p>}
        <p className="max-w-measure text-sm text-fg-muted">{t("chatgpt.usageNote")}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy !== null} focusableWhenDisabled onClick={() => void check()}>
            {busy === "checking" ? t("connections.checking") : t("connections.check")}
          </Button>
          {manageUsage}
          <Button disabled={busy !== null} focusableWhenDisabled onClick={() => void signOut()}>
            {busy === "signing-out" ? t("chatgpt.signingOut") : t("chatgpt.signOut")}
          </Button>
        </div>
      </>
    );
  } else if (connection?.state === "needs-attention") {
    const planNotAllowed = connection.reason === "plan-not-allowed";
    body = (
      <>
        <p className="max-w-measure font-medium text-warning">{t(planNotAllowed ? "chatgpt.planNotAllowed" : "chatgpt.sessionEnded")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={blocked} focusableWhenDisabled onClick={() => void signIn()}>
            {t(planNotAllowed ? "chatgpt.allowPlan" : "chatgpt.signInAgain")}
          </Button>
          {planNotAllowed ? (
            <Button disabled={busy !== null} focusableWhenDisabled onClick={() => void signOut()}>
              {busy === "signing-out" ? t("chatgpt.signingOut") : t("chatgpt.signOut")}
            </Button>
          ) : null}
        </div>
        {planNotAllowed ? null : differentAccount}
      </>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={blocked} focusableWhenDisabled onClick={() => void signIn()}>
            {t("chatgpt.signIn")}
          </Button>
        </div>
        {connection?.state === "not-connected" && connection.savedAccount ? differentAccount : null}
      </>
    );
  }

  return (
    <Card title={t("chatgpt.title")} badge={state && !blocked ? badge(state) : blocked && connection ? badge("not-connected") : null} testId="chatgpt-card">
      <p className="max-w-measure text-fg-muted">{t("chatgpt.body")}</p>
      {body}
      <StatusLine message={message} testId="chatgpt-message" />
      <Dialog open={welcome} onOpenChange={setWelcome} title={t("chatgpt.welcomeTitle")}>
        <DialogDescription className="mt-2 text-fg-muted">{t("chatgpt.welcomeBody")}</DialogDescription>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => void window.aba.openChatGptUsage().catch(() => undefined)}>{t("chatgpt.manageUsage")}</Button>
          <DialogClose render={<Button variant="primary" />}>{t("chatgpt.welcomeDismiss")}</DialogClose>
        </div>
      </Dialog>
    </Card>
  );
}

const SAVE_MESSAGES: Record<Exclude<SaveClaudeKeyResult["outcome"], "credentials-problem" | "not-a-key">, { key: string; problem: boolean }> = {
  saved: { key: "claude.resultSaved", problem: false },
  rejected: { key: "claude.resultRejected", problem: true },
  unreachable: { key: "claude.resultUnreachable", problem: true },
  "provider-error": { key: "claude.resultProviderError", problem: true },
  "not-saved": { key: "claude.resultNotSaved", problem: true },
};

function ClaudeCard({ connection, blocked }: { connection: ClaudeConnection | null; blocked: boolean }) {
  const { t } = useTranslation();
  const badge = useBadge();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"saving" | "checking" | "removing" | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [replacing, setReplacing] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const state = connection?.state ?? null;

  async function save(event: { preventDefault(): void }) {
    event.preventDefault();
    setMessage(null);
    setFieldError(null);
    setBusy("saving");
    const result = await window.aba.saveClaudeKey(key).catch(() => null);
    setBusy(null);
    if (result === null) return setMessage({ text: t("connections.failed"), problem: true });
    if (result.outcome === "credentials-problem") return;
    if (result.outcome === "not-a-key") return setFieldError(t(result.problem === "empty" ? "claude.resultEmpty" : "claude.resultNotAKey"));
    const { key: text, problem } = SAVE_MESSAGES[result.outcome];
    if (result.outcome === "rejected") setFieldError(t("claude.resultRejected"));
    else setMessage({ text: t(text as "claude.resultSaved"), problem });
    // The key is not kept on screen once it is saved.
    if (result.outcome === "saved") {
      setKey("");
      setReplacing(false);
    }
  }

  async function check() {
    setBusy("checking");
    setMessage(null);
    setMessage(checkMessage(t, "claude", await window.aba.checkClaudeKey().catch(() => null)));
    setBusy(null);
  }

  async function remove() {
    setBusy("removing");
    setMessage(null);
    const result = await window.aba.removeClaudeKey().catch(() => null);
    setBusy(null);
    if (result?.outcome === "removed") {
      setReplacing(false);
      setMessage({ text: t("claude.resultRemoved"), problem: false });
    } else if (result?.outcome !== "credentials-problem") setMessage({ text: t("claude.resultRemoveFailed"), problem: true });
  }

  const showForm = state === "not-connected" || state === "needs-attention" || replacing || blocked;
  return (
    <Card title={t("claude.title")} badge={state && !blocked ? badge(state) : blocked && connection ? badge("not-connected") : null} testId="claude-card">
      <p className="max-w-measure text-fg-muted">{t("claude.body")}</p>
      {state === "needs-attention" && !blocked ? <p className="max-w-measure font-medium text-warning">{t("claude.keyRejected")}</p> : null}
      {state === "connected" && !blocked ? <p className="font-medium">{t("claude.keySaved")}</p> : null}
      {showForm ? (
        <form className="flex max-w-xl flex-col gap-2" onSubmit={(event) => void save(event)} noValidate>
          <TextField
            label={t("claude.keyLabel")}
            description={t("claude.keyDescription")}
            error={fieldError}
            type="password"
            name="claude-key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            disabled={blocked}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={blocked || busy !== null} focusableWhenDisabled>
              {busy === "saving" ? t("claude.saving") : t("claude.save")}
            </Button>
          </div>
        </form>
      ) : null}
      {(state === "connected" || state === "needs-attention") && !blocked ? (
        <div className="flex flex-wrap gap-2">
          {state === "connected" ? (
            <Button disabled={busy !== null} focusableWhenDisabled onClick={() => void check()}>
              {busy === "checking" ? t("connections.checking") : t("connections.check")}
            </Button>
          ) : null}
          {state === "connected" && !replacing ? <Button onClick={() => setReplacing(true)}>{t("claude.replaceKey")}</Button> : null}
          <Button disabled={busy !== null} focusableWhenDisabled onClick={() => void remove()}>
            {t("claude.remove")}
          </Button>
        </div>
      ) : null}
      <StatusLine message={message} testId="claude-message" />
    </Card>
  );
}
