# Evaluation run: 2026-11-28T00-58-19-t1-accept

> **Risk Assessment: drafted with v5, judged under v6's expectations.**
> - This baseline is the drafts of fix round 1 of T1 (`eval-results/2026-11-28T00-20-22-t1-fix1`, drafted at cc1864d), not drafted again. Its Risk Assessment re-judge (`2026-11-28T00-53-24-t1-fix2-rejudge`, at 7da80cb) was accepted here with 0 new requests.
> - Its Risk Assessment drafts were written with Risk Assessment rule v5 (`drafting.rulesVersions` says `"section-risk-assessment": "5"`) and judged under the expectations that came with v6.
> - v6 (7da80cb) only stops that section restating the caregiver training method and naming a procedure. Run 2's draft still names one ("reinforcement for requesting help or a break during demands"), which is why its nothing-invented score is 1.
> - Every other section was drafted with the rules as they are at 7da80cb.
> - **Re-scored offline with checks v5** (review round 1 of T1, findings 6 to 9 and 13, no request): the code items of both arms were checked again. The her-wording false positives ("support facilitation", the payer's "frequency and severity") are gone, which moves code from 205 to 207 of 216 (dev from 171 to 173), and nothing else changed. The judge answers are the stored ones. The baseline arm's name is written once ("dev-step0-2026-11-23 re-judged"), and its note says where its drafts were all judged again.

**No hard regression: no code item's median went down, no check that passed in the baseline fails in most runs now, and nothing went unscored. Judge item medians, apart from the verdict: 0 down, 22 up.** (baseline: dev-step0-2026-11-23 re-judged)

- Drafted by this checkout (JulioCesar97DB/rules-her-answers at cc1864d); judged by this checkout at 6b62b5d.
- 3 runs per case, each drafted and judged on its own. Every score below is the median of the runs; an item is unscored when any run could not score it, and a check fails when it fails in most runs.
- Rubric v3, judge prompt v2, checks v5, 1 judge sample per section in each run (median when more than one); judge format json-schema; openai (ChatGPT sign-in), gpt-6.2-astra; chained drafting.
- Judged again only where a run had no answer from run 2026-11-28T00-53-24-t1-fix2-rejudge's drafts, checked again with the current checks. The request counts below are both runs together.
- Requests: 90 (27 drafts, 24 consistency checks, 30 judge, 0 repairs, 9 judging the baseline's drafts again). 2026-11-28T00:58:19.843Z to 2026-11-28T00:58:23.104Z.
- Judge input: 543186 tokens, 0 read from the cache.
- Windows: draft launch: 0 visible, Dock hidden, 0 focused; draft end: 0 visible, Dock hidden, 0 focused; judge launch: 0 visible, Dock hidden, 0 focused; judge end: 0 visible, Dock hidden, 0 focused; judge launch: 0 visible, Dock hidden, 0 focused; judge end: 0 visible, Dock hidden, 0 focused; 0 checks during the run, all clear.
- Scores (medians): code items 207 of 216, judge items 100 of 144; the baseline as the current checks score it: code 173 of 216, judge 72 of 144 (3 runs).
- Noise: the runs disagree on 10 of 108 code item scores and 18 of 72 judge item scores (see each case's spread).

## case-b-sofia

Medians. Each cell: baseline → this run.

| Item | BI | MN | SW | EC | FCI | GM | DC | RA | CP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| markers (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| shape (code) | 2 → 2 | 1 → 1 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 1 → 2 | 2 → 2 |
| numbers-sourced (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| names (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| repetition (code) | 0 → 0 | 1 → 1 | 2 → 2 | 1 → 2 | 1 → 1 | 2 → 2 | 2 → 2 | 0 → 2 | 1 → 1 |
| data-density (code) | 1 → 2 | 0 → 0 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 1 → 2 | 1 → 1 | 2 → 2 |
| banned-patterns (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| her-wording (code) | 2 → 2 | 0 → 2 | 1 → 2 | 1 → 2 | 1 → 2 | 2 → 2 | 1 → 2 | 1 → 2 | 0 → 2 |
| no-quoted-speech (code) | 1 → 2 | 2 → 2 | 2 → 2 | 1 → 2 | 1 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 0 → 2 |
| no-dates-or-names (code) | 0 → 2 | 0 → 2 | 1 → 2 | 0 → 2 | 0 → 2 | 2 → 2 | 1 → 2 | 0 → 2 | 0 → 2 |
| examples-not-copied (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| payer-readiness (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| data-explained (judge) | 1 → 1 | 1 → 1 | 1 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 1 → 1 | 1 → 1 | 2 → 2 |
| thread (judge) | 2 → 2 | 1 → 1 | 1 → 2 | 2 → 2 | 2 → 2 | 1 → 1 | 2 → 2 | 1 → 2 | 2 → 2 |
| ownership (judge) | 1 → 1 | 1 → 1 | 2 → 2 | 1 → 2 | 0 → 2 | 2 → 2 | 1 → 1 | 1 → 1 | 0 → 0 |
| attribution (judge) | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 2 | 2 → 2 | 1 → 1 | 1 → 1 | 1 → 2 |
| structure (judge) | 1 → 1 | 1 → 1 | 1 → 1 | 2 → 2 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 0 → 1 |
| style (judge) | 0 → 1 | 0 → 1 | 0 → 1 | 0 → 0 | 0 → 2 | 0 → 2 | 0 → 1 | 0 → 2 | 0 → 1 |
| nothing-invented (judge) | 2 → 2 | 1 → 1 | 2 → 2 | 1 → 2 | 1 → 2 | 1 → 1 | 0 → 2 | 2 → 2 | 0 → 2 |
| key-facts (judge) | 1 → 1 | 1 → 1 | 0 → 0 | 2 → 2 | 2 → 2 | 0 → 0 | 0 → 1 | 0 → 1 | 1 → 1 |
| words | 775 | 1173 | 360 | 311 | 365 | 213 | 598 | 399 | 436 |
| markers | 0 | 0 | 0 | 1 | 2 | 0 | 16 | 1 | 6 |

Spread over the 3 runs: each cell is every run's score in order; **bold** where the runs disagree.

| Item | BI | MN | SW | EC | FCI | GM | DC | RA | CP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| markers (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| shape (code) | **2·1·2** | 1·1·1 | 2·2·2 | **1·2·2** | 2·2·2 | 2·2·2 | 2·2·2 | **1·2·2** | 2·2·2 |
| numbers-sourced (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| names (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| repetition (code) | **0·0·1** | **0·1·1** | **1·2·2** | 2·2·2 | **1·1·2** | 2·2·2 | 2·2·2 | **1·2·2** | **2·1·1** |
| data-density (code) | **1·2·2** | 0·0·0 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 1·1·1 | 2·2·2 |
| banned-patterns (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| her-wording (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| no-quoted-speech (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| no-dates-or-names (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| examples-not-copied (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| payer-readiness (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| data-explained (judge) | 1·1·1 | 1·1·1 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | **1·1·0** | 1·1·1 | 2·2·2 |
| thread (judge) | 2·2·2 | 1·1·1 | **1·2·2** | 2·2·2 | 2·2·2 | 1·1·1 | 2·2·2 | **1·2·2** | 2·2·2 |
| ownership (judge) | 1·1·1 | 1·1·1 | 2·2·2 | **2·2·1** | 2·2·2 | 2·2·2 | 1·1·1 | 1·1·1 | 0·0·0 |
| attribution (judge) | 1·1·1 | 1·1·1 | 1·1·1 | 1·1·1 | 2·2·2 | 2·2·2 | 1·1·1 | 1·1·1 | **2·2·1** |
| structure (judge) | 1·1·1 | 1·1·1 | 1·1·1 | 2·2·2 | 1·1·1 | 1·1·1 | **1·1·2** | 1·1·1 | 1·1·1 |
| style (judge) | 1·1·1 | **0·1·1** | **1·1·2** | 0·0·0 | **2·1·2** | 2·2·2 | **1·2·1** | 2·2·2 | **1·1·2** |
| nothing-invented (judge) | **2·1·2** | 1·1·1 | **1·2·2** | **1·2·2** | **2·2·1** | **1·1·2** | 2·2·2 | **2·1·2** | 2·2·2 |
| key-facts (judge) | 1·1·1 | 1·1·1 | 0·0·0 | 2·2·2 | 2·2·2 | 0·0·0 | **0·1·1** | 1·1·1 | 1·1·1 |
| words | 772·863·775 | 1212·1173·1163 | 373·348·360 | 286·311·321 | 365·377·357 | 214·211·213 | 598·597·604 | 409·397·399 | 435·436·458 |

- Her inputs: session notes given; no standing instructions (every section's cleared).
- Provisional in the key, for her to confirm:
  - "the 11/20 session note: the YMCA program accepted Sofía" belongs to environmental-changes (step 0's section map)
  - "the grandmother's trip to Colombia" belongs to environmental-changes (step 0's section map)
  - "the planned move and change of school" belongs to environmental-changes (step 0's section map)
  - "the September bus route change" belongs to environmental-changes (step 0's section map)
  - "running across the street on 10/10" belongs to risk-assessment (step 0's section map)
  - "the 09/14 head-banging episode and urgent care" belongs to risk-assessment (step 0's section map)
  - "the chair thrown at school on 03/12" belongs to risk-assessment (step 0's section map)
  - "the butter knife and the threat to Diego" belongs to risk-assessment (step 0's section map)
  - fact dc-thresholds (discharge-and-service-fading-plan) is not scored: it rests on her standard practice

## Notes

- The baseline was accepted under rubric version 2. Every one of its stored drafts was checked and judged again in run 2026-11-27T21-31-23-t1-rules, so it is compared under rubric version 3; in this run its drafts were checked again, and judged again only where the judge changed: the baseline arm is its stored drafts, re-judged, not drafted again.

## Code item medians that went up

- case-b-sofia BI data-density: 1 → 2 (runs 1·1·1 → 1·2·2)
- case-b-sofia BI no-quoted-speech: 1 → 2 (runs 1·1·0 → 2·2·2)
- case-b-sofia BI no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia MN her-wording: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia MN no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia SW her-wording: 1 → 2 (runs 1·0·1 → 2·2·2)
- case-b-sofia SW no-dates-or-names: 1 → 2 (runs 1·1·0 → 2·2·2)
- case-b-sofia EC repetition: 1 → 2 (runs 1·0·2 → 2·2·2)
- case-b-sofia EC her-wording: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia EC no-quoted-speech: 1 → 2 (runs 2·1·1 → 2·2·2)
- case-b-sofia EC no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia FCI her-wording: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia FCI no-quoted-speech: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia FCI no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia DC data-density: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia DC her-wording: 1 → 2 (runs 1·1·2 → 2·2·2)
- case-b-sofia DC no-dates-or-names: 1 → 2 (runs 1·0·1 → 2·2·2)
- case-b-sofia RA shape: 1 → 2 (runs 1·1·1 → 1·2·2)
- case-b-sofia RA repetition: 0 → 2 (runs 0·0·2 → 1·2·2)
- case-b-sofia RA her-wording: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia RA no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia CP her-wording: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia CP no-quoted-speech: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia CP no-dates-or-names: 0 → 2 (runs 0·0·0 → 2·2·2)

## Judge item medians that went up

- case-b-sofia BI style: 0 → 1 (runs 0·0·0 → 1·1·1)
- case-b-sofia MN style: 0 → 1 (runs 0·0·0 → 0·1·1)
- case-b-sofia SW data-explained: 1 → 2 (runs 1·1·2 → 2·2·2)
- case-b-sofia SW thread: 1 → 2 (runs 2·1·1 → 1·2·2)
- case-b-sofia SW style: 0 → 1 (runs 0·0·0 → 1·1·2)
- case-b-sofia EC ownership: 1 → 2 (runs 2·1·1 → 2·2·1)
- case-b-sofia EC nothing-invented: 1 → 2 (runs 2·1·1 → 1·2·2)
- case-b-sofia FCI ownership: 0 → 2 (runs 1·0·0 → 2·2·2)
- case-b-sofia FCI attribution: 1 → 2 (runs 1·1·1 → 2·2·2)
- case-b-sofia FCI style: 0 → 2 (runs 0·0·0 → 2·1·2)
- case-b-sofia FCI nothing-invented: 1 → 2 (runs 1·0·1 → 2·2·1)
- case-b-sofia GM style: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia DC style: 0 → 1 (runs 0·0·0 → 1·2·1)
- case-b-sofia DC nothing-invented: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia DC key-facts: 0 → 1 (runs 0·0·0 → 0·1·1)
- case-b-sofia RA thread: 1 → 2 (runs 1·1·1 → 1·2·2)
- case-b-sofia RA style: 0 → 2 (runs 0·0·0 → 2·2·2)
- case-b-sofia RA key-facts: 0 → 1 (runs 0·0·0 → 1·1·1)
- case-b-sofia CP attribution: 1 → 2 (runs 1·1·1 → 2·2·1)
- case-b-sofia CP structure: 0 → 1 (runs 1·0·0 → 1·1·1)
- case-b-sofia CP style: 0 → 1 (runs 0·0·0 → 1·1·2)
- case-b-sofia CP nothing-invented: 0 → 2 (runs 0·0·0 → 2·2·2)

Sections: BI Background Information; MN Medical Necessity Criteria; SW Strengths and Weaknesses; EC Environmental Changes; FCI Family/Caregiver Involvement; GM Generalization and Maintenance; DC Discharge and Service Fading Plan; RA Risk Assessment; CP Crisis Plan.
