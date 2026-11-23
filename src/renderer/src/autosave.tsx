import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FailedSave } from "../../shared/sources.ts";
import { onRetried, registerFlusher, trackSave, useFailedSaveList, useFailedSavesLoaded } from "./case-saves.tsx";

/*
 * Text saved as she types, with no Save button: when typing pauses, when the field loses
 * focus, when the screen goes away, and when the window is about to close or reload
 * (registerFlusher). Saves run one after another, in order, so a later one never lands
 * before an earlier one. A failed save is shown with "Try again" and keeps closing from
 * passing silently (trackSave).
 */

export const TYPING_PAUSE_MS = 600;

export type AutosaveStatus = "idle" | "saving" | "saved" | "failed";

/**
 * `initial` is what the box starts with; `savedValue` what is on disk, when that differs
 * (a kept text put back after a reload: review round 2, B3); null when nothing of it is
 * saved yet, so the next save writes it.
 */
export function useAutosave({ caseId, initial, savedValue = initial, save }: { caseId: string; initial: string; savedValue?: string | null; save: (text: string) => Promise<boolean> }) {
  const [value, setValueState] = useState(initial);
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const latest = useRef(initial);
  const saved = useRef<string | null>(savedValue);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  /** Saves what is waiting; resolves whether everything typed is saved now. */
  const flush = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const run = queue.current.then(async () => {
      const text = latest.current;
      if (text === saved.current) return true;
      setStatus("saving");
      const ok = await trackSave(caseId, saveRef.current(text));
      if (ok) saved.current = text;
      setStatus(ok ? (latest.current === saved.current ? "saved" : "saving") : "failed");
      return ok;
    });
    queue.current = run.then(() => undefined);
    return run;
  }, [caseId]);

  const setValue = useCallback(
    (text: string) => {
      latest.current = text;
      setValueState(text);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), TYPING_PAUSE_MS);
    },
    [flush],
  );

  useEffect(() => registerFlusher(async () => void (await flush())), [flush]);

  /** Whether she has typed nothing since the box last matched the disk. */
  const untouched = useCallback(() => latest.current === saved.current, []);

  /** Puts a kept text back in the box, not saved yet: her next keystroke (or a flush) saves it with what she types. */
  const restore = useCallback((text: string) => {
    latest.current = text;
    setValueState(text);
    setStatus("idle");
  }, []);

  /**
   * "Try again" saved this text: it is what the disk holds now. What the box shows is not
   * changed: when it differs, the box's next save writes what she sees.
   */
  const markSaved = useCallback((text: string) => {
    saved.current = text;
    if (latest.current === text) setStatus("saved");
  }, []);
  // Leaving the screen saves what is still waiting.
  useEffect(() => () => void flush(), [flush]);

  return useMemo(() => ({ value, setValue, status, flush, retry: flush, untouched, restore, markSaved }), [value, setValue, status, flush, untouched, restore, markSaved]);
}

/**
 * Puts a text she typed that could not be saved back in the box it came from (review
 * round 2, B3): after a reload the main process still keeps it, and the box shows it
 * instead of the older text on disk, so "Try again" saves what she wrote and her next
 * keystroke builds on it. The main process is told the box shows it, so that box's next
 * save may replace it. After "Try again", the box knows the text is on disk.
 */
export function useKeptText(box: ReturnType<typeof useAutosave>, match: (item: FailedSave) => boolean, onRestored?: (item: FailedSave) => void): void {
  const failed = useFailedSaveList();
  const loaded = useFailedSavesLoaded();
  // Decided once, when the box mounts and the list is known (review round 3, R3-1): never
  // later, when the box becomes "untouched" after a save, which could put back a text
  // older than the one she just saved.
  const decided = useRef(false);
  // The newest kept text of this box: the list is oldest first.
  const kept = failed.filter((item) => match(item) && item.text !== null).at(-1);
  useEffect(() => {
    if (decided.current || !loaded) return;
    decided.current = true;
    // Something she typed before the list arrived is not replaced: the kept text stays kept, with Try again.
    if (!kept || kept.text === null || !box.untouched()) return;
    box.restore(kept.text);
    void window.aba.failedSaveShown(kept.id).catch(() => undefined);
    onRestored?.(kept);
  }, [loaded, kept, box, onRestored]);
  useEffect(
    () =>
      onRetried((item) => {
        if (match(item) && item.text !== null) box.markSaved(item.text);
      }),
    [box, match],
  );
}
