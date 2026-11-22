/*
 * Every string the interface shows, in English. src/renderer/src/i18n/es.ts has exactly
 * the same keys (TypeScript and tests/i18n.test.ts both check it).
 *
 * Not here, on purpose: the clinical terms and section names that stay English in both
 * languages (src/renderer/src/i18n/terms.ts and src/shared/report-sections.ts). Inside a
 * sentence, such a term is wrapped in <term></term>, which the screen renders with
 * lang="en" so a screen reader reads it in English.
 */
export const en = {
  app: {
    name: "ABA Workbench",
    skipToContent: "Skip to content",
    pageTitle: "{{page}} · ABA Workbench",
  },
  nav: {
    mainLabel: "Main",
    cases: "Cases",
    settings: "Settings",
    devCheck: "Development check",
    menu: "Menu",
    menuTitle: "Navigation",
    closeMenu: "Close menu",
    allCases: "All cases",
    stepsLabel: "Steps of the case",
    sectionsHeading: "Sections",
    languageLabel: "Screen language",
  },
  /** Each language's own name, as the language switch and the Select show it. */
  languages: {
    en: "English",
    es: "Español",
  },
  /** Each language's name inside a sentence of the screen language ("will open in Spanish"). */
  languageInSentence: {
    en: "English",
    es: "Spanish",
  },
  ai: {
    notConnected: "AI not connected",
    notConnectedHint: "Connecting Claude or ChatGPT arrives in a later version. Until then, nothing is sent anywhere.",
  },
  status: {
    notStarted: "Not started",
    notRun: "Not run",
    notAvailableYet: "Not available yet",
  },
  steps: {
    sources: "Sources",
    report: "Report",
    review: "Review and copy",
    position: "Step {{number}} of {{total}}",
  },
  home: {
    title: "Cases",
    newCase: "New case",
    emptyTitle: "No cases yet",
    emptyBody: "A case keeps one client's sources and the assessment drafted from them, on this computer.",
    emptyNext: "Creating and opening cases arrives in the next version. Until then, you can see how a case is laid out, or choose the screen language.",
    previewCase: "Preview a case",
    openSettings: "Open Settings",
    newCaseDialogTitle: "New case",
    newCaseDialogBody:
      "Creating cases arrives in the next version of ABA Workbench. You will choose a folder on this computer for your cases, then add each client's sources.",
    newCaseDialogClose: "Got it",
  },
  case: {
    previewName: "Case preview",
    previewDetail: "No case is open. This only shows how a case is laid out.",
    notFoundTitle: "This case was not found",
    notFoundBody: "Opening saved cases arrives in the next version.",
    backToCases: "Back to cases",
  },
  workspace: {
    placeholderBadge: "Not built yet",
    sourcesBody:
      "Here you will add the client's documents: evaluations and score reports as PDFs, interviews and observation notes as text. They stay on this computer, in the case's folder.",
    behaviorsBody: "Here you will list the client's target <term>Behaviors</term>, taken from the sources, and confirm each one before the report is drafted.",
    interventionsBody: "Here you will choose the <term>Interventions</term> for each target behavior and skill, which the report then describes.",
    reportBody: "The report is drafted one section at a time, in English, from the case's sources and the writing rules. Choose a section to see where its draft will go.",
    reportSectionColumn: "Section",
    reportStatusColumn: "Status",
    reportNumberColumn: "Number",
    sectionPosition: "Section {{number}} of {{total}}",
    sectionBody: "The draft of this section will appear here, written in English from the case's sources, for you to read, edit and approve.",
    reviewBody: "Here you will read the whole assessment once more, resolve anything still marked as missing, and copy each section to paste into ABA Matrix.",
  },
  rail: {
    label: "Sources and checks",
    sources: "Sources",
    noSources: "No sources yet.",
    checks: "Checks",
    checkStructure: "Section structure",
    checkMissing: "Missing data",
    checkContradictions: "Contradictions",
  },
  settings: {
    title: "Settings",
    languageHeading: "Screen language",
    languageLabel: "Language",
    languageDescription:
      "The language of menus, buttons and messages. The assessment is always written in English, and clinical terms such as <term>Behaviors</term>, <term>Interventions</term> and the section names stay in English.",
    languageSaved: "Saved. The app will open in {{language}} next time.",
    languageNotSaved: "Shown in {{language}} for now, but the choice could not be saved: the app will open in {{previous}} next time.",
    casesFolderHeading: "Cases folder",
    casesFolderBody: "The folder on this computer where your cases are kept. Choosing it arrives in the next version.",
    aiHeading: "AI connection",
    aiBody: "Connecting Claude or ChatGPT to draft sections arrives in a later version. Until then, nothing is sent anywhere.",
    aboutHeading: "About",
    aboutApplication: "Application",
    aboutVersion: "Version",
  },
  notFound: {
    title: "This screen does not exist",
    body: "The link may be out of date.",
    backToCases: "Go to cases",
  },
};

export type Messages = typeof en;
