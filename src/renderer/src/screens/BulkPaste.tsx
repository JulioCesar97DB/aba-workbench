import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { REPORT_SECTIONS, type ReportSection, type ReportSectionId } from "../../../shared/report-sections.ts";
import { countWords, MAX_SECTION_TEXT_LENGTH, splitParagraphs } from "../../../shared/section-text.ts";
import type { SectionState } from "../../../shared/sections.ts";
import { filledBoxes, isFilled, saveBoxes, sectionChip, type PastedTexts } from "../bulk-paste.ts";
import { useFailedSavesLoaded, useSectionFailures } from "../case-saves.tsx";
import { casePath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { NextStepCard } from "../components/NextStepCard.tsx";
import { StateChip } from "../components/StateChip.tsx";
import { clearStartedFromParts, keepPastedDraft, onPastedSectionFlushed, pastedDrafts, savePastedSection } from "../half-done.ts";
import { useOpenedCase, usePatchOpenedCase } from "../open-case.tsx";
import { useSectionsBeingWritten } from "../section-generation.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
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

  // A text she pasted here that could not be saved, kept by the main process: after a reload it goes back in its box,
  // shown as not saved. Decided once, when the list of kept texts is known; a box she already has text in keeps hers.
  const loaded = useFailedSavesLoaded();
  const failures = useSectionFailures(caseId);
  const [restored, setRestored] = useState<string[] | null>(null);
  if (restored === null && loaded) {
    const kept = new Map<ReportSectionId, { id: string; text: string }>();
    for (const item of failures) {
      const section = REPORT_SECTIONS.find((candidate) => candidate.id === item.sectionId);
      // Only a pasted text (no editing pass): an edit of a version belongs to the section's own editor.
      if (item.about === "section" && section && item.editing === null && item.text !== null && !isFilled(texts[section.id])) kept.set(section.id, { id: item.id, text: item.text });
    }
    setRestored([...kept.values()].map((item) => item.id));
    if (kept.size > 0) {
      setTexts((current) => ({ ...current, ...Object.fromEntries([...kept].map(([id, item]) => [id, item.text])) }));
      setOpenRows((current) => new Set([...current, ...kept.keys()]));
      setOutcomes((current) => ({ ...current, ...Object.fromEntries([...kept.keys()].map((id) => [id, "failed"])) }));
      for (const [id, item] of kept) keepPastedDraft(caseId, id, item.text, { failed: true });
    }
  }
  // The main process is told the boxes show them: from now on, their saves are built on them.
  useEffect(() => {
    for (const id of restored ?? []) void window.aba.failedSaveShown(id).catch(() => undefined);
  }, [restored]);

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
        } else {
          failed++;
          setOpenRows((current) => new Set([...current, sectionId]));
          const text = boxes.find((box) => box.sectionId === sectionId)?.text ?? "";
          keepPastedDraft(caseId, sectionId, text, { failed: true });
        }
      },
    );
    // Her sections are in: the case no longer waits for them (the banner on Documentos and the card on top of the report go).
    if (saved > 0) clearStartedFromParts(caseId);
    setLastRun({ saved, failed });
    setSaving(false);
  }

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
        <p role="status" data-testid="bulk-paste-result" className={cn("text-sm font-medium empty:hidden", lastRun && lastRun.failed > 0 ? "text-danger" : "text-success")}>
          {lastRun ? (lastRun.failed > 0 ? t("bulkPaste.someFailed", { count: lastRun.failed }) : lastRun.saved > 0 ? t("bulkPaste.allSaved", { count: lastRun.saved }) : null) : null}
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
  const words = countWords(text);
  const note = writing ? t("bulkPaste.writing") : state !== "not-started" ? t("bulkPaste.hasText") : null;
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
          <Collapsible.Trigger className="flex min-h-control min-w-0 flex-1 basis-56 items-center gap-2.5 rounded-sm text-left">
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
            maxLength={MAX_SECTION_TEXT_LENGTH}
            onChange={(event) => onChange(event.target.value)}
            className={cn(
              "min-h-32 w-full max-w-reading resize-none overflow-hidden rounded-md border bg-surface px-3.5 py-2.5 text-md text-fg field-sizing-content disabled:bg-surface-muted",
              outcome === "failed" ? "border-danger" : "border-border-control",
            )}
          />
          <p id={hintId} className="text-sm text-fg-muted">
            {t("section.editorHint")} {t("section.editorParagraphs", { count: splitParagraphs(text).length })} · {t("section.editorWords", { count: words })}.
          </p>
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
          <li>{t("bulkPaste.railAi")}</li>
        </ul>
      </section>
      {done ? null : next}
    </>
  );
}
