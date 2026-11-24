import { useTranslation } from "react-i18next";
import { stepTitle } from "../case-steps.tsx";
import type { StepState } from "../step-states.ts";
import type { CaseStep } from "../steps.ts";
import { cn } from "./cn.ts";
import { Icon } from "./Icon.tsx";

/*
 * A step's state drawn on a light surface (owner's proposal §3.4), the same marks as the
 * sidebar's steps: green with a check once done, amber while in progress, hollow before,
 * dashed when the step is not built yet. Drawn only: the state is always said in words too.
 */

export const STEP_STATE_KEYS: Record<StepState, "nav.stepDone" | "nav.stepInProgress" | "nav.stepNotStarted" | "nav.stepLater"> = {
  done: "nav.stepDone",
  "in-progress": "nav.stepInProgress",
  "not-started": "nav.stepNotStarted",
  later: "nav.stepLater",
};

/** The circle of a step, with its number or a check: the case summary's rows. Hidden from screen readers. */
export function StepCircle({ number, state }: { number: number; state: StepState }) {
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs font-semibold tabular-nums",
        state === "done" && "bg-dot-done text-nav",
        state === "in-progress" && "bg-dot-draft text-nav",
        state === "not-started" && "border border-border-control text-fg-muted",
        state === "later" && "border border-dashed border-border-control text-fg-muted",
      )}
    >
      {state === "done" ? <Icon name="check" size={14} /> : number}
    </span>
  );
}

/**
 * Home's five-segment bar (owner's proposal §3.4): one segment per step, in order. It is an
 * image whose name says each step and its state, so a screen reader hears what it shows.
 */
export function StepProgressBar({ steps }: { steps: ReadonlyArray<{ step: CaseStep; state: StepState }> }) {
  const { t } = useTranslation();
  const states = steps.map(({ step, state }) => t("home.stepAndState", { step: stepTitle(t, step), state: t(STEP_STATE_KEYS[state]) })).join("; ");
  return (
    <span role="img" aria-label={t("home.progressLabel", { states })} data-testid="step-progress" className="flex w-32 shrink-0 gap-1">
      {steps.map(({ step, state }) => (
        <span
          key={step}
          data-state={state}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            state === "done" && "bg-dot-done",
            state === "in-progress" && "bg-dot-draft",
            state === "not-started" && "bg-border",
            state === "later" && "border border-dashed border-border-control",
          )}
        />
      ))}
    </span>
  );
}
