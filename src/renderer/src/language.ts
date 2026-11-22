import { useTranslation } from "react-i18next";
import { isLanguage, type Language } from "../../shared/api.ts";

/** Thrown by changeLanguage when the main process could not save the choice. */
export class LanguageNotSavedError extends Error {
  /** The language the app will open in next time: the one saved before. */
  readonly previous: Language;
  constructor(previous: Language) {
    super("The language could not be saved.");
    this.previous = previous;
  }
}

/**
 * The screen language and the way to change it. The main process saves the choice
 * (window.aba.setLanguage). If saving fails, the screen still changes for this session,
 * so the user can work in the language they chose, and changeLanguage throws
 * LanguageNotSavedError so the screen can say it will not be remembered.
 */
export function useLanguage(): { language: Language; changeLanguage: (language: Language) => Promise<void> } {
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  const changeLanguage = async (next: Language) => {
    const previous = language;
    let saved: Language;
    try {
      saved = (await window.aba.setLanguage(next)).language;
    } catch {
      await i18n.changeLanguage(next);
      throw new LanguageNotSavedError(previous);
    }
    await i18n.changeLanguage(saved);
  };
  return { language, changeLanguage };
}
