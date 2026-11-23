import { useId, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { SectionSummary } from "../../../shared/sections.ts";
import { useAutosave } from "../autosave.tsx";
import { usePatchOpenedCase } from "../open-case.tsx";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Language } from "../../../shared/api.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { CASE_STEPS, casePath, StepLabel } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { NavItem, SectionNavItem } from "../components/NavItem.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useConnections } from "../connections.tsx";
import { useLanguage } from "../language.tsx";
import { Eyebrow } from "./WorkArea.tsx";

/** The reference shows the switch as ES EN. */
const SWITCH_ORDER: Language[] = ["es", "en"];

/*
 * The dark sidebar. Outside a case it lists the app's screens; inside a case it shows the
 * case, its five steps and the report's sections, as in the reference. Its footer holds
 * the AI connection's state and the screen language.
 */

function Brand() {
  const { t } = useTranslation();
  return <Eyebrow as="p" className="text-xs text-fg-on-nav-muted">{t("app.name")}</Eyebrow>;
}

export function AppSidebar() {
  const { t } = useTranslation();
  const info = useAppInfo();
  return (
    <SidebarFrame
      top={
        <div className="px-2">
          <Brand />
        </div>
      }
    >
      <nav aria-label={t("nav.mainLabel")}>
        <ul className="flex flex-col gap-0.5">
          <li>
            <NavItem to="/" end>
              {t("nav.cases")}
            </NavItem>
          </li>
          <li>
            <NavItem to="/settings">{t("nav.settings")}</NavItem>
          </li>
          {info?.developmentBuild ? (
            <li>
              {/* Development builds only; the packaged app has no link to it. */}
              <NavItem to="/dev-check" detail="dev">
                {t("nav.devCheck")}
              </NavItem>
            </li>
          ) : null}
        </ul>
      </nav>
    </SidebarFrame>
  );
}

/** A section's state in a word or two, for the sidebar and the report's table. */
export function sectionStateText(t: TFunction, section: SectionSummary): { short: string | null; long: string } {
  switch (section.state) {
    case "hers":
      return { short: t("section.stateHers"), long: t("section.stateHers") };
    case "approved":
      return { short: t("section.stateApproved"), long: t("section.stateApproved") };
    case "drafted":
      return { short: t("section.stateDraft", { number: section.currentVersion }), long: t("section.stateDraftLong", { number: section.currentVersion }) };
    default:
      return { short: null, long: t("status.notStarted") };
  }
}

export function CaseSidebar({ caseId, caseName, caseDetail, sections, notes }: { caseId: string; caseName: string; caseDetail: string; sections: SectionSummary[]; notes: string }) {
  const { t } = useTranslation();
  const sectionsHeadingId = useId();
  const states = new Map(sections.map((section) => [section.id, section]));
  return (
    <SidebarFrame
      top={
        <div className="flex flex-col gap-0.5 px-2">
          <Brand />
          <p className="text-lg font-semibold">{caseName}</p>
          <p className="text-xs text-fg-on-nav-muted">{caseDetail}</p>
          <Link to="/" className="mt-1 self-start rounded-sm text-xs text-fg-on-nav underline underline-offset-2 hover:decoration-2">
            {t("nav.allCases")}
          </Link>
        </div>
      }
      footerExtra={
        <NavItem to="/settings">{t("nav.settings")}</NavItem>
      }
    >
      <nav aria-label={t("nav.stepsLabel")}>
        <ol className="flex flex-col gap-0.5">
          {CASE_STEPS.map((step, index) => (
            <li key={step}>
              <NavItem to={casePath(caseId, step)} number={index + 1}>
                <StepLabel t={t} step={step} />
              </NavItem>
            </li>
          ))}
        </ol>
      </nav>
      <nav aria-labelledby={sectionsHeadingId} className="flex flex-col gap-1">
        <Eyebrow id={sectionsHeadingId} className="px-2 text-fg-on-nav-muted">
          {t("nav.sectionsHeading")}
        </Eyebrow>
        <ul className="flex flex-col">
          {REPORT_SECTIONS.map((section) => {
            const summary = states.get(section.id) ?? { id: section.id, state: "not-started" as const, currentVersion: null, approvedVersion: null, versionCount: 0 };
            const text = sectionStateText(t, summary);
            return (
              <li key={section.id}>
                <SectionNavItem to={casePath(caseId, "report", section.id)} title={section.title} state={summary.state} detail={text.short} statusLabel={text.long} />
              </li>
            );
          })}
        </ul>
      </nav>
      <SessionNotes key={caseId} caseId={caseId} initial={notes} />
    </SidebarFrame>
  );
}

/** The case (or brand) on top, the lists in the middle, scrolling on their own when the window is short, and the footer always in view. */
function SidebarFrame({ top, children, footerExtra }: { top: ReactNode; children: ReactNode; footerExtra?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4.5 py-4.5">
      <div className="px-3.5">{top}</div>
      <div className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-y-auto px-3.5">{children}</div>
      <div className="px-3.5">
        <SidebarFooter extra={footerExtra} />
      </div>
    </div>
  );
}

/**
 * The AI connections in one line, from the same state as Settings, linking there. A
 * connection that needs attention (a sign-in that ended, a key Anthropic refuses) says so.
 */
function AiConnectionStatus() {
  const { t } = useTranslation();
  const { connections } = useConnections();
  const chatgpt = connections?.problem ? null : connections?.chatgpt.state;
  const claude = connections?.problem ? null : connections?.claude.state;
  const attention = chatgpt === "needs-attention" || claude === "needs-attention";
  const label = attention
    ? t("ai.needsAttention")
    : chatgpt === "connected" && claude === "connected"
      ? t("ai.connectedBoth")
      : chatgpt === "connected"
        ? t("ai.connectedChatgpt")
        : claude === "connected"
          ? t("ai.connectedClaude")
          : t("ai.notConnected");
  return (
    <Link
      to="/settings"
      data-testid="ai-status"
      className={`rounded-sm underline-offset-2 hover:underline ${attention ? "font-medium text-fg-on-nav-warning" : "text-fg-on-nav-muted"}`}
    >
      {label}
    </Link>
  );
}

function SidebarFooter({ extra }: { extra?: ReactNode }) {
  const { t } = useTranslation();
  const { language, savedLanguage, changeLanguage } = useLanguage();

  async function choose(option: Language) {
    if (option !== language) await changeLanguage(option);
  }

  return (
    <div className="flex flex-col gap-2">
      {extra}
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 text-xs text-fg-on-nav-muted">
        <AiConnectionStatus />
        <div role="group" aria-label={t("nav.languageLabel")} className="flex gap-0.5">
          {SWITCH_ORDER.map((option) => (
            <Tooltip key={option} content={t(`languages.${option}`)} lang={option}>
              <Button
                variant="nav"
                lang={option}
                aria-label={t(`languages.${option}`)}
                aria-pressed={language === option}
                onClick={() => void choose(option)}
                className="min-w-control text-xs aria-pressed:bg-nav-current aria-pressed:font-semibold aria-pressed:text-fg-on-nav-current aria-pressed:hover:bg-nav-current"
              >
                {option.toUpperCase()}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
      {/* Always rendered, even empty, so a screen reader announces the message when it appears. */}
      <p role="status" className="px-2 text-xs text-fg-on-nav-warning">
        {/* The same message as in Settings, from the same state, naming the language that was saved. */}
        {language !== savedLanguage
          ? t("settings.languageNotSaved", { language: t(`languageInSentence.${language}`), previous: t(`languageInSentence.${savedLanguage}`) })
          : null}
      </p>
    </div>
  );
}

/**
 * Her notes for this session, under the sections (as in the reference). The AI takes them
 * into account in everything it drafts in this case until she starts a new session, which
 * keeps them in the case's file and empties the box.
 */
function SessionNotes({ caseId, initial }: { caseId: string; initial: string }) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const headingId = useId();
  const hintId = useId();
  // A new session starts a new box: its text, and what was saved of it, start empty.
  const [round, setRound] = useState(0);
  const [startFailed, setStartFailed] = useState(false);

  async function newSession(flush: () => Promise<void>) {
    await flush();
    const result = await window.aba.startNewSession(caseId).catch(() => null);
    setStartFailed(result?.outcome !== "saved");
    if (result?.outcome === "saved") {
      patch(caseId, { notes: result.notes });
      setRound((value) => value + 1);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-nav-hover px-3 py-3">
      <Eyebrow id={headingId} className="text-fg-on-nav-muted">
        {t("section.notesHeading")}
      </Eyebrow>
      <p id={hintId} className="text-xs text-fg-on-nav-muted">
        {t("section.notesHint")}
      </p>
      <NotesBox key={round} caseId={caseId} initial={round === 0 ? initial : ""} labelledBy={headingId} describedBy={hintId} onNewSession={newSession} />
      {startFailed ? (
        <p role="alert" className="text-xs font-medium text-fg-on-nav-warning">
          {t("section.actionFailed")}
        </p>
      ) : null}
    </section>
  );
}

function NotesBox({
  caseId,
  initial,
  labelledBy,
  describedBy,
  onNewSession,
}: {
  caseId: string;
  initial: string;
  labelledBy: string;
  describedBy: string;
  onNewSession: (flush: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const notes = useAutosave({
    key: `notes:${caseId}`,
    initial,
    save: async (text) => {
      const result = await window.aba.saveSessionNotes(caseId, text);
      if (result.outcome === "saved") patch(caseId, { notes: result.notes });
      return result.outcome === "saved";
    },
  });
  return (
    <>
      <textarea
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        data-testid="session-notes"
        value={notes.value}
        placeholder={t("section.notesPlaceholder")}
        onChange={(event) => notes.setValue(event.target.value)}
        onBlur={() => void notes.flush()}
        rows={4}
        className="min-h-24 w-full resize-y rounded-md bg-nav-hover px-2.5 py-2 text-sm text-fg-on-nav placeholder:text-fg-on-nav-muted"
      />
      {notes.status === "failed" ? (
        <p role="alert" className="text-xs font-medium text-fg-on-nav-warning">
          {t("section.actionFailed")}{" "}
          <button type="button" onClick={() => void notes.retry()} className="underline">
            {t("sources.tryAgain")}
          </button>
        </p>
      ) : null}
      {notes.value.trim() !== "" ? (
        <Tooltip content={t("section.newSessionHint")}>
          <Button variant="nav" size="sm" className="self-start" onClick={() => void onNewSession(notes.flush)}>
            {t("section.newSession")}
          </Button>
        </Tooltip>
      ) : null}
    </>
  );
}
