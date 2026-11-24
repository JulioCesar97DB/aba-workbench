# The interface

How the React interface in `src/renderer/` is organized: its look (direction C, "compact panel"), its parts, its two languages, and the rules every screen follows. How it talks to the main process is in [desktop.md](desktop.md).

## The look

Direction C, chosen by the owner from three mockups: a dark sidebar with the case, its five steps and the report's sections; a light working area under a compact header; a light grey right rail for documents and checks. IBM Plex Sans for every sentence, the header's detail line included; IBM Plex Mono only for numbers, versions and paths (a step's count, "v3", a cost, the cases folder's path; owner's decision T17), wrapped in `Mono` (`shell/PageHeader.tsx`) when they sit inside a sentence; an amber accent for the main action, links and focus. Dense, but every control is at least 44 px tall. One theme for now.

The fonts come from the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` packages: Vite copies the font files into the build and the app loads them from its own files. The interface makes no network request of its own. They are under the SIL Open Font License 1.1, which asks every copy to carry IBM's notice and the license: `licenses/IBM-Plex-OFL.txt` (from IBM's own repository) ships in the packaged app's resources folder, `tests/licenses.test.ts` checks it against the license the font packages carry, and the packaged window tests check it is in the app. See [licenses/README.md](../licenses/README.md).

## Where things are

| Path | What it holds |
| --- | --- |
| `src/renderer/src/main.tsx` | Start-up: reads the saved settings, starts i18next in that language, renders the app. |
| `src/renderer/src/App.tsx` | The screens and their addresses (React Router), and the providers around them. One shell route holds every screen. |
| `src/renderer/src/styles/tokens.css` | **The design tokens**: every color, type size, radius, shadow and fixed size. |
| `src/renderer/src/styles/app.css` | Tailwind, the tokens, and the few rules that apply everywhere (body text, the focus ring). |
| `src/renderer/src/styles/fonts.ts` | Which Plex weights ship. |
| `src/renderer/src/components/` | **The project's own components**, on Base UI where it has the part: `Button`, `TextLink` and `ButtonLink`, `Select`, `Dialog` (a centered box or a side panel), `Tooltip`, `Table`, `StatusBadge`, `NavItem`, `StepNavItem` and `SectionNavItem`, `Term`. |
| `src/renderer/src/shell/` | The frame: `AppShell` (rendered once: the sidebar for the app or for the case, the working area, the Menu panel on a narrow window, the skip link, the announcement and focus after a navigation), `Sidebar`, `NotesPanel` (today's notes, opened from the case's sidebar), `TrialBar` (the line above every screen saying the app is not ready for real client data), `PageHeader`, `WorkArea` (a screen's `<main>`: header, content and right rail). |
| `src/renderer/src/screens/` | One file per screen: `Home` ("Pick up where you left off", the cases with their progress, and the New case form), `CaseSummary` (where a case opens), `ComingLater` (Plan and Review and copy, not built yet), `Case` (opening a case, the report's table), `Sources` (the Documents step), `SourceText` (a pasted text), `CaseMap` (the case map), `Section` (one section of the report), `Settings` and `Connections` (its AI connection), `NotFound`, `DevCheck`. |
| `src/renderer/src/open-case.tsx` | The open case: AppShell loads it when the address enters a case, so the sidebar shows its label and the screens its data; a saved change to its sources replaces them there. |
| `src/renderer/src/case-saves.tsx` | Every case's saves, for the whole app: the save state the screens show ("Saving…", "All changes saved", what was not saved and "Try again"), the failures Home lists (read from the main process, so a reload keeps them), and saving everything before the window closes or the page reloads. |
| `src/renderer/src/source-details.tsx` | A source's type, title and date fields: one state before and after a new text exists. |
| `src/renderer/src/source-labels.tsx` | A source's name, type, size and date as the screens show them. |
| `src/renderer/src/language.tsx` | The screen language and the saved one, shared by the sidebar and Settings. |
| `src/renderer/src/connections.tsx` | The AI connections' state, shared by the sidebar and Settings, kept current by the main process's updates ([connections.md](connections.md)). |
| `src/renderer/src/case-steps.tsx`, `steps.ts`, `step-states.ts` | The five steps: their paths, their names and subtitles in the screen language, and their states and counts in the sidebar. |
| `src/renderer/src/next-thing.ts`, `next-thing-words.tsx` | "Lo siguiente": the one next thing to do in a case, by the rule of the owner's proposal §6 (computed, nothing stored), where it is done, the step the case is at; and its words. |
| `src/renderer/src/ai-errors.ts` | What a failed AI request means for her, by error code: the kind of failure whose sentence the section screen shows. |
| `src/renderer/src/format.ts`, `cases-folder.tsx` | Ages and dates in the screen language, and the order of the system's date field; the cases folder's problems in words, and "Show in Finder / Explorer". |
| `src/renderer/src/i18n/` | The strings: `en.ts`, `es.ts`, the English-only clinical terms (`terms.ts`) and i18next's set-up. |
| `src/shared/report-sections.ts` | The report's sections and their English titles, shared with the main process. |
| `src/shared/theme.ts` | The two design values code needs outside the stylesheet (the window's background, the sidebar breakpoint); a test keeps them equal to the tokens. |

## Screens and addresses

React Router keeps the address in the URL's hash (`#/settings`). The app's page never navigates (the main process blocks it, see [desktop.md](desktop.md)); a hash change stays inside the page, and a reload comes back to the same screen.

| Address | Screen |
| --- | --- |
| `#/` | Home (UX-5, mockup 01): "Pick up where you left off" with the case saved last (the first in the list), its step, its progress, when it was saved, its next thing and Continue (straight to that next thing, T7); then "Your cases", the case saved last first (by its `updatedAt`, then by when it was made; owner's decision on UX-5 review round 1, as mockup 01; opening a case does not move it), one row per case: its name (to its summary), age, step and progress in words, the five-segment bar of its steps' states, when it was saved, and Continue (to its next thing) or, once everything is done, Open (to its summary). A case whose progress could not be read (a file a later version wrote, say) is still listed, with its age, when it was saved and Open; below them the folders that could not be opened. "New case" is the header's primary action only while there is no case. With none, what a case is and New case; while no AI is connected, "Connect the AI so it can draft" with Connect ChatGPT (a card on an empty Home, a slim bar above the list; P7). When the cases folder cannot be used, why and a way to choose another (as before). |
| `#/cases/<id>` | **The case summary** ("Resumen del caso", owner's decision T6), where a case opens: below. |
| `#/cases/<id>/sources` | The Documents step (the path keeps its first name, owner's decision T13): the case's documents, PDFs in its folder that are not documents of the case, removed documents (below). |
| `#/cases/<id>/sources/text/<source-id>`, `#/cases/<id>/sources/new/<type>` | A pasted text, to read and edit; a new one of that type. |
| `#/cases/<id>/case-map` | The case map ([case-map.md](case-map.md)), shown as "Case map" / "Mapa del caso". |
| `#/cases/<id>/interventions`, `/review` | "Plan" and "Review and copy" (paths unchanged, T13): not built yet, so each says so honestly (below, "Steps not built yet"). In every screen of a case the sidebar shows its name (a link to its summary) and age, its steps with their states, the report's sections while she is in the report or its review, and a button that opens today's notes. An id that is not a case, or a case that cannot be opened, says so. |
| `#/cases/<id>/report` | The report's sections, each with its state (not started, yours, draft version N, approved). |
| `#/cases/<id>/report/<section-id>` | One section of the report (ids in `src/shared/report-sections.ts`), `screens/Section.tsx`: start it the two ways ("A mano": paste or type what she wrote; "Con la IA": draft it), watch it written, read it in numbered paragraphs, mark one to change only it, ask for changes in the request box docked at the foot, edit by hand, pick a version in the version menu, approve, then copy for ABA Matrix; the rail holds "Siguiente paso", the checks before approving, her instructions for the section and what the version used ([sections.md](sections.md), "The screen"). |
| `#/settings` | In the order she needs them (owner's decision U12): the AI connection first, with one sentence on what the AI does and when anything is sent, one card for ChatGPT (Continue with ChatGPT, signing in, signed in as, check, manage usage, sign out, needs attention) and one for Claude (paste, check and save, check, remove), each with its state in words (`screens/Connections.tsx`), then the model as one line ("Model: the most capable (recommended)", with "Change" opening the choice for each provider); the screen language; the cases folder (its path, "Choose another folder…", "Show in Finder", and a message when the folder cannot be shown or checked); About. |
| `#/dev-check` | The development check (mock generation). Linked from the sidebar only when the app runs from the repository (`getAppInfo().developmentBuild`); the packaged app has no link to it, and the window tests open it by address. It is a developer screen, in English only. |

## The case summary and "Lo siguiente" (UX-5)

Owner's proposal §4 ("Resumen del caso", "Home", "3 · Plan", "Picking up a half-done assessment") and §6, mockups 01, 03 and 12; decisions T6, T7, T13, P3, P7, P8.

- **Where a case opens.** `#/cases/<id>` is the summary (T6); the other paths are unchanged (T13). The case's name at the top of the sidebar links to it (current while it is shown). A new case still opens on Documentos.
- **"Lo siguiente"** (`next-thing.ts`). The first that applies: (1) a change that could not be saved, "Hay un cambio sin guardar", whose button is "Volver a intentar" (it runs that change again; once saved, the case is read again); (2) no document, "Agrega los documentos del cliente"; (3) a section with an AI draft not approved, the first in ABA Matrix's order, "Revisa el borrador de <section>"; (4) a part of the case map with content and not approved, "Aprueba «<part>» en el mapa del caso" (to `case-map?part=<part>`); (5) no case map and no section yet, "Arma el mapa del caso"; (6) the first section not started, "Empieza <section>"; (8) everything done, "Las 9 secciones están listas". Rule 7 (approved sections not copied) needs the copied marks of UX-7 (T8): it is left out, and UX-7 adds `copied` to the inputs and one entry to `RULES` before the end. Nothing is stored (T7, P8): it is computed from the case's data each time; Home gets each case's `progress` from `listCases`, and the opened case carries the same `progress` (`openCase`), so the summary names the part to approve at once; the summary reads the map again through its own `getCaseMap` (read only) whenever the map's counts change in the window, so it never names a part already approved. The map's counts here are its parts with something in them and how many of those are approved (`src/shared/case-progress.ts`): a part approved while empty is not counted, so "approved" never exceeds the parts with content. The case's step on Home is the step of its next piece of work (the change not saved aside).
- **The summary.** Header: the case's name as the eyebrow, "Resumen del caso", no actions. The "LO SIGUIENTE" card (amber edge, the light amber tint of mockup 03, `--color-next-subtle`): one sentence, one more, and the screen's one primary button. "Cómo va la evaluación": the five steps, each with its circle (the sidebar's marks on a light surface, `StepCircle`), its state in a sentence (documents and their types; parts approved; sections ready, approved, yours and drafts waiting) and a secondary button (Empezar, Seguir, Ver) whose name also says the step; Plan and Review and copy show "Pronto" and have no button. Then "Dos formas de trabajar, en cada paso", the two ways as a legend (`TwoWays` bar with the `Tuya` and `Borrador de la IA` chips). No rail.
- **Steps not built yet** (`ComingLater.tsx`, §3.5, P3). A `StepHeader` ("Paso 3 de 5", the name, a dashed "Llega más adelante" chip), a dashed card "Este paso todavía no está en la app" with what it will do, what to do meanwhile, the screen's primary button to the next useful step and a secondary one, then the two ways as cards ("Hoy…" / "Después…"). Plan: [Seguir con el Informe] [Volver al Mapa del caso]. Review and copy, until UX-7: [Ir al Informe] [Ver el Resumen del caso]. "Siguiente paso" skips them: once every section is ready, a section's "Siguiente paso" goes to the case summary.
- **Home's bar** (`StepProgressBar`): five segments, the steps' states as the sidebar computes them (`step-states.ts`): green done, amber in progress, grey not started, dashed not built yet. It is an image whose name says each step and its state.

## Design tokens

All of them are in `src/renderer/src/styles/tokens.css`, inside Tailwind's `@theme`, so each one is also a utility class: `--color-fg-muted` gives `text-fg-muted`, `--spacing-control` gives `min-h-control`, `--text-sm` gives `text-sm`. Tailwind's own palette is switched off: only the project's colors exist.

- Names say what a token is for (`surface`, `nav`, `fg-on-nav-muted`, `accent`, `success-subtle`), never what it looks like. A second theme (a dark one, say) gives the same names other values under a selector such as `[data-theme="dark"]` on `<html>`; no component changes, because Tailwind's utilities read the variables.
- Colors are hex values so `tests/design-tokens.test.ts` can check contrast: text 4.5:1 on each background it is used on, control borders, focus rings and status dots 3:1. When a component puts a text color on a new background, add the pair there.
- Layout values are tokens too: `--breakpoint-sidebar` (the `sidebar:` variant: the sidebar shows from 48rem), `--container-split` and `--container-split-wide` (the `@split:` and `@split-wide:` container variants: the rail beside the content, then wider), `--spacing-rail` and `--spacing-rail-wide` (280 and 300 px), `--spacing-header` (every header, 64 px), `--spacing-reading`, `--spacing-form` and `--spacing-list` (the widest a section's prose, a form and a list may be).
- `--color-ai-subtle` is the light amber tint that marks what the AI does or proposes (the same value as `--color-mark`, named for that use). `--color-next-subtle`, the same value again, is the case summary's "Lo siguiente" card (mockup 03).
- Components never use raw values (`#9a4a05`, `13px`): add or reuse a token. Code outside the stylesheet that needs one (the main process's window background, the script that closes the Menu panel) reads it from `src/shared/theme.ts`, which the token test compares with `tokens.css`.
- Only what the screens use exists. The reference's success and warning colors and its "ready" and "draft" section dots arrive with the screens that show them. One exception, by the owner's decision T21: `--spacing-reading`, `--spacing-form`, `--spacing-list` and `--color-ai-subtle` were added with the frame (UX-1), ahead of the screens that use them (the section and the two ways in UX-3, Documentos in UX-4), with their contrast pairs already tested.

## Components

Each component in `src/renderer/src/components/` wraps a Base UI part (`@base-ui/react`) where Base UI has one, which brings the keyboard behavior and the ARIA wiring, and styles it with Tailwind classes that use the tokens. Built only for what the screens use today:

- `Button` (`primary`, `secondary`, `ai`, `nav`; `md` 44 px or `sm` 32 px), and `ButtonLink` for a link that looks like one. `ai` is what asks the AI to do something: the AI's amber tint (`--color-ai-subtle`) edged in the accent (owner's decision P9). One `primary` per screen.
- `TextLink`: an underlined link inside text. Every link goes to a screen of the app.
- `Select`: a labelled list with an optional description, announced with the control.
- `Dialog`: modal; focus moves in and returns to the trigger; Escape and the backdrop close it. `variant="sheet"` is the navigation panel on a narrow window. `variant="panel"` is a light panel from the right edge that is not modal: the screen beside it stays usable, and a press outside closes it (today's notes). Without a `trigger` the screen opens it itself (`open`), as for the one-time "You're using your ChatGPT plan".
- `Tooltip`: hover and keyboard focus. It repeats the control's own name; it is never the only place a piece of information lives.
- `Table` and its parts: plain HTML tables with column or row headers.
- `StatusBadge`: a status in words; the color only repeats them. Four tones: `neutral`, `accent`, `success` ("Connected") and `warning` ("Needs attention").
- `NavItem`, `StepNavItem`, `SectionNavItem`: the sidebar's links; the current one is `aria-current="page"`. A step shows its state as a circle (its number; a check once done; amber while in progress; dashed with "Soon" when it is not built yet) and in words to a screen reader, with a count after it and, outside the report, a few words under its name on what it holds ("What you already have"; out of the link's name and offered as its description, `aria-describedby`). A section shows a dot and its state ("Yours", "v3", "Approved").
- `TextField`: a labelled text input (Base UI Field) with an optional description and an error, wired to the input. The New case form and a source's details use it (a source's date is `type="date"`, the system's own date field).
- `MenuButton`: a button that opens a short list of actions (Base UI Menu): "Paste text" lists the types.
- `ConfirmDialog`: a question before something happens (Base UI AlertDialog), opened by the caller; focus starts on Cancel, Escape cancels.
- `Term`, `TransWithTerms`: English terms inside the interface (below).
- The shared pieces of every step, `Icon`, `TwoWays`, `StateChip`, `StepHeader` and `NextStepCard`: below.
- `StepCircle` and `StepProgressBar` (`components/StepMarks.tsx`, UX-5): a step's state drawn on a light surface, the summary's circles and Home's five-segment bar.

Not built yet, on purpose: anything no screen uses.

Base UI's own inline `<style>` tags are turned off (`CSPProvider disableStyleElements` in `App.tsx`): the content security policy would block them, and no component used needs them.

## Shared pieces (UX-3)

Built for every step (the report's sections first, then Documentos in UX-4, and the empty case map's two ways in the case map speed pull request; the rest of the case map and the summary adopt them in their own pull requests). Their props are kept small on purpose.

**`Icon`** (`components/Icon.tsx`, owner's decision T5): the app's own inline SVGs, no icon library. `<Icon name="pencil" />`; `name` is one of `pencil`, `sparkle`, `check`, `arrow`, `chevron`, `forward` (the "›" after the case's name in the sidebar, UX-5), `copy`, `upload`, `stop`, `panel`, `more` (the "⋯" of a row's menu, UX-4); `size` in px (default: 1em, the size of the text around it); `className`. Drawn on a 16x16 grid in `currentColor`, hidden from screen readers: the words beside an icon carry the meaning. A new icon is one more path in `PATHS`.

**`TwoWays`** (`components/TwoWays.tsx`, proposal §3.1): the two ways of doing a step, "A mano" on the left (white, pencil) and "Con la IA" on the right (`--color-ai-subtle`, sparkle), the same on every step.

```tsx
<TwoWays
  layout="cards"            // "cards" while the step is empty; "bar" once it has content
  hand={{ title, body, actions }}   // title: cards only; body: one sentence; actions: its button(s)
  ai={{ title, body, actions }}     // AI buttons use variant="ai"; no actions when the AI has no role in the step
  aiConnected={providerConnected}   // default true
  connectWithoutActions     // also offer "Conectar la IA" on an AI side with no actions (Documentos, UX-4)
  active="hand"             // bar only: the way she is using now ("hand" | "ai"), marked on its edge and to a screen reader
/>
```

With `aiConnected={false}` the AI side keeps its color and its sentence; its `actions` become "Conectar la IA" (a link to Settings, `data-testid="connect-ai"`) and the sentence gains "Conecta ChatGPT en Ajustes para usar este camino." (owner's decision P7). It is never greyed. An AI side without `actions` is left as it is, unless `connectWithoutActions`: then an informative card (Documentos) also gains the sentence and "Conectar la IA", since P7 asks for it inside every AI card. The two sides sit side by side from `--container-split` up and stack below it.

**`StateChip`** (`components/StateChip.tsx`, layout rule 12): `<StateChip state="ai-draft" detail="editando" />`. `state`: `not-started` (Sin empezar), `hers` (Tuya), `ai-draft` (Borrador de la IA), `corrected` (Corregida por ti), `approved` (Aprobada), `copied` (Copiada), `writing` (La IA está escribiendo). `detail` follows after a middle dot. Hers in the success tint with a pencil, the AI's in the AI tint with a sparkle; the color and icon only repeat the words. One chip per header.

**`StepHeader`** (`shell/PageHeader.tsx`, proposal §3.2): a `PageHeader` with the step's parts named.

```tsx
<StepHeader
  eyebrow="Informe · sección 2 de 9"   // small capitals above the title ("Paso 2 de 5")
  title="Medical Necessity Criteria" titleLang="en"
  chip={<StateChip state="ai-draft" />}  // one chip
  afterChip={<VersionMenu … />}          // a menu, never a row of buttons (version details, history)
  status={<SaveState … />}               // "Todo guardado" / "Guardando…", in a space of fixed width
  secondary={<Button>Copiar</Button>}     // at most two actions,
  primary={<Button variant="primary">Aprobar</Button>}  // the primary last
/>
```

One row of `--spacing-header` (64 px) from `--container-split` up: nothing in it changes its height (the eyebrow and the title shorten with an ellipsis; the chip, the menu and the actions keep their width). The case's name is not repeated (it is in the sidebar).

**`NextStepCard`** (`components/NextStepCard.tsx`, proposal §3.3): "Siguiente paso", in the rail.

```tsx
<NextStepCard name="Strengths and Weaknesses" nameLang="en" body="…one sentence…" to={path} action="Abrir la sección" primary={done} />
```

`primary` once the current step has its minimum (a soft rule, never a gate: P5): the button becomes the screen's one primary and the card moves to the top of the rail; before that the button is secondary and the card closes the rail. Without `to` it shows no button (everything done). `disabledNote` (UX-4): before there is anything to move on with (Documentos with no document), the button shows disabled with this sentence under it ("Se activa cuando agregues el primer documento.").

**`WorkArea`'s `footer`**: docked at the foot of the content pane, outside its scroll (layout rule 3), beside the rail; a section's request box. Below `--container-split` it sticks to the foot of the one scroll area.

## Layout

`AppShell`, rendered once for every screen: the sidebar (16rem) and the working area side by side. One slim line tops the working area on every screen ("Trial version", with "What this means"), instead of a box on each section. Nothing in the frame scrolls as a whole; each region scrolls on its own, and only one area scrolls per region (owner's decision T1):

- **The sidebar**: the case on top and the footer (today's notes, the AI connection, the language) always in view; between them the steps, and the report's nine sections under "Report" only while she is in the report or its review and copy (T18). It fits a 1366x768 window with the sections listed; on a shorter window the list between scrolls. Settings is a link under the case's name.
- **Today's notes** open from the sidebar's footer in a panel from the right edge (T4). The panel stays mounted while closed, so its box lives as long as the case is open: saved as she types, in order, with its status. The button says "Not saved" on every screen of the case while a notes save that failed is kept, and the panel shows it with Try again. The box grows with what she writes, so the panel is the only thing that scrolls.
- **A screen** is a `WorkArea`: one `<main>` with the header, which never scrolls, and below it the content and the right rail. When the working area is at least `--container-split` (50rem) wide the rail sits beside the content and each scrolls on its own, so reading a long section moves only its text; below that the rail follows the content and the two scroll together. It is a container query, so it follows the working area's own width whether the sidebar shows or not.
- **The header** (`PageHeader`) is one row of `--spacing-header` (64 px) from `--container-split` up: the title and the detail line shorten with an ellipsis (the whole title is its tooltip, only once it is cut), what follows the title (a chip, a version menu) keeps its width, and the actions keep theirs, so no button moves when a title is long, a section has many versions or the screen is in Spanish. On a narrower working area it may wrap.

Below `--breakpoint-sidebar` (48rem) the sidebar leaves the screen: a dark bar with a Menu button takes its place and opens it as a side panel, which closes when a link is followed or the window widens again. Steps and section names wrap rather than cut off, which matters in Spanish, whose strings run longer.

## The Documents step

Step 1, "Documentos" (owner's proposal §4 "1 · Documentos", mockups 04 and 05; UX-4). What the assessment is drafted from. The screens say "documents" ("documentos"), never "sources" (audit U16); the code and the data file keep `sources`. Built for a clinician who is not technical: nothing to save by hand, nothing lost by a slip.

- **The header** is a `StepHeader`: "Paso 1 de 5", "Documentos", the save state, and, once there is a document, "Pegar un texto" and "Agregar PDF" (both secondary: the rail's "Siguiente paso" is the screen's primary).
- **Empty.** One sentence on what the step is for, then the two ways as cards (`TwoWays`): "A mano · Agrega cada documento" with [Pegar un texto] (the primary) and [Agregar PDF]; "Con la IA · La IA no agrega documentos", informative (it reads them for the case map and the report; nothing is sent until she asks), with "Conectar la IA" while no AI is connected (P7). Then **the checklist** "Lo que suele tener una evaluación inicial" (`document-checklist.ts`, owner's decision T14: display only, from `SOURCE_TYPES`, nothing stored): CDE, Parent interview, Direct observation, FBA questionnaire, Vineland-3, BASC-3, IEP, ABLLS-R, Otro documento, each with what it is in the screen language, the form it usually comes in, and its own [Pegar texto] / [Agregar PDF]. Adding from a row sets the type, so she never picks a type from a menu of English names (U5): a text opens with the type set; each PDF chosen from a row whose file name said nothing of its type gets the row's type (saved right after it is added, the same change as setting the type by hand); a name that does say it ("basc-3-prq.pdf" from the Vineland-3 row) keeps its own. A PDF copied but not added (`copied-not-added`) gets its type guessed again when she adds it from the folder card. Each row's buttons carry the row's name in their own accessible name too ("Pegar texto · CDE"), and each row's name is a heading, as on the document rows. ABLLS-R has its own row after BASC-3 (owner's answer on UX-4).
- **With documents.** The two ways as a slim bar ("La IA leerá estos 7 documentos en el Mapa del caso y en el Informe.") and **one list in the checklist's order**: a compact row per document (type chip, title, one line with what it is, its date, its length or size and a pasted text's first words, then any warning in words: a PDF missing from the folder, a PDF over ChatGPT's or both providers' size limit), with [Abrir] (a pasted text in the app, a PDF in the system's viewer) and a "⋯" menu (Nombre y fecha, Quitar). A control that goes away with what it changed hands the focus on: after adding PDFs (from a row, the header, the card or the folder card) it goes to the first new document's "Abrir". The expected types not added yet stay as dashed rows with their own [Pegar texto] / [Agregar PDF]; ABLLS-R and "Otro" are optional and leave no dashed row. A text's first words have Markdown's marks taken out for display (headings, bullets, quotes, rules, a table's lines, bold, italic, backticks: `withoutMarkdownMarks` in `src/main/case-sources.ts`, owner's decision T15); the saved text never changes.
- **The rail** (layout rule 7: what helps act on the step, not a second copy of the list). Empty: "Este paso" (the first of five; the hint "Con el CDE, la entrevista y tus observaciones ya puedes seguir…") and "Siguiente paso · Mapa del caso" with its button disabled until the first document. With a document: "Siguiente paso" first, its button the primary (P5: from the first document, never a gate); "Este paso" with three checks in words (CDE, entrevista y observaciones; Puntajes (Vineland-3, BASC-3); IEP: opcional) and the hint while any of the first three is missing; "Tamaño para la IA", only once there is a PDF: "Ningún PDF es demasiado grande para ChatGPT o Claude.", or which PDFs are too large for which AI. Only the PDFs' sizes are checked against each provider's limit for one request; pasted texts and the models' context windows are not, so the sentence claims nothing about them.
- **Adding by dialog or drop.** "Agregar PDF" opens the system's dialog (several at once); PDFs can also be dropped anywhere on the window while the step is open, which shows "Suelta los PDF para agregarlos a este caso". Each PDF is copied into the case's folder; the original is not touched. Its type is guessed from its file name (`guessPdfType`). What was added, and why anything was not (not a PDF, already a document, too large...), is said in a line above the list.
- **Saving.** Every change is saved at once: a pasted text when typing pauses (600 ms), when the field is left, when the screen is left and when the window is about to close; a title the same way; a type or a date as soon as it changes. The header shows "Saving…" and then "All changes saved", in a space as wide as the longer of the two, so the buttons beside it never move as it changes; a save that fails says what happened, with "Try again", until it or a later save of the same thing succeeds. Only a failure is announced to a screen reader (`role="alert"`); the saved state is shown, not announced, since it would be heard after every typing pause. The saves belong to the app, not the screen (`case-saves.tsx`): leaving the text editor or the case never drops one, and a save that fails after she has left the case is listed on Home ("A change to … could not be saved", with a link back). What could not be saved is kept by the main process with what it was writing, so a reload forgets nothing and "Try again" still works after one. Before the window closes, the app quits or the page reloads, everything still waiting is saved, and she is asked before anything unsaved is lost on a close or a quit (desktop.md, "Closing, quitting and reloading").
- **A pasted text** (`SourceText.tsx`): "Paso 1 de 5 · Documentos", its name, the save state and "Volver a Documentos" in the header; its type, title and date in one row above the text; the text box fills the pane down to its foot and grows with the text, so the pane is its only scroll and it has no resize handle (owner's decision T16). The character count shows only from 80% of what one text holds (800,000 of 1,000,000). A new text opened with no type ("Pegar un texto") says under the fields to choose its type there, so the AI knows what it is reading. Its type, title and date are one set of fields before and after the text exists (`source-details.tsx`): the text is created with what they hold, anything changed while it was being created is saved right after, and nothing is swapped, so what she is typing and the focus stay where they are.
- **Removing.** "Quitar" (in the row's "⋯") asks first ("Remove “…” from this case?"), and says the text or the file is kept. A removed document moves to "Documentos quitados (n) · se pueden restaurar", collapsed at the foot of the step, with Restore; right after removing, a line says so with Undo, which takes the focus (the row is gone), and Cmd+Z / Ctrl+Z (outside a text field) does the same.
- **PDFs in the folder** that are not documents of the case (put there in Finder or Explorer) are listed in a card, "Hay 2 PDF en la carpeta del caso que no agregaste. La IA no los usa hasta que los agregues.", each with [Agregar] and [Ignorar]. Ignoring stores nothing (owner's answer on UX-4): the PDF is hidden in this window while the app runs (`ignored-folder-pdfs.ts`, per case), a line "PDF ignorados (n) · hasta que vuelvas a abrir la app · Mostrar" brings it back (after Ignorar the focus goes to the next PDF's Agregar, or to Mostrar when none is left; after Mostrar, to the first Agregar), and it shows again after the app starts again, or at once if the file changes (another size or date).
- **The date** is the system's own date field, which follows the computer's regional settings rather than the screen language, so its hint names the order to type it in, in the screen language ("Type it as month/day/year…"; `dateFieldOrder` in `format.ts`, owner's decision T20).
- **Long texts.** The text area is not controlled by React: only its length is kept in state, so a very long paste stays quick. Measured in the built app (Apple silicon): pasting 600,000 characters in paragraphs takes about 0.1 s and typing in it stays immediate. One single paragraph that long, with no line break at all, is slow in Chromium's text area (seconds per keystroke); past 100,000 characters with no line break, the step says so under the text ("This text has no paragraph breaks, so typing in it may be slow").
- **Dropped files that are not PDFs** are refused from their first 1024 bytes, before the rest is read.

## Languages

The screens are in English or Spanish, chosen in Settings (or with ES/EN at the foot of the sidebar) and remembered across restarts. The assessment itself is always English.

- The setting lives in the main process, in `settings.json` in the app's data folder (`src/main/settings.ts`, read back through Zod; a missing, corrupt or outdated file falls back to the defaults). The interface reaches it only through `window.aba.getSettings()` and `window.aba.setLanguage()`. On the first run the language follows the system's preferred languages: Spanish if Spanish comes before English, English otherwise.
- A change is saved first, then shown. If the main process cannot save it (a read-only file, say), the screen still changes for this session, so the user can work in the language they chose, and the sidebar's footer and Settings both say it could not be saved and which language the app will open in next time: the one the main process has saved, read back from it, from one state both share (`language.tsx`).
- Ages and dates take their words and shape from the system's `Intl` data in the screen language: "4 years 2 months", "4 años 2 meses"; "Nov 22, 2026", "22 nov 2026".
- The sidebar's switch reads ES EN, as in the reference.
- A language named inside a sentence uses `languageInSentence` ("will open in Spanish", "se abrirá en español"), not the language's own name (`languages`: "English", "Español"), which the switch and the Select show.
- `<html lang>` follows the screen language. The steps are named in the screen language (Documentos, Mapa del caso, Plan, Informe, Revisión y copia; owner's decision P1). Clinical terms and section names stay English in the Spanish interface (Interventions, Medical Necessity Criteria, the case map's functions and measures...), because that is how the clinician and her forms name them, and they are marked `lang="en"` so a screen reader reads them in English. Spanish uses the informal "tú" and Latin American vocabulary ("computadora").

### Adding a string

1. Add the key and its English text to `src/renderer/src/i18n/en.ts`, in the group of its screen.
2. Add the same key with its Spanish text to `src/renderer/src/i18n/es.ts`. TypeScript refuses `es.ts` until it has exactly the keys of `en.ts`, and `pnpm test` checks it again (same keys, nothing empty, same `{{placeholders}}`, same English terms).
3. Use it with `const { t } = useTranslation(); t("group.key")`; keys are typed, so a typo does not compile.
4. A clinical term inside a sentence goes between `<term></term>`, in both languages, word for word, and the sentence is rendered with `<TransWithTerms i18nKey="group.key" />`. A term or section name on its own is not a string at all: it lives in `src/renderer/src/i18n/terms.ts` or `src/shared/report-sections.ts` and is shown with `<Term>`.

## Accessibility

- Everything works from the keyboard. The first Tab stop is "Skip to content", which puts focus on the screen's title (`<h1>` inside `<main>`). Dialogs keep focus inside and give it back; the Select opens with Enter, Space or the arrows.
- After each navigation a polite live region announces the new screen's title. When the link that was followed is gone (moving into or out of a case changes the sidebar), focus moves to the new screen's title instead of being lost; otherwise it stays on the link.
- Focus is always visible: one 2 px ring for every focusable element (`:focus-visible` in `app.css`), amber on light surfaces and light amber on the sidebar (`data-surface="nav"`).
- Text contrast meets 4.5:1 (checked by `tests/design-tokens.test.ts`).
- Every control has a name a screen reader announces; ES/EN are named "Español" and "English", each in its own language.
- Each screen has one `h1` (in its header, inside `main`), and landmarks for the navigation, the content (`main`) and the rail (`aside`).
- The language of each part is marked (`<html lang>`, `lang="en"` on English terms in Spanish screens, `lang="en"` on the development check).
- Motion is minimal and switched off under "reduce motion".

The window tests (`e2e/shell.e2e.ts`) check the keyboard path, the focus ring on each stop, the marked languages and the narrow layout.
