import type { TFunction } from "i18next";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PlanFinding } from "../../../shared/plan-checks.ts";
import { FUNCTION_TITLES } from "../../../shared/plan-copy.ts";
import { decisionOf, type DecidedPart, type PlanDecisionFields, type PlanItemByPart, type PlanParameter } from "../../../shared/plan.ts";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { StatusBadge, type StatusTone } from "../components/StatusBadge.tsx";
import type { PlanData } from "./data.ts";
import { PlanItemForm, type PlanFormContext } from "./forms.tsx";

/*
 * A plan item on screen (the Plan step's D2 to D4): its state in words ("Propuesta",
 * "Aceptada", "Corregida por ti", "Escrita por ti"), its checks before QA, and its actions:
 * Aceptar (a proposal), Editar (in place, saved as she types: it accepts the item), Rechazar
 * (it moves under "Rechazadas", where Recuperar brings it back undecided).
 */

export type DecisionLook = "proposed" | "accepted" | "corrected" | "hers" | "rejected";

export function decisionLook(item: PlanDecisionFields): DecisionLook {
  const decision = decisionOf(item);
  if (decision === "rejected") return "rejected";
  if (decision === "proposed") return "proposed";
  if (item.by === "her") return "hers";
  return item.editedAt ? "corrected" : "accepted";
}

const TONES: Record<DecisionLook, StatusTone> = { proposed: "accent", accepted: "success", corrected: "success", hers: "success", rejected: "neutral" };

export function DecisionChip({ item }: { item: PlanDecisionFields }) {
  const { t } = useTranslation();
  const look = decisionLook(item);
  return (
    <span data-testid="plan-decision" data-decision={look}>
      <StatusBadge tone={TONES[look]}>{t(`planStep.decision.${look}`)}</StatusBadge>
    </span>
  );
}

/** A parameter as one short line: "Wait before prompting: 5 s". */
export function parameterLine(t: TFunction, parameter: PlanParameter): string {
  const unit = parameter.unit === "other" || parameter.unit === "count" ? "" : ` ${parameter.unit}`;
  const value = parameter.value?.value ?? "";
  return `${parameter.label ? `${parameter.label}: ` : ""}${value}${value === "" ? "" : unit}`.trim() || t("planStep.form.parameterEmpty");
}

/** A finding in one sentence, for the item's line, the rail and "Antes de QA". */
export function findingText(t: TFunction, finding: PlanFinding): { title: string; body: string } {
  const fn = finding.function ? FUNCTION_TITLES[finding.function] : "";
  const key = `planStep.finding.${finding.kind.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase())}`;
  const values: Record<string, unknown> = { function: fn };
  switch (finding.kind) {
    case "prompt-before-latency":
      Object.assign(values, { behavior: finding.behaviorName, item: finding.itemName, label: finding.label || finding.itemName, seconds: finding.seconds, latency: finding.latency });
      break;
    case "delivery-before-offset":
      Object.assign(values, { behavior: finding.behaviorName, item: finding.itemName, label: finding.label || finding.itemName, seconds: finding.seconds, offset: finding.offset });
      break;
    case "proximity-beyond-elopement":
      Object.assign(values, { behavior: finding.behaviorName, item: finding.itemName, feet: finding.feet, elopement: finding.elopementFeet });
      break;
    case "no-equivalent-replacement":
      Object.assign(values, { programs: finding.programs.map((program) => program.name).join(", ") });
      break;
    case "no-management":
    case "two-management":
    case "safety-first-missing":
      Object.assign(values, { behavior: finding.unitName });
      break;
    case "aversive":
      Object.assign(values, { item: finding.itemName, term: finding.term });
      break;
    case "glossary-number":
      Object.assign(values, { item: finding.itemName, number: finding.number });
      break;
    case "few-openings":
      Object.assign(values, { distinct: finding.distinct, total: finding.total });
      break;
    case "task-analysis-steps":
      Object.assign(values, { item: finding.itemName, steps: finding.steps });
      break;
    case "baseline-not-ten":
      Object.assign(values, { item: finding.itemName, percent: finding.percent });
      break;
    default:
      if ("itemName" in finding) values.item = finding.itemName;
  }
  return { title: t(`${key}.title` as "planStep.finding.aversive.title", values), body: t(`${key}.body` as "planStep.finding.aversive.body", values) };
}

/** A finding on its item: the body says it whole for a clash, a replacement or a procedure she never uses; otherwise its title leads. */
function lineOf(t: TFunction, finding: PlanFinding): string {
  const text = findingText(t, finding);
  const whole = ["prompt-before-latency", "delivery-before-offset", "proximity-beyond-elopement", "no-equivalent-replacement", "aversive"].includes(finding.kind);
  return whole ? text.body : `${text.title}. ${text.body}`;
}

/** An item's checks before QA, as amber lines (never offering a rewrite). */
export function FindingLines({ findings }: { findings: readonly PlanFinding[] }) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="plan-item-findings">
      {findings.map((finding, index) => (
        <li key={index} className="flex items-start gap-1.5 rounded-sm bg-warning-subtle px-2 py-1 text-sm text-warning">
          <span aria-hidden="true">⚠</span>
          <span>
            {t("planStep.qaPrefix")} {lineOf(t, finding)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One item: its card, and its form in place while she edits it. */
export function ItemCard<P extends DecidedPart>({
  caseId,
  part,
  item,
  title,
  titleLang = "en",
  children,
  findings,
  data,
  context,
  startEditing = false,
  extraActions,
}: {
  caseId: string;
  part: P;
  item: PlanItemByPart[P];
  title: string;
  titleLang?: string;
  children?: ReactNode;
  findings: readonly PlanFinding[];
  data: PlanData;
  context: PlanFormContext;
  startEditing?: boolean;
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(startEditing);
  const titleId = useId();
  const look = decisionLook(item);
  const decide = (decision: "accepted" | "rejected" | "proposed") => void data.decide([{ part, itemId: item.id, decision }]);
  return (
    <article
      aria-labelledby={titleId}
      data-testid="plan-item"
      data-item={item.id}
      data-decision={look}
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3",
        look === "proposed" ? "border-dashed border-accent bg-ai-subtle" : look === "rejected" ? "border-border bg-surface-muted text-fg-muted" : "border-border border-l-4 border-l-success bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <h3 id={titleId} lang={titleLang} className="min-w-0 flex-1 text-base font-semibold break-words">
          {title}
        </h3>
        <DecisionChip item={item} />
      </div>
      {children}
      <FindingLines findings={findings} />
      {editing ? <PlanItemForm caseId={caseId} part={part} item={item} data={data} context={context} title={title} onDone={() => setEditing(false)} /> : null}
      <div className="flex flex-wrap gap-1.5">
        {look === "rejected" ? (
          <Button size="sm" onClick={() => decide("proposed")}>
            {t("planStep.recover")}
          </Button>
        ) : (
          <>
            {look === "proposed" ? (
              <Button size="sm" aria-describedby={titleId} onClick={() => decide("accepted")}>
                <Icon name="check" />
                {t("planStep.accept")}
              </Button>
            ) : null}
            {editing ? null : (
              <Button size="sm" aria-describedby={titleId} onClick={() => setEditing(true)}>
                <Icon name="pencil" />
                {t("planStep.edit")}
              </Button>
            )}
            <Button size="sm" aria-describedby={titleId} onClick={() => decide("rejected")}>
              {t("planStep.reject")}
            </Button>
            {extraActions}
          </>
        )}
      </div>
    </article>
  );
}

/** "Rechazadas (n)": the rejected items of a view, folded, each with Recuperar (D4). */
export function RejectedList({ children, count }: { children: ReactNode; count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <details data-testid="plan-rejected" className="rounded-md border border-border bg-surface px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold text-fg-muted">{t("planStep.rejected", { count })}</summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}
