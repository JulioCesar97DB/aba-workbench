# Accepted evaluation runs

Each folder here is one accepted run of `pnpm eval` (owner's decision, 2026-11-23: accepted baselines are committed; every run is written to the gitignored `eval-results/`). A folder holds that run's `results.json` and `summary.md`. The drafts in them are of the invented cases only.

- **Accepting a run:** accept it when the owner (or the BCBA's verdict) accepts the rules it was drafted with. `pnpm eval --accept <name>` saves the run as `eval/baselines/<name>/`; commit it with the rules change it measured.
- **What is refused:** an invalid run (a window showed), a rehearsal (`--rehearse`), a run from a checkout with uncommitted changes in `rules/`, `src/` or `eval/`, and a run where any run of any case has a failed draft, a judge error or an unscored item: an incomplete run never becomes the bar.
- **No local paths:** a baseline names checkouts by a label and a commit, never by a path. `--accept` refuses to write one that still holds a local path, the home folder or the user name.
- **All runs:** a baseline holds every run of each case (3 by default: texts, findings, judge answers and scores) and their medians, so its drafts can be checked and judged again run by run.
- **Comparing:** `pnpm eval` compares medians with the newest accepted run of the same kind, or with `--baseline <name>`.
  - Every stored run of the baseline is checked again with the current checks, and its medians are worked out again.
  - Its runs are judged again when the baseline's judge differs from this one.

  The baseline's files are never changed by a comparison.

## Known gaps

- **`t1-rules-2026-11-27`:**
  - **Risk Assessment drafted with v5:** its drafts are those of T1 fix round 1 (cc1864d). Risk Assessment was re-judged under v6's expectations (7da80cb) but not drafted again, so its drafts were written with Risk Assessment rule v5.
  - **What v6 changes:** it only stops that section restating the caregiver training method and naming a procedure.
  - **Every other section** was drafted with the rules as they are at 7da80cb.
  - **Re-scored offline with checks v5** (review round 1 of T1, no request): both arms' code items were checked again with the fixed checks, and `results.json` and `summary.md` were written again. Only the her-wording false positives in Background and Discharge went away: code 205 → 207 of 216, dev 171 → 173. The judge answers are the stored ones.
  - **Its notes, corrected:** the summary names the dev arm once ("dev-step0-2026-11-23 re-judged", not "re-judged re-judged"). It also says that the dev arm's drafts were all judged again in run 2026-11-27T21-31-23-t1-rules, and later only where the judge changed (finding 10).
  - **Its key is version 2;** case B's key is now version 3 (review round 1: `sw-family` and `fci-father` follow who owns the fact). Version 4 (the owner's decision of 2026-11-27 on her practice) gives `fci-bst` the rules as its source and adds `fci-training-language`. Other judge expectations changed after it was judged: Background and Family/Caregiver Involvement (review round 1) and Medical Necessity (the same decision). So the next comparison notes that the key changed and re-judges Background, Medical Necessity, Strengths and Weaknesses and Family/Caregiver Involvement in both arms.

- **`dev-2026-11-23`:**
  - **One run:** it is from before runs, one run of case B. It is read as a single run, whose medians are its own scores, and a comparison with it notes that the run counts differ.
  - **`generation` is `null`** in every section: the model that served each draft, its tokens and the rules versions it was drafted with.
  - **Why:** the drafts were made on 2026-11-23 before the harness read them from the case file, so these were never recorded. This is not a harness bug, and they cannot come back without drafting again.
  - **What is known:** the drafts were written with `dev`'s rules at 363e3d7 (the run's `drafting.rulesVersions` lists them) on GPT-6.2 Astra through the ChatGPT sign-in.
  - **What is recorded:** the drafts themselves, their checks and their judge records. Runs from fa44083 onward record `generation` for every draft.
