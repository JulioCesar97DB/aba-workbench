import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { bulkPastePath, CASE_STEPS, casePath, stepTitle, type CaseStep } from "../case-steps.tsx";
import { casesFolderProblemText } from "../cases-folder.tsx";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";
import { useOpenCaseState, useOpenedCase } from "../open-case.tsx";
import { sourceName, sourceNameLang } from "../source-labels.tsx";
import { sectionStateText } from "../shell/Sidebar.tsx";
import { formatUsd } from "./Section.tsx";
import { useLanguage } from "../language.tsx";
import { useWaitsForHerSections } from "../half-done.ts";
import type { SectionSummary } from "../../../shared/sections.ts";

/*
 * The case workspace: the five steps and the report's sections. AppShell opens the case
 * (src/renderer/src/open-case.tsx). The case opens on its summary (CaseSummary.tsx, owner's
 * decision T6). Documents has its own screens (Sources.tsx, SourceText.tsx), and so does the
 * case map (CaseMap.tsx); Plan and Review and copy say they come later (ComingLater.tsx).
 */

/** The case's screens, once it is open; otherwise why it cannot be. */
export function CaseRoute() {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const state = useOpenCaseState();
  // The case's saves outlive its screens (case-saves.tsx): leaving it never drops one under way.
  if (state?.outcome === "opened") return <Outlet />;
  if (state === null || state.outcome === "loading") {
    return (
      <WorkArea header={<PageHeader title={t("case.loading")} />}>
        <span />
      </WorkArea>
    );
  }
  const [title, body] =
    state.outcome === "unreadable"
      ? [t("case.unreadableTitle"), t(`unreadable.${state.reason}`)]
      : state.outcome === "folder-problem"
        ? [t("case.folderProblemTitle"), casesFolderProblemText(t, state.problem, platform)]
        : state.outcome === "error"
          ? [t("case.unreadableTitle"), t("case.openFailed")]
          : [t("case.notFoundTitle"), t("case.notFoundBody")];
  return (
    <WorkArea header={<PageHeader title={title} />}>
      <div className="flex max-w-measure flex-col items-start gap-3">
        <p className="text-md">{body}</p>
        <TextLink to="/">{t("case.backToCases")}</TextLink>
      </div>
    </WorkArea>
  );
}

export function useStepMeta(step: CaseStep): string {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  return `${opened.label} · ${t("steps.position", { number: CASE_STEPS.indexOf(step) + 1, total: CASE_STEPS.length })}`;
}

/** The report: its sections, each with its status. */
export function ReportScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const meta = useStepMeta("report");
  const states = new Map(opened.sections.map((section) => [section.id, section]));
  const { language } = useLanguage();
  // What the AI cost for this case: every version and check whose price is known (review, low 2).
  const spent = opened.sections.reduce((sum, section) => sum + section.costUsd, 0);
  // "Ya escribí partes" at creation puts the paste card first (T9); otherwise it waits under the sections, at any time (§4).
  const pasteFirst = useWaitsForHerSections(caseId, opened.sections);
  return (
    <WorkArea header={<PageHeader title={stepTitle(t, "report")} meta={meta} />} rail={<CaseRail />} railLabel={t("rail.sources")}>
      <div className="flex max-w-measure flex-col gap-5">
        <p className="text-md">{t("workspace.reportBody")}</p>
        {spent > 0 ? <p className="text-sm text-fg-muted">{t("section.caseCost", { cost: formatUsd(language, spent) })}</p> : null}
        {pasteFirst ? <PasteCard caseId={caseId} primary /> : null}
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell className="w-10">
                <span aria-hidden="true">#</span>
                <span className="sr-only">{t("workspace.reportNumberColumn")}</span>
              </TableHeaderCell>
              <TableHeaderCell>{t("workspace.reportSectionColumn")}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t("workspace.reportStatusColumn")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody className="text-base">
            {REPORT_SECTIONS.map((section, index) => (
              <TableRow key={section.id}>
                <TableCell className="py-2 font-mono text-xs text-fg-muted tabular-nums">{index + 1}</TableCell>
                <TableRowHeader className="py-2">
                  <TextLink to={casePath(caseId, "report", section.id)} lang="en">
                    {section.title}
                  </TextLink>
                </TableRowHeader>
                <TableCell className="py-2 text-right">
                  <SectionStateBadge summary={states.get(section.id)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pasteFirst ? null : <PasteCard caseId={caseId} />}
      </div>
    </WorkArea>
  );
}

/** "Pegar lo que ya escribiste": the nine sections on one screen (owner's decision T10). */
function PasteCard({ caseId, primary = false }: { caseId: string; primary?: boolean }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="paste-card" data-first={primary || undefined} className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border-control bg-surface px-4 py-3.5">
      <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
          <Icon name="pencil" className="text-fg-muted" />
          {t("workspace.pasteCardTitle")}
        </h2>
        <p className="text-sm text-fg-muted">{t("workspace.pasteCardBody")}</p>
      </div>
      <ButtonLink to={bulkPastePath(caseId)} variant={primary ? "primary" : "secondary"} className="shrink-0" aria-describedby={headingId}>
        {t("workspace.pasteCardAction")}
      </ButtonLink>
    </section>
  );
}

/** The right rail: the case's sources and the PDFs in its folder. Each section's checks are on its own screen. */
export function CaseRail() {
  const { t } = useTranslation();
  const { files, sources } = useOpenedCase();
  const active = sources.sources.filter((source) => !source.removedAt);
  const sourcesId = useId();
  const filesId = useId();
  return (
    <>
      <section aria-labelledby={sourcesId} className="flex flex-col gap-1.5">
        <Eyebrow id={sourcesId} className="text-fg-muted">
          {t("rail.sources")}
        </Eyebrow>
        {active.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {active.map((source) => (
              <li key={source.id} lang={sourceNameLang(source)} className="break-words">
                {sourceName(t, source)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{t("rail.noSources")}</p>
        )}
      </section>
      <section aria-labelledby={filesId} className="flex flex-col gap-1.5">
        <Eyebrow id={filesId} className="text-fg-muted">
          {t("rail.filesHeading")}
        </Eyebrow>
        {files.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {files.map((pdf) => (
              <li key={pdf.name} className="break-all">
                {pdf.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{t("rail.noFiles")}</p>
        )}
      </section>
    </>
  );
}


/** A section's state in the report's table. */
function SectionStateBadge({ summary }: { summary: SectionSummary | undefined }) {
  const { t } = useTranslation();
  if (!summary || summary.state === "not-started") return <StatusBadge>{t("status.notStarted")}</StatusBadge>;
  const text = sectionStateText(t, summary).long;
  return <StatusBadge tone={summary.state === "drafted" ? "accent" : "success"}>{text}</StatusBadge>;
}
