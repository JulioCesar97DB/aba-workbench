import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { SOURCE_TYPES } from "../src/shared/sources.ts";

/*
 * A case key: what the evaluation expects of an invented case (fixtures/cases/<case>/key.json).
 * The case's sources stay as they are (case.json lists them); the key adds how each one is
 * loaded into the app, the expected behaviors and their names and functions, the people,
 * the planted gaps, the incidents and notes with their home section, and the facts each
 * section must contain. The harness takes any number of cases: every folder under
 * fixtures/cases with a case.json and a key.json is one.
 *
 * Patterns are regular expressions written as strings, matched case-insensitively.
 */

const SECTION_IDS = REPORT_SECTIONS.map((section) => section.id) as [ReportSectionId, ...ReportSectionId[]];
export const SectionIdSchema = z.enum(SECTION_IDS);

/** A pattern that must compile; "i" and "u" are always on. */
const Pattern = z.string().min(1).refine((value) => {
  try {
    new RegExp(value, "iu");
    return true;
  } catch {
    return false;
  }
}, "not a valid regular expression");

const SourceLoad = z.strictObject({
  /** The id in case.json. */
  id: z.string().min(1),
  /** The app's source type (src/shared/sources.ts). */
  type: z.enum(SOURCE_TYPES),
  /** The date the app records with the source, as the clinician would type it. */
  date: z.string().optional(),
  /**
   * For a PDF: the HTML its score report was rendered from (scripts/render-fixture-pdfs.mts),
   * read as text by the number-provenance check. The app still gets the PDF itself.
   */
  textOf: z.string().optional(),
});

/** An invented source that is not in case.json (kept next to it in the case folder). */
const ExtraSource = SourceLoad.extend({ title: z.string().min(1), file: z.string().min(1) });

const NameEntry = z.strictObject({
  id: z.string().min(1),
  /** The name every section should use. */
  name: z.string().min(1),
  /** Other ways of writing the same name that are fine (abbreviations, "her mother"). */
  accepted: z.array(Pattern).default([]),
  /** Names for the same thing that break the thread (another behavior name, a wrong relation). */
  drift: z.array(Pattern).default([]),
  /** Why a drift name is wrong, shown with the finding. */
  note: z.string().optional(),
});

const Behavior = NameEntry.extend({
  functions: z.strictObject({ primary: z.array(z.string()).min(1), secondary: z.array(z.string()).default([]) }),
  /** Same nature and same function: one consequence entry later (section 14). Ids of the behaviors it groups with. */
  groupWith: z.array(z.string()).default([]),
});

const Person = NameEntry.extend({
  role: z.string().min(1),
  /**
   * Her style decision on given names is pending (rules/style.md on step 0 says not to use a
   * caregiver's own name until she answers). "avoid": a caregiver's given name in prose is a
   * finding; "allowed": not checked.
   */
  givenName: z.strictObject({ pattern: Pattern, use: z.enum(["avoid", "allowed"]) }).optional(),
});

const PlantedGap = z
  .strictObject({
  id: z.string().min(1),
  gap: z.string().min(1),
  /** Sections that must leave a [MISSING: ...] (or [CHECK: ...]) marker about it, matching `marker`. */
  mustMarkIn: z.array(SectionIdSchema).default([]),
  marker: Pattern.optional(),
  /**
   * A sentence matching `pattern` fills the gap with something the sources do not say. A
   * sentence that also matches `unless` (a negation, a marker) is not counted. Checked in every section.
   */
  forbid: z.array(z.strictObject({ pattern: Pattern, unless: Pattern.optional(), what: z.string().min(1) })).default([]),
  })
  // Review M1: a gap that must be marked says what the marker is about; otherwise any marker would do.
  .refine((gap) => gap.mustMarkIn.length === 0 || gap.marker !== undefined, { message: "a gap that must be marked needs a marker pattern" });

const Incident = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * A sentence that tells it matches every pattern of one of these lists. The patterns name
   * the incident's own details (its date, what happened), so a passing mention of a place
   * or a program is not a retelling (review S7).
   */
  mentions: z.array(z.array(Pattern).min(1)).min(1),
  /** The section that tells it in full, by step 0's section map (rules/guide.md). */
  home: SectionIdSchema,
  /** How many other sections may refer to it. The audit's rule: one reference. */
  references: z.number().int().min(0).default(1),
  /** Sections whose own key facts require it (Medical Necessity arguing a safety incident): they never count against it. */
  requiredIn: z.array(SectionIdSchema).default([]),
  /** Its home follows a section map she has not confirmed yet: shown as provisional in the summary (review M7). */
  provisional: z.boolean().default(true),
  /** Sources it comes from: an incident whose source is not loaded is not checked. */
  from: z.array(z.string()).min(1),
});

/**
 * The reserved source of a fact that rests on her practice as the rules state it (confirmed by her
 * questionnaire answers; owner's decision, 2026-11-27), not on a case document. Always counted as loaded.
 */
export const RULES_SOURCE = "rules";

const Fact = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** What must be there, in words the judge can check. */
  fact: z.string().min(1),
  /** Sources it comes from: a fact whose source is not loaded is skipped. "rules" (RULES_SOURCE) is her practice as the rules state it. */
  from: z.array(z.string()).min(1),
  /**
   * A fact that rests on a rule pending her answer (her standard practice, not yet given to
   * the AI): reported, never counted in the score (review S2).
   */
  provisional: z.boolean().default(false),
});

const PayerParams = z.strictObject({
  /** The settings impairment must be shown in (Medical Necessity): each a pattern. */
  settings: z.array(z.strictObject({ name: z.string(), pattern: Pattern })).min(1),
  /** Other services the child receives: Medical Necessity says ABA complements them. */
  otherServices: z.array(z.strictObject({ name: z.string(), pattern: Pattern })).default([]),
  /** The caregivers expected to take part in training (Family/Caregiver Involvement). */
  caregivers: z.array(z.strictObject({ name: z.string(), pattern: Pattern })).min(1),
});

export const CaseKeySchema = z.strictObject({
  keyVersion: z.string().min(1),
  caseId: z.string().min(1),
  child: z.strictObject({ firstName: z.string().min(1), fullName: z.string().min(1) }),
  sources: z.array(SourceLoad).min(1),
  extraSources: z.array(ExtraSource).default([]),
  /** Her session notes and standing instructions for the run, as she would type them (invented). */
  inputs: z
    .strictObject({
      /** Her session notes; a fact or incident from them names "notes" as its source. */
      notes: z.string().optional(),
      instructions: z.record(SectionIdSchema, z.string()).optional(),
    })
    .default({}),
  behaviors: z.array(Behavior).min(1),
  people: z.array(Person).default([]),
  procedures: z.array(NameEntry).default([]),
  plantedGaps: z.array(PlantedGap).default([]),
  incidents: z.array(Incident).default([]),
  /** Phrases any section may repeat word for word (the diagnosis as the CDE words it, instrument names). */
  allowedRepeats: z.array(z.string().min(1)).default([]),
  payer: PayerParams,
  /** The facts each section must contain. */
  sectionFacts: z.partialRecord(SectionIdSchema, z.array(Fact)),
});

export type CaseKey = z.infer<typeof CaseKeySchema>;
export type CaseKeyFact = z.infer<typeof Fact>;
export type CaseKeyIncident = z.infer<typeof Incident>;
export type CaseKeyGap = z.infer<typeof PlantedGap>;
export type CaseKeyName = z.infer<typeof NameEntry>;

/** What case.json says (the fields the evaluation reads). */
export const CaseFileSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  sources: z.array(z.looseObject({ id: z.string(), title: z.string(), file: z.string() })),
});

export interface LoadedCase {
  folder: string;
  caseFile: z.infer<typeof CaseFileSchema>;
  key: CaseKey;
}

/** Reads one case folder's case.json and key.json, and checks that the key names only sources the case has. */
export function loadCase(folder: string): LoadedCase {
  const caseFile = CaseFileSchema.parse(JSON.parse(readFileSync(path.join(folder, "case.json"), "utf8")));
  const key = CaseKeySchema.parse(JSON.parse(readFileSync(path.join(folder, "key.json"), "utf8")));
  const problems = keyProblems(caseFile, key);
  if (problems.length > 0) throw new Error(`The key of ${folder} does not match its case:\n- ${problems.join("\n- ")}`);
  return { folder, caseFile, key };
}

/** Everything in a key that does not match its case (pure, for the tests). */
export function keyProblems(caseFile: z.infer<typeof CaseFileSchema>, key: CaseKey): string[] {
  const problems: string[] = [];
  if (key.caseId !== caseFile.id) problems.push(`caseId ${key.caseId} is not ${caseFile.id}`);
  const caseIds = new Set(caseFile.sources.map((source) => source.id));
  const loaded = new Set(key.sources.map((source) => source.id));
  for (const id of caseIds) if (!loaded.has(id)) problems.push(`source ${id} has no load entry`);
  for (const id of loaded) if (!caseIds.has(id)) problems.push(`load entry ${id} is not a source of the case`);
  const all = new Set([...caseIds, ...key.extraSources.map((source) => source.id)]);
  const behaviorIds = new Set(key.behaviors.map((behavior) => behavior.id));
  for (const behavior of key.behaviors) for (const other of behavior.groupWith) if (!behaviorIds.has(other)) problems.push(`behavior ${behavior.id} groups with unknown ${other}`);
  if (key.inputs.notes) all.add("notes");
  for (const incident of key.incidents) for (const id of incident.from) if (!all.has(id)) problems.push(`incident ${incident.id} comes from unknown source ${id}`);
  for (const [section, facts] of Object.entries(key.sectionFacts)) {
    for (const fact of facts ?? []) for (const id of fact.from) if (!all.has(id) && id !== RULES_SOURCE) problems.push(`fact ${section}/${fact.id} comes from unknown source ${id}`);
  }
  return problems;
}
