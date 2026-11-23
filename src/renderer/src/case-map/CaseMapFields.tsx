import type { TFunction } from "i18next";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { baselineMean, FUNCTION_NAMES, MAX_MAP_LIST, TEMPLATE_SECTIONS, type Claim, type ClaimInput, type MapPartId, type MapRef } from "../../../shared/case-map.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { Button } from "../components/Button.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useLanguage } from "../language.tsx";
import { MAP_TERMS } from "../i18n/terms.ts";
import { EVIDENCE_TOOL_OPTIONS, savedClaim, savedInList, type ColumnSpec, type FieldSpec, type TermList, type WordList } from "./specs.ts";

/*
 * The form of a case map item: every field of its part (specs.ts), each value with chips
 * saying where it came from (a source, one of her sections, her notes, her) and its
 * [CHECK] when it has one. The form holds what she sends (values and [CHECK]s); the item
 * as saved gives the chips, for the values she has not changed since.
 */

export interface MapFormContext {
  part: MapPartId | "groups";
  behaviors: ReadonlyArray<{ id: string; title: string }>;
  settings: ReadonlyArray<{ id: string; title: string }>;
  /** A source's name on screen, by id; null when the case has no such source. */
  sourceLabel: (id: string) => string | null;
  /**
   * For a group's form: the other group a behavior is in, by its name, or null. Ticking it
   * moves it into this group (review round 1, S1), so the form says so before she ticks.
   */
  otherGroupOf?: (behaviorId: string) => string | null;
}

type Values = Record<string, unknown>;

const inputClass = "w-full rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-base text-fg";
const selectClass = "min-h-control-sm rounded-md border border-border-control bg-surface px-2 text-sm text-fg";

function isTerm(words: WordList | TermList): words is TermList {
  return words in MAP_TERMS;
}

/** An option's name: a clinical term (English on both screens), or a translated word. */
export function optionLabel(t: TFunction, words: WordList | TermList, option: string): { text: string; lang?: "en" } {
  if (isTerm(words)) {
    const terms = MAP_TERMS[words] as Record<string, string>;
    return { text: terms[option] ?? option, lang: "en" };
  }
  return { text: t(`caseMap.words.${words}.${option}` as "caseMap.title", { defaultValue: option }) };
}

/** A field's label on screen. */
export function fieldLabel(t: TFunction, part: MapPartId | "groups", key: string): string {
  return t(`caseMap.field.${part}.${key}` as "caseMap.title", { defaultValue: key });
}

/* Where a value came from */

function refLabel(t: TFunction, ref: MapRef, context: MapFormContext): string {
  switch (ref.kind) {
    case "source":
      return (ref.sourceId ? context.sourceLabel(ref.sourceId) : null) ?? t("caseMap.ref.source");
    case "section": {
      const title = REPORT_SECTIONS.find((section) => section.id === ref.sectionId)?.title ?? t("caseMap.ref.source");
      return t("caseMap.ref.section", { title, version: ref.version ?? "?" });
    }
    case "note":
      return t("caseMap.ref.note");
    case "her":
      return t("caseMap.ref.her");
    case "app":
      return t("caseMap.ref.app");
    default:
      return ref.kind;
  }
}

const chipBase = "inline-flex max-w-full items-center rounded-sm px-1.5 py-px font-mono text-2xs break-words";

/** The chips of a value: where it came from, and what kind of content it is when it is not a fact. */
export function Provenance({ claim, context }: { claim: Pick<Claim<unknown>, "refs" | "origin"> | null; context: MapFormContext }) {
  const { t } = useTranslation();
  if (!claim) return null;
  const chips: ReactNode[] = [];
  if (claim.origin !== "her" && claim.origin !== "extracted") {
    const known = claim.origin === "ai-drafted" || claim.origin === "hypothesis" || claim.origin === "proposed";
    chips.push(
      <span key="origin" className={`${chipBase} ${claim.origin === "proposed" ? "bg-warning-subtle text-warning" : "border border-border-control bg-surface text-fg"}`}>
        {known ? t(`caseMap.origin.${claim.origin as "proposed"}`) : claim.origin}
      </span>,
    );
  }
  claim.refs.forEach((ref, index) => {
    const label = refLabel(t, ref, context);
    const tone = ref.kind === "her" ? "bg-success-subtle text-success" : ref.kind === "note" ? "bg-accent-subtle text-fg-on-accent-subtle" : "bg-neutral-subtle text-neutral";
    const chip = (
      <span key={index} tabIndex={ref.quote ? 0 : undefined} aria-label={ref.quote ? `${label}: ${ref.quote}` : undefined} className={`${chipBase} ${tone}`}>
        {label}
      </span>
    );
    chips.push(
      ref.quote ? (
        <Tooltip key={index} content={<span lang="en">“{ref.quote}”</span>}>
          {chip}
        </Tooltip>
      ) : (
        chip
      ),
    );
  });
  return (
    <span className="inline-flex flex-wrap gap-1" aria-label={t("caseMap.provenanceLabel")}>
      {chips}
    </span>
  );
}

/** A [CHECK] on a value, with "Resolved" to clear it. */
function CheckLine({ text, onResolve }: { text: string; onResolve: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span lang="en" className="rounded-sm bg-warning-subtle px-1.5 py-0.5 text-warning">
        {t("caseMap.checkText", { text })}
      </span>
      <Button size="sm" onClick={onResolve}>
        {t("caseMap.resolved")}
      </Button>
    </p>
  );
}

/* Fields */

function asClaim(value: unknown): ClaimInput | null {
  return typeof value === "object" && value !== null && "value" in value ? (value as ClaimInput) : null;
}

/** A box of her own text, in English (the assessment's language). A long one grows with its text (field-sizing), up to a scrolling height. */
function TextInput({ id, value, max, multiline, onChange, label, describedBy }: { id?: string; value: string; max: number; multiline?: boolean; onChange: (text: string) => void; label?: string; describedBy?: string }) {
  return multiline ? (
    <textarea id={id} lang="en" aria-label={label} aria-describedby={describedBy} value={value} maxLength={max} onChange={(event) => onChange(event.target.value)} className={`${inputClass} field-sizing-content min-h-16 max-h-80 resize-y text-md`} />
  ) : (
    <input id={id} lang="en" aria-label={label} aria-describedby={describedBy} value={value} maxLength={max} onChange={(event) => onChange(event.target.value)} className={`${inputClass} min-h-control-sm`} />
  );
}

/** A field: its label beside it on a wide form, above it on a narrow one. A field of several controls is a named group. */
function FieldRow({ label, htmlFor, children, legend }: { label: string; htmlFor?: string; children: ReactNode; legend?: boolean }) {
  const labelId = useId();
  if (legend) {
    return (
      <div role="group" aria-labelledby={labelId} className="grid gap-1.5 @lg:grid-cols-[10rem_1fr] @lg:gap-4">
        <span id={labelId} className="pt-1 text-sm font-semibold text-fg-muted">
          {label}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5 @lg:grid-cols-[10rem_1fr] @lg:gap-4">
      <label htmlFor={htmlFor} className="pt-1 text-sm font-semibold text-fg-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** One value: what she types, and where the saved one came from. */
function ClaimText({ label, spec, value, saved, onChange, context }: { label: string; spec: Extract<FieldSpec, { kind: "text" }>; value: unknown; saved: unknown; onChange: (next: ClaimInput | null) => void; context: MapFormContext }) {
  const id = useId();
  const claim = asClaim(value);
  const text = claim?.value ?? "";
  return (
    <FieldRow label={label} htmlFor={id}>
      <TextInput id={id} value={text} max={spec.max} multiline={spec.multiline} onChange={(next) => onChange(next === "" && !claim?.check ? null : { value: next, check: claim?.check ?? null })} />
      <Provenance claim={savedClaim(saved, text)} context={context} />
      {claim?.check ? <CheckLine text={claim.check} onResolve={() => onChange(claim.value === "" ? null : { value: claim.value, check: null })} /> : null}
    </FieldRow>
  );
}

function NativeSelect({ id, value, options, words, optional, onChange, label }: { id?: string; value: string; options: readonly string[]; words: WordList | TermList; optional: boolean; onChange: (value: string) => void; label?: string }) {
  const { t } = useTranslation();
  const known = value === "" || options.includes(value);
  return (
    <select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={selectClass}>
      {optional ? <option value="">{t("caseMap.notGiven")}</option> : null}
      {known ? null : <option value={value}>{value}</option>}
      {options.map((option) => {
        const name = optionLabel(t, words, option);
        return (
          <option key={option} value={option} lang={name.lang}>
            {name.text}
          </option>
        );
      })}
    </select>
  );
}

function ClaimChoice({ label, spec, value, saved, onChange, context }: { label: string; spec: Extract<FieldSpec, { kind: "choice" }>; value: unknown; saved: unknown; onChange: (next: ClaimInput | null) => void; context: MapFormContext }) {
  const id = useId();
  const claim = asClaim(value);
  const current = claim?.value ?? "";
  return (
    <FieldRow label={label} htmlFor={id}>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect id={id} value={current} options={spec.options} words={spec.words} optional onChange={(next) => onChange(next === "" && !claim?.check ? null : { value: next, check: claim?.check ?? null })} />
        <Provenance claim={savedClaim(saved, current)} context={context} />
      </div>
      {claim?.check ? <CheckLine text={claim.check} onResolve={() => onChange(claim.value === "" ? null : { value: claim.value, check: null })} /> : null}
    </FieldRow>
  );
}

/** Several values, one per line, each with where it came from. */
function ClaimList({ label, spec, value, saved, onChange, context }: { label: string; spec: Extract<FieldSpec, { kind: "list" }>; value: unknown; saved: unknown; onChange: (next: ClaimInput[]) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  const lines = (Array.isArray(value) ? value : []).map(asClaim).filter((claim): claim is ClaimInput => claim !== null);
  const values = lines.map((line) => line.value);
  const set = (index: number, next: ClaimInput) => onChange(lines.map((line, at) => (at === index ? next : line)));
  return (
    <FieldRow label={label} legend>
      {lines.map((line, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <TextInput value={line.value} max={spec.max} multiline label={`${label} ${index + 1}`} onChange={(next) => set(index, { ...line, value: next })} />
            <Button size="sm" aria-label={t("caseMap.removeLine", { number: index + 1 })} onClick={() => onChange(lines.filter((_line, at) => at !== index))}>
              {t("caseMap.remove")}
            </Button>
          </div>
          <Provenance claim={savedInList(saved, values, index)} context={context} />
          {line.check ? <CheckLine text={line.check} onResolve={() => set(index, { ...line, check: null })} /> : null}
        </div>
      ))}
      <AddButton count={lines.length} label={t("caseMap.addLine")} onAdd={() => onChange([...lines, { value: "", check: null }])} />
    </FieldRow>
  );
}

/** Rows of values (scores, observations, other services): each row a small card, its values side by side when there is room. */
function Records({ label, columns, value, saved, onChange, context }: { label: string; columns: ColumnSpec[]; value: unknown; saved: unknown; onChange: (next: Values[]) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  const rows = (Array.isArray(value) ? value : []) as Values[];
  const savedRows = Array.isArray(saved) ? (saved as Values[]) : [];
  const setCell = (index: number, key: string, next: ClaimInput | null) => onChange(rows.map((row, at) => (at === index ? { ...row, [key]: next } : row)));
  const columnLabel = (key: string) => t(`caseMap.column.${key}` as "caseMap.title", { defaultValue: key });
  return (
    <FieldRow label={label} legend>
      {rows.map((row, index) => (
        <div key={index} role="group" aria-label={`${label} ${index + 1}`} className="flex flex-col gap-2 rounded-md border border-border p-2.5">
          <div className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-4">
            {columns.map((column) => {
              const claim = asClaim(row[column.key]);
              const cellLabel = `${columnLabel(column.key)} ${index + 1}`;
              const set = (next: string) => setCell(index, column.key, next === "" && !claim?.check ? null : { value: next, check: claim?.check ?? null });
              return (
                <div key={column.key} className="flex min-w-0 flex-col gap-1">
                  <span aria-hidden="true" className="text-xs font-semibold text-fg-muted">
                    {columnLabel(column.key)}
                  </span>
                  {column.kind === "text" ? (
                    <TextInput value={claim?.value ?? ""} max={column.max} label={cellLabel} onChange={set} />
                  ) : (
                    <NativeSelect value={claim?.value ?? ""} options={column.options} words={column.words} optional label={cellLabel} onChange={set} />
                  )}
                  <Provenance claim={savedClaim(savedRows[index]?.[column.key], claim?.value ?? "")} context={context} />
                  {claim?.check ? <CheckLine text={claim.check} onResolve={() => setCell(index, column.key, claim.value === "" ? null : { value: claim.value, check: null })} /> : null}
                </div>
              );
            })}
          </div>
          <div>
            <Button size="sm" aria-label={t("caseMap.removeRow", { number: index + 1 })} onClick={() => onChange(rows.filter((_row, at) => at !== index))}>
              {t("caseMap.remove")}
            </Button>
          </div>
        </div>
      ))}
      <AddButton count={rows.length} label={t("caseMap.addRow")} onAdd={() => onChange([...rows, Object.fromEntries(columns.map((column) => [column.key, null]))])} />
    </FieldRow>
  );
}

/** "Add a line" and its kin: off at the most a list may hold, saying so, so no line past the limit is ever typed and refused (review round 1, minor 1). */
function AddButton({ count, label, onAdd }: { count: number; label: string; onAdd: () => void }) {
  const { t } = useTranslation();
  const full = count >= MAX_MAP_LIST;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={full} onClick={onAdd}>
        {label}
      </Button>
      {full ? <span className="text-xs text-fg-muted">{t("caseMap.atMost", { count: MAX_MAP_LIST })}</span> : null}
    </div>
  );
}

function Checkbox({ checked, onChange, children, lang }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; lang?: string }) {
  return (
    <label className="inline-flex min-h-control-sm items-center gap-2 text-sm" lang={lang}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-accent" />
      {children}
    </label>
  );
}

/** Tags from a fixed list, as one value (barriers). */
function Tags({ label, spec, value, saved, onChange, context }: { label: string; spec: Extract<FieldSpec, { kind: "tags" }>; value: unknown; saved: unknown; onChange: (next: ClaimInput<string[]> | null) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  const claim = typeof value === "object" && value !== null ? (value as ClaimInput<string[]>) : null;
  const tags = claim?.value ?? [];
  const toggle = (tag: string, on: boolean) => {
    const next = on ? [...tags, tag] : tags.filter((entry) => entry !== tag);
    onChange(next.length === 0 && !claim?.check ? null : { value: spec.options.filter((option) => next.includes(option)).concat(next.filter((entry) => !spec.options.includes(entry))), check: claim?.check ?? null });
  };
  return (
    <FieldRow label={label} legend>
      <div className="flex flex-wrap gap-x-4">
        {spec.options.map((option) => {
          const name = optionLabel(t, spec.words, option);
          return (
            <Checkbox key={option} checked={tags.includes(option)} lang={name.lang} onChange={(on) => toggle(option, on)}>
              {name.text}
            </Checkbox>
          );
        })}
      </div>
      <Provenance claim={savedClaim(saved, tags)} context={context} />
      {claim?.check ? <CheckLine text={claim.check} onResolve={() => onChange(tags.length === 0 ? null : { value: tags, check: null })} /> : null}
    </FieldRow>
  );
}

/** Ids of other items (the settings of a behavior, the behaviors of a risk or a group). */
function Ids({ label, spec, value, onChange, context }: { label: string; spec: Extract<FieldSpec, { kind: "ids" }>; value: unknown; onChange: (next: string[]) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const choices = spec.from === "behaviors" ? context.behaviors : context.settings;
  // An id whose item is gone (removed, or another version shown) stays chosen until she unticks it.
  const missing = ids.filter((id) => !choices.some((choice) => choice.id === id));
  return (
    <FieldRow label={label} legend>
      {choices.length === 0 && missing.length === 0 ? <p className="text-sm text-fg-muted">{t(spec.from === "behaviors" ? "caseMap.noBehaviors" : "caseMap.noSettings")}</p> : null}
      <div className="flex flex-wrap gap-x-4">
        {choices.map((choice) => {
          const elsewhere = spec.from === "behaviors" && !ids.includes(choice.id) ? (context.otherGroupOf?.(choice.id) ?? null) : null;
          return (
            <Checkbox key={choice.id} checked={ids.includes(choice.id)} onChange={(on) => onChange(on ? [...ids, choice.id] : ids.filter((id) => id !== choice.id))}>
              <span lang="en">{choice.title}</span>
              {elsewhere ? <span className="text-xs text-fg-muted"> {t("caseMap.inOtherGroup", { group: elsewhere })}</span> : null}
            </Checkbox>
          );
        })}
        {missing.map((id) => (
          <Checkbox key={id} checked onChange={() => onChange(ids.filter((entry) => entry !== id))}>
            {t("caseMap.missingItem", { id })}
          </Checkbox>
        ))}
      </div>
    </FieldRow>
  );
}

interface FunctionInput {
  primary: string[];
  secondary: string[];
  evidence: Array<{ tool: string; respondent: string | null; result: ClaimInput | null; supports: string[] }>;
  reasoning: string | null;
  check: string | null;
}

/** A behavior's hypothesized function: primary and secondary, how the evidence combines, and the evidence. */
function FunctionField({ label, value, saved, onChange, context }: { label: string; value: unknown; saved: unknown; onChange: (next: FunctionInput) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  const reasoningId = useId();
  const fn = value as FunctionInput;
  const savedFn = (typeof saved === "object" && saved !== null ? saved : {}) as { origin?: string; evidence?: Values[] };
  const roleOf = (name: string) => (fn.primary.includes(name) ? "primary" : fn.secondary.includes(name) ? "secondary" : "none");
  const setRole = (name: string, role: "none" | "primary" | "secondary") =>
    onChange({
      ...fn,
      primary: FUNCTION_NAMES.filter((entry) => (entry === name ? role === "primary" : fn.primary.includes(entry))),
      secondary: FUNCTION_NAMES.filter((entry) => (entry === name ? role === "secondary" : fn.secondary.includes(entry))),
    });
  const setEvidence = (index: number, next: FunctionInput["evidence"][number]) => onChange({ ...fn, evidence: fn.evidence.map((entry, at) => (at === index ? next : entry)) });
  const origin = savedFn.origin;
  return (
    <FieldRow label={label} legend>
      <div className="flex flex-wrap items-center gap-2">
        {origin === "hypothesis" ? <span className={`${chipBase} border border-border-control bg-surface text-fg`}>{t("caseMap.origin.hypothesis")}</span> : null}
        {origin === "her" ? <span className={`${chipBase} bg-success-subtle text-success`}>{t("caseMap.ref.her")}</span> : null}
      </div>
      <table className="w-full max-w-md border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-semibold">
              <span className="sr-only">{t("caseMap.function.name")}</span>
            </th>
            {(["none", "primary", "secondary"] as const).map((role) => (
              <th key={role} scope="col" className="px-2 py-1 text-center font-semibold">
                {t(`caseMap.function.${role}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FUNCTION_NAMES.map((name) => {
            const term = optionLabel(t, "functions", name);
            return (
              <tr key={name} className="border-t border-border">
                <th scope="row" lang="en" className="px-2 py-1 text-left font-normal">
                  {term.text}
                </th>
                {(["none", "primary", "secondary"] as const).map((role) => (
                  <td key={role} className="px-2 py-1 text-center">
                    <input
                      type="radio"
                      name={`${reasoningId}-${name}`}
                      aria-label={`${term.text}: ${t(`caseMap.function.${role}`)}`}
                      checked={roleOf(name) === role}
                      onChange={() => setRole(name, role)}
                      className="size-4 accent-accent"
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <label htmlFor={reasoningId} className="text-sm font-medium">
        {t("caseMap.function.reasoning")}
      </label>
      <TextInput id={reasoningId} value={fn.reasoning ?? ""} max={1500} multiline onChange={(next) => onChange({ ...fn, reasoning: next === "" ? null : next })} />
      {fn.check ? <CheckLine text={fn.check} onResolve={() => onChange({ ...fn, check: null })} /> : null}
      <p className="text-sm font-medium">{t("caseMap.function.evidence")}</p>
      {fn.evidence.map((entry, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={entry.tool} options={EVIDENCE_TOOL_OPTIONS} words="tools" optional={false} label={`${t("caseMap.function.tool")} ${index + 1}`} onChange={(tool) => setEvidence(index, { ...entry, tool })} />
            <input
              lang="en"
              aria-label={`${t("caseMap.function.respondent")} ${index + 1}`}
              placeholder={t("caseMap.function.respondent")}
              value={entry.respondent ?? ""}
              maxLength={120}
              onChange={(event) => setEvidence(index, { ...entry, respondent: event.target.value === "" ? null : event.target.value })}
              className={`${inputClass} min-h-control-sm max-w-48`}
            />
            <Button size="sm" aria-label={t("caseMap.function.removeEvidence", { number: index + 1 })} onClick={() => onChange({ ...fn, evidence: fn.evidence.filter((_entry, at) => at !== index) })}>
              {t("caseMap.remove")}
            </Button>
          </div>
          <TextInput
            value={entry.result?.value ?? ""}
            max={1500}
            label={`${t("caseMap.function.result")} ${index + 1}`}
            onChange={(next) => setEvidence(index, { ...entry, result: next === "" && !entry.result?.check ? null : { value: next, check: entry.result?.check ?? null } })}
          />
          <Provenance claim={savedClaim(savedFn.evidence?.[index]?.result, entry.result?.value ?? "")} context={context} />
          <div className="flex flex-wrap gap-x-3" role="group" aria-label={`${t("caseMap.function.supports")} ${index + 1}`}>
            {FUNCTION_NAMES.map((name) => (
              <Checkbox key={name} lang="en" checked={entry.supports.includes(name)} onChange={(on) => setEvidence(index, { ...entry, supports: FUNCTION_NAMES.filter((option) => (option === name ? on : entry.supports.includes(option))) })}>
                {optionLabel(t, "functions", name).text}
              </Checkbox>
            ))}
          </div>
        </div>
      ))}
      <AddButton count={fn.evidence.length} label={t("caseMap.function.addEvidence")} onAdd={() => onChange({ ...fn, evidence: [...fn.evidence, { tool: "observation", respondent: null, result: null, supports: [] }] })} />
    </FieldRow>
  );
}

function SectionChoice({ label, value, onChange }: { label: string; value: unknown; onChange: (next: number | null) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <select id={id} value={typeof value === "number" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} className={`${selectClass} max-w-md`}>
        <option value="">{t("caseMap.notGiven")}</option>
        {TEMPLATE_SECTIONS.map((title, index) => (
          <option key={title} value={index + 1} lang="en">
            {index + 1} · {title}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

function Plain({ label, spec, value, onChange }: { label: string; spec: Extract<FieldSpec, { kind: "plain" }>; value: unknown; onChange: (next: string) => void }) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <TextInput id={id} value={typeof value === "string" ? value : ""} max={spec.max} multiline={spec.multiline} onChange={onChange} />
    </FieldRow>
  );
}

function PlainChoice({ label, spec, value, onChange }: { label: string; spec: Extract<FieldSpec, { kind: "plainChoice" }>; value: unknown; onChange: (next: string | null) => void }) {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <div>
        <NativeSelect id={id} value={typeof value === "string" ? value : ""} options={spec.options} words={spec.words} optional={spec.optional} onChange={(next) => onChange(next === "" ? null : next)} />
      </div>
    </FieldRow>
  );
}

/** The section 8 baseline: the mean of the observations' counts, computed by the app from what the form holds (D20; review round 1, S2). */
function BaselineMean({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const observations = (typeof value === "object" && value !== null && Array.isArray((value as Values).observations) ? (value as Values).observations : []) as Array<{ value: ClaimInput | null }>;
  if (observations.length === 0) return null;
  const mean = baselineMean(observations.map((observation) => ({ value: observation.value ? { value: observation.value.value, refs: [], origin: "her", check: null } : null })));
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold text-fg-muted">{t("caseMap.mean")}</span>
      {mean === null ? (
        <span className="text-fg-muted">{t("caseMap.meanNone")}</span>
      ) : (
        <>
          <span className="font-mono">{new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(mean)}</span>
          <Provenance claim={{ refs: [{ kind: "app" }], origin: "extracted" }} context={{ part: "behaviors", behaviors: [], settings: [], sourceLabel: () => null }} />
        </>
      )}
    </p>
  );
}

/** Every field of an item, in its part's order. */
export function MapFields({ fields, labelPart, value, saved, onChange, context }: { fields: FieldSpec[]; labelPart: MapPartId | "groups"; value: Values; saved: Values; onChange: (next: Values) => void; context: MapFormContext }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      {fields.map((spec) => {
        const label = fieldLabel(t, labelPart, spec.key);
        const set = (next: unknown) => onChange({ ...value, [spec.key]: next });
        const current = value[spec.key];
        const stored = saved[spec.key];
        switch (spec.kind) {
          case "text":
            return <ClaimText key={spec.key} label={label} spec={spec} value={current} saved={stored} onChange={set} context={context} />;
          case "choice":
            return <ClaimChoice key={spec.key} label={label} spec={spec} value={current} saved={stored} onChange={set} context={context} />;
          case "list":
            return <ClaimList key={spec.key} label={label} spec={spec} value={current} saved={stored} onChange={set} context={context} />;
          case "records":
            return <Records key={spec.key} label={label} columns={spec.columns} value={current} saved={stored} onChange={set} context={context} />;
          case "tags":
            return <Tags key={spec.key} label={label} spec={spec} value={current} saved={stored} onChange={set} context={context} />;
          case "ids":
            return <Ids key={spec.key} label={label} spec={spec} value={current} onChange={set} context={context} />;
          case "function":
            return <FunctionField key={spec.key} label={label} value={current} saved={stored} onChange={set} context={context} />;
          case "section":
            return <SectionChoice key={spec.key} label={label} value={current} onChange={set} />;
          case "plain":
            return <Plain key={spec.key} label={label} spec={spec} value={current} onChange={set} />;
          case "plainChoice":
            return <PlainChoice key={spec.key} label={label} spec={spec} value={current} onChange={set} />;
          case "nested":
            return (
              <fieldset key={spec.key} className="flex flex-col gap-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-semibold">{label}</legend>
                <MapFields
                  fields={spec.fields}
                  labelPart={labelPart}
                  value={(typeof current === "object" && current !== null ? current : {}) as Values}
                  saved={(typeof stored === "object" && stored !== null ? stored : {}) as Values}
                  onChange={set}
                  context={context}
                />
                {spec.key === "baseline" ? <BaselineMean value={current} /> : null}
              </fieldset>
            );
        }
      })}
    </div>
  );
}
