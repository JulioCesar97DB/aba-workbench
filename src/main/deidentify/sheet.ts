/*
 * The client sheet: what the clinician tells the app to hide for one case. The case
 * screens that fill it in come with part 2; this is the shape the core reads.
 * Every field is optional: whatever is filled in is hidden, and the patterns
 * (src/main/deidentify/patterns.ts, dates.ts) run on every text whether it is filled in or not.
 */

export interface SheetPerson {
  /** Given names as written, "María José". */
  firstName?: string;
  /** Surnames as written: "Ficticio Gómez", "Rodríguez-Peña", "de la Cruz". */
  lastName?: string;
  /** Other names the person is called by: "Teo", "Majo". */
  nicknames?: string[];
  /** The name the text should use when a first name or a nickname is restored. */
  preferredName?: string;
  /** "mother", "teacher", "pediatrician": shown on the review screen, never hidden. */
  relation?: string;
}

export interface ClientSheet {
  client: SheetPerson & {
    /** The date of birth as YYYY-MM-DD. */
    dateOfBirth?: string;
  };
  caregivers?: SheetPerson[];
  /** Siblings and other relatives. */
  family?: SheetPerson[];
  /** Teachers, therapists, physicians and other professionals she adds. */
  professionals?: SheetPerson[];
  schools?: string[];
  addresses?: string[];
  phones?: string[];
  emails?: string[];
  /** Medicaid number, member ID, record number and the like. */
  ids?: string[];
  /** Anything else she wants hidden, matched as written (case and accents ignored). */
  other?: string[];
}

export type PersonGroup = "client" | "caregiver" | "family" | "professional";

export type FoundKind =
  | PersonGroup
  | "unlisted-name"
  | "school"
  | "address"
  | "city"
  | "phone"
  | "email"
  | "id"
  | "dob"
  | "date"
  | "other";
