# De-identification

Clients' health data never reaches an AI provider in a form that identifies them. Before any request, the app replaces what identifies the client with placeholders, and puts the values back in the text the AI returns, on the clinician's computer only (owner's decision, 2026-11-22). PDFs are never sent as files: their text is extracted on the computer, de-identified like any other text, and only that text is sent.

The owner's decisions on this core (2026-11-22): PDF.js reads the PDFs, bundled into the main process; the placeholders are typed words in square brackets, with a person's first name and surname as separate forms; a sheet name that is also a common word is hidden when capitalized or inside a full name, and reported (not hidden) in lowercase; the date of birth in every format, and its month with its year, is hidden, other full dates only when more than 12 months old.

This is the core, in the main process, with no screen: `src/main/deidentify/` and `src/main/pdf-text/`. Part 2 adds the client sheet to the case, the review screen she sees before every send (what was found and how it will be sent, with a way to hide something else), and the wiring into every request.

## How it is used

```ts
import { Deidentifier, reidentify } from "../main/deidentify/index.ts";

const engine = new Deidentifier(sheet); // one per request: every source shares its placeholders
const notes = engine.deidentify(notesText); // { text, found, possible, map }
const vineland = engine.deidentify(vinelandText);
// ... send notes.text and vineland.text ...
const back = reidentify(aiText, engine.map); // { text, restored, unrestored }
```

- `text`: what may be sent.
- `found`: one entry per placeholder: its kind (`client`, `caregiver`, `family`, `professional`, `unlisted-name`, `school`, `address`, `phone`, `email`, `id`, `dob`, `date`, `other`), whether it came from the sheet or from a pattern, how many times it was replaced, and each way it was written. For the review screen.
- `possible`: what was left as it is but may identify (today: a sheet name that is also a common word, written in lowercase), with the placeholder it would get. For the review screen.
- `map`: placeholder → value to restore. It stays on the computer; nothing in this module writes it to disk.
- `reidentify` reports every placeholder it could not restore instead of dropping it silently.

`deidentify(text, sheet)` is the one-text shorthand.

## The client sheet

What she fills in for each case (`ClientSheet` in `src/main/deidentify/sheet.ts`; every field optional):

| Field | Examples |
| --- | --- |
| `client` | first name(s), last name(s), nicknames, the preferred name, the date of birth (YYYY-MM-DD) |
| `caregivers`, `family`, `professionals` | the same name fields, and a relation ("mother", "teacher") that is shown, never hidden |
| `schools` | "José Martí Elementary School" |
| `addresses`, `phones`, `emails`, `ids` | "4471 SW 12th Terrace, Apt 3, Miami, FL 33135", "(305) 555-0142", the Medicaid number |
| `other` | anything else, hidden as written: a clinic, a church, a team |

## What is hidden

### People on the sheet

Every name of every person on the sheet, in any case and with or without accents ("Lucía", "LUCIA", "lucia"):

- the full name, the first name alone, the last name alone, nicknames, each part of a compound or hyphenated name alone ("Inventada-Ruiz", "Ruiz"), with the surname's particles ("Ms. de la Fuente");
- possessives ("Mateo's"), plurals of a surname ("the Ficticios"), "Last, First" ("Ficticio, Mateo"), initials next to a name ("Mateo F.", "M. Ficticio") and dotted initials ("M.F.");
- a name split across a line break ("Mateo⏎Ficticio") or hyphenated at the end of a line ("Fic-⏎ticio");
- the same person written two ways ("Lucia Ficticio", "Lucía Ficticio-Gómez", "Mrs. Ficticio"): one placeholder.

When a run of words could be two people (a surname shared by the client and a caregiver), the longest reading wins, and at equal length the person listed first: client, caregivers, family, professionals. "Mrs. Ficticio" becomes "Mrs. [CLIENT LAST NAME]", which restores to the same surname.

**Names that are also common words.** A name part that is an ordinary English or Spanish word ("Will", "Hope", "Grace", "Rosa", "Luz", "Paz", "Cruz", "Peña", "Brown", "King"; the list is `src/main/deidentify/common-words.ts`), or has one or two letters, is hidden when it starts with a capital letter (at the start of a sentence too) and always when it is part of a full name; written in lowercase ("he will need", "una camiseta rosa", "le da pena") it is left as it is and reported in `possible` so she can hide it on the review screen. `commonWordNames: "always"` hides it in any case.

### Other values on the sheet

- **Schools**: the full name in any case, and its distinctive words alone when capitalized, with any generic words around them: "José Martí Elementary School", "Jose Marti Elementary", "José Martí" (but not "Martí's" alone). Generic words: Elementary, Middle, High, School, Academy, Preschool, VPK, Center, Montessori, Escuela and the like.
- **Addresses**: the full address and its street line, however the street words are abbreviated ("Terrace"/"Ter.", "Southwest"/"SW", "12th"/"12").
- **Phones, IDs**: the same digits with any spacing, dashes, dots or brackets.
- **Emails, other values**: as written, ignoring case and accents.

Each form of a name restores on its own: `[CLIENT]` as the preferred name (or the first name), `[CLIENT FULL NAME]` as the first name and the surname from the sheet, `[CLIENT LAST NAME]` as the part of the surname the text used most often, in the sheet's spelling ("Mrs. Ficticio" comes back as "Ficticio" even when the sheet says "Ficticio Gómez"), `[CLIENT INITIALS]` as the initials.

### Patterns, whether or not the sheet lists them

| Kind | Caught | Placeholder |
| --- | --- | --- |
| Date of birth | the sheet's date in any format below, its month with its year ("August 2022"), its month with its day ("August 3") | `[DOB]`, `[DOB MONTH AND YEAR]`, `[DOB MONTH AND DAY]` |
| Other dates | full dates more than 12 months before today (they could be a birth date): 03/14/2020, 3/14/20, 3-14-20, 03.14.2020, 2020-03-14, March 14, 2020, Mar. 14th 2020, 14 March 2020, 14th of March, 2020, 14 de marzo de 2020, marzo 14, 2020. A day-first date (14/03/2020) is read both ways. `dates: "all"` hides every full date. | `[DATE 1]` |
| Phones | US numbers in any usual format with or without +1 and an extension; international numbers starting with +; 7- and 10-digit numbers after "phone", "cell", "tel", "teléfono"... | `[PHONE 1]` |
| Emails | any address | `[EMAIL 1]` |
| IDs | 7 or more digits in a row; SSN-shaped numbers; a code of capitals with 5 digits ("W123456789"); 4 or more digits after "Medicaid", "member", "MRN", "record", "policy", "case", "student", "ID", "#"... | `[ID 1]` |
| Addresses | a street address (number, street words, a street type, an apartment, a city, a state and a ZIP code); a city with a state and a ZIP code; a ZIP after "ZIP"; a P.O. box | `[ADDRESS 1]` |
| Names not on the sheet | after a label at the start of a line or a table cell ("Examinee:", "Respondent \|", "Evaluator:", "Referral source:", "Teacher:", "Nombre:"...) or after a title ("Dr.", "Ms.", "Mr.", "Sra."...) | `[NAME 1]` |

### Placeholders

Uppercase words in square brackets, numbered where the kind can repeat, numbered in the order they are first met in a request: `[CLIENT]` (first name or nickname, restored as the preferred name), `[CLIENT FULL NAME]`, `[CLIENT LAST NAME]`, `[CLIENT INITIALS]`, the same for `[CAREGIVER 1]`, `[FAMILY 1]` (siblings and other relatives) and `[PERSON 1]` (professionals), `[SCHOOL 1]`, `[ADDRESS 1]`, `[PHONE 1]`, `[EMAIL 1]`, `[ID 1]`, `[DOB]`, `[DATE 1]`, `[NAME 1]`, `[OTHER 1]`. The same value always gets the same placeholder within a request. The format is set in one file, `src/main/deidentify/placeholders.ts`.

When two findings overlap, the longer wins ("1234 Ficticio Street" is one address) and, at equal length, the sheet wins over a pattern; whatever part of the shorter one is left outside is hidden on its own, so nothing is left half-hidden.

## What is not hidden

- **The client's age** ("4 years 2 months", "4:2"): the writing needs it (owner's decision).
- **Clinical content**: diagnoses and ICD-10 codes (F84.0), CPT codes (97153), test names (Vineland-3, BASC-3), scores, percentiles, ranges, ages in years:months, hours and times.
- **Recent dates and future dates** (interview, observation, test and planned dates), and a year alone ("since 2024"), a month with its year that is not the birth month ("March 2026").
- **A city or a neighborhood on its own** ("lives in Hialeah"); hidden only as part of an address.
- **Words of the sheet's common-word names in lowercase** (reported in `possible`).

## Putting values back

`reidentify` accepts what models do to placeholders: another case (`[Client]`), a possessive inside or after the brackets (`[CLIENT'S]`, `[CLIENT]'s`), another separator or none (`[CAREGIVER_1]`, `[CAREGIVER1]`), doubled, escaped or other brackets (`[[CLIENT]]`, `\[CLIENT\]`, `{CLIENT}`), parentheses in capitals (`(CLIENT)`), one bracket missing (`[CLIENT`, `CLIENT]`), and no brackets at all for an unmistakable label in capitals (`CAREGIVER 1`, `CLIENT FULL NAME`). Once a person is mentioned, every form of their name can be restored, even one that was not in the text sent.

It reports, and leaves in the text: an unknown placeholder (`[CAREGIVER 3]` when there are two, `[INSERT DATE]`, `[Name]`) and a lone `CLIENT` in capitals, which could be a heading. "DOB" alone is left alone: it is how forms label a date of birth. Each restored placeholder comes with how many of its occurrences had to be repaired.

## PDF text

`extractPdfText(bytes, pdfjsReader)` (`src/main/pdf-text/extract.ts`, `src/main/pdf-text/pdfjs-reader.ts`) returns:

- `{ status: "text", text, pageCount, pagesWithoutText }`: the text, each page under `--- Page 2 of 3 ---`; a page with no text layer is marked `[No text on this page: it is probably a scanned image. Its content is not included.]` and listed, so the interface can ask her to paste those scores.
- `{ status: "no-text", pageCount }`: no page has text, almost always a scan: the interface asks her to paste the scores.
- `{ status: "unreadable", reason }`: `not-a-pdf`, `password`, `damaged`, `too-many-pages` (over 300) or `timed-out` (over 60 s).

A page counts as having no text when it has fewer than 20 letters and digits, or when more than 30% of its characters are unreadable glyphs (a font with no usable text map).

The reader is Mozilla's PDF.js (`pdfjs-dist`, Apache-2.0, pinned to 6.5.438), its Node.js build, a devDependency bundled into the main process like every other package (about 3.3 MB of the main bundle once part 2 imports it; checked by bundling it with electron-vite and reading the fixtures from the bundle). It only reads text: its worker runs in the same thread (the bundled worker module is handed to PDF.js, so no file is loaded and no thread started), nothing is drawn and no font is loaded, the PDF's scripts and XFA forms never run, and this version of PDF.js no longer compiles fonts into JavaScript (the path of CVE-2024-4367; its `isEvalSupported` option is gone). Its optional native canvas package (`@napi-rs/canvas`) is not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`): it is only for drawing, and a bundled main process could not load a native module. Without it PDF.js prints three warnings when it is first loaded ("Cannot polyfill `DOMMatrix`" and the like): expected, harmless for text. The time limit stops PDF.js and frees the document.

The layout (`src/main/pdf-text/layout.ts`) rebuilds reading order from each piece of text's position: lines top to bottom; a table row on one line with its cells joined by ` | ` (`Communication | 23 | 62 | 57–67 | 1 | Low`), even when a cell wraps onto several lines and the other cells sit between them; a label and its value on one line (`Examinee | Mateo Ficticio`); the lines of a paragraph joined; a blank line between blocks. Charts, pictures and the visual layout are lost.

## Known limits

- A person who is not on the sheet, written without a title and not after a label ("her cousin Bruno visits on Sundays"), is not hidden. The review screen is where she adds them.
- Two people with the same first name: a first name alone goes to the one listed first.
- Undotted initials ("MF"), a nickname not on the sheet, a misspelling ("Mateu"), and names in another script are not caught.
- Free-text details that identify without any name or number (a rare event, a unique job) are not caught.
- A date written without a year ("on March 14") is hidden only when it is the birth date.
- PDFs: a page in two columns is read across both columns line by line; rotated text is read as if it were not; values typed into a fillable PDF form's fields are not read; scanned pages are not read (no OCR).

## Tests

`tests/deidentify.test.ts` and `tests/pdf-text.test.ts`, with invented people only:

- A battery of invented paragraphs (`tests/deidentify-battery.ts`): Spanish and English names, accents and no accents, hyphenated and double surnames with particles, a caregiver sharing the client's surname, a father sharing a first name, a school named after a person, names that are common words (Will, Hope, Grace, Rosa, Paz, Cruz, Peña), names split across lines, every date format, phones, emails, IDs, addresses, CPT and ICD codes, scores. Measured: 86 identifying strings, 1 slipped through (a cousin named only in the text, the first limit above), 0 clinical strings wrongly hidden.
- Round trip: every placeholder of the battery comes back, none is reported, and de-identifying the restored text gives the same placeholders again; a text written with the sheet's own spellings comes back exactly.
- The two invented fixture cases' notes (`fixtures/cases/*/*.md`), with the sheet she would fill in: no name survives, the evaluators, the pediatrician and the psychiatrist included (not on the sheet: caught by their label or title).
- PDF layout on positioned pieces (wrapped cells, a three-line cell, paragraphs, ligatures) and the extraction results with a stand-in reader (scans, garbled pages, unreadable files, the time limit): `tests/pdf-text.test.ts`.
- PDF.js on the fixture PDFs (`tests/pdf-fixtures.test.ts`): the four invented score reports (`fixtures/cases/*/*.pdf`) and `fixtures/pdf-text/layout-check.pdf` (a four-line header cell, a cell wrapped onto four lines with its row's other cells in the middle, a name wrapped in a narrow column, two pages) give exactly the texts in `fixtures/pdf-text/expected/`; `scan.pdf` (a picture of a report, no text layer) is `no-text`; `mixed.pdf` (a text page, then a scanned one) lists page 2; a password-protected PDF, a truncated one, a PDF with no pages and an HTML file each say why; the extracted text de-identifies with its scores intact (`Examinee | [CLIENT FULL NAME]`, `Communication | 23 | 62 | 57–67 | 1 | Low`).

The fixture PDFs are made by `node scripts/render-fixture-pdfs.mts` (headless Chrome) from invented HTML: the score reports from `fixtures/cases/<case>/reports/`, the extraction fixtures from `fixtures/pdf-text/` (`scan.pdf` and `mixed.pdf` from a screenshot of `scan-source.html`, as a scanner would make them). After rendering again, regenerate the expected texts only after reading what changed.
