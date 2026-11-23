# The interface

How the React interface in `src/renderer/` is organized: its look (direction C, "compact panel"), its parts, its two languages, and the rules every screen follows. How it talks to the main process is in [desktop.md](desktop.md).

## The look

Direction C, chosen by the owner from three mockups: a dark sidebar with the case, its five steps and the report's sections; a light working area under a compact header; a light grey right rail for sources and checks. IBM Plex Sans for the interface, IBM Plex Mono for technical detail (versions, positions such as "Step 2 of 5"), an amber accent for the main action, links and focus. Dense, but every control is at least 44 px tall. One theme for now.

The fonts come from the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` packages: Vite copies the font files into the build and the app loads them from its own files. The interface makes no network request of its own. They are under the SIL Open Font License 1.1, which asks every copy to carry IBM's notice and the license: `licenses/IBM-Plex-OFL.txt` (from IBM's own repository) ships in the packaged app's resources folder, `tests/licenses.test.ts` checks it against the license the font packages carry, and the packaged window tests check it is in the app. See [licenses/README.md](../licenses/README.md).

## Where things are

| Path | What it holds |
| --- | --- |
| `src/renderer/src/main.tsx` | Start-up: reads the saved settings, starts i18next in that language, renders the app. |
| `src/renderer/src/App.tsx` | The screens and their addresses (React Router), and the providers around them. One shell route holds every screen. |
| `src/renderer/src/styles/tokens.css` | **The design tokens**: every color, type size, radius, shadow and fixed size. |
| `src/renderer/src/styles/app.css` | Tailwind, the tokens, and the few rules that apply everywhere (body text, the focus ring). |
| `src/renderer/src/styles/fonts.ts` | Which Plex weights ship. |
| `src/renderer/src/components/` | **The project's own components**, on Base UI where it has the part: `Button`, `TextLink` and `ButtonLink`, `Select`, `Dialog` (a centered box or a side panel), `Tooltip`, `Table`, `StatusBadge`, `NavItem` and `SectionNavItem`, `Term`. |
| `src/renderer/src/shell/` | The frame: `AppShell` (rendered once: the sidebar for the app or for the case, the working area, the Menu panel on a narrow window, the skip link, the announcement and focus after a navigation), `Sidebar`, `PageHeader`, `WorkArea` (a screen's `<main>`: header, content and right rail). |
| `src/renderer/src/screens/` | One file per screen: `Home` (the list of cases and the New case form), `Case` (the workspace's steps, report and right rail), `Sources` (the Sources step), `SourceText` (a pasted text), `Settings`, `NotFound`, `DevCheck`. |
| `src/renderer/src/open-case.tsx` | The open case: AppShell loads it when the address enters a case, so the sidebar shows its label and the screens its data; a saved change to its sources replaces them there. |
| `src/renderer/src/case-saves.tsx` | Every case's saves, for the whole app: the save state the screens show ("Saving…", "All changes saved", what was not saved and "Try again"), the failures Home lists (read from the main process, so a reload keeps them), and saving everything before the window closes or the page reloads. |
| `src/renderer/src/source-details.tsx` | A source's type, title and date fields: one state before and after a new text exists. |
| `src/renderer/src/source-labels.tsx` | A source's name, type, size and date as the screens show them. |
| `src/renderer/src/language.tsx` | The screen language and the saved one, shared by the sidebar and Settings. |
| `src/renderer/src/connections.tsx` | The AI connections' state, shared by the sidebar and Settings, kept current by the main process's updates ([connections.md](connections.md)). |
| `src/renderer/src/format.ts`, `cases-folder.tsx` | Ages and dates in the screen language; the cases folder's problems in words, and "Show in Finder / Explorer". |
| `src/renderer/src/i18n/` | The strings: `en.ts`, `es.ts`, the English-only clinical terms (`terms.ts`) and i18next's set-up. |
| `src/shared/report-sections.ts` | The report's sections and their English titles, shared with the main process. |
| `src/shared/theme.ts` | The two design values code needs outside the stylesheet (the window's background, the sidebar breakpoint); a test keeps them equal to the tokens. |

## Screens and addresses

React Router keeps the address in the URL's hash (`#/settings`). The app's page never navigates (the main process blocks it, see [desktop.md](desktop.md)); a hash change stays inside the page, and a reload comes back to the same screen.

| Address | Screen |
| --- | --- |
| `#/` | Home: the cases in the cases folder, newest first (label, client age, created, last saved, PDFs), "New case", and below them the folders that could not be opened. When there are none, what to do; when the cases folder cannot be used, why and a way to choose another. |
| `#/cases/<id>/sources` | The Sources step: the case's sources, PDFs in its folder that are not sources, removed sources (below). |
| `#/cases/<id>/sources/text/<source-id>`, `#/cases/<id>/sources/new/<type>` | A pasted text, to read and edit; a new one of that type. |
| `#/cases/<id>/behaviors`, `/interventions`, `/review` | The case workspace's other steps, for the case with that id. The sidebar shows its label and age, the report's sections with their states, and her notes for this session; the rail lists its sources and the PDFs in its folder. These steps are still placeholders that say what they will hold. An id that is not a case, or a case that cannot be opened, says so. |
| `#/cases/<id>/report` | The report's sections, each with its state (not started, yours, draft version N, approved). |
| `#/cases/<id>/report/<section-id>` | One section of the report (ids in `src/shared/report-sections.ts`), `screens/Section.tsx`: start it (paste what she wrote, or draft it with the AI), read it, mark a paragraph to change, ask for changes, edit, the versions, approve, copy for ABA Matrix; the rail holds her instructions for the section, the sources used and the checks ([sections.md](sections.md)). |
| `#/settings` | The screen language; the cases folder (its path, "Choose another folder…", "Show in Finder", and a message when the folder cannot be shown or checked); the AI connection, one card for ChatGPT (Continue with ChatGPT, signing in, signed in as, check, manage usage, sign out, needs attention) and one for Claude (paste, check and save, check, remove), each with its state in words (`screens/Connections.tsx`); the AI model on each provider; About. |
| `#/dev-check` | The development check (mock generation). Linked from the sidebar only when the app runs from the repository (`getAppInfo().developmentBuild`); the packaged app has no link to it, and the window tests open it by address. It is a developer screen, in English only. |

## Design tokens

All of them are in `src/renderer/src/styles/tokens.css`, inside Tailwind's `@theme`, so each one is also a utility class: `--color-fg-muted` gives `text-fg-muted`, `--spacing-control` gives `min-h-control`, `--text-sm` gives `text-sm`. Tailwind's own palette is switched off: only the project's colors exist.

- Names say what a token is for (`surface`, `nav`, `fg-on-nav-muted`, `accent`, `success-subtle`), never what it looks like. A second theme (a dark one, say) gives the same names other values under a selector such as `[data-theme="dark"]` on `<html>`; no component changes, because Tailwind's utilities read the variables.
- Colors are hex values so `tests/design-tokens.test.ts` can check contrast: text 4.5:1 on each background it is used on, control borders, focus rings and status dots 3:1. When a component puts a text color on a new background, add the pair there.
- Layout values are tokens too: `--breakpoint-sidebar` (the `sidebar:` variant: the sidebar shows from 48rem), `--container-split` and `--container-split-wide` (the `@split:` and `@split-wide:` container variants: the rail beside the content), `--spacing-rail` and `--spacing-rail-wide`.
- Components never use raw values (`#9a4a05`, `13px`): add or reuse a token. Code outside the stylesheet that needs one (the main process's window background, the script that closes the Menu panel) reads it from `src/shared/theme.ts`, which the token test compares with `tokens.css`.
- Only what the screens use exists. The reference's success and warning colors and its "ready" and "draft" section dots arrive with the screens that show them.

## Components

Each component in `src/renderer/src/components/` wraps a Base UI part (`@base-ui/react`) where Base UI has one, which brings the keyboard behavior and the ARIA wiring, and styles it with Tailwind classes that use the tokens. Built only for what the screens use today:

- `Button` (`primary`, `secondary`, `nav`; `md` 44 px or `sm` 32 px), and `ButtonLink` for a link that looks like one.
- `TextLink`: an underlined link inside text. Every link goes to a screen of the app.
- `Select`: a labelled list with an optional description, announced with the control.
- `Dialog`: modal; focus moves in and returns to the trigger; Escape and the backdrop close it. `variant="sheet"` is the navigation panel on a narrow window. Without a `trigger` the screen opens it itself (`open`), as for the one-time "You're using your ChatGPT plan".
- `Tooltip`: hover and keyboard focus. It repeats the control's own name; it is never the only place a piece of information lives.
- `Table` and its parts: plain HTML tables with column or row headers.
- `StatusBadge`: a status in words; the color only repeats them. Four tones: `neutral`, `accent`, `success` ("Connected") and `warning` ("Needs attention").
- `NavItem`, `SectionNavItem`: the sidebar's links; the current one is `aria-current="page"`. A section shows one state today, "not started".
- `TextField`: a labelled text input (Base UI Field) with an optional description and an error, wired to the input. The New case form and a source's details use it (a source's date is `type="date"`, the system's own date field).
- `MenuButton`: a button that opens a short list of actions (Base UI Menu): "Paste text" lists the types.
- `ConfirmDialog`: a question before something happens (Base UI AlertDialog), opened by the caller; focus starts on Cancel, Escape cancels.
- `Term`, `TransWithTerms`: English terms inside the interface (below).

Not built yet, on purpose: anything no screen uses.

Base UI's own inline `<style>` tags are turned off (`CSPProvider disableStyleElements` in `App.tsx`): the content security policy would block them, and no component used needs them.

## Layout

`AppShell`, rendered once for every screen: the sidebar (16rem) and the working area side by side, each scrolling on its own; inside the sidebar the case and the footer stay put and the lists scroll. Below `--breakpoint-sidebar` (48rem) the sidebar leaves the screen: a dark bar with a Menu button takes its place and opens it as a side panel, which closes when a link is followed or the window widens again. Each screen is a `WorkArea`: one `<main>` with the screen's header and content, and the right rail beside the content when the working area is at least `--container-split` (50rem) wide, below it otherwise; it is a container query, so it follows the working area's own width whether the sidebar shows or not. Titles, steps and section names wrap rather than cut off, which matters in Spanish, whose strings run longer.

## The Sources step

What the assessment is drafted from. Built for a clinician who is not technical: nothing to save by hand, nothing lost by a slip.

- **Adding.** "Paste text" opens a menu of the text types (CDE, Parent interview, Direct observation, FBA questionnaire, IEP, Other); choosing one opens an empty text with the focus in it. "Add PDF…" opens the system's dialog (several at once); PDFs can also be dropped anywhere on the window while the step is open, which shows "Drop PDFs to add them to this case". Each PDF is copied into the case's folder; the original is not touched. What was added, and why anything was not (not a PDF, already a source, too large...), is said in a line above the list.
- **The list.** Each source shows its type (an English clinical term, `lang="en"`, except "Other"), its name (its title, else its type or its file), what it is (pasted text and its length, or PDF and its size), its date, a pasted text's first words, and warnings in words: a PDF missing from the folder, a PDF over ChatGPT's or both providers' size limit. Its actions: Open (a pasted text opens in the app; a PDF in the system's viewer), "Name, type and date" and Remove. The rail lists the sources too.
- **Saving.** Every change is saved at once: a pasted text when typing pauses (600 ms), when the field is left, when the screen is left and when the window is about to close; a title the same way; a type or a date as soon as it changes. The header shows "Saving…" and then "All changes saved", in a space as wide as the longer of the two, so the buttons beside it never move as it changes (a click on "Back to sources" would otherwise miss where the header wraps); a save that fails says what happened, with "Try again", until it or a later save of the same thing succeeds. Only a failure is announced to a screen reader (`role="alert"`); the saved state is shown, not announced, since it would be heard after every typing pause. The saves belong to the app, not the screen (`case-saves.tsx`): leaving the text editor or the case never drops one, and a save that fails after she has left the case is listed on Home ("A change to … could not be saved", with a link back). What could not be saved is kept by the main process with what it was writing, so a reload forgets nothing and "Try again" still works after one. Before the window closes, the app quits or the page reloads, everything still waiting is saved, and she is asked before anything unsaved is lost on a close or a quit (desktop.md, "Closing, quitting and reloading").
- **A new text.** Its type, title and date are one set of fields before and after the text exists (`source-details.tsx`): the text is created with what they hold, anything changed while it was being created is saved right after, and nothing is swapped, so what she is typing and the focus stay where they are.
- **Removing.** Remove asks first ("Remove “…” from this case?"), and says the text or the file is kept. A removed source moves to "Removed sources", collapsed at the foot of the step, with Restore; right after removing, a line says so with Undo, which takes the focus (the row is gone), and Cmd+Z / Ctrl+Z (outside a text field) does the same.
- **PDFs in the folder** that are not sources (put there in Finder or Explorer) are listed under "Also in this case's folder", each with "Add as a source".
- **Long texts.** The text area is not controlled by React: only its length is kept in state, so a very long paste stays quick. Measured in the built app (Apple silicon): pasting 600,000 characters in paragraphs takes about 0.1 s and typing in it stays immediate. One single paragraph that long, with no line break at all, is slow in Chromium's text area (seconds per keystroke); past 100,000 characters with no line break, the step says so under the text ("This text has no paragraph breaks, so typing in it may be slow").
- **Dropped files that are not PDFs** are refused from their first 1024 bytes, before the rest is read.

## Languages

The screens are in English or Spanish, chosen in Settings (or with ES/EN at the foot of the sidebar) and remembered across restarts. The assessment itself is always English.

- The setting lives in the main process, in `settings.json` in the app's data folder (`src/main/settings.ts`, read back through Zod; a missing, corrupt or outdated file falls back to the defaults). The interface reaches it only through `window.aba.getSettings()` and `window.aba.setLanguage()`. On the first run the language follows the system's preferred languages: Spanish if Spanish comes before English, English otherwise.
- A change is saved first, then shown. If the main process cannot save it (a read-only file, say), the screen still changes for this session, so the user can work in the language they chose, and the sidebar's footer and Settings both say it could not be saved and which language the app will open in next time: the one the main process has saved, read back from it, from one state both share (`language.tsx`).
- Ages and dates take their words and shape from the system's `Intl` data in the screen language: "4 years 2 months", "4 años 2 meses"; "Nov 22, 2026", "22 nov 2026".
- The sidebar's switch reads ES EN, as in the reference.
- A language named inside a sentence uses `languageInSentence` ("will open in Spanish", "se abrirá en español"), not the language's own name (`languages`: "English", "Español"), which the switch and the Select show.
- `<html lang>` follows the screen language. Clinical terms and section names stay English in the Spanish interface (Behaviors, Interventions, Medical Necessity Criteria...), because that is how the clinician and her forms name them, and they are marked `lang="en"` so a screen reader reads them in English. Spanish uses the informal "tú" and Latin American vocabulary ("computadora").

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
