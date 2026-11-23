# The evaluation set: `pnpm eval`

The core of the project is the AI's knowledge: how well it writes an ABA initial assessment with a logical thread and in her style. A rules change must pass this evaluation set before it reaches the BCBA (owner's decision, 2026-11-23). The set is made of invented cases, scored with a rubric (`eval/RUBRIC.md`).

## What a run does

1. It builds the app (`pnpm build`) and starts it hidden (`--hidden`: no window shown, no Dock icon, never the focus). The start stops at once if it sees a visible window or a Dock icon.
   - The app runs on a throwaway profile (`--user-data-dir`) and a temporary home folder (`--home-folder`), both outside `~/ABA Workbench` and outside Documents.
   - Visible windows, the Dock icon and focused windows are checked when the app starts and before it closes, and recorded in the results.
2. It takes every case in `fixtures/cases/` that has a `key.json`, or the ones named with `--cases`. For each case:
   - it creates the case, adds its sources (PDFs as dropped bytes) and her session notes through `window.aba`, as she would;
   - it drafts the nine narrative sections in report order. In the default **chained** mode (owner's decision) it approves each draft before the next one, as she works. The app's own consistency check then runs after drafts 2 to 9.
3. It runs the automatic checks on every section (`eval/checks/checks.ts`).
4. It asks the judge to score each section on its own, with the other eight drafts of the case as context (owner's decision). The judge request goes through `window.aba.judgeSection` (see below).
5. It writes `eval-results/<run>/` (gitignored):
   - `results.json`: everything;
   - `summary.md`: the verdict, a score table per case, requests, windows;
   - `comparison.json`;
   - `drafts/<case>/<section>.txt`.
6. It compares the run with the newest accepted run in `eval/baselines/` (committed; owner's decision) and says plainly whether a rubric item went down or a check that passed now fails. The process exits with code 2 when it did.

Every request takes the path her requests take:

1. `window.aba` (the preload);
2. the main process's section service;
3. `prepareOutgoingRequest` / `prepareJudgeRequest` in `src/main/outgoing.ts`;
4. the provider.

The harness never talks to a provider and never reads the app's credentials file.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm eval --sign-in` | The first time only: opens OpenAI's sign-in page in the browser for the eval profile, then runs |
| `pnpm eval` | A real run on the ChatGPT sign-in of the eval profile |
| `pnpm eval --rehearse` | The whole run with a fake provider inside the app's main process: no request leaves the computer, nothing is spent. It uses a profile of its own, deleted afterwards |
| `pnpm eval --draft-app <checkout>` | Drafts with another checkout's app (its rules and its code, built there with `pnpm build`), and judges with this one. Use it to compare a rules branch with `dev` |
| `pnpm eval --cases case-b-sofia` | Only these cases |
| `pnpm eval --mode independent` | Drafts without approving, so no consistency checks |
| `pnpm eval --baseline <name>` | Compares with `eval/baselines/<name>/` instead of the newest |
| `pnpm eval --accept <name>` | Also saves the run as `eval/baselines/<name>/` (commit it) |
| `pnpm eval --label <text>`, `--no-build` | Names the run folder; uses the apps as already built |

**The eval profile** is `~/.aba-workbench-eval/profile`. It is owner-only and kept signed in between runs (owner's decision), so the owner signs in once. A fresh temporary home folder is used for every run and deleted at the end.

**Requests per run** (chained mode, a judge request per section):

- per case: 9 drafts + 8 consistency checks + 9 judge = **26**, plus up to 9 repair requests;
- plus one free model-list call to check the sign-in before anything is spent;
- cases A and B together: 52, at most 70.

The writing and the judge both spend the owner's ChatGPT Pro plan (no money).

**Comparing step 0 with `dev` on case B:**

```sh
# dev's rules: a checkout of dev anywhere (it needs node_modules)
pnpm eval --cases case-b-sofia --draft-app <checkout of dev> --label dev
# step 0's rules, compared with the run just made after it is accepted
pnpm eval --cases case-b-sofia --draft-app <checkout of the step-0 branch> --baseline <name>
```

The judge is always this branch's app, so both runs are measured by the same judge.

## The judge

`src/lib/judge.ts` holds the judge's prompt (versioned, `JUDGE_PROMPT_VERSION`), its JSON schema and the Zod check of its answer.

**The prompt:**

- the judge's fixed instructions (not `rules/`, so a rules change cannot move the bar);
- the case's sources (cached across the nine judge requests of a case);
- the rubric items with their anchors, and her structure and habits for the section;
- the case key's notes (behaviors and functions, planted gaps, where incidents belong) and the section's facts;
- the other eight drafts, and the section under review.

**The answer:** one score per item with a reason and quotes, and present, partial or absent for each fact.

**Structured output, both ways:**

- The harness first sends the JSON schema. The providers take an optional `outputFormat`; OpenAI sends it as a strict `json_schema` text format. Whether the ChatGPT sign-in route accepts that is verified by the first judge request of the first real run.
- If the route refuses it, the rest of the run asks for plain JSON. Every answer is validated with Zod (each item and each fact exactly once). An invalid answer gets **one** repair request that quotes it and lists what was wrong.
- An item still without a valid answer is recorded as not scored, which the comparison reports.

**Where the judge can be reached:** `window.aba.judgeSection` is answered only by a development build started with `--hidden` (`resolveJudgeEnabled` in `src/main/paths.ts`). A packaged app never registers its channel. Nothing the judge does is saved to the case.

## The parts

| File | What |
| --- | --- |
| `eval/RUBRIC.md`, `eval/rubric.ts` | The rubric (version 1): items, anchors, who scores each, her shapes, structure and habits |
| `eval/checks/` | The automatic checks, pure functions (`tests/eval-checks.test.ts`) |
| `eval/key.ts`, `fixtures/cases/*/key.json` | The case key schema and the keys of cases A and B |
| `eval/results.ts` | The results' shape, scores, the comparison and the summary (`tests/eval-rubric.test.ts`) |
| `eval/run.mts` | The run |
| `eval/rehearsal.ts` | The fake provider of `--rehearse` |
| `eval/baselines/` | Accepted runs, committed |
| `src/lib/judge.ts`, `prepareJudgeRequest`, `SectionService.prepareJudge` | The app side of the judge (`tests/eval-app.test.ts`) |

## Growing it

- **More cases:** add a folder to `fixtures/cases/` with its `case.json`, its sources and a `key.json`. The run picks it up. Where the next cases come from is the owner's decision.
- **The later stages** (the case formulation, the plan, the whole-assessment review): their rubric items are already defined in `eval/rubric.ts` with `stage` set and are not scored yet. Each new stage adds:
  - its request kind to the run;
  - its sections to `SECTION_EXPECTATIONS`;
  - its code checks (coverage: every behavior in 8, 10, 13, 14, 19; every procedure in 14 also in 15 and the reverse).
- **Examples in the rules:** the copied-example check reads invented examples by convention:
  - text under a heading that names an example ("## Invented example: ...");
  - blockquotes;
  - a quotation right after "Example:".

  Template phrases with "..." or [brackets] are not examples.
