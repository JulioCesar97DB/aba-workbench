# Evaluation run: 2026-11-23T13-28-26-dev-step0

**No hard regression: no code item's median went down, no check that passed in the baseline fails in most runs now, and nothing went unscored. Judge item medians, apart from the verdict: 5 down, 25 up.** (baseline: dev-2026-11-23)

- Drafted by dev-checkout (HEAD at 2e2ceec); judged by this checkout at 1cc1bd6.
- 3 runs per case, each drafted and judged on its own. Every score below is the median of the runs; an item is unscored when any run could not score it, and a check fails when it fails in most runs.
- Rubric v2, judge prompt v2, checks v2, 1 judge sample per section in each run (median when more than one); judge format json-schema; openai (ChatGPT sign-in), gpt-6.2-astra; chained drafting.
- Requests: 78 (27 drafts, 24 consistency checks, 27 judge, 0 repairs, 0 judging the baseline's drafts again). 2026-11-23T13:28:26.537Z to 2026-11-23T14:00:19.408Z.
- Judge input: 563868 tokens, 0 read from the cache.
- Windows: draft launch: 0 visible, Dock hidden, 0 focused; draft end: 0 visible, Dock hidden, 0 focused; judge launch: 0 visible, Dock hidden, 0 focused; judge end: 0 visible, Dock hidden, 0 focused; 381 checks during the run, all clear.
- Scores (medians): code items 147 of 162, judge items 106 of 144; the baseline as the current checks score it: code 126 of 162, judge 82 of 144 (1 run).
- Noise: the runs disagree on 12 of 81 code item scores and 18 of 72 judge item scores (see each case's spread).

## case-b-sofia

Medians. Each cell: baseline → this run.

| Item | BI | MN | SW | EC | FCI | GM | DC | RA | CP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| markers (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| shape (code) | 1 → 2 | 0 → 1 | 1 → 2 | 1 → 2 | 0 → 2 | 0 → 2 | 1 → 2 | 0 → 1 | 2 → 2 |
| numbers-sourced (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| names (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| repetition (code) | 0 → 0 | 0 → 1 | 0 → 2 | 0 → 1 | 0 → 1 | 1 → 2 | 0 → 2 | 0 → 0 | 0 → 1 |
| data-density (code) | 1 → 1 | 0 → 0 | 1 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 1 → 1 | 1 → 1 | 2 → 2 |
| banned-patterns (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| examples-not-copied (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| payer-readiness (code) | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 1 → 2 | 2 → 2 | 2 → 2 | 2 → 2 | 2 → 2 |
| data-explained (judge) | 1 → 1 | 1 → 1 | 1 → 2 | 2 → 2 | 1 → 2 | 2 → 2 | 1 → 1 | 1 → 1 | 2 → 2 |
| thread (judge) | 1 → 2 | 1 → 1 | 2 → 2 | 2 → 2 | 1 → 2 | 1 → 1 | 1 → 2 | 1 → 2 | 2 → 2 |
| ownership (judge) | 0 → 2 | 0 → 1 | 0 → 2 | 2 → 2 | 0 → 1 | 2 → 2 | 1 → 1 | 1 → 2 | 0 → 0 |
| attribution (judge) | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 1 → 1 | 2 → 2 | 2 → 1 | 1 → 1 | 1 → 1 |
| structure (judge) | 1 → 1 | 1 → 1 | 0 → 1 | 1 → 2 | 1 → 1 | 1 → 1 | 1 → 2 | 0 → 1 | 1 → 1 |
| style (judge) | 2 → 2 | 1 → 1 | 1 → 2 | 1 → 2 | 1 → 2 | 2 → 2 | 1 → 2 | 2 → 2 | 2 → 1 |
| nothing-invented (judge) | 2 → 2 | 1 → 1 | 2 → 2 | 1 → 2 | 0 → 1 | 1 → 1 | 0 → 2 | 2 → 2 | 0 → 2 |
| key-facts (judge) | 2 → 2 | 2 → 1 | 1 → 1 | 1 → 2 | 2 → 2 | 0 → 0 | 1 → 0 | 2 → 1 | 1 → 2 |
| words | 848 | 1158 | 388 | 349 | 385 | 209 | 643 | 402 | 844 |
| markers | 0 | 1 | 0 | 1 | 3 | 0 | 16 | 1 | 9 |

Spread over the 3 runs: each cell is every run's score in order; **bold** where the runs disagree.

| Item | BI | MN | SW | EC | FCI | GM | DC | RA | CP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| markers (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| shape (code) | **2·1·2** | **2·1·1** | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 1·1·1 | 2·2·2 |
| numbers-sourced (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| names (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| repetition (code) | **0·0·1** | **0·1·2** | **2·1·2** | **1·0·2** | 1·1·1 | 2·2·2 | **2·1·2** | **0·0·2** | **1·1·2** |
| data-density (code) | 1·1·1 | **1·0·0** | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 1·1·1 | 1·1·1 | 2·2·2 |
| banned-patterns (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| examples-not-copied (code) | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 |
| payer-readiness (code) | 2·2·2 | **1·2·2** | 2·2·2 | 2·2·2 | 2·2·2 | **2·2·1** | 2·2·2 | 2·2·2 | 2·2·2 |
| data-explained (judge) | 1·1·1 | 1·1·1 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | **2·1·1** | 1·1·1 | 2·2·2 |
| thread (judge) | 2·2·2 | 1·1·1 | 2·2·2 | 2·2·2 | **2·2·1** | 1·1·1 | **1·2·2** | **2·2·1** | 2·2·2 |
| ownership (judge) | **2·1·2** | 1·1·1 | **1·2·2** | 2·2·2 | 1·1·1 | 2·2·2 | 1·1·1 | **1·2·2** | 0·0·0 |
| attribution (judge) | 1·1·1 | 1·1·1 | 1·1·1 | 1·1·1 | **1·2·1** | 2·2·2 | 1·1·1 | **1·2·1** | 1·1·1 |
| structure (judge) | 1·1·1 | 1·1·1 | 1·1·1 | 2·2·2 | 1·1·1 | 1·1·1 | 2·2·2 | 1·1·1 | 1·1·1 |
| style (judge) | 2·2·2 | **1·2·1** | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | 2·2·2 | **2·1·2** | 1·1·1 |
| nothing-invented (judge) | 2·2·2 | 1·1·1 | **2·2·1** | 2·2·2 | **1·1·2** | **1·2·1** | **0·2·2** | 2·2·2 | **2·1·2** |
| key-facts (judge) | **2·2·1** | 1·1·1 | 1·1·1 | 2·2·2 | 2·2·2 | 0·0·0 | **1·0·0** | 1·1·1 | 2·2·2 |
| words | 848·873·840 | 1142·1158·1206 | 350·388·399 | 349·365·330 | 396·385·384 | 226·206·209 | 643·629·658 | 403·401·402 | 844·780·849 |

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

- Runs per case differ: 1 run in the baseline, 3 now; each side is compared on its own medians.

## Code item medians that went up

- case-b-sofia BI shape: 1 → 2 (runs 1 → 2·1·2)
- case-b-sofia MN shape: 0 → 1 (runs 0 → 2·1·1)
- case-b-sofia MN repetition: 0 → 1 (runs 0 → 0·1·2)
- case-b-sofia SW shape: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia SW repetition: 0 → 2 (runs 0 → 2·1·2)
- case-b-sofia SW data-density: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC shape: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC repetition: 0 → 1 (runs 0 → 1·0·2)
- case-b-sofia FCI shape: 0 → 2 (runs 0 → 2·2·2)
- case-b-sofia FCI repetition: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia FCI payer-readiness: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia GM shape: 0 → 2 (runs 0 → 2·2·2)
- case-b-sofia GM repetition: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia DC shape: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia DC repetition: 0 → 2 (runs 0 → 2·1·2)
- case-b-sofia RA shape: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia CP repetition: 0 → 1 (runs 0 → 1·1·2)

## Judge item medians that went down (apart from the verdict; 3 runs × 1 sample)

- case-b-sofia MN key-facts: 2 → 1 (runs 2 → 1·1·1)
- case-b-sofia DC attribution: 2 → 1 (runs 2 → 1·1·1)
- case-b-sofia DC key-facts: 1 → 0 (runs 1 → 1·0·0)
- case-b-sofia RA key-facts: 2 → 1 (runs 2 → 1·1·1)
- case-b-sofia CP style: 2 → 1 (runs 2 → 1·1·1)

## Judge item medians that went up

- case-b-sofia BI thread: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia BI ownership: 0 → 2 (runs 0 → 2·1·2)
- case-b-sofia MN ownership: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia SW data-explained: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia SW ownership: 0 → 2 (runs 0 → 1·2·2)
- case-b-sofia SW structure: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia SW style: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC structure: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC style: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC nothing-invented: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia EC key-facts: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia FCI data-explained: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia FCI thread: 1 → 2 (runs 1 → 2·2·1)
- case-b-sofia FCI ownership: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia FCI style: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia FCI nothing-invented: 0 → 1 (runs 0 → 1·1·2)
- case-b-sofia DC thread: 1 → 2 (runs 1 → 1·2·2)
- case-b-sofia DC structure: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia DC style: 1 → 2 (runs 1 → 2·2·2)
- case-b-sofia DC nothing-invented: 0 → 2 (runs 0 → 0·2·2)
- case-b-sofia RA thread: 1 → 2 (runs 1 → 2·2·1)
- case-b-sofia RA ownership: 1 → 2 (runs 1 → 1·2·2)
- case-b-sofia RA structure: 0 → 1 (runs 0 → 1·1·1)
- case-b-sofia CP nothing-invented: 0 → 2 (runs 0 → 2·1·2)
- case-b-sofia CP key-facts: 1 → 2 (runs 1 → 2·2·2)

Sections: BI Background Information; MN Medical Necessity Criteria; SW Strengths and Weaknesses; EC Environmental Changes; FCI Family/Caregiver Involvement; GM Generalization and Maintenance; DC Discharge and Service Fading Plan; RA Risk Assessment; CP Crisis Plan.
