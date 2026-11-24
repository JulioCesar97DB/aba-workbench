import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  looksLikePdf,
  MAX_PDF_BYTES,
  type AddPdfsResult,
  type CaseSources,
  type PdfProblem,
  type PdfSizeWarning,
  type SourceSummary,
  type SourceType,
} from "../../../shared/sources.ts";
import { sourceAnswer, useCaseSaves, type SaveState } from "../case-saves.tsx";
import { bulkPastePath, CASE_STEPS, casePath, newTextPath, sourceTextPath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { NextStepCard } from "../components/NextStepCard.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { CHECKLIST, documentList, stepChecks, type ChecklistRow } from "../document-checklist.ts";
import { useProviders } from "../drafting-provider.tsx";
import { formatDate } from "../format.ts";
import { useWaitsForHerSections } from "../half-done.ts";
import { useIgnoredFolderPdfs } from "../ignored-folder-pdfs.ts";
import { useLanguage } from "../language.tsx";
import { useOpenedCase, useSetCaseSources } from "../open-case.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, useNarrowWindow, WorkArea } from "../shell/WorkArea.tsx";
import { formatCount, formatFileSize, formatSourceDate, SourceTypeLabel, sourceName, sourceNameLang, sourceTypeLang, sourceTypeName } from "../source-labels.tsx";
import { SourceDetailFields, useSourceDetails } from "../source-details.tsx";

/*
 * Step 1, Documentos (owner's proposal §4 "1 · Documentos", mockups 04 and 05): everything
 * the assessment is drafted from. The clinician pastes texts and adds PDFs, through the
 * system's dialog or by dropping them anywhere on the window; each PDF is copied into the
 * case's folder and the original is never touched. Every change is saved at once
 * (case-saves.tsx). Removing a document only marks it: it moves to "Documentos quitados",
 * where it can be restored, and "Deshacer" brings it straight back.
 *
 * Empty, the step shows the two ways as cards ("A mano": paste a text or add a PDF; "Con
 * la IA": what the AI does with the documents later, informative) and the checklist of
 * what an initial assessment usually has (document-checklist.ts, T14), each row adding a
 * document of its own type. With documents, one list in the checklist's order: a compact
 * row per document (type chip, title, one line of detail with a preview, "Abrir" and a
 * "⋯" menu), dashed rows for the expected types not added yet, the PDFs in the folder not
 * added ("Agregar" / "Ignorar") and "Documentos quitados (n)" at the foot. The rail opens
 * with "Siguiente paso" to the case map once there is one document (P5's soft rule).
 */

type Notice =
  | { kind: "removed"; source: SourceSummary }
  | { kind: "restored"; name: string }
  | { kind: "added"; count: number; problems: Array<{ name: string; problem: PdfProblem }> }
  | { kind: "error"; message: string };

/** Given to the new text's screen by the generic "Pegar un texto" (not a checklist row): its type is still to be chosen there. */
const PICK_TYPE = { pickType: true };

/** The step's place in the path, for every Documentos screen's eyebrow ("PASO 1 DE 5"). */
export function useDocumentsEyebrow(): string {
  const { t } = useTranslation();
  return t("steps.position", { number: CASE_STEPS.indexOf("sources") + 1, total: CASE_STEPS.length });
}

export function SourcesScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const { sources } = opened;
  const eyebrow = useDocumentsEyebrow();
  const narrow = useNarrowWindow();
  const { run } = useCaseSaves();
  const setSources = useSetCaseSources();
  const providers = useProviders();
  // While the connections load, the AI side is shown as connected: no flash of "Conectar la IA".
  const aiConnected = providers.loading || providers.available.length > 0;
  const ignored = useIgnoredFolderPdfs(caseId);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  // The control to focus once the screen has drawn the change (review S2): the one she pressed
  // (a checklist row's or a folder PDF's button, Ignorar, Mostrar) has gone with what it changed.
  const focusNext = useRef<string | null>(null);
  // Tried once, after the first render that follows the change, then dropped: a target that
  // never appears must not take the focus later, on another change (UX-4 review round 2, minor 2).
  useEffect(() => {
    const selector = focusNext.current;
    if (!selector) return;
    focusNext.current = null;
    document.querySelector<HTMLElement>(selector)?.focus();
  });
  /** After PDFs are added: the first new document's "Abrir". */
  const focusAdded = (added: string[]) => {
    if (added.length > 0) focusNext.current = `[data-open-source="${CSS.escape(added[0])}"]`;
  };

  const active = sources.sources.filter((source) => !source.removedAt);
  const removed = sources.sources.filter((source) => source.removedAt);
  const used = new Set(sources.sources.flatMap((source) => (source.kind === "pdf" ? [source.fileName] : [])));
  const loose = sources.files.filter((file) => !used.has(file.name));
  const looseShown = loose.filter((file) => !ignored.isIgnored(file));
  const looseIgnored = loose.length - looseShown.length;

  /** Shows what adding PDFs did: the case's sources as saved, how many were added, and why any were not. */
  const reportAdded = useCallback(
    (result: AddPdfsResult, earlier: { count: number; problems: Array<{ name: string; problem: PdfProblem }> } = { count: 0, problems: [] }) => {
      if (result.outcome === "cancelled") return;
      if (result.outcome === "done") {
        setSources(caseId, result.sources);
        setNotice({ kind: "added", count: earlier.count + result.added.length, problems: [...earlier.problems, ...result.problems] });
      } else if (result.outcome === "copied-not-added") {
        setSources(caseId, result.sources);
        setNotice({ kind: "error", message: t("sources.copiedNotAdded", { names: result.files.join(", ") }) });
      } else {
        setNotice({ kind: "error", message: t(`saveFailure.${result.outcome}`) });
      }
    },
    [caseId, setSources, t],
  );

  /**
   * PDFs through the system's dialog. From a checklist row, each PDF added whose file name
   * said nothing of its type ("other") gets that row's type: the same change as choosing the
   * type in "Nombre y fecha", saved right after. A name that does say it ("basc-3-prq.pdf"
   * chosen from the Vineland-3 row) keeps its own type (review, minor 1). A PDF copied but not
   * added (`copied-not-added`) gets its type guessed again when she adds it from the folder.
   */
  async function choosePdfs(type?: SourceType) {
    setAdding(true);
    try {
      const result = await window.aba.choosePdfs(caseId);
      reportAdded(result);
      if (result.outcome === "done") {
        focusAdded(result.added);
        if (type) {
          for (const id of result.added) {
            const added = result.sources.sources.find((source) => source.id === id);
            if (added && added.type === "other" && type !== "other") await run(async () => sourceAnswer(await window.aba.changeSource(caseId, id, { type })));
          }
        }
      }
    } catch {
      setNotice({ kind: "error", message: t("sources.addFailed") });
    } finally {
      setAdding(false);
    }
  }

  /** Dropped files, one at a time: each is read here and sent as bytes, never as a path. */
  const addDropped = useCallback(
    async (files: File[]) => {
      setAdding(true);
      const earlier = { count: 0, problems: [] as Array<{ name: string; problem: PdfProblem }> };
      let last: AddPdfsResult | null = null;
      try {
        for (const dropped of files) {
          // Too large to be worth reading: never sent at all.
          if (dropped.size > MAX_PDF_BYTES) {
            earlier.problems.push({ name: dropped.name, problem: "too-large" });
            continue;
          }
          let data: Uint8Array;
          try {
            // Only a PDF is read whole: a large video dropped by mistake is refused from its first bytes.
            if (!looksLikePdf(new Uint8Array(await dropped.slice(0, 1024).arrayBuffer()))) {
              earlier.problems.push({ name: dropped.name, problem: "not-a-pdf" });
              continue;
            }
            data = new Uint8Array(await dropped.arrayBuffer());
          } catch {
            // A folder, or a file the system would not let the window read.
            earlier.problems.push({ name: dropped.name, problem: "cannot-read" });
            continue;
          }
          if (last?.outcome === "done") {
            earlier.count += last.added.length;
            earlier.problems.push(...last.problems);
          }
          last = await window.aba.addDroppedPdf(caseId, { name: dropped.name, data });
          if (last.outcome !== "done") break;
        }
        if (last) reportAdded(last, earlier);
        else setNotice({ kind: "added", count: 0, problems: earlier.problems });
      } catch {
        setNotice({ kind: "error", message: t("sources.addFailed") });
      } finally {
        setAdding(false);
      }
    },
    [caseId, reportAdded, t],
  );

  const dragging = usePdfDrop(addDropped);

  async function remove(source: SourceSummary) {
    const answer = await run(async () => sourceAnswer(await window.aba.removeSource(caseId, source.id)));
    if (answer.ok) setNotice({ kind: "removed", source });
  }

  async function restore(source: SourceSummary) {
    const answer = await run(async () => sourceAnswer(await window.aba.restoreSource(caseId, source.id)));
    if (answer.ok) setNotice({ kind: "restored", name: sourceName(t, source) });
  }

  const addFromFolder = useCallback(
    async (name: string) => {
      try {
        const result = await window.aba.addFolderPdf(caseId, name);
        reportAdded(result);
        if (result.outcome === "done") focusAdded(result.added);
      } catch {
        setNotice({ kind: "error", message: t("sources.addFailed") });
      }
    },
    [caseId, reportAdded, t],
  );

  // Cmd+Z / Ctrl+Z undoes a removal, unless the focus is in a field (where it undoes typing).
  const removedSource = notice?.kind === "removed" ? notice.source : null;
  useEffect(() => {
    if (!removedSource) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z" || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      void restore(removedSource);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Ignorar: the focus goes to the next PDF's "Agregar" (the one before when it was the last), or to "Mostrar" when none is left. */
  function ignoreFolderPdf(file: CaseSources["files"][number]) {
    const index = looseShown.indexOf(file);
    const left = looseShown.filter((other) => other !== file);
    const next = left[Math.min(index, left.length - 1)];
    focusNext.current = next ? `[data-folder-add="${CSS.escape(next.name)}"]` : "[data-show-ignored]";
    ignored.ignore(file);
  }

  const empty = active.length === 0;
  const pasteLabel = t("sources.pasteText");
  const addPdfButton = () => (
    <Button onClick={() => void choosePdfs()} disabled={adding} focusableWhenDisabled>
      <Icon name="upload" />
      {t("sources.addPdf")}
    </Button>
  );
  // Empty, the two cards hold the actions; with documents, the header does (the rail's "Siguiente paso" is the primary).
  const header = (
    <StepHeader
      eyebrow={eyebrow}
      title={stepTitle(t, "sources")}
      // Below 1024 px the header keeps one row for the rail's button and the two actions: the list's
      // saves (remove, restore) say themselves in the notice, and a failure in SaveFailure (T2).
      status={narrow ? undefined : <SaveStatus />}
      secondary={
        empty ? undefined : (
          <ButtonLink to={newTextPath(caseId, "other")} state={PICK_TYPE}>
            {pasteLabel}
          </ButtonLink>
        )
      }
      primary={empty ? undefined : addPdfButton()}
    />
  );

  return (
    <WorkArea header={header} rail={<DocumentsRail active={active} sources={sources} />} railLabel={t("sources.stepHeading")} contentClassName="max-w-list">
      <div className="flex flex-col gap-5">
        <SaveFailure />
        <NoticeBar notice={notice} onUndo={(source) => void restore(source)} onDismiss={() => setNotice(null)} />
        <HalfDoneBanner caseId={caseId} />
        {empty ? (
          <>
            <p className="max-w-reading text-md">{t("sources.intro")}</p>
            <TwoWays
              layout="cards"
              aiConnected={aiConnected}
              connectWithoutActions
              hand={{
                title: t("sources.handTitle"),
                body: t("sources.handBody"),
                actions: (
                  <>
                    <ButtonLink variant="primary" to={newTextPath(caseId, "other")} state={PICK_TYPE}>
                      {pasteLabel}
                    </ButtonLink>
                    {addPdfButton()}
                  </>
                ),
              }}
              ai={{ title: t("sources.aiTitle"), body: t("sources.aiBody") }}
            />
            <Checklist caseId={caseId} adding={adding} onAddPdf={(type) => void choosePdfs(type)} />
          </>
        ) : (
          <>
            <TwoWays
              layout="bar"
              aiConnected={aiConnected}
              connectWithoutActions
              hand={{ body: t("sources.handBar") }}
              ai={{ body: t("sources.aiBar", { count: active.length }) }}
            />
            <DocumentList caseId={caseId} active={active} adding={adding} onAddPdf={(type) => void choosePdfs(type)} onRemove={(source) => void remove(source)} />
          </>
        )}
        {looseShown.length > 0 ? <FolderPdfs files={looseShown} onAdd={(name) => void addFromFolder(name)} onIgnore={ignoreFolderPdf} /> : null}
        {looseIgnored > 0 ? (
          <IgnoredLine
            count={looseIgnored}
            onShow={() => {
              focusNext.current = "[data-folder-add]";
              ignored.showAll();
            }}
          />
        ) : null}
        {removed.length > 0 ? <RemovedSources sources={removed} onRestore={(source) => void restore(source)} /> : null}
      </div>
      {dragging ? <DropOverlay /> : null}
    </WorkArea>
  );
}

/**
 * The case was started with "Ya escribí partes en ABA Matrix" (owner's proposal §4 "Nuevo
 * caso", T9): after the documents, her sections go in "Pegar lo que ya escribiste". Gone
 * once a section of hers is saved, here or on its own screen (half-done.ts).
 */
function HalfDoneBanner({ caseId }: { caseId: string }) {
  const { t } = useTranslation();
  const fromParts = useWaitsForHerSections(caseId, useOpenedCase().sections);
  if (!fromParts) return null;
  return (
    <div data-testid="half-done-banner" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-control bg-surface-muted px-4 py-2.5 text-md">
      <p className="flex min-w-0 flex-1 basis-64 items-baseline gap-2">
        <Icon name="pencil" className="shrink-0 self-center text-fg-muted" />
        {t("sources.halfDoneBanner")}
      </p>
      <ButtonLink to={bulkPastePath(caseId)} size="sm" className="shrink-0">
        {t("sources.halfDoneAction")}
      </ButtonLink>
    </div>
  );
}

/**
 * "Saving…" or "All saved" ("Todo guardado", §3.6), where the header's actions are. Shared with the text
 * editor and the details dialog. Shown, not announced: a screen reader would hear it after
 * every typing pause. Only a failure is announced (SaveFailure, role="alert").
 */
export function SaveStatus() {
  const { t } = useTranslation();
  const { state } = useCaseSaves();
  // Every label takes the same place, as wide as the longest: the buttons beside it never
  // move as the state changes (a click on "Back to sources" would land where it was).
  // The two labels are drawn hidden (::before, ::after) only to size it, so the page holds the text once.
  return (
    <p
      data-saving={t("sources.saving")}
      data-saved={t("sources.saved")}
      className="grid items-center self-center px-1 text-sm text-fg-muted before:invisible before:col-start-1 before:row-start-1 before:content-[attr(data-saving)] after:invisible after:col-start-1 after:row-start-1 after:content-[attr(data-saved)]"
    >
      <span className="col-start-1 row-start-1">
        <SaveStatusText state={state} />
      </span>
    </p>
  );
}

/** What could not be saved, and "Try again"; nothing while every change is saved. */
export function SaveFailure() {
  const { t } = useTranslation();
  const { state } = useCaseSaves();
  if (state.status !== "failed") return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-danger px-3.5 py-2 text-md font-medium text-danger">
      <span>{t(`saveFailure.${state.failure}`)}</span>
      <Button size="sm" onClick={state.retry}>
        {t("sources.tryAgain")}
      </Button>
    </div>
  );
}

function SaveStatusText({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state.status === "saving") return <>{t("sources.saving")}</>;
  if (state.status === "saved") return <>{t("sources.saved")}</>;
  return null;
}

/** The keys of a checklist row's words: camelCase, as hyphenated keys make the translation types too deep. */
const CHECKLIST_KEYS = {
  cde: "cde",
  "parent-interview": "parentInterview",
  "direct-observation": "directObservation",
  "fba-questionnaire": "fbaQuestionnaire",
  "vineland-3": "vineland3",
  "basc-3": "basc3",
  iep: "iep",
  "ablls-r": "abllsR",
  other: "other",
} as const satisfies Record<SourceType, string>;

/** A checklist row's name: the type's clinical name (English), or "Otro documento". */
function rowName(t: TFunction, type: SourceType): string {
  return type === "other" ? t("sources.otherTitle") : sourceTypeName(t, type);
}

/** What a checklist row's type is, and the form it usually comes in, in the screen's language. */
function rowWords(t: TFunction, row: ChecklistRow): { description: string; form: string } {
  return {
    description: t(`sources.checklist.${CHECKLIST_KEYS[row.type]}`),
    form: t(`sources.forms.${row.form === "text-or-pdf" ? "textOrPdf" : row.form}`),
  };
}

/** The empty step's checklist: what an initial assessment usually has, each with its own way to add it (T14). */
function Checklist({ caseId, adding, onAddPdf }: { caseId: string; adding: boolean; onAddPdf: (type: SourceType) => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={headingId} className="text-base font-semibold">
          {t("sources.checklistHeading")}
        </h2>
        <p className="text-sm text-fg-muted">{t("sources.checklistNote")}</p>
      </div>
      <ul aria-labelledby={headingId} data-testid="checklist" className="flex flex-col gap-1.5">
        {CHECKLIST.map((row) => (
          <MissingRow key={row.type} caseId={caseId} row={row} adding={adding} onAddPdf={onAddPdf} inList={false} />
        ))}
      </ul>
      <p className="text-sm text-fg-muted">{t("sources.dropAnywhere")}</p>
    </section>
  );
}

/**
 * A type with no document: its name, what it is, and "Pegar texto" / "Agregar PDF", which
 * add one of this type. Dashed: something that could be here. In the empty checklist it
 * also says what form it usually comes in; in the list it says it is not added.
 */
function MissingRow({ caseId, row, adding, onAddPdf, inList }: { caseId: string; row: ChecklistRow; adding: boolean; onAddPdf: (type: SourceType) => void; inList: boolean }) {
  const { t } = useTranslation();
  const nameId = useId();
  const { description, form } = rowWords(t, row);
  const detail = inList ? `${t("sources.notAdded")} · ${description}` : `${description} · ${form}`;
  const name = rowName(t, row.type);
  const lang = row.type === "other" ? undefined : sourceTypeLang(row.type);
  // Each row's buttons say whose they are in their own name too: nine "Pegar texto" in a
  // screen reader's list of links would be one and the same (review, minor 5).
  const suffix = (
    <span className="sr-only">
      {" · "}
      <span lang={lang}>{name}</span>
    </span>
  );
  return (
    <li
      data-testid="checklist-row"
      data-type={row.type}
      data-missing
      className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-dashed border-border-control px-3.5 py-2"
    >
      <div className="min-w-0 flex-1 basis-56">
        <h3 id={nameId} lang={lang} className="font-semibold">
          {name}
        </h3>
        <p className="text-sm text-fg-muted">{detail}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <ButtonLink size="sm" to={newTextPath(caseId, row.type)} aria-describedby={nameId}>
          {t("sources.pasteRow")}
          {suffix}
        </ButtonLink>
        <Button size="sm" aria-describedby={nameId} disabled={adding} focusableWhenDisabled onClick={() => onAddPdf(row.type)}>
          {t("sources.addPdf")}
          {suffix}
        </Button>
      </div>
    </li>
  );
}

/** The step with documents: one list in the checklist's order, documents and the expected types not added yet. */
function DocumentList({
  caseId,
  active,
  adding,
  onAddPdf,
  onRemove,
}: {
  caseId: string;
  active: SourceSummary[];
  adding: boolean;
  onAddPdf: (type: SourceType) => void;
  onRemove: (source: SourceSummary) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const entries = documentList(active);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="sr-only">
        {t("sources.listHeading")}
      </h2>
      <ul aria-labelledby={headingId} data-testid="document-list" className="flex flex-col gap-1.5">
        {entries.map((entry) =>
          entry.kind === "document" ? (
            <SourceRow key={entry.source.id} caseId={caseId} source={entry.source} onRemove={() => onRemove(entry.source)} />
          ) : (
            <MissingRow key={`missing-${entry.row.type}`} caseId={caseId} row={entry.row} adding={adding} onAddPdf={onAddPdf} inList />
          ),
        )}
      </ul>
    </section>
  );
}

/** A document: type chip, title, one line of detail (and a pasted text's first words), "Abrir" and "⋯" (Nombre y fecha, Quitar). */
function SourceRow({ caseId, source, onRemove }: { caseId: string; source: SourceSummary; onRemove: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const nameId = useId();
  const [confirming, setConfirming] = useState(false);
  const [details, setDetails] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const name = sourceName(t, source);
  const detail =
    source.kind === "text"
      ? [t("sources.kindText"), t("sources.characters", { count: source.characters, formatted: formatCount(language, source.characters) })]
      : [t("sources.kindPdf"), formatFileSize(language, source.bytes)];
  if (source.date) detail.splice(1, 0, formatSourceDate(language, source.date));
  if (source.kind === "pdf" && source.title) detail.push(source.fileName);
  if (source.kind === "text" && source.preview) detail.push(source.preview);

  return (
    <li data-testid="document-row" data-type={source.type} className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface px-3.5 py-2">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {name === sourceTypeName(t, source.type) ? null : (
            <StatusBadge className="shrink-0">
              <SourceTypeLabel t={t} type={source.type} />
            </StatusBadge>
          )}
          <h3 id={nameId} lang={sourceNameLang(source)} title={name} className="min-w-0 truncate font-semibold">
            {name}
          </h3>
        </div>
        <p data-testid="document-meta" className="truncate text-sm text-fg-muted">
          {detail.join(" · ")}
        </p>
        {source.kind === "pdf" && !source.present ? <p className="text-sm font-medium text-danger">{t("sources.missingFile", { name: source.fileName })}</p> : null}
        {source.kind === "pdf" && source.sizeWarning ? <SizeWarningText warning={source.sizeWarning} bytes={source.bytes} /> : null}
        {openFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("sources.openFailed")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {source.kind === "text" ? (
          <ButtonLink size="sm" to={sourceTextPath(caseId, source.id)} aria-describedby={nameId} data-open-source={source.id}>
            {t("sources.open")}
          </ButtonLink>
        ) : (
          <Button
            size="sm"
            aria-describedby={nameId}
            data-open-source={source.id}
            disabled={!source.present}
            focusableWhenDisabled
            onClick={() => {
              void window.aba.openSourcePdf(caseId, source.id).then(
                (opened) => setOpenFailed(!opened),
                () => setOpenFailed(true),
              );
            }}
          >
            {t("sources.open")}
          </Button>
        )}
        <MenuButton
          label={t("sources.moreActions", { name })}
          trigger={
            <Button size="sm" aria-label={t("sources.moreActions", { name })} className="px-2">
              <Icon name="more" size={16} />
            </Button>
          }
          items={[
            { key: "details", label: t("sources.nameAndDate"), onSelect: () => setDetails(true) },
            { key: "remove", label: t("sources.remove"), onSelect: () => setConfirming(true) },
          ]}
        />
      </div>
      <SourceDetailsDialog caseId={caseId} source={source} open={details} onOpenChange={setDetails} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("sources.confirmRemoveTitle", { name })}
        confirmLabel={t("sources.confirmRemove")}
        cancelLabel={t("sources.cancel")}
        onConfirm={onRemove}
      >
        <p>{t("sources.confirmRemoveBody")}</p>
        <p className="text-fg-muted">{source.kind === "pdf" ? t("sources.confirmRemovePdf") : t("sources.confirmRemoveText")}</p>
      </ConfirmDialog>
    </li>
  );
}

/** Type, title and date of a document, each saved as it changes ("Nombre y fecha" in the row's menu). */
function SourceDetailsDialog({ caseId, source, open, onOpenChange }: { caseId: string; source: SourceSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog title={t("sources.detailsTitle", { name: sourceName(t, source) })} open={open} onOpenChange={onOpenChange}>
      <DialogDescription className="mt-2 text-md text-fg-muted">{t("sources.detailsBody")}</DialogDescription>
      <div className="mt-4 flex flex-col gap-4">
        <ExistingSourceFields caseId={caseId} source={source} />
        <SaveStatus />
        <SaveFailure />
      </div>
      <div className="mt-5 flex justify-end">
        <DialogClose render={<Button variant="primary" />}>{t("sources.done")}</DialogClose>
      </div>
    </Dialog>
  );
}

/** The fields of a source that exists (the "Nombre y fecha" dialog). */
function ExistingSourceFields({ caseId, source }: { caseId: string; source: SourceSummary }) {
  const details = useSourceDetails({ caseId, sourceId: source.id, initial: { type: source.type, title: source.title ?? "", date: source.date ?? "" } });
  return <SourceDetailFields details={details} />;
}

/** The PDFs in the case's folder that are not documents of the case: "Agregar" or "Ignorar" each. */
function FolderPdfs({ files, onAdd, onIgnore }: { files: CaseSources["files"]; onAdd: (name: string) => void; onIgnore: (file: CaseSources["files"][number]) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="folder-pdfs" className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="text-base font-semibold">
          {t("sources.folderTitle", { count: files.length })}
        </h2>
        <p className="text-sm text-fg-muted">{t("sources.folderBody", { count: files.length })}</p>
      </div>
      <ul aria-labelledby={headingId} className="flex flex-col gap-1.5">
        {files.map((file, index) => (
          <li key={file.name} className="flex flex-wrap items-center justify-between gap-2">
            <span id={`${headingId}-${index}`} className="min-w-0 text-sm break-all">
              {file.name} <span className="text-fg-muted">· {formatFileSize(language, file.bytes)}</span>
            </span>
            <span className="flex shrink-0 gap-1.5">
              <Button size="sm" aria-describedby={`${headingId}-${index}`} data-folder-add={file.name} onClick={() => onAdd(file.name)}>
                {t("sources.folderAdd")}
              </Button>
              <Button size="sm" aria-describedby={`${headingId}-${index}`} onClick={() => onIgnore(file)}>
                {t("sources.folderIgnore")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How many folder PDFs she ignored, until the app starts again, and "Mostrar" to see them again. */
function IgnoredLine({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg-muted">
      <span>
        {t("sources.ignoredLine", { count })} · {t("sources.ignoredNote")} ·
      </span>
      <button type="button" data-show-ignored onClick={onShow} className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover">
        {t("sources.showIgnored")}
      </button>
    </p>
  );
}

function RemovedSources({ sources, onRestore }: { sources: SourceSummary[]; onRestore: (source: SourceSummary) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const listId = useId();
  return (
    <details data-testid="removed-documents" className="group flex flex-col gap-2">
      <summary className="flex min-h-control-sm cursor-default list-none items-center gap-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <Icon name="chevron" className="-rotate-90 text-accent transition-transform group-open:rotate-0" />
        <span className="font-medium text-accent underline underline-offset-2">{t("sources.removedHeading", { count: sources.length })}</span>
        <span className="text-fg-muted">· {t("sources.removedHint", { count: sources.length })}</span>
      </summary>
      <p className="max-w-measure text-sm text-fg-muted">{t("sources.removedBody")}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {sources.map((source, index) => (
          <li key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-muted px-3 py-2">
            <span id={`${listId}-${index}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <StatusBadge>
                <SourceTypeLabel t={t} type={source.type} />
              </StatusBadge>
              <span lang={sourceNameLang(source)} className="break-words">
                {sourceName(t, source)}
              </span>
              {source.removedAt ? <span className="text-sm text-fg-muted">· {t("sources.removedOn", { date: formatDate(language, source.removedAt) })}</span> : null}
            </span>
            <Button size="sm" aria-describedby={`${listId}-${index}`} onClick={() => onRestore(source)}>
              {t("sources.restore")}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The step's rail (layout rule 7: what helps act on the step, never a second copy of the
 * list). With a document: "Siguiente paso" to the case map first, as the screen's primary
 * (P5: from the first document); then what the step has (the CDE, interview and
 * observations; the scores; the IEP, optional) with the soft hint while any of the first
 * three is missing; then whether the PDFs fit what the AI reads at once. Empty: what the
 * step is, the hint, and "Siguiente paso" waiting for the first document.
 */
function DocumentsRail({ active, sources }: { active: SourceSummary[]; sources: CaseSources }) {
  const { t } = useTranslation();
  const { id: caseId } = useOpenedCase();
  const stepId = useId();
  const sizeId = useId();
  const empty = active.length === 0;
  const checks = stepChecks(active);
  const next = (
    <NextStepCard
      name={stepTitle(t, "case-map")}
      body={t("sources.nextBody")}
      to={casePath(caseId, "case-map")}
      action={t("sources.nextAction")}
      primary={!empty}
      disabledNote={empty ? t("sources.nextDisabled") : undefined}
    />
  );
  return (
    <>
      {empty ? null : next}
      <section aria-labelledby={stepId} className="flex flex-col gap-2">
        <Eyebrow id={stepId} className="text-fg-muted">
          {t("sources.stepHeading")}
        </Eyebrow>
        {empty ? (
          <p className="text-sm">{t("sources.stepAbout")}</p>
        ) : (
          <ul data-testid="step-checks" className="flex flex-col gap-1.5 text-sm">
            <StepCheck done={checks.coreMissing.length === 0} label={t("sources.checkCore")} />
            <StepCheck done={checks.scoresMissing.length === 0} label={t("sources.checkScores")} />
            <StepCheck done={checks.hasIep} optional label={t("sources.checkIep")} />
          </ul>
        )}
        {checks.coreMissing.length > 0 ? <p className="text-sm text-fg-muted">{t("sources.whenHint")}</p> : null}
      </section>
      {!active.some((source) => source.kind === "pdf") ? null : (
        <section aria-labelledby={sizeId} className="flex flex-col gap-1.5">
          <Eyebrow id={sizeId} className="text-fg-muted">
            {t("sources.sizeHeading")}
          </Eyebrow>
          <TotalSize sources={sources} active={active} />
        </section>
      )}
      {empty ? next : null}
    </>
  );
}

function StepCheck({ done, optional = false, label }: { done: boolean; optional?: boolean; label: string }) {
  const { t } = useTranslation();
  return (
    <li className={done ? "flex items-start gap-2" : "flex items-start gap-2 text-fg-muted"}>
      {done ? <Icon name="check" size={16} className="mt-0.5 text-success" /> : <span aria-hidden="true" className="w-4 shrink-0 text-center">–</span>}
      <span>
        <span className="sr-only">{done ? t("sources.checkDone") : optional ? null : t("sources.checkNotYet")} </span>
        {label}
      </span>
    </li>
  );
}

function SizeWarningText({ warning, bytes, total = false }: { warning: PdfSizeWarning; bytes: number; total?: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { sources } = useOpenedCase();
  const values = {
    size: formatFileSize(language, bytes),
    chatgpt: formatFileSize(language, sources.pdfLimits.chatgpt),
    claude: formatFileSize(language, sources.pdfLimits.claude),
  };
  const key = total ? (warning === "over-all" ? "sources.totalOverAll" : "sources.totalOverChatgpt") : warning === "over-all" ? "sources.sizeOverAll" : "sources.sizeOverChatgpt";
  return <p className="max-w-measure text-sm font-medium text-danger">{t(key, values)}</p>;
}

/** Whether the case's PDFs fit what each AI reads at once (the rail's "Tamaño para la IA"). */
function TotalSize({ sources, active }: { sources: CaseSources; active: SourceSummary[] }) {
  const { t } = useTranslation();
  // Only the PDFs' sizes are checked against each provider's limit for one request: the
  // sentence says that and no more (review S1; pasted texts and context windows are not checked).
  if (!sources.totalPdfWarning) return <p className="text-sm text-fg-muted">{t("sources.sizeFits")}</p>;
  // A single PDF over the limit already says so on its own row.
  if (active.some((source) => source.kind === "pdf" && source.sizeWarning === sources.totalPdfWarning)) return <p className="text-sm font-medium text-danger">{t("sources.sizeSeeRow")}</p>;
  const bytes = active.reduce((sum, source) => (source.kind === "pdf" ? sum + source.bytes : sum), 0);
  return <SizeWarningText warning={sources.totalPdfWarning} bytes={bytes} total />;
}

/** What just happened: a removal (with Undo), a restore, PDFs added and the ones that were not. */
function NoticeBar({ notice, onUndo, onDismiss }: { notice: Notice | null; onUndo: (source: SourceSummary) => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const undoRef = useRef<HTMLButtonElement>(null);
  const removedId = notice?.kind === "removed" ? notice.source.id : null;
  // The Remove button that started it is gone with its row: the focus goes to Undo.
  useEffect(() => {
    if (removedId) undoRef.current?.focus();
  }, [removedId]);
  let body: ReactNode = null;
  if (notice?.kind === "removed") {
    body = (
      <>
        <span>{t("sources.removedNotice", { name: sourceName(t, notice.source) })}</span>
        <Button ref={undoRef} size="sm" onClick={() => onUndo(notice.source)}>
          {t("sources.undo")}
        </Button>
      </>
    );
  } else if (notice?.kind === "restored") {
    body = <span>{t("sources.restoredNotice", { name: notice.name })}</span>;
  } else if (notice?.kind === "added") {
    body = (
      <div className="flex flex-col gap-1">
        {notice.count > 0 ? <span>{t("sources.added", { count: notice.count })}</span> : null}
        {notice.problems.map((problem, index) => (
          <span key={index} className="font-medium text-danger">
            {t(`pdfProblem.${problem.problem}`, { name: problem.name })}
          </span>
        ))}
      </div>
    );
  } else if (notice?.kind === "error") {
    body = <span className="font-medium text-danger">{notice.message}</span>;
  }
  return (
    // Always in the page, so a screen reader hears what appears in it; out of the layout while empty.
    <div role="status" className={body ? undefined : "absolute"}>
      {body ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-muted px-3.5 py-2 text-md">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{body}</div>
          {notice?.kind !== "removed" ? (
            <Button size="sm" onClick={onDismiss}>
              {t("sources.done")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DropOverlay() {
  const { t } = useTranslation();
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-backdrop p-6">
      <div className="flex max-w-md flex-col items-center gap-2 rounded-lg border-2 border-dashed border-accent bg-surface px-8 py-7 text-center shadow-popup">
        <p className="text-lg font-semibold">{t("sources.dropHint")}</p>
        <p className="text-md text-fg-muted">{t("sources.dropNote")}</p>
      </div>
    </div>
  );
}

/**
 * Files dragged over the window: true while they are over it, and `onDrop` gets them
 * when they are dropped. Only on this screen; elsewhere a drop does nothing (main.tsx).
 */
function usePdfDrop(onDrop: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) onDrop(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [onDrop]);
  return dragging;
}
