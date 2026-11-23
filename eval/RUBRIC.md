---
id: rubric
version: 1
updated: 2026-11-23
---

# The evaluation rubric

Every rules change passes the evaluation set before it reaches the BCBA (owner's decision, 2026-11-23). This rubric is how the set is scored. `eval/rubric.ts` holds the same rubric as data; `tests/eval-rubric.test.ts` keeps the two in step. A change to an item's meaning, its anchors, or how it is scored raises the version. Two runs are compared item by item only when they use the same version.

## How it is scored

- Each item is scored **0, 1 or 2 for each section**.
- **Code** scores some items from the automatic checks (`eval/checks/checks.ts`). These checks run on every saved version, cost nothing and give the same answer every time.
- **The judge** scores the rest: ChatGPT on the owner's plan, one request per section, sent through the app (`src/lib/judge.ts`). It gets the case's sources, the section under review, the other eight drafts, this rubric, her structure for the section, her habits, and the case key's facts for the section.
- The judge's instructions and her expectations live in the rubric, not in `rules/`. A rules change therefore cannot move the bar it is measured against.
- The bar is her own practice. The structure, the shapes and the habits come from her decisions (the decisions file) and from the patterns of her own recent assessments, written here in our words. Nothing of hers is copied.

### Code scores

- **Markers, shape, examples:**
  - no finding: 2;
  - only minor findings: 1 (a malformed marker, or a shape slightly off);
  - any major finding: 0.
- **The counted checks** (number provenance, names, repetition, data density, banned patterns, payer readiness):
  - no finding: 2;
  - one or two: 1;
  - three or more: 0.
- **Key facts** (scored from the judge's answers): the judge marks each fact present (1), partial (½) or absent (0).
  - at least 90%: 2;
  - at least 70%: 1;
  - otherwise: 0.

## The gate

`pnpm eval` compares a run with the last accepted run. It says plainly whether a rules change fails the gate. It fails when:

- a rubric item went down in any section of any case;
- a check that found nothing in the baseline finds something now;
- an item scored in the baseline could not be scored this time (a failed draft, or no valid judge answer).

A change that fails the gate does not go to her.

## Items scored today (stage: report body, the nine narrative sections)

| Item | Scored by | 2 | 1 | 0 |
| --- | --- | --- | --- | --- |
| `markers` Markers correct | code | Every planted gap the section must mark is marked; no section fills a planted gap; every marker well formed | Only malformed markers | A planted gap unmarked where it must be, or filled with something the sources do not say |
| `shape` Shape | code | Paragraphs and words within her range for the section (table below); plain paragraphs only (a numbered protocol is allowed in the Crisis Plan) | One paragraph off, or within 15% of the word range | Further off, or headings, bullets, bold or tables |
| `numbers-sourced` Every number exists in a source | code | None unsourced | One or two | Three or more |
| `names` Names match the case key | code | No behavior, person or procedure name drifts from the key, and no caregiver is called by a given name | One or two | Three or more |
| `repetition` No repetition beyond a reference | code | No 12-word run shared with another section; no incident told outside its home in more sections than allowed | One or two | Three or more |
| `data-density` No list of numbers | code | No sentence with 3 or more values (not dates or times) and no clause of meaning | One or two | Three or more |
| `banned-patterns` No banned patterns | code | None of: meta sentences, filler, sentences about the text, first person, addressing the reader, promised outcomes, hours of service, scores or a severity level in Background Information, restraint or seclusion | One or two | Three or more |
| `examples-not-copied` No example copied | code | No 10-word run of an invented example from the rules | – | Any |
| `payer-readiness` Payer items present | code | Every payer item that applies to the section (list below) | One missing | Two or more |
| `data-explained` Data explained, not listed | judge | Every score, count or duration says what it means for this child; the most impairing data are argued with incidents | Mostly, with a run that reads as a list | Mostly listed |
| `thread` Thread with the assessment | judge | Same behaviors, deficits, people and numbers as the other sections, by the same names; connects to what they define, measure or treat; no contradiction | One loose end | Reads on its own, or contradicts |
| `ownership` Stays in its own lane | judge | Says in full only what it owns; refers to the rest in a clause (her deliberate repeats, the family's priorities and the safety response, are fine) | One passage retells another section | Large parts do |
| `attribution` Every fact attributed | judge | Every fact names its source in the sentence; the kind of evidence is clear | A few unattributed, or second-hand written as observed | Mostly missing, or a report presented as observation |
| `structure` Her structure | judge | Follows her structure for the section (below), in order | A part missing or out of order | Does not follow it |
| `style` Her habits | judge | Her habits (below) | One lapse | Several |
| `nothing-invented` Nothing invented | judge | Every clinical fact is in the sources or her inputs; no unmarked clinical proposal (her standard supports and discharge criteria are hers, not proposals) | One small step beyond the sources | An invented fact, or several unmarked proposals |
| `key-facts` The section's facts | judge (per fact), then code | At least 90% of the key's facts for the section | At least 70% | Less |

## Items for later stages (defined, not scored yet)

These items wait for the sections the AI does not write yet. They are scored once the pipeline reaches those sections (the case formulation and the plan; owner's decision, 2026-11-23).

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

- **Background Information:** household, languages and priorities; diagnosis, medication, birth and medical history; milestones and communication; school, past therapies and prior ABA; concerns by source; social life, play, sensory needs and transitions. Disagreements between sources are shown side by side. No scores and no severity level.
- **Medical Necessity:** an opening that names the supporting sources and the affected areas; the Vineland-3 in prose, tied to what the caregiver describes; one paragraph per functional area (deficit, one concrete example, impact, what ABA will teach by name); a direct-observation paragraph; a closing on why individualized ABA is necessary, where, how, caregiver training, school coordination and how effectiveness is measured. Never hours.
- **Strengths and Weaknesses:** strengths first, each tied to how it helps treatment; then the weaknesses, sourced; a closing on how ABA addresses them.
- **Environmental Changes:** how the child reacts to change, with examples; then the changes and concrete supports. Her standard supports count as her structure.
- **Family/Caregiver Involvement:** involvement and priorities, who takes part and when, Behavioral Skills Training in the home language, current responses described without blame.
- **Generalization and Maintenance:** two paragraphs, as she described them.
- **Discharge:** her standard criteria tied to this child (goals substantially met; fading after the reduction goals hold three consecutive months with the caregivers independent; services end after six consecutive months without clinically significant behavior; fading pauses if skills slip).
- **Risk Assessment:** risks to carrying out the plan first; then behavior risks from most to least dangerous; then least-restrictive procedures and a pointer to the Crisis Plan; then training and fidelity. No rating.
- **Crisis Plan:** scaled to the risk: a numbered protocol for the highest-risk behavior, or a plain statement that none is needed with one safety scenario. Always the monitoring. Never restraint.

## Her habits (for the judge)

- The child's first name. Caregivers by relation, rarely by their own names. "The BCBA".
- Third person, active voice. Present tense for current functioning, past for history and observations, "will" for the plan.
- Programs and strategies by the same names everywhere.
- Deliberate repeats only: the family's priorities and the safety response.
- No bullets in the narrative, no blame of the family, no promised outcomes. Harmless movement is never a target; speech and eye contact are never required.
- Missing or conflicting information is stated, never guessed.

## Payer readiness items (narrative sections)

These come from Florida Medicaid policy 4.2.1 and 6.2.2 and the Molina guide (sections 2 to 5 and 8), and apply to the narrative sections. Each is a pattern check in `PAYER_ITEMS`.

- **Background Information:**
  - the diagnosis as the CDE states it;
  - every other service;
  - prior ABA, or that there was none.
- **Medical Necessity:**
  - the diagnosis;
  - impairment in two or more settings;
  - the behaviors' functions;
  - ABA complements, and does not duplicate, other services;
  - caregiver training;
  - how progress is measured.
- **Strengths and Weaknesses:** strengths documented.
- **Environmental Changes:** supports for the changes, or a marker.
- **Family/Caregiver Involvement:**
  - each caregiver by role;
  - their availability;
  - the language of training;
  - what training covers.
- **Generalization and Maintenance:**
  - generalization across settings and people;
  - maintenance probes;
  - reinforcement thinned.
- **Discharge:**
  - objective criteria, or markers;
  - caregiver criteria;
  - how services step down;
  - the transition.
- **Risk Assessment:**
  - every target behavior;
  - injuries and near misses.
- **Crisis Plan:**
  - when emergency services are called, or a marker;
  - early signs.

## The case keys

Each invented case has a `key.json` next to its `case.json` (`eval/key.ts` gives the schema). It holds:

- how each source is loaded;
- the expected behaviors, with their names, accepted variants, drifting names and functions;
- the people;
- the planted gaps (where each must be marked, and what would fill one wrongly);
- incidents and notes with their home section and how many other sections may refer to them (provisional where her section map is not settled);
- phrases allowed to repeat;
- the payer parameters;
- the facts each section must contain.

The harness takes every case folder that has a key.
