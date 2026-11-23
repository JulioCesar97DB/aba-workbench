import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Settings } from "../../shared/api.ts";
import { App } from "./App.tsx";
import { flushAllSaves, holdUnloadForSaves, refreshFailedSaves } from "./case-saves.tsx";
import { initI18n } from "./i18n/index.ts";
import { LanguageProvider } from "./language.tsx";
import "./styles/fonts.ts";
import "./styles/app.css";

// A file dropped anywhere but where a screen takes it (the Sources step) does nothing:
// without this the window would try to open it (the main process blocks that anyway).
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
}

// Before the window closes or the app quits, every save still waiting is made (case-saves.tsx).
window.aba.onFlushSaves(flushAllSaves);
// A reload sends what is still waiting, and is held while saves are under way.
window.addEventListener("beforeunload", holdUnloadForSaves);
// What could not be saved before a reload is still known to the main process.
void refreshFailedSaves();

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
