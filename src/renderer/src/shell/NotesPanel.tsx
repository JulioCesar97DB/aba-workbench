import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { FailedSave } from "../../../shared/sources.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import { onRetried, retry, useFailedSaveList } from "../case-saves.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { usePatchOpenedCase, useSetCaseSources } from "../open-case.tsx";

/*
 * Her notes for today (owner's decision T4): a button at the foot of the case's sidebar
 * opens them in a light panel from the right edge, so the sidebar no longer holds a text
 * box of its own and fits the window. The panel is not modal: the section stays readable
 * beside it, and a press outside closes it. The AI takes the notes into account in
 * everything it drafts in this case until she starts a new session, which keeps them in
 * the case's file and empties the box.
 *
 * There is one panel, and one box, for the open case (review round 1, S1): AppShell renders
 * it once, beside the sidebar, and the sidebar (and its copy in the Menu panel on a narrow
 * window) only holds the button that opens it. The panel stays mounted while closed
 * (Dialog's "panel" keeps it, hidden), so the box lives as long as the case is open: its
 * saves run in order on one queue, closing and opening never starts a second box from
 * older notes, and its status stays. A save that failed is said on the button too, on
 * every screen of the case, until it is saved (review round 1, S2).
 */

/** Opens today's notes: given by AppShell, used by the sidebar's button. */
export const OpenNotesContext = createContext<(() => void) | null>(null);

const isNotesOf = (caseId: string) => (item: FailedSave) => item.about === "notes" && item.caseId === caseId;

/** The button at the foot of the case's sidebar. */
export function NotesButton({ caseId, notes }: { caseId: string; notes: string }) {
  const { t } = useTranslation();
  const open = useContext(OpenNotesContext);
  const unsaved = useFailedSaveList().some(isNotesOf(caseId));
  const hasNotes = notes.trim() !== "";
  return (
    <button
      type="button"
      data-testid="notes-open"
      // In the Menu panel of a narrow window, the Menu panel closes as the notes open.
      data-closes-menu=""
      onClick={() => open?.()}
      className="flex min-h-control w-full items-center justify-between gap-2 rounded-lg border border-nav-hover px-2.5 text-left text-sm font-medium text-fg-on-nav transition-colors hover:bg-nav-hover"
    >
      <span>{t("section.notesOpen")}</span>
      {unsaved ? (
        <span className="text-xs font-semibold text-fg-on-nav-warning">{t("section.notesUnsaved")}</span>
      ) : hasNotes ? (
        <>
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-dot-draft" />
          <span className="sr-only">{t("section.notesHas")}</span>
        </>
      ) : null}
    </button>
  );
}

/** The panel and its box: one for the open case, rendered by AppShell. */
export function NotesPanel({ caseId, notes, open, onOpenChange }: { caseId: string; notes: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const isMine = useMemo(() => isNotesOf(caseId), [caseId]);
  // "Try again" saved notes kept from a failed save: the case holds them now.
  useEffect(
    () =>
      onRetried((item) => {
        if (isMine(item) && item.text !== null) patch(caseId, { notes: item.text });
      }),
    [isMine, caseId, patch],
  );
  return (
    <Dialog
      variant="panel"
      title={t("section.notesHeading")}
      open={open}
      onOpenChange={onOpenChange}
      // The caret goes after what she already wrote, so typing at once adds to it (review M5).
      initialFocus={() => {
        const box = boxRef.current;
        if (!box) return true;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        return false;
      }}
    >
      <SessionNotes caseId={caseId} initial={notes} boxRef={boxRef} isMine={isMine} />
    </Dialog>
  );
}

function SessionNotes({ caseId, initial, boxRef, isMine }: { caseId: string; initial: string; boxRef: RefObject<HTMLTextAreaElement | null>; isMine: (item: FailedSave) => boolean }) {
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
      <NotesBox key={round} caseId={caseId} initial={round === 0 ? initial : ""} describedBy={hintId} boxRef={boxRef} isMine={isMine} onNewSession={newSession} />
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

function NotesBox({
  caseId,
  initial,
  describedBy,
  boxRef,
  isMine,
  onNewSession,
}: {
  caseId: string;
  initial: string;
  describedBy: string;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  isMine: (item: FailedSave) => boolean;
  onNewSession: (flush: () => Promise<boolean>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const patch = usePatchOpenedCase();
  const setSources = useSetCaseSources();
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
  const ready = useKeptText(notes, isMine);
  // What the main process still keeps of her notes (a failed save, also from before a reload):
  // said here with Try again, as long as it is kept.
  const kept = useFailedSaveList().filter(isMine).at(-1) ?? null;
  const newSessionHintId = useId();
  return (
    <>
      <textarea
        ref={boxRef}
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
      {notes.status === "failed" || kept ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
          {/* Short here: the screen's own line (a section's, Sources', Home's) says the whole of it. */}
          {t("section.actionFailed")}
          <Button size="sm" onClick={() => (notes.status === "failed" || !kept ? void notes.retry() : retry(kept, (sources) => setSources(caseId, sources)))}>
            {t("sources.tryAgain")}
          </Button>
        </p>
      ) : null}
      {notes.value.trim() !== "" && notes.status !== "failed" ? (
        <div className="flex flex-col items-start gap-1">
          <Button size="sm" aria-describedby={newSessionHintId} onClick={() => void onNewSession(notes.flush)}>
            {t("section.newSession")}
          </Button>
          {/* Said under the button, not in a tooltip: it is what tells her the notes are kept, not deleted (review S3). */}
          <p id={newSessionHintId} className="text-xs text-fg-muted">
            {t("section.newSessionHint")}
          </p>
        </div>
      ) : null}
    </>
  );
}
