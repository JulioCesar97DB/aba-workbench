# De-identification

Clients' health data never reaches an AI provider in a form that identifies them. Before any request, the app replaces what identifies the client with placeholders, and puts the values back in the text the AI returns, on the clinician's computer only (owner's decision, 2026-11-22). PDFs are never sent as files: their text is extracted on the computer, de-identified like any other text, and only that text is sent.

The owner's decisions on this core (2026-11-22):
- PDF.js reads the PDFs, in a separate process for each PDF (an Electron utility process) with its own heap cap, killed at a hard 30-second limit; a crash or an out-of-memory marks only that PDF unreadable.
- Keep fixing and reviewing until nothing on the sheet slips through, however many rounds it takes.
- Placeholders are typed words in square brackets; a person's first name and surname are separate forms, and a full name is one placeholder (`[CLIENT FULL NAME]`).
- A sheet name that is also a common word is hidden when capitalized or inside a full name, and reported (not hidden) in lowercase.
- The date of birth in every format, and its month with its year, is hidden; other full dates only when more than 12 months old.
- The city or neighborhood of any address on the sheet is always hidden, also alone ("lives in [CITY 1]").
- The age may be sent, but the days part of an age ("6;8;8") is dropped: with a test date it gives the date of birth.

This is the core, in the main process (and the PDF reading process), with no screen: `src/main/deidentify/` and `src/main/pdf-text/`. Part 2 adds the client sheet to the case, the review screen she sees before every send (what was found and how it will be sent, with a way to hide something else), and the wiring into every request.

## How it is used

```ts
import { Deidentifier, reidentify } from "../main/deidentify/index.ts";

const engine = new Deidentifier(sheet); // one per request: every source shares its placeholders
const notes = engine.deidentify(notesText); // { text, found, possible, dropped, map }
const vineland = engine.deidentify(vinelandText);
// ... send notes.text and vineland.text ...
const back = reidentify(aiText, engine.map); // { text, restored, unrestored }
```

- `text`: what may be sent.
- `found`: one entry per placeholder: its kind (`client`, `caregiver`, `family`, `professional`, `unlisted-name`, `school`, `address`, `city`, `phone`, `email`, `id`, `dob`, `date`, `other`), whether it came from the sheet or from a pattern, how many times it was replaced, and each way it was written.
- `possible`: for the review screen, each with the placeholder it has or would get:
  - left as it is but may identify: a common-word sheet name in lowercase (`common-word-name`), a sheet name inside a longer word ("Luciana" for Lucía, `name-inside-word`), a distinctive word of the school alone ("Martí.", `school-word`), a capitalized word that could shorten a sheet name ("Vale" for Valeria, `possible-nickname`);
  - hidden, but to check: a name two people on the sheet share (`shared-name`), and a sheet name split by a space next to a short word, which may be two ordinary words ("mate o" for Mateo, `split-name`): both are sent as a neutral `[NAME n]`, restored exactly as written (`hidden: true`).
- `dropped`: what was removed with no placeholder (the days part of an age).
- `map`: placeholder → value to restore. It stays on the computer; nothing in this module writes it to disk.
- `reidentify` reports every placeholder it could not restore, and never restores part of a bracket.

`deidentify(text, sheet)` is the one-text shorthand. One call takes at most 5,000,000 characters (`MAX_TEXT_LENGTH`). Every step is linear in the text's length, dates included (measured: 1.5 million characters of names, dates and addresses in about 1 s; 1.1 MB of nothing but dates in 0.6 s; 2.8 MB of "birthday 3/14" in 1.3 s).

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

The text is first folded, keeping a map from every folded character back to the original one, so each match is replaced, and restored, at its exact original place:
- compatibility forms are normalized (NFKC): ligatures ("Soﬁa" copied out of a PDF), fullwidth letters ("Ｍａｔｅｏ") and the like read as plain letters;
- lowercase, accents removed, "ß" as "ss";
- invisible format characters (soft hyphen, zero-width space and joiners, word joiner, bidi marks) dropped, so "Fic‍ticio" with a hidden joiner is still "ficticio";
- HTML character references pasted with a text ("Luc&iacute;a", "&#237;") read as their letter.

### People on the sheet

Every name of every person on the sheet, in any case and with or without accents ("Lucía", "LUCIA", "lucia"):

- the full name, the first name alone, the last name alone, nicknames, each part of a compound or hyphenated name alone ("Inventada-Ruiz", "Ruiz"), with the surname's particles ("Ms. de la Fuente");
- possessives with or without an apostrophe and plurals ("Mateo's", "Valerias toys", "the Ficticios"), "Last, First" ("Ficticio, Mateo"), initials next to a name ("Mateo F.", "J. M. Peña") and dotted initials ("M.F.");
- a name split across a line break ("Mateo⏎Ficticio");
- a name word broken inside, as PDF paragraph hyphenation, typing or OCR leave it: "Fic-ticio", "Fic- ticio", "Fic-⏎ticio", "Ficti-cio", "M ateo", "Fi cticio", "Mu-estras" (with a plural s); when the split is a space next to an everyday short word ("mate o", "and res"), it may be two ordinary words, so it is sent as a neutral `[NAME n]` restored as written and shown for review;
- a name word misread by OCR in a scanned report's text layer (5 letters or more, one or more of 0/o, 1/l/i/|, rn/m, vv/w, c/e, 5/s read alike): "Mate0", "Luc1a", "FlCTlClO", "Matco";
- a name joined to other text: in a file name, a handle or a hashtag ("MateoFicticio.pdf", "@mateoficticio", "#TeamMateo", "mateo_ficticio_cde.docx"), or at a CamelCase, digit or underscore boundary; inside an ordinary longer word it is only reported ("Luciana");
- a name written letter by letter ("L u c i a", "Ma | teo", as some PDFs give it);
- Spanish diminutives of each given name and nickname ("Mateíto", "Teíto", "Carmencita", "Valerita");
- the same words written two ways ("Lucia Ficticio", "LUCÍA FICTICIO"): one placeholder.

When a surname alone is shared by several people (the client and a caregiver), it is the same family name and goes to the person listed first (client, caregivers, family, professionals): it restores to the same word. When a first name or a full name fits two people equally (a father who shares the client's name), it is sent as a neutral `[NAME n]`, restored exactly as written, and listed in `possible` as `shared-name` for her to check; it is never sent as the client.

A name restores as the same words in the sheet's spelling: `[CLIENT]` as the preferred name (or the first name: the owner's rule, so a nickname comes back as the preferred name), `[CLIENT FULL NAME]` as the sheet's whole name, a full name written with fewer words (`[CLIENT FULL NAME 1]` for "Mateo Ficticio", "Ficticio, Mateo" or "Mateo F.") as exactly those words, a surname alone as the part it stood for. A broken, OCR-misread or fullwidth name word comes back clean ("Fic-ticio" as "Ficticio").

**Names that are also common words.** A name part that is an ordinary English or Spanish word ("Will", "Hope", "Grace", "Rosa", "Luz", "Paz", "Cruz", "Peña", "Brown", "King"; the list is `src/main/deidentify/common-words.ts`), or has one or two letters, is hidden when it starts with a capital letter (at the start of a sentence too) and always when it is part of a full name; written in lowercase ("he will need", "una camiseta rosa", "le da pena") it is left as it is and reported in `possible`. `commonWordNames: "always"` hides it in any case.

### Other values on the sheet

- **Schools**: the full name in any case; its distinctive words when capitalized, alone or with generic words after them ("José Martí", "Jose Marti Elementary"); one distinctive word followed by a generic word ("Martí Elementary"); its initials in capitals ("JMES", "JME"); any of these words hyphenated or broken across a line ("Mar-tí Ele-⏎mentary"). A distinctive word alone ("Martí.") is reported in `possible`. Generic words: Elementary, Middle, High, School, Academy, Preschool, VPK, Center, Montessori, Escuela and the like.
- **Addresses**: the full address; the house number with the street, with or without its type, its unit, city, state and ZIP; the street without its number when its type is there ("SW 12th Terrace"); however the words are written ("Terrace", "Terr.", "Trce"; "SW", "S.W.", "Southwest"; "12th", "12", "Twelfth"; "Apt", "Unit", "#"), even with the spaces lost ("4471SW12th").
- **Cities and neighborhoods** of the sheet's addresses, everywhere, also alone and hyphenated: `[CITY 1]` ("lives in Miami", "MIAMI, FL", "Mia-⏎mi"). A city name that is also an ordinary word ("Sunrise", "Plantation") only when capitalized.
- **Phones**: the same digits with any spacing, dashes, dots, slashes or brackets, and the number without its area code ("555-0142").
- **IDs**: the same characters with any spacing, dashes or dots ("FL 123 - 456 - 789"), the digits of an ID with a letter prefix alone ("123456789" for "FL123456789"), and the digits touching letters ("fl9876543210").
- **Emails, other values**: as written, ignoring case and accents; other values also hyphenated.

Every value that is not a name is restored exactly as it was written: each different written value (a full address, a street alone, a phone without its area code, another school with the same words) has its own placeholder, and the same value written again, or in another format of the same value ("(305) 555-0142" and "305.555.0142", "4471 SW 12th Terr." and "4471 S.W. 12 Terrace"), shares it and comes back as it was first written. So restoring never changes, adds or drops a word.

### Patterns, whether or not the sheet lists them

| Kind | Caught | Placeholder |
| --- | --- | --- |
| Date of birth | the sheet's date written in any way the date reader below understands, also as six or eight bare digits ("031420", "03142020", "14032020"); its month with its year ("March 2020"); its month and day anywhere, in any form ("March 14", "14th March", "the fourteenth of March", "el catorce de marzo", "3/14", "14/3") | `[DOB]`, `[DOB MONTH AND YEAR]`, `[DOB MONTH AND DAY]` |
| Birthdays | any full date with the birth date's month and day in another year ("he turned 6 on 03/14/2026"): it gives the date of birth away | `[DATE n]` |
| Other dates | full dates more than 12 months before today (they could be a birth date). The date reader (`dates.ts`) reads a stream of numbers, words and separators, not a list of formats: three numbers with the same separator, spaces allowed around it, and a year of four digits, two digits or "'20" (03/14/2020, 3-14-20, 03 / 14 / 2020, 3/14/'20, 2020/03/14, 14-III-2020); a month name or abbreviation in English or Spanish, also hyphenated or split ("Mar-⏎ch"), with a day as a number, an ordinal or words ("14", "14th", "fourteenth", "twenty-first", "catorce") before or after it, "the", "of" or "de" between, and a year ("March the 14th, 2020", "14-Mar-20", "5 Jan 24", "Jan 5 '24", "14 de marzo del año 2020"). A day-first date is read both ways. A date right after an age label ("CA = 6-08-08") is an age, not a date. `dates: "all"` hides every full date. | `[DATE n]` |
| Phones | US numbers in any usual format, with dots, dashes, slashes, spaces or brackets, with or without +1 and an extension ("786-5550199", "786/555/0199"); international numbers starting with +; 7- and 10-digit numbers after "phone", "cel", "cell", "tel", "teléfono"... | `[PHONE n]` |
| Emails | any address | `[EMAIL n]` |
| IDs | 7 or more digits in a row; SSN-shaped numbers; a code of capitals with 5 digits ("W123456789"); 4 or more digits, spaced or not, after "Medicaid", "member", "MRN", "record", "policy", "case", "student", "ID", "#", an insurer's name (KidCare, Aetna, Sunshine Health, Humana, Simply, Molina...), also with "is" between ("number is SH4471-22"); the last 4 digits after "ending in", "last 4 of", "últimos 4" | `[ID n]` |
| Addresses | a street address (a unit, a number, street words, a street type, a unit, a city, a state and a ZIP code), Spanish-style streets ("22 Calle Ocho, Miami", "1500 Avenida Ponce de León"), a unit first ("Apartment 3B at ..."); a city with a state and a ZIP code; a Florida ZIP code after a city ("Doral 33172"); a ZIP after "ZIP"; a P.O. box. A place word takes no period unless it is an abbreviation ("St. Petersburg"), so an address never runs into the next sentence ("…, Miami. Mother said") | `[ADDRESS n]` |
| Names not on the sheet | after a label at the start of a line or a table cell ("Examinee:", "Respondent \|", "Evaluator:", "Referral source:", "Teacher:", "Nombre:"...); after a title ("Dr.", "Ms.", "Sra.") or a relation used as one, with no period after it ("Coach", "Abuela", "Tía", "Primo", "Grandma", "Aunt"; capitalized, or lowercase as in "his aunt Marisol"), never taking a test or form word ("Teacher Rating Scales", "Coach Training Program" stay as written); before a credential ("Ana María Prado-Ilustre, BCBA", "Rodrigo Ejemplar, M.D.") | `[NAME n]` |
| The days of an age | "6;8;8"; "6-8-8", "6:8:8" or "6:08:08" after "age", "aged", "CA", "Chronological age" or "Edad", with ":", "=", a table bar or "(Y:M:D)" between; "Chronological Age \| 6 \| 8 \| 8"; "6 years, 8 months, 8 days", "6 years 8 months & 8 days", "23 months 8 days", "6 years, 248 days", "6 años, 8 meses y 8 días": the days part is dropped ("6;8", "6 years, 8 months") | (removed) |

### Placeholders

Uppercase words in square brackets, numbered where the kind can repeat, in the order they are first met in a request: `[CLIENT]` (first name or nickname, restored as the preferred name), `[CLIENT FULL NAME]`, `[CLIENT LAST NAME]` (the whole surname) and `[CLIENT LAST NAME 1]`, `[CLIENT LAST NAME 2]` (each part of a double surname), `[CLIENT INITIALS]`, the same for `[CAREGIVER 1]`, `[FAMILY 1]` (siblings and other relatives) and `[PERSON 1]` (professionals), `[SCHOOL n]`, `[ADDRESS n]`, `[CITY n]`, `[PHONE n]`, `[EMAIL n]`, `[ID n]`, `[DOB]`, `[DATE n]`, `[NAME n]`, `[OTHER n]`. The same value always gets the same placeholder within a request. The format is set in one file, `src/main/deidentify/placeholders.ts`.

Each form restores exactly what it stood for: `[CLIENT LAST NAME 2]` comes back as "Gómez" and `[CLIENT LAST NAME 1]` as "Ficticio" (as the text wrote it most often, in the sheet's spelling: "de la Fuente" or "Fuente"), `[CLIENT FULL NAME]` as the sheet's full name, `[CLIENT FULL NAME 1]` as the fewer words it stood for, a `[NAME n]`, a `[DATE n]` and every value that is not a name as written.

When two findings overlap, the longer wins ("1234 Ficticio Street" is one address) and, at equal length, the sheet wins over a pattern; whatever part of the shorter one is left outside is hidden on its own, so nothing is left half-hidden.

## What is not hidden

- **The client's age** in years and months ("4 years 2 months", "4:2"): the writing needs it (owner's decision). Its days part is dropped.
- **Clinical content**: diagnoses and ICD-10 codes (F84.0), CPT codes (97153), test names (Vineland-3, BASC-3), scores, percentiles, ranges, ages in years:months, hours and times.
- **Recent dates and future dates** (interview, observation, test and planned dates) unless they fall on the birthday, a year alone ("since 2024"), a month with its year that is not the birth month ("March 2026"), the year left after a birthday written with its day and month ("born March 14, '20" keeps nothing; "March 14 20" keeps the "20": a year alone is allowed).
- **A city on its own that is not in a sheet address** ("they visited Orlando"); hidden only as part of an address found by its pattern.
- **Words of the sheet's common-word names in lowercase**, a sheet name inside an ordinary longer word, a school's distinctive word alone: reported in `possible`.

## Putting values back

`reidentify` accepts what models do to placeholders: another case (`[Client]`), a possessive inside or after the brackets for people (`[CLIENT'S]`, `[CLIENT]'s`), another separator or none (`[CAREGIVER_1]`, `[CAREGIVER1]`), doubled, escaped or other brackets (`[[CLIENT]]`, `\[CLIENT\]`, `{CLIENT}`), parentheses in capitals (`(CLIENT)`), one bracket missing (`[CLIENT went home`, `went home CLIENT]`) when no more label text runs to a closing bracket, and no brackets at all for an unmistakable label in capitals (`CAREGIVER 1`, `CLIENT FULL NAME`). Once a person is mentioned, every form of their name can be restored, even one that was not in the text sent.

It never restores part of a bracket. A bracketed stretch that is not a placeholder of this request but looks like one is reported and left in the text: an unknown placeholder (`[CAREGIVER 3]` when there are two), a placeholder the model invented (`[CLIENT NAME]`, `[Client's name]`, `[CLIENT FIRST NAME]`, `[CLIENT 1]`, `[CAREGIVER 1 AND 2]`, `[DOB MONTH AND YEAR]` when only `[DOB]` was sent, `[DOB'S]`), `[INSERT DATE]`. A lone `CLIENT` in capitals, which could be a heading, is reported too. "DOB" alone is left alone: it is how forms label a date of birth. Each restored placeholder comes with how many of its occurrences had to be repaired.

## PDF text

`extractPdfTextIsolated(bytes, spawnElectronPdfChild)` (`src/main/pdf-text/isolated.ts`, `electron-child.ts`) reads one PDF in its own Electron utility process, running the bundled `out/main/pdf-text-child.js` (a second main-process entry in `electron.vite.config.ts`; the source is `src/main/pdf-text/child.ts`):

- The process gets the bytes and the limits, answers once and is killed. Its heap is capped at 1 GB and code built from strings is refused (`--js-flags=--max-old-space-size=1024 --disallow-code-generation-from-strings`: a utility process ignores a bare `--max-old-space-size`, checked on Electron 45.4.1). PDF.js 6.5 needs no such code.
- The main process checks the process's whole memory every 250 ms (`app.getAppMetrics()`) and kills it above 1.5 GB: `too-large` (a decompressed stream lives outside the heap the flag caps; a 1 GB whitespace bomb is killed in about 2 s).
- The main process kills it at a hard 30-second limit, whatever it is doing: `timed-out`. A crash, an out-of-memory or a malformed answer: `crashed`. The main process and the window never wait on PDF.js.
- It gets an environment of its own with one variable (`ABA_WORKBENCH_PDF_READER=1`): none of the app's variables, such as a provider key set in a shell profile, reaches it. (Electron 45 reads an empty `env` as "inherit everything".) It still runs with the user's file and network access: a Node.js utility process cannot be sandboxed; a PDF.js exploit would run with those rights, which is the remaining risk.
- Inside, `extractPdfText` (`extract.ts`) refuses files over 20 MB and over 300 pages, and stops between pages past 200,000 characters on a page or 2,000,000 in all (`too-large`), with a soft time limit two seconds before the hard one. PDF.js parses a page's whole content before it hands out any of its text, so a single-page bomb runs until the memory or time limit, not the character budget.
- An ESLint rule forbids importing PDF.js or `pdfjs-reader.ts` anywhere but the reading process: main-process code can only call `extractPdfTextIsolated`.

It returns:

- `{ status: "text", text, pageCount, pagesWithoutText, pagesNeedingReview }`: the text, each page under `--- Page 2 of 3 ---`; a page with no text layer is marked `[No text on this page: it is probably a scanned image. Its content is not included.]` and listed in `pagesWithoutText`, so the interface can ask her to paste those scores; a page whose text was letter-spaced or overlapping is listed in `pagesNeedingReview`.
- `{ status: "no-text", pageCount }`: no page has text, almost always a scan: the interface asks her to paste the scores.
- `{ status: "unreadable", reason }`: `not-a-pdf`, `password`, `damaged`, `too-many-pages`, `too-large`, `timed-out` or `crashed`.

A page counts as having no text when it has fewer than 20 letters and digits, or when more than 30% of its characters are unreadable glyphs (a font with no usable text map).

The reader is Mozilla's PDF.js (`pdfjs-dist`, Apache-2.0, pinned to 6.5.438; its license ships in the app as `licenses/PDF.js-Apache-2.0.txt`), its Node.js build, bundled into the reading process only (`out/main/index.js` does not contain it). It only reads text: its worker runs in the same thread, nothing is drawn and no font is loaded, the PDF's scripts and XFA forms never run, and this version of PDF.js no longer compiles fonts into JavaScript (the path of CVE-2024-4367; its `isEvalSupported` option is gone). Its optional native canvas package (`@napi-rs/canvas`) is not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`): it is only for drawing. Without it PDF.js prints three warnings when it is first loaded ("Cannot polyfill `DOMMatrix`" and the like), in the reading process: expected, harmless for text.

The layout (`src/main/pdf-text/layout.ts`) rebuilds reading order from each piece of text's position: lines top to bottom; a table row on one line with its cells joined by ` | ` (`Communication | 23 | 62 | 57–67 | 1 | Low`), even when a cell wraps onto several lines and the other cells sit between them; a label and its value on one line (`Examinee | Mateo Ficticio`); the lines of a paragraph joined; a blank line between blocks. Letter-spaced pieces ("L u c i a") are joined back into words, using their own letter spacing to tell a letter from a word gap. Charts, pictures and the visual layout are lost.

## Known limits

- A person who is not on the sheet, written without a title, a relation word, a credential or a label ("Bruno visits on Sundays"), is not hidden. The review screen is where she adds them.
- A nickname not on the sheet that is not a Spanish diminutive ("Lucy", "Andy", "Lu") is not caught; a capitalized shortening of a long given name ("Vale") is only reported. A misspelling that is not an OCR confusion ("Mateu"), undotted initials ("MF"), a name word of 3 letters or fewer broken inside ("T eo") and names in another script are not caught.
- A sheet name inside an ordinary longer word with no boundary ("mateoficticio" in running text, not a file name or a handle) is only reported.
- Free-text details that identify without any name or number (a rare event, a unique job) are not caught.
- A date without a year ("on March 14") is hidden only when it is the birth date.
- PDFs: letter-spaced text whose word gaps PDF.js does not keep can come out with words run together ("3/14/2020andseen"); the names, dates and addresses of the sheet are still caught there, and the page is flagged for review. A word hyphenated at a line end keeps its hyphen in the text ("Fic-ticio"): sheet values are caught across it, other words read hyphenated. Text drawn overlapping other text can come out in the wrong order (also flagged). A page in two columns is read across both columns line by line; rotated text is read as if it were not; values typed into a fillable PDF form's fields are not read; scanned pages are not read (no OCR).
- Over-hiding the owner's rules accept: the sheet's city inside an institution's name ("[CITY 1] Children's Hospital"), a capitalized common-word name at the start of a sentence ("Brown rice"), a month and day that equal the birthday in another sense ("Set 3 Mar 14 targets").
- The reading process is checked in real Electron by `pnpm check:pdf-reader`, not by the unit tests; the app does not call it until part 2, which should cover it in a window test.

## Tests

With invented people only:

- `tests/deidentify.test.ts`, with a battery of invented paragraphs (`tests/deidentify-battery.ts`): Spanish and English names, accents and no accents, hyphenated and double surnames with particles, a caregiver sharing the client's surname, a father sharing a first name, a school named after a person, names that are common words, names split across lines, dates, phones, emails, IDs, addresses, CPT and ICD codes, scores. Measured: 86 identifying strings, 0 slipped through, 0 clinical strings wrongly hidden. Round trip: every placeholder comes back, none is reported, de-identifying the restored text gives the same placeholders again, and a text written with the sheet's own spellings comes back exactly. The two invented fixture cases' notes keep no name, the evaluators, the pediatrician and the psychiatrist included.
- `tests/deidentify-adversarial.test.ts`: both review rounds' inputs and variants of each class of leak (`tests/deidentify-adversarial.ts`): 142 probes with 248 identifying strings (every date-of-birth format, birthdays, abbreviated and partial addresses, the city, short school names and initials, phone and ID variants, names joined to file names, handles and hashtags, invisible characters, letter-spaced, hyphenated and split names, ligatures and fullwidth letters, HTML references, OCR misreadings, diminutives, people not on the sheet, ages with days), 0 slipped through; 16 lines of clinical text (tests and forms with title words, CPT and ICD codes, scores, common words, labels) unchanged; 28 things models do to placeholders, each restored or reported, none garbled; 8 texts restored exactly as written (or, for names, as the same words in the sheet's spelling); 100,000 dates in a row stay fast.
- `tests/deidentify-generated.test.ts`: property-style tests from a fixed seed, each variant put in a sentence: 2,000 sheet names under random hyphenation points, splits, letter spacing, case, accents, decomposed accents, fullwidth letters, ligatures, invisible characters, HTML references, possessives, joined file names, handles and hashtags, and OCR swaps; 3,784 date-of-birth sentences (every combination of month form, day form, year form, order and separator) and 684 birthday sentences (month and day alone); 2,000 phones, IDs, school names, cities and addresses under random separators, prefixes, hyphenation and abbreviations. 0 survive. (Run once more with three other seeds at 10,000 variants each: 0 survived.)
- `tests/pdf-text.test.ts`: the layout on positioned pieces (wrapped cells, a three-line cell, letter-spaced text, paragraphs, ligatures) and the extraction results with a stand-in reader (scans, garbled pages, unreadable files, every limit).
- `tests/pdf-fixtures.test.ts`: PDF.js on the fixture PDFs: the four invented score reports and `fixtures/pdf-text/layout-check.pdf` give exactly the texts in `fixtures/pdf-text/expected/`; `scan.pdf` is `no-text`; `mixed.pdf` lists page 2; a password-protected, a truncated, an empty and a non-PDF file each say why; the reviews' hostile PDFs (`tests/hostile-pdfs.ts`, generated at test time: a page-tree loop, a form that draws itself, 200,000 nested arrays, 5,000 pages, a whitespace bomb, a text bomb, letter-spaced names, a paragraph hyphenated at line ends through names, the school, the city and the date of birth) each end quickly with an answer and leak nothing.
- `tests/pdf-isolated.test.ts`: the reading process (here a Node.js child process running the same `child.ts`) reads a fixture; a process that hangs or loops is killed at the hard limit; a crash, an out-of-memory and a malformed answer are reported; a 650 KB text bomb (256 MB of text operators) never blocks the parent's event loop; files too large or not PDFs never start a process; every process started has ended.
- `tests/licenses.test.ts`: PDF.js's license in `licenses/` is the package's own; the third-party notices trace each bundled module to its package and carry its license text; the packaged window tests check both are in the app.
- `pnpm check:pdf-reader` (`scripts/check-pdf-reader.mjs`), in real Electron, with the flags, the environment and the memory limit of `electron-child.ts` (read from `isolated.ts`): the built child reads a fixture and reports a scan in a utility process, a text bomb is stopped without blocking the main process, a 1 GB whitespace bomb is killed at the memory limit, the heap cap and the refusal of code from strings reach the child, it sees none of the app's environment, and an out-of-memory ends only the child.

The fixture PDFs are made by `node scripts/render-fixture-pdfs.mts` (headless Chrome) from invented HTML: the score reports from `fixtures/cases/<case>/reports/`, the extraction fixtures from `fixtures/pdf-text/` (`scan.pdf` and `mixed.pdf` from a screenshot of `scan-source.html`, as a scanner would make them). After rendering again, regenerate the expected texts only after reading what changed.
