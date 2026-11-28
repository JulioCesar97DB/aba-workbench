import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClaimInput } from "../../../shared/case-map.ts";
import { FUNCTION_NAMES, MAP_TEXT_LIMITS } from "../../../shared/case-map.ts";
import {
  CAREGIVER_GOAL_KINDS,
  MASTERY_CATEGORIES,
  MAX_BASELINE_SESSIONS,
  MAX_PARAMETERS,
  MAX_PROGRAM_STEPS,
  MAX_PROGRAM_TARGETS,
  OUTCOMES,
  PARAMETER_ROLES,
  PARAMETER_UNITS,
  PROGRAM_AREAS,
  PROGRAM_KINDS,
  PROGRAM_MEASURES,
  STRATEGY_KINDS,
  type PlanItemByPart,
  type PlanPartId,
} from "../../../shared/plan.ts";
import { sessionPercent } from "../../../shared/plan-compute.ts";
import type { FailedSave } from "../../../shared/sources.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import { Button } from "../components/Button.tsx";
import { FUNCTION_TITLES } from "../../../shared/plan-copy.ts";
import type { PlanData } from "./data.ts";

/*
 * The form of a plan item (the Plan step, by hand): what she types is saved as she types
 * (no Save button), into the part's editing pass, kept by the main process when it cannot be
 * saved and put back after a reload, exactly as a case map item's form. Saving accepts the
 * item (D3). The form holds what the interface may send for the part: values and [CHECK]s
 * only, never a decision.
 */

const T = MAP_TEXT_LIMITS;
type Values = Record<string, unknown>;
type Claimish = { value: string; check?: string | null } | null | undefined;

const claimIn = (claim: Claimish): ClaimInput | null => (claim && typeof claim.value === "string" ? { value: claim.value, check: claim.check ?? null } : null);
const claimsIn = (claims: readonly Claimish[] | undefined) => (claims ?? []).map(claimIn).filter((claim): claim is ClaimInput => claim !== null);
const parametersIn = (parameters: PlanItemByPart["strategies"]["parameters"]) => parameters.map((parameter) => ({ label: parameter.label ?? "", role: parameter.role ?? "other", value: claimIn(parameter.value), unit: parameter.unit ?? "other" }));

/** What the form starts from: the item's fields as saved, as she would send them back unchanged. */
export function planInput<P extends PlanPartId>(part: P, raw: PlanItemByPart[P]): Values {
  switch (part) {
    case "strategies": {
      const item = raw as PlanItemByPart["strategies"];
      return {
        name: claimIn(item.name),
        kind: item.kind,
        functions: [...item.functions],
        parameters: parametersIn(item.parameters),
        tracesTo: item.tracesTo.map((trace) => ({ behaviorId: trace.behaviorId, antecedent: claimIn(trace.antecedent) })),
      };
    }
    case "interventions": {
      const item = raw as PlanItemByPart["interventions"];
      return { function: item.function, kind: item.kind, behaviorIds: [...item.behaviorIds], groupId: item.groupId, text: claimIn(item.text), strategyIds: [...item.strategyIds], safetyFirst: item.safetyFirst };
    }
    case "programs": {
      const item = raw as PlanItemByPart["programs"];
      return {
        kind: item.kind,
        title: claimIn(item.title),
        function: item.function,
        outcome: item.outcome,
        area: item.area,
        answers: claimsIn(item.answers),
        definition: claimIn(item.definition),
        procedure: claimsIn(item.procedure),
        targets: claimsIn(item.targets),
        measure: item.measure,
        parameters: parametersIn(item.parameters),
        baseline: {
          sessions: item.baseline.sessions.map((session) => ({ date: claimIn(session.date), correct: claimIn(session.correct), opportunities: claimIn(session.opportunities) })),
          caregiverReport: claimIn(item.baseline.caregiverReport),
          caregiverPercent: claimIn(item.baseline.caregiverPercent),
          override: claimIn(item.baseline.override),
        },
        mastery: { category: item.mastery.category, override: claimIn(item.mastery.override) },
      };
    }
    case "glossary": {
      const item = raw as PlanItemByPart["glossary"];
      return { strategyId: item.strategyId, definition: claimIn(item.definition), implementation: claimIn(item.implementation) };
    }
    case "caregiverGoals": {
      const item = raw as PlanItemByPart["caregiverGoals"];
      return { kind: item.kind, title: claimIn(item.title), procedure: claimIn(item.procedure), baselinePercent: claimIn(item.baselinePercent), masteryOverride: claimIn(item.masteryOverride) };
    }
    default: {
      const item = raw as PlanItemByPart["planInputs"];
      return { weeklyHours: claimIn(item.weeklyHours), targetOverride: claimIn(item.targetOverride) };
    }
  }
}

/** A claim from what she typed: none when the box is empty and carries no [CHECK]. */
const typed = (text: string, before: Claimish): ClaimInput | null => (text === "" && !before?.check ? null : { value: text, check: before?.check ?? null });

const inputClass = "w-full rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-base text-fg";
const selectClass = "min-h-control-sm rounded-md border border-border-control bg-surface px-2 text-sm text-fg";

function Row({ label, htmlFor, children, group }: { label: string; htmlFor?: string; children: ReactNode; group?: boolean }) {
  const labelId = useId();
  return group ? (
    <div role="group" aria-labelledby={labelId} className="grid gap-1.5 @lg:grid-cols-[10rem_1fr] @lg:gap-4">
      <span id={labelId} className="pt-1 text-sm font-semibold text-fg-muted">
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  ) : (
    <div className="grid gap-1.5 @lg:grid-cols-[10rem_1fr] @lg:gap-4">
      <label htmlFor={htmlFor} className="pt-1 text-sm font-semibold text-fg-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** A [CHECK] on a value, with "Resuelto" to clear it. */
function CheckNote({ text, onResolve }: { text: string; onResolve: () => void }) {
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

export function TextBox({ label, value, onChange, multiline = false, max = T.text, lang = "en", hint }: { label: string; value: Claimish; onChange: (next: ClaimInput | null) => void; multiline?: boolean; max?: number; lang?: string; hint?: string }) {
  const id = useId();
  const hintId = useId();
  const text = value?.value ?? "";
  const set = (next: string) => onChange(typed(next, value));
  return (
    <Row label={label} htmlFor={id}>
      {multiline ? (
        <textarea id={id} lang={lang} value={text} maxLength={max} aria-describedby={hint ? hintId : undefined} onChange={(event) => set(event.target.value)} className={`${inputClass} field-sizing-content min-h-16 max-h-80 resize-y text-md`} />
      ) : (
        <input id={id} lang={lang} value={text} maxLength={max} aria-describedby={hint ? hintId : undefined} onChange={(event) => set(event.target.value)} className={`${inputClass} min-h-control-sm`} />
      )}
      {hint ? (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
      {value?.check ? <CheckNote text={value.check} onResolve={() => onChange(text === "" ? null : { value: text, check: null })} /> : null}
    </Row>
  );
}

export function Choice({ label, value, options, labelOf, onChange, optional = false, english = false }: { label: string; value: string | null; options: readonly string[]; labelOf: (option: string) => string; onChange: (next: string | null) => void; optional?: boolean; english?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const current = value ?? "";
  const known = current === "" || options.includes(current);
  return (
    <Row label={label} htmlFor={id}>
      <select id={id} value={current} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)} className={`${selectClass} w-fit`}>
        {optional ? <option value="">{t("caseMap.notGiven")}</option> : null}
        {known ? null : <option value={current}>{current}</option>}
        {options.map((option) => (
          <option key={option} value={option} lang={english ? "en" : undefined}>
            {labelOf(option)}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Several lines (a procedure's steps, numbered; targets; what a program answers). */
export function Lines({ label, value, onChange, max = T.text, limit, numbered = false, addLabel }: { label: string; value: ClaimInput[]; onChange: (next: ClaimInput[]) => void; max?: number; limit: number; numbered?: boolean; addLabel: string }) {
  const { t } = useTranslation();
  const set = (index: number, text: string) => onChange(value.map((line, at) => (at === index ? { ...line, value: text } : line)));
  return (
    <Row label={label} group>
      {value.map((line, index) => (
        <div key={index} className="flex items-start gap-2">
          {numbered ? (
            <span aria-hidden="true" className="w-5 shrink-0 pt-2 text-right font-mono text-sm text-fg-muted">
              {index + 1}.
            </span>
          ) : null}
          <textarea lang="en" aria-label={`${label} ${index + 1}`} value={line.value} maxLength={max} onChange={(event) => set(index, event.target.value)} className={`${inputClass} field-sizing-content min-h-control-sm max-h-60 resize-y`} />
          <Button size="sm" aria-label={t("caseMap.removeLine", { number: index + 1 })} onClick={() => onChange(value.filter((_line, at) => at !== index))}>
            {t("caseMap.remove")}
          </Button>
        </div>
      ))}
      {value.length < limit ? (
        <div>
          <Button size="sm" onClick={() => onChange([...value, { value: "", check: null }])}>
            {addLabel}
          </Button>
        </div>
      ) : null}
    </Row>
  );
}

/** Ticks from a list (the blocks a strategy is preventive in; the strategies an entry names). */
export function Ticks({ label, value, options, onChange, english = true, minOne = false }: { label: string; value: string[]; options: ReadonlyArray<{ id: string; label: string }>; onChange: (next: string[]) => void; english?: boolean; minOne?: boolean }) {
  const { t } = useTranslation();
  return (
    <Row label={label} group>
      {options.length === 0 ? <p className="text-sm text-fg-muted">{t("planStep.form.noneYet")}</p> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(option.id)} disabled={minOne && value.length === 1 && value.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id))} />
            <span lang={english ? "en" : undefined}>{option.label}</span>
          </label>
        ))}
      </div>
    </Row>
  );
}

type ParameterIn = { label: string; role: string; value: ClaimInput | null; unit: string };

/** Structured parameters (D13): label, what it is for, value and unit. */
export function Parameters({ value, onChange }: { value: ParameterIn[]; onChange: (next: ParameterIn[]) => void }) {
  const { t } = useTranslation();
  const label = t("planStep.form.parameters");
  const set = (index: number, change: Partial<ParameterIn>) => onChange(value.map((row, at) => (at === index ? { ...row, ...change } : row)));
  return (
    <Row label={label} group>
      <p className="text-xs text-fg-muted">{t("planStep.form.parametersHint")}</p>
      {value.map((row, index) => (
        <div key={index} role="group" aria-label={`${label} ${index + 1}`} className="grid gap-2 rounded-md border border-border p-2.5 @md:grid-cols-[1.4fr_1fr_0.6fr_0.6fr_auto]">
          <input lang="en" aria-label={`${t("planStep.form.parameterLabel")} ${index + 1}`} placeholder={t("planStep.form.parameterLabel")} value={row.label} maxLength={T.name} onChange={(event) => set(index, { label: event.target.value })} className={`${inputClass} min-h-control-sm`} />
          <select aria-label={`${t("planStep.form.parameterRole")} ${index + 1}`} value={row.role} onChange={(event) => set(index, { role: event.target.value })} className={selectClass}>
            {PARAMETER_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`planStep.role.${role.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase())}` as "planStep.role.other")}
              </option>
            ))}
          </select>
          <input lang="en" aria-label={`${t("planStep.form.parameterValue")} ${index + 1}`} placeholder={t("planStep.form.parameterValue")} value={row.value?.value ?? ""} maxLength={T.short} onChange={(event) => set(index, { value: typed(event.target.value, row.value) })} className={`${inputClass} min-h-control-sm font-mono`} />
          <select aria-label={`${t("planStep.form.parameterUnit")} ${index + 1}`} value={row.unit} onChange={(event) => set(index, { unit: event.target.value })} className={selectClass}>
            {PARAMETER_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`planStep.unit.${unit === "%" ? "percent" : unit}` as "planStep.unit.other")}
              </option>
            ))}
          </select>
          <Button size="sm" aria-label={t("caseMap.removeLine", { number: index + 1 })} onClick={() => onChange(value.filter((_row, at) => at !== index))}>
            {t("caseMap.remove")}
          </Button>
        </div>
      ))}
      {value.length < MAX_PARAMETERS ? (
        <div>
          <Button size="sm" onClick={() => onChange([...value, { label: "", role: "other", value: null, unit: "s" }])}>
            {t("planStep.form.addParameter")}
          </Button>
        </div>
      ) : null}
    </Row>
  );
}

type SessionIn = { date: ClaimInput | null; correct: ClaimInput | null; opportunities: ClaimInput | null };

/** A skill's baseline sessions: correct out of opportunities, each with its percent computed by the app (D11). */
function Sessions({ value, onChange }: { value: SessionIn[]; onChange: (next: SessionIn[]) => void }) {
  const { t } = useTranslation();
  const label = t("planStep.form.sessions");
  const set = (index: number, key: keyof SessionIn, text: string) => onChange(value.map((row, at) => (at === index ? { ...row, [key]: typed(text, row[key]) } : row)));
  return (
    <Row label={label} group>
      {value.map((row, index) => {
        const percent = sessionPercent(row.correct?.value, row.opportunities?.value);
        return (
          <div key={index} role="group" aria-label={`${t("planStep.form.session")} ${index + 1}`} className="grid items-center gap-2 @md:grid-cols-[1fr_0.7fr_0.7fr_4rem_auto]">
            {(["date", "correct", "opportunities"] as const).map((key) => (
              <input
                key={key}
                lang="en"
                aria-label={`${t(`planStep.form.${key}`)} ${index + 1}`}
                placeholder={t(`planStep.form.${key}`)}
                value={row[key]?.value ?? ""}
                maxLength={T.short}
                onChange={(event) => set(index, key, event.target.value)}
                className={`${inputClass} min-h-control-sm ${key === "date" ? "" : "font-mono"}`}
              />
            ))}
            <span className="font-mono text-sm text-fg-muted tabular-nums" aria-label={t("planStep.form.sessionPercent", { number: index + 1 })}>
              {percent === null ? "–" : `${Math.round(percent)}%`}
            </span>
            <Button size="sm" aria-label={t("caseMap.removeLine", { number: index + 1 })} onClick={() => onChange(value.filter((_row, at) => at !== index))}>
              {t("caseMap.remove")}
            </Button>
          </div>
        );
      })}
      {value.length < MAX_BASELINE_SESSIONS ? (
        <div>
          <Button size="sm" onClick={() => onChange([...value, { date: null, correct: null, opportunities: { value: "10", check: null } }])}>
            {t("planStep.form.addSession")}
          </Button>
        </div>
      ) : null}
    </Row>
  );
}

/** What a form may offer: the plan's strategies (an entry names them) and the map's functions. */
export interface PlanFormContext {
  strategies: ReadonlyArray<{ id: string; label: string }>;
}

/** The fields of one part's form. */
function PlanFields({ part, value, set, context }: { part: PlanPartId; value: Values; set: (key: string, next: unknown) => void; context: PlanFormContext }) {
  const { t } = useTranslation();
  const field = (key: string) => t(`planStep.field.${key}` as "planStep.field.name");
  const functionOptions = FUNCTION_NAMES.map((name) => ({ id: name, label: FUNCTION_TITLES[name] }));
  switch (part) {
    case "strategies":
      return (
        <>
          <TextBox label={field("name")} value={value.name as Claimish} max={T.name} onChange={(next) => set("name", next)} hint={t("planStep.form.nameHint")} />
          <Choice label={field("kind")} value={value.kind as string} options={STRATEGY_KINDS} labelOf={(option) => t(`planStep.strategyKind.${option}` as "planStep.strategyKind.antecedent")} onChange={(next) => set("kind", next ?? "antecedent")} />
          {/* A preventive strategy keeps at least one block, so it never drops out of every view (finding 8). */}
          {value.kind === "antecedent" ? <Ticks label={field("functions")} value={value.functions as string[]} options={functionOptions} onChange={(next) => set("functions", next)} minOne={(value.functions as string[]).length > 0} /> : null}
          <Parameters value={value.parameters as ParameterIn[]} onChange={(next) => set("parameters", next)} />
        </>
      );
    case "interventions":
      return (
        <>
          <TextBox label={value.kind === "positive" ? "Positive" : field("management")} value={value.text as Claimish} multiline max={T.definition} onChange={(next) => set("text", next)} />
          {value.kind === "maladaptive" ? (
            <Row label={field("safetyFirst")} group>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={value.safetyFirst === true} onChange={(event) => set("safetyFirst", event.target.checked)} />
                {t("planStep.form.safetyFirst")}
              </label>
            </Row>
          ) : null}
          <Ticks label={field("strategyIds")} value={value.strategyIds as string[]} options={context.strategies} onChange={(next) => set("strategyIds", next)} />
        </>
      );
    case "programs": {
      const baseline = value.baseline as Values;
      const mastery = value.mastery as Values;
      return (
        <>
          <TextBox label={field("title")} value={value.title as Claimish} max={T.name} onChange={(next) => set("title", next)} />
          <Choice label={field("programKind")} value={value.kind as string} options={PROGRAM_KINDS} labelOf={(option) => t(`planStep.programKind.${option}` as "planStep.programKind.skill")} onChange={(next) => set("kind", next ?? "skill")} />
          {value.kind === "replacement" ? (
            <>
              <Choice label={field("function")} value={value.function as string | null} options={FUNCTION_NAMES} labelOf={(option) => FUNCTION_TITLES[option as keyof typeof FUNCTION_TITLES]} onChange={(next) => set("function", next)} optional english />
              <Choice label={field("outcome")} value={value.outcome as string | null} options={OUTCOMES} labelOf={(option) => t(`planStep.outcome.${option === "competing-activity" ? "competing" : option}` as "planStep.outcome.other")} onChange={(next) => set("outcome", next)} optional />
            </>
          ) : null}
          <Choice label={field("area")} value={value.area as string | null} options={PROGRAM_AREAS} labelOf={(option) => t(`planStep.area.${option.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase())}` as "planStep.area.other")} onChange={(next) => set("area", next)} optional />
          <TextBox label={field("definition")} value={value.definition as Claimish} multiline max={T.definition} onChange={(next) => set("definition", next)} />
          <Lines label={field("procedure")} value={value.procedure as ClaimInput[]} limit={MAX_PROGRAM_STEPS} numbered addLabel={t("planStep.form.addStep")} onChange={(next) => set("procedure", next)} />
          <Lines label={field("targets")} value={value.targets as ClaimInput[]} max={T.name} limit={MAX_PROGRAM_TARGETS} addLabel={t("planStep.form.addTarget")} onChange={(next) => set("targets", next)} />
          <Choice label={field("measure")} value={value.measure as string} options={PROGRAM_MEASURES} labelOf={(option) => t(`planStep.measure.${option === "percent-opportunities" ? "percent" : option === "task-analysis-steps" ? "taskAnalysis" : "duration"}` as "planStep.measure.percent")} onChange={(next) => set("measure", next ?? "percent-opportunities")} />
          <Sessions value={baseline.sessions as SessionIn[]} onChange={(next) => set("baseline", { ...baseline, sessions: next })} />
          <TextBox label={field("caregiverReport")} value={baseline.caregiverReport as Claimish} multiline onChange={(next) => set("baseline", { ...baseline, caregiverReport: next })} />
          <TextBox label={field("caregiverPercent")} value={baseline.caregiverPercent as Claimish} max={T.short} onChange={(next) => set("baseline", { ...baseline, caregiverPercent: next })} />
          <TextBox label={field("baselineOverride")} value={baseline.override as Claimish} max={T.short} hint={t("planStep.form.overrideHint")} onChange={(next) => set("baseline", { ...baseline, override: next })} />
          <Choice label={field("masteryCategory")} value={mastery.category as string} options={MASTERY_CATEGORIES} labelOf={(option) => t(`planStep.mastery.${option === "street-crossing" ? "street" : option}` as "planStep.mastery.general")} onChange={(next) => set("mastery", { ...mastery, category: next ?? "general" })} />
          <TextBox label={field("masteryOverride")} value={mastery.override as Claimish} max={T.short} hint={t("planStep.form.overrideHint")} onChange={(next) => set("mastery", { ...mastery, override: next })} />
          <Parameters value={value.parameters as ParameterIn[]} onChange={(next) => set("parameters", next)} />
        </>
      );
    }
    case "glossary":
      return (
        <>
          <TextBox label={field("definitionSentence")} value={value.definition as Claimish} multiline onChange={(next) => set("definition", next)} />
          <TextBox label={field("implementation")} value={value.implementation as Claimish} multiline max={T.definition} hint={t("planStep.form.implementationHint")} onChange={(next) => set("implementation", next)} />
        </>
      );
    case "caregiverGoals":
      return (
        <>
          <TextBox label={field("title")} value={value.title as Claimish} max={T.name} onChange={(next) => set("title", next)} />
          <Choice label={field("goalKind")} value={value.kind as string} options={CAREGIVER_GOAL_KINDS} labelOf={(option) => t(`planStep.goalKind.${option}` as "planStep.goalKind.extra")} onChange={(next) => set("kind", next ?? "extra")} />
          <TextBox label={field("procedure")} value={value.procedure as Claimish} multiline max={T.definition} onChange={(next) => set("procedure", next)} />
          <Choice label={field("baselinePercent")} value={(value.baselinePercent as Claimish)?.value ?? null} options={["0", "10", "20"]} labelOf={(option) => `${option}%`} onChange={(next) => set("baselinePercent", next === null ? null : { value: next, check: null })} optional />
          <TextBox label={field("masteryOverride")} value={value.masteryOverride as Claimish} max={T.short} hint={t("planStep.form.overrideHint")} onChange={(next) => set("masteryOverride", next)} />
        </>
      );
    default:
      return null;
  }
}

/**
 * One plan item's form, saved as she types. The form's text is its fields as JSON, so the
 * autosave and the kept-text paths of the map's items serve it as they are.
 */
export function PlanItemForm<P extends PlanPartId>({
  caseId,
  part,
  item,
  data,
  context,
  onDone,
  title,
  autoFocus = false,
}: {
  caseId: string;
  part: P;
  item: PlanItemByPart[P];
  data: Pick<PlanData, "accept" | "editingFor">;
  context: PlanFormContext;
  onDone?: () => void;
  title: string;
  /** The form takes the focus when it opens, on its first field (review of PR 1, finding 6). */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [initial] = useState(() => JSON.stringify(planInput(part, item)));
  const { accept, editingFor } = data;
  const save = useCallback(
    async (text: string) => {
      const result = await window.aba.saveMapItem(caseId, part, "items", item.id, text, editingFor(part)).catch(() => null);
      return accept(result, part);
    },
    [accept, caseId, editingFor, item.id, part],
  );
  const box = useAutosave({ caseId, initial, save });
  const mapItem = `${part}/items/${item.id}`;
  const ready = useKeptText(box, useCallback((failed: FailedSave) => failed.about === "map" && failed.caseId === caseId && failed.mapItem === mapItem, [caseId, mapItem]));
  const value = useMemo(() => {
    try {
      return JSON.parse(box.value) as Values;
    } catch {
      return JSON.parse(initial) as Values;
    }
  }, [box.value, initial]);
  const set = (key: string, next: unknown) => box.setValue(JSON.stringify({ ...value, [key]: next }));
  const sectionRef = useRef<HTMLElement | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || !ready || focused.current) return;
    focused.current = true;
    sectionRef.current?.querySelector<HTMLElement>("fieldset input, fieldset textarea, fieldset select")?.focus();
  }, [autoFocus, ready]);
  return (
    <section ref={sectionRef} aria-label={t("planStep.form.editing", { name: title })} data-testid="plan-form" className="@container flex flex-col gap-3 rounded-md border border-accent bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t("planStep.form.editing", { name: title })}</span>
        <span className="flex-1" />
        <span aria-live="polite" className="text-xs text-fg-muted">
          {box.status === "saving" ? t("sources.saving") : box.status === "saved" ? t("caseMap.saved") : ""}
        </span>
        {onDone ? (
          <Button size="sm" onClick={() => void box.flush().then((saved) => saved && onDone())}>
            {t("planStep.done")}
          </Button>
        ) : null}
      </div>
      {box.status === "failed" ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
          {t("caseMap.actionFailed")}
          <Button size="sm" onClick={() => void box.retry()}>
            {t("sources.tryAgain")}
          </Button>
        </p>
      ) : null}
      <fieldset disabled={!ready} className="contents" onBlur={() => void box.flush()}>
        <PlanFields part={part} value={value} set={set} context={context} />
      </fieldset>
    </section>
  );
}
