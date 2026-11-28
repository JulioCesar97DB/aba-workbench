# PR 0 paused (2026-11-28)

The owner paused PR 0, which sends the approved case map into section requests. It resumes with the Plan step's PR 4, when sections must name accepted plan items. Everything here is on branch `JulioCesar97DB/map-in-sections`:
- the renderer (`src/lib/case-map-block.ts`);
- the routes;
- `mapUsed`;
- the rules;
- `pnpm eval --map` with the invented fixture `fixtures/cases/case-b-sofia/approved-map.json`;
- the tests.

The baseline `t1-rules-2026-11-27` was not changed.

## Results

The eval was case B, 3 runs, chained, `--map`, ChatGPT sign-in, gpt-6.2-astra, against `t1-rules-2026-11-27`. Both rounds came out as REGRESSION.

| | Baseline | Round 1: whole map to every section | Round 2: owned items in full, the rest by name |
| --- | --- | --- | --- |
| Code items (of 216) | 207 | 200 | 204 |
| Judge items (of 144) | 99 | 96 | 87 |
| Code medians down / hard checks now failing | – | 8 / 7 | 7 / 7 |
| ChatGPT drafts that read the cache | 19 of 27 | 9 of 27 | 12 of 27 |
| Requests | – | 90 | 91 |

### Round 1: the whole map to every section (D11 as first decided)

- **Retelling:** sections retold the map's incidents outside their home, in the map's own words (the street crossing, the thrown chair, the homework outbursts). Repetition failed in MN, EC, DC and RA.
- **Numbers:** Discharge and Background Information listed the map's raw counts without saying what they mean.
- **Dates:** Environmental Changes put dates in the narrative.
- **Length:** Risk Assessment ran over its word range.
- **Size:** the block was about 50,000 characters, roughly 11,000 to 12,000 tokens more per request.

### Round 2: each section gets in full only the items it owns (D11 as the owner changed it on 2026-11-28)

**What improved:** retelling. Hard repetition regressions fell from 4 sections to 1.

**What got worse:**
- **Discharge:**
  - The name-plus-numbers exception sent baselines with the app's computed "120 minutes", which is in no source. Discharge wrote "3, 1 and 2 contacts per 120-minute observation", a run of numbers with no meaning.
  - It also dropped the other baselines: the IEP's 2 to 4 classroom departures a week, and refusal on 6 of 20 school days.
  - The map's "contacts" replaced the key's episodes.
- **Environmental Changes:**
  - Its own facts arrive in full with their dates, so full dates landed in the narrative.
  - It came out at 298 or 299 words, against her range of 300 to 450.
- **Risk Assessment:**
  - Every risk arrives in full with its evidence, and the section ran to 407 to 439 words (range 300 to 400).
  - It shares the street-crossing wording with Medical Necessity.
- **Background Information:** the client part arrives in full with its numbers, and the section lists them without saying what they mean.
- **The judge's "thread":** it fell in BI, SW, FCI, DC and RA. With bare names, sections lose links the whole map gave them:
  - SW leaves out Hand biting and requesting a break;
  - FCI does not tie the caregivers' responses to the skills;
  - BI leaves out the street-crossing safety concern;
  - RA and DC miss the classroom-departure rate.

## Open question: D8 on ChatGPT

The block now differs per section. The ChatGPT sign-in caches only up to the end of the latest user message, so a map message of its own would move that place for every section. Round 2 therefore puts the map in `instructions`, after the fixed first line and before the task. The input is then only the rules and the sources, the same bytes for every request of a case.

This departs from D8 ("the map's own last user message") and needs the owner's confirmation. Claude and OpenAI with a key keep the map as a third cached block after the sources.

## Ideas for a next round (none tried)

1. **Discharge's numbers:** send only the sources' own baseline values (the observations and the other baselines), never the app's computed minutes.
2. **Dates in facts:** give a fact in full without its dates, except for a coming change, or have Environmental Changes' rule restate the date check.
3. **Risk Assessment:** send the risks in full without their evidence lines, which the sources already give.
4. **The thread:** give name-only items one line of what connects them, for example a behavior's name with its home and its hypothesized function, or a skill a section must tie to. This goes beyond "name only" and needs the owner's decision.

Full reports, outside the repo:
- `pr0-map-in-sections-report.md`
- `pr0-map-in-sections-d11-report.md`

Results, under `eval-results/`:
- `2026-11-28T09-26-19-pr0-map`
- `2026-11-28T15-52-51-pr0-map-d11`
