import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FailedSave } from "../../../shared/sources.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import { onRetried } from "../case-saves.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { usePatchOpenedCase } from "../open-case.tsx";

/*
 * Her notes for today (owner's decision T4): a button at the foot of the case's sidebar
 * opens them in a light panel from the right edge, so the sidebar no longer holds a text
 * box of its own and fits the window. The panel is not modal: the section stays readable
 * beside it, and a press outside closes it. The AI takes the notes into account in
 * everything it drafts in this case until she starts a new session, which keeps them in
 * the case's file and empties the box.
 *
 * The box is saved as she types, when it loses focus, and when the panel closes (the box
 * goes away, which saves what is waiting). Notes that could not be saved come back in the
 * box when it opens again, after a reload too (review round 2, B3).
 */
export function NotesPanel({ caseId, notes }: { caseId: string; notes: string }) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  // "Try again" on the screen saved notes kept from a failed save: the case holds them now,
  // so the box shows them the next time it opens. Listened to here, where it is always
  // mounted, not in the box, which exists only while the panel is open.
  const isMine = useCallback((item: FailedSave) => item.about === "notes" && item.caseId === caseId, [caseId]);
  useEffect(
    () =>
      onRetried((item) => {
        if (isMine(item) && item.text !== null) patch(caseId, { notes: item.text });
      }),
    [isMine, caseId, patch],
  );
  const hasNotes = notes.trim() !== "";
  return (
    <Dialog
      variant="panel"
      title={t("section.notesHeading")}
      trigger={
        <button
          type="button"
          data-testid="notes-open"
          className="flex min-h-control w-full items-center justify-between gap-2 rounded-lg border border-nav-hover px-2.5 text-left text-sm font-medium text-fg-on-nav transition-colors hover:bg-nav-hover"
        >
          <span>{t("section.notesOpen")}</span>
          {hasNotes ? (
            <>
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-dot-draft" />
              <span className="sr-only">{t("section.notesHas")}</span>
            </>
          ) : null}
        </button>
      }
    >
      <SessionNotes key={caseId} caseId={caseId} initial={notes} />
    </Dialog>
  );
}

function SessionNotes({ caseId, initial }: { caseId: string; initial: string }) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const hintId = useId();
  // A new session starts a new box: its text, and what was saved of it, start empty.
  const [round, setRound] = useState(0);
  const [startFailed, setStartFailed] = useState(false);

  async function newSession(flush: () => Promise<boolean>) {
    // Never start a new session over notes that are not saved (review, low 6): they would be left out of the archive.
    if (!(await flush())) {
      setStartFailed(true);
      return;
    }
    const result = await window.aba.startNewSession(caseId).catch(() => null);
    setStartFailed(result?.outcome !== "saved");
    if (result?.outcome === "saved") {
      patch(caseId, { notes: result.notes });
      setRound((value) => value + 1);
    }
  }

  return (
    <>
      <DialogDescription id={hintId} className="text-sm text-fg-muted">
        {t("section.notesHint")}
      </DialogDescription>
      <NotesBox key={round} caseId={caseId} initial={round === 0 ? initial : ""} describedBy={hintId} onNewSession={newSession} />
      {startFailed ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t("section.actionFailed")}
        </p>
      ) : null}
      <div className="mt-auto flex justify-end pt-2">
        <DialogClose render={<Button />}>{t("section.notesClose")}</DialogClose>
      </div>
    </>
  );
}

function NotesBox({ caseId, initial, describedBy, onNewSession }: { caseId: string; initial: string; describedBy: string; onNewSession: (flush: () => Promise<boolean>) => Promise<void> }) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const notes = useAutosave({
    caseId,
    initial,
    save: async (text) => {
      const result = await window.aba.saveSessionNotes(caseId, text);
      if (result.outcome === "saved") patch(caseId, { notes: result.notes });
      return result.outcome === "saved";
    },
  });
  // Notes she typed that could not be saved come back in this box after a reload (review round 2, B3).
  const isMine = useCallback((item: FailedSave) => item.about === "notes" && item.caseId === caseId, [caseId]);
  const ready = useKeptText(notes, isMine);
  return (
    <>
      <textarea
        aria-label={t("section.notesHeading")}
        aria-describedby={describedBy}
        data-testid="session-notes"
        readOnly={!ready}
        value={notes.value}
        placeholder={t("section.notesPlaceholder")}
        onChange={(event) => notes.setValue(event.target.value)}
        onBlur={() => void notes.flush()}
        // The box grows with what she writes: the panel is the one thing that scrolls.
        className="min-h-40 w-full resize-none rounded-md border border-border-control bg-surface px-3 py-2 text-md text-fg [field-sizing:content] placeholder:text-fg-muted"
      />
      {notes.status === "failed" ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
          {t("section.actionFailed")}
          <Button size="sm" onClick={() => void notes.retry()}>
            {t("sources.tryAgain")}
          </Button>
        </p>
      ) : null}
      {notes.value.trim() !== "" && notes.status !== "failed" ? (
        <Tooltip content={t("section.newSessionHint")}>
          <Button size="sm" className="self-start" onClick={() => void onNewSession(notes.flush)}>
            {t("section.newSession")}
          </Button>
        </Tooltip>
      ) : null}
    </>
  );
}
