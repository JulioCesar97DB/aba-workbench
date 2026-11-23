import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, type AiPreferences, type CasesFolderInfo, type DraftingProvider, type Language } from "../../../shared/api.ts";
import { MODEL_CHOICES } from "../../../shared/models.ts";
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
import { ConnectionsSection } from "./Connections.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/**
 * Settings, in the order she needs them (owner's decision U12): the AI connection first,
 * with the model as one line under it, then the screen language, the cases folder and About.
 */
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
      <ConnectionsSection>
        <ModelLine />
      </ConnectionsSection>

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
    window.aba.getCasesFolder().then(
      (info) => {
        setFolder(info);
        // A failure to check it an earlier time no longer holds.
        setMessage((current) => (current?.text === t("casesFolder.readFailed") ? null : current));
      },
      () => {
        setFolder(null);
        setMessage({ text: t("casesFolder.readFailed"), problem: true });
      },
    );
  }, [t]);

  async function show() {
    const shown = await window.aba.showCasesFolder().catch(() => false);
    setMessage(shown ? null : { text: t("casesFolder.showFailed"), problem: true });
  }

  async function choose() {
    try {
      const result = await window.aba.chooseCasesFolder();
      if (result.outcome === "chosen") {
        setFolder(result.folder);
        setMessage({ text: t("casesFolder.chosen"), problem: false });
      } else if (result.outcome === "unusable") {
        setMessage({ text: `${t("casesFolder.unusable")} ${casesFolderProblemText(t, result.problem, platform)}`, problem: true });
      } else if (result.outcome === "inside-app") {
        setMessage({ text: t("casesFolder.insideApp"), problem: true });
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
      <p className="max-w-measure text-fg-muted">{t("settings.casesFolderSyncNote")}</p>
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
        <Button disabled={!canShow} focusableWhenDisabled onClick={() => void show()}>
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

/**
 * The model each provider writes with (owner's decision, 2026-11-22): the most capable by
 * default, or the other one offered, which costs about half as much. One line under the AI
 * connection says which is used (U12); "Change" opens the choice for each provider.
 */
function ModelLine() {
  const { t } = useTranslation();
  const choicesId = useId();
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<AiPreferences | null>(null);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  useEffect(() => {
    window.aba.getAiPreferences().then(setPreferences, () => setMessage({ text: t("settings.modelsReadFailed"), problem: true }));
  }, [t]);

  async function choose(provider: DraftingProvider, model: string) {
    try {
      setPreferences(await window.aba.setModel(provider, model));
      setMessage({ text: t("settings.modelSaved"), problem: false });
    } catch {
      setMessage({ text: t("settings.modelNotSaved"), problem: true });
    }
  }

  const providers = ["openai", "anthropic"] as const;
  const providerName = (provider: DraftingProvider) => (provider === "anthropic" ? t("settings.modelClaude") : t("settings.modelChatgpt"));
  const best = (provider: DraftingProvider) => preferences?.models[provider] === MODEL_CHOICES[provider][0].id;
  const choiceText = (provider: DraftingProvider) => (best(provider) ? t("settings.modelBest") : t("settings.modelLower"));
  // One choice when both providers use the same kind of model; otherwise each by name.
  const summary = preferences
    ? best("openai") === best("anthropic")
      ? choiceText("openai")
      : providers.map((provider) => t("settings.modelEach", { provider: providerName(provider), choice: choiceText(provider) })).join(" · ")
    : null;

  return (
    <div className="flex flex-col gap-2.5">
      {preferences ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-fg-muted">{t("settings.modelLabel")}</span>{" "}
          <span>{summary}</span>{" "}
          <Button size="sm" aria-expanded={open} aria-controls={choicesId} onClick={() => setOpen((value) => !value)}>
            {t("settings.modelChange")}
          </Button>
        </p>
      ) : null}
      {preferences && open ? (
        <div id={choicesId} className="flex flex-col gap-2.5">
          <p className="max-w-measure text-sm text-fg-muted">{t("settings.modelsBody")}</p>
          <div className="flex flex-wrap gap-6">
            {providers.map((provider) => (
              <div key={provider} className="min-w-60">
                <Select
                  label={providerName(provider)}
                  value={preferences.models[provider]}
                  options={MODEL_CHOICES[provider].map((choice, index) => ({ value: choice.id, label: index === 0 ? t("settings.modelMostCapable", { model: choice.label }) : t("settings.modelLowerCost", { model: choice.label }), lang: undefined }))}
                  onValueChange={(value) => void choose(provider, value)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <p role="status" className={message?.problem ? "max-w-measure text-sm font-medium text-danger" : "max-w-measure text-sm text-fg-muted"}>
        {message?.text}
      </p>
    </div>
  );
}
