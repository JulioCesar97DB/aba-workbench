import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, type CasesFolderInfo, type Language } from "../../../shared/api.ts";
import { useAppInfo } from "../app-info.tsx";
import { casesFolderProblemText, useShowInFolderLabel } from "../cases-folder.tsx";
import { Button } from "../components/Button.tsx";
import { Select } from "../components/Select.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { Table, TableBody, TableCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TransWithTerms } from "../components/Trans.tsx";
import { useLanguage } from "../language.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

/** Settings: the screen language and the cases folder; the AI connection arrives later. */
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

      <CasesFolderSection />

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

/**
 * Where the cases are kept. The main process sends the folder's path as text to show; a
 * new folder can only come from the system's folder dialog, which the main process opens.
 */
function CasesFolderSection() {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const showLabel = useShowInFolderLabel();
  const [folder, setFolder] = useState<CasesFolderInfo | null>(null);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  useEffect(() => {
    window.aba.getCasesFolder().then(setFolder, () => setFolder(null));
  }, []);

  async function choose() {
    try {
      const result = await window.aba.chooseCasesFolder();
      if (result.outcome === "chosen") {
        setFolder(result.folder);
        setMessage({ text: t("casesFolder.chosen"), problem: false });
      } else if (result.outcome === "unusable") {
        setMessage({ text: `${t("casesFolder.unusable")} ${casesFolderProblemText(t, result.problem, platform)}`, problem: true });
      } else if (result.outcome === "not-saved") {
        setMessage({ text: t("casesFolder.notSaved"), problem: true });
      }
    } catch {
      setMessage({ text: t("casesFolder.failed"), problem: true });
    }
  }

  const problem = folder && folder.state !== "ready" && folder.state !== "not-created-yet" ? folder.state : null;
  const canShow = folder?.state === "ready" || folder?.state === "not-writable";
  return (
    <SettingsSection heading={t("settings.casesFolderHeading")}>
      <p className="max-w-measure text-fg-muted">{t("settings.casesFolderBody")}</p>
      {folder ? (
        <dl className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <dt className="font-medium">{t("settings.casesFolderLabel")}</dt>
            {folder.isDefault ? <StatusBadge>{t("casesFolder.defaultBadge")}</StatusBadge> : null}
          </div>
          <dd className="max-w-measure font-mono text-sm break-all" data-testid="cases-folder-path">
            {folder.displayPath}
          </dd>
          {problem ? <dd className="max-w-measure text-sm font-medium text-danger">{casesFolderProblemText(t, problem, platform)}</dd> : null}
          {folder.state === "not-created-yet" ? <dd className="text-sm text-fg-muted">{t("casesFolder.notCreatedYet")}</dd> : null}
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void choose()}>{t("casesFolder.choose")}</Button>
        <Button disabled={!canShow} focusableWhenDisabled onClick={() => void window.aba.showCasesFolder()}>
          {showLabel}
        </Button>
      </div>
      <p role="status" className={message?.problem ? "max-w-measure text-sm font-medium text-danger" : "max-w-measure text-sm text-fg-muted"}>
        {message?.text}
      </p>
      <p className="max-w-measure text-sm text-fg-muted">{t("settings.casesFolderChangeNote")}</p>
    </SettingsSection>
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
