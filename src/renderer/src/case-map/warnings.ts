import type { TFunction } from "i18next";
import type { CaseMapView } from "../../../shared/case-map.ts";
import { definitionWarnings, reviewFingerprint, type CheckedBehavior } from "../../../shared/definition-checks.ts";

/*
 * The checks before QA (T3) as the screen words them, behavior by behavior: the code's
 * (computed from what is saved, so after every draft and every edit, hers too) and the
 * newest AI review's, marked when the behavior changed after the review read it.
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
