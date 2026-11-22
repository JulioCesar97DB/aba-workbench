# Third-party licenses shipped with the app

| File | Covers | Source |
| --- | --- | --- |
| `IBM-Plex-OFL.txt` | The IBM Plex Sans and IBM Plex Mono fonts the interface ships (from the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` packages). SIL Open Font License 1.1, with IBM's copyright notice and the Reserved Font Name "Plex". | `LICENSE.txt` of the font project, https://github.com/IBM/plex (identical for `packages/plex-sans` and `packages/plex-mono`), copied 2026-11-22 with LF line endings. |

The OFL requires each copy of the fonts to carry the copyright notice and the license, so electron-builder copies this folder into the packaged app's resources folder (`licenses/`, next to `rules/`; see `electron-builder.yml`). `tests/licenses.test.ts` checks the file against the license the font packages carry, and the packaged window tests check it is in the app.

The fonts are used as published: the app does not modify them or ship them on their own.
