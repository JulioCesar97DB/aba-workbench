# Accepted evaluation runs

Each folder here is one accepted run of `pnpm eval` (owner's decision, 2026-11-23: accepted baselines are committed; every run is written to the gitignored `eval-results/`). A folder holds that run's `results.json` and `summary.md`. The drafts in them are of the invented cases only.

- **Accepting a run:** accept it when the owner (or the BCBA's verdict) accepts the rules it was drafted with. `pnpm eval --accept <name>` saves the run as `eval/baselines/<name>/`; commit it with the rules change it measured.
- **What is refused:** an invalid run (a window showed), a rehearsal (`--rehearse`), and a run from a checkout with uncommitted changes in `rules/`, `src/` or `eval/`.
- **No local paths:** a baseline names checkouts by a label and a commit, never by a path. `--accept` refuses to write one that still holds a local path, the home folder or the user name.
- **Comparing:** `pnpm eval` compares with the newest accepted run of the same kind, or with `--baseline <name>`.
  - The baseline's drafts are checked again with the current checks.
  - They are judged again when the baseline's judge differs from this one.

  The baseline's files are never changed by a comparison.
