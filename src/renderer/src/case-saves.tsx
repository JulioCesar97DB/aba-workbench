import { useCallback, useSyncExternalStore } from "react";
import type { CaseSources, SourceSaveFailure } from "../../shared/sources.ts";
import { useOpenedCase, useSetCaseSources } from "./open-case.tsx";

/*
 * Every change to a case's sources is saved at once: there is no Save button to forget.
 * This keeps, for the whole app, each case's save state: how many saves are under way,
 * and the ones that failed, each with a way to try it again. It lives outside any screen
 * (one store, read with useSyncExternalStore), so leaving a case never drops a save under
 * way or hides one that failed: Home lists them (useFailedSaves).
 *
 * Each save has a key: the thing it changes ("text:<id>" for a source's text, say). A
 * failed save is offered again ("Try again") until a later save with the same key
 * succeeds, which replaces it: trying the older one again would undo the newer.
 *
 * Before the window closes or the app quits, the main process asks the interface to
 * finish its saves (flushAllSaves): every screen with typing still waiting for its pause
 * saves it now (registerFlusher), and the answer comes once nothing is under way.
 */

export type SaveFailure = SourceSaveFailure["outcome"] | "error";

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "failed"; failure: SaveFailure; retry: () => void };

/** What a save answers: the case's sources as saved, or why not. */
export type SaveAnswer<T> = { ok: true; sources: CaseSources; value: T } | { ok: false; failure: SaveFailure };

interface CaseEntry {
  label: string;
  pending: number;
  savedOnce: boolean;
  failures: Map<string, { failure: SaveFailure; retry: () => void }>;
}

const cases = new Map<string, CaseEntry>();
const inFlight = new Set<Promise<unknown>>();
const flushers = new Set<() => Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function entry(caseId: string, label: string): CaseEntry {
  let found = cases.get(caseId);
  if (!found) {
    found = { label, pending: 0, savedOnce: false, failures: new Map() };
    cases.set(caseId, found);
  }
  found.label = label;
  return found;
}

/** Runs one save of a case; `onSaved` gets the case's sources as saved. */
export function runSave<T>(caseId: string, label: string, key: string, save: () => Promise<SaveAnswer<T>>, onSaved: (sources: CaseSources) => void): Promise<SaveAnswer<T>> {
  const state = entry(caseId, label);
  state.pending++;
  changed();
  const work = (async (): Promise<SaveAnswer<T>> => {
    let answer: SaveAnswer<T>;
    try {
      answer = await save();
    } catch {
      answer = { ok: false, failure: "error" };
    }
    state.pending--;
    if (answer.ok) {
      onSaved(answer.sources);
      state.savedOnce = true;
      state.failures.delete(key);
    } else {
      state.failures.set(key, { failure: answer.failure, retry: () => void runSave(caseId, state.label, key, save, onSaved) });
    }
    changed();
    return answer;
  })();
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
  return work;
}

/** A screen's typing still waiting for its pause: saved at once when the window is about to close. */
export function registerFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/**
 * Saves everything still waiting, then waits until no save is under way. `ok` is false
 * when any case has a change that could not be saved.
 */
export async function flushAllSaves(): Promise<{ ok: boolean }> {
  await Promise.allSettled([...flushers].map((flush) => flush()));
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  return { ok: [...cases.values()].every((state) => state.failures.size === 0) };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

function stateOf(state: CaseEntry | undefined): SaveState {
  if (!state) return { status: "idle" };
  if (state.pending > 0) return { status: "saving" };
  const last = [...state.failures.values()].at(-1);
  if (last) return { status: "failed", ...last };
  return state.savedOnce ? { status: "saved" } : { status: "idle" };
}

/** The open case's save state, and `run` to save a change to it. */
export function useCaseSaves(): { state: SaveState; run: <T>(key: string, save: () => Promise<SaveAnswer<T>>) => Promise<SaveAnswer<T>> } {
  const opened = useOpenedCase();
  const setSources = useSetCaseSources();
  // Re-renders when the store changes; the state is read from it below.
  useVersion();
  const { id, label } = opened;
  const run = useCallback(<T,>(key: string, save: () => Promise<SaveAnswer<T>>) => runSave(id, label, key, save, (sources) => setSources(id, sources)), [id, label, setSources]);
  return { state: stateOf(cases.get(id)), run };
}

/** Every case with a change that could not be saved, for Home. */
export function useFailedSaves(): Array<{ caseId: string; label: string; failure: SaveFailure }> {
  useVersion();
  return [...cases.entries()].flatMap(([caseId, state]) => {
    const last = [...state.failures.values()].at(-1);
    return last ? [{ caseId, label: state.label, failure: last.failure }] : [];
  });
}

/** A source change's answer, as a SaveAnswer. */
export function sourceAnswer(result: { outcome: "saved"; sources: CaseSources; sourceId: string } | SourceSaveFailure): SaveAnswer<string> {
  return result.outcome === "saved" ? { ok: true, sources: result.sources, value: result.sourceId } : { ok: false, failure: result.outcome };
}
