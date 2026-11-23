import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
import { Deidentifier, deidentify, reidentify, type ClientSheet, type DeidentifyResult } from "../src/main/deidentify/index.ts";
import { BATTERY, TODAY } from "./deidentify-battery.ts";

// Invented people only (see tests/deidentify-battery.ts).

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `value` is still in `text` as a whole word, ignoring case and accents. */
function survives(text: string, value: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(foldString(value))}(?![\\p{L}\\p{N}])`, "u").test(foldString(text));
}

/** Whether `value` is still in `text` with its capital letter (accents ignored). */
function survivesCapitalized(text: string, value: string): boolean {
  const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(plain(value))}(?![\\p{L}\\p{N}])`, "u").test(plain(text));
}

const PLACEHOLDER = /\[[A-Z][A-Z0-9 ]*\]/g;

test("battery: nothing identifying survives, clinical words do, and every placeholder comes back", (t) => {
  let identifying = 0;
  let leaks: string[] = [];
  let overHidden: string[] = [];
  for (const item of BATTERY) {
    const engine = new Deidentifier(item.sheet, { today: TODAY });
    const results = item.paragraphs.map((paragraph) => engine.deidentify(paragraph));
    const all = results.map((r) => r.text).join("\n\n");
    for (const value of item.mustHide) {
      identifying++;
      if (survives(all, value)) leaks.push(`${item.name}: ${value}`);
    }
    for (const value of item.mustHideCapitalized ?? []) {
      identifying++;
      if (survivesCapitalized(all, value)) leaks.push(`${item.name}: ${value}`);
    }
    for (const value of item.mustKeep) if (!all.includes(value)) overHidden.push(`${item.name}: ${value}`);

    // Round trip: every placeholder is restored, none is left or reported, and hiding the
    // restored text again gives the same placeholders (the map is consistent).
    for (const result of results) {
      const back = reidentify(result.text, engine.map);
      assert.deepEqual(back.unrestored, [], `${item.name}: unrestored in ${result.text}`);
      assert.equal(back.text.match(PLACEHOLDER), null, back.text);
      assert.equal(engine.deidentify(back.text).text, result.text, `${item.name}: not stable`);
    }
  }
  t.diagnostic(`identifying strings: ${identifying}, slipped through: ${leaks.length}, clinical strings wrongly hidden: ${overHidden.length}`);
  leaks = leaks.sort();
  overHidden = overHidden.sort();
  assert.deepEqual({ leaks, overHidden }, { leaks: KNOWN_LEAKS, overHidden: [] });
});

/** What the battery knows slips through: nothing today (the cousin "Su primo Bruno" is caught by "primo" used as a title). */
const KNOWN_LEAKS: string[] = [];

test("fixture cases: the invented notes keep no name, with the sheet she would fill in", (t) => {
  const sheets: Record<string, ClientSheet> = {
    "case-a-mateo": {
      client: { firstName: "Mateo", lastName: "Ficticio", dateOfBirth: "2022-08-03" },
      caregivers: [{ firstName: "Lucía", lastName: "Ficticio" }, { firstName: "Andrés", lastName: "Ficticio" }],
      family: [{ firstName: "Valeria", lastName: "Ficticio" }],
      professionals: [{ firstName: "Daniela", lastName: "Muestra" }],
    },
    "case-b-sofia": {
      client: { firstName: "Sofía", lastName: "Inventada", dateOfBirth: "2017-05-09" },
      caregivers: [{ firstName: "Carmen", lastName: "Inventada" }],
      family: [{ firstName: "Diego", lastName: "Inventada" }],
      professionals: [{ firstName: "Daniela", lastName: "Muestra" }],
      schools: ["Ejemplo Elementary School"],
    },
  };
  // The evaluators, the pediatrician and the psychiatrist are not on the sheets: a label or a title gives them away.
  const names = ["Mateo", "Ficticio", "Lucía", "Andrés", "Valeria", "Daniela", "Muestra", "Elena Placeholder", "Ramón Ejemplar", "Sofía", "Inventada", "Carmen", "Diego", "Marta Supuesta", "Iván Hipotético", "Ejemplo"];
  let files = 0;
  for (const [id, sheet] of Object.entries(sheets)) {
    const engine = new Deidentifier(sheet, { today: TODAY });
    const folder = path.join(import.meta.dirname, "..", "fixtures", "cases", id);
    for (const name of readdirSync(folder).filter((f) => f.endsWith(".md"))) {
      files++;
      const result = engine.deidentify(readFileSync(path.join(folder, name), "utf8"));
      for (const value of names) assert.ok(!survives(result.text, value), `${id}/${name}: ${value}`);
      assert.deepEqual(reidentify(result.text, engine.map).unrestored, [], `${id}/${name}`);
    }
  }
  t.diagnostic(`${files} fixture notes de-identified`);
});

const MATEO: ClientSheet = {
  client: { firstName: "Mateo", lastName: "Ficticio Gómez", nicknames: ["Teo"], dateOfBirth: "2022-08-03" },
  caregivers: [{ firstName: "Lucía", lastName: "Ficticio", relation: "mother" }],
};

function hide(text: string, sheet: ClientSheet = MATEO, options = {}): DeidentifyResult {
  return deidentify(text, sheet, { today: TODAY, ...options });
}

test("names: every form of the client and a caregiver", () => {
  const cases: Array<[string, string]> = [
    ["Mateo bit her.", "[CLIENT] bit her."],
    ["mateo bit her.", "[CLIENT] bit her."],
    ["MATEO FICTICIO GÓMEZ", "[CLIENT FULL NAME]"],
    ["Mateo's tablet", "[CLIENT]'s tablet"],
    ["Mateo\u{2019}s tablet", "[CLIENT]\u{2019}s tablet"],
    ["Teo cried", "[CLIENT] cried"],
    // A full name with fewer words than the sheet's ("Mateo Ficticio" for "Mateo Ficticio Gómez") has a numbered placeholder of its own.
    ["Mateo\nFicticio left", "[CLIENT FULL NAME 1] left"],
    ["Mateo Fic-\nticio left", "[CLIENT FULL NAME 1] left"],
    ["Ficticio, Mateo", "[CLIENT FULL NAME 1]"],
    ["Mateo F. and M. Ficticio and M.F.", "[CLIENT FULL NAME 1] and [CLIENT FULL NAME 2] and [CLIENT INITIALS]"],
    // Written otherwise than the sheet ("Ficticio-Gómez" for "Ficticio Gómez"): its own number, restored as written.
    ["Mateo Ficticio-Gómez", "[CLIENT FULL NAME 1]"],
    ["Lucia Ficticio and Lucía", "[CAREGIVER 1 FULL NAME] and [CAREGIVER 1]"],
    // One of the client's two surnames: its own placeholder, so it restores exactly.
    ["Mrs. Ficticio said", "Mrs. [CLIENT LAST NAME 1] said"],
    ["Mrs. Ficticio Gómez said", "Mrs. [CLIENT LAST NAME] said"],
    ["the Ficticios came", "the [CLIENT LAST NAME 1]s came"],
    // A plural or possessive s without an apostrophe; a longer name is only reported.
    ["Mateos toys and Lucíana", "[CLIENT]s toys and Lucíana"],
  ];
  for (const [input, expected] of cases) assert.equal(hide(input).text, expected, input);
});

test("names: a name that is also a word, capitalized only by default, every case with 'always'", () => {
  const sheet: ClientSheet = { client: { firstName: "Will", lastName: "Ashcombe" }, caregivers: [{ firstName: "Hope", lastName: "Ashcombe" }] };
  const text = "Will will need help. Hope has hope. Will Ashcombe, will ashcombe.";
  const byDefault = hide(text, sheet);
  assert.equal(byDefault.text, "[CLIENT] will need help. [CAREGIVER 1] has hope. [CLIENT FULL NAME], [CLIENT FULL NAME].");
  assert.deepEqual(
    byDefault.possible.map((p) => [p.text, p.placeholder]),
    [
      ["will", "[CLIENT]"],
      ["hope", "[CAREGIVER 1]"],
    ],
  );
  assert.equal(hide(text, sheet, { commonWordNames: "always" }).text, "[CLIENT] [CLIENT] need help. [CAREGIVER 1] has [CAREGIVER 1]. [CLIENT FULL NAME], [CLIENT FULL NAME].");
});

test("dates: the date of birth in every format, other dates by the date rule", () => {
  const text = "DOB 08/03/2022, 8/3/22, 8-3-2022, 2022-08-03, August 3, 2022, Aug. 3rd 2022, 3 August 2022, 3rd of August, 2022, 3 de agosto de 2022, agosto 3, 2022; born in August 2022, birthday August 3. Seen 10/02/2026; CDE 03/14/2024 and March 14, 2024; next visit 01/15/2027.";
  const result = hide(text);
  assert.equal(
    result.text,
    "DOB [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB]; born in [DOB MONTH AND YEAR], birthday [DOB MONTH AND DAY]. Seen 10/02/2026; CDE [DATE 1] and [DATE 2]; next visit 01/15/2027.",
  );
  assert.equal(
    hide(text, MATEO, { dates: "all" }).text,
    "DOB [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB], [DOB]; born in [DOB MONTH AND YEAR], birthday [DOB MONTH AND DAY]. Seen [DATE 1]; CDE [DATE 2] and [DATE 3]; next visit [DATE 4].",
  );
  // The other order of day and month, and what is not a date.
  assert.equal(hide("03/08/2022 (day first)").text, "[DOB] (day first)");
  assert.equal(hide("Range 57-67, age 4:2, ratio 1/2, 13/45/2020, 02/30/2019.").text, "Range 57-67, age 4:2, ratio 1/2, 13/45/2020, 02/30/2019.");
});

test("patterns: phones, emails, IDs, addresses, with or without the sheet", () => {
  const empty: ClientSheet = { client: {} };
  const cases: Array<[string, string]> = [
    // Each written form of a value has its own placeholder, restored exactly as written.
    ["Call (305) 555-0142, 305-555-0142, 305.555.0142, +1 305 555 0142 or 1-305-555-0142 ext. 12.", "Call [PHONE 1], [PHONE 2], [PHONE 3], [PHONE 4] or [PHONE 5]."],
    ["Cell: 555-0199. Tel 3055550123.", "Cell: [PHONE 1]. Tel [PHONE 2]."],
    ["Write to Lucia.F+aba@example.co.uk today.", "Write to [EMAIL 1] today."],
    ["Medicaid ID: 9876543210; Member # ABC12345; MRN 00456789; SSN 123-45-6789; record 1234 5678.", "Medicaid ID: [ID 1]; Member # [ID 2]; MRN [ID 3]; SSN [ID 4]; record [ID 5]."],
    ["Policy W123456789 and 12345678 alone.", "Policy [ID 1] and [ID 2] alone."],
    ["Lives at 4471 SW 12th Terrace, Apt 3, Miami, FL 33135 with her aunt.", "Lives at [ADDRESS 1] with her aunt."],
    ["Moved to 55 Ocean Drive. Lives in Miami Beach, FL 33139. P.O. Box 4410. ZIP 33010.", "Moved to [ADDRESS 1]. Lives in [ADDRESS 2]. [ADDRESS 3]. ZIP [ADDRESS 4]."],
    ["Examinee: Pablo Desconocido\nRespondent | Marta Inexistente (mother)\nTeacher: N/A", "Examinee: [NAME 1]\nRespondent | [NAME 2] (mother)\nTeacher: N/A"],
  ];
  for (const [input, expected] of cases) assert.equal(hide(input, empty).text, expected, input);
});

test("patterns: clinical codes, scores and ordinary numbers are never hidden", () => {
  const text =
    "CPT 97151, 97153, 97155, 97156 and H2019; ICD-10 F84.0 and F90.2; Vineland-3 ABC 66 (62-70), BASC-3 PRQ T-score 38, percentile 1, age equivalent 1:6. " +
    "20 hours per week, 3 times a day from 8:00 to 14:00, 2 to 4 times per week, 12 St. Patrick's day cards, walked 2 blocks down the road, room 12, 2026.";
  assert.equal(hide(text, { client: {} }).text, text);
  // A name after a title is hidden even when the sheet does not list it.
  assert.equal(hide("Met with Dr. Tomás Ilustre and Ms. Ortega's team; Sra. Prado de la Vega called.", { client: {} }).text, "Met with Dr. [NAME 1] and Ms. [NAME 2]'s team; Sra. [NAME 3] called.");
});

test("sheet values: a school by its distinctive words, an address however it is abbreviated, other values", () => {
  const sheet: ClientSheet = {
    client: { firstName: "Sofía" },
    schools: ["José Martí Elementary School"],
    addresses: ["4471 SW 12th Terrace, Apt 3, Miami, FL 33135"],
    other: ["Little Steps Therapy Center"],
  };
  const text = "José Martí Elementary School, Jose Marti Elementary, José Martí, the school; José Martí's poems; 4471 Southwest 12 Ter; little steps therapy center.";
  // Each different written form has its own placeholder and comes back exactly as written; the same words (accents aside) share one.
  const hidden = hide(text, sheet);
  assert.equal(hidden.text, "[SCHOOL 1], [SCHOOL 2], [SCHOOL 3], the school; [SCHOOL 3]'s poems; [ADDRESS 1]; [OTHER 1].");
  assert.equal(reidentify(hidden.text, hidden.map).text, "José Martí Elementary School, Jose Marti Elementary, José Martí, the school; José Martí's poems; 4471 Southwest 12 Ter; little steps therapy center.");
});

test("one Deidentifier keeps the same placeholders across texts, in reading order", () => {
  const engine = new Deidentifier(MATEO, { today: TODAY });
  const first = engine.deidentify("Call 786-555-0101 or 786-555-0102.");
  const second = engine.deidentify("Only 786-555-0102 works; Lucía agrees.");
  assert.equal(first.text, "Call [PHONE 1] or [PHONE 2].");
  assert.equal(second.text, "Only [PHONE 2] works; [CAREGIVER 1] agrees.");
  assert.deepEqual(second.found.map((f) => [f.placeholder, f.count, f.originals]), [
    ["[PHONE 2]", 1, ["786-555-0102"]],
    ["[CAREGIVER 1]", 1, ["Lucía"]],
  ]);
  assert.deepEqual(engine.map.entries.map((e) => [e.placeholder, e.value]), [
    ["[PHONE 1]", "786-555-0101"],
    ["[PHONE 2]", "786-555-0102"],
    ["[CAREGIVER 1]", "Lucía"],
    // Once a person is mentioned, every form of their name can be restored.
    ["[CAREGIVER 1 FULL NAME]", "Lucía Ficticio"],
    ["[CAREGIVER 1 LAST NAME]", "Ficticio"],
    ["[CAREGIVER 1 INITIALS]", "L.F."],
  ]);
});

test("findings: kind, source, count and each way it was written", () => {
  const result = hide("Mateo and MATEO and Teo. DOB 08/03/2022. Call 305-555-0142.");
  assert.deepEqual(result.found, [
    { placeholder: "[CLIENT]", kind: "client", source: "sheet", count: 3, originals: ["Mateo", "MATEO", "Teo"] },
    { placeholder: "[DOB]", kind: "dob", source: "sheet", count: 1, originals: ["08/03/2022"] },
    { placeholder: "[PHONE 1]", kind: "phone", source: "pattern", count: 1, originals: ["305-555-0142"] },
  ]);
});

test("reidentify: puts back what models do to placeholders and reports what it cannot", () => {
  const { map } = hide("Mateo Ficticio, Lucía, Mrs. Ficticio, DOB 08/03/2022, Lucía Ficticio.");
  const restored = reidentify(
    "[CLIENT FULL NAME]. [Client]'s mother [caregiver 1] and [CAREGIVER_1]; [CAREGIVER1] said [CLIENT 'S] name. \\[CLIENT LAST NAME 1\\] [[DOB]] " +
      "{CAREGIVER 1 FULL NAME} (CLIENT LAST NAME 1) [CLIENT LAST NAME 1 and [CAREGIVER 1 CAREGIVER 1 FULL NAME. The client (client) [sic].",
    map,
  );
  assert.equal(
    restored.text,
    "Mateo Ficticio Gómez. Mateo's mother Lucía and Lucía; Lucía said Mateo's name. Ficticio 08/03/2022 " +
      "Lucía Ficticio Ficticio Ficticio and Lucía Lucía Ficticio. The client (client) [sic].",
  );
  assert.deepEqual(restored.unrestored, []);
  const reported = reidentify("CLIENT INFORMATION: [CLIENT] met [CAREGIVER 2] on [DATE 1]; [INSERT SCHOOL]. [Name]. See [the notes](notes.md).", map);
  assert.equal(reported.text, "CLIENT INFORMATION: Mateo met [CAREGIVER 2] on [DATE 1]; [INSERT SCHOOL]. [Name]. See [the notes](notes.md).");
  assert.deepEqual(
    reported.unrestored.map((u) => [u.text, u.reason]),
    [
      ["CLIENT", "no-brackets"],
      ["[CAREGIVER 2]", "unknown-placeholder"],
      ["[DATE 1]", "unknown-placeholder"],
      ["[INSERT SCHOOL]", "unknown-placeholder"],
      ["[Name]", "unknown-placeholder"],
    ],
  );
  assert.deepEqual(restored.restored.find((r) => r.placeholder === "[CLIENT FULL NAME]"), { placeholder: "[CLIENT FULL NAME]", count: 1, repaired: 0 });
});

test("each part of a surname has its own placeholder and restores as the text wrote it, in the sheet's spelling", () => {
  const sheet: ClientSheet = { client: { firstName: "Ana", lastName: "Ejemplar de la Fuente" }, caregivers: [{ firstName: "Rita", lastName: "Rodríguez-Peña" }] };
  const hidden = hide("Ms. de la fuente and MS. DE LA FUENTE, then Ejemplar once; Mrs. Rodriguez; Mrs. Rodríguez; Ejemplar de la Fuente.", sheet);
  assert.equal(
    hidden.text,
    "Ms. [CLIENT LAST NAME 1] and MS. [CLIENT LAST NAME 2], then [CLIENT LAST NAME 3] once; Mrs. [CAREGIVER 1 LAST NAME 1]; Mrs. [CAREGIVER 1 LAST NAME 1]; [CLIENT LAST NAME].",
  );
  // Each written form comes back as written, in the sheet's spelling for the name words, particles as written.
  assert.equal(
    reidentify("Ms. [CLIENT LAST NAME 1], MS. [CLIENT LAST NAME 2], [CLIENT LAST NAME 3], [CLIENT LAST NAME] and Mrs. [CAREGIVER 1 LAST NAME 1].", hidden.map).text,
    "Ms. de la Fuente, MS. DE LA Fuente, Ejemplar, Ejemplar de la Fuente and Mrs. Rodríguez.",
  );
});

test("round trip: a text written with the sheet's own spellings comes back exactly", () => {
  const sheet: ClientSheet = {
    ...MATEO,
    schools: ["José Martí Elementary School"],
    phones: ["(305) 555-0142"],
  };
  const text = "Mateo Ficticio Gómez (DOB 08/03/2022) attends José Martí Elementary School. Mateo lives with Lucía, who answers (305) 555-0142. Diagnosis F84.0; 97153.";
  const hidden = hide(text, sheet);
  assert.equal(hidden.text, "[CLIENT FULL NAME] (DOB [DOB]) attends [SCHOOL 1]. [CLIENT] lives with [CAREGIVER 1], who answers [PHONE 1]. Diagnosis F84.0; 97153.");
  assert.equal(reidentify(hidden.text, hidden.map).text, text);
});
