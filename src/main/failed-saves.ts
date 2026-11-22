import { randomUUID } from "node:crypto";
import type { FailedSave, SourceSaveResult } from "../shared/sources.ts";
import type { CaseLibrary } from "./cases.ts";

/*
 * The changes to a case's sources that could not be saved, kept in the main process for
 * as long as the app runs: a reload of the window (Cmd+R in a development build, or the
 * page reloading after a crash) must not forget them, nor what each was trying to write.
 * The interface lists them (Home, the Sources step) and "Try again" runs the same change
 * again (retry). Closing or quitting asks first while any is left (src/main/close-guard.ts).
 *
 * Each change has a key: the thing it changes ("text:<source id>", "title:<source id>",
 * "removed:<source id>", "text:new-<case id>" for a new text). A later change with the same
 * key that is saved replaces a failed one: trying the older one again would undo the newer.
 * Nothing here imports Electron, so it is unit-tested.
 */

export type SaveOp =
  | { kind: "add-text"; input: unknown }
  | { kind: "change"; sourceId: string; change: Record<string, unknown> }
  | { kind: "removed"; sourceId: string; removed: boolean };

/** Runs a change through the case library. */
export function runOnCases(cases: Pick<CaseLibrary, "addTextSource" | "changeSource" | "setSourceRemoved">): FailedSavesOptions["run"] {
  return (caseId, op) => {
    if (op.kind === "add-text") return cases.addTextSource(caseId, op.input);
    if (op.kind === "change") return cases.changeSource(caseId, op.sourceId, op.change);
    return cases.setSourceRemoved(caseId, op.sourceId, op.removed);
  };
}

/**
 * The thing a change changes. Every key of a change goes in, so a two-field change has its
 * own key. A new text has no id yet: each failed one is its own entry, and one that is
 * saved later replaces it only if it is the same draft grown (see sameDraft).
 */
export function saveKey(caseId: string, op: SaveOp, entryId = ""): string {
  if (op.kind === "add-text") return `${caseId}/text:new:${entryId}`;
  if (op.kind === "removed") return `${caseId}/removed:${op.sourceId}`;
  return `${caseId}/${Object.keys(op.change).sort().join("+")}:${op.sourceId}`;
}

type Failure = Exclude<SourceSaveResult["outcome"], "saved"> | "error";

interface Entry {
  id: string;
  caseId: string;
  op: SaveOp;
  failure: Failure;
  at: number;
}

export interface FailedSavesOptions {
  /** Runs a change (CaseLibrary). It throws "Refused: ..." for input it refuses. */
  run: (caseId: unknown, op: SaveOp) => Promise<SourceSaveResult>;
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
  async save(caseId: unknown, op: SaveOp): Promise<SourceSaveResult> {
    let result: SourceSaveResult;
    try {
      result = await this.options.run(caseId, op);
    } catch (error) {
      // A refusal is the interface's mistake, not a change to keep; anything else is.
      if (!(error instanceof Error && error.message.startsWith("Refused:")) && typeof caseId === "string") this.record(caseId, op, "error");
      throw error;
    }
    const id = caseId as string;
    if (result.outcome === "saved") this.forget(id, op);
    else this.record(id, op, result.outcome);
    return result;
  }

  /** Every change not saved, oldest first. */
  list(): FailedSave[] {
    return [...this.entries.values()]
      .sort((a, b) => a.at - b.at)
      .map(({ id, caseId, failure }) => ({ id, caseId, label: this.options.labelOf(caseId), failure }));
  }

  /** Runs a failed change again. */
  async retry(id: unknown): Promise<SourceSaveResult> {
    const entry = [...this.entries.values()].find((item) => item.id === id);
    if (!entry) return { outcome: "source-not-found" };
    return this.save(entry.caseId, entry.op);
  }

  /** Forgets the failed changes a saved one replaces. */
  private forget(caseId: string, op: SaveOp): void {
    if (op.kind !== "add-text") {
      this.entries.delete(saveKey(caseId, op));
      return;
    }
    for (const [key, entry] of this.entries) if (entry.caseId === caseId && sameDraft(entry.op, op)) this.entries.delete(key);
  }

  private record(caseId: string, op: SaveOp, failure: Failure): void {
    // A new text failing again as it grows is one entry, not one per try.
    if (op.kind === "add-text") this.forget(caseId, op);
    const id = op.kind === "add-text" ? this.options.newId() : (this.entries.get(saveKey(caseId, op))?.id ?? this.options.newId());
    this.entries.set(saveKey(caseId, op, op.kind === "add-text" ? id : ""), { id, caseId, op, failure, at: this.options.now() });
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
