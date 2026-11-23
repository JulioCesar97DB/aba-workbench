import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MAP_PARTS, type MapPartId } from "../../../shared/case-map.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import type { SourceType } from "../../../shared/sources.ts";
import { CASE_STEPS, casePath, stepTitle, type CaseStep } from "../case-steps.tsx";
import { onRetried, useCaseSaves, useFailedSaveList } from "../case-saves.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { StateChip } from "../components/StateChip.tsx";
import { STEP_STATE_KEYS, StepCircle } from "../components/StepMarks.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { CHECKLIST, checklistTypeOf } from "../document-checklist.ts";
import { nextThing, nextThingPath, type NextInputs } from "../next-thing.ts";
import { useNextWords } from "../next-thing-words.tsx";
import { useOpenedCase, usePatchOpenedCase } from "../open-case.tsx";
import { SourceTypeLabel } from "../source-labels.tsx";
import { readySections, stepState, type StepState } from "../step-states.ts";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

/*
 * "Resumen del caso" (owner's proposal §4, mockup 03; decision T6): where a case opens, its
 * index address. "Lo siguiente" first, with one sentence and the screen's one primary
 * button (the rule of §6, next-thing.ts: computed, nothing stored, T7 and P8); then the
 * five steps, each with its state in a sentence and a secondary button; then the two ways,
 * as a legend. The case map's state is read through its own API only (getCaseMap), never
 * changed here.
 */

export function CaseSummaryScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const mapPart = useMapPartToApprove(opened.id, opened.caseMap.withContent);
  const unsaved = useFailedSaveList().some((item) => item.caseId === opened.id);
  useReadAgainAfterRetry(opened.id);
  const active = opened.sources.sources.filter((source) => !source.removedAt);
  const inputs: NextInputs = { unsaved, sources: active.length, caseMap: opened.caseMap, mapPartToApprove: mapPart, sections: opened.sections };
  return (
    <WorkArea header={<PageHeader eyebrow={opened.label} title={t("summary.title")} />} contentClassName="max-w-list">
      <div className="flex flex-col gap-7">
        <NextCard caseId={opened.id} inputs={inputs} />
        <Steps caseId={opened.id} inputs={inputs} types={active.map((source) => source.type)} />
        <WaysLegend />
      </div>
    </WorkArea>
  );
}

/**
 * The first part of the map with content and not approved, read from the map itself
 * (getCaseMap, the case map's API); null while it is read, when there is none, or when it
 * cannot be read (the card then names the map, not the part).
 */
function useMapPartToApprove(caseId: string, withContent: number): MapPartId | null {
  const [found, setFound] = useState<{ caseId: string; part: MapPartId | null } | null>(null);
  useEffect(() => {
    if (withContent === 0) return;
    let live = true;
    window.aba.getCaseMap(caseId).then(
      (result) => {
        if (!live || result.outcome !== "read") return;
        const part = MAP_PARTS.find((id) => {
          const view = result.map.parts[id];
          return view.status !== "approved" && (view.items.length > 0 || view.groups.length > 0);
        });
        setFound({ caseId, part: part ?? null });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [caseId, withContent]);
  return withContent > 0 && found?.caseId === caseId ? found.part : null;
}

/**
 * "Volver a intentar" on a change to a section, its instructions, the notes or the map:
 * once it is saved, the case is read again so the summary shows what was saved (a change
 * to a document answers with the documents themselves).
 */
function useReadAgainAfterRetry(caseId: string) {
  const patch = usePatchOpenedCase();
  useEffect(
    () =>
      onRetried((item) => {
        if (item.caseId !== caseId) return;
        void window.aba.openCase(caseId).then(
          (result) => {
            if (result.outcome === "opened") patch(caseId, { sections: result.case.sections, notes: result.case.notes, caseMap: result.case.caseMap });
          },
          () => undefined,
        );
      }),
    [caseId, patch],
  );
}

/** "LO SIGUIENTE": one sentence, one more, and the screen's one primary button. */
function NextCard({ caseId, inputs }: { caseId: string; inputs: NextInputs }) {
  const { t } = useTranslation();
  const headingId = useId();
  const thing = nextThing(inputs);
  const words = useNextWords(thing);
  const saves = useCaseSaves();
  let action: ReactNode;
  if (thing.kind === "unsaved") {
    const failed = saves.state.status === "failed" ? saves.state : null;
    action = (
      <Button variant="primary" disabled={!failed} focusableWhenDisabled onClick={() => failed?.retry()}>
        {failed ? t("next.unsavedAction") : t("next.unsavedRetrying")}
      </Button>
    );
  } else {
    action = (
      <ButtonLink to={nextThingPath(caseId, thing)} variant="primary">
        {words.action}
        <Icon name="arrow" />
      </ButtonLink>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="next-thing"
      data-kind={thing.kind}
      className="flex flex-col gap-3 rounded-lg border-2 border-accent bg-surface px-5 py-4 @split:flex-row @split:items-center @split:gap-6"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Eyebrow id={headingId} className="text-fg-on-accent-subtle">
          {t("summary.nextHeading")}
        </Eyebrow>
        <p className="text-md font-semibold">{words.title}</p>
        <p className="text-sm text-fg-muted">{words.body}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </section>
  );
}

/** "Cómo va la evaluación": the five steps, each with its state in a sentence and a secondary button. */
function Steps({ caseId, inputs, types }: { caseId: string; inputs: NextInputs; types: SourceType[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-base font-semibold">
        {t("summary.stepsHeading")}
      </h2>
      <ol data-testid="summary-steps" className="flex flex-col rounded-lg border border-border">
        {CASE_STEPS.map((step, index) => (
          <StepRow key={step} caseId={caseId} step={step} number={index + 1} state={stepState(step, inputs)} sentence={<StepSentence step={step} inputs={inputs} types={types} />} />
        ))}
      </ol>
    </section>
  );
}

function StepRow({ caseId, step, number, state, sentence }: { caseId: string; step: CaseStep; number: number; state: StepState; sentence: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  const action = state === "later" ? null : state === "done" ? t("summary.view") : state === "in-progress" ? t("summary.continue") : t("summary.start");
  return (
    <li data-step={step} data-state={state} className="flex items-center gap-3.5 border-b border-border px-4 py-3 last:border-b-0">
      <StepCircle number={number} state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 id={titleId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
          {stepTitle(t, step)}
          {state === "later" ? (
            <span aria-hidden="true" className="rounded-sm border border-dashed border-border-control px-1.5 text-xs font-medium text-fg-muted">
              {t("summary.soon")}
            </span>
          ) : null}
          <span className="sr-only">, {t(STEP_STATE_KEYS[state])}</span>
        </h3>
        <p className="text-sm text-fg-muted">{sentence}</p>
      </div>
      {action ? (
        <ButtonLink to={casePath(caseId, step)} size="sm" className="shrink-0">
          {action}
          <span className="sr-only"> · {stepTitle(t, step)}</span>
        </ButtonLink>
      ) : null}
    </li>
  );
}

/** A step's state in a sentence. */
function StepSentence({ step, inputs, types }: { step: CaseStep; inputs: NextInputs; types: SourceType[] }) {
  const { t } = useTranslation();
  const total = REPORT_SECTIONS.length;
  switch (step) {
    case "sources":
      return types.length === 0 ? (
        <>{t("summary.sourcesNone")}</>
      ) : (
        <>
          {t("summary.sourcesCount", { count: types.length })} <DocumentTypes types={types} />.
        </>
      );
    case "case-map": {
      const { approved, withContent } = inputs.caseMap;
      if (withContent === 0) return <>{t("summary.mapNone")}</>;
      return <>{approved >= withContent ? t("summary.mapDone", { count: withContent }) : t("summary.mapSome", { approved, total: withContent })}</>;
    }
    case "interventions":
      return <>{t("summary.planLater")}</>;
    case "report": {
      const states = inputs.sections.map((section) => section.state);
      if (states.every((state) => state === "not-started")) return <>{t("summary.reportNone", { total })}</>;
      const ready = readySections(inputs.sections);
      const approved = states.filter((state) => state === "approved").length;
      const hers = states.filter((state) => state === "hers").length;
      const drafts = states.filter((state) => state === "drafted").length;
      const parts = [approved > 0 ? t("summary.reportApproved", { count: approved }) : null, hers > 0 ? t("summary.reportHers", { count: hers }) : null].filter((part) => part !== null);
      const head = ready === total ? t("summary.reportAllReady", { total }) : t("summary.reportReady", { ready, total });
      return (
        <>
          {head}
          {parts.length > 0 ? `: ${parts.join(", ")}.` : "."}
          {drafts > 0 ? ` ${t("summary.reportDrafts", { count: drafts })}` : null}
        </>
      );
    }
    case "review":
      return <>{t("summary.reviewLater")}</>;
  }
}

/** The documents' types, in the checklist's order, with how many of each: "CDE, Direct observation (3), Vineland-3". */
function DocumentTypes({ types }: { types: SourceType[] }) {
  const { t } = useTranslation();
  const counts = new Map<SourceType, number>();
  for (const type of types) counts.set(checklistTypeOf(type), (counts.get(checklistTypeOf(type)) ?? 0) + 1);
  const ordered = CHECKLIST.map((row) => row.type).filter((type) => counts.has(type));
  return (
    <>
      {ordered.map((type, index) => (
        <span key={type}>
          {index > 0 ? ", " : null}
          <SourceTypeLabel t={t} type={type} />
          {(counts.get(type) ?? 0) > 1 ? ` (${counts.get(type)})` : null}
        </span>
      ))}
    </>
  );
}

/** The two ways, as a legend (mockup 03): what is hers and what is the AI's, and how each is marked. */
function WaysLegend() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-base font-semibold">
        {t("summary.waysHeading")}
      </h2>
      <TwoWays
        layout="bar"
        hand={{
          body: (
            <>
              {t("summary.waysHand")} <StateChip state="hers" className="align-middle" /> {t("summary.waysHandAfter")}
            </>
          ),
        }}
        ai={{
          body: (
            <>
              {t("summary.waysAi")} <StateChip state="ai-draft" className="align-middle" /> {t("summary.waysAiAfter")}
            </>
          ),
        }}
      />
    </section>
  );
}
