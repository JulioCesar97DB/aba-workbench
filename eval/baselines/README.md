# Accepted evaluation runs

Each folder here is one accepted run of `pnpm eval` (owner's decision, 2026-11-23: accepted baselines are committed; every run is written to the gitignored `eval-results/`). A folder holds that run's `results.json` and `summary.md`. The drafts in them are of the invented cases only.

- **Accepting a run:** accept it when the owner (or the BCBA's verdict) accepts the rules it was drafted with. `pnpm eval --accept <name>` saves the run as `eval/baselines/<name>/`; commit it with the rules change it measured.
- **What is refused:** an invalid run (a window showed), a rehearsal (`--rehearse`), and a run from a checkout with uncommitted changes in `rules/`, `src/` or `eval/`.
- **No local paths:** a baseline names checkouts by a label and a commit, never by a path. `--accept` refuses to write one that still holds a local path, the home folder or the user name.
- **All runs:** a baseline holds every run of each case (3 by default: texts, findings, judge answers and scores) and their medians, so its drafts can be checked and judged again run by run.
- **Comparing:** `pnpm eval` compares medians with the newest accepted run of the same kind, or with `--baseline <name>`.
  - Every stored run of the baseline is checked again with the current checks, and its medians are worked out again.
  - Its runs are judged again when the baseline's judge differs from this one.

  The baseline's files are never changed by a comparison.

## Known gaps

- **`dev-2026-11-23`** is from before runs: one run of case B. It is read as a single run, whose medians are its own scores, and a comparison with it notes that the run counts differ.

- **`dev-2026-11-23`:** every section's `generation` is `null`. That is the model that served each draft, its tokens and the rules versions it was drafted with.
  - **Why:** the drafts were made on 2026-11-23 before the harness read them from the case file, so these were never recorded. This is not a harness bug, and they cannot come back without drafting again.
  - **What is known:** the drafts were written with `dev`'s rules at 363e3d7 (the run's `drafting.rulesVersions` lists them) on GPT-6.2 Astra through the ChatGPT sign-in.
  - **What is recorded:** the drafts themselves, their checks and their judge records. Runs from fa44083 onward record `generation` for every draft.
