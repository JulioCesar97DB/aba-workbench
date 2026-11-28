import type { TFunction } from "i18next";
import type { CaseMapView } from "../../../shared/case-map.ts";
import { definitionWarnings, reviewFingerprint, type CheckedBehavior } from "../../../shared/definition-checks.ts";

/*
 * The checks before QA (T3) as the screen words them, behavior by behavior: the code's
 * (computed from what is saved, so after every draft and every edit, hers too) and the
 * newest AI review's, marked when the behavior changed after the review read it.
 */

/** A piece of a warning: the app's words (her language) or the AI's (English, marked so: review of T3, nit 8). */
export interface WarningPart {
  text: string;
  lang: "en" | undefined;
}

/** One warning as the screen shows it. */
export interface WarningLine {
  key: string;
  parts: WarningPart[];
  /** The behavior changed after the AI's review read it. */
  stale: boolean;
}

/** A warning's text as one string (the parts joined by a space). */
export function lineText(line: Pick<WarningLine, "parts">): string {
  return line.parts.map((part) => part.text).join(" ");
}

/** The findings of a review whose behaviors are all still in the map: what the screen shows and counts (review of T3, nit 9). */
export function shownFindings(review: CaseMapView["definitionReview"], behaviorIds: ReadonlySet<string>) {
  if (review?.status !== "done") return [];
  return review.findings.filter((finding) => (finding.kind === "dead-man" ? behaviorIds.has(finding.behaviorId) : finding.behaviorIds.every((id) => behaviorIds.has(id))));
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
      add(id, { key: `code-${id}-${index}`, parts: [{ text, lang: undefined }], stale: false });
    });
  }
  const review = map.definitionReview;
  if (review) {
    const current = new Map(items.map((item) => [item.id, reviewFingerprint(item)]));
    const stale = (id: string) => review.fingerprints[id] !== current.get(id);
    shownFindings(review, new Set(current.keys())).forEach((finding, index) => {
      if (finding.kind === "dead-man") {
        add(finding.behaviorId, { key: `ai-${index}`, parts: [{ text: t("caseMap.qa.aiDeadMan"), lang: undefined }, { text: finding.why, lang: "en" }], stale: stale(finding.behaviorId) });
        return;
      }
      const [first, second] = finding.behaviorIds;
      const changed = stale(first) || stale(second);
      for (const [id, other] of [[first, second], [second, first]] as const) {
        add(id, {
          key: `ai-${index}-${id}`,
          parts: [
            { text: t("caseMap.qa.aiOverlap", { other: nameOf.get(other) ?? other }), lang: undefined },
            { text: finding.response, lang: "en" },
            { text: t("caseMap.qa.aiSeparate"), lang: undefined },
            { text: finding.exclusion, lang: "en" },
          ],
          stale: changed,
        });
      }
    });
  }
  return out;
}
