import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PlanInstructionsView } from "../shared/plan.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../shared/report-sections.ts";
import { MAX_INSTRUCTIONS_LENGTH, normalizeLineEndings } from "../shared/section-text.ts";
import { removeLeftoverAppDataTemporaryFiles, writeFileDurably } from "./durable-write.ts";

/*
 * Her standing instructions for each section, remembered for all her cases (owner's
 * decision, 2026-11-22): instructions.json in the app's own data folder, next to
 * settings.json, written durably. Nothing is lost: each editing pass's earlier text goes
 * into the section's history, kept in the file. Nothing here imports Electron, so it is
 * unit-tested.
 *
 * A file this version cannot read whole (damaged, or written by a newer app) is never
 * written over: the instructions then read as empty and a save is refused, so nothing in
 * it is lost; the main-process log says why.
 */

export const INSTRUCTIONS_FILE_NAME = "instructions.json";
/**
 * Whose standing instructions: a report section's, the case map's (her definition thresholds,
 * D16), or the plan's (her usual parameters; the Plan step's D17). The plan's entry also
 * keeps the HBI intro she confirmed once (D16 of the Plan step), as "hbiIntro".
 */
export type InstructionsId = ReportSectionId | "case-map" | "plan";
export const INSTRUCTIONS_FILE_VERSION = 1;
/** Typing pauses closer together than this are one editing pass: one entry in the history. */
export const EDITING_PASS_MS = 10 * 60 * 1000;
/** Earlier texts kept per section. */
export const MAX_HISTORY = 1000;

const TimestampSchema = z.iso.datetime();
const TextSchema = z.string().max(MAX_INSTRUCTIONS_LENGTH);

const SectionInstructionsSchema = z.looseObject({
  text: TextSchema,
  updatedAt: TimestampSchema,
  /** Earlier texts, oldest first, each with the time it was last saved. */
  history: z.array(z.looseObject({ text: TextSchema, savedAt: TimestampSchema })).max(MAX_HISTORY * 2),
});

const InstructionsFileSchema = z.looseObject({
  version: z.literal(INSTRUCTIONS_FILE_VERSION),
  // A section id this version does not know is kept as it is.
  sections: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), SectionInstructionsSchema),
});

export type InstructionsFile = z.infer<typeof InstructionsFileSchema>;

export type InstructionsRead = { ok: true; file: InstructionsFile } | { ok: false; problem: "damaged" | "newer-version" };

/** Reads the file's text (null: there is no file yet). Never throws. */
export function readInstructionsFile(text: string | null): InstructionsRead {
  if (text === null) return { ok: true, file: { version: INSTRUCTIONS_FILE_VERSION, sections: {} } };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "damaged" };
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > INSTRUCTIONS_FILE_VERSION) return { ok: false, problem: "newer-version" };
  const parsed = InstructionsFileSchema.safeParse(json);
  return parsed.success ? { ok: true, file: parsed.data } : { ok: false, problem: "damaged" };
}

export function serializeInstructionsFile(file: InstructionsFile): string {
  const { version, sections, ...rest } = file;
  return `${JSON.stringify({ version, sections, ...rest }, null, 2)}\n`;
}

/** The file with the HBI intro she confirmed (or replaced), at the top of section 14's copy from now on. */
export function confirmHbiIntro(file: InstructionsFile, raw: string, now: Date): InstructionsFile {
  const text = normalizeLineEndings(raw).trim();
  if (text === "" || text.length > MAX_INSTRUCTIONS_LENGTH) throw new Error("Refused: the intro must be text, and not that long.");
  const current = file.sections.plan ?? { text: "", updatedAt: now.toISOString(), history: [] };
  // The intro she confirmed before is kept, as every earlier text is (review of PR 1, finding 9).
  const earlier: unknown = current.hbiIntro;
  const history: unknown[] = Array.isArray(current.hbiIntroHistory) ? current.hbiIntroHistory : [];
  const hbiIntroHistory = earlier && typeof earlier === "object" ? [...history, earlier].slice(-MAX_HISTORY) : history;
  return { ...file, sections: { ...file.sections, plan: { ...current, hbiIntro: { text, confirmedAt: now.toISOString() }, ...(hbiIntroHistory.length > 0 ? { hbiIntroHistory } : {}) } } };
}

/** The plan's standing instructions and the intro she confirmed, as the interface shows them. */
export function planInstructionsOf(file: InstructionsFile): PlanInstructionsView {
  const entry = file.sections.plan;
  const intro = (entry as { hbiIntro?: unknown } | undefined)?.hbiIntro as { text?: unknown; confirmedAt?: unknown } | undefined;
  const confirmed = intro && typeof intro.text === "string" && intro.text.trim() !== "" && typeof intro.confirmedAt === "string" ? { text: intro.text, confirmedAt: intro.confirmedAt } : null;
  return { text: entry?.text ?? "", hbiIntro: confirmed };
}

/** The file with one section's text changed; the earlier text joins the history when a new editing pass starts. Null when nothing changed. */
export function changeInstructions(file: InstructionsFile, id: InstructionsId, raw: string, now: Date): InstructionsFile | null {
  const text = normalizeLineEndings(raw);
  if (text.length > MAX_INSTRUCTIONS_LENGTH) throw new Error("Refused: the instructions are too long.");
  const current = file.sections[id];
  if ((current?.text ?? "") === text) return null;
  let history = current?.history ?? [];
  const newPass = !current || now.getTime() - Date.parse(current.updatedAt) >= EDITING_PASS_MS;
  if (current && newPass && current.text !== "") history = [...history, { text: current.text, savedAt: current.updatedAt }].slice(-MAX_HISTORY);
  return { ...file, sections: { ...file.sections, [id]: { ...current, text, updatedAt: now.toISOString(), history } } };
}

export class InstructionsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(file: string, options: { now?: () => Date; log?: (message: string) => void } = {}) {
    this.file = file;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
  }

  private async read(): Promise<InstructionsRead> {
    await removeLeftoverAppDataTemporaryFiles(this.file);
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`The instructions file could not be read (${(error as Error).message}).`);
        return { ok: false, problem: "damaged" };
      }
    }
    const read = readInstructionsFile(text);
    if (!read.ok) this.log(`The instructions file is ${read.problem === "damaged" ? "damaged" : "from a newer version of the app"}; it is left as it is.`);
    return read;
  }

  /** A section's (or the case map's) instructions; empty when there are none or the file cannot be read. */
  async get(id: InstructionsId): Promise<string> {
    await this.queue;
    const read = await this.read();
    return read.ok ? (read.file.sections[id]?.text ?? "") : "";
  }

  /** The plan's standing instructions and confirmed intro; empty when there are none or the file cannot be read. */
  async plan(): Promise<PlanInstructionsView> {
    await this.queue;
    const read = await this.read();
    return read.ok ? planInstructionsOf(read.file) : { text: "", hbiIntro: null };
  }

  /** Saves the HBI intro she confirmed; false when the file could not be written or cannot be read whole. */
  saveHbiIntro(text: string): Promise<boolean> {
    return this.write((file) => confirmHbiIntro(file, text, this.now()));
  }

  /** Every section's instructions, by id. */
  async all(): Promise<Partial<Record<ReportSectionId, string>>> {
    const read = await this.read();
    if (!read.ok) return {};
    return Object.fromEntries(REPORT_SECTIONS.map((section) => [section.id, read.file.sections[section.id]?.text ?? ""]));
  }

  /** Saves a section's instructions; false when the file could not be written or cannot be read whole. */
  save(id: InstructionsId, text: string): Promise<boolean> {
    return this.write((file) => changeInstructions(file, id, text, this.now()));
  }

  /** Writes the file changed by `change` (null: nothing to change), one write after another. */
  private write(change: (file: InstructionsFile) => InstructionsFile | null): Promise<boolean> {
    const run = this.queue.then(async () => {
      const read = await this.read();
      if (!read.ok) return false;
      const next = change(read.file);
      if (!next) return true;
      const serialized = serializeInstructionsFile(next);
      // Never write what this version would not read back whole (review B1).
      if (!readInstructionsFile(serialized).ok) {
        this.log("The instructions were not saved: they would not read back whole.");
        return false;
      }
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFileDurably(this.file, serialized);
        return true;
      } catch (error) {
        this.log(`The instructions could not be saved (${(error as Error).message}).`);
        return false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
