import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Settings } from "../../shared/api.ts";
import { App } from "./App.tsx";
import { initI18n } from "./i18n/index.ts";
import { LanguageProvider } from "./language.tsx";
import "./styles/fonts.ts";
import "./styles/app.css";

async function start() {
  // The saved language first, so the first screen is already in it.
  const settings: Settings = await window.aba.getSettings().catch(() => ({ language: "en" }));
  await initI18n(settings.language);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <LanguageProvider initialSaved={settings.language}>
        <App />
      </LanguageProvider>
    </StrictMode>,
  );
}

void start();
