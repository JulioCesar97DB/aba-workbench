import { useTranslation } from "react-i18next";
import { isLanguage, type Language } from "../../shared/api.ts";

/**
 * The screen language and the way to change it. A change is saved by the main process
 * first (window.aba.setLanguage) and shown only once saved, so the screen never shows a
 * language the next start would not.
 */
export function useLanguage(): { language: Language; changeLanguage: (language: Language) => Promise<void> } {
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  const changeLanguage = async (next: Language) => {
    const saved = await window.aba.setLanguage(next);
    await i18n.changeLanguage(saved.language);
  };
  return { language, changeLanguage };
}
