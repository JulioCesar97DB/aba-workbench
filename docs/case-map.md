# The case map

Step 1 of the AI knowledge plan (owner's decisions D1 to D35, 2026-11-23; the proposal is in the coordinator's notes, `step1-proposal.md`). The case map is one structured record of the case: its client, caregivers, settings, deficit areas, strengths, behaviors and their groups, risks, facts, open items, and the report on her own sections. The AI will draft it, she corrects and approves it part by part, and every section will be written from it, with the whole sources still sent.

Pull request 1 built the map's storage, its history and status, and the **Case map** step (step 2 of a case, `/case-map`, "Mapa del caso" in Spanish) where she types, corrects and approves it by hand. Pull request 2 adds the AI's draft ("The AI's draft", below). The next ones add the evaluation of the map, the code-rendered tables for ABA Matrix, "Read what I have" fully, session notes as facts, and the map in every section request.

## Storage: `aba-case.json`, schema version 4

`src/main/case-file.ts` (the file) and `src/main/case-map.ts` (the map). Version 4 adds one optional top-level key, `caseMap`. A version 3 file reads as version 4 **with no map** (`MIGRATIONS[3]` adds nothing, D7): a case has a map only once she types one, or (later) the AI drafts one. Every rule of the data file still holds: lossless reading, unknown keys kept everywhere (in the map too: unknown parts, kinds, origins, tags and fields), a newer file never written to, durable writes, the 50 MB cap.

```json
{
  "schemaVersion": 4,
  "…": "the keys of version 3",
  "caseMap": {
    "parts": {
      "behaviors": {
        "currentVersion": 2,
        "approvedVersion": null,
        "versions": [
          { "number": 1, "kind": "ai", "createdAt": "…", "extraction": "…", "content": { "items": ["…"], "groups": ["…"] } },
          { "number": 2, "kind": "edited", "createdAt": "…", "updatedAt": "…", "basedOn": 1, "content": { "items": ["…"], "groups": ["…"] } }
        ]
      }
    }
  }
}
```

### Parts and their history (D1, D2)

The parts are `client` (one item, id `client`), `caregivers`, `settings`, `deficits`, `strengths`, `behaviors` (items and `groups`), `risks`, `facts`, `openItems` and `report`. Each keeps its own versions, like a section:

- an AI version (`"ai"`, or `"update"` for an update of a map that existed) never changes;
- her edits go into one `"edited"` version that changes in place while she types (her **editing pass**: the version the last answer named), as long as it is the newest version, the one shown, and not approved; otherwise her edit starts a new version based on the one shown;
- a new version takes the part's approval away (she approves again); approved content never changes: a version she ever approved carries `"approvedOnce": true` and is never edited in place again, even after she takes the approval back;
- going back to a version only moves `currentVersion`;
- removing an item makes a version without it; every earlier version keeps it, and its id is never used again.

A part's status follows the version shown: **empty** (no versions), **draft** (the AI's, not approved), **corrected** (hers, not approved; shown as "Typed by you" when the part never had an AI version) and **approved** (the version shown is the approved one). Each item also records `editedAt`, when she last changed it by hand.

### Claims and provenance (D3)

Every fact-bearing value is a claim: `{ "value": "…", "refs": [ … ], "origin": "…", "check": "…" | null }`.

- `refs` say where it came from: `source` (a source id and a verbatim quote), `section` (one of her sections, its version and a quote), `note` (her session notes), `her` (she typed or changed it) or `app` (computed).
- `origin` is the kind of content (the four kinds of `rules/assessment.md`): `her`, `extracted`, `ai-drafted`, `hypothesis` (functions and groups) or `proposed` (a clinical choice that is hers, such as a barrier tag).
- `check` is the text of a `[CHECK: …]` on the value.

The interface sends values and `[CHECK]`s only; the main process records provenance. A value she keeps keeps its refs and origin; a value she changes or adds becomes hers (`origin: "her"`, a `her` ref first, every earlier ref kept after it, never cut: a claim holds at most 10 refs where it came from plus one of hers, so her edit of any claim that reads back always fits). A list of claims is matched by value first, so a line she did not touch keeps its source; when no line was added or removed in the same save, a line she edited then takes the unmatched stored line at the same place, so its earlier refs follow it after hers (otherwise it is hers alone, never given another line's source). A line she added and left empty is not stored. A function or a group becomes hers when anything in it changes. In this pull request she cites no source by hand; the AI's quotes come with the extraction.

### Limits (D6)

Read and written with these limits (`src/shared/case-map.ts`): 30 behaviors and 30 groups, 20 deficit areas, 60 strengths, 10 caregivers, 20 settings, 40 risks, 500 facts, 500 open items, 200 report items; 30 entries per list, 10 refs per claim; names 120 characters, quotes 300, texts and [CHECK]s 1,500, definitions 3,000; 10,000 versions per part. A file past a limit reads as damaged and is never rewritten with less; a change past a limit is refused before anything is saved.

### Other rules kept in code

- A behavior is in one group at most. Nothing about groups is ever refused (a refused save would lose what she typed): a behavior she ticks into a group leaves the group it was in (marked changed by her), an id the version has no behavior for or one named twice is dropped, and removing a behavior takes it out of its group. The group form says, beside a behavior that is in another group, that ticking it moves it.
- An edit of an item the version shown does not hold (she showed an older version, or "Try again" of an edit kept from before) brings the item back, from the newest version that had it, with her edit, into a new version. Only an id no version ever had is "not found".
- The section 8 baseline mean is the app's (D20): the mean of the dated counts, two decimals, or none when a count is missing or does not start with a plain number (`baselineMean`). A count is the plain number its value starts with, so "3 contacts" counts as 3 and "2.5 incidents" as 2.5; "about 3", a range ("3-4", "3 to 4"), "3:30" and an empty value give none (owner's decision of 2026-11-28). For a behavior measured by duration the mean is a duration (`baselineDurationMean`): each value must start with a plain number followed by its time unit (s, sec, seconds, min, minutes), every value must give the same unit and say per incident, total or per session alike, and the mean is shown in that unit ("9.5 minutes per incident"). A value with no unit ("2 episodes"), mixed units or a range gives none; nothing is converted.
- Intensity is hers only (D19); barrier tags come from her fixed list of nine (D18); the functions are her five, in her order (D17).

## What she does on the Case map step

- The part bar shows each part with its status dot and count; the sidebar's step shows parts approved out of parts with something in them; a part approved while empty is counted in neither (`caseMapSummary`), as the case summary and Home count them.
- She adds an item (or a group, in the behaviors part), types it, and it is saved as she types, with no Save button: `window.aba.saveMapItem` goes through the failed saves (`"map-item"`), so an edit the disk refuses is kept by the main process, offered with Try again, and put back in its form after a reload, like a section's text.
- Each value shows chips for where it came from and its `[CHECK]`, with Resolved to clear it.
- She approves the part shown (in the header), or takes the approval back. For now approving only marks the part as checked by her; the sections start using approved parts in a later pull request, and the screen says so. An approval or a version shown never becomes her editing pass, so an edit after taking an approval back starts a new version and the content she approved stays recorded.
- The rail lists what is still marked [CHECK] in the part (each opens its item) and the part's versions, newest first, to show another one. Behavior rows show their functions; the baseline shows its mean, computed by the app (D20), or a dash when a count does not start with a plain number, and, for a frequency behavior, the intensity her rule suggests.
- Lists, rows and evidence stop at 30, and the button says so.
- After adding an item, its first field takes the focus once; after removing one, the Add button does. What she typed in an item is saved before the removal is asked; when it cannot be saved, the failure shows with Try again and the removal is not asked.
- The report on her sections is shown empty until the AI reads her sections (a later pull request); she will only mark its items.

## The AI's draft (pull request 2)

"Draft the map with the AI" ("Armar el mapa con la IA"), or "Update the map with the AI" once the map has content, runs two requests, one after the other (D12):

1. **`map-facts`**: the client, caregivers, settings, deficit areas with scores, strengths, facts with their home sections, open items, and, when she has sections of her own, the report on them;
2. **`map-behaviors`**: the behaviors with topographies, definitions, baselines, antecedents and consequences, functions with their evidence and barriers; the groups; the risks (they name behaviors, so they come here); more open items.

**The prompt.** Each request is prepared in `src/main/outgoing.ts` (`prepareMapRequest`) like every request about a case. The system prefix (the whole-assessment rules, guide, style, examples, payer, instruments and requests) and the sources are exactly the section requests', so the cache is shared. The task holds, in order:

1. `rules/case-map.md` (and `rules/behaviors.md` for the behaviors, with its invented definition example), sent with map requests only (D15). The example is not in `examples.md`, so the prefix every section request caches stays as it was (owner's decision on review round 1, S9);
2. `<her-sections>`: every section that is hers or approved, first (D13): her text wins, and a source that disagrees becomes a [CHECK];
3. `<her-map>` on an update: the parts she approved, whole, and the items she changed by hand in the others, with their ids;
4. `<standing-instructions>` (behaviors only): her own definition thresholds, once she has saved them (D16); each line takes the place of the default it changes;
5. `<session-notes>`;
6. `<map-facts>` (behaviors only): the settings saved by the first request, with their ids;
7. the request.

On the ChatGPT route the task opens with a preamble of its own that names these blocks; section requests keep theirs.

**Structured output (D14).** The answer must follow one JSON schema per request (`src/lib/case-map-extraction.ts`):
- strict on both providers: every property required, objects closed, enums for every fixed list (the measure, a setting's kind and evidence, a strength's kind, a service's "paid"), no length limits;
- **one claim per score row** (owner's decision, 2026-11-23, case map speed): a deficit's score row carries its instrument, scale, score, percentile and level as plain text under one set of refs, an origin and a check, instead of five claims each quoting the same line. It is stored as before, as five claims, each with the row's refs and origin, so stored maps and the screen do not change. The row's own [CHECK] goes on its score (or its first field), and "a number is not in its quote" on the field that holds that number;
- **no union at all**: Claude takes at most 16 parameters with `anyOf` or a type array across a request's strict schemas, and the map has far more nullable values. So nothing is nullable on the wire: an absent value is an empty claim (`value: ""`, no refs), an absent text is `""`, an absent home section is `0`, a group's function or measure that cannot be named is `"none"`. Zod turns each back into `null`, so the stored shape does not change. A test counts the unions (0);
- Claude enforces it through `output_config.format`, OpenAI (key and ChatGPT sign-in) through `text.format`;
- a route whose refusal names the schema or the output format is asked the same request as plain JSON, and remembered for the rest of the app's run. Any other refusal (a PDF over a page limit, say) is reported as it is.

**The checks (D4).** The answer is read with Zod (the map's limits), then checked by code:
- every ref names a source, a section of hers or her notes that was sent;
- its quote has at least three words, one of them not a number, and is found word for word in that text. Quote marks, dashes, spaces, case and the source's Markdown (emphasis, table pipes, heading and list markers, escapes) are set aside on both sides;
- a value a source or her text states (`extracted`, `her`) has a ref;
- every number of every value is written in one of its quotes, without leading zeros, and a date counts as a date, not as numbers. A score row is one value: every number of its five fields, the instrument's ("Vineland-3") included, is in one of the row's quotes (the rules ask for a second ref quoting the report's title when the row's line does not name the instrument). An AI-drafted definition, onset or offset may also state her default thresholds (`DEFAULTS` in `src/shared/case-map-thresholds.ts`, listed word for word in `rules/behaviors.md`) or her own, each only as the threshold it is: the number with its unit, in the field it belongs in (5 s, 3 s and 6 ft for the start; 10 s and 6 ft for the end, 30 s only for a behavior named a tantrum). A line of her own replaces the default with the same label and adds its own thresholds, those after the word "tantrum" for a tantrum only; a line with no default's label adds its thresholds to all three fields. Any other number of seconds, feet or minutes there is a problem (`threshold`), and a default's number is never a count elsewhere (D16; owner's decision, 2026-11-28; review of T2, finding 1);
- every setting, group and risk link is known; keys are unique; no behavior is in two groups; a group's function is a primary function of each member and its measure is each member's.

A PDF's text cannot be read yet, so its quotes are marked "not checked" (D32). A value that cites only PDFs has its numbers unchecked too. A value that cites a PDF next to a text quote is checked against the text quote: a number found only in the PDF's quote passes, marked [CHECK] ("only in a PDF's quote"), and a number in no quote is a problem, as is a threshold nobody gave. Dates compare as dates: "5/14/26", "05/14/2026" and "May 14, 2026" are the same, and a date without its year matches one with it.

**The repair (D14, review round 1, B1; case map speed).** When problems are found, **one** repair request quotes only what failed and lists the problems, each with its item's key:
- an item whose problems are all its values' (a quote not found or too short, a number in no quote, a value outside its list, a value with no ref) is quoted as its key and those values only; of a list of entries (observations, a function's evidence, other services) only the failed entries, with what names them (a date, an instrument, a tool and its respondent). The repair answers those items with only those values filled and everything else empty, so it writes a few values, not the items again;
- an item with a problem of its own (a link to nothing, a function both primary and secondary, a group's rule, a report item) is quoted whole, as the AI wrote it;
- the whole answer when a problem belongs to no single item (a key used twice), or when the answer could not be read.

Its items are merged into the first answer's by key, field by field: a field the repair gives replaces the first answer's, and a field it leaves empty keeps the first answer's value, flagged again by the checks; an item it leaves out keeps the first answer's version. In a list of claims (examples, antecedents and the like), the first answer's claims that passed the checks stay unless the repair gives the same value; a failed claim is replaced by what the repair gives. After a whole-answer repair the repair's list comes first, and a key the first answer used twice is not doubled; after any other repair, an item under a key the first answer never used is left out (it would be a few values with no item around them). When the repair comes back unreadable, cut short or failed, the first answer is saved as it is. What still fails is saved and flagged: a ref the checks could not find is `checked: "not-found"` and the value gets a [CHECK]. The request's record keeps the problems the first answer had (`problemsBeforeRepair`), why the repair was needed (`repairCauses`: how many problems of each kind, `quote-not-found`, `number-not-quoted`, `quote-too-short`, `no-ref`, `threshold`, `not-in-list`, `unknown-ref`, `unknown-link`, `group-rule`, `function-both`, `duplicate-key`, or `unreadable`), what it quoted (`repairScope`: `values`, `items` or `whole`) and how many values it was asked to fix (`repairValues`), whether the repair was used, the problems left, and how long the answer and the repair took (`seconds`). `pnpm map-verify` prints them.

**Lengths (owner's decision, 2026-11-23).** Zod does not check the length of a value, a quote or a note in the AI's answer, so one long value never makes the answer unreadable. The code checks make a value, a quote, a claim's check, a score row's field, a function's reasoning or check, a respondent, or a group's nature or reason over its limit that value's own problem (`too-long`), fixed by the values-only repair. A report item's text over its limit is the item's (report items are quoted whole). What is still too long after the repair is cut to fit when saved: a value ends with "…" and gets a [CHECK]; a quote keeps its first words that fit, still word for word, so still found. An open item (never repaired) is cut to fit when read. Keys, ids and how many items a list holds are still Zod's.

**Notes on empty values.** An empty value is left out, but a [CHECK] the AI wrote on it ("the evaluation gives no severity level") becomes an open item, after the name of the item it is about ("Hand biting: …"), never a code path.

**What the AI cannot link.** A behavior's setting the map does not have, or a group's or a risk's behavior that does not exist, is left out with an open item naming it. Saving never stops on the AI's content: an item that does not fit the map's limits is left out and recorded among the request's problems, so one bad value never costs a whole answer. What the save leaves out counts in the number of problems the screen shows.

**Items shown as they arrive (case map speed, 2026-11-23).** While an answer is written, `src/lib/json-items.ts` finds each item of a top-level list (and the client) the moment its JSON closes. The item is read with Zod and checked on its own as the whole answer is (its quotes, numbers, links to the settings and to the behaviors that arrived before it); when it passes, it is put in the map's stored shape and sent to the screen (`"map-preview"`). Checks across items (keys used twice, a group's members) wait for the whole answer, so groups show once their request saves. Only what the save would write is shown (review round 1 of case map speed, S4): nothing of a part she approved, nothing under the id of an item she changed by hand (hers is kept), and no client when one is saved. On an update, an item under the id of a saved item is that item's new version (`replaces`), and the screen shows it under the saved item, not as a new row. The progress line counts only what is shown. Nothing is saved by a preview: the request saves after its checks and its repair, as before, and its previews then give way to the saved items. A stopped or failed request leaves nothing behind, previews included, and when it had shown some, its message adds "The items shown while the AI wrote were not saved." (review round 1 of case map speed, M5). A repair is not read this way (it is small).

**Saving (D1, D2, D5).** Each request's parts are saved as soon as they pass, as new versions: `"ai"` for a part that had none before the run, `"update"` otherwise.
- Ids are made by code. An item whose key is an id the part has had keeps it; any other key gets a new id, never one used before. Groups and risks get their behaviors' ids.
- An item she changed by hand is kept as hers in place of the AI's, and kept when the AI leaves it out.
- A part whose version shown she approved is never changed.
- Intensity is never filled by the AI (D19); the form suggests it (below). Barrier tags come in as proposals (D18). Functions and groups are hypotheses. A caregiver's mitigation no source states is a proposal. A value marked as hers stays hers only when a quote of her section or her notes was found.
- An observation's length is kept as the notes write it ("3:30 to 5:30 p.m."); the app works out its minutes (`minutesOfLength`) and marks them as its own (origin `"app"`, a ref of kind `"app"`), as it does the baseline mean (D20). A length written twice ("2 hours (120 minutes)") counts once; a range ("1-2 hours") or two lengths that disagree give no minutes.
- On an update, the risks keep their links to the behaviors she approved.
- Each request is recorded in `caseMap.extractions`: run, provider, models, rules versions, sources and sections used, tokens, cost, format, whether it was repaired and whether the repair was used, the problems before the repair, why and about how much it was repaired, the problems left, and its time.

**Her thresholds (D16).** Her defaults from her questionnaire answers of 2026-11-27 are in `rules/behaviors.md` for every user (owner's decision, 2026-11-28), so a draft uses them with nothing saved. The rail offers them (`THRESHOLDS_DRAFT`) for her to change: once saved they are the map's standing instructions (`"case-map"` in `instructions.json`), sent with every behaviors request, and each line she changes takes the place of that default, one threshold at a time; a default she leaves or deletes still applies. Her sections and the sources for this child come before both. The rules have the AI write `[MISSING: your threshold for …]` only for a threshold none of these gives (the task area, for example).

**The intensity suggestion (owner's decision 2A, 2026-11-28).** Next to the baseline mean, the behavior's form shows the intensity her rule gives (`suggestedIntensity`: a mean per session over 10 is 3, 5 to 10 is 2, under 5 is 1), only for a behavior measured by frequency with a mean. "Use it" puts it in the intensity field, saved as hers like any value she picks; nothing is saved until she clicks, and the button is hidden when the intensity already is the suggestion. A duration behavior, or one with only a caregiver's count, gets no suggestion.

**On screen.**
- The AI action is marked **Beta**, with one line saying its evaluation is in progress, in both languages: it ships in v0.2.0 before the map's evaluation (owner's decision, 2026-11-23).
- An empty map shows the two ways as UX-3's `TwoWays` cards: "A mano" (Add a behavior) and "Con la IA", which holds the AI action, or "Connect the AI" when none is connected (P7). The card is then the map's only AI action and its only "connect" line: the header has no AI button and the draft panel no "Connect ChatGPT or Claude" line, so nothing is said twice or greyed out (review round 1 of case map speed, M4). Once the map has content, the action ("Update the map with the AI") is in the header, in the AI's style, until the step adopts the two-ways bar. The AI action is its own component (`src/renderer/src/case-map/MapDraft.tsx`).
- While the AI works, a panel shows the two steps, what is arriving (how many items arrived, and how many passed their checks and show in the map), a repair by what it asks for again (review round 1 of case map speed, S5): "N values did not pass the app's checks: asking the AI to fix those values only" for a repair of values, "…to fix those items" when items are rewritten whole, and "…to write the answer again" for the whole answer, the time it has taken so far, measured, for the whole draft and for the step at work (no estimate of the time left: owner's decision, 2026-11-23), "It can take 10 to 20 minutes" (owner's decision, 2026-11-23, from the measuring run: 19 minutes with a whole-answer repair, about 13 without), and Stop.
- Each item that passed its checks shows at once in its part's list, with a dashed amber edge and "Checked, not saved yet"; opened, its fields are read-only, with their chips, and a line says it is saved, and can be corrected, when that step of the draft finishes. On an update, the AI's new version of a saved item shows under that item, marked "New version, not saved yet", and its line says it replaces that item when the step finishes. When a request's parts are saved, the saved items take their place.
- A draft that fails says so in her language, as a section does (owner's decision T11, `src/renderer/src/ai-errors.ts`): nothing more was saved, or the case facts are saved and the behaviors are not, followed by what to do for its kind of failure, with "Open Settings" when the way out is there. The provider's English text is only under "Technical details".
- Each chip says how its quote was checked ("not checked" for a PDF, "not found" in the warning color).

## Where the code is

| File | What |
| --- | --- |
| `src/shared/case-map.ts` | The parts, the claim and item types, the lists and limits, the status, the baseline mean |
| `src/main/case-map.ts` | The stored schema (Zod), the views, the changes (save, add, remove, show a version, approve) and the provenance merge |
| `src/main/case-map-service.ts` | What the interface may call; every argument checked |
| `src/main/failed-saves.ts` | The `"map-item"` kind |
| `src/renderer/src/screens/CaseMap.tsx`, `src/renderer/src/case-map/` | The step, the part bar, the item list, the form and the rail |
| `rules/case-map.md`, `rules/behaviors.md` | The map's rules, sent in the task of map requests only |
| `src/lib/case-map-extraction.ts` | The answer schemas, their Zod check, the code checks, what a repair quotes and the merge |
| `src/lib/json-items.ts` | The items of an answer found as it arrives |
| `src/lib/rules.ts` (`buildCaseMapPrompt`), `src/main/outgoing.ts` (`prepareMapRequest`) | The map requests' prompt |
| `src/main/case-map-draft.ts` | The draft's two requests, the plain-JSON resend, the repair, and the answers in the map's shape |
| `src/renderer/src/case-map/draft.ts`, `MapDraft.tsx` | The draft's store, the AI action, its progress, the two ways and her thresholds |
| `tests/case-map.test.ts` | Migration round trip, unknown keys, history, status, provenance, groups, limits, the service and a kept edit |
| `tests/case-map-extraction.test.ts` | The draft with a fake provider: prompts, schema, checks, repair, plain JSON, an update, her thresholds; score rows, repairs of only what failed, the items shown as they arrive |
| `tests/json-items.test.ts` | The items of an answer found as it arrives, however it is cut |
| `e2e/case-map.e2e.ts` | The step in the app window (run by CI) |
