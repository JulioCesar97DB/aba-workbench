import type { Messages } from "./en.ts";

/*
 * Todo el texto de la interfaz en español, con las mismas claves que en.ts. Los términos
 * clínicos y los nombres de las secciones se quedan en inglés (<term></term>), como en
 * los formularios de la clínica.
 */
export const es: Messages = {
  app: {
    name: "ABA Workbench",
    skipToContent: "Saltar al contenido",
    pageTitle: "{{page}} · ABA Workbench",
  },
  nav: {
    mainLabel: "Principal",
    cases: "Casos",
    settings: "Ajustes",
    devCheck: "Comprobación de desarrollo",
    menu: "Menú",
    menuTitle: "Navegación",
    closeMenu: "Cerrar el menú",
    allCases: "Todos los casos",
    stepsLabel: "Pasos del caso",
    sectionsHeading: "Secciones",
    languageLabel: "Idioma de la pantalla",
  },
  languages: {
    en: "English",
    es: "Español",
  },
  languageInSentence: {
    en: "inglés",
    es: "español",
  },
  ai: {
    notConnected: "IA sin conectar",
    notConnectedHint: "La conexión con Claude o ChatGPT estará disponible en una versión posterior. Hasta entonces no se envía nada a ninguna parte.",
  },
  status: {
    notStarted: "Sin empezar",
    notRun: "No realizada",
    notAvailableYet: "Aún no disponible",
  },
  steps: {
    sources: "Fuentes",
    report: "Informe",
    review: "Revisión y copia",
    position: "Paso {{number}} de {{total}}",
  },
  home: {
    title: "Casos",
    newCase: "Nuevo caso",
    emptyTitle: "Todavía no hay casos",
    emptyBody: "Un caso reúne las fuentes de un cliente y la evaluación redactada a partir de ellas, en esta computadora.",
    emptyNext: "Podrás crear y abrir casos en la próxima versión. Mientras tanto, puedes ver cómo se organiza un caso o elegir el idioma de la pantalla.",
    previewCase: "Ver un caso de muestra",
    openSettings: "Abrir Ajustes",
    newCaseDialogTitle: "Nuevo caso",
    newCaseDialogBody:
      "Podrás crear casos en la próxima versión de ABA Workbench. Elegirás una carpeta de esta computadora para tus casos y luego agregarás las fuentes de cada cliente.",
    newCaseDialogClose: "Entendido",
  },
  case: {
    previewName: "Caso de muestra",
    previewDetail: "No hay ningún caso abierto. Solo muestra cómo se organiza un caso.",
    notFoundTitle: "No se encontró este caso",
    notFoundBody: "Podrás abrir casos guardados en la próxima versión.",
    backToCases: "Volver a los casos",
  },
  workspace: {
    placeholderBadge: "En preparación",
    sourcesBody:
      "Aquí agregarás los documentos del cliente: evaluaciones e informes de puntajes en PDF, entrevistas y notas de observación como texto. Se quedan en esta computadora, en la carpeta del caso.",
    behaviorsBody: "Aquí anotarás los <term>Behaviors</term> objetivo del cliente, sacados de las fuentes, y confirmarás cada uno antes de redactar el informe.",
    interventionsBody: "Aquí elegirás las <term>Interventions</term> para cada conducta y habilidad objetivo, que luego describe el informe.",
    reportBody: "El informe se redacta sección por sección, en inglés, a partir de las fuentes del caso y de las reglas de redacción. Elige una sección para ver dónde irá su borrador.",
    reportSectionColumn: "Sección",
    reportStatusColumn: "Estado",
    reportNumberColumn: "Número",
    sectionPosition: "Sección {{number}} de {{total}}",
    sectionBody: "Aquí aparecerá el borrador de esta sección, escrito en inglés a partir de las fuentes del caso, para que lo leas, lo edites y lo apruebes.",
    reviewBody: "Aquí leerás la evaluación completa una vez más, resolverás lo que siga marcado como faltante y copiarás cada sección para pegarla en ABA Matrix.",
  },
  rail: {
    label: "Fuentes y comprobaciones",
    sources: "Fuentes",
    noSources: "Todavía no hay fuentes.",
    checks: "Comprobaciones",
    checkStructure: "Estructura de la sección",
    checkMissing: "Datos faltantes",
    checkContradictions: "Contradicciones",
  },
  settings: {
    title: "Ajustes",
    languageHeading: "Idioma de la pantalla",
    languageLabel: "Idioma",
    languageDescription:
      "El idioma de los menús, los botones y los mensajes. La evaluación se escribe siempre en inglés, y los términos clínicos como <term>Behaviors</term>, <term>Interventions</term> y los nombres de las secciones se quedan en inglés.",
    languageSaved: "Guardado. La aplicación se abrirá en {{language}} la próxima vez.",
    languageNotSaved: "Se muestra en {{language}} por ahora, pero no se pudo guardar: la próxima vez la aplicación se abrirá en {{previous}}.",
    casesFolderHeading: "Carpeta de casos",
    casesFolderBody: "La carpeta de esta computadora donde se guardan tus casos. Podrás elegirla en la próxima versión.",
    aiHeading: "Conexión con la IA",
    aiBody: "La conexión con Claude o ChatGPT para redactar secciones estará disponible en una versión posterior. Hasta entonces no se envía nada a ninguna parte.",
    aboutHeading: "Acerca de",
    aboutApplication: "Aplicación",
    aboutVersion: "Versión",
  },
  notFound: {
    title: "Esta pantalla no existe",
    body: "Puede que el enlace esté desactualizado.",
    backToCases: "Ir a los casos",
  },
};
