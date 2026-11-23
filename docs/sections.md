# The report's sections

The section workspace: how the clinician starts, drafts, corrects, approves and copies each of the nine narrative sections of the initial assessment, how it is stored, and exactly what is sent to the AI. Decisions are the owner's (2026-11-22) unless marked otherwise.

## What she can do

Each section of the report (`src/shared/report-sections.ts`, in ABA Matrix's order) has a screen at `#/cases/<id>/report/<section id>` (`src/renderer/src/screens/Section.tsx`), matching the approved mockups (direction C, "Flujo 1" and "Flujo 2").

- **Start it** in one of two ways. "I already wrote it": she pastes what she already has in ABA Matrix; it is kept exactly as she wrote it (only line endings are made `\n`), used as context for the other sections and never contradicted. "Draft it with the AI": from the case's sources, her other sections, her standing instructions and her session notes.
- **Watch it stream** as it is written, with Stop always in view. A stopped, refused, failed or cut-short answer is never saved: the screen says nothing was saved and her versions are unchanged.
- **Correct it, both ways.** "Ask for changes in your own words" rewrites the whole text. Selecting a paragraph (click, or Enter/Space) opens "Change this paragraph": the model returns only that paragraph and the app puts it in place by character offsets, so everything outside that paragraph (the other paragraphs and the spaces and blank lines between them) stays exactly as it was. An answer that is not one paragraph (more than two paragraphs, another paragraph of the section repeated in it, or far longer than the paragraph) is not saved, and the screen says the AI returned more than the paragraph. "Edit the text" lets her edit by hand. "Improve it with the AI" (on her own text) adds a version beside hers.
- **Versions.** Every change is a new version (v1, v2, v3 beside the title, with what made it: "v3: “shorter, and mention the school” · Written by Claude Fable 5.2 · $0.18"). Going back to a version only moves the current pointer; nothing is ever removed.
- **Approve** a version. A newer version takes the approval away until she approves again; the approval of an earlier one is kept in the history.
- **Copy for ABA Matrix**, in one click: see "Copy for ABA Matrix" below. The message names the version copied, says how many `[MISSING]`/`[CHECK]` markers are still to resolve, and says which version is approved when she copied another one.
- **Lines that are not paragraphs.** Text pasted with single line breaks reads as one paragraph (many text boxes copy that way). The paste editor and the reading view say so and offer "Treat each line as a paragraph", which makes a new version; her text stays as she pasted it.
- **Her standing instructions** for each section (the rail), remembered for all her cases.
- **Her notes for this session** (the sidebar, under the sections), used in every request about this case until she presses "Start a new session", which archives them.
- **Checks** beside the text: structure, missing data and consistency with her sections (below).
- The sidebar counts the sections that are hers or approved ("Sections · 3 of 9"), and the sidebar and the Report step show each section's state: not started (hollow dot), "Yours" (green), "v3" (amber: an AI draft waiting), "Approved" (green).
- **Which AI.** The connected provider; with both connected, a "Write with" choice, defaulting to the one she used last. The model is the most capable one unless she chooses the other in Settings ("AI model").
- **Not ready for real client data.** Until de-identification is plugged in, every section screen says so plainly ("Not ready for real client data yet"), above anything that can send a request.

## Section states

What the other sections build on (`finalVersion` in `src/main/case-sections.ts`): the approved version; otherwise her newest final text: what she pasted, her edit of it (`edited` based on her own text), or her hand fix of the version she had approved (`fromApproved`; the edit clears the approval as decided, but stays what the other sections use until she approves again), and her edits of those. An AI version she edited without having approved it is never context.

`sectionState` in `src/shared/sections.ts`: `not-started` (no version), `hers` (the current version is her own text, pasted or edited before any AI version), `drafted` (the current version was written by the AI, or edited after one), `approved` (she approved a version).

## Storage

### In the case's data file: `aba-case.json`, schema version 3

`src/main/case-file.ts` and `src/main/case-sections.ts`. Version 3 adds two top-level keys; a version 2 file reads as version 3 with `"sections": {}` and is written as version 3 on its next save (`MIGRATIONS[2]`). Every rule of the data file still holds (lossless reading, unknown keys kept, a newer file never written to, durable writes, the 50 MB cap).

```json
{
  "schemaVersion": 3,
  "…": "the keys of version 2 (id, label, clientAge, times, files, sources)",
  "sessionNotes": { "text": "The mother confirmed today…", "startedAt": "…", "updatedAt": "…" },
  "sessionNotesArchive": [{ "text": "…", "startedAt": "…", "updatedAt": "…", "endedAt": "…" }],
  "sections": {
    "medical-necessity": {
      "currentVersion": 3,
      "approvedVersion": 3,
      "approvedAt": "2026-11-22T18:10:00.000Z",
      "versions": [
        {
          "number": 1,
          "kind": "draft",
          "createdAt": "2026-11-22T18:00:00.000Z",
          "text": "…the section, paragraphs separated by one blank line…",
          "generation": {
            "provider": "anthropic",
            "requestedModel": "claude-fable-5-2",
            "servedModel": "claude-fable-5-2",
            "effort": "high",
            "rulesVersions": { "assessment": "3", "requests": "1", "section-medical-necessity": "3", "…": "…" },
            "sourcesUsed": [{ "id": "…", "title": "CDE (2026-10-02)" }],
            "sectionsUsed": [{ "id": "background-information", "version": 1 }],
            "instructions": "Each area with its score…",
            "notes": "The mother confirmed today…",
            "deidentified": false,
            "usage": { "uncachedInputTokens": 7400, "cacheWriteTokens": 34000, "cacheReadTokens": 0, "outputTokens": 8100 },
            "costUsd": 0.92
          },
          "consistency": { "status": "none", "items": [], "checkedAt": "…", "model": "claude-fable-5-2", "costUsd": 0.1, "sectionsCompared": [{ "id": "background-information", "version": 1 }] }
        },
        { "number": 2, "kind": "paragraph", "basedOn": 1, "paragraphIndex": 1, "request": "explain the percentiles", "createdAt": "…", "text": "…", "generation": { "…": "…" } },
        { "number": 3, "kind": "change", "basedOn": 2, "request": "shorter, and mention the school", "createdAt": "…", "text": "…", "generation": { "…": "…" } }
      ]
    },
    "background-information": {
      "currentVersion": 1,
      "approvedVersion": null,
      "versions": [{ "number": 1, "kind": "hers", "createdAt": "…", "updatedAt": "…", "text": "…exactly as she pasted it…" }]
    }
  }
}
```

- `kind`: `hers`, `draft`, `change`, `paragraph`, `improve`, `edited`. A kind or a section id a newer app writes is kept as it is (shown as an edit).
- Version numbers are never reused. AI versions never change. Her own text (`hers`, `edited`) is updated in place while she types in that same editing pass and it is still the newest version and not approved; any later pass, or an edit of an approved version, starts a new version (approved text never changes).
- **Nothing the app writes can make a case unreadable.** Every write of `aba-case.json` is first read back with the same rules it is read with (`readableCaseFileText` in `src/main/case-file.ts`); a change that would not read back whole is refused (`not-saved`, logged) and the file stays as it was. What a model returns is clamped to those limits before it is saved (a check keeps at most 20 items of at most 2,000 characters; model names at most 200); an answer longer than a section can be (100,000 characters) is not saved and says so. `instructions.json` follows the same rule.
- **What she types is never lost on a reload.** A section's text (with its editing pass), her instructions and her notes are saved through the main process's store of changes that could not be saved (`src/main/failed-saves.ts`), as the sources are: when a save fails, the change itself is kept there while the app runs, the section screen shows it (and Home lists the case) after a reload, and "Try again" saves what was typed. Closing or quitting asks first while any is left.
- **The kept text goes back in its box.** After a reload, the box it came from (the session notes, the section's instructions, or the section's editor, reopened in edit or paste mode) shows the kept text instead of the older text on disk, while the alert still says it is not saved; "Try again" saves it, and her next keystroke builds on it (`useKeptText` in `src/renderer/src/autosave.tsx`). The main process is told when a box shows a kept text (`failedSaveShown`). A save that does not contain a kept text, from a box that never showed it, never forgets it: a kept section text is first saved as its own version, and kept notes or instructions stay kept, with Try again. A later failed text that does not hold the kept one is kept beside it, never over it.
- `generation` records what made each AI version: who answered, the rules versions, the sources, her sections, the instructions and notes as they were sent, whether the client's details were hidden (`deidentified`, false until de-identification is plugged in), the tokens and the cost (null with ChatGPT sign-in, which spends her plan).
- `consistency`: the check run right after an AI version is saved (below).
- About 10 KB per version: hundreds of versions stay far under the file's 50 MB cap.
- `sessionNotes` holds the session under way; "Start a new session" moves it to `sessionNotesArchive` (kept, never sent again). The key names avoid `notes`, which a version 2 file could hold as an unknown key.

### Her standing instructions: `instructions.json` in the app's data folder

`src/main/instructions.ts`, next to `settings.json` (`~/Library/Application Support/ABA Workbench` on macOS, `%APPDATA%\ABA Workbench` on Windows), written durably.

```json
{
  "version": 1,
  "sections": {
    "medical-necessity": {
      "text": "Each area with its score, one example from home and one from school.",
      "updatedAt": "2026-11-22T18:00:00.000Z",
      "history": [{ "text": "an earlier text", "savedAt": "2026-11-21T10:00:00.000Z" }]
    }
  }
}
```

Nothing is lost: when she starts a new editing pass (more than 10 minutes after the last change), the earlier text joins `history`. A file this version cannot read whole (damaged, or from a newer app) is never written over: the instructions read as empty, saving is refused and the screen says it could not be saved.

### The model choice

`settings.json` gains `models` (`{ "anthropic": "claude-opus-5-5" }`, only when she chose one) and `lastProvider`. The choices are in `src/shared/models.ts`: Claude Fable 5.2 (default) or Claude Opus 5.5; GPT-6.2 Astra (default) or GPT-6.2 Sol.

## What is sent to the model

Every request about a case is prepared by **one function**, `prepareOutgoingRequest` in `src/main/outgoing.ts`, and nothing else can make one: `runSectionGeneration` takes only what it returns (a value tagged by that function), a unit test fails if any other file builds a section prompt or calls a provider, and `StreamRestorer` applies the request's `restore` to everything that streams back (holding back a `[` that is not closed yet, so a placeholder split across two pieces of the stream is restored whole). De-identification plugs in there: on every piece of text (sources, her sections, instructions, notes, the text being corrected and her request), with its restore map becoming `restore`. Until then, `deidentified` is false, `restore` returns the text as it is, and the interface shows the notice.

**PDFs** are sent as files (base64) for now. The owner decided PDFs are never sent to a provider as files; this is acceptable only while the app shows it is not ready for real client data, and the de-identification task replaces it with each PDF's text, extracted locally and de-identified in `prepareOutgoingRequest`.

Each request, in this order (`buildSectionPrompt` in `src/lib/rules.ts`):

| Part | What | Cached |
| --- | --- | --- |
| System | `rules/assessment.md`, `rules/payers/florida-medicaid-molina.md`, `rules/instruments.md`, `rules/requests.md` | Yes: the same for every case and every request. |
| Sources | Every source of the case not removed, whole (never a prepared summary), each in a `<source>` tag named by its type, title and date | Yes: the same for every request of the case. |
| Task | The section's rules (`rules/sections/<id>.md`); `<her-sections>`: her other sections that are hers or approved, each labeled, final (unapproved AI drafts are never context); `<standing-instructions>`; `<session-notes>`; then the request: a draft; a change (`<current-text>` and `<her-request>`); a paragraph change (`<current-text>` with `<marked-paragraph>`, and `<her-request>`); an improvement (`<current-text>`) | No: it changes from one request to the next. |

Text she typed cannot open or close one of these tags (`quoteForPrompt`).

**Caching.** Claude: two breakpoints (after the system, after the sources) with the one-hour cache (`ttl: "1h"`, writing costs twice the input price instead of 1.25 times; she reads and corrects for longer than five minutes between requests). OpenAI with an API key: 30 minutes, as before; with ChatGPT sign-in, the plan's own cache.

Claude keys its cache on the request's settings as well as its text (a change of effort invalidates it). So every section request runs with the same settings (owner's decision, 2026-11-23): effort high and 32,000 output tokens for drafts, changes, paragraph changes, improvements and consistency checks alike, with the same system and sources before the breakpoints. The first request of the hour writes the cache and every later request in the hour reads it, the checks and paragraph changes included. A unit test (`tests/sections.test.ts`, "M4") sends every kind of request through the real Claude request builder and checks that everything up to the last cache breakpoint is identical.

**Effort and output room** (`src/main/sections.ts`): every request at effort high with 32,000 output tokens (only what is written is billed).

**Expected cost** (Claude with an API key; prices in `src/lib/pricing.ts`, checked 2026-11-21; a real case of about 30,000 tokens of sources, rules about 4,000, the task with her sections about 7,500, a draft about 8,000 output tokens with its thinking):

| Request | Claude Fable 5.2 (default) | Claude Opus 5.5 |
| --- | --- | --- |
| First request of the hour (cache written) | about $0.90 | about $0.45 |
| A draft or whole-text change within the hour | about $0.40 | about $0.20 |
| A paragraph change (the cache read; more thinking at effort high) | about $0.20 | about $0.10 |
| A consistency check (the cache read) | about $0.14 | about $0.07 |
| A whole assessment (9 sections, about 3 corrections each, about 30 checks, one cache write per working hour) | about $18 | about $9 |

What changed with one effort for everything: the extra cache write per hour for medium-effort requests is gone (about $0.54 on Fable 5.2, $0.27 on Opus 5.5 each hour, $1.5 to $2.5 over an assessment on Fable), while each paragraph change and check now thinks at effort high and costs a little more (about +$0.05 and +$0.04 on Fable). Over a whole assessment the two roughly cancel: the estimate stays about $18 on Fable 5.2 and $9 on Opus 5.5. The first real runs should confirm it with `cache_read_input_tokens` on the checks and paragraph changes.

ChatGPT sign-in spends her ChatGPT plan, not money. The real cost of each version is recorded with it (`costUsd`) and shown beside its number.

## Checks beside the text

`src/shared/section-text.ts`, `src/main/sections.ts`.

- **Structure** (local, free): plain paragraphs only (no headings, lists, bold or tables, which ABA Matrix does not take), and as many paragraphs and words as the section's rules ask when they say so (`paragraphs: 6-9`, `words: 900-1500` in the rules file's front matter; only Medical Necessity has them today).
- **Missing data** (local, free): every `[MISSING: …]` and `[CHECK: …]` marker, with what it says; markers are highlighted in the text.
- **Consistency with her sections** (AI): after each new AI version, a second request (same provider, model and settings, reading the cache the draft wrote; see "Caching") checks it against her sections that are hers or approved, and the answer (`NO CONTRADICTIONS`, or one line per contradiction) is saved with the version, with what it cost. With none of her sections yet, nothing is sent ("Nothing to compare yet"). While only the check runs, the button says "Skip the check": the version is already saved. A check that failed, was skipped, or no longer holds because her sections changed since ("Your other sections changed since this check") can be run again with "Check again", which goes through the same preparation as every request (`checkSection`).
- At a narrow window, where the rail falls below the text, a line near the top ("Checks: 2 to look at") leads to them.
- **Cost.** Each version shows what it cost, each check its own ("Check: $0.10"), and the Report step what the AI cost for the case so far.

## Copy for ABA Matrix

`abaMatrixClipboard` in `src/shared/section-text.ts`: the clipboard gets two forms at once (one `ClipboardItem`): plain text, its paragraphs separated by one blank line, and minimal HTML, one `<p>` per paragraph with no fonts, colors or styles (a line break inside a paragraph becomes `<br>`). A rich-text box takes the HTML and keeps clean paragraphs in its own font; a plain box takes the text. It has not been tried in ABA Matrix itself (no access from here): a one-minute paste into a field of an empty or invented ABA Matrix record would settle which form it uses.

## Writing rules for each section

`rules/sections/`. Medical Necessity has the BCBA's own structure. The other eight were written from the decisions file (`aba-assessment-template.md`): who reads it, what it covers, what to write, its gaps. Where the decisions file says too little to write a section's rules well, the file says so under "Not yet settled with the BCBA" instead of inventing clinical guidance (Background Information, Strengths and Weaknesses, Environmental Changes, Family/Caregiver Involvement, Discharge and Service Fading Plan, Risk Assessment, Crisis Plan). Generalization and Maintenance follows her two-paragraph description exactly. Crisis Plan gives no de-escalation techniques of its own (the decisions file does not give hers); Discharge tells the model not to describe the three phases. All are marked `confirmed: no` until she reviews them.

## Tests

- `tests/section-requests.test.ts`: every section has rules; the cached prefix is the same for every section and request; the parts of the task; a paragraph request marks that paragraph only; her text cannot break the tags; `prepareOutgoingRequest` reads PDFs only when sending and is not de-identified yet; `StreamRestorer`; only `src/main/outgoing.ts` builds a section prompt and only the generation runners call a provider; a complete generation is saved once; a refusal, a cut-short or empty answer and a stop never are.
- `tests/section-text.test.ts`: paragraphs, replacing one paragraph, markers, the structure check.
- `tests/sections.test.ts`: the section service with a faked model: her pasted text kept as written, editing passes, a draft with its record, context (hers and approved yes, unapproved drafts no), instructions and notes sent, the consistency check (nothing to compare, none, found), a paragraph change byte for byte, approval taken away by a newer version, improving her text, copy (both forms, markers), a stopped request saves nothing, hostile input refused before anything is read or sent, notes archived, the version 2 to 3 migration keeping what the file held, and the instructions file (history per editing pass, a damaged file never written over).
- `e2e/sections.e2e.ts` drives the window with Claude faked inside the main process (`stubDrafting` in `e2e/app.ts`, which refuses any other request): the whole flow in English, picking up a section in Spanish with her text, instructions and notes in the request and the check after it, stopping a draft and the no-AI state, and everything surviving a restart. `e2e/section-screenshots.e2e.ts` takes screenshots of every state in both languages when `ABA_SCREENSHOTS` names a folder.
