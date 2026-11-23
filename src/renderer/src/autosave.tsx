import { useCallback, useEffect, useRef, useState } from "react";
import { registerFlusher, trackSave } from "./case-saves.tsx";

/*
 * Text saved as she types, with no Save button: when typing pauses, when the field loses
 * focus, when the screen goes away, and when the window is about to close or reload
 * (registerFlusher). Saves run one after another, in order, so a later one never lands
 * before an earlier one. A failed save is shown with "Try again" and keeps closing from
 * passing silently (trackSave).
 */

export const TYPING_PAUSE_MS = 600;

export type AutosaveStatus = "idle" | "saving" | "saved" | "failed";

export function useAutosave({ caseId, initial, save }: { caseId: string; initial: string; save: (text: string) => Promise<boolean> }) {
  const [value, setValueState] = useState(initial);
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const latest = useRef(initial);
  const saved = useRef(initial);
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
  // Leaving the screen saves what is still waiting.
  useEffect(() => () => void flush(), [flush]);

  return { value, setValue, status, flush, retry: flush };
}
