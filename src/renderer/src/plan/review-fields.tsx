import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GetPlanResult, MapSaveResult } from "../../../shared/api.ts";
import { planCopy } from "../../../shared/plan-copy.ts";
import { planMapInputOf } from "../../../shared/plan.ts";
import { casePath } from "../case-steps.tsx";
import { TextLink } from "../components/Link.tsx";
import { usePatchOpenedCase } from "../open-case.tsx";
import { CompactCopyList, useCopyFields } from "./copy.tsx";

/*
 * Revisión y copia lists the plan's fields too (the Plan step's D22): the same fields as the
 * Plan's "Copiar para ABA Matrix", with the same copied marks (D23), each copied from here.
 */
export function ReviewPlanFields({ caseId }: { caseId: string }) {
  const { t } = useTranslation();
  const headingId = useId();
  const patch = usePatchOpenedCase();
  const [read, setRead] = useState<Extract<GetPlanResult, { outcome: "read" }> | null>(null);
  useEffect(() => {
    let current = true;
    window.aba.getPlan(caseId).then(
      (result) => {
        if (current && result.outcome === "read") setRead(result);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [caseId]);
  const onSaved = useCallback(
    (result: MapSaveResult) => {
      if (result.outcome !== "saved") return;
      setRead((previous) => (previous ? { ...previous, plan: result.plan, map: result.map } : previous));
      patch(caseId, { plan: result.planSummary });
    },
    [caseId, patch],
  );
  const { copy, last } = useCopyFields(caseId, onSaved);
  if (!read) return null;
  const groups = planCopy({ plan: read.plan, map: planMapInputOf(read.map), hbiIntro: read.instructions.hbiIntro?.text ?? null });
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-md font-semibold">
        {t("planStep.review.heading")}
      </h2>
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {t("planStep.review.empty")} <TextLink to={casePath(caseId, "interventions")}>{t("planStep.review.toPlan")}</TextLink>
        </p>
      ) : (
        <>
          <p className="max-w-reading text-sm text-fg-muted">{t("planStep.review.body")}</p>
          <CompactCopyList groups={groups} plan={read.plan} onCopy={(ids) => void copy(ids)} last={last} />
        </>
      )}
    </section>
  );
}
