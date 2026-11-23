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
- The section 8 baseline mean is the app's (D20): the mean of the dated counts, two decimals, or none when a count is missing or not a plain number (`baselineMean`).
- Intensity is hers only (D19); barrier tags come from her fixed list of nine (D18); the functions are her five, in her order (D17).

## What she does on the Case map step

- The part bar shows each part with its status dot and count; the sidebar's step shows parts approved out of parts with something in them.
- She adds an item (or a group, in the behaviors part), types it, and it is saved as she types, with no Save button: `window.aba.saveMapItem` goes through the failed saves (`"map-item"`), so an edit the disk refuses is kept by the main process, offered with Try again, and put back in its form after a reload, like a section's text.
- Each value shows chips for where it came from and its `[CHECK]`, with Resolved to clear it.
- She approves the part shown (in the header), or takes the approval back. For now approving only marks the part as checked by her; the sections start using approved parts in a later pull request, and the screen says so. An approval or a version shown never becomes her editing pass, so an edit after taking an approval back starts a new version and the content she approved stays recorded.
- The rail lists what is still marked [CHECK] in the part (each opens its item) and the part's versions, newest first, to show another one. Behavior rows show their functions; the baseline shows its mean, computed by the app (D20), or a dash when a count is not a plain number.
- Lists, rows and evidence stop at 30, and the button says so.
- After adding an item, its first field takes the focus once; after removing one, the Add button does. What she typed in an item is saved before the removal is asked; when it cannot be saved, the failure shows with Try again and the removal is not asked.
- The report on her sections is shown empty until the AI reads her sections (a later pull request); she will only mark its items.

## The AI's draft (pull request 2)

"Draft the map with the AI" ("Armar el mapa con la IA"), or "Update the map with the AI" once the map has content, runs two requests, one after the other (D12):

1. **`map-facts`**: the client, caregivers, settings, deficit areas with scores, strengths, facts with their home sections, open items, and, when she has sections of her own, the report on them;
2. **`map-behaviors`**: the behaviors with topographies, definitions, baselines, antecedents and consequences, functions with their evidence and barriers; the groups; the risks (they name behaviors, so they come here); more open items.

**The prompt.** Each request is prepared in `src/main/outgoing.ts` (`prepareMapRequest`) like every request about a case. The system prefix (the whole-assessment rules, guide, style, examples, payer, instruments and requests) and the sources are exactly the section requests', so the cache is shared. The task holds, in order:

1. `rules/case-map.md` (and `rules/behaviors.md` for the behaviors), sent with map requests only (D15);
2. `<her-sections>`: every section that is hers or approved, first (D13): her text wins, and a source that disagrees becomes a [CHECK];
3. `<her-map>` on an update: the parts she approved, whole, and the items she changed by hand in the others, with their ids;
4. `<standing-instructions>` (behaviors only): her definition thresholds, once she has confirmed them (D16);
5. `<session-notes>`;
6. `<map-facts>` (behaviors only): the settings saved by the first request, with their ids;
7. the request.

**Structured output (D14).** The answer must follow one JSON schema per request (`src/lib/case-map-extraction.ts`):
- strict on both providers: every property required, objects closed, null as `anyOf`, enums for every list, no length limits;
- Claude enforces it through `output_config.format`, OpenAI (key and ChatGPT sign-in) through `text.format`;
- a route that refuses the schema (a 400 or "unsupported") is asked the same request as plain JSON, and remembered for the rest of the app's run.

**The checks (D4).** The answer is read with Zod (the map's limits), then checked by code:
- every ref names a source, a section of hers or her notes that was sent;
- its quote is found word for word (quote marks, dashes, spaces and case aside) in that text;
- every count, minute, score and percentile is written in one of its quotes;
- every setting, group and risk link is known; keys are unique; no behavior is in two groups.

A PDF's text cannot be read yet, so its quotes are marked "not checked" (D32), and its numbers are not checked either. Any problem gets **one** repair request that quotes the answer and lists the problems. What still fails is saved and flagged: the ref is `checked: "not-found"` and the value gets a [CHECK] saying the quote was not found. Nothing is dropped, and the problems are kept in the request's record.

**Saving (D1, D2, D5).** Each request's parts are saved as soon as they pass, as new versions: `"ai"` for a part that had none before the run, `"update"` otherwise.
- Ids are made by code. An item whose key is an id the part has had keeps it; any other key gets a new id, never one used before. Groups and risks get their behaviors' ids.
- An item she changed by hand is kept as hers in place of the AI's, and kept when the AI leaves it out.
- A part whose version shown she approved is never changed.
- Intensity is never filled (D19). Barrier tags come in as proposals (D18). Functions and groups are hypotheses.
- Each request is recorded in `caseMap.extractions`: run, provider, models, rules versions, sources and sections used, tokens, cost, format, whether it was repaired, and the problems left.

**Her thresholds (D16).** The rail offers the thresholds her assessments show (`src/shared/case-map-thresholds.ts`, in our words). She reviews, changes and confirms them once; from then on they are the map's standing instructions (`"case-map"` in `instructions.json`), sent with every behaviors request. Until then the rules have the AI write `[MISSING: your threshold for …]` in each definition.

**On screen.**
- The AI action sits in the header, kept in its own component (`src/renderer/src/case-map/MapDraft.tsx`) so it moves as it is into the "Con la IA" side of the two-ways bar when the UX redesign's UX-3 lands.
- An empty map shows the two ways side by side ("A mano" / "Con la IA").
- While the AI works, a panel shows the two steps, what is arriving, "It usually takes 2 to 6 minutes", and Stop. When a request's parts are saved, the screen shows them at once.
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
| `src/lib/case-map-extraction.ts` | The answer schemas, their Zod check and the code checks |
| `src/lib/rules.ts` (`buildCaseMapPrompt`), `src/main/outgoing.ts` (`prepareMapRequest`) | The map requests' prompt |
| `src/main/case-map-draft.ts` | The draft's two requests, the plain-JSON resend, the repair, and the answers in the map's shape |
| `src/renderer/src/case-map/draft.ts`, `MapDraft.tsx` | The draft's store, the AI action, its progress, the two ways and her thresholds |
| `tests/case-map.test.ts` | Migration round trip, unknown keys, history, status, provenance, groups, limits, the service and a kept edit |
| `tests/case-map-extraction.test.ts` | The draft with a fake provider: prompts, schema, checks, repair, plain JSON, an update, her thresholds |
| `e2e/case-map.e2e.ts` | The step in the app window (run by CI) |
