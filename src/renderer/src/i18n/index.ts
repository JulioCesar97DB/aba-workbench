import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { LANGUAGES, type Language } from "../../../shared/api.ts";
import { en } from "./en.ts";
import { es } from "./es.ts";

export const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

/** Starts i18next in the saved language and keeps <html lang> in step with it. */
export async function initI18n(language: Language): Promise<void> {
  i18next.on("languageChanged", (lng) => {
    document.documentElement.lang = lng;
  });
  await i18next.use(initReactI18next).init({
    resources,
    lng: language,
    supportedLngs: [...LANGUAGES],
    fallbackLng: "en",
    // React escapes what it renders.
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = i18next.language;
}

export { i18next };
