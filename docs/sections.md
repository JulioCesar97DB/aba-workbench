# The report's sections

The section workspace: how the clinician starts, drafts, corrects, approves and copies each of the nine narrative sections of the initial assessment, how it is stored, and exactly what is sent to the AI. Decisions are the owner's (2026-11-22) unless marked otherwise.

## What she can do

Each section of the report (`src/shared/report-sections.ts`, in ABA Matrix's order) has a screen at `#/cases/<id>/report/<section id>` (`src/renderer/src/screens/Section.tsx`), matching the approved mockups (direction C, "Flujo 1" and "Flujo 2").

- **Start it** in one of two ways. "I already wrote it": she pastes what she already has in ABA Matrix; it is kept exactly as she wrote it (only line endings are made `\n`), used as context for the other sections and never contradicted. "Draft it with the AI": from the case's sources, her other sections, her standing instructions and her session notes.
- **Watch it stream** as it is written, with Stop always in view. A stopped, refused, failed or cut-short answer is never saved: the screen says nothing was saved and her versions are unchanged. The screen and the file always agree (review round 4, R4-1): the Stop is checked right before the save and again in the case's save queue just before the write, so a Stop up to then writes nothing; once the write has started it finishes, and the screen shows that version and says it was saved because the text was already finished. A Stop (or "Skip the check") pressed while a request is still being prepared is remembered and sent as soon as it starts.
- **Correct it, both ways.** "Ask for changes in your own words" rewrites the whole text. Selecting a paragraph (click, or Enter/Space) opens "Change this paragraph": the model returns only that paragraph and the app puts it in place by character offsets, so everything outside that paragraph (the other paragraphs and the spaces and blank lines between them) stays exactly as it was. An answer that is not one paragraph (more than two paragraphs, another paragraph of the section repeated in it, or far longer than the paragraph) is not saved, and the screen says the AI returned more than the paragraph. "Edit the text" lets her edit by hand. "Improve it with the AI" (on her own text) adds a version beside hers; her facts (times, dates, numbers, names, scores) stay exactly as she wrote them, and anything the model thinks is wrong becomes a `[CHECK: …]` beside her fact, never a silent change (real runs, 2026-11-23: an improvement had turned her 3:00–6:00 p.m. into 5:30).
- **Versions.** Every change is a new version (v1, v2, v3 beside the title, with what made it: "v3: “shorter, and mention the school” · Written by Claude Fable 5.2 · $0.18"). Going back to a version only moves the current pointer; nothing is ever removed.
- **Approve** a version. A newer version takes the approval away until she approves again; the approval of an earlier one is kept in the history.
- **Copy for ABA Matrix**, in one click: see "Copy for ABA Matrix" below. The message names the version copied, says how many `[MISSING]`/`[CHECK]` markers are still to resolve, and says which version is approved when she copied another one.
- **Lines that are not paragraphs.** Text pasted with single line breaks reads as one paragraph (many text boxes copy that way). The paste editor and the reading view say so and offer "Treat each line as a paragraph", which makes a new version; her text stays as she pasted it.
- **Her standing instructions** for each section (the rail), remembered for all her cases.
- **Her notes for this session** (the sidebar, under the sections), used in every request about this case until she presses "Start a new session", which archives them.
- **Checks** beside the text: structure, missing data and consistency with her sections and her own text (below).
- **A request that fails** says what is known (for OpenAI: could not be reached; the connection dropped while it was answering, nothing saved; an answer the app could not read, nothing saved; no answer in time; an error OpenAI sent while answering, with its code and words; a problem on its side, with the status) and offers "Try again", which sends the same request to the same AI.
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
            "usage": { "uncachedInputTokens": 7400, "cacheWriteTokens": 34000, "cacheReadTokens": 0, "outputTokens": 8100, "reasoningTokens": null },
            "costUsd": 0.92
          },
          "consistency": {
            "status": "none", "items": [], "checkedAt": "…", "model": "claude-fable-5-2",
            "usage": { "uncachedInputTokens": 2100, "cacheWriteTokens": 0, "cacheReadTokens": 34000, "outputTokens": 900, "reasoningTokens": null },
            "costUsd": 0.1,
            "sectionsCompared": [{ "id": "background-information", "version": 1 }],
            "ownTextCompared": null
          }
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
- **The kept text goes back in its box.** After a reload, the box it came from (the session notes, the section's instructions, or the section's editor, reopened in edit or paste mode) shows the newest kept text instead of the older text on disk, while the alert still says it is not saved; "Try again" saves it, and her next keystroke builds on it (`useKeptText` in `src/renderer/src/autosave.tsx`). A box takes no typing until the page has read the list of kept texts (a few milliseconds at most; if the list cannot be read, it does not wait), so nothing she types can race a kept text it should show (review round 4, L-2). A box restores only once, when it opens; never later, and "Try again" never changes what a box shows, so nothing can put an older text back over one she has seen (review round 3, R3-1). In the main process, a failure of a box's own save counts as already shown in that box: typing and deleting during one outage stays one kept entry, her latest, and her next save that works clears it. After a reload no box shows anything until it says so (`failedSaveShown`; a reload resets it). A save that does not contain a kept text, from a box that has not shown it, never forgets it: a kept section text is first saved as its own version, and kept notes or instructions stay kept, with Try again. When a box shows the newest kept text, older ones kept beside it count as shown too.
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
| System | `rules/assessment.md`, `rules/guide.md`, `rules/style.md`, `rules/payers/florida-medicaid-molina.md`, `rules/instruments.md`, `rules/requests.md` (about 8,600 tokens since step 0 of the AI knowledge plan, 2026-11-23; about 3,000 before) | Yes: the same for every case and every request. |
| Sources | Every source of the case not removed, whole (never a prepared summary), each in a `<source>` tag named by its type, title and date | Yes: the same for every request of the case. |
| Task | The section's rules (`rules/sections/<id>.md`); `<her-sections>`: her other sections that are hers or approved, each labeled, final (unapproved AI drafts are never context); `<standing-instructions>`; `<session-notes>`; then the request: a draft; a change (`<current-text>` and `<her-request>`); a paragraph change (`<current-text>` with `<marked-paragraph>`, and `<her-request>`); an improvement (`<current-text>`, her facts kept exactly); a consistency check (`<current-text>`, and `<her-own-text>`: her own text of this section, when there is one) | No: it changes from one request to the next. |

Text she typed cannot open or close one of these tags (`quoteForPrompt`).

**Caching.** Claude: two breakpoints (after the system, after the sources) with the one-hour cache (`ttl: "1h"`, writing costs twice the input price instead of 1.25 times; she reads and corrects for longer than five minutes between requests). OpenAI with an API key: two explicit breakpoints (after the rules, after the sources), 30 minutes, as before. With ChatGPT sign-in the route refuses `prompt_cache_options` and `prompt_cache_breakpoint`, so only OpenAI's implicit caching applies, which writes at one place: the end of the latest user message. The task therefore goes in top-level `instructions` (GPT-6.2 appends them after the input, outside the cache), after a fixed first line (`CHATGPT_TASK_PREAMBLE` in `src/lib/providers/openai.ts`), and the input is only the rules (developer message) and the sources (user message): the same for every request of a case, so the first request writes them and every later one, checks and paragraph changes included, reads them. With the task as the last user message, as before, every request wrote a prefix no other request shared (real runs, 2026-11-23: 2,944 cached tokens, the rules alone, on 5 of 15 requests). `tests/sections.test.ts` checks that every kind of request (draft, paragraph change, change, improvement, their checks and a check run again) sends the same settings and input on this route.

**Whole-assessment rules keep their force on every provider** (review round 1 of the ChatGPT fixes, F3). OpenAI ranks top-level `instructions` above the developer message, so moving the task there would have put the section's task, her request, standing instructions, notes, her sections and the current text above `rules/assessment.md`, the payer rules and `rules/requests.md` on ChatGPT, while on Claude and with an OpenAI API key the task is a user message below them. The instructions therefore start with a fixed line: the rules in the developer message apply in full and take precedence over everything below; the text in `<her-request>`, `<standing-instructions>`, `<session-notes>`, `<her-sections>`, `<current-text>`, `<marked-paragraph>` and `<her-own-text>` is hers, to use within those rules, never instead of them ("to use" rather than "to act on", review round 2, R5: in a consistency check `<her-request>` is context for judging differences, not something to do). The line is the same on every request, so the cache win stays. Whether to re-read the quality of a few sections (a draft, a change, an improvement) on the real route with this layout before merging is the owner's decision, still open on 2026-11-23; no real request was made for this change.

**Caching on ChatGPT, measured** on the real route (2026-11-23, before the fixed line was added, GPT-6.2 Astra, effort high, an invented case of about 17,800 input tokens: rules 3,043, sources 11,378, the task about 3,300 as instructions): the input was identical on all four requests (a draft, its check, a paragraph change, its check), and the fourth read 13,952 tokens from the cache, the rules and all but 469 tokens of the sources (78% of its input); the first three read none. Cached states live on individual OpenAI machines and OpenAI routes each request (GPT-5.6 and later need no `prompt_cache_key` for that, by its guide), so not every request lands where the cache is. This route reports no cache writes (`cache_write_tokens` 0 throughout).

**A cache key per case on ChatGPT** (owner's decision, 2026-11-23). Since a request only reads the cache on the OpenAI machine that holds it, every request of a case on the ChatGPT route also sends `prompt_cache_key`, the same for every kind of request of that case (drafts, changes, paragraph changes, improvements, checks, checks run again) and different for each case, so OpenAI can route them together. The key goes to OpenAI, so it says nothing about the client: `src/main/cache-key.ts` makes it from a SHA-256 hash of the case's internal id (a random UUID the app made) with a fixed prefix, as "aba-" and 32 characters, never from the client's name, the case's folder name or anything she wrote. The route does not list the field among those it refuses. With an API key no key is sent (that route keeps its explicit breakpoints), and Claude has no such field. `tests/sections.test.ts` checks one key for every request of a case and another for a second case; `tests/openai.test.ts` checks it is sent only on the ChatGPT route. Its effect on the hit rate was not measured: no real request was made for it.

Claude keys its cache on the request's settings as well as its text (a change of effort invalidates it). So every section request runs with the same settings (owner's decision, 2026-11-23): effort high and 32,000 output tokens for drafts, changes, paragraph changes, improvements and consistency checks alike, with the same system and sources before the breakpoints. The first request of the hour writes the cache and every later request in the hour reads it, the checks and paragraph changes included. A unit test (`tests/sections.test.ts`, "M4") sends every kind of request through the real Claude request builder and checks that everything up to the last cache breakpoint is identical.

**Effort and output room** (`src/main/sections.ts`): every request at effort high with 32,000 output tokens (only what is written is billed). With ChatGPT sign-in the effort is sent as `reasoning.effort` and OpenAI echoes it back in the response (`"effort": "high"`, mode `standard`; real route, 2026-11-23), so it is honoured as a setting; GPT-6.2 reasons adaptively, though, and used no reasoning tokens on any of those four requests (14 of 15 in the first real runs). Each version and each check keeps its reasoning tokens (`usage.reasoningTokens`). The route takes no output limit (`max_output_tokens` is refused).

**Expected cost** (Claude with an API key; prices in `src/lib/pricing.ts`, checked 2026-11-21; a real case of about 30,000 tokens of sources, rules about 4,000, the task with her sections about 7,500, a draft about 8,000 output tokens with its thinking):

| Request | Claude Fable 5.2 (default) | Claude Opus 5.5 |
| --- | --- | --- |
| First request of the hour (cache written) | about $0.90 | about $0.45 |
| A draft or whole-text change within the hour | about $0.40 | about $0.20 |
| A paragraph change (the cache read; more thinking at effort high) | about $0.20 | about $0.10 |
| A consistency check (the cache read) | about $0.14 | about $0.07 |
| A whole assessment (9 sections, about 3 corrections each, about 30 checks, one cache write per working hour) | about $18 | about $9 |

Since step 0 of the AI knowledge plan (2026-11-23) the rules are about 9,000 tokens instead of about 4,000 (the guide and the style guide joined the cached prefix): on Claude Fable 5.2 that adds about $0.09 to each hour's cache write and a fraction of a cent to every request that reads the cache; the estimate above has not been redone.

What changed with one effort for everything: the extra cache write per hour for medium-effort requests is gone (about $0.54 on Fable 5.2, $0.27 on Opus 5.5 each hour, $1.5 to $2.5 over an assessment on Fable), while each paragraph change and check now thinks at effort high and costs a little more (about +$0.05 and +$0.04 on Fable). Over a whole assessment the two roughly cancel: the estimate stays about $18 on Fable 5.2 and $9 on Opus 5.5. The first real runs should confirm it with `cache_read_input_tokens` on the checks and paragraph changes.

ChatGPT sign-in spends her ChatGPT plan, not money. The real cost of each version is recorded with it (`costUsd`) and shown beside its number.

## Checks beside the text

`src/shared/section-text.ts`, `src/main/sections.ts`.

- **Structure** (local, free): plain paragraphs only (no headings, lists, bold or tables, which ABA Matrix does not take), and as many paragraphs and words as the section's rules ask when they say so (`paragraphs: 6-9`, `words: 900-1500` in the rules file's front matter; only Medical Necessity has them today).
- **Missing data** (local, free): every `[MISSING: …]` and `[CHECK: …]` marker, with what it says; markers are highlighted in the text.
- **Consistency with her sections** (AI): after each new AI version, a second request (same provider, model and settings, reading the cache the draft wrote; see "Caching") checks it against her sections that are hers or approved, and against her own text of this section: the first version she wrote or edited by hand on the checked version's own lineage (each version's `basedOn`, back from the one checked; a hand edit on another branch of her versions does not count, review round 2, R2), her hand edit of an AI version included, since a fact she fixed by hand is her latest word on it (`ownTextBefore`; a predicate of its own, not the one that decides what the other sections build on, where her edit of an unapproved AI draft does not count). A draft, which comes from no text of hers, is compared with her latest hand-written version before it. A hand edit of an AI version adopts every fact in it, even one that version's check reported, if she fixed only a typo (review round 2, R3: the owner's rule, a hand edit being her word on the facts; the earlier finding stays on that AI version). A fact of hers that the version replaces with another value is a contradiction, with or without a `[CHECK: …]`; her fact kept as she wrote it with a `[CHECK: …]` quoting a source beside it (the right answer to "Improve") is not, nor is a fact of hers left out. For a change or a paragraph change, what she asked for since her text (the requests of the versions on that same walk back, oldest first) goes to the check in `<her-request>`: a difference she asked for is not a contradiction, and a value she asked for becomes her fact, so a later version that keeps her old value or gives a third one is a contradiction, unless a later request changed it again (review round 2, R1). The answer (`NO CONTRADICTIONS`, or one line per contradiction) is saved with the version, with its tokens and what it cost, as for a version (`usage`, `costUsd`; no cost with ChatGPT sign-in), and the version of her own text it compared (`ownTextCompared`). With nothing of hers to compare, nothing is sent ("Nothing to compare yet"). While only the check runs, the button says "Skip the check": the version is already saved. A check that failed, was skipped, or no longer holds because her sections changed since ("Your other sections changed since this check") can be run again with "Check again", which goes through the same preparation as every request (`checkSection`).
- At a narrow window, where the rail falls below the text, a line near the top ("Checks: 2 to look at") leads to them.
- **Cost.** Each version shows what it cost, its checks theirs ("Check: $0.10", every check run on the version added up), and the Report step what the AI cost for the case so far. A check run again replaces the result but keeps what the earlier checks of the version cost and used (`earlierCostUsd`, `earlierUsage`), so a failed or stopped "Check again" never takes money already spent out of the totals. Tokens are kept in the case's data file for versions and checks alike, and shown for neither.

## Copy for ABA Matrix

`abaMatrixClipboard` in `src/shared/section-text.ts`: the clipboard gets two forms at once (one `ClipboardItem`): plain text, its paragraphs separated by one blank line, and minimal HTML, one `<p>` per paragraph with no fonts, colors or styles (a line break inside a paragraph becomes `<br>`). A rich-text box takes the HTML and keeps clean paragraphs in its own font; a plain box takes the text. It has not been tried in ABA Matrix itself (no access from here): a one-minute paste into a field of an empty or invented ABA Matrix record would settle which form it uses.

## Writing rules for each section

`rules/sections/`. Medical Necessity has the BCBA's own structure. The other eight were written from the decisions file (`aba-assessment-template.md`): who reads it, what it covers, what to write, its gaps. Where the decisions file says too little to write a section's rules well, the file says so under "Not yet settled with the BCBA" instead of inventing clinical guidance (Background Information, Strengths and Weaknesses, Environmental Changes, Family/Caregiver Involvement, Discharge and Service Fading Plan, Risk Assessment, Crisis Plan). Generalization and Maintenance follows her two-paragraph description exactly. Crisis Plan gives no de-escalation techniques of its own (the decisions file does not give hers); Discharge tells the model not to describe the three phases. All are marked `confirmed: no` until she reviews them.

Step 0 of the AI knowledge plan (2026-11-23, from the audit of the quality runs) revised them without new app features: Medical Necessity argues the most impairing behaviors with an incident and what the numbers mean instead of listing every count and questionnaire score, and keeps the incidents when shortened; Strengths and Weaknesses names Medical Necessity's areas without repeating its numbers and qualifies a strength only with a sourced fact; Background Information says what it owns and leaves the behaviors' data, the scores and the current changes to their sections; Family/Caregiver Involvement names the procedures without describing them, states training delivery only when a source gives it, and has an interim length; Risk Assessment leaves every response to the Crisis Plan; Discharge states criteria in the payer's form and no sentences commenting on the evidence. The whole-assessment rules separate facts, clinical reasoning and proposals: a clinical choice that is hers (strategies, parameters, supports, crisis steps, thresholds, training delivery, hours) is never written into prose until the case formulation exists and she accepts it there; until then it stays `[MISSING: …]`.

## Tests

- `tests/section-requests.test.ts`: every section has rules; the cached prefix is the same for every section and request; the parts of the task; a paragraph request marks that paragraph only; her text cannot break the tags; `prepareOutgoingRequest` reads PDFs only when sending and is not de-identified yet; `StreamRestorer`; only `src/main/outgoing.ts` builds a section prompt and only the generation runners call a provider; a complete generation is saved once; a refusal, a cut-short or empty answer and a stop never are.
- `tests/section-text.test.ts`: paragraphs, replacing one paragraph, markers, the structure check.
- `tests/sections.test.ts`: the section service with a faked model: her pasted text kept as written, editing passes, a draft with its record, context (hers and approved yes, unapproved drafts no), instructions and notes sent, the consistency check (nothing to compare, none, found; her own text of the section compared, her hand edit of an AI version included; what she asked for passed to it, in a chain of requests too; the right Improve answer not called a contradiction; its tokens and cost recorded, and kept in the totals when a "Check again" fails or is stopped), Improve told to keep her facts, every kind of request sending the same input to ChatGPT with only `instructions` changing and the rules' precedence line first, a paragraph change byte for byte, approval taken away by a newer version, improving her text, copy (both forms, markers), a stopped request saves nothing, hostile input refused before anything is read or sent, notes archived, the version 2 to 3 migration keeping what the file held, and the instructions file (history per editing pass, a damaged file never written over).
- `e2e/sections.e2e.ts` drives the window with Claude faked inside the main process (`stubDrafting` in `e2e/app.ts`, which refuses any other request): the whole flow in English, picking up a section in Spanish with her text, instructions and notes in the request and the check after it, stopping a draft and the no-AI state, and everything surviving a restart. `e2e/section-screenshots.e2e.ts` takes screenshots of every state in both languages when `ABA_SCREENSHOTS` names a folder.
