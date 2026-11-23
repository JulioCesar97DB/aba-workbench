# The evaluation set: `pnpm eval`

The core of the project is the AI's knowledge: how well it writes an ABA initial assessment with a logical thread and in her style. A rules change must pass this evaluation set before it reaches the BCBA (owner's decision, 2026-11-23). The set is made of invented cases, scored with a rubric (`eval/RUBRIC.md`, version 2).

## What a run does

1. **It starts the app hidden.** It builds the app (`pnpm build`) and starts it with `--hidden`: no window shown, no Dock icon, never the focus.
   - **Profile and home:** the app runs on the eval profile (`--user-data-dir`) and a temporary home folder (`--home-folder`), both outside `~/ABA Workbench` and Documents.
   - **Window checks:** visible windows, the Dock icon and focused windows are checked at launch, every 5 seconds while the app runs, and before it closes.
   - **Fail-closed:** anything shown or focused kills the app and stops the run. A window at the end marks the run invalid: it is never compared or accepted.
   - **No dialog:** in hidden mode the app never shows its "unsaved changes" dialog; it closes and logs instead.
   - **Old checkouts refused:** `--draft-app` refuses a checkout that has no hidden mode.
2. **It drafts each case.** It takes every case in `fixtures/cases/` that has a `key.json`, or the ones named with `--cases`. For each case:
   - it creates the case and adds its sources (PDFs as dropped bytes), her session notes and her standing instructions for **every** section (the key's text, or cleared, since the eval profile is kept between runs), through `window.aba` as she would;
   - it drafts the nine narrative sections in report order. In the default **chained** mode (owner's decision) each draft is approved before the next one, so the app's own consistency check runs after drafts 2 to 9.
3. **It runs the automatic checks** on every section (`eval/checks/checks.ts`).
4. **It asks the judge** to score each section on its own, with the other eight drafts of the case as context (owner's decision), through `window.aba.judgeSection`. With `--judge-samples n` it asks n times and scores the median.
5. **It writes `eval-results/<run>/`** (gitignored):
   - `results.json`: everything, with labels and commits instead of paths;
   - `summary.md`: the verdict, a score table per case (baseline → this run), requests, windows;
   - `comparison.json` and `baseline-as-compared.json`;
   - `drafts/<case>/<section>.txt`.
6. **It compares** the run with the newest accepted run in `eval/baselines/` (committed; owner's decision):
   - the baseline's stored drafts are checked again with the current checks;
   - where the baseline was judged by another judge, its drafts are judged again in the same run by this judge (see "The verdict").

Every request takes the path her requests take:

1. `window.aba` (the preload);
2. the main process's section service;
3. `prepareOutgoingRequest` / `prepareJudgeRequest` in `src/main/outgoing.ts`;
4. the provider.

The harness never talks to a provider and never reads the app's credentials file. It reads the case's data file in its own temporary home, to record each draft's model, tokens and rules versions.

## The verdict

- **REGRESSION** (exit code 2), the hard verdict, on any of these:
  - a code item went down;
  - a check that found nothing in the baseline finds something now;
  - an item scored in the baseline is not scored now.

  The rules change does not go to her.
- **No hard regression** (exit code 0). Judge items that went up or down are listed **apart from the verdict**, for the sections both runs had the same judge. A single judge sample's noise is not measured yet; whether one sample or the median of three decides is the owner's call (pending).
- **NOT COMPARED** (exit code 3): another rubric version, another provider (a rehearsal against a real run) or another drafting mode.
- **INVALID** (exit code 1): a window, the Dock icon or the focus showed.

**The same judge.** A judge record carries a fingerprint: the judge's prompt version and code, its inputs for the section (rubric, expectations, payer facts, key facts and notes, her notes and instructions), the model and the number of samples. The drafts it judges are not part of it.
- Judge items are compared only between records with the same fingerprint.
- When the baseline's fingerprint differs, the run first judges the baseline's drafts again with this judge, which costs 9 requests per case.

**Findings under a rule pending her answer** (a caregiver called by her given name) are listed as provisional and never scored. Key facts that rest on her unconfirmed standard practice are left out of the judge's list.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm eval --sign-in` | The first time only: opens OpenAI's sign-in page in the browser for the eval profile, then runs |
| `pnpm eval` | A real run on the ChatGPT sign-in of the eval profile |
| `pnpm eval --rehearse` | The whole run with a fake provider inside the app's main process: no request leaves the computer, nothing is spent. It uses a profile of its own, deleted afterwards |
| `pnpm eval --draft-app <checkout>` | Drafts with another checkout's app (its rules and its code, built there with `pnpm build`), and judges with this one. Use it to compare a rules branch with `dev` |
| `pnpm eval --from-run <run folder>` | Takes that run's drafts (no drafting), checks them again, and asks the judge only for the sections with no answer from this same judge |
| `pnpm eval --rejudge <run folder>` | Takes that run's drafts, checks them again, and judges every section again. Also takes a baseline's folder |
| `pnpm eval --judge-samples <n>` | Judges each section n times (1 to 5) and scores the median (default 1) |
| `pnpm eval --cases case-b-sofia` | Only these cases |
| `pnpm eval --mode independent` | Drafts without approving, so no consistency checks |
| `pnpm eval --baseline <name>` | Compares with `eval/baselines/<name>/` instead of the newest |
| `pnpm eval --accept <name>` | Also saves the run as `eval/baselines/<name>/`, with every path stripped (commit it). Refused for an invalid run, a rehearsal, or a checkout with uncommitted changes in `rules/`, `src/` or `eval/` |
| `pnpm eval --label <text>`, `--no-build` | Names the run folder; uses the apps as already built |

**The eval profile** is `~/.aba-workbench-eval/profile`. It is owner-only and kept signed in between runs (owner's decision), so the owner signs in once. A fresh temporary home folder is used for every run and deleted at the end, even when the run fails.

**Requests per run** (chained mode, one judge sample, a judge request per section):

- **per case:** 9 drafts + 8 consistency checks + 9 judge = **26**, plus up to 9 repair requests and one retry for each request that fails on the provider's side;
- **plus 9 per case** when the baseline's drafts need judging again;
- **plus** one free model-list call to check the sign-in before anything is spent.

`--rejudge` costs 9 judge requests per case and drafts nothing. The writing and the judge both spend the owner's ChatGPT Pro plan (no money).

**Comparing a rules branch with `dev` on case B:**

```sh
pnpm eval --cases case-b-sofia --draft-app <a checkout of the branch> --label branch --baseline <name>
```

The judge is always this branch's app, so both runs are measured by the same judge.

## The judge

`src/lib/judge.ts` holds the judge's prompt (versioned, `JUDGE_PROMPT_VERSION`), its JSON schema and the Zod check of its answer.

**The prompt:**

- the judge's fixed instructions (not `rules/`, so a rules change cannot move the bar);
- the case's sources;
- the rubric items with their anchors, her structure and habits for the section, the payer facts of the section;
- the case key's notes (behaviors and functions, planted gaps, where incidents belong) and the section's facts;
- her session notes and her standing instructions for the section;
- the other eight drafts, and the section under review.

Every input is quoted, so nothing in it can open or close a tag. **The answer:** one score per item with a reason and quotes, and present, partial or absent for each fact.

**Structured output, both ways:**

- The harness first sends the JSON schema. The providers take an optional `outputFormat`; OpenAI sends it as a strict `json_schema` text format. The ChatGPT sign-in route accepted it on every judge request of the first real run.
- If the route refuses it, the rest of the run asks for plain JSON. A transient error is retried before that decision.
- Every answer is validated with Zod (each item and each fact exactly once). An invalid answer gets **one** repair request that quotes it and lists what was wrong.

**Where the judge can be reached:** `window.aba.judgeSection` is answered only by a development build started with `--hidden` (`resolveJudgeEnabled` in `src/main/paths.ts`). A packaged app never registers its channel. Nothing the judge does is saved to the case.

## The parts

| File | What |
| --- | --- |
| `eval/RUBRIC.md`, `eval/rubric.ts` | The rubric: items, anchors, who scores each, her shapes, structure, habits and the payer facts |
| `eval/checks/` | The automatic checks, pure functions (`tests/eval-checks.test.ts`) |
| `eval/key.ts`, `fixtures/cases/*/key.json` | The case key schema and the keys of cases A and B |
| `eval/results.ts` | The results' shape, scores, medians, rescoring, the comparison, the summary and the baseline path guard (`tests/eval-rubric.test.ts`) |
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
