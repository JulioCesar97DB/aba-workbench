import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  looksLikePdf,
  MAX_PDF_BYTES,
  TEXT_SOURCE_TYPES,
  type AddPdfsResult,
  type CaseSources,
  type PdfProblem,
  type PdfSizeWarning,
  type SourceSummary,
} from "../../../shared/sources.ts";
import { sourceAnswer, useCaseSaves, type SaveState } from "../case-saves.tsx";
import { newTextPath, sourceTextPath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { formatDate } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { useOpenedCase, useSetCaseSources } from "../open-case.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";
import { formatCount, formatFileSize, formatSourceDate, SourceTypeLabel, sourceName, sourceNameLang, sourceTypeLang, sourceTypeName } from "../source-labels.tsx";
import { SourceDetailFields, useSourceDetails } from "../source-details.tsx";
import { CaseRail, useStepMeta } from "./Case.tsx";

/*
 * The Sources step: everything the assessment is drafted from. The clinician pastes
 * texts (each with a type, and optionally a title and a date) and adds PDFs, through the
 * system's dialog or by dropping them onto the window; each PDF is copied into the
 * case's folder and the original is never touched. Every change is saved at once
 * (case-saves.tsx). Removing a source only marks it: it moves to "Removed sources",
 * where it can be restored, and "Undo" brings it straight back.
 */

type Notice =
  | { kind: "removed"; source: SourceSummary }
  | { kind: "restored"; name: string }
  | { kind: "added"; count: number; problems: Array<{ name: string; problem: PdfProblem }> }
  | { kind: "error"; message: string };

export function SourcesScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const { sources } = opened;
  const meta = useStepMeta("sources");
  const navigate = useNavigate();
  const { run } = useCaseSaves();
  const setSources = useSetCaseSources();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);

  const active = sources.sources.filter((source) => !source.removedAt);
  const removed = sources.sources.filter((source) => source.removedAt);
  const used = new Set(sources.sources.flatMap((source) => (source.kind === "pdf" ? [source.fileName] : [])));
  const loose = sources.files.filter((file) => !used.has(file.name));

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

  async function choosePdfs() {
    setAdding(true);
    try {
      reportAdded(await window.aba.choosePdfs(caseId));
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
    const answer = await run(`removed:${source.id}`, async () => sourceAnswer(await window.aba.removeSource(caseId, source.id)));
    if (answer.ok) setNotice({ kind: "removed", source });
  }

  async function restore(source: SourceSummary) {
    const answer = await run(`removed:${source.id}`, async () => sourceAnswer(await window.aba.restoreSource(caseId, source.id)));
    if (answer.ok) setNotice({ kind: "restored", name: sourceName(t, source) });
  }

  const addFromFolder = useCallback(
    async (name: string) => {
      try {
        reportAdded(await window.aba.addFolderPdf(caseId, name));
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

  const header = (
    <PageHeader
      title={stepTitle(t, "sources")}
      meta={meta}
      actions={
        <>
          <SaveStatus />
          <Button onClick={() => void choosePdfs()} disabled={adding} focusableWhenDisabled>
            {t("sources.addPdf")}
          </Button>
          <MenuButton
            label={t("sources.pasteTextMenu")}
            trigger={<Button variant="primary">{t("sources.pasteText")}</Button>}
            items={[...TEXT_SOURCE_TYPES].map((type) => ({
              key: type,
              label: sourceTypeName(t, type),
              lang: sourceTypeLang(type),
              onSelect: () => navigate(newTextPath(caseId, type)),
            }))}
          />
        </>
      }
    />
  );

  return (
    <WorkArea header={header} rail={<CaseRail />}>
      <div className="flex max-w-4xl flex-col gap-6">
        <SaveFailure />
        <NoticeBar notice={notice} onUndo={(source) => void restore(source)} onDismiss={() => setNotice(null)} />
        {active.length === 0 ? <EmptySources /> : <SourceList caseId={caseId} sources={active} onRemove={(source) => void remove(source)} />}
        <TotalSizeWarning sources={sources} />
        {loose.length > 0 ? <FolderPdfs files={loose} onAdd={(name) => void addFromFolder(name)} /> : null}
        {removed.length > 0 ? <RemovedSources sources={removed} onRestore={(source) => void restore(source)} /> : null}
      </div>
      {dragging ? <DropOverlay /> : null}
    </WorkArea>
  );
}

/**
 * "Saving…" or "All changes saved", where the header's actions are. Shared with the text
 * editor and the details dialog. Shown, not announced: a screen reader would hear it after
 * every typing pause. Only a failure is announced (SaveFailure, role="alert").
 */
export function SaveStatus() {
  const { state } = useCaseSaves();
  return (
    <p className="flex items-center self-center px-1 text-sm text-fg-muted">
      <SaveStatusText state={state} />
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

function EmptySources() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex max-w-xl flex-col items-start gap-3 rounded-lg border border-border bg-surface-muted p-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {t("sources.emptyTitle")}
      </h2>
      <p className="text-md">{t("sources.emptyBody")}</p>
      <p className="text-md text-fg-muted">{t("sources.emptyDrop")}</p>
    </section>
  );
}

function SourceList({ caseId, sources, onRemove }: { caseId: string; sources: SourceSummary[]; onRemove: (source: SourceSummary) => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-baseline gap-2 text-base font-semibold">
        {t("sources.listHeading")}
        <span className="font-mono text-xs font-normal text-fg-muted tabular-nums">{sources.length}</span>
      </h2>
      <ul aria-labelledby={headingId} className="flex flex-col gap-2">
        {sources.map((source) => (
          <SourceRow key={source.id} caseId={caseId} source={source} onRemove={() => onRemove(source)} />
        ))}
      </ul>
    </section>
  );
}

function SourceRow({ caseId, source, onRemove }: { caseId: string; source: SourceSummary; onRemove: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const nameId = useId();
  const [confirming, setConfirming] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const name = sourceName(t, source);
  const detail =
    source.kind === "text"
      ? [t("sources.kindText"), t("sources.characters", { count: source.characters, formatted: formatCount(language, source.characters) })]
      : [t("sources.kindPdf"), formatFileSize(language, source.bytes)];
  if (source.date) detail.push(formatSourceDate(language, source.date));

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3.5 @split:flex-row @split:items-start @split:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {name === sourceTypeName(t, source.type) ? null : (
            <StatusBadge>
              <SourceTypeLabel t={t} type={source.type} />
            </StatusBadge>
          )}
          <h3 id={nameId} lang={sourceNameLang(source)} className="font-semibold break-words">
            {name}
          </h3>
        </div>
        <p className="text-sm text-fg-muted">
          {detail.join(" · ")}
          {source.kind === "pdf" && source.title ? <span className="break-all"> · {source.fileName}</span> : null}
        </p>
        {source.kind === "text" && source.preview ? <p className="line-clamp-2 max-w-measure text-sm break-words">{source.preview}</p> : null}
        {source.kind === "pdf" && !source.present ? <p className="text-sm font-medium text-danger">{t("sources.missingFile", { name: source.fileName })}</p> : null}
        {source.kind === "pdf" && source.sizeWarning ? <SizeWarningText warning={source.sizeWarning} bytes={source.bytes} /> : null}
        {openFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("sources.openFailed")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {source.kind === "text" ? (
          <ButtonLink size="sm" to={sourceTextPath(caseId, source.id)} aria-describedby={nameId}>
            {t("sources.open")}
          </ButtonLink>
        ) : (
          <Button
            size="sm"
            aria-describedby={nameId}
            disabled={!source.present}
            focusableWhenDisabled
            onClick={() => {
              void window.aba.openSourcePdf(caseId, source.id).then(
                (opened) => setOpenFailed(!opened),
                () => setOpenFailed(true),
              );
            }}
          >
            {t("sources.openPdf")}
          </Button>
        )}
        <SourceDetailsDialog caseId={caseId} source={source} describedBy={nameId} />
        <Button size="sm" aria-describedby={nameId} onClick={() => setConfirming(true)}>
          {t("sources.remove")}
        </Button>
      </div>
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

function TotalSizeWarning({ sources }: { sources: CaseSources }) {
  if (!sources.totalPdfWarning) return null;
  const active = sources.sources.filter((source) => !source.removedAt);
  // A single PDF over the limit already says so on its own row.
  if (active.some((source) => source.kind === "pdf" && source.sizeWarning === sources.totalPdfWarning)) return null;
  const bytes = active.reduce((sum, source) => (source.kind === "pdf" ? sum + source.bytes : sum), 0);
  return <SizeWarningText warning={sources.totalPdfWarning} bytes={bytes} total />;
}

/** Type, title and date of a source, each saved as it changes. */
function SourceDetailsDialog({ caseId, source, describedBy }: { caseId: string; source: SourceSummary; describedBy: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      title={t("sources.detailsTitle", { name: sourceName(t, source) })}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" aria-describedby={describedBy}>
          {t("sources.details")}
        </Button>
      }
    >
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

/** The fields of a source that exists (the Details dialog). */
function ExistingSourceFields({ caseId, source }: { caseId: string; source: SourceSummary }) {
  const details = useSourceDetails({ caseId, sourceId: source.id, initial: { type: source.type, title: source.title ?? "", date: source.date ?? "" } });
  return <SourceDetailFields details={details} />;
}

function FolderPdfs({ files, onAdd }: { files: CaseSources["files"]; onAdd: (name: string) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t("sources.folderHeading")}
      </h2>
      <p className="max-w-measure text-md text-fg-muted">{t("sources.folderBody")}</p>
      <ul className="flex flex-col gap-1.5">
        {files.map((file, index) => (
          <li key={file.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span id={`${headingId}-${index}`} className="min-w-0 break-all">
              {file.name} <span className="text-sm text-fg-muted">· {formatFileSize(language, file.bytes)}</span>
            </span>
            <Button size="sm" aria-describedby={`${headingId}-${index}`} onClick={() => onAdd(file.name)}>
              {t("sources.addFromFolder")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RemovedSources({ sources, onRestore }: { sources: SourceSummary[]; onRestore: (source: SourceSummary) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const listId = useId();
  return (
    <details className="group flex flex-col gap-2">
      <summary className="flex min-h-control cursor-default items-center gap-2 text-base font-semibold">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" className="transition-transform group-open:rotate-90">
          <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("sources.removedHeading", { count: sources.length })}
      </summary>
      <p className="max-w-measure text-md text-fg-muted">{t("sources.removedBody")}</p>
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
