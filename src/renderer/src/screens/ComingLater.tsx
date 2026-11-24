import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CASE_STEPS, casePath, stepTitle } from "../case-steps.tsx";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { useOpenedCase } from "../open-case.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

/*
 * The honest "coming later" (owner's proposal §3.5, decision P3; mockup 12): a step that is
 * not built yet says so in a dashed card, says what it will do and what to do meanwhile,
 * and sends her on to the next useful step with the screen's one primary button. Then the
 * two ways: what she does today by hand, what the AI will do later. Plan (step 3); its
 * sidebar step stays dashed with "Pronto". (Revisión y copia, step 5, is built: Review.tsx.)
 */

/** The step header of a step not built yet: "Paso 3 de 5", its name and a dashed "Llega más adelante". */
function ComingLaterHeader({ step }: { step: "interventions" }) {
  const { t } = useTranslation();
  return (
    <StepHeader
      eyebrow={t("steps.position", { number: CASE_STEPS.indexOf(step) + 1, total: CASE_STEPS.length })}
      title={stepTitle(t, step)}
      chip={
        <span data-testid="state-chip" data-state="later" className="inline-flex shrink-0 items-center rounded-sm border border-dashed border-border-control px-2 py-0.5 text-sm font-medium whitespace-nowrap text-fg-muted">
          {t("comingLater.chip")}
        </span>
      }
    />
  );
}

/** The dashed card: what the step will do, what to do meanwhile, and where to go. */
function ComingLaterCard({ what, meanwhile, primary, secondary }: { what: ReactNode; meanwhile: ReactNode; primary: ReactNode; secondary: ReactNode }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="coming-later" className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-control bg-surface px-5 py-4.5">
      <h2 id={headingId} className="text-md font-semibold">
        {t("comingLater.title")}
      </h2>
      <p className="max-w-reading text-md">{what}</p>
      <p className="max-w-reading text-sm text-fg-muted">{meanwhile}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {primary}
        {secondary}
      </div>
    </section>
  );
}

/** Step 3, Plan: not built yet. "Seguir con el Informe" skips it (P3). */
export function PlanScreen() {
  const { t } = useTranslation();
  const { id } = useOpenedCase();
  return (
    <WorkArea header={<ComingLaterHeader step="interventions" />} contentClassName="max-w-list">
      <div className="flex flex-col gap-5">
        <ComingLaterCard
          what={<TransWithTerms i18nKey="plan.what" />}
          meanwhile={t("plan.meanwhile")}
          primary={
            <ButtonLink to={casePath(id, "report")} variant="primary">
              {t("plan.toReport")}
              <Icon name="arrow" />
            </ButtonLink>
          }
          secondary={<ButtonLink to={casePath(id, "case-map")}>{t("plan.backToMap")}</ButtonLink>}
        />
        <TwoWays layout="cards" hand={{ title: t("plan.handTitle"), body: <TransWithTerms i18nKey="plan.handBody" /> }} ai={{ title: t("plan.aiTitle"), body: t("plan.aiBody") }} />
      </div>
    </WorkArea>
  );
}
