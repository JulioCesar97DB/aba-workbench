import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { FUNCTION_NAMES, type ClientItem, type FunctionName } from "../../../shared/case-map.ts";
import { FINDING_GROUPS, findingGroup, findingItems, planChecks, type PlanFinding, type PlanViewId } from "../../../shared/plan-checks.ts";
import { ageInYears, byName, caregiverBaseline, caregiverMastery, masteryPercent, programTarget, skillBaseline } from "../../../shared/plan-compute.ts";
import { baselineSentence, FUNCTION_TITLES, isCopied, planCopy, undecidedCount } from "../../../shared/plan-copy.ts";
import {
  DECIDED_PARTS,
  HBI_INTRO_DRAFT,
  blockContent,
  decisionOf,
  entryCovers,
  functionBlocks,
  inNoBlock,
  isRejected,
  viewItems,
  planMapInputOf,
  type DecidedPart,
  type FunctionBlock,
  type PlanItemByPart,
  type PlanView,
} from "../../../shared/plan.ts";
import type { FailedSave } from "../../../shared/sources.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import { CASE_STEPS, casePath, stepTitle } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { TextLink } from "../components/Link.tsx";
import { NextStepCard } from "../components/NextStepCard.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { useOpenedCase } from "../open-case.tsx";
import { CopyList, CopyPreview, useCopyFields } from "../plan/copy.tsx";
import { usePlanData, type PlanData } from "../plan/data.ts";
import { planInput, type PlanFormContext } from "../plan/forms.tsx";
import { DecisionChip, findingText, ItemCard, parameterLine, RejectedList } from "../plan/items.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

/*
 * Step 3 of a case: the plan (the Plan step's proposal, accepted whole on 2026-11-28; PR 1,
 * by hand). She builds her plan from the approved case map, in her order: one block per
 * function (computed by code from the map, D7), the replacement and skill programs, the
 * Interventions glossary and the caregiver goals (D9). Every item is decided one by one
 * (D2): Aceptar, Editar (which accepts it, D3), Rechazar (D4), and "Aceptar lo que queda"
 * per view. Code computes the counts, baselines and mastery (D10 to D13), runs the checks
 * before QA (D19 to D21, "Antes de QA") and renders the plain text of each ABA Matrix field
 * ("Copiar para ABA Matrix", D22, D23). The AI's way ("Con la IA") comes in PR 2.
 *
 * Views, by the address's ?view=: "fn:<function>", "programs", "glossary", "goals",
 * "checks", "copy"; none, while the plan is empty, shows its two ways.
 */

type View = PlanViewId | "checks" | "copy" | "start";

function isView(value: string | null): value is Exclude<View, "start"> {
  if (value === null) return false;
  if (value.startsWith("fn:")) return (FUNCTION_NAMES as readonly string[]).includes(value.slice(3));
  return ["programs", "glossary", "goals", "checks", "copy"].includes(value);
}

type Entry = ReturnType<typeof viewItems>[number];

/** The items a view decides (src/shared/plan.ts). */
const viewEntries = (plan: PlanView, view: View): Entry[] => viewItems(plan, view);

function counts(entries: readonly Entry[]) {
  const live = entries.filter((entry) => !isRejected(entry.item));
  const proposed = entries.filter((entry) => decisionOf(entry.item) === "proposed");
  return { total: entries.length, decided: entries.length - proposed.length, proposed, live: live.length };
}

const strategyName = (item: { name: { value: string } | null; id: string }) => item.name?.value.trim() || item.id;
const programName = (item: { title: { value: string } | null; id: string }) => item.title?.value.trim() || item.id;

export function PlanScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const data = usePlanData(caseId);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [fresh, setFresh] = useState<string | null>(null);
  const state = data.state;

  const derived = useMemo(() => {
    if (state.status !== "ready") return null;
    const mapInput = planMapInputOf(state.map);
    const blocks = functionBlocks(mapInput);
    const hbiIntro = state.instructions.hbiIntro?.text ?? null;
    const findings = planChecks({ plan: state.plan, map: mapInput, hbiIntro });
    const groups = planCopy({ plan: state.plan, map: mapInput, hbiIntro });
    const client = state.map.parts.client.items[0] as unknown as ClientItem | undefined;
    const hasPlan = DECIDED_PARTS.some((part) => state.plan.parts[part].items.length > 0);
    return { mapInput, blocks, findings, groups, client, hasPlan };
  }, [state]);

  const param = params.get("view");
  const view: View = isView(param) ? param : derived?.hasPlan ? (derived.blocks[0] ? `fn:${derived.blocks[0].function}` : "programs") : "start";
  const selectedItem = params.get("item");
  const go = useCallback((next: View, item?: string | null) => setParams(next === "start" ? {} : item ? { view: next, item } : { view: next }), [setParams]);

  // An item named in the address ("Ver" in Antes de QA) is brought into view.
  useEffect(() => {
    if (!selectedItem) return;
    document.querySelector(`[data-item="${CSS.escape(selectedItem)}"]`)?.scrollIntoView({ block: "center" });
  }, [selectedItem, view, state.status]);

  const position = t("steps.position", { number: CASE_STEPS.indexOf("interventions") + 1, total: CASE_STEPS.length });

  if (state.status !== "ready" || !derived) {
    return (
      <WorkArea header={<StepHeader eyebrow={position} title={stepTitle(t, "interventions")} />}>
        {state.status === "failed" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-md">
              {t("planStep.loadFailed")}
            </p>
            <Button onClick={() => void data.load()}>{t("home.retry")}</Button>
          </div>
        ) : (
          <p className="text-md text-fg-muted">{t("planStep.loading")}</p>
        )}
      </WorkArea>
    );
  }

  const { plan, map, instructions } = state;
  const { blocks, findings, groups, client } = derived;
  const entries = viewEntries(plan, view);
  const viewCounts = counts(entries);
  const viewFindings = findings.filter((finding) => finding.view === view);
  const context: PlanFormContext = { strategies: plan.parts.strategies.items.filter((item) => !isRejected(item)).map((item) => ({ id: item.id, label: strategyName(item) })) };
  const findingsOf = (id: string) => findings.filter((finding) => findingItems(finding).some((ref) => ref.id === id));
  const target = programTarget({ ageYears: ageInYears(client?.age?.value, opened.clientAge), hoursText: plan.parts.planInputs.items[0]?.weeklyHours?.value, overrideText: plan.parts.planInputs.items[0]?.targetOverride?.value });
  const add = async <P extends DecidedPart>(part: P, input: Record<string, unknown>, then?: View) => {
    const id = await data.add(part, input);
    if (!id) return;
    setFresh(id);
    if (then) go(then, id);
  };
  const behaviorsApproved = map.parts.behaviors.status === "approved";

  // The header: the view's name, how far it is, and "Aceptar lo que queda".
  const title =
    view === "start"
      ? stepTitle(t, "interventions")
      : view.startsWith("fn:")
        ? FUNCTION_TITLES[view.slice(3) as FunctionName]
        : t(`planStep.view.${view as "programs"}`);
  const copiedCount = groups.flatMap((group) => group.fields).filter((field) => isCopied(plan, field)).length;
  const fieldCount = groups.flatMap((group) => group.fields).length;
  const chip =
    view === "start" ? (
      <StatusBadge>{t("status.notStarted")}</StatusBadge>
    ) : view === "checks" ? (
      <StatusBadge tone={findings.length > 0 ? "warning" : "success"}>{t("planStep.checks.count", { count: findings.length })}</StatusBadge>
    ) : view === "copy" ? (
      <StatusBadge tone={fieldCount > 0 && copiedCount === fieldCount ? "success" : "neutral"}>{t("planStep.copy.count", { copied: copiedCount, total: fieldCount })}</StatusBadge>
    ) : viewCounts.total > 0 ? (
      <span data-testid="plan-view-count">
        <StatusBadge tone={viewCounts.proposed.length > 0 ? "accent" : "success"}>{t("planStep.decidedCount", { decided: viewCounts.decided, total: viewCounts.total })}</StatusBadge>
      </span>
    ) : null;
  const acceptRest =
    viewCounts.proposed.length > 0 ? (
      <Button variant="primary" data-testid="plan-accept-rest" onClick={() => void data.decide(viewCounts.proposed.map((entry) => ({ part: entry.part, itemId: entry.item.id, decision: "accepted" as const })), true)}>
        <Icon name="check" />
        {t("planStep.acceptRest", { count: viewCounts.proposed.length })}
      </Button>
    ) : null;
  // "Paso 3 de 5" while the plan is empty (its title is "Plan"); "Paso 3 de 5 · Plan" over a view's name.
  const eyebrow = view === "start" ? position : `${position} · ${stepTitle(t, "interventions")}`;
  const header = <StepHeader eyebrow={eyebrow} title={title} titleLang={view.startsWith("fn:") ? "en" : undefined} chip={chip} primary={acceptRest} />;

  const next = nextStep(t, plan, blocks, view, findings.length);
  const rail = (
    <>
      {view !== "checks" && view !== "copy" && view !== "start" ? <QaRail t={t} findings={viewFindings} view={view} title={title} onSee={(finding) => go(finding.view, findingItems(finding)[0]?.id ?? null)} /> : null}
      {view === "start" ? <BeforeRail map={map} /> : null}
      {view === "start" || view === "programs" ? <CountRail caseId={caseId} data={data} plan={plan} target={target} programs={plan.parts.programs.items.filter((item) => !isRejected(item)).length} /> : null}
      {view.startsWith("fn:") || view === "copy" || view === "start" ? <IntroRail instructions={instructions} onSaved={data.setInstructions} /> : null}
      {view === "start" || view.startsWith("fn:") ? <PlanInstructionsRail caseId={caseId} text={instructions.text} onSaved={(text) => data.setInstructions({ ...instructions, text })} /> : null}
      {view === "checks" ? <ChecksRail /> : null}
      {view === "copy" ? <CopyRail undecided={undecidedCount(plan)} findings={findings.length} markers={groups.flatMap((group) => group.fields).reduce((sum, field) => sum + field.markers, 0)} /> : null}
      <NextStepCard name={next.name} nameLang={next.nameLang} body={next.body} to={next.to ? (next.to === "/report" ? casePath(caseId, "report") : `${casePath(caseId, "interventions")}?view=${next.to}`) : undefined} action={next.action} primary={next.primary} />
    </>
  );

  const aiSoon = (
    <span data-testid="plan-ai-soon" className="inline-flex items-center rounded-sm border border-dashed border-accent px-2 py-0.5 text-sm font-medium text-fg-on-accent-subtle">
      {t("planStep.aiNext")}
    </span>
  );

  return (
    <WorkArea header={header} rail={rail} railLabel={t("planStep.railLabel")} railCount={view === "checks" || view === "copy" ? null : viewFindings.length}>
      <div className="flex flex-col gap-4">
        {data.actionFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("caseMap.actionFailed")}
          </p>
        ) : null}
        {view === "start" ? (
          <StartView
            t={t}
            caseId={caseId}
            blocks={blocks}
            behaviorsApproved={behaviorsApproved}
            aiSoon={aiSoon}
            onStart={(fn) => go(`fn:${fn}`)}
            onProgram={() => void add("programs", { kind: "skill" }, "programs")}
          />
        ) : (
          <>
            <TwoWays layout="bar" active="hand" hand={{ body: t(`planStep.hand.${view.startsWith("fn:") ? "function" : (view as "programs")}`) }} ai={{ body: t("planStep.aiBar") }} />
            <ViewTabs t={t} plan={plan} blocks={blocks} view={view} findings={findings.length} copied={copiedCount} fields={fieldCount} onGo={(next) => go(next)} />
            {!behaviorsApproved && view.startsWith("fn:") ? <p className="text-sm text-warning">{t("planStep.behaviorsNotApproved")}</p> : null}
            {view.startsWith("fn:") ? (
              <FunctionView
                key={view}
                caseId={caseId}
                fn={view.slice(3) as FunctionName}
                block={blocks.find((block) => block.function === view.slice(3)) ?? null}
                plan={plan}
                data={data}
                context={context}
                fresh={fresh}
                findingsOf={findingsOf}
                onAdd={add}
                onOpenProgram={(id) => go("programs", id)}
              />
            ) : null}
            {view === "programs" ? (
              <ProgramsView caseId={caseId} plan={plan} data={data} context={context} fresh={fresh} selected={selectedItem} target={target.target} findingsOf={findingsOf} onSelect={(id) => go("programs", id)} onAdd={add} />
            ) : null}
            {view === "glossary" ? <GlossaryView caseId={caseId} plan={plan} data={data} context={context} fresh={fresh} findingsOf={findingsOf} onAdd={add} /> : null}
            {view === "goals" ? <GoalsView caseId={caseId} plan={plan} data={data} context={context} fresh={fresh} findingsOf={findingsOf} onAdd={add} /> : null}
            {view === "checks" ? <ChecksView t={t} findings={findings} onSee={(finding) => go(finding.view, findingItems(finding)[0]?.id ?? null)} /> : null}
            {view === "copy" ? <CopyView caseId={caseId} plan={plan} groups={groups} data={data} undecided={undecidedCount(plan)} onReport={() => navigate(casePath(caseId, "report"))} /> : null}
          </>
        )}
      </div>
    </WorkArea>
  );
}

/** "Siguiente paso": the first view with items to decide; then the checks, the copy, and the report. */
function nextStep(t: TFunction, plan: PlanView, blocks: readonly FunctionBlock[], view: View, findings: number): { name: string; nameLang?: string; body: string; to?: string; action?: string; primary: boolean } {
  // The plan empty: after it, the report (mockup 01).
  if (view === "start") return { name: stepTitle(t, "report"), body: t("planStep.next.report"), to: "/report", action: t("planStep.next.toReport"), primary: false };
  const views: View[] = [...blocks.map((block) => `fn:${block.function}` as View), "programs", "glossary", "goals"];
  for (const candidate of views) {
    if (candidate === view) continue;
    const left = counts(viewEntries(plan, candidate)).proposed.length;
    if (left === 0) continue;
    const name = candidate.startsWith("fn:") ? FUNCTION_TITLES[candidate.slice(3) as FunctionName] : t(`planStep.view.${candidate as "programs"}`);
    return { name, nameLang: candidate.startsWith("fn:") ? "en" : undefined, body: t("planStep.next.left", { count: left, name }), to: candidate, action: t("planStep.next.go", { name }), primary: counts(viewEntries(plan, view)).proposed.length === 0 };
  }
  if (view !== "checks" && view !== "copy" && findings > 0) return { name: t("planStep.view.checks"), body: t("planStep.next.checks", { count: findings }), to: "checks", action: t("planStep.next.toChecks"), primary: false };
  if (view !== "copy") return { name: t("planStep.view.copy"), body: t("planStep.next.copy"), to: "copy", action: t("planStep.next.toCopy"), primary: true };
  return { name: stepTitle(t, "report"), body: t("planStep.next.report"), to: "/report", action: t("planStep.next.toReport"), primary: true };
}

/** The plan's views: one tab per function block (a function with no behavior is dashed), then programs, glossary, goals, checks and copy. */
function ViewTabs({ t, plan, blocks, view, findings, copied, fields, onGo }: { t: TFunction; plan: PlanView; blocks: readonly FunctionBlock[]; view: View; findings: number; copied: number; fields: number; onGo: (view: View) => void }) {
  const present = new Set(blocks.map((block) => block.function));
  // Every function has its tab; one with no behavior of the map is dashed, "sin conductas" (proposal §2.1; review nit 13).
  const functions = FUNCTION_NAMES;
  const tab = (id: View, label: ReactNode, detail: string | null, lang?: string, dashed = false) => (
    <li key={id}>
      <button
        type="button"
        aria-current={view === id ? "page" : undefined}
        data-view={id}
        onClick={() => onGo(id)}
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
          view === id ? "border-accent bg-ai-subtle font-semibold" : "border-border-control bg-surface hover:bg-surface-muted",
          dashed && "border-dashed text-fg-muted",
        )}
      >
        <span lang={lang}>{label}</span>
        {detail ? <span className="font-mono text-xs text-fg-muted tabular-nums">{detail}</span> : null}
      </button>
    </li>
  );
  const of = (id: View) => {
    const c = counts(viewEntries(plan, id));
    return c.total > 0 ? `${c.decided}/${c.total}` : null;
  };
  return (
    <nav aria-label={t("planStep.tabsLabel")}>
      <ul className="flex flex-wrap gap-1.5">
        {functions.map((fn) => tab(`fn:${fn}`, FUNCTION_TITLES[fn], present.has(fn) ? of(`fn:${fn}`) : t("planStep.noBehaviors"), "en", !present.has(fn)))}
        {tab("programs", t("planStep.view.programs"), of("programs"))}
        {tab("glossary", t("planStep.view.glossary"), of("glossary"))}
        {tab("goals", t("planStep.view.goals"), of("goals"))}
        {tab("checks", t("planStep.view.checks"), String(findings))}
        {tab("copy", t("planStep.view.copy"), fields > 0 ? `${copied}/${fields}` : null)}
      </ul>
    </nav>
  );
}

/** The plan empty: the two ways as cards, and what the plan will use from her map. */
function StartView({ t, caseId, blocks, behaviorsApproved, aiSoon, onStart, onProgram }: { t: TFunction; caseId: string; blocks: readonly FunctionBlock[]; behaviorsApproved: boolean; aiSoon: ReactNode; onStart: (fn: FunctionName) => void; onProgram: () => void }) {
  const headingId = useId();
  const first = blocks[0]?.function ?? null;
  return (
    <>
      <p className="max-w-reading text-md">
        <TransWithTerms i18nKey="planStep.intro" />
      </p>
      <TwoWays
        layout="cards"
        hand={{
          title: t("planStep.handTitle"),
          body: t("planStep.handBody"),
          actions: (
            <>
              {first ? <Button onClick={() => onStart(first)}>{t("planStep.startWith", { name: FUNCTION_TITLES[first] })}</Button> : null}
              <Button onClick={onProgram}>{t("planStep.addProgram")}</Button>
            </>
          ),
        }}
        ai={{ title: t("planStep.aiTitle"), body: t("planStep.aiBody"), actions: aiSoon }}
      />
      <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <h2 id={headingId} className="text-md font-semibold">
          {t("planStep.fromMap")}
        </h2>
        {blocks.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {t("planStep.noFunctions")} <TextLink to={casePath(caseId, "case-map")}>{t("planStep.toMap")}</TextLink>
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-2xs tracking-eyebrow text-fg-muted uppercase">
                <th className="py-1.5 pr-3 font-semibold">{t("planStep.functionColumn")}</th>
                <th className="py-1.5 font-semibold">{t("planStep.behaviorsColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((block) => (
                <tr key={block.function} className="border-b border-border last:border-b-0">
                  <th scope="row" lang="en" className="py-1.5 pr-3 text-left font-medium">
                    {FUNCTION_TITLES[block.function]}
                  </th>
                  <td lang="en" className="py-1.5">
                    {block.behaviors.map((behavior) => behavior.name).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-fg-muted">{behaviorsApproved ? t("planStep.fromMapNote") : t("planStep.behaviorsNotApproved")}</p>
      </section>
    </>
  );
}

type AddFn = <P extends DecidedPart>(part: P, input: Record<string, unknown>, then?: View) => Promise<void>;

interface ViewProps {
  caseId: string;
  plan: PlanView;
  data: PlanData;
  context: PlanFormContext;
  fresh: string | null;
  findingsOf: (id: string) => PlanFinding[];
  onAdd: AddFn;
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <Eyebrow className="text-fg-muted">{title}</Eyebrow>
      {children}
    </section>
  );
}

function Params({ parameters }: { parameters: PlanItemByPart["strategies"]["parameters"] }) {
  const { t } = useTranslation();
  if (parameters.length === 0) return null;
  return (
    <p lang="en" className="font-mono text-sm text-fg-muted">
      {parameters.map((parameter) => parameterLine(t, parameter)).join(", ")}
    </p>
  );
}

/** A function's block: its behaviors (from the map), then preventive, replacement and management columns. */
function FunctionView({ fn, block, onOpenProgram, ...props }: ViewProps & { fn: FunctionName; block: FunctionBlock | null; onOpenProgram: (id: string) => void }) {
  const { t } = useTranslation();
  const { caseId, plan, data, context, fresh, findingsOf, onAdd } = props;
  const content = blockContent(plan, fn);
  const rejected = viewEntries(plan, `fn:${fn}`).filter((entry) => isRejected(entry.item));
  const units = block?.units ?? [];
  const card = (entry: Entry, body: ReactNode, title: string, extra?: ReactNode) => (
    <ItemCard key={entry.item.id} caseId={caseId} part={entry.part} item={entry.item} title={title} findings={findingsOf(entry.item.id)} data={data} context={context} startEditing={fresh === entry.item.id} extraActions={extra}>
      {body}
    </ItemCard>
  );
  const entryTitle = (entry: PlanItemByPart["interventions"]) =>
    entry.kind === "positive" ? "Positive" : (units.find((unit) => entryCovers(entry, unit))?.name ?? entry.behaviorIds.map((id) => block?.behaviors.find((behavior) => behavior.id === id)?.name ?? id).join("; ")) || t("planStep.untitled");
  return (
    <>
      <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
        <span className="mr-2 text-2xs font-semibold tracking-eyebrow text-fg-muted uppercase" lang="en">
          Behaviors
        </span>
        {block ? (
          <span lang="en" data-testid="plan-block-behaviors">
            {block.behaviors.map((behavior) => behavior.name).join(" · ")}
          </span>
        ) : (
          <span>{t("planStep.noBehaviorsLong")}</span>
        )}{" "}
        <span className="text-fg-muted">{t("planStep.fromYourMap")}</span>
      </p>
      <div className="grid items-start gap-4 @4xl:grid-cols-3">
        <Column title={t("planStep.columns.preventive")}>
          {content.preventive.map((item) => card({ part: "strategies", item }, <Params parameters={item.parameters} />, strategyName(item)))}
          <div>
            <Button size="sm" onClick={() => void onAdd("strategies", { kind: "antecedent", functions: [fn] })}>
              {t("planStep.addPreventive")}
            </Button>
          </div>
        </Column>
        <Column title={t("planStep.columns.replacement")}>
          {content.replacements.map((item) =>
            card(
              { part: "programs", item },
              <p className="text-sm text-fg-muted">{item.outcome ? t(`planStep.outcome.${item.outcome === "competing-activity" ? "competing" : (item.outcome as "other")}`) : t("planStep.noOutcome")}</p>,
              programName(item),
              <Button size="sm" onClick={() => onOpenProgram(item.id)}>
                {t("planStep.openProgram")}
              </Button>,
            ),
          )}
          <div>
            <Button size="sm" onClick={() => void onAdd("programs", { kind: "replacement", function: fn }, "programs")}>
              {t("planStep.addReplacement")}
            </Button>
          </div>
        </Column>
        <Column title={t("planStep.columns.management")}>
          {content.positive.map((item) => card({ part: "interventions", item }, <p lang="en" className="text-sm whitespace-pre-wrap">{item.text?.value}</p>, "Positive"))}
          {content.positive.length === 0 ? (
            <div>
              <Button size="sm" onClick={() => void onAdd("interventions", { function: fn, kind: "positive" })}>
                {t("planStep.addPositive")}
              </Button>
            </div>
          ) : null}
          {units.map((unit) => {
            const covering = content.maladaptive.filter((entry) => entryCovers(entry, unit));
            if (covering.length > 0)
              return covering.map((item) =>
                card(
                  { part: "interventions", item },
                  <>
                    {item.safetyFirst ? (
                      <p>
                        <StatusBadge tone="warning">{t("planStep.safetyFirst")}</StatusBadge>
                      </p>
                    ) : null}
                    <p lang="en" className="text-sm whitespace-pre-wrap">
                      {item.text?.value}
                    </p>
                  </>,
                  entryTitle(item),
                ),
              );
            return (
              <div key={unit.key} data-testid="plan-missing-entry" className="flex flex-col items-start gap-1.5 rounded-md border border-dashed border-border-control p-3">
                <p className="text-sm">
                  <span lang="en" className="font-semibold">
                    {unit.name}
                  </span>
                  {unit.dangerous ? ` · ${t("planStep.dangerous")}` : null}
                </p>
                <Button size="sm" onClick={() => void onAdd("interventions", { function: fn, kind: "maladaptive", behaviorIds: unit.behaviorIds, groupId: unit.groupId, safetyFirst: unit.dangerous })}>
                  {t("planStep.addManagement")}
                </Button>
              </div>
            );
          })}
          {content.maladaptive
            .filter((entry) => !units.some((unit) => entryCovers(entry, unit)))
            .map((item) => card({ part: "interventions", item }, <p lang="en" className="text-sm whitespace-pre-wrap">{item.text?.value}</p>, entryTitle(item)))}
        </Column>
      </div>
      <RejectedList count={rejected.length}>
        {rejected.map((entry) =>
          card(entry, null, entry.part === "strategies" ? strategyName(entry.item as PlanItemByPart["strategies"]) : entry.part === "programs" ? programName(entry.item as PlanItemByPart["programs"]) : entryTitle(entry.item as PlanItemByPart["interventions"])),
        )}
      </RejectedList>
    </>
  );
}

/** A program in full: what it is, its definition, numbered procedure, targets, baseline and mastery, computed by the app. */
function ProgramBody({ program }: { program: PlanItemByPart["programs"] }) {
  const { t } = useTranslation();
  const baseline = skillBaseline(program.baseline);
  const mastery = masteryPercent(program.mastery.category, program.mastery.override?.value);
  const steps = program.procedure.filter((step) => step.value.trim() !== "");
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="flex flex-wrap gap-1.5">
        <StatusBadge>{t(`planStep.programKind.${program.kind === "replacement" ? "replacement" : "skill"}`)}</StatusBadge>
        {program.function ? (
          <StatusBadge>
            <span lang="en">{FUNCTION_TITLES[program.function as FunctionName] ?? program.function}</span>
          </StatusBadge>
        ) : null}
        {program.outcome ? <StatusBadge>{t(`planStep.outcome.${program.outcome === "competing-activity" ? "competing" : (program.outcome as "other")}`)}</StatusBadge> : null}
      </p>
      {program.definition?.value ? (
        <p lang="en" className="whitespace-pre-wrap">
          {program.definition.value}
        </p>
      ) : null}
      {steps.length > 0 ? (
        <ol lang="en" className="list-decimal pl-6">
          {steps.map((step, index) => (
            <li key={index}>{step.value}</li>
          ))}
        </ol>
      ) : null}
      {program.targets.length > 0 ? (
        <p lang="en">
          <span className="text-fg-muted">{t("planStep.field.targets")}: </span>
          {program.targets.map((target) => target.value).join("; ")}
        </p>
      ) : null}
      {baseline.sessions.length > 0 ? (
        <table className="w-fit text-sm">
          <thead>
            <tr className="text-left text-2xs tracking-eyebrow text-fg-muted uppercase">
              <th className="pr-4 font-semibold">{t("planStep.form.session")}</th>
              <th className="pr-4 font-semibold">{t("planStep.form.correct")}</th>
              <th className="pr-4 font-semibold">{t("planStep.form.opportunities")}</th>
              <th className="font-semibold">%</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {program.baseline.sessions.map((session, index) => (
              <tr key={index}>
                <td className="pr-4">{session.date?.value || index + 1}</td>
                <td className="pr-4">{session.correct?.value ?? ""}</td>
                <td className="pr-4">{session.opportunities?.value ?? ""}</td>
                <td>{baseline.sessions[index] === null ? "–" : `${Math.round(baseline.sessions[index]!)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p data-testid="plan-baseline">
        <span lang="en" className="font-medium">
          {baselineSentence(program)}
        </span>{" "}
        <span className="text-fg-muted">{t(`planStep.baselineSource.${baseline.source}`)}</span>
      </p>
      <p data-testid="plan-mastery">
        {t("planStep.masteryLine", { percent: mastery.percent })} <span className="text-fg-muted">{mastery.source === "override" ? t("planStep.yours") : t("planStep.byCategory")}</span>
      </p>
      <Params parameters={program.parameters} />
    </div>
  );
}

/** The programs: replacements then skills, "n de ~target", and the one chosen in full. */
function ProgramsView({ selected, target, onSelect, ...props }: ViewProps & { selected: string | null; target: number; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const { caseId, plan, data, context, fresh, findingsOf, onAdd } = props;
  const programs = plan.parts.programs.items;
  const live = programs.filter((item) => !isRejected(item));
  const chosen = programs.find((item) => item.id === selected) ?? live[0] ?? null;
  const rejected = programs.filter(isRejected);
  const list = (kind: "replacement" | "skill") => {
    const items = live.filter((item) => (kind === "replacement" ? item.kind === "replacement" : item.kind !== "replacement"));
    return (
      <section className="flex flex-col gap-1.5">
        <Eyebrow className="text-fg-muted">{t(`planStep.programsList.${kind}`, { count: items.length })}</Eyebrow>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-program={item.id}
                aria-current={chosen?.id === item.id ? "true" : undefined}
                onClick={() => onSelect(item.id)}
                className={cn("flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm", chosen?.id === item.id ? "border-accent bg-ai-subtle" : "border-border bg-surface hover:bg-surface-muted")}
              >
                <span lang="en" className="min-w-0 flex-1 break-words">
                  {programName(item)}
                </span>
                <DecisionChip item={item} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  };
  return (
    <div className="grid items-start gap-5 @3xl:grid-cols-[16rem_1fr]">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold" data-testid="plan-program-count">
          {t("planStep.programsCount", { count: live.length, target })}
        </p>
        {list("replacement")}
        {list("skill")}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void onAdd("programs", { kind: "skill" }, "programs")}>
            {t("planStep.addSkill")}
          </Button>
          <Button size="sm" onClick={() => void onAdd("programs", { kind: "replacement" }, "programs")}>
            {t("planStep.addReplacement")}
          </Button>
        </div>
        <RejectedList count={rejected.length}>
          {rejected.map((item) => (
            <ItemCard key={item.id} caseId={caseId} part="programs" item={item} title={programName(item)} findings={[]} data={data} context={context} />
          ))}
        </RejectedList>
      </div>
      <div className="min-w-0">
        {chosen && !isRejected(chosen) ? (
          <ItemCard key={chosen.id} caseId={caseId} part="programs" item={chosen} title={programName(chosen)} findings={findingsOf(chosen.id)} data={data} context={context} startEditing={fresh === chosen.id}>
            <ProgramBody program={chosen} />
          </ItemCard>
        ) : (
          <p className="text-md text-fg-muted">{t("planStep.noPrograms")}</p>
        )}
      </div>
    </div>
  );
}

/** The glossary: alphabetical, each entry named as its strategy (D15); the strategies with no entry; the teaching procedures. */
function GlossaryView(props: ViewProps) {
  const { t } = useTranslation();
  const { caseId, plan, data, context, fresh, findingsOf, onAdd } = props;
  const strategies = plan.parts.strategies.items;
  const nameOf = (id: string) => {
    const strategy = strategies.find((item) => item.id === id);
    return strategy ? strategyName(strategy) : t("planStep.noStrategy");
  };
  const entries = byName(plan.parts.glossary.items.filter((item) => !isRejected(item)), (entry) => nameOf(entry.strategyId));
  const rejected = plan.parts.glossary.items.filter(isRejected);
  const covered = new Set(plan.parts.glossary.items.filter((item) => !isRejected(item)).map((item) => item.strategyId));
  const missing = strategies.filter((item) => !isRejected(item) && !covered.has(item.id));
  // Teaching and consequence procedures, and any antecedent strategy no block shows (finding 8).
  const teaching = strategies.filter(inNoBlock);
  return (
    <>
      <p className="max-w-reading text-sm text-fg-muted">{t("planStep.glossaryNote")}</p>
      {missing.length > 0 ? (
        <section className="flex flex-col gap-1.5 rounded-md border border-dashed border-border-control p-3" data-testid="plan-glossary-missing">
          <Eyebrow className="text-fg-muted">{t("planStep.glossaryMissing", { count: missing.length })}</Eyebrow>
          <ul className="flex flex-col gap-1">
            {missing.map((strategy) => (
              <li key={strategy.id} data-item={strategy.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span lang="en" className="flex-1">
                  {strategyName(strategy)}
                </span>
                <Button size="sm" onClick={() => void onAdd("glossary", { strategyId: strategy.id })}>
                  {t("planStep.writeEntry")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <ItemCard key={entry.id} caseId={caseId} part="glossary" item={entry} title={`${nameOf(entry.strategyId)}:`} findings={findingsOf(entry.id)} data={data} context={context} startEditing={fresh === entry.id}>
            <p lang="en" className="text-sm">
              {[entry.definition?.value, entry.implementation?.value].filter(Boolean).join(" ")}
            </p>
          </ItemCard>
        ))}
        {entries.length === 0 ? <p className="text-md text-fg-muted">{t("planStep.glossaryEmpty")}</p> : null}
      </div>
      <section className="flex flex-col gap-2">
        <Eyebrow className="text-fg-muted">{t("planStep.teachingHeading")}</Eyebrow>
        <p className="text-sm text-fg-muted">{t("planStep.teachingNote")}</p>
        {teaching.filter((item) => !isRejected(item)).map((item) => (
          <ItemCard key={item.id} caseId={caseId} part="strategies" item={item} title={strategyName(item)} findings={findingsOf(item.id)} data={data} context={context} startEditing={fresh === item.id}>
            <Params parameters={item.parameters} />
          </ItemCard>
        ))}
        <div>
          <Button size="sm" onClick={() => void onAdd("strategies", { kind: "teaching" })}>
            {t("planStep.addTeaching")}
          </Button>
        </div>
      </section>
      <RejectedList count={rejected.length + teaching.filter(isRejected).length}>
        {rejected.map((entry) => (
          <ItemCard key={entry.id} caseId={caseId} part="glossary" item={entry} title={`${nameOf(entry.strategyId)}:`} findings={[]} data={data} context={context} />
        ))}
        {teaching.filter(isRejected).map((item) => (
          <ItemCard key={item.id} caseId={caseId} part="strategies" item={item} title={strategyName(item)} findings={[]} data={data} context={context} />
        ))}
      </RejectedList>
    </>
  );
}

/** The caregiver goals (D9): one set for all caregivers; baseline 0, 10 or 20%; mastery 95%. */
function GoalsView(props: ViewProps) {
  const { t } = useTranslation();
  const { caseId, plan, data, context, fresh, findingsOf, onAdd } = props;
  const goals = plan.parts.caregiverGoals.items;
  return (
    <>
      <p className="max-w-reading text-sm text-fg-muted">{t("planStep.goalsNote")}</p>
      <div className="flex flex-col gap-2">
        {goals
          .filter((goal) => !isRejected(goal))
          .map((goal) => {
            const baseline = caregiverBaseline(goal.baselinePercent?.value);
            const mastery = caregiverMastery(goal.masteryOverride?.value);
            return (
              <ItemCard key={goal.id} caseId={caseId} part="caregiverGoals" item={goal} title={goal.title?.value || t("planStep.untitled")} findings={findingsOf(goal.id)} data={data} context={context} startEditing={fresh === goal.id}>
                <p lang="en" className="text-sm whitespace-pre-wrap">
                  {goal.procedure?.value}
                </p>
                <p className="text-sm">
                  {baseline === null ? t("planStep.goalNoBaseline") : t("planStep.goalBaseline", { percent: baseline.percent })} · {t("planStep.masteryLine", { percent: mastery })}
                </p>
              </ItemCard>
            );
          })}
        {goals.length === 0 ? <p className="text-md text-fg-muted">{t("planStep.goalsEmpty")}</p> : null}
      </div>
      {goals.length >= 6 ? <p className="text-sm text-fg-muted">{t("planStep.goalsFull")}</p> : null}
      <div>
        <Button size="sm" onClick={() => void onAdd("caregiverGoals", { kind: "interventions" })} disabled={goals.length >= 6}>
          {t("planStep.addGoal")}
        </Button>
      </div>
      <RejectedList count={goals.filter(isRejected).length}>
        {goals.filter(isRejected).map((goal) => (
          <ItemCard key={goal.id} caseId={caseId} part="caregiverGoals" item={goal} title={goal.title?.value || t("planStep.untitled")} findings={[]} data={data} context={context} />
        ))}
      </RejectedList>
    </>
  );
}

/** "Antes de QA": every check of the code, together, by kind, each with Ver (D19). */
function ChecksView({ t, findings, onSee }: { t: TFunction; findings: readonly PlanFinding[]; onSee: (finding: PlanFinding) => void }) {
  return (
    <>
      <p className="max-w-reading text-md">{t("planStep.checks.intro")}</p>
      {findings.length === 0 ? <p className="text-md text-success">{t("planStep.checks.none")}</p> : null}
      {FINDING_GROUPS.map((group) => {
        const list = findings.filter((finding) => findingGroup(finding.kind) === group);
        if (list.length === 0) return null;
        return (
          <section key={group} data-testid={`plan-checks-${group}`} className="flex flex-col gap-2">
            <Eyebrow className="text-fg-muted">{t(`planStep.checks.group.${group}`, { count: list.length })}</Eyebrow>
            <ul className="flex flex-col rounded-lg border border-border bg-surface">
              {list.map((finding, index) => {
                const text = findingText(t, finding);
                return (
                  <li key={index} data-testid="plan-finding" data-kind={finding.kind} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <span aria-hidden="true" className="text-warning">
                      ⚠
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
                        {text.title}
                        <StatusBadge>{t("planStep.checks.byApp")}</StatusBadge>
                      </p>
                      <p className="text-sm">{text.body}</p>
                      <p className="text-xs text-fg-muted">{finding.view.startsWith("fn:") ? FUNCTION_TITLES[finding.view.slice(3) as FunctionName] : t(`planStep.view.${finding.view as "programs"}`)}</p>
                    </div>
                    <Button size="sm" onClick={() => onSee(finding)}>
                      {t("planStep.checks.see")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** "Copiar para ABA Matrix": the fields of her accepted plan, one at a time (D22, D23). */
function CopyView({ caseId, plan, groups, data, undecided, onReport }: { caseId: string; plan: PlanView; groups: ReturnType<typeof planCopy>; data: PlanData; undecided: number; onReport: () => void }) {
  const { t } = useTranslation();
  const fields = groups.flatMap((group) => group.fields.map((field) => ({ group, field })));
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = fields.find((entry) => entry.field.id === selected) ?? fields[0] ?? null;
  const { copy, last } = useCopyFields(caseId, (result) => data.accept(result));
  return (
    <>
      <p className="max-w-reading text-md">{t("planStep.copy.intro", { count: undecided })}</p>
      {fields.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-md text-fg-muted">{t("planStep.copy.empty")}</p>
          <Button onClick={onReport}>{t("planStep.next.toReport")}</Button>
        </div>
      ) : (
        <div className="grid items-start gap-5 @3xl:grid-cols-[18rem_1fr]">
          <CopyList groups={groups} plan={plan} selected={chosen?.field.id ?? null} onSelect={setSelected} />
          {chosen ? <CopyPreview group={chosen.group} field={chosen.field} plan={plan} onCopy={(ids) => void copy(ids)} last={last} /> : null}
        </div>
      )}
    </>
  );
}

/* The rail */

function RailSection({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className="flex flex-col gap-2">
      <Eyebrow id={id} className="text-fg-muted">
        {title}
      </Eyebrow>
      {children}
    </section>
  );
}

function QaRail({ t, findings, view, title, onSee }: { t: TFunction; findings: readonly PlanFinding[]; view: View; title: string; onSee: (finding: PlanFinding) => void }) {
  return (
    <RailSection title={t("planStep.qaHeading", { name: title, count: findings.length })} testId="plan-qa-rail">
      {findings.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("planStep.qaNone")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((finding, index) => {
            const text = findingText(t, finding);
            return (
              <li key={`${view}-${index}`} className="text-sm">
                <span className="font-semibold">{text.title}</span> <span className="text-fg-muted">({t("planStep.checks.byApp")})</span>: {text.body}{" "}
                {findingItems(finding).length > 0 ? (
                  <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => onSee(finding)}>
                    {t("planStep.checks.see")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-fg-muted">{t("planStep.qaSoft")}</p>
    </RailSection>
  );
}

function BeforeRail({ map }: { map: NonNullable<ReturnType<typeof usePlanData>["state"] & { status: "ready" }>["map"] }) {
  const { t } = useTranslation();
  const parts = (["behaviors", "deficits", "strengths", "caregivers"] as const).map((part) => ({ part, status: map.parts[part].status }));
  return (
    <RailSection title={t("planStep.before")}>
      <ul className="flex flex-col gap-1.5">
        {parts.map(({ part, status }) => (
          <li key={part} className="flex items-start gap-2 text-sm">
            <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", status === "approved" ? "bg-success" : status === "empty" ? "border border-dot-empty" : "bg-warning")} />
            {t(`planStep.mapPart.${part}`)}: {t(`caseMap.status.${status === "empty" ? "empty" : status}`, { defaultValue: status })}
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

/** "Cuántos programas" (D10): her weekly hours, and the target her rule gives; her override wins. */
function CountRail({ caseId, data, plan, target, programs }: { caseId: string; data: PlanData; plan: PlanView; target: ReturnType<typeof programTarget>; programs: number }) {
  const { t } = useTranslation();
  const inputs = plan.parts.planInputs.items[0];
  const rule =
    target.rule === "under-5"
      ? t("planStep.count.under5", { age: target.ageYears ?? 0 })
      : target.rule === "hours"
        ? t("planStep.count.hours", { hours: target.hours ?? 0 })
        : target.rule === "override"
          ? t("planStep.count.override")
          : target.rule === "unreadable-hours"
            ? t("planStep.count.unreadable")
            : t("planStep.count.default");
  return (
    <RailSection title={t("planStep.count.heading")} testId="plan-count-rail">
      {inputs ? (
        <InputsForm key={inputs.id} caseId={caseId} data={data} item={inputs} />
      ) : (
        <FirstHours data={data} />
      )}
      <p className="text-sm" data-testid="plan-target">
        <span className="font-mono font-semibold">~{target.target}</span> · {rule}
      </p>
      {/* "No weekly hours yet" only when she gave none; unreadable hours are said on the line above (review round 2, finding 2). */}
      {target.openItem && target.rule === "default" ? <p className="text-sm text-warning">{t("planStep.count.openItem")}</p> : null}
      <p className="text-xs text-fg-muted">{t("planStep.count.so", { count: programs, target: target.target })}</p>
    </RailSection>
  );
}

/** Her weekly hours before the plan has its inputs item: saved, which makes it, once she pauses or leaves the box. */
function FirstHours({ data }: { data: PlanData }) {
  const { t } = useTranslation();
  const hoursId = useId();
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const save = (value: string) => {
    window.clearTimeout(timer.current);
    if (value.trim() === "" || adding) return;
    setAdding(true);
    void data.add("planInputs", { weeklyHours: { value, check: null } }).finally(() => setAdding(false));
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={hoursId} className="text-sm font-semibold">
        {t("planStep.count.hoursLabel")}
      </label>
      <input
        id={hoursId}
        inputMode="decimal"
        value={text}
        readOnly={adding}
        placeholder={t("planStep.count.hoursPlaceholder")}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => save(value), 600);
        }}
        onBlur={() => save(text)}
        className="min-h-control-sm w-full rounded-md border border-border-control bg-surface px-2.5 text-base"
      />
    </div>
  );
}

/** Her weekly hours and her override of the target, saved as she types (planInputs, D10). */
function InputsForm({ caseId, data, item }: { caseId: string; data: PlanData; item: PlanItemByPart["planInputs"] }) {
  const { t } = useTranslation();
  const [initial] = useState(() => JSON.stringify(planInput("planInputs", item)));
  const save = useCallback(
    async (text: string) => data.accept(await window.aba.saveMapItem(caseId, "planInputs", "items", "plan", text, data.editingFor("planInputs")).catch(() => null), "planInputs"),
    [caseId, data],
  );
  const box = useAutosave({ caseId, initial, save });
  // Hours she typed that could not be saved come back in the box (review of PR 1, finding 7).
  const ready = useKeptText(box, useCallback((failed: FailedSave) => failed.about === "map" && failed.caseId === caseId && failed.mapItem === "planInputs/items/plan", [caseId]));
  const value = JSON.parse(box.value) as { weeklyHours: { value: string } | null; targetOverride: { value: string } | null };
  const hoursId = useId();
  const overrideId = useId();
  const set = (key: "weeklyHours" | "targetOverride", text: string) => box.setValue(JSON.stringify({ ...value, [key]: text === "" ? null : { value: text, check: null } }));
  return (
    <fieldset disabled={!ready} className="flex flex-col gap-2" onBlur={() => void box.flush()}>
      <label htmlFor={hoursId} className="text-sm font-semibold">
        {t("planStep.count.hoursLabel")}
      </label>
      <input id={hoursId} inputMode="decimal" value={value.weeklyHours?.value ?? ""} onChange={(event) => set("weeklyHours", event.target.value)} className="min-h-control-sm w-full rounded-md border border-border-control bg-surface px-2.5 text-base" />
      <label htmlFor={overrideId} className="text-sm text-fg-muted">
        {t("planStep.count.overrideLabel")}
      </label>
      <input id={overrideId} inputMode="numeric" value={value.targetOverride?.value ?? ""} onChange={(event) => set("targetOverride", event.target.value)} className="min-h-control-sm w-24 rounded-md border border-border-control bg-surface px-2.5 text-base" />
      <span aria-live="polite" className="text-xs text-fg-muted">
        {box.status === "saving" ? t("sources.saving") : box.status === "saved" ? t("caseMap.saved") : box.status === "failed" ? t("caseMap.actionFailed") : ""}
      </span>
    </fieldset>
  );
}

/** The HBI intro (D16): our draft until she confirms or replaces it, once for all her cases. */
function IntroRail({ instructions, onSaved }: { instructions: { text: string; hbiIntro: { text: string; confirmedAt: string } | null }; onSaved: (next: { text: string; hbiIntro: { text: string; confirmedAt: string } | null }) => void }) {
  const { t } = useTranslation();
  const confirmed = instructions.hbiIntro;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(confirmed?.text ?? HBI_INTRO_DRAFT);
  const [failed, setFailed] = useState(false);
  const boxId = useId();
  const save = async (value: string) => {
    setFailed(false);
    const result = await window.aba.confirmHbiIntro(value).catch(() => null);
    if (result?.outcome === "saved") {
      onSaved(result.instructions);
      setEditing(false);
    } else setFailed(true);
  };
  return (
    <RailSection title={t("planStep.intro14.heading")} testId="plan-intro-rail">
      <p className="flex items-center gap-2 text-sm">
        <StatusBadge tone={confirmed ? "success" : "accent"}>{confirmed ? t("planStep.intro14.confirmed") : t("planStep.intro14.draft")}</StatusBadge>
      </p>
      {editing ? (
        <>
          <label htmlFor={boxId} className="sr-only">
            {t("planStep.intro14.heading")}
          </label>
          <textarea id={boxId} lang="en" value={text} onChange={(event) => setText(event.target.value)} className="field-sizing-content min-h-24 w-full rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-sm" />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={text.trim() === ""} onClick={() => void save(text)}>
              {t("planStep.intro14.saveConfirm")}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              {t("caseMap.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p lang="en" className="text-sm">
            {confirmed?.text ?? HBI_INTRO_DRAFT}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {confirmed ? null : (
              <Button size="sm" onClick={() => void save(HBI_INTRO_DRAFT)}>
                <Icon name="check" />
                {t("planStep.intro14.confirm")}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(true)}>
              {t("planStep.edit")}
            </Button>
          </div>
        </>
      )}
      <p className="text-xs text-fg-muted">{t("planStep.intro14.note")}</p>
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t("caseMap.actionFailed")}
        </p>
      ) : null}
    </RailSection>
  );
}

/** Her plan standing instructions (D17): her usual parameters, for all her cases; the AI reads them from PR 2 on. */
function PlanInstructionsRail({ caseId, text, onSaved }: { caseId: string; text: string; onSaved: (text: string) => void }) {
  const { t } = useTranslation();
  const boxId = useId();
  const save = useCallback(
    async (value: string) => {
      const result = await window.aba.saveSectionInstructions(caseId, "plan", value).catch(() => null);
      if (result?.outcome === "saved") onSaved(value);
      return result?.outcome === "saved";
    },
    [caseId, onSaved],
  );
  const box = useAutosave({ caseId, initial: text, save });
  return (
    <RailSection title={t("planStep.instructions.heading")}>
      <label htmlFor={boxId} className="text-sm text-fg-muted">
        {t("planStep.instructions.label")}
      </label>
      <textarea id={boxId} lang="en" value={box.value} placeholder={t("planStep.instructions.placeholder")} onChange={(event) => box.setValue(event.target.value)} onBlur={() => void box.flush()} className="field-sizing-content min-h-20 w-full rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-sm" />
      <span aria-live="polite" className="text-xs text-fg-muted">
        {box.status === "saving" ? t("sources.saving") : box.status === "saved" ? t("caseMap.saved") : box.status === "failed" ? t("caseMap.actionFailed") : ""}
      </span>
    </RailSection>
  );
}

function ChecksRail() {
  const { t } = useTranslation();
  return (
    <>
      <RailSection title={t("planStep.checks.appHeading")}>
        <p className="text-sm">{t("planStep.checks.appBody")}</p>
      </RailSection>
      <RailSection title={t("planStep.checks.aiHeading")}>
        <p className="text-sm text-fg-muted">{t("planStep.checks.aiBody")}</p>
      </RailSection>
    </>
  );
}

function CopyRail({ undecided, findings, markers }: { undecided: number; findings: number; markers: number }) {
  const { t } = useTranslation();
  return (
    <>
      <RailSection title={t("planStep.copy.beforeHeading")}>
        <ul className="flex flex-col gap-1.5 text-sm">
          <li>{undecided > 0 ? t("planStep.copy.undecided", { count: undecided }) : t("planStep.copy.allDecided")}</li>
          <li>{findings > 0 ? t("planStep.copy.findings", { count: findings }) : t("planStep.copy.noFindings")}</li>
          <li>{markers > 0 ? t("planStep.copy.markersLeft", { count: markers }) : t("planStep.copy.noMarkers")}</li>
        </ul>
      </RailSection>
      <RailSection title={t("planStep.copy.notHereHeading")}>
        <p className="text-sm">{t("planStep.copy.notHereBody")}</p>
      </RailSection>
    </>
  );
}

