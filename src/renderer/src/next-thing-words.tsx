import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { findReportSection, REPORT_SECTIONS } from "../../shared/report-sections.ts";
import { TransWithTerms } from "./components/Trans.tsx";
import type { NextThing } from "./next-thing.ts";

/*
 * "Lo siguiente" in words (owner's proposal §6 and §7): one sentence naming the next thing,
 * one more on what it means, and the words of its button. Shared by the case summary's card
 * and Home's "Sigue donde lo dejaste". Section titles stay English, marked lang="en".
 */

export interface NextWords {
  title: ReactNode;
  body: string;
  /** The button's words; null for a change not saved, whose button is "Try again" (the summary's own). */
  action: string | null;
}

function SectionTitle({ i18nKey, sectionId }: { i18nKey: "next.reviewDraftTitle" | "next.startSectionTitle"; sectionId: string }) {
  return <TransWithTerms i18nKey={i18nKey} values={{ section: findReportSection(sectionId)?.title ?? sectionId }} />;
}

export function nextWords(t: TFunction, thing: NextThing): NextWords {
  switch (thing.kind) {
    case "unsaved":
      return { title: t("next.unsavedTitle"), body: t("next.unsavedBody"), action: null };
    case "add-documents":
      return { title: t("next.addDocumentsTitle"), body: t("next.addDocumentsBody"), action: t("next.addDocumentsAction") };
    case "review-draft":
      return { title: <SectionTitle i18nKey="next.reviewDraftTitle" sectionId={thing.sectionId} />, body: t("next.reviewDraftBody"), action: t("next.openSection") };
    case "approve-map":
      return {
        title: thing.part ? t("next.approveMapPartTitle", { part: t(`caseMap.parts.${thing.part}`) }) : t("next.approveMapTitle"),
        body: t("next.approveMapBody"),
        action: t("next.approveMapAction"),
      };
    case "build-map":
      return { title: t("next.buildMapTitle"), body: t("next.buildMapBody"), action: t("next.buildMapAction") };
    case "start-section":
      return { title: <SectionTitle i18nKey="next.startSectionTitle" sectionId={thing.sectionId} />, body: t("next.startSectionBody"), action: t("next.openSection") };
    case "all-ready":
      return { title: t("next.allReadyTitle", { total: REPORT_SECTIONS.length }), body: t("next.allReadyBody"), action: t("next.allReadyAction") };
  }
}

export function useNextWords(thing: NextThing): NextWords {
  const { t } = useTranslation();
  return nextWords(t, thing);
}
