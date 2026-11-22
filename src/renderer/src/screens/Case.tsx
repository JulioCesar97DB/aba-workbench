import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useParams } from "react-router";
import { findReportSection, REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { CASE_STEPS, casePath, PREVIEW_CASE_ID, stepTitle, stepTitleLang, type CaseStep } from "../case-steps.tsx";
import { TextLink } from "../components/Link.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";
import { Placeholder } from "./Placeholder.tsx";

/*
 * The case workspace. Only the preview case exists until cases can be created and opened
 * (the next task): it shows the layout, the five steps and the report's sections, with
 * a placeholder on each screen that says what will be there.
 */

/** The case's screens; the sidebar shows the case (AppShell). Any case but the preview is not found. */
export function CaseRoute() {
  const { t } = useTranslation();
  const { caseId = "" } = useParams();
  if (caseId !== PREVIEW_CASE_ID) {
    return (
      <WorkArea header={<PageHeader title={t("case.notFoundTitle")} />}>
        <div className="flex max-w-measure flex-col items-start gap-3">
          <p className="text-md">{t("case.notFoundBody")}</p>
          <TextLink to="/">{t("case.backToCases")}</TextLink>
        </div>
      </WorkArea>
    );
  }
  return <Outlet />;
}

export function CaseIndex() {
  return <Navigate to="sources" replace />;
}

function useStepMeta(step: CaseStep): string {
  const { t } = useTranslation();
  return `${t("case.previewName")} · ${t("steps.position", { number: CASE_STEPS.indexOf(step) + 1, total: CASE_STEPS.length })}`;
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
  const { caseId = PREVIEW_CASE_ID } = useParams();
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
  const { caseId = PREVIEW_CASE_ID, sectionId } = useParams();
  const section = findReportSection(sectionId);
  if (!section) return <Navigate to={casePath(caseId, "report")} replace />;
  const number = REPORT_SECTIONS.indexOf(section) + 1;
  return (
    <WorkArea
      header={
        <PageHeader
          title={section.title}
          titleLang="en"
          meta={`${t("case.previewName")} · ${t("workspace.sectionPosition", { number, total: REPORT_SECTIONS.length })}`}
        />
      }
      rail={<CaseRail />}
    >
      <Placeholder>{t("workspace.sectionBody")}</Placeholder>
    </WorkArea>
  );
}

/** The right rail: the case's sources and the checks run on a draft. Empty for now. */
function CaseRail() {
  const { t } = useTranslation();
  const sourcesId = useId();
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

