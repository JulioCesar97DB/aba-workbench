import { useEffect, useSyncExternalStore } from "react";
import type { SectionSaveResult } from "../../shared/api.ts";
import type { ReportSectionId } from "../../shared/report-sections.ts";
import type { SectionState, SectionSummary } from "../../shared/sections.ts";
import { filledBoxes, saveBoxes, type PastedTexts } from "./bulk-paste.ts";
import { registerFlusher, trackSave } from "./case-saves.tsx";

/*
 * A case started from what she already wrote (owner's proposal §4 "Nuevo caso" and
 * "Picking up a half-done assessment"; decisions T9 and T10).
 *
 * "¿Cómo empiezas?" is not stored (T9): "Ya escribí partes en ABA Matrix" is kept in this
 * window only, per case, while the app runs, like the PDFs she ignores on Documentos
 * (ignored-folder-pdfs.ts). It decides where she lands (Documentos with a line saying to
 * paste her sections after the documents) and puts "Pegar lo que ya escribiste" first on
 * the Informe list. It ends once a section of hers is saved (here or on its own screen), or
 * when the app restarts; the card stays on the Informe list either way, under the sections.
 *
 * What she has in the boxes of "Pegar lo que ya escribiste" and has not tried to save yet is
 * kept here too, per case, so leaving the screen and coming back finds it. Before the window
 * closes, the app quits or the page reloads, it is saved as "Guardar" would save it (one call
 * per filled box: case-saves.tsx, registerFlusher), so nothing she pasted is lost.
 *
 * A box whose save failed is not kept here (review round 1, S1): the main process keeps
 * that text (src/main/failed-saves.ts), and the screen shows it again from there each time
 * it opens, only while it is still kept. Once it is saved, or replaced by a newer text of
 * the section saved elsewhere, it is gone from there, so no stale box can put an older text
 * back over a newer one. It is not tried again on a close or a reload either (a save that
 * failed again would hold a reload once more, and again).
 */

const fromParts = new Set<string>();
const drafts = new Map<string, PastedTexts>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "Ya escribí partes en ABA Matrix", chosen when the case was created. */
export function markStartedFromParts(caseId: string): void {
  fromParts.add(caseId);
  changed();
}

/** A pasted section was saved: the case is no longer waiting for her sections. */
export function clearStartedFromParts(caseId: string): void {
  if (fromParts.delete(caseId)) changed();
}

function useStartedFromParts(caseId: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return fromParts.has(caseId);
}

/**
 * Whether the case still waits for the sections she already wrote: started with "Ya escribí
 * partes" and no section of hers yet. A section of hers saved any way (here, or with «Ya la
 * escribí» on its own screen: review round 1, minor 9) ends it for good.
 */
export function useWaitsForHerSections(caseId: string, sections: ReadonlyArray<{ state: SectionState }>): boolean {
  const started = useStartedFromParts(caseId);
  const hasHers = sections.some((section) => section.state === "hers");
  useEffect(() => {
    if (started && hasHers) clearStartedFromParts(caseId);
  }, [caseId, started, hasHers]);
  return started && !hasHers;
}

/** What she has in the boxes of a case, not saved yet. */
export function pastedDrafts(caseId: string): PastedTexts {
  return { ...drafts.get(caseId) };
}

/** Keeps (or, with "", forgets) what one box holds and has not been tried yet. */
export function keepPastedDraft(caseId: string, sectionId: ReportSectionId, text: string): void {
  const kept = { ...drafts.get(caseId) };
  if (text === "") delete kept[sectionId];
  else kept[sectionId] = text;
  if (Object.keys(kept).length === 0) drafts.delete(caseId);
  else drafts.set(caseId, kept);
}

/** Saves one box's text as her version of the section; resolves whether it was saved. Tracked, so closing waits for it and a failure is kept. */
export function savePastedSection(caseId: string, sectionId: ReportSectionId, text: string, onSaved?: (result: Extract<SectionSaveResult, { outcome: "saved" }>) => void): Promise<boolean> {
  return trackSave(
    caseId,
    window.aba.saveSectionText(caseId, sectionId, text, null, true).then((result) => {
      if (result.outcome !== "saved") return false;
      onSaved?.(result);
      return true;
    }),
  );
}

type FlushedListener = (caseId: string, sectionId: ReportSectionId, sections: SectionSummary[]) => void;
const flushedListeners = new Set<FlushedListener>();

/** Told when a box was saved before the window closed or reloaded, so a screen still showing it shows it saved. */
export function onPastedSectionFlushed(listener: FlushedListener): () => void {
  flushedListeners.add(listener);
  return () => flushedListeners.delete(listener);
}

// The window is about to close or reload: every box still waiting is saved, one call each. Each is taken out of the
// kept boxes before its save (review round 1, minor 2): the page's unload and the main process's own flush can both
// run this, and the screen may be saving it already; a box is saved once. A box that fails stays out: the main
// process keeps its text. A section the AI is writing is saved too: the page's requests stop when it goes away
// (src/main/ipc.ts), so no AI version can land on top of it, and leaving it out would lose her text on a close.
registerFlusher(async () => {
  for (const [caseId, texts] of [...drafts]) {
    const waiting = filledBoxes(texts);
    for (const box of waiting) keepPastedDraft(caseId, box.sectionId, "");
    await saveBoxes(waiting, (sectionId, text) =>
      savePastedSection(caseId, sectionId, text, (result) => {
        clearStartedFromParts(caseId);
        for (const listener of flushedListeners) listener(caseId, sectionId, result.sections);
      }),
    );
  }
});
