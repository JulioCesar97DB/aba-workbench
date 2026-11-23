# Accepted evaluation runs

Each folder here is one accepted run of `pnpm eval` (owner's decision, 2026-11-23: accepted baselines are committed; every run is written to the gitignored `eval-results/`). A folder holds that run's `results.json` and `summary.md`. The drafts in them are of the invented cases only.

- Accept a run when the owner (or the BCBA's verdict) accepts the rules it was drafted with: `pnpm eval --accept <name>` saves the run as `eval/baselines/<name>/`; commit it with the rules change it measured.
- `pnpm eval` compares with the newest accepted run of the same kind (real or rehearsal), or with `--baseline <name>`.
- Rehearsal runs (`--rehearse`, a fake provider) are never accepted here.
