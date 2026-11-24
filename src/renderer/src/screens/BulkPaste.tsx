import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { REPORT_SECTIONS, type ReportSection, type ReportSectionId } from "../../../shared/report-sections.ts";
import { countWords, hasLinesInParagraphs, linesAsParagraphs, MAX_SECTION_TEXT_LENGTH, splitParagraphs } from "../../../shared/section-text.ts";
import type { SectionDetail, SectionState, SectionSummary } from "../../../shared/sections.ts";
import { filledBoxes, isFilled, isTooLong, saveBoxes, sectionChip, type PastedTexts } from "../bulk-paste.ts";
import { onRetried, useFailedSavesLoaded, useSectionFailures, type SectionFailure } from "../case-saves.tsx";
import { casePath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { NextStepCard } from "../components/NextStepCard.tsx";
import { StateChip } from "../components/StateChip.tsx";
import { clearStartedFromParts, keepPastedDraft, onPastedSectionFlushed, pastedDrafts, savePastedSection } from "../half-done.ts";
import { useLanguage } from "../language.tsx";
import { useOpenedCase, usePatchOpenedCase } from "../open-case.tsx";
import { useSectionsBeingWritten } from "../section-generation.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { formatCount } from "../source-labels.tsx";
import { LinesNotice } from "./Section.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

/*
 * "Pegar lo que ya escribiste" (#/cases/<id>/report/paste; owner's proposal §4 "4 · Informe"
 * and "Picking up a half-done assessment", decision T10): the nine sections in ABA Matrix's
 * order as collapsed rows, each with a box. "Guardar" saves each filled box through the
 * section's own save (window.aba.saveSectionText, no editing pass), one call per box, one
 * after another: each becomes her version of that section exactly as "Ya la escribí" makes
 * it on the section's screen. A box that could not be saved keeps its text and says so,
 * with "Volver a intentar"; the main process keeps it too (src/main/failed-saves.ts), so a
 * reload puts it back here. What the boxes hold is kept while the app runs (half-done.ts).
 */

type RowOutcome = "saving" | "saved" | "failed";

/** The newest kept text of each section with no editing pass, from the main process's list (oldest first). */
function keptTexts(failures: SectionFailure[]): Map<ReportSectionId, { id: string; text: string }> {
  const kept = new Map<ReportSectionId, { id: string; text: string }>();
  for (const item of failures) {
    const section = REPORT_SECTIONS.find((candidate) => candidate.id === item.sectionId);
    if (item.about === "section" && section && item.editing === null && item.text !== null) kept.set(section.id, { id: item.id, text: item.text });
  }
  return kept;
}

/** The case's sections with one of them as it is now. */
function withSummary(sections: SectionSummary[], detail: SectionDetail): SectionSummary[] {
  const { id, state, currentVersion, approvedVersion, versionCount, costUsd } = detail;
  return sections.map((section) => (section.id === id ? { id, state, currentVersion, approvedVersion, versionCount, costUsd } : section));
}

export function BulkPasteScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const patch = usePatchOpenedCase();
  const states = new Map(opened.sections.map((section) => [section.id, section.state]));
  const writing = useSectionsBeingWritten(caseId);
  const [texts, setTexts] = useState<PastedTexts>(() => pastedDrafts(caseId));
  const [openRows, setOpenRows] = useState<ReadonlySet<ReportSectionId>>(() => new Set(filledBoxes(pastedDrafts(caseId)).map((box) => box.sectionId)));
  const [outcomes, setOutcomes] = useState<Partial<Record<ReportSectionId, RowOutcome>>>({});
  const [saving, setSaving] = useState(false);
  const [lastRun, setLastRun] = useState<{ saved: number; failed: number } | null>(null);
  const [focusRow, setFocusRow] = useState<ReportSectionId | null>(null);

  /*
   * A text that could not be saved is kept by the main process, not here (half-done.ts, review round 1, S1): each time
   * the screen opens (a reload, or coming back to it), a section's kept text with no editing pass goes back in its box,
   * shown as not saved, unless she has text waiting in that box. Decided once per opening, when the list is known.
   * The section's own editor sends its first save with no editing pass too, so a text she could not save there shows
   * here as well; both boxes show the same kept text, and whichever saves it first makes it go from the other.
   */
  const loaded = useFailedSavesLoaded();
  const failures = useSectionFailures(caseId);
  const kept = keptTexts(failures);
  const [restored, setRestored] = useState<string[] | null>(null);
  if (restored === null && loaded) {
    const shown = [...kept].filter(([id]) => !isFilled(texts[id]));
    setRestored(shown.map(([, item]) => item.id));
    if (shown.length > 0) {
      setTexts((current) => ({ ...current, ...Object.fromEntries(shown.map(([id, item]) => [id, item.text])) }));
      setOpenRows((current) => new Set([...current, ...shown.map(([id]) => id)]));
      setOutcomes((current) => ({ ...current, ...Object.fromEntries(shown.map(([id]) => [id, "failed"])) }));
    }
  }
  // A box shown as not saved whose kept text is gone from the main process (saved or replaced somewhere else, such as
  // the section's own screen) no longer stands for anything: it empties, so it can never put an older text back.
  const stale = REPORT_SECTIONS.filter((section) => outcomes[section.id] === "failed" && !kept.has(section.id) && !saving);
  if (loaded && stale.length > 0) {
    setTexts((current) => ({ ...current, ...Object.fromEntries(stale.map((section) => [section.id, ""])) }));
    setOutcomes((current) => ({ ...current, ...Object.fromEntries(stale.map((section) => [section.id, undefined])) }));
    setOpenRows((current) => new Set([...current].filter((id) => !stale.some((section) => section.id === id))));
  }
  // The main process is told the boxes show them: from now on, their saves are built on them.
  useEffect(() => {
    for (const id of restored ?? []) void window.aba.failedSaveShown(id).catch(() => undefined);
  }, [restored]);

  const sectionsRef = useRef(opened.sections);
  useEffect(() => {
    sectionsRef.current = opened.sections;
  }, [opened.sections]);
  // "Volver a intentar" from elsewhere (Home, the summary, the header's save state) saved a box shown here as not saved:
  // it shows saved, and the case's sections are read again for its chip and the sidebar.
  useEffect(
    () =>
      onRetried((item) => {
        if (item.caseId !== caseId || item.about !== "section" || !item.sectionId) return;
        const sectionId = item.sectionId as ReportSectionId;
        setOutcomes((current) => (current[sectionId] === "failed" ? { ...current, [sectionId]: "saved" } : current));
        setTexts((current) => (current[sectionId] === item.text ? { ...current, [sectionId]: "" } : current));
        void window.aba.getSection(caseId, sectionId).then((result) => {
          if (result.outcome === "read") patch(caseId, { sections: withSummary(sectionsRef.current, result.section) });
        });
      }),
    [caseId, patch],
  );

  // A box saved as the window was about to close or reload (half-done.ts): if the window stays, it shows saved.
  useEffect(
    () =>
      onPastedSectionFlushed((savedCase, sectionId, sections) => {
        if (savedCase !== caseId) return;
        patch(caseId, { sections });
        setTexts((current) => ({ ...current, [sectionId]: "" }));
        setOutcomes((current) => ({ ...current, [sectionId]: "saved" }));
      }),
    [caseId, patch],
  );

  function change(sectionId: ReportSectionId, text: string) {
    // A new text in a box shown as not saved is hers to save from now on; the kept one stays kept until a save replaces it.
    setTexts((current) => ({ ...current, [sectionId]: text }));
    keepPastedDraft(caseId, sectionId, text);
    // A new text in a box that was saved or failed is a new paste: its old line goes.
    setOutcomes((current) => (current[sectionId] === "saved" || current[sectionId] === "failed" ? { ...current, [sectionId]: undefined } : current));
  }

  /** "Guardar" (every filled box) or a row's "Volver a intentar" (that box): one call per box, in ABA Matrix's order. */
  async function save(only?: ReportSectionId) {
    if (saving) return;
    const boxes = filledBoxes(only ? { [only]: texts[only] } : texts).filter((box) => !writing.has(box.sectionId));
    if (boxes.length === 0) return;
    setSaving(true);
    setLastRun(null);
    let saved = 0;
    let failed = 0;
    await saveBoxes(
      boxes,
      (sectionId, text) => {
        setOutcomes((current) => ({ ...current, [sectionId]: "saving" }));
        // Out of the kept drafts while it is being saved, so a close meanwhile does not save it twice.
        keepPastedDraft(caseId, sectionId, "");
        return savePastedSection(caseId, sectionId, text, (result) => patch(caseId, { sections: result.sections }));
      },
      (sectionId, outcome) => {
        setOutcomes((current) => ({ ...current, [sectionId]: outcome }));
        if (outcome === "saved") {
          saved++;
          setTexts((current) => ({ ...current, [sectionId]: "" }));
          setOpenRows((current) => new Set([...current].filter((id) => id !== sectionId)));
          // Its "Volver a intentar" goes with the row: the focus goes to the row's own button (review round 1, minor 3).
          if (only) setFocusRow(sectionId);
        } else {
          // The main process keeps its text now (half-done.ts): the box shows it while that lasts.
          failed++;
          setOpenRows((current) => new Set([...current, sectionId]));
        }
      },
    );
    // Her sections are in: the case no longer waits for them (the banner on Documentos and the card on top of the report go).
    if (saved > 0) clearStartedFromParts(caseId);
    setLastRun({ saved, failed });
    setSaving(false);
  }

  const result = lastRun ? (lastRun.failed > 0 ? t("bulkPaste.someFailed", { count: lastRun.failed }) : lastRun.saved > 0 ? t("bulkPaste.allSaved", { count: lastRun.saved }) : null) : null;
  const filled = filledBoxes(texts).filter((box) => !writing.has(box.sectionId)).length;
  const savedHere = Object.values(outcomes).some((outcome) => outcome === "saved");
  // Once what she pasted is saved and nothing waits, "Siguiente paso" is the screen's one primary (layout rule 9).
  const done = savedHere && filled === 0;
  const header = (
    <StepHeader
      eyebrow={t("bulkPaste.eyebrow", { total: REPORT_SECTIONS.length })}
      title={t("bulkPaste.title")}
      secondary={<ButtonLink to={casePath(caseId, "report")}>{t("bulkPaste.back")}</ButtonLink>}
      primary={
        <Button variant={done ? "secondary" : "primary"} data-testid="bulk-paste-save" disabled={saving || filled === 0} focusableWhenDisabled onClick={() => void save()}>
          {saving ? t("bulkPaste.saving") : filled === 0 ? t("bulkPaste.saveNone") : t("bulkPaste.save", { count: filled })}
        </Button>
      }
    />
  );

  return (
    <WorkArea header={header} rail={<BulkPasteRail done={done} />} contentClassName="max-w-list">
      <div className="flex flex-col gap-4">
        <p className="max-w-reading text-md">{t("bulkPaste.intro")}</p>
        {/* Always in the page, so its words are announced when they come (review round 1, minor 4); hidden while empty. */}
        <p role="status" data-testid="bulk-paste-result" className={cn("text-sm font-medium", !result && "sr-only", lastRun && lastRun.failed > 0 ? "text-danger" : "text-success")}>
          {result}
        </p>
        <h2 className="sr-only">{t("bulkPaste.listHeading")}</h2>
        <ol data-testid="bulk-paste-list" className="flex flex-col gap-2">
          {REPORT_SECTIONS.map((section, index) => (
            <PasteRow
              key={section.id}
              caseId={caseId}
              number={index + 1}
              section={section}
              state={states.get(section.id) ?? "not-started"}
              writing={writing.has(section.id)}
              text={texts[section.id] ?? ""}
              outcome={outcomes[section.id] ?? null}
              open={openRows.has(section.id)}
              busy={saving}
              onOpenChange={(open) => setOpenRows((current) => (open ? new Set([...current, section.id]) : new Set([...current].filter((id) => id !== section.id))))}
              onChange={(text) => change(section.id, text)}
              onRetry={() => void save(section.id)}
              focusTrigger={focusRow === section.id}
              onFocused={() => setFocusRow(null)}
            />
          ))}
        </ol>
      </div>
    </WorkArea>
  );
}

function PasteRow({
  caseId,
  number,
  section,
  state,
  writing,
  text,
  outcome,
  open,
  busy,
  onOpenChange,
  onChange,
  onRetry,
  focusTrigger,
  onFocused,
}: {
  caseId: string;
  number: number;
  section: ReportSection;
  state: SectionState;
  writing: boolean;
  text: string;
  outcome: RowOutcome | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (text: string) => void;
  onRetry: () => void;
  /** Its "Volver a intentar" just saved it and went with the row: the row's own button takes the focus. */
  focusTrigger: boolean;
  onFocused: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const hintId = useId();
  const noteId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  // Opened by her (the row's button): the focus goes to its box.
  const focusBox = useRef(false);
  useEffect(() => {
    if (!open || !focusBox.current) return;
    focusBox.current = false;
    box.current?.focus();
  }, [open]);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusTrigger) return;
    trigger.current?.focus();
    onFocused();
  }, [focusTrigger, onFocused]);
  const { language } = useLanguage();
  const words = countWords(text);
  // Saving over an approved section takes its approval away (review round 1, S3): said before she saves.
  const note = writing ? t("bulkPaste.writing") : state === "approved" ? t("bulkPaste.hasApproved") : state !== "not-started" ? t("bulkPaste.hasText") : null;
  const tooLong = isTooLong(text);
  return (
    <li data-testid="paste-row" data-section={section.id} data-outcome={outcome ?? undefined} className={cn("rounded-lg border bg-surface", outcome === "failed" ? "border-danger" : open ? "border-border-control" : "border-border")}>
      <Collapsible.Root
        open={open}
        onOpenChange={(next) => {
          focusBox.current = next;
          onOpenChange(next);
        }}
      >
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
          <Collapsible.Trigger ref={trigger} className="flex min-h-control min-w-0 flex-1 basis-56 items-center gap-2.5 rounded-sm text-left">
            <Icon name="chevron" className={cn("shrink-0 text-accent transition-transform", open ? "rotate-0" : "-rotate-90")} />
            <span aria-hidden="true" className="w-5 shrink-0 text-right font-mono text-xs text-fg-muted tabular-nums">
              {number}
            </span>
            <span id={titleId} lang="en" className="min-w-0 text-base font-semibold break-words">
              {section.title}
            </span>
            {!open && isFilled(text) ? <span className="shrink-0 text-sm text-fg-muted">· {t("section.editorWords", { count: words })}</span> : null}
          </Collapsible.Trigger>
          {outcome === "saved" && !open ? (
            <span className="flex shrink-0 items-center gap-2 text-sm">
              <span className="font-medium text-success">{t("bulkPaste.saved")}</span>
              <TextLink to={casePath(caseId, "report", section.id)} aria-describedby={titleId}>
                {t("bulkPaste.openSection")}
              </TextLink>
            </span>
          ) : null}
          <StateChip state={writing ? "writing" : sectionChip(state)} />
        </div>
        <Collapsible.Panel className="flex flex-col gap-1.5 px-3 pb-3">
          {note ? (
            <p id={noteId} className="max-w-reading text-sm text-fg-muted">
              {note}
            </p>
          ) : null}
          <label htmlFor={`${titleId}-box`} className="sr-only">
            {t("bulkPaste.boxLabel", { section: section.title })}
          </label>
          <textarea
            ref={box}
            id={`${titleId}-box`}
            lang="en"
            data-testid="paste-box"
            aria-describedby={note ? `${noteId} ${hintId}` : hintId}
            value={text}
            disabled={writing}
            readOnly={busy}
            onChange={(event) => onChange(event.target.value)}
            className={cn(
              "min-h-32 w-full max-w-reading resize-none overflow-hidden rounded-md border bg-surface px-3.5 py-2.5 text-md text-fg field-sizing-content disabled:bg-surface-muted",
              outcome === "failed" ? "border-danger" : "border-border-control",
            )}
          />
          <p id={hintId} className="text-sm text-fg-muted">
            {t("section.editorHint")} {t("section.editorParagraphs", { count: splitParagraphs(text).length })} · {t("section.editorWords", { count: words })}.
          </p>
          {tooLong ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t("bulkPaste.tooLong", { max: formatCount(language, MAX_SECTION_TEXT_LENGTH) })}
            </p>
          ) : null}
          {!busy && hasLinesInParagraphs(text) ? <LinesNotice onTreat={() => onChange(linesAsParagraphs(text))} /> : null}
          {outcome === "failed" ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
              {t("bulkPaste.failed")}
              <Button size="sm" disabled={busy} focusableWhenDisabled onClick={onRetry}>
                {t("bulkPaste.tryAgain")}
              </Button>
            </p>
          ) : null}
          {outcome === "saving" ? <p className="text-sm text-fg-muted">{t("bulkPaste.saving")}</p> : null}
        </Collapsible.Panel>
      </Collapsible.Root>
    </li>
  );
}

/** The rail: how the screen works, then "Siguiente paso" to the report (its button the primary once what she pasted is saved). */
function BulkPasteRail({ done }: { done: boolean }) {
  const { t } = useTranslation();
  const { id: caseId } = useOpenedCase();
  const headingId = useId();
  const next = <NextStepCard name={stepTitle(t, "report")} body={t("bulkPaste.nextBody")} to={casePath(caseId, "report")} action={t("bulkPaste.nextAction")} primary={done} />;
  return (
    <>
      {done ? next : null}
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <Eyebrow id={headingId} className="text-fg-muted">
          {t("bulkPaste.railHeading")}
        </Eyebrow>
        <ul className="flex flex-col gap-2 text-sm">
          <li>{t("bulkPaste.railYours")}</li>
          <li>{t("bulkPaste.railVersions")}</li>
          <li>{t("bulkPaste.railClose")}</li>
          <li>{t("bulkPaste.railAi")}</li>
        </ul>
      </section>
      {done ? null : next}
    </>
  );
}
