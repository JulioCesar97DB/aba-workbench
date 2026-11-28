import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CaseMapView } from "../../../shared/case-map.ts";
import { definitionWarnings, reviewFingerprint, type CheckedBehavior } from "../../../shared/definition-checks.ts";
import { Button } from "../components/Button.tsx";
import { useProviders } from "../drafting-provider.tsx";
import { useLanguage } from "../language.tsx";
import { Eyebrow } from "../shell/WorkArea.tsx";
import { isDrafting, startMapReview, stopMapDraft, useMapDraft, useMapReview } from "./draft.ts";

/*
 * The checks before QA (T3, owner's decisions of 2026-11-28), on each behavior, where the map
 * already shows its checks: the code's (computed from what is saved, so after every draft and
 * every edit, hers too) and the newest AI review's. They are warnings: she approves with
 * them open, as with any [CHECK], and none offers to rewrite her text.
 */

/** One warning as the screen shows it. The AI's texts are English on both screens. */
export interface WarningLine {
  key: string;
  text: string;
  lang: "en" | undefined;
  /** The behavior changed after the AI's review read it. */
  stale: boolean;
}

/** Every behavior's warnings, by its id: the code checks first, then the AI review's findings. */
export function warningLines(t: TFunction, map: CaseMapView): Map<string, WarningLine[]> {
  const items = map.parts.behaviors.items as unknown as CheckedBehavior[];
  const nameOf = new Map(items.map((item) => [item.id, typeof (item.name as { value?: unknown } | null)?.value === "string" ? ((item.name as { value: string }).value.trim() || t("caseMap.untitled")) : t("caseMap.untitled")]));
  const out = new Map<string, WarningLine[]>();
  const add = (id: string, line: WarningLine) => out.set(id, [...(out.get(id) ?? []), line]);
  for (const [id, warnings] of definitionWarnings(items)) {
    warnings.forEach((warning, index) => {
      const text =
        warning.kind === "dead-man"
          ? t(warning.field === "definition" ? "caseMap.qa.deadManDefinition" : "caseMap.qa.deadManOnset", { phrase: warning.phrase })
          : t(warning.via === "example" ? "caseMap.qa.overlapExample" : "caseMap.qa.overlapTopography", { other: warning.otherName, phrase: warning.phrase });
      add(id, { key: `code-${id}-${index}`, text, lang: undefined, stale: false });
    });
  }
  const review = map.definitionReview;
  if (review?.status === "done") {
    const current = new Map(items.map((item) => [item.id, reviewFingerprint(item)]));
    const stale = (id: string) => review.fingerprints[id] !== current.get(id);
    review.findings.forEach((finding, index) => {
      if (finding.kind === "dead-man") {
        if (!current.has(finding.behaviorId)) return;
        add(finding.behaviorId, { key: `ai-${index}`, text: t("caseMap.qa.aiDeadMan", { why: finding.why }), lang: "en", stale: stale(finding.behaviorId) });
        return;
      }
      const [first, second] = finding.behaviorIds;
      if (!current.has(first) || !current.has(second)) return;
      const changed = stale(first) || stale(second);
      for (const [id, other] of [[first, second], [second, first]] as const) {
        add(id, { key: `ai-${index}-${id}`, text: t("caseMap.qa.aiOverlap", { other: nameOf.get(other) ?? other, response: finding.response, exclusion: finding.exclusion }), lang: "en", stale: changed });
      }
    });
  }
  return out;
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
            <span lang={line.lang}>{line.text}</span>
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
      <p className={review?.status === "failed" && !running ? "text-sm text-warning" : "text-sm"}>
        {running ? t("caseMap.qa.reviewing") : review === null ? null : review.status === "failed" ? t("caseMap.qa.reviewFailed") : t("caseMap.qa.reviewed", { count: review.findings.length, when })}
      </p>
      {run?.phase === "done" && run.outcome === "stopped" ? <p className="text-sm text-fg-muted">{t("caseMap.qa.reviewStopped")}</p> : null}
      {refused || (run?.phase === "done" && run.outcome === "not-run") ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t("caseMap.qa.reviewNotStarted")}
        </p>
      ) : null}
      {hasBehaviors && providers.provider !== null && !drafting ? (
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
