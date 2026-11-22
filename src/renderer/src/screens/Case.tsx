import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useParams } from "react-router";
import { findReportSection, REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { CASE_STEPS, casePath, stepTitle, stepTitleLang, type CaseStep } from "../case-steps.tsx";
import { casesFolderProblemText } from "../cases-folder.tsx";
import { TextLink } from "../components/Link.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";
import { useOpenCaseState, useOpenedCase } from "../open-case.tsx";
import { Placeholder } from "./Placeholder.tsx";

/*
 * The case workspace: the five steps and the report's sections. AppShell opens the case
 * (src/renderer/src/open-case.tsx); the steps are placeholders until later phases fill them.
 */

/** The case's screens, once it is open; otherwise why it cannot be. */
export function CaseRoute() {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const state = useOpenCaseState();
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

export function CaseIndex() {
  return <Navigate to="sources" replace />;
}

function useStepMeta(step: CaseStep): string {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  return `${opened.label} · ${t("steps.position", { number: CASE_STEPS.indexOf(step) + 1, total: CASE_STEPS.length })}`;
}

const STEP_BODIES = {
  sources: "workspace.sourcesBody",
  behaviors: "workspace.behaviorsBody",
  interventions: "workspace.interventionsBody",
  review: "workspace.reviewBody",
} as const;

/** Sources, Behaviors, Interventions, Review and copy: placeholders for now. */
export function StepScreen({ step }: { step: keyof typeof STEP_BODIES }) {
  const { t } = useTranslation();
  const meta = useStepMeta(step);
  return (
    <WorkArea header={<PageHeader title={stepTitle(t, step)} titleLang={stepTitleLang(step)} meta={meta} />} rail={<CaseRail />}>
      <Placeholder>
        <TransWithTerms i18nKey={STEP_BODIES[step]} />
      </Placeholder>
    </WorkArea>
  );
}

/** The report: its sections, each with its status. */
export function ReportScreen() {
  const { t } = useTranslation();
  const caseId = useOpenedCase().id;
  const meta = useStepMeta("report");
  return (
    <WorkArea header={<PageHeader title={stepTitle(t, "report")} meta={meta} />} rail={<CaseRail />}>
      <div className="flex max-w-measure flex-col gap-5">
        <Placeholder>{t("workspace.reportBody")}</Placeholder>
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
                  <StatusBadge>{t("status.notStarted")}</StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </WorkArea>
  );
}

/** One section of the report. */
export function ReportSectionScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const { sectionId } = useParams();
  const section = findReportSection(sectionId);
  if (!section) return <Navigate to={casePath(caseId, "report")} replace />;
  const number = REPORT_SECTIONS.indexOf(section) + 1;
  return (
    <WorkArea
      header={
        <PageHeader
          title={section.title}
          titleLang="en"
          meta={`${opened.label} · ${t("workspace.sectionPosition", { number, total: REPORT_SECTIONS.length })}`}
        />
      }
      rail={<CaseRail />}
    >
      <Placeholder>{t("workspace.sectionBody")}</Placeholder>
    </WorkArea>
  );
}

/** The right rail: the case's sources, the PDFs in its folder, and the checks run on a draft. */
function CaseRail() {
  const { t } = useTranslation();
  const { files } = useOpenedCase();
  const sourcesId = useId();
  const filesId = useId();
  const checksId = useId();
  const checks = [t("rail.checkStructure"), t("rail.checkMissing"), t("rail.checkContradictions")];
  return (
    <>
      <section aria-labelledby={sourcesId} className="flex flex-col gap-1.5">
        <Eyebrow id={sourcesId} className="text-fg-muted">
          {t("rail.sources")}
        </Eyebrow>
        <p className="text-sm text-fg-muted">{t("rail.noSources")}</p>
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
      <section aria-labelledby={checksId} className="flex flex-col gap-1.5">
        <Eyebrow id={checksId} className="text-fg-muted">
          {t("rail.checks")}
        </Eyebrow>
        <Table>
          <TableBody>
            {checks.map((check) => (
              <TableRow key={check}>
                <TableRowHeader>{check}</TableRowHeader>
                <TableCell className="text-right">
                  <StatusBadge>{t("status.notRun")}</StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

