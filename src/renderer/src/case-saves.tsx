import { useCallback, useSyncExternalStore } from "react";
import type { CaseSources, FailedSave, SourceSaveFailure, SourceSaveResult } from "../../shared/sources.ts";
import { useOpenedCase, useSetCaseSources } from "./open-case.tsx";

/*
 * Every change to a case's sources is saved at once: there is no Save button to forget.
 *
 * What is under way lives here, for the whole app (one store, read with
 * useSyncExternalStore), so leaving a screen or a case never drops a save. What could not
 * be saved lives in the main process (src/main/failed-saves.ts), with what each change was
 * trying to write: this store reads it again after every save and when the page starts,
 * so a reload forgets nothing, Home lists what failed (useFailedSaves), and "Try again"
 * asks the main process to run that change again.
 *
 * Typing still waiting for its pause is saved at once (registerFlusher) when the window
 * is about to close or the app to quit (flushAllSaves, asked for by the main process) and
 * when the page is about to unload, a reload say (holdUnloadForSaves).
 */

export type SaveFailure = SourceSaveFailure["outcome"] | "error";

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "failed"; failure: SaveFailure; retry: () => void };

/** What a save answers: the case's sources as saved, or why not. */
export type SaveAnswer<T> = { ok: true; sources: CaseSources; value: T } | { ok: false; failure: SaveFailure };

const pending = new Map<string, number>();
const savedOnce = new Set<string>();
let failed: FailedSave[] = [];
const inFlight = new Set<Promise<unknown>>();
const flushers = new Set<() => Promise<void>>();
/** Saves outside the sources (a section's text, instructions, notes) that failed, by key, until one with the same key works. */
const otherFailures = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

/** Reads again, from the main process, the changes that could not be saved. */
export async function refreshFailedSaves(): Promise<void> {
  try {
    failed = await window.aba.listFailedSaves();
  } catch {
    // Kept as it was: the next save reads it again.
  }
  changed();
}

function track<T>(caseId: string, work: Promise<T>): Promise<T> {
  pending.set(caseId, (pending.get(caseId) ?? 0) + 1);
  changed();
  const done = work.finally(async () => {
    pending.set(caseId, (pending.get(caseId) ?? 1) - 1);
    await refreshFailedSaves();
  });
  inFlight.add(done);
  void done.finally(() => inFlight.delete(done)).catch(() => undefined);
  return done;
}

/** Runs one save of a case; `onSaved` gets the case's sources as saved. */
export function runSave<T>(caseId: string, save: () => Promise<SaveAnswer<T>>, onSaved: (sources: CaseSources) => void): Promise<SaveAnswer<T>> {
  return track(
    caseId,
    (async (): Promise<SaveAnswer<T>> => {
      let answer: SaveAnswer<T>;
      try {
        answer = await save();
      } catch {
        answer = { ok: false, failure: "error" };
      }
      if (answer.ok) {
        onSaved(answer.sources);
        savedOnce.add(caseId);
      }
      return answer;
    })(),
  );
}

/** "Try again": the main process runs the change that failed again. */
function retry(item: FailedSave, onSaved: (sources: CaseSources) => void): void {
  void runSave(item.caseId, async () => sourceAnswer(await window.aba.retryFailedSave(item.id)), onSaved);
}

/**
 * Tracks a save that is not a change to sources (a section's text, her instructions, her
 * notes): closing waits for it, and says a change could not be saved while the last save
 * with that key failed. Resolves whether it was saved.
 */
export function trackSave(key: string, work: Promise<boolean>): Promise<boolean> {
  const done = work.then(
    (ok) => {
      if (ok) otherFailures.delete(key);
      else otherFailures.add(key);
      changed();
      return ok;
    },
    () => {
      otherFailures.add(key);
      changed();
      return false;
    },
  );
  inFlight.add(done);
  void done.finally(() => inFlight.delete(done));
  return done;
}

/** A screen's typing still waiting for its pause: saved at once when the window is about to close or the page to unload. */
export function registerFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/**
 * Saves everything still waiting, then waits until no save is under way. `ok` is false
 * when a change could not be saved.
 */
export async function flushAllSaves(): Promise<{ ok: boolean }> {
  await Promise.allSettled([...flushers].map((flush) => flush()));
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  await refreshFailedSaves();
  return { ok: failed.length === 0 && otherFailures.size === 0 };
}

/**
 * The page is about to unload (a reload): typing still waiting is sent now (each save
 * sends its change before its first pause, so it reaches the main process even as the
 * page goes), and while any save is under way the unload is held: the main process waits
 * for them and then reloads (src/main/index.ts, "will-prevent-unload").
 */
export function holdUnloadForSaves(event: BeforeUnloadEvent): void {
  for (const flush of flushers) void flush();
  if (inFlight.size === 0) return;
  event.preventDefault();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

function stateOf(caseId: string, onSaved: (sources: CaseSources) => void): SaveState {
  if ((pending.get(caseId) ?? 0) > 0) return { status: "saving" };
  const last = failed.filter((item) => item.caseId === caseId).at(-1);
  if (last) return { status: "failed", failure: last.failure, retry: () => retry(last, onSaved) };
  return savedOnce.has(caseId) ? { status: "saved" } : { status: "idle" };
}

/** The open case's save state, and `run` to save a change to it. */
export function useCaseSaves(): { state: SaveState; run: <T>(save: () => Promise<SaveAnswer<T>>) => Promise<SaveAnswer<T>> } {
  const { id } = useOpenedCase();
  const setSources = useSetCaseSources();
  // Re-renders when the store changes; the state is read from it below.
  useVersion();
  const onSaved = useCallback((sources: CaseSources) => setSources(id, sources), [id, setSources]);
  const run = useCallback(<T,>(save: () => Promise<SaveAnswer<T>>) => runSave(id, save, onSaved), [id, onSaved]);
  return { state: stateOf(id, onSaved), run };
}

/** Every case with a change that could not be saved, for Home. */
export function useFailedSaves(): Array<{ caseId: string; label: string | null; failure: SaveFailure }> {
  useVersion();
  const byCase = new Map<string, FailedSave>();
  for (const item of failed) byCase.set(item.caseId, item);
  return [...byCase.values()].map(({ caseId, label, failure }) => ({ caseId, label, failure }));
}

/** A source change's answer, as a SaveAnswer. */
export function sourceAnswer(result: SourceSaveResult): SaveAnswer<string> {
  return result.outcome === "saved" ? { ok: true, sources: result.sources, value: result.sourceId } : { ok: false, failure: result.outcome };
}
