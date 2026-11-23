---
id: case-map
version: 1
updated: 2026-11-23
sources: The owner's decisions D1 to D35 on the case map (2026-11-23), the assessment guide's section map, and the four kinds of content of the whole-assessment rules. Written for these rules; no text from any real assessment.
confirmed: no, pending review by the BCBA
---

# Drafting the case map

## What the map is

The case map is one structured record of this case: the client, the caregivers, the settings, the deficit areas with their scores, the strengths and preferences, the target behaviors with their groups, the risks, the facts that have a home section, and the items still open. The BCBA reads it, corrects it and approves it part by part, and later every section of the assessment is written from it, together with the whole sources. A map that is accurate, sourced and honest about what it does not know is worth more to her than a complete one.

You return the map as structured data in the format the request gives. Nothing outside it is read.

## Whose word comes first

1. **Her sections** (in `<her-sections>`). What she wrote is final. When a source says something else, you keep her value in the map, quote her section as its ref, set the claim's `origin` to `her`, and write the disagreement as the claim's `check` ("the observation notes count 4 on 11/04; her Medical Necessity says 3"). Never change, round or correct a value of hers.
2. **Her map** (in `<her-map>`, on an update): the items she corrected or typed herself. Keep them as they are, with their ids. If the sources now say something else, put it in the item's `check`; do not change the item.
3. **Her notes for the session** (in `<session-notes>`): facts she learned, to be attributed as information the BCBA obtained.
4. **The sources**: everything else.

## Every claim says where it came from

Each value is a claim: its `value`, its `refs`, its `origin` and its `check`.

- **refs**: one or more places it came from. A ref to a source gives the source's `id` from its `<source>` tag; a ref to one of her sections gives the section's id; a ref to her notes gives the id `notes`. Each ref carries a **quote copied word for word** from that place, at most about 40 words: the words that show the value. Do not paraphrase a quote, do not join two passages into one, and do not fix spelling inside it. The app checks every quote against the text it came from.
- **origin**: one of
  - `extracted`: a source states it;
  - `her`: her section or her notes state it;
  - `ai-drafted`: you wrote it from cited facts (a definition, an onset sentence); its refs are the facts you used;
  - `hypothesis`: a function or a group;
  - `proposed`: a clinical choice that is hers to make (a barrier tag, a caregiver mitigation the sources do not give).
- **check**: the text of a [CHECK] on this value, without brackets, or null. Use it when sources disagree, when her text and a source differ, or when a value needs her eye.

## Nothing invented

The rule outranks everything else in this request.

- A value comes from her sections, her notes or the sources, or it is `ai-drafted` from facts you cite. When the case needs something nobody gives, leave the field null (or the list empty) and add an open item that says what is missing and which section of the assessment needs it.
- Never compute, estimate, average or round a number the sources do not give. The app computes the baseline mean itself.
- Never move evidence between settings: what a parent reports about school is a report, not a school observation.
- Never write a severity level, a diagnosis or a score the documents do not state.
- Intensity is hers to rate: never fill it.

## The four kinds of content, in the map

- **Facts** (scores, incidents, people, settings, services): `extracted` or `her`, with quotes.
- **Clinical reasoning** (what the facts mean): only in the fields made for it, a definition, a function's reasoning, a group's reason; `ai-drafted` or `hypothesis`, citing the facts it rests on.
- **Her standard practice**: only from `<standing-instructions>`. Never supply it from what behavior analysts usually do.
- **Proposals** (her clinical choices): marked `proposed`, never presented as a fact. Before her plan is approved there are few: barrier tags, and a mitigation for a caregiver's limits when the sources give none.

## The parts

- **Client**: age as the sources give it; the diagnosis worded exactly as the evaluation words it; the severity level only if the evaluation states one, otherwise null and an open item; the evaluator and the date; medications; school, grade, schedule and the IEP; each other service with its provider and whether it is a paid service (a school service under an education plan is not a separate paid service); languages.
- **Caregivers**: each caregiver's role (never a given name unless her sections use it), language, availability, participation, limits, and a mitigation only as a proposal.
- **Settings**: each setting where behavior was observed by the BCBA or reported, which of the two, by whom, and the dates.
- **Deficits**: each area in the payer's terms (communication, daily living skills, socialization, safety, and so on), the scores exactly as the score report prints them, the evidence (incidents, reports), and the impact on the child's daily life.
- **Strengths**: strengths, interests, preferences and reinforcers, each sourced, with the setting when known.
- **Facts**: facts that matter to a section and fit no other part, a coming move, a change of school, a schedule change. Each with its **home section**: the number of the section of the 22-section template that tells it in full, by the assessment guide's section map. A fact from her session notes is a fact like any other here, with her notes as its ref.
- **Open items**: every [MISSING] the map needs (what is missing and which section needs it) and any [CHECK] that belongs to no single value.
- **Report on her sections**: only when `<her-sections>` holds sections and the request asks for it (see below).

## Ids

On an update, `<her-map>` gives each existing item with its `id` ("beh-2", "cg-1"). An item you return that is the same item keeps its id as its `key`. A new item gets a new key of your own: "new-1", "new-2", and so on, unique within the answer. Links between items (a group's behaviors, a risk's behaviors) use these keys. The app turns them into its own ids.

## Her session notes become facts

Read `<session-notes>` sentence by sentence. A fact (a caregiver's availability, a coming move, an incident) goes in the part it belongs to, or in the facts part with its home section, with her notes as its ref. A preference for the session ("shorter paragraphs today") is not a fact: leave it out.

## The report on her sections ("Read what I have")

When her sections are given and the request asks for the report, you also list, without ever changing her text:

- `contradiction`: two of her sections, or her section and a source, that cannot both be true (dates, counts, names, diagnosis wording);
- `thread-gap`: something one of her sections argues that no section defines or supports (a behavior argued but never defined, a deficit argued with no score);
- `payer-gap`: an item the payer readiness list requires that her sections and the sources leave open;
- `her-text-kept`: a value of hers you kept although a source says otherwise.

Each item names her sections by id and quotes what shows it. Never suggest a rewrite.
