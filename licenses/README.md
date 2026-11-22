# Third-party licenses shipped with the app

| File | Covers | Source |
| --- | --- | --- |
| `PDF.js-Apache-2.0.txt` | Mozilla's PDF.js (the `pdfjs-dist` package), bundled into the process that reads PDFs' text (`out/main/pdf-text-child.js`). Apache License 2.0 (its source files carry "Copyright 2024 Mozilla Foundation"). The package ships no NOTICE file. | `LICENSE` of the `pdfjs-dist` package, version 6.5.438, copied 2026-11-22. |
| `IBM-Plex-OFL.txt` | The IBM Plex Sans and IBM Plex Mono fonts the interface ships (from the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` packages). SIL Open Font License 1.1, with IBM's copyright notice and the Reserved Font Name "Plex". | `LICENSE.txt` of the font project, https://github.com/IBM/plex (identical for `packages/plex-sans` and `packages/plex-mono`), copied 2026-11-22 with LF line endings. |

The OFL requires each copy of the fonts to carry the copyright notice and the license, and the Apache License 2.0 (section 4a) requires giving recipients of PDF.js a copy of its license, so electron-builder copies this folder into the packaged app's resources folder (`licenses/`, next to `rules/`; see `electron-builder.yml`). `tests/licenses.test.ts` checks each file against the license its package carries, and the packaged window tests check they are in the app.

The fonts are used as published: the app does not modify them or ship them on their own.
