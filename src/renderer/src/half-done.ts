import { useSyncExternalStore } from "react";
import type { SectionSaveResult } from "../../shared/api.ts";
import type { ReportSectionId } from "../../shared/report-sections.ts";
import type { SectionSummary } from "../../shared/sections.ts";
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
 * the Informe list. It ends once a pasted section is saved, or when the app restarts; the
 * card stays on the Informe list either way, under the sections.
 *
 * What she has in the boxes of "Pegar lo que ya escribiste" and not saved yet is kept here
 * too, per case, so leaving the screen and coming back finds it. Before the window closes,
 * the app quits or the page reloads, it is saved as "Guardar" would save it (one call per
 * filled box: case-saves.tsx, registerFlusher), so nothing she pasted is lost; a box whose save
 * failed is not tried again then, since the main process keeps its text already.
 */

const fromParts = new Set<string>();
const drafts = new Map<string, PastedTexts>();
/**
 * The boxes whose text could not be saved ("<case id>/<section id>"): the main process keeps
 * that text already (src/main/failed-saves.ts), so closing or reloading does not try it again
 * (a save that fails again would hold a reload once more, and again). Typing in the box makes it waiting again.
 */
const failedDrafts = new Set<string>();
const draftKey = (caseId: string, sectionId: ReportSectionId) => `${caseId}/${sectionId}`;
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

export function useStartedFromParts(caseId: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return fromParts.has(caseId);
}

/** What she has in the boxes of a case, not saved yet. */
export function pastedDrafts(caseId: string): PastedTexts {
  return { ...drafts.get(caseId) };
}

/** Keeps (or, with "", forgets) what one box holds; `failed` when it is a text whose save failed (kept by the main process). */
export function keepPastedDraft(caseId: string, sectionId: ReportSectionId, text: string, { failed = false }: { failed?: boolean } = {}): void {
  if (failed && text !== "") failedDrafts.add(draftKey(caseId, sectionId));
  else failedDrafts.delete(draftKey(caseId, sectionId));
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
    window.aba.saveSectionText(caseId, sectionId, text, null).then((result) => {
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

// The window is about to close or reload: every box still holding text is saved, one call each.
registerFlusher(async () => {
  for (const [caseId, texts] of [...drafts]) {
    const waiting = filledBoxes(texts).filter((box) => !failedDrafts.has(draftKey(caseId, box.sectionId)));
    await saveBoxes(waiting, (sectionId, text) =>
      savePastedSection(caseId, sectionId, text, (result) => {
        keepPastedDraft(caseId, sectionId, "");
        clearStartedFromParts(caseId);
        for (const listener of flushedListeners) listener(caseId, sectionId, result.sections);
      }),
      // Kept by the main process now: not tried again by the next close or reload.
      (sectionId, outcome) => {
        if (outcome === "failed") keepPastedDraft(caseId, sectionId, texts[sectionId] ?? "", { failed: true });
      },
    );
  }
});
