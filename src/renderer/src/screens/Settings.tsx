import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, type Language } from "../../../shared/api.ts";
import { useAppInfo } from "../app-info.tsx";
import { Select } from "../components/Select.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Table, TableBody, TableCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { useLanguage } from "../language.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

/** Settings: the screen language today; the cases folder and the AI connection arrive later. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const info = useAppInfo();
  const { language, savedLanguage, changeLanguage } = useLanguage();
  // True after a change made here was saved, to confirm it.
  const [justSaved, setJustSaved] = useState(false);
  // The screen and the settings file disagree: the last choice, here or in the sidebar, was not saved.
  const notSaved = language !== savedLanguage;

  async function onLanguageChange(next: Language) {
    setJustSaved(await changeLanguage(next));
  }
  const inSentence = (lng: Language) => t(`languageInSentence.${lng}`);

  return (
    <WorkArea header={<PageHeader title={t("settings.title")} />} contentClassName="max-w-3xl">
      <SettingsSection heading={t("settings.languageHeading")}>
        <Select
          label={t("settings.languageLabel")}
          description={<TransWithTerms i18nKey="settings.languageDescription" />}
          value={language}
          options={LANGUAGES.map((option) => ({ value: option, label: t(`languages.${option}`), lang: option }))}
          onValueChange={(next) => void onLanguageChange(next)}
        />
        <p role="status" className={notSaved ? "text-sm font-medium text-danger" : "text-sm text-fg-muted"}>
          {notSaved
            ? t("settings.languageNotSaved", { language: inSentence(language), previous: inSentence(savedLanguage) })
            : justSaved
              ? t("settings.languageSaved", { language: inSentence(language) })
              : null}
        </p>
      </SettingsSection>

      <SettingsSection heading={t("settings.casesFolderHeading")} badge={t("status.notAvailableYet")}>
        <p className="max-w-measure text-fg-muted">{t("settings.casesFolderBody")}</p>
      </SettingsSection>

      <SettingsSection heading={t("settings.aiHeading")} badge={t("status.notAvailableYet")}>
        <p className="max-w-measure text-fg-muted">{t("settings.aiBody")}</p>
      </SettingsSection>

      <SettingsSection heading={t("settings.aboutHeading")}>
        {info ? (
          <Table className="max-w-sm text-base">
            <TableBody>
              <TableRow>
                <TableRowHeader>{t("settings.aboutApplication")}</TableRowHeader>
                <TableCell>{info.name}</TableCell>
              </TableRow>
              <TableRow>
                <TableRowHeader>{t("settings.aboutVersion")}</TableRowHeader>
                <TableCell className="font-mono text-sm">{info.version}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ) : null}
      </SettingsSection>
    </WorkArea>
  );
}

function SettingsSection({ heading, badge, children }: { heading: string; badge?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 border-b border-border py-5 first:pt-0 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          {heading}
        </h2>
        {badge ? <StatusBadge>{badge}</StatusBadge> : null}
      </div>
      {children}
    </section>
  );
}