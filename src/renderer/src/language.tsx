import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isLanguage, type Language } from "../../shared/api.ts";

/*
 * The screen language, and the one the main process has saved (the language the app
 * will open in next time). Both live here, once for the whole app, so the sidebar and
 * Settings always tell the same story: when they differ, the last choice could not be
 * saved, and every message that says so names the saved one.
 */

interface LanguageState {
  /** The language on screen. */
  language: Language;
  /** The language in the settings file: the one the app opens in next time. */
  savedLanguage: Language;
  /**
   * Saves the choice, then shows it. If the main process cannot save it, the screen
   * still changes for this session, so the user can work in the language they chose,
   * and the promise resolves false; savedLanguage is then read back from the main process.
   */
  changeLanguage: (language: Language) => Promise<boolean>;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ initialSaved, children }: { initialSaved: Language; children: ReactNode }) {
  const { i18n } = useTranslation();
  const language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  const [savedLanguage, setSavedLanguage] = useState<Language>(initialSaved);

  const changeLanguage = useCallback(
    async (next: Language) => {
      try {
        const saved = (await window.aba.setLanguage(next)).language;
        setSavedLanguage(saved);
        await i18n.changeLanguage(saved);
        return true;
      } catch {
        // What is on disk, not what was on screen: after two failed saves in a row the
        // screen shows a language that was never saved.
        const saved = await window.aba.getSettings().then(
          (settings) => settings.language,
          () => null,
        );
        if (saved) setSavedLanguage(saved);
        await i18n.changeLanguage(next);
        return false;
      }
    },
    [i18n],
  );

  const value = useMemo(() => ({ language, savedLanguage, changeLanguage }), [language, savedLanguage, changeLanguage]);
  return <LanguageContext value={value}>{children}</LanguageContext>;
}

export function useLanguage(): LanguageState {
  const state = useContext(LanguageContext);
  if (!state) throw new Error("useLanguage needs a LanguageProvider.");
  return state;
}
