import { randomUUID } from "node:crypto";
import type { InstructionsSaveResult, MapSaveResult, NotesSaveResult, SectionSaveResult } from "../shared/api.ts";
import type { FailedSave, FailedSaveFailure, SourceSaveResult } from "../shared/sources.ts";
import type { CaseMapService } from "./case-map-service.ts";
import type { CaseLibrary } from "./cases.ts";
import type { SectionService } from "./sections.ts";

/*
 * The changes to a case's sources that could not be saved, kept in the main process for
 * as long as the app runs: a reload of the window (Cmd+R in a development build, or the
 * page reloading after a crash) must not forget them, nor what each was trying to write.
 * The interface lists them (Home, the Sources step) and "Try again" runs the same change
 * again (retry). Closing or quitting asks first while any is left (src/main/close-guard.ts).
 *
 * The same holds for what she types in the report's sections (review B3, the owner's
 * decision of item 60): a section's text with its editing pass, her standing
 * instructions for a section, and her session notes. And for what she types in an item
 * of the case map (owner's decision, 2026-11-23, step 1 PR 1): the item's fields, as JSON
 * text, with the part's editing pass.
 *
 * Each change has a key: the thing it changes ("text:<source id>", "title:<source id>",
 * "removed:<source id>", "text:new-<case id>" for a new text, "section-text:<section id>",
 * "notes", "map-item:<part>/<list>/<item id>", and "instructions:<section id>", which is
 * the same in every case). A later change with the same
 * key that is saved replaces a failed one: trying the older one again would undo the newer.
 * Nothing here imports Electron, so it is unit-tested.
 */

export type SaveOp =
  | { kind: "add-text"; input: unknown }
  | { kind: "change"; sourceId: string; change: Record<string, unknown> }
  | { kind: "removed"; sourceId: string; removed: boolean }
  | { kind: "section-text"; sectionId: unknown; text: unknown; editing: unknown }
  | { kind: "instructions"; sectionId: unknown; text: unknown }
  | { kind: "notes"; text: unknown }
  | { kind: "map-item"; part: unknown; collection: unknown; itemId: unknown; text: unknown; editing: unknown };

/** What any of those changes answers. */
export type SaveResult = SourceSaveResult | SectionSaveResult | NotesSaveResult | InstructionsSaveResult | MapSaveResult;

/** Runs a change through the case library, the section service for what is typed in the report's sections, or the case map's service. */
export function runSaves(
  cases: Pick<CaseLibrary, "addTextSource" | "changeSource" | "setSourceRemoved">,
  sections: () => Pick<SectionService, "saveText" | "saveInstructions" | "saveNotes">,
  caseMap: () => Pick<CaseMapService, "saveItem"> = () => {
    throw new Error("No case map service.");
  },
): FailedSavesOptions["run"] {
  return (caseId, op) => {
    if (op.kind === "map-item") return caseMap().saveItem(caseId, op.part, op.collection, op.itemId, op.text, op.editing);
    if (op.kind === "add-text") return cases.addTextSource(caseId, op.input);
    if (op.kind === "change") return cases.changeSource(caseId, op.sourceId, op.change);
    if (op.kind === "removed") return cases.setSourceRemoved(caseId, op.sourceId, op.removed);
    if (op.kind === "section-text") return sections().saveText(caseId, op.sectionId, op.text, op.editing);
    if (op.kind === "instructions") return sections().saveInstructions(op.sectionId, op.text);
    return sections().saveNotes(caseId, op.text);
  };
}

/** Sources only: what the tests of sources use. */
export function runOnCases(cases: Pick<CaseLibrary, "addTextSource" | "changeSource" | "setSourceRemoved">): FailedSavesOptions["run"] {
  return runSaves(cases, () => {
    throw new Error("No section service.");
  });
}

/**
 * The thing a change changes. Every key of a change goes in, so a two-field change has its
 * own key. A new text has no id yet: each failed one is its own entry, and one that is
 * saved later replaces it only if it is the same draft grown (see sameDraft).
 */
export function saveKey(caseId: string, op: SaveOp, entryId = ""): string {
  if (op.kind === "add-text") return `${caseId}/text:new:${entryId}`;
  if (op.kind === "removed") return `${caseId}/removed:${op.sourceId}`;
  if (op.kind === "section-text") return `${caseId}/section-text:${String(op.sectionId)}`;
  // Her instructions are the same in every case: a later save from any case replaces a failed one.
  if (op.kind === "instructions") return `*/instructions:${String(op.sectionId)}`;
  if (op.kind === "notes") return `${caseId}/notes`;
  if (op.kind === "map-item") return `${caseId}/map-item:${mapItemOf(op)}`;
  return `${caseId}/${Object.keys(op.change).sort().join("+")}:${op.sourceId}`;
}

type Failure = FailedSaveFailure;

/** What the interface is told of a failure: the reasons it explains, any other as "not-saved". */
function failureOf(outcome: string): Failure {
  return outcome === "case-full" || outcome === "case-unavailable" || outcome === "source-not-found" || outcome === "error" ? outcome : "not-saved";
}

/** What a change is about, for the interface: a source, a section's text, her instructions or her notes. */
function aboutOf(op: SaveOp): Pick<FailedSave, "about" | "sectionId"> {
  if (op.kind === "section-text") return { about: "section", sectionId: typeof op.sectionId === "string" ? op.sectionId : null };
  if (op.kind === "instructions") return { about: "instructions", sectionId: typeof op.sectionId === "string" ? op.sectionId : null };
  if (op.kind === "notes") return { about: "notes", sectionId: null };
  if (op.kind === "map-item") return { about: "map", sectionId: null };
  return { about: "source", sectionId: null };
}

/** A map item's key: "<part>/<items or groups>/<item id>". */
function mapItemOf(op: Extract<SaveOp, { kind: "map-item" }>): string {
  return `${String(op.part)}/${String(op.collection)}/${String(op.itemId)}`;
}

interface Entry {
  id: string;
  caseId: string;
  op: SaveOp;
  failure: Failure;
  at: number;
  /**
   * The text is in its box on the page as it is now: it failed from that box's own save
   * (review round 3, R3-1), or the box put it back after a reload (review round 2, B3).
   * The box's next save is built on it. A page that reloads clears it (newPage).
   */
  shown: boolean;
}

/** What she typed, for a change to a section's text, her instructions, her notes or a map item; null for a source's change. */
function typedText(op: SaveOp): string | null {
  if (op.kind !== "section-text" && op.kind !== "instructions" && op.kind !== "notes" && op.kind !== "map-item") return null;
  return typeof op.text === "string" ? op.text : null;
}

/** Whether a later text holds the kept one (line endings and the spaces at its ends aside). */
function contains(later: string | null, kept: string | null): boolean {
  if (kept === null) return true;
  if (later === null) return false;
  const clean = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  return clean(later).includes(clean(kept));
}

/** The entries of one thing: its key, and the keys of kept texts a later one did not contain ("<key>#<id>"). */
function sameThing(entryKey: string, key: string): boolean {
  return entryKey === key || entryKey.startsWith(`${key}#`);
}

export interface FailedSavesOptions {
  /** Runs a change (CaseLibrary). It throws "Refused: ..." for input it refuses. */
  run: (caseId: unknown, op: SaveOp) => Promise<SaveResult>;
  /** A case's label, as last listed or opened; null if the app has not seen it. */
  labelOf: (caseId: string) => string | null;
  newId?: () => string;
  now?: () => number;
}

export class FailedSaves {
  private entries = new Map<string, Entry>();
  private readonly options: Required<FailedSavesOptions>;

  constructor(options: FailedSavesOptions) {
    this.options = { newId: () => randomUUID(), now: () => Date.now(), ...options };
  }

  /** How many changes are not saved. */
  get size(): number {
    return this.entries.size;
  }

  /** Runs a change and remembers it if it could not be saved; a saved one clears a failed one with the same key. */
  /**
   * `fromBox` (the default): the change comes from the box she is typing in, so a failure
   * of it is already shown there; false for "Try again" of a kept change.
   */
  async save<R extends SaveResult = SourceSaveResult>(caseId: unknown, op: SaveOp, { fromBox = true }: { fromBox?: boolean } = {}): Promise<R> {
    let result: SaveResult;
    if (typeof caseId === "string") await this.keepSectionText(caseId, op);
    try {
      result = await this.options.run(caseId, op);
    } catch (error) {
      // A refusal is the interface's mistake, not a change to keep; anything else is.
      if (!(error instanceof Error && error.message.startsWith("Refused:")) && typeof caseId === "string") this.record(caseId, op, "error", fromBox);
      throw error;
    }
    const id = caseId as string;
    if (result.outcome === "saved") this.forget(id, op);
    else this.record(id, op, failureOf(result.outcome), fromBox);
    return result as R;
  }

  /** The page reloaded (or its renderer was replaced): no box shows a kept text until it says so again. */
  newPage(): void {
    for (const entry of this.entries.values()) entry.shown = false;
  }

  /**
   * Before a section's text (or a map item) is saved, a kept text of it that this save does
   * not contain, and that no box has shown, is saved as its own version first (review round
   * 2, B3): a version costs nothing, and so the kept text is never dropped by a save that
   * was not built on it.
   */
  private async keepSectionText(caseId: string, op: SaveOp): Promise<void> {
    if (op.kind !== "section-text" && op.kind !== "map-item") return;
    const key = saveKey(caseId, op);
    for (const [entryKey, entry] of [...this.entries]) {
      if (!sameThing(entryKey, key) || entry.shown || contains(typedText(op), typedText(entry.op)) || entry.op.kind !== op.kind) continue;
      try {
        const kept = await this.options.run(caseId, { ...entry.op, editing: null });
        if (kept.outcome === "saved") this.entries.delete(entryKey);
      } catch {
        // Kept as it is: Try again can still save it.
      }
    }
  }

  /**
   * The interface put a kept text back in its box: from now on, that box's saves are built
   * on it. The box shows the newest kept text of that thing; older ones kept beside it are
   * older than what she now sees, so they count as shown too: nothing can put them back over it.
   */
  markShown(id: unknown): void {
    const found = [...this.entries].find(([, entry]) => entry.id === id);
    if (!found) return;
    const group = found[0].split("#")[0];
    for (const [entryKey, entry] of this.entries) if (sameThing(entryKey, group)) entry.shown = true;
  }

  /** Every change not saved, oldest first. */
  list(): FailedSave[] {
    return [...this.entries.values()]
      .sort((a, b) => a.at - b.at)
      .map(({ id, caseId, failure, op }) => ({
        id,
        caseId,
        label: this.options.labelOf(caseId),
        failure,
        ...aboutOf(op),
        // What she typed, so the interface can put it back in its box after a reload.
        text: typedText(op),
        editing: (op.kind === "section-text" || op.kind === "map-item") && typeof op.editing === "number" ? op.editing : null,
        mapItem: op.kind === "map-item" ? mapItemOf(op) : null,
      }));
  }

  /** Runs a failed change again. */
  async retry(id: unknown): Promise<SaveResult> {
    const entry = [...this.entries.values()].find((item) => item.id === id);
    if (!entry) return { outcome: "source-not-found" };
    return this.save<SaveResult>(entry.caseId, entry.op, { fromBox: entry.shown });
  }

  /** Forgets the failed changes a saved one replaces. */
  private forget(caseId: string, op: SaveOp): void {
    const typed = typedText(op);
    if (typed !== null) {
      // A save forgets a kept text only when it holds it, or when the box it was typed in
      // showed it again before this save: a save that does not contain a kept text never
      // forgets it (review round 2, B3).
      const key = saveKey(caseId, op);
      for (const [entryKey, entry] of [...this.entries]) {
        if (sameThing(entryKey, key) && (entry.shown || contains(typed, typedText(entry.op)))) this.entries.delete(entryKey);
      }
      return;
    }
    if (op.kind !== "add-text") {
      this.entries.delete(saveKey(caseId, op));
      return;
    }
    for (const [key, entry] of this.entries) if (entry.caseId === caseId && sameDraft(entry.op, op)) this.entries.delete(key);
  }

  private record(caseId: string, op: SaveOp, failure: Failure, fromBox = true): void {
    const typed = typedText(op);
    if (typed !== null) {
      const key = saveKey(caseId, op);
      const earlier = this.entries.get(key);
      // A failure of the box's own save replaces what that box failed to save before: she
      // typed or deleted on top of it, in front of her (review round 3, R3-1). Only a kept
      // text no box on this page has shown is kept beside a later one, never under it.
      if (earlier && !earlier.shown && !contains(typed, typedText(earlier.op))) {
        const id = this.options.newId();
        this.entries.set(`${key}#${id}`, earlier);
        this.entries.delete(key);
        this.entries.set(key, { id: this.options.newId(), caseId, op, failure, at: this.options.now(), shown: fromBox });
        return;
      }
      // Newest last: the entry moves to the end, so the newest of a box's kept texts is always the last one listed.
      this.entries.delete(key);
      this.entries.set(key, { id: earlier?.id ?? this.options.newId(), caseId, op, failure, at: this.options.now(), shown: fromBox || (earlier?.shown ?? false) });
      return;
    }
    // A new text failing again as it grows is one entry, not one per try.
    if (op.kind === "add-text") this.forget(caseId, op);
    const id = op.kind === "add-text" ? this.options.newId() : (this.entries.get(saveKey(caseId, op))?.id ?? this.options.newId());
    this.entries.set(saveKey(caseId, op, op.kind === "add-text" ? id : ""), { id, caseId, op, failure, at: this.options.now(), shown: fromBox });
  }
}

function draftText(op: SaveOp): string | null {
  if (op.kind !== "add-text" || typeof op.input !== "object" || op.input === null) return null;
  const text = (op.input as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Whether `later` is the same new text as `earlier`, typed on: its text starts with the earlier one's. */
function sameDraft(earlier: SaveOp, later: SaveOp): boolean {
  const before = draftText(earlier);
  const after = draftText(later);
  return before !== null && after !== null && after.startsWith(before);
}
