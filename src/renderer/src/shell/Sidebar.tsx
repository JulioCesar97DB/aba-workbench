import { useId, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { SectionSummary } from "../../../shared/sections.ts";
import type { CaseMapSummary } from "../../../shared/case-map.ts";
import type { PlanSummary } from "../../../shared/plan.ts";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router";
import type { Language } from "../../../shared/api.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { CASE_STEPS, casePath, caseSummaryPath, stepSubtitle, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { titleWhenCut } from "../components/truncate.ts";
import { NavItem, SectionNavItem, StepNavItem } from "../components/NavItem.tsx";
import { readySections, stepCount, stepState, type StepState } from "../step-states.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { useConnections } from "../connections.tsx";
import { useLanguage } from "../language.tsx";
import { Eyebrow } from "./WorkArea.tsx";
import { NotesButton } from "./NotesPanel.tsx";

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

const STATE_TEXT_KEYS: Record<StepState, "nav.stepDone" | "nav.stepInProgress" | "nav.stepNotStarted" | "nav.stepLater"> = {
  done: "nav.stepDone",
  "in-progress": "nav.stepInProgress",
  "not-started": "nav.stepNotStarted",
  later: "nav.stepLater",
};

export function CaseSidebar({
  caseId,
  caseName,
  caseDetail,
  sections,
  notes,
  caseMap,
  plan,
  sourceCount,
}: {
  caseId: string;
  caseName: string;
  caseDetail: string;
  sections: SectionSummary[];
  notes: string;
  caseMap: CaseMapSummary;
  plan: PlanSummary;
  sourceCount: number;
}) {
  const { t } = useTranslation();
  const sectionsHeadingId = useId();
  const location = useLocation();
  const states = new Map(sections.map((section) => [section.id, section]));
  const inputs = { sources: sourceCount, caseMap, plan, sections };
  const ready = readySections(sections);
  // The report's sections are listed under its step only while she works on the report or
  // its review and copy; elsewhere the step's count says enough (owner's decision T18).
  const inReport = /^\/cases\/[^/]+\/(report|review)(\/|$)/.test(location.pathname);
  return (
    <SidebarFrame
      top={
        <div className="flex flex-col gap-0.5 px-2">
          <Brand />
          {/* The case's name opens its summary, where the case opens (owner's decision T6, mockup 03). */}
          <NavLink
            to={caseSummaryPath(caseId)}
            end
            data-testid="case-summary-link"
            className="-mx-2 flex flex-col gap-0.5 rounded-md px-2 text-fg-on-nav no-underline transition-colors hover:bg-nav-hover aria-[current=page]:bg-nav-hover"
          >
            {/* One line, cut with its whole name as a tooltip, so a long name never pushes the steps out of view (UX-5 follow-up). */}
            <span className="flex min-w-0 items-center gap-1.5 text-lg font-semibold">
              <span data-testid="case-name-line" className="min-w-0 truncate" onPointerEnter={(event) => titleWhenCut(event.currentTarget, caseName)}>
                {caseName}
              </span>
              <Icon name="forward" size={14} className="shrink-0" />
            </span>
            <span className="text-xs text-fg-on-nav-muted">{caseDetail}</span>
            <span className="sr-only">, {t("summary.title")}</span>
          </NavLink>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
            <Link to="/" className="rounded-sm text-fg-on-nav underline underline-offset-2 hover:decoration-2">
              {t("nav.allCases")}
            </Link>
            <NavLink to="/settings" className="rounded-sm text-fg-on-nav underline underline-offset-2 hover:decoration-2">
              {t("nav.settings")}
            </NavLink>
          </p>
        </div>
      }
      footer={<NotesButton caseId={caseId} notes={notes} />}
    >
      <nav aria-label={t("nav.stepsLabel")}>
        <ol className="flex flex-col gap-0.5">
          {CASE_STEPS.map((step, index) => {
            const state = stepState(step, inputs);
            const count = stepCount(step, inputs);
            const spoken =
              count === null
                ? null
                : count.spoken.key === "caseMap"
                  ? t("caseMap.sidebarCount", count.spoken.values as { approved: number; total: number })
                  : count.spoken.key === "plan"
                    ? t("nav.planCount", count.spoken.values as { decided: number; total: number })
                    : count.spoken.key === "sources"
                    ? t("nav.sourcesCount", count.spoken.values as { count: number })
                    : count.spoken.key === "review"
                      ? t("nav.reviewCount", count.spoken.values as { copied: number; total: number })
                      : t("nav.reportCount", count.spoken.values as { done: number; total: number });
            return (
              <li key={step}>
                <StepNavItem to={casePath(caseId, step)} number={index + 1} state={state} stateText={t(STATE_TEXT_KEYS[state])} laterTag={t("nav.stepLaterTag")} detail={count?.shown} subtitle={stepSubtitle(t, step)} compact={inReport}>
                  {stepTitle(t, step)}
                  {spoken ? <span className="sr-only">, {spoken}</span> : null}
                </StepNavItem>
                {step === "report" && inReport ? (
                  <nav aria-labelledby={sectionsHeadingId} className="mt-0.5 mb-1 ml-4 border-l border-nav-hover pl-2">
                    <h2 id={sectionsHeadingId} className="sr-only">
                      {t("nav.sectionsHeading")} · {t("section.reportReady", { done: ready, total: REPORT_SECTIONS.length })}
                    </h2>
                    <ul className="flex flex-col">
                      {REPORT_SECTIONS.map((section) => {
                        const summary = states.get(section.id) ?? { id: section.id, state: "not-started" as const, currentVersion: null, approvedVersion: null, versionCount: 0, costUsd: 0, copiedVersion: null, copied: false };
                        const text = sectionStateText(t, summary);
                        return (
                          <li key={section.id}>
                            <SectionNavItem to={casePath(caseId, "report", section.id)} title={section.title} state={summary.state} detail={text.short} statusLabel={text.long} />
                          </li>
                        );
                      })}
                    </ul>
                  </nav>
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>
    </SidebarFrame>
  );
}

/**
 * The case (or brand) on top, the lists in the middle, and the footer always in view. The
 * whole sidebar fits a 1366x768 window, the report's sections listed; on a shorter one the
 * middle scrolls, as the sidebar's one scroll area, and the footer (today's notes, the AI
 * connection, the language) stays reachable.
 */
function SidebarFrame({ top, children, footer }: { top: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 py-3.5">
      <div className="px-3.5">{top}</div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5">{children}</div>
      <div className="flex flex-col gap-2 px-3.5">
        {footer}
        <SidebarFooter />
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

function SidebarFooter() {
  const { t } = useTranslation();
  const { language, savedLanguage, changeLanguage } = useLanguage();

  async function choose(option: Language) {
    if (option !== language) await changeLanguage(option);
  }

  return (
    <div className="flex flex-col">
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
      <p role="status" className="px-2 text-xs text-fg-on-nav-warning [&:not(:empty)]:mt-1">
        {/* The same message as in Settings, from the same state, naming the language that was saved. */}
        {language !== savedLanguage
          ? t("settings.languageNotSaved", { language: t(`languageInSentence.${language}`), previous: t(`languageInSentence.${savedLanguage}`) })
          : null}
      </p>
    </div>
  );
}
