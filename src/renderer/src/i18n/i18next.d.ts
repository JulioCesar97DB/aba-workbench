import type { en } from "./en.ts";

// Typed keys: t("home.title") is checked against en.ts at compile time.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
