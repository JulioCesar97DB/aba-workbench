import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CaseMapView } from "../../../shared/case-map.ts";
import { Button } from "../components/Button.tsx";
import { useProviders } from "../drafting-provider.tsx";
import { useLanguage } from "../language.tsx";
import { Eyebrow } from "../shell/WorkArea.tsx";
import { shownFindings, type WarningLine, type WarningPart } from "./warnings.ts";
import { reviewOffered } from "./draft-state.ts";
import { isDrafting, startMapReview, stopMapDraft, useMapDraft, useMapReview } from "./draft.ts";

/*
 * The checks before QA (T3, owner's decisions of 2026-11-28), on each behavior, where the map
 * already shows its checks: the code's (computed from what is saved, so after every draft and
 * every edit, hers too) and the newest AI review's. They are warnings: she approves with
 * them open, as with any [CHECK], and none offers to rewrite her text.
 */

/** A warning's parts, the AI's marked as English, so a screen reader reads each in its language. */
export function LineParts({ parts }: { parts: readonly WarningPart[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} lang={part.lang}>
          {index > 0 ? " " : ""}
          {part.text}
        </span>
      ))}
    </>
  );
}

/** A behavior's warnings, in its form, above its fields. */
export function BehaviorWarnings({ lines }: { lines: readonly WarningLine[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) return null;
  return (
    <section aria-label={t("caseMap.qa.heading")} data-testid="map-qa-warnings" className="flex flex-col gap-1.5 rounded-md border border-warning px-3 py-2.5">
      <Eyebrow as="p" className="text-warning">
        {t("caseMap.qa.heading")}
      </Eyebrow>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <li key={line.key} className="max-w-measure text-sm">
            <LineParts parts={line.parts} />
            {line.stale ? <span className="text-fg-muted"> {t("caseMap.qa.stale")}</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">{t("caseMap.qa.note")}</p>
    </section>
  );
}

/**
 * The review's status line, on the behaviors part: when the AI last reviewed the definitions
 * and how many findings it has, or that it could not run; and "Review the definitions again"
 * (owner's decision 2A), offered when an AI is connected and no draft runs.
 */
export function ReviewStatus({ caseId, map }: { caseId: string; map: CaseMapView }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const providers = useProviders();
  const draft = useMapDraft(caseId);
  const run = useMapReview(caseId);
  const [refused, setRefused] = useState(false);
  const review = map.definitionReview;
  const hasBehaviors = map.parts.behaviors.items.length > 0;
  if (!hasBehaviors && !review) return null;
  const running = run?.phase === "running";
  const drafting = isDrafting(draft);
  const offered = reviewOffered({ hasBehaviors, connected: providers.provider !== null, drafting });
  // Nothing to say and nothing to offer: no line at all.
  if (review === null && !running && !offered) return null;
  const when = review ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(review.at)) : "";
  async function start() {
    if (!providers.provider) return;
    setRefused(false);
    const outcome = await startMapReview(caseId, providers.provider);
    if (outcome !== "started") setRefused(true);
  }
  return (
    <section aria-live="polite" data-testid="map-review-status" className="flex flex-col gap-2">
      <Eyebrow className="text-fg-muted">{t("caseMap.qa.heading")}</Eyebrow>
      {running || review !== null ? (
        <p className={review?.status === "failed" && !running ? "text-sm text-warning" : "text-sm"}>
          {running ? t("caseMap.qa.reviewing") : review?.status === "failed" ? t("caseMap.qa.reviewFailed") : t("caseMap.qa.reviewed", { count: shownFindings(review, new Set(map.parts.behaviors.items.map((item) => item.id))).length, when })}
        </p>
      ) : null}
      {run?.phase === "done" && run.outcome === "stopped" ? <p className="text-sm text-fg-muted">{t("caseMap.qa.reviewStopped")}</p> : null}
      {refused || (run?.phase === "done" && run.outcome === "not-run") ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t("caseMap.qa.reviewNotStarted")}
        </p>
      ) : null}
      {offered ? (
        <div>
          {running && run ? (
            <Button size="sm" onClick={() => stopMapDraft({ id: run.id })}>
              {t("caseMap.qa.stop")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()}>
              {t("caseMap.qa.reviewAgain")}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
