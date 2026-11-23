/*
 * De-identification, main process only: see docs/deidentification.md.
 */
export { deidentify, Deidentifier, type DeidentifyOptions, type DeidentifyResult, type Finding, type MapEntry, type Possible, type RestoreMap } from "./deidentify.ts";
export { DEFAULT_WORKER_SCRIPT, DeidentifyThread, type DeidentifyState } from "./off-thread.ts";
export { reidentify, type ReidentifyResult, type Restored, type Unrestored } from "./reidentify.ts";
export type { ClientSheet, FoundKind, PersonGroup, SheetPerson } from "./sheet.ts";
