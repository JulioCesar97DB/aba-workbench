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
/** `sources` is null for a save that does not change sources (a section's text, instructions, notes). */
export type SaveAnswer<T> = { ok: true; sources: CaseSources | null; value: T } | { ok: false; failure: SaveFailure };

const pending = new Map<string, number>();
const savedOnce = new Set<string>();
let failed: FailedSave[] = [];
/** True once the list has been read from the main process at least once on this page. */
let failedLoaded = false;
const inFlight = new Set<Promise<unknown>>();
const flushers = new Set<() => Promise<void>>();
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
    failedLoaded = true;
  } catch {
    // Kept as it was: the next save reads it again. The boxes do not wait for it any
    // longer: she can always type (review round 4, L-2).
    failedLoaded = true;
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
        if (answer.sources) onSaved(answer.sources);
        savedOnce.add(caseId);
      }
      return answer;
    })(),
  );
}

/** Told when a change that is not a source's (a section's text, instructions, notes) was saved by "Try again", so its screen reads it again. */
const retriedListeners = new Set<(item: FailedSave) => void>();

export function onRetried(listener: (item: FailedSave) => void): () => void {
  retriedListeners.add(listener);
  return () => retriedListeners.delete(listener);
}

/** "Try again": the main process runs the change that failed again, with what was typed then. */
export function retry(item: FailedSave, onSaved: (sources: CaseSources) => void): void {
  void runSave(
    item.caseId,
    async (): Promise<SaveAnswer<null>> => {
      const result = await window.aba.retryFailedSave(item.id);
      if (result.outcome !== "saved") return { ok: false, failure: result.outcome === "case-full" || result.outcome === "case-unavailable" || result.outcome === "source-not-found" ? result.outcome : "not-saved" };
      if (item.about !== "source") for (const listener of retriedListeners) listener(item);
      return { ok: true, sources: "sources" in result ? result.sources : null, value: null };
    },
    onSaved,
  );
}

/**
 * Tracks a save that is not a change to sources (a section's text, her instructions, her
 * notes): closing waits for it. Whether it failed is the main process's to keep (it keeps
 * the change itself, src/main/failed-saves.ts), so a reload forgets neither the failure
 * nor what was typed (review B3); the list is read again after it. Resolves whether it was saved.
 */
export function trackSave(caseId: string, work: Promise<boolean>): Promise<boolean> {
  return track(caseId, work.catch(() => false));
}

/** Whether the list of changes not saved has been read on this page yet. */
export function useFailedSavesLoaded(): boolean {
  // The page reads it when it starts (main.tsx) and after every save.
  useVersion();
  return failedLoaded;
}

/** Every change not saved, as the main process keeps it. */
export function useFailedSaveList(): FailedSave[] {
  useVersion();
  return failed;
}

/** A change not saved that is about the report's sections: a section's text, its instructions or the notes. */
export type SectionFailure = FailedSave & { about: "section" | "instructions" | "notes" };

/** The changes not saved that are about a case's report sections: what was typed in a section, its instructions or the notes. */
export function useSectionFailures(caseId: string): SectionFailure[] {
  useVersion();
  return failed.filter((item): item is SectionFailure => item.caseId === caseId && (item.about === "section" || item.about === "instructions" || item.about === "notes"));
}

/** The changes not saved that are about a case's map: what was typed in an item (src/renderer/src/screens/CaseMap.tsx). */
export function useMapFailures(caseId: string): FailedSave[] {
  useVersion();
  return failed.filter((item) => item.caseId === caseId && item.about === "map");
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
  return { ok: failed.length === 0 };
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
