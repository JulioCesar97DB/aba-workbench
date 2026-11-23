import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AppInfo, CasesFolderProblem } from "../../shared/api.ts";
import { useAppInfo } from "./app-info.tsx";

/** What is wrong with the cases folder, in plain words (with the macOS privacy setting on a Mac). */
export function casesFolderProblemText(t: TFunction, problem: CasesFolderProblem, platform: AppInfo["platform"] | undefined): string {
  if (problem === "not-allowed") return platform === "mac" ? t("casesFolder.not-allowed-mac") : t("casesFolder.not-allowed");
  return t(`casesFolder.${problem}`);
}

/** "Show in Finder", "Show in Explorer" or "Show in file manager". */
export function useShowInFolderLabel(): string {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  return platform === "mac" ? t("casesFolder.showMac") : platform === "windows" ? t("casesFolder.showWindows") : t("casesFolder.showLinux");
}
