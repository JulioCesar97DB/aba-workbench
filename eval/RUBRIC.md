---
id: rubric
version: 3
updated: 2026-11-27
---

# The evaluation rubric

Every rules change passes the evaluation set before it reaches the BCBA (owner's decision, 2026-11-23). This rubric is how the set is scored. `eval/rubric.ts` holds the same rubric as data; `tests/eval-rubric.test.ts` keeps the two in step. A change to an item's meaning, its anchors, or how it is scored raises the version. Two runs are compared only when they use the same version.

**Version 3** (the BCBA's questionnaire answers of 2026-11-27) changes:

- Three new code items: her wording (long dashes; utilize, facilitate, leverage; "the BCBA observed" or "saw"; "hypothesized"; a severity level in any section, markers included), quoted speech, and dates and names in narrative.
- A caregiver called by a name is scored now that she has answered (no longer provisional).
- The judge's attribution and style anchors, her structure for each section and her habits follow her answers.
- The case keys follow her answers too: no severity level to mark, no dates or names in the facts, the family's crisis responses in Risk Assessment, no BASC-3 PRQ scores in Medical Necessity, early signs only as the caregivers report them.
- Payer readiness in the Crisis Plan checks the dangerous behaviors instead of early signs.
- A baseline accepted under another rubric version is compared when this run checked and judged every one of its stored drafts again (see "The verdict").

**Version 2** (review round 1) changes:

- Medical Necessity's "ABA will…" names what the child needs to learn, never a procedure before her plan is approved.
- Her standard practice counts only when her standing instructions give it.
- The caregiver given-name rule is not scored until she answers.
- Payer readiness is scored as its anchor says.
- The judge reads the session notes, her standing instructions and the payer facts of each section.

## How it is scored

- Each item is scored **0, 1 or 2 for each section**.
- **Code** scores some items from the automatic checks (`eval/checks/checks.ts`, checks version 3). These run on every saved version, cost nothing and give the same answer every time.
- **The judge** scores the rest: ChatGPT on the owner's plan, one request per section, sent through the app (`src/lib/judge.ts`, prompt version 2). It gets:
  - the case's sources, her session notes and her standing instructions for the section;
  - the section under review and the other eight drafts;
  - this rubric, her structure for the section, her habits, the payer facts of the section, and the case key's facts for the section.

  With `--judge-samples n` each section is judged n times in each run and the median is scored (default 1: the runs are the judge's samples).
- **Runs:** each case is run 3 times by default (owner's decision, 2026-11-23), each run drafted and judged on its own. An item's score for a section is the **median of its runs**, and the spread of the runs is shown next to it.
- **Her own bar, fixed in the rubric:** her expectations and the payer facts live here, not in `rules/`, so a rules change cannot move the bar it is measured against. The structure, the shapes and the habits come from her decisions and from the patterns of her own recent assessments, written in our words; nothing of hers is copied.
- **Rules pending her answer are never counted.** A finding under such a rule is listed as provisional and not scored (since version 3 no check has one: she answered how caregivers are named). A key fact that rests on her unconfirmed standard practice is left out of the judge's list. Neither is part of the verdict.

### Code scores

- **Markers, shape, examples:**
  - no finding: 2;
  - only minor findings: 1 (a malformed marker, a shape slightly off);
  - any major finding: 0.
- **Payer readiness:** every item there 2; one missing 1; two or more missing 0.
- **The counted checks** (number provenance, names, repetition, data density, banned patterns, her wording, quoted speech, dates and names):
  - no finding: 2;
  - one or two: 1;
  - three or more: 0.
- **Key facts** (from the judge's answers): each fact present (1), partial (½) or absent (0).
  - at least 90%: 2;
  - at least 70%: 1;
  - otherwise: 0.

## The verdict

`pnpm eval` compares the medians of a run with those of the last accepted run (`eval/baselines/`):

- **Medians:** each item's score is the median of the runs (with 3 runs, the middle one). An item that any run could not score (a failed draft, or no valid judge answer) is **unscored**. A missing judge answer is filled with `--from-run`; a failed draft needs a new run.
- **Checks:** a check passes when it finds nothing in most runs (at least 2 of 3) and fails when it finds something in most runs.
- **Rescoring:** every stored run of the baseline is checked again with the current checks before the comparison, so a change to the checks never reads as a change of the rules.
- **Same judge:** where the baseline was judged by another judge (another prompt, inputs, model or number of samples per run: its fingerprint), its drafts are judged again in the same run by this judge, run by run.
- **Another rubric version:** a baseline accepted under another rubric version is compared only when every stored draft of every case compared was checked again and judged again in this run, with a valid answer for each. It is then scored by this version, and the summary's notes say that the baseline arm is its stored drafts, re-judged. A baseline judged only in part is not compared.

The verdict is one of:

- **REGRESSION** (hard; exit code 2): a code item's median went down, a check that passed in the baseline fails in most runs now, or an item scored in the baseline is unscored now. A change with a hard regression does not go to her. A drop in one run of three moves neither the median nor the majority, so it is noise, shown in the spread, not a regression.
- **Judge item medians are reported apart from the verdict:** up and down, for the sections both runs had the same judge in every run.
- **Not compared, and said so:** an item the baseline could not score, and the checks of a section that a baseline run has no draft of, are listed apart in the summary instead of being skipped. A run with a failed draft, a judge error or an unscored item is never accepted as a baseline, so this only happens when a judge request for the baseline fails during the comparison.
- **NOT COMPARED** (exit code 3): the runs used another rubric version (unless the baseline was fully checked and judged again in this run), another provider or another drafting mode.
- **INVALID** (exit code 1): a window, the Dock icon or the focus showed during the run, or the app asked for a dialog. Such a run is never compared or accepted.

## Items scored today (stage: report body, the nine narrative sections)

| Item | Scored by | 2 | 1 | 0 |
| --- | --- | --- | --- | --- |
| `markers` Markers correct | code | Every planted gap the section must mark is marked; no section fills a planted gap; every marker well formed | Only malformed markers | A planted gap unmarked where it must be, or filled with something the sources do not say |
| `shape` Shape | code | Paragraphs and words within her range for the section (table below); plain paragraphs only (a numbered protocol is allowed in the Crisis Plan) | One paragraph off, or within 15% of the word range | Further off, or headings, bullets, bold or tables |
| `numbers-sourced` Every number exists in a source | code | None unsourced; a duration, interval or percentage needs its unit too ("3 minutes", "6 months") | One or two | Three or more |
| `names` Names match the case key | code | No behavior, person or procedure name drifts from the key, and no caregiver is called by a given name | One or two | Three or more |
| `repetition` No repetition beyond a reference | code | No 12-word run shared with another section; no incident told, by its own details, outside its home and the sections whose facts require it in more sections than allowed | One or two | Three or more |
| `data-density` No list of numbers | code | No sentence with 3 or more values (not dates or times) and no clause saying what they mean, in it or in the next sentence | One or two | Three or more |
| `banned-patterns` No banned patterns | code | None of: meta sentences, filler, sentences about the text, first person, addressing the reader, promised outcomes, hours of service (unless the CDE's or the IEP's recommendation), scores in Background Information, restraint or seclusion | One or two | Three or more |
| `her-wording` Her wording | code | None of: a long dash (— or a spaced –), utilize, facilitate or leverage, "the BCBA observed" or "saw" (or "observed by the BCBA"), "hypothesized" or "hypothesis", a severity level or a mention of one in any section (markers included) | One or two | Three or more |
| `no-quoted-speech` No quoted speech | code | No quoted span outside a marker, straight or curly quotes | One or two | Three or more |
| `no-dates-or-names` No dates or names in narrative | code | No numeric date; no "Month D" date except in a sentence about a coming change; no person named with "Dr.", credentials, or Mr., Mrs. or Ms. and a surname | One or two | Three or more |
| `examples-not-copied` No example copied | code | No 10-word run of an invented example from the rules | – | Any |
| `payer-readiness` Payer items present | code | Every payer item that applies to the section (list below), in the prose | One missing | Two or more |
| `data-explained` Data explained, not listed | judge | Every score, count or duration says what it means for this child; the most impairing data are argued with incidents | Mostly, with a run that reads as a list | Mostly listed |
| `thread` Thread with the assessment | judge | Same behaviors, deficits, people and numbers as the other sections, by the same names; connects to what they define, measure or treat; no contradiction | One loose end | Reads on its own, or contradicts |
| `ownership` Stays in its own lane | judge | Says in full only what it owns; refers to the rest in a clause (her deliberate repeats, the family's priorities and the safety response, are fine) | One passage retells another section | Large parts do |
| `attribution` Every fact attributed | judge | Every fact names its source in the sentence; the kind of evidence is clear | A few unattributed, or second-hand written as observed | Mostly missing, or a report presented as observation |
| `structure` Her structure | judge | Follows her structure for the section (below), in order | A part missing or out of order | Does not follow it |
| `style` Her habits | judge | Her habits (below); how caregivers are named is not scored | One lapse | Several |
| `nothing-invented` Nothing invented | judge | Every clinical fact is in the sources, the session notes or her standing instructions; text the payer requires of the section is not invented; no clinical proposal (a named procedure, parameter, program title, support or criterion) that none of them gives, unless marked | One small step beyond them | An invented fact, or several unmarked proposals |
| `key-facts` The section's facts | judge (per fact), then code | At least 90% of the key's facts for the section (provisional facts left out) | At least 70% | Less |

## Items for later stages (defined, not scored yet)

These are scored once the pipeline reaches the case formulation and the plan (owner's decision, 2026-11-23).

| Item | Stage | 2 |
| --- | --- | --- |
| `definition-topography` | formulation (sections 8, 10) | Topography, onset and offset, examples and non-examples, all from this child's incidents |
| `strategies-traced` | plan (14) | Every preventive strategy traces to a recorded antecedent of a behavior with that function |
| `one-consequence-per-group` | plan (14) | Exactly one consequence entry per behavior or per group (same nature, same function) |
| `definition-then-implementation` | plan (15) | One definition sentence, then this child's implementation with concrete parameters |

## Her shape for each section

These are the ranges her recent assessments keep. Where her length varies, no limit is set.

| Section | Paragraphs | Words |
| --- | --- | --- |
| Background Information | 5–7 | 600–850 |
| Medical Necessity Criteria | 8–9 | 950–1150 |
| Strengths and Weaknesses | 2–3 | 300–450 |
| Environmental Changes | 2–3 | 300–450 |
| Family/Caregiver Involvement (narrative) | 1–4 | 200–400 |
| Generalization and Maintenance | 2 | 200–280 |
| Discharge and Service Fading Plan | 2–3 | – |
| Risk Assessment | 3–4 | 300–400 |
| Crisis Plan | – (scales with the risk) | – |

## Her structure for each section (for the judge)

`SECTION_EXPECTATIONS` in `eval/rubric.ts` gives this in full. In short:

- **Background Information:** household (who lives there, who cares for the child, who works and supports it, culture), languages and priorities, and a request for therapy in another language first; diagnosis (without its severity level or the CDE's tests), medication, birth and medical history; milestones and communication; school, past therapies and prior ABA; concerns by source; social life, play, sensory needs and transitions. Disagreements between sources side by side (only here). No scores, no reason for referral.
- **Medical Necessity:**
  - an opening that names the supporting sources and the affected areas;
  - the Vineland-3 in prose (domains, subdomain v-scales, levels, Maladaptive Behavior Index, critical items, a plain explanation), tied to what the caregiver describes;
  - one paragraph per functional area: the deficit, one concrete example, its impact, and what ABA will do, said as **what the child needs to learn** (the reverse of the documented deficit) and the general approach;
  - a paragraph on what the direct observations showed;
  - a closing on why individualized ABA is necessary, where and how, caregiver training, how it always complements the other services, and how effectiveness is measured.

  No FAST or MAS results, no BASC-3 PRQ scores (only what it shows, in words), one example per area; with no school data, home and community as the settings; the Florida definition never cited.

  Before her plan is approved, a named procedure, parameter, program title or support (DRA, FCT, DRO, Premack, high-p, NCR, BST, a warning, a visual schedule) is a proposal: it belongs here only where her sections, standing instructions, notes or a source give it. The diagnosis never carries a severity level, and no marker asks for one. Never hours.
- **Strengths and Weaknesses:** no scores; strengths first (emerging and preferred skills, reinforcers, a good BASC-3 PRQ result in words, the family's involvement), each tied to how it helps treatment; then the needs, sourced, preferably with other examples than Medical Necessity's; a closing on how ABA addresses them.
- **Environmental Changes:** how the child reacts to change, with examples; then the changes (school or grade, caregiver, a new sibling, medication, RBT or BCBA) and their supports, written even when no change is coming, as her plan, instructions, notes or a source give them. Her standard supports count as her structure only when her standing instructions give them; otherwise an unnamed support is marked missing. (Her standard supports are pending her confirmation.)
- **Family/Caregiver Involvement:** "the caregiver" or the relation, never a name; involvement and priorities, who takes part and when, Behavioral Skills Training in person (never by telehealth) in the home language, what it covers and why, current responses described without blame, training that increases as fading nears.
- **Generalization and Maintenance:** two paragraphs, as she described them.
- **Discharge:** the payer's discharge grounds, then criteria tied to this child with their numbers (zero only for dangerous behaviors), how services step down, caregiver training that increases, the transition, community resources only when there are some; the phases only in her table. Her standard criteria and thresholds count only when her standing instructions give them; otherwise a number none of the inputs gives is marked missing. (Pending her confirmation.)
- **Risk Assessment:** risks to carrying out the plan first; then behavior risks from most to least dangerous, and the non-behavioral risks the sources report; then the family's current crisis responses in ABA terms, least-restrictive procedures and a pointer to the Crisis Plan; then training and fidelity. No rating.
- **Crisis Plan:** always the dangerous behaviors, the antecedent strategies staff always follow, an adult always present and the designated caregivers, 911 when the situation gets out of control, incidents reported as soon as possible; a protocol for mouthing, physical aggression, property destruction, self-injury or elopement even with no past crisis; early signs only as the caregivers report them. Always the monitoring. Never restraint.

## Her habits (for the judge)

- The child's first name; caregivers by relation or "the caregiver", professionals by role, never by name; "the BCBA", never as the one who observed.
- Written for a technical reviewer: no term explained; short sentences, nothing generic, sales-like or translated-sounding; no long dashes or utilize, facilitate, leverage; data in digits.
- No dates in narrative and no quotes; functions as "is maintained by"; no severity level anywhere; abbreviations spelled out the first time in each section except BCBA, FAST, MAS, STO, LTO, BASC-3, ABLLS-R.
- Outside Background Information, conflicting sources become a [CHECK] question, not two versions side by side.
- Third person, active voice. Present tense for current functioning, past for history and observations, "will" for the plan.
- Programs and strategies by the same names everywhere.
- Deliberate repeats only: the family's priorities and the safety response.
- No bullets in the narrative, no blame of the family, no promised outcomes. Harmless movement is never a target; speech and eye contact are never required.
- Missing or conflicting information is stated, never guessed.

## Payer facts the judge reads, and payer readiness items code checks

`SECTION_PAYER_FACTS` in `eval/rubric.ts` gives the judge, per section, what Florida Medicaid policy 4.2.1 and 6.2.2 and the Molina guide (sections 2 to 5 and 8) require. Examples: the AHCA discharge grounds, and caregiver training that increases as the transition nears. Text the payer requires is not invented.

Code checks these items (`PAYER_ITEMS`), in the prose; a marker counts only where a marker is the right answer:

- **Background Information:** the diagnosis as the CDE states it; every other service; prior ABA, or that there was none.
- **Medical Necessity:**
  - the diagnosis;
  - impairment in two or more settings;
  - the behaviors' functions;
  - ABA complements, and does not duplicate, other services;
  - caregiver training;
  - how progress is measured.
- **Strengths and Weaknesses:** strengths documented.
- **Environmental Changes:** supports for the changes, or a marker.
- **Family/Caregiver Involvement:** each caregiver by role; their availability; the language of training; what training covers.
- **Generalization and Maintenance:** generalization across settings and people; maintenance probes; reinforcement thinned.
- **Discharge:**
  - objective criteria, or markers;
  - caregiver criteria, or a marker for their number;
  - how services step down;
  - the transition.
- **Risk Assessment:** every target behavior; injuries and near misses.
- **Crisis Plan:** when emergency services are called, or a marker; the behaviors that can be dangerous.

## The case keys

Each invented case has a `key.json` next to its `case.json` (`eval/key.ts` gives the schema; key version 2). It holds:

- how each source is loaded;
- the expected behaviors, with their names, accepted variants, drifting names and functions;
- the people;
- the planted gaps: where each must be marked, with the marker it needs, and what would fill one wrongly;
- the incidents and notes:
  - each told only by its own details;
  - with its home section by step 0's section map (`rules/guide.md`);
  - the sections whose facts require it;
  - how many other sections may refer to it;
  - and whether the home is provisional (shown in the summary);
- phrases allowed to repeat;
- the payer parameters;
- the facts each section must contain, placed in their home by the same map. A fact marked provisional (her standard practice) is not counted.

The harness takes every case folder that has a key.
