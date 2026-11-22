# Writing rules

These are the instructions the model receives, kept apart from the code so they can be read, discussed and versioned.

| File | What it holds | When it is sent |
| --- | --- | --- |
| `assessment.md` | Rules for the whole assessment: what it is for, who reads it, how it is written, "nothing invented", the format for pasting into ABA Matrix. | On every call, as part of the cached prefix. |
| `payers/florida-medicaid-molina.md` | Facts from the Florida Medicaid policy (Dec. 2024) and the Molina guide (Jul. 2026) that bear on authorization. Only what those two texts say. | On every call, as part of the cached prefix. |
| `instruments.md` | How to read the Vineland-3 and the BASC-3 PRQ (means, standard deviations, the direction of each scale). Not from the payers; marked as pending confirmation by the BCBA. | On every call, as part of the cached prefix. |
| `sections/medical-necessity.md` | What the Medical Necessity section is for, the structure the BCBA requires and what a good one looks like. | Only when generating that section, after the cached prefix. |

Each file starts with an `id` and a `version`. When the content changes, the version goes up; every output stores the versions that produced it (`rulesVersions` in each run's JSON).

The order matters for cost: the first three files are the same for every section and every case, and a case's sources are the same for every section of that case. That prefix is written once to the provider's cache and the other sections read it at a fraction of the price. Each section's rules go last so they don't break that prefix.
