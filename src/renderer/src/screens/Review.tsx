import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ReportSectionText } from "../../../shared/api.ts";
import { REPORT_SECTIONS, type ReportSection, type ReportSectionId } from "../../../shared/report-sections.ts";
import { splitParagraphs } from "../../../shared/section-text.ts";
import { versionToCopy, type SectionSummary } from "../../../shared/sections.ts";
import { CASE_STEPS, casePath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { useOpenedCase, usePatchOpenedCase } from "../open-case.tsx";
import { beforePasting, firstToCopy, markedIn, reviewAction, wordsIn, type Marked } from "../review-view.ts";
import { copiedLead } from "../section-view.ts";
import { sectionStateText } from "../shell/Sidebar.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";
import { copiedSections } from "../step-states.ts";
import { Highlighted } from "./Section.tsx";

/*
 * Step 5, Revisión y copia (#/cases/<id>/review), owner's proposal §4 "5 · Revisión y copia"
 * and mockup 10; decisions T8 (copied marks stored per section), P2 (copy and approval) and
 * P4 (this v0 now, the AI's whole review later):
 *
 * - the nine sections in ABA Matrix's order, each with its number, title, state, words and
 *   what is still marked; "✓ Copiada" once what she copied last is what she would copy now;
 * - one primary "Copiar" on the first section ready and not copied yet; the others secondary,
 *   "Copiar otra vez" once copied; a section not ready offers what comes first (review the
 *   AI's draft, or start it);
 * - a copy is the section screen's copy: the same IPC (plain text and minimal HTML on the
 *   clipboard), the same line (what is still marked, where to paste it, not approved yet);
 * - below, the two ways: "Lee la evaluación completa" [Leer todo] and the AI's whole review,
 *   "Pronto";
 * - the rail: how many are copied, and "Antes de pegar".
 *
 * "Leer todo" (#/cases/<id>/review/read): every section, read only, in one scroll.
 */

/** The opened case's sections, each with the text of the version she would copy (read from the main process; null until read). */
function useReport(): { rows: Array<{ summary: SectionSummary; text: string | null }>; failed: boolean; read: boolean } {
  const opened = useOpenedCase();
  const [report, setReport] = useState<ReportSectionText[] | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  // Read again whenever the sections change (a copy, a version saved elsewhere): the texts follow them.
  useEffect(() => {
    const ask = ++asked.current;
    window.aba.readReport(opened.id).then(
      (result) => {
        if (ask !== asked.current) return;
        if (result.outcome === "read") {
          setReport(result.sections);
          setFailed(false);
        } else setFailed(true);
      },
      () => {
        if (ask === asked.current) setFailed(true);
      },
    );
  }, [opened.id, opened.sections]);
  const texts = new Map((report ?? []).map((item) => [item.summary.id, item]));
  const rows = REPORT_SECTIONS.map((section) => {
    const summary = opened.sections.find((item) => item.id === section.id) ?? emptySummary(section.id);
    const read = texts.get(section.id);
    // A text read for another version than the one she would copy now is not shown: it is being read again.
    return { summary, text: read && read.version === versionToCopy(summary) ? read.text : null };
  });
  return { rows, failed, read: report !== null };
}

function emptySummary(id: ReportSectionId): SectionSummary {
  return { id, state: "not-started", currentVersion: null, approvedVersion: null, versionCount: 0, costUsd: 0, copiedVersion: null, copied: false };
}

function reviewEyebrow(t: TFunction): string {
  return t("steps.position", { number: CASE_STEPS.indexOf("review") + 1, total: CASE_STEPS.length });
}

/** What the last copy did, shown under its row and said by the screen's live region. */
type LastCopy = { sectionId: ReportSectionId; outcome: "copied"; text: string; approved: boolean; marked: boolean } | { sectionId: ReportSectionId; outcome: "failed" };

export function ReviewScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const patch = usePatchOpenedCase();
  const { rows, failed, read } = useReport();
  const [last, setLast] = useState<LastCopy | null>(null);
  /** Emptied while a copy runs, so the same sentence after "Copiar otra vez" is announced again. */
  const [announced, setAnnounced] = useState(false);
  const primaryId = firstToCopy(rows.map((row) => row.summary));
  const copied = copiedSections(rows.map((row) => row.summary));
  const total = REPORT_SECTIONS.length;

  async function copy(summary: SectionSummary) {
    const version = versionToCopy(summary);
    if (version === null) return;
    setAnnounced(false);
    const result = await window.aba.copySection(opened.id, summary.id, version).catch(() => null);
    if (result?.outcome === "copied") {
      if (result.marked) patch(opened.id, { sections: result.marked.sections });
      const text = rows.find((row) => row.summary.id === summary.id)?.text ?? "";
      setLast({ sectionId: summary.id, outcome: "copied", text, approved: summary.approvedVersion === version, marked: result.marked !== null });
    } else {
      setLast({ sectionId: summary.id, outcome: "failed" });
    }
    setAnnounced(true);
  }

  const header = <StepHeader eyebrow={reviewEyebrow(t)} title={stepTitle(t, "review")} />;
  return (
    <WorkArea header={header} rail={<ReviewRail rows={rows} copied={copied} />} contentClassName="max-w-list">
      <div className="flex flex-col gap-5">
        <p role="status" data-testid="review-announcer" className="sr-only">
          {announced && last ? copySentence(t, last) : ""}
        </p>
        <p className="max-w-reading text-md">{t("review.intro")}</p>
        {copied === total ? (
          <p data-testid="review-all-copied" className="flex max-w-reading items-start gap-2 text-md font-medium text-success">
            <Icon name="check" className="mt-1 shrink-0" />
            {t("review.allCopied", { total })}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("review.readFailed")}
          </p>
        ) : null}
        <ol data-testid="review-list" aria-busy={!read} className="flex flex-col rounded-lg border border-border bg-surface">
          {rows.map((row, index) => (
            <ReviewRow
              key={row.summary.id}
              caseId={opened.id}
              section={REPORT_SECTIONS[index]}
              number={index + 1}
              summary={row.summary}
              text={row.text}
              primary={row.summary.id === primaryId}
              last={last?.sectionId === row.summary.id ? last : null}
              onCopy={() => void copy(row.summary)}
            />
          ))}
        </ol>
        <TwoWays
          layout="cards"
          hand={{
            title: t("review.readAllTitle"),
            body: t("review.readAllBody"),
            actions: (
              <ButtonLink to={`${casePath(opened.id, "review")}/read`} data-testid="read-all">
                {t("review.readAll")}
              </ButtonLink>
            ),
          }}
          ai={{
            title: t("review.aiTitle"),
            body: t("review.aiBody"),
            actions: <SoonTag />,
          }}
        />
      </div>
    </WorkArea>
  );
}

/** "Pronto" on the AI's card (owner's decision P4): not a button, the review with the AI comes later. */
function SoonTag() {
  const { t } = useTranslation();
  return (
    <span data-testid="review-ai-soon" className="inline-flex items-center rounded-sm border border-dashed border-accent px-2 py-0.5 text-sm font-medium text-fg-on-accent-subtle">
      {t("summary.soon")}
    </span>
  );
}

/** One section: its number, title, state, words and what is still marked; "✓ Copiada"; its one button (layout rule 5). */
function ReviewRow({
  caseId,
  section,
  number,
  summary,
  text,
  primary,
  last,
  onCopy,
}: {
  caseId: string;
  section: ReportSection;
  number: number;
  summary: SectionSummary;
  text: string | null;
  primary: boolean;
  last: LastCopy | null;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const action = reviewAction(summary);
  const words = wordsIn(text);
  const marked = markedIn(text);
  const meta = [sectionStateText(t, summary).long, words !== null ? t("review.words", { count: words }) : null].filter(Boolean).join(" · ");
  // She copied another version before (a newer one since, or another approved): say which, so the mark is not a surprise.
  const copiedBefore = !summary.copied && summary.copiedVersion !== null && summary.state !== "not-started";
  return (
    <li data-section={section.id} data-copied={summary.copied || undefined} className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3.5">
        <span aria-hidden="true" className="w-5 shrink-0 text-right font-mono text-sm text-fg-muted tabular-nums">
          {number}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={titleId} className="text-base font-semibold">
            <span className="sr-only">{number}. </span>
            {/* The title opens the section; plain until hovered, as in mockup 10 (the row's button is its action). */}
            <Link to={casePath(caseId, "report", section.id)} lang="en" className="rounded-sm text-fg underline-offset-2 hover:underline">
              {section.title}
            </Link>
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span>{meta}</span>
            {marked.count > 0 ? <MarkedChip marked={marked} /> : null}
            {copiedBefore ? <span>{t("review.copiedBefore", { number: summary.copiedVersion })}</span> : null}
          </p>
        </div>
        {summary.copied ? (
          <span data-testid="copied-mark" className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-success">
            <Icon name="check" />
            {t("chip.copied")}
          </span>
        ) : null}
        <div className="flex shrink-0">
          {action === "copy" || action === "copy-again" ? (
            // One element for both, so the focus stays on it when "Copiar" becomes "Copiar otra vez".
            <Button size="sm" variant={primary ? "primary" : "secondary"} data-testid="review-copy" aria-describedby={titleId} onClick={onCopy}>
              <Icon name="copy" />
              {action === "copy" ? t("section.copyShort") : t("section.copyAgain")}
            </Button>
          ) : (
            <ButtonLink to={casePath(caseId, "report", section.id)} size="sm" data-testid="review-open" aria-describedby={titleId}>
              {action === "review" ? t("review.reviewDraft") : t("summary.start")}
            </ButtonLink>
          )}
        </div>
      </div>
      {last ? <CopiedLine last={last} section={section} /> : null}
    </li>
  );
}

/** "1 dato por completar", "2 datos marcados": what the version she would copy still has marked. */
function MarkedChip({ marked }: { marked: Marked }) {
  const { t } = useTranslation();
  return (
    <span data-testid="marked-chip" className="rounded-sm bg-warning-subtle px-1.5 font-medium text-warning">
      {marked.allMissing ? t("review.toComplete", { count: marked.count }) : t("review.marked", { count: marked.count })}
    </span>
  );
}

/** After a copy, under its row: the section screen's copied line (P2), in the same words. */
function CopiedLine({ last, section }: { last: LastCopy; section: ReportSection }) {
  const { t } = useTranslation();
  if (last.outcome === "failed") {
    return (
      <p data-testid="copied-line" className="pl-8.5 text-sm font-medium text-danger">
        {t("section.copyFailed")}
      </p>
    );
  }
  const lead = copiedLead(last.text);
  const warn = lead.key !== "copiedLead" || !last.approved || !last.marked;
  return (
    <p data-testid="copied-line" className={cn("max-w-reading pl-8.5 text-sm font-medium", warn ? "text-warning" : "text-success")}>
      {lead.key === "copiedLead" ? t("section.copiedLead") : t(`section.${lead.key}`, { count: lead.count })} {pasteWhere(t, section)}
      {last.approved ? null : ` ${t("section.copiedNotApprovedYet")}`}
      {last.marked ? null : ` ${t("review.markNotSaved")}`}
    </p>
  );
}

function pasteWhere(t: TFunction, section: ReportSection): ReactNode {
  const [before, after] = t("section.pasteWhere", { section: "\u0000" }).split("\u0000");
  return (
    <>
      {before}
      <span lang="en">{section.title}</span>
      {after}
    </>
  );
}

/** The copied line as one sentence, for the live region. */
function copySentence(t: TFunction, last: LastCopy): string {
  if (last.outcome === "failed") return t("section.copyFailed");
  const section = REPORT_SECTIONS.find((item) => item.id === last.sectionId);
  const lead = copiedLead(last.text);
  const parts = [lead.key === "copiedLead" ? t("section.copiedLead") : t(`section.${lead.key}`, { count: lead.count }), t("section.pasteWhere", { section: section?.title ?? "" })];
  if (!last.approved) parts.push(t("section.copiedNotApprovedYet"));
  if (!last.marked) parts.push(t("review.markNotSaved"));
  return parts.join(" ");
}

/** The rail (layout rule 7): how many are copied, then "Antes de pegar". */
function ReviewRail({ rows, copied }: { rows: Array<{ summary: SectionSummary; text: string | null }>; copied: number }) {
  const { t } = useTranslation();
  const progressId = useId();
  const pasteId = useId();
  const total = REPORT_SECTIONS.length;
  const notes = beforePasting(rows);
  return (
    <>
      <section aria-labelledby={progressId} data-testid="review-progress" className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3.5">
        <Eyebrow id={progressId} className="text-fg-muted">
          {t("review.progressHeading")}
        </Eyebrow>
        <p className="text-md font-semibold">{t("review.progress", { copied, total })}</p>
        <span aria-hidden="true" className="flex gap-1">
          {rows.map((row) => (
            <span key={row.summary.id} className={cn("h-1.5 flex-1 rounded-full", row.summary.copied ? "bg-dot-done" : "bg-border")} />
          ))}
        </span>
        <p className="text-sm text-fg-muted">{t("review.progressNote")}</p>
      </section>
      <section aria-labelledby={pasteId} data-testid="before-pasting" className="flex flex-col gap-1.5">
        <Eyebrow id={pasteId} className="text-fg-muted">
          {t("review.beforePasting")}
        </Eyebrow>
        {notes.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("review.nothingMarked")}</p>
        ) : (
          <ul className="flex flex-col text-sm">
            {notes.map((note) => {
              const title = REPORT_SECTIONS.find((section) => section.id === note.sectionId)?.title ?? note.sectionId;
              const words =
                note.kind === "draft" ? t("review.noteDraft") : note.marked.allMissing ? t("review.noteToComplete", { count: note.marked.count }) : t("review.noteMarked", { count: note.marked.count });
              return (
                <li key={`${note.sectionId}-${note.kind}`} className="flex gap-2 border-b border-border py-2 last:border-b-0">
                  <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-warning" />
                  <span className="break-words">
                    <span lang="en" className="font-medium">
                      {title}
                    </span>
                    : {words}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/** "Leer todo" (#/cases/<id>/review/read): every section, read only, one after the other, in one scroll. */
export function ReadAllScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const { rows, failed, read } = useReport();
  const headings = useRef(new Map<ReportSectionId, HTMLHeadingElement>());
  const header = (
    <StepHeader
      eyebrow={`${reviewEyebrow(t)} · ${stepTitle(t, "review")}`}
      title={t("review.readTitle")}
      secondary={
        <ButtonLink to={casePath(opened.id, "review")} data-testid="back-to-review">
          {t("review.backToReview")}
        </ButtonLink>
      }
    />
  );
  const rail = (
    <nav aria-label={t("review.contents")} className="flex flex-col gap-1.5">
      <Eyebrow as="p" className="text-fg-muted">
        {t("review.contents")}
      </Eyebrow>
      <ol className="flex flex-col text-sm">
        {rows.map((row, index) => (
          <li key={row.summary.id}>
            <button
              type="button"
              onClick={() => {
                const heading = headings.current.get(row.summary.id);
                heading?.scrollIntoView({ block: "start" });
                heading?.focus({ preventScroll: true });
              }}
              className="flex min-h-control-sm w-full items-baseline gap-2 rounded-sm py-1 text-left hover:underline"
            >
              <span className="w-4 shrink-0 text-right font-mono text-xs text-fg-muted tabular-nums">{index + 1}</span>
              <span lang="en">{REPORT_SECTIONS[index].title}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
  return (
    <WorkArea header={header} rail={rail}>
      <div className="flex max-w-reading flex-col gap-8" aria-busy={!read}>
        <p className="text-md">{t("review.readIntro")}</p>
        {failed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("review.readFailed")}
          </p>
        ) : null}
        {rows.map((row, index) => {
          const section = REPORT_SECTIONS[index];
          const paragraphs = row.text === null ? [] : splitParagraphs(row.text);
          return (
            <article key={section.id} data-section={section.id} className="flex flex-col gap-3">
              <header className="flex flex-col gap-0.5 border-b border-border pb-2">
                <h2
                  tabIndex={-1}
                  ref={(element) => {
                    if (element) headings.current.set(section.id, element);
                    else headings.current.delete(section.id);
                  }}
                  className="scroll-mt-4 text-lg font-semibold outline-none"
                >
                  <span className="mr-2 font-mono text-sm font-normal text-fg-muted tabular-nums">{index + 1}</span>
                  <span lang="en">{section.title}</span>
                </h2>
                <p className="text-sm text-fg-muted">
                  {sectionStateText(t, row.summary).long}
                  {row.summary.copied ? ` · ${t("chip.copied")}` : null}
                </p>
              </header>
              {row.summary.state === "not-started" ? (
                <p className="text-sm text-fg-muted">{t("review.readNotStarted")}</p>
              ) : (
                paragraphs.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex} lang="en" className="text-md whitespace-pre-line">
                    <Highlighted text={paragraph} />
                  </p>
                ))
              )}
            </article>
          );
        })}
      </div>
    </WorkArea>
  );
}
