import assert from "node:assert/strict";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
import { Deidentifier, reidentify } from "../src/main/deidentify/index.ts";
import {
  CLINICAL,
  CLINICAL_ROUND2,
  COMPOUND_SHEET,
  PROBES,
  REIDENTIFY_CASES,
  REIDENTIFY_SOURCE,
  RESTORE_COMPOUND,
  RESTORE_EXACT,
  RESTORE_NAMES,
  REVIEW_SHEET,
  REVIEW_TODAY,
  R4_PROBES,
  R4_SCORE_ROWS,
  R4_SPANISH_PROBES,
  R4_SPANS,
  R5_PROBES,
  R6_CLINICAL,
  R6_HOUSE_KEEP,
  R6_PROBES,
  R7_CLINICAL,
  R8_CLINICAL,
  R8_PROBES,
  R8_RESTORE,
  ENGLISH_SHEET,
  R7_PROBES,
  R7_RESTORE,
  SHORT_SHEET,
  R5_RATIOS,
  R5_RESTORE,
  SPANISH_SHEET,
  SPLIT_CLINICAL,
  SPLIT_SHEET,
} from "./deidentify-adversarial.ts";

const PLACEHOLDER = /\[[A-Z][A-Z0-9 ]*\]/gu;

/** Whether `value` survives in `text`, ignoring case, accents and invisible characters, once the placeholders are taken out. */
function survives(text: string, value: string): boolean {
  return foldString(text.replace(PLACEHOLDER, " ")).includes(foldString(value));
}

test("adversarial review: nothing identifying survives, clinical text does, every placeholder comes back", (t) => {
  const leaks: string[] = [];
  const lost: string[] = [];
  let strings = 0;
  for (const probe of PROBES) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const result = engine.deidentify(probe.text);
    for (const value of probe.hide) {
      strings++;
      if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
    }
    for (const value of probe.keep ?? []) if (!result.text.includes(value)) lost.push(`${probe.group}: ${JSON.stringify(result.text)} lost ${value}`);
    const back = reidentify(result.text, engine.map);
    assert.deepEqual(back.unrestored, [], probe.text);
    assert.equal(back.text.match(PLACEHOLDER), null, back.text);
  }
  for (const text of [...CLINICAL, ...CLINICAL_ROUND2]) {
    const result = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY }).deidentify(text);
    if (result.text !== text) lost.push(`clinical: ${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
  }
  t.diagnostic(`${PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through; ${CLINICAL.length + CLINICAL_ROUND2.length} clinical lines, ${lost.length} changed`);
  assert.deepEqual({ leaks, lost }, { leaks: [], lost: [] });
});

test("adversarial review: what models do to placeholders is restored or reported, never garbled", () => {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  engine.deidentify(REIDENTIFY_SOURCE);
  engine.deidentify("M.F.");
  for (const [written, expected, reported] of REIDENTIFY_CASES) {
    const result = reidentify(written, engine.map);
    assert.equal(result.text, expected, written);
    assert.equal(result.unrestored.length > 0, reported, `${written}: ${JSON.stringify(result.unrestored)}`);
  }
});

test("adversarial review: what is hidden comes back exactly as it was written, never another value, never a lost word", () => {
  for (const [text, expected] of [...RESTORE_EXACT.map((t) => [t, t]), ...RESTORE_NAMES]) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const hidden = engine.deidentify(text);
    assert.notEqual(hidden.text, text);
    const back = reidentify(hidden.text, engine.map);
    assert.deepEqual(back.unrestored, [], text);
    assert.equal(back.text, expected);
  }
});

test("dates: finding them stays linear on a hostile text (80,000 dates)", () => {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  for (const unit of ["on 05/01/2026 ", "birthday 3/14 ", "14 de marzo de 2020, "]) {
    const start = performance.now();
    engine.deidentify(unit.repeat(80_000));
    const ms = performance.now() - start;
    assert.ok(ms < 15_000, `${JSON.stringify(unit)} x100000: ${Math.round(ms)} ms`);
  }
});

test("long runs without spaces stay linear: single letters with dots, underscores or hyphens, link-like runs", () => {
  // Each took time growing with the square of its length before (80,000 characters of "a.b.c…": 73 s).
  for (const unit of ["a.b.c.d.e.f.g.h.i.j.", "ana_b_c_d_paz_", "a-n-a-b-", "a.b@c.d.", "ab%zzcd."]) {
    const engine = new Deidentifier(SHORT_SHEET, { today: REVIEW_TODAY });
    const start = performance.now();
    engine.deidentify(unit.repeat(Math.ceil(400_000 / unit.length)) + "zz");
    const ms = performance.now() - start;
    assert.ok(ms < 10_000, `${JSON.stringify(unit)}: ${Math.round(ms)} ms`);
  }
});

test("split names: ordinary words that spell a sheet name split in two come through as written, and are listed for review", () => {
  for (const text of SPLIT_CLINICAL) {
    const result = new Deidentifier(SPLIT_SHEET, { today: REVIEW_TODAY }).deidentify(text);
    assert.equal(result.text, text);
    assert.ok(result.possible.some((p) => p.reason === "split-name"), text);
  }
});

test("compound names, particles and birthdays restore exactly (review round 3)", () => {
  for (const [text, written, expected] of RESTORE_COMPOUND) {
    const engine = new Deidentifier(COMPOUND_SHEET, { today: REVIEW_TODAY });
    const hidden = engine.deidentify(text);
    assert.notEqual(hidden.text, text);
    const back = reidentify(written || hidden.text, engine.map);
    assert.deepEqual(back.unrestored, [], text);
    assert.equal(back.text, expected);
  }
});

test("a bare label, with a number or more label words or not, is reported, never restored", () => {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  engine.deidentify("Ficticio Gómez");
  const back = reidentify("CLIENT LAST NAME 2 and CLIENT LAST NAME and [CLIENT LAST NAME 3]", engine.map);
  assert.equal(back.text, "CLIENT LAST NAME 2 and CLIENT LAST NAME and [CLIENT LAST NAME 3]");
  assert.deepEqual(back.unrestored.map((u) => u.text), ["CLIENT LAST NAME 2", "CLIENT LAST NAME", "[CLIENT LAST NAME 3]"]);
});

test("review round 4: separators, the ZIP alone, OCR digits, page breaks, Spanish streets and school initials never survive", (t) => {
  const leaks: string[] = [];
  let strings = 0;
  for (const [sheet, probes] of [[REVIEW_SHEET, R4_PROBES], [SPANISH_SHEET, R4_SPANISH_PROBES]] as const) {
    for (const probe of probes) {
      const engine = new Deidentifier(sheet, { today: REVIEW_TODAY });
      const result = engine.deidentify(probe.text);
      for (const value of probe.hide) {
        strings++;
        if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
      }
      const back = reidentify(result.text, engine.map);
      assert.deepEqual(back.unrestored, [], probe.text);
    }
  }
  t.diagnostic(`${R4_PROBES.length + R4_SPANISH_PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through`);
  assert.deepEqual(leaks, []);
});

test("review round 4: no span across a sentence end, labels stay, nothing re-split", () => {
  for (const [text, sent, back] of R4_SPANS) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const result = engine.deidentify(text);
    assert.equal(result.text, sent, text);
    assert.equal(reidentify(result.text, engine.map).text, back, text);
  }
});

test("review round 4: score rows whose numbers equal a short sheet value are sent as they are, and listed for review", () => {
  for (const [change, row] of R4_SCORE_ROWS) {
    const sheet = {
      ...REVIEW_SHEET,
      client: { ...REVIEW_SHEET.client, dateOfBirth: change.dateOfBirth ?? REVIEW_SHEET.client.dateOfBirth },
      addresses: change.address ? [change.address] : REVIEW_SHEET.addresses,
    };
    const result = new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(row);
    assert.equal(result.text, row, row);
    assert.ok(result.possible.some((p) => p.reason === "possible-sheet-value"), `${row}: not listed for review`);
  }
  // With a label the same numbers are the value.
  const labelled = new Deidentifier({ ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth: "2014-03-19" } }, { today: REVIEW_TODAY }).deidentify("DOB | 3 | 19 | 14");
  assert.equal(labelled.text, "DOB | [DOB]");
});

test("review round 5: the full date of birth in any layout, the short forms by the client's name, birthday words and the house number never survive", (t) => {
  const leaks: string[] = [];
  const lost: string[] = [];
  let strings = 0;
  for (const probe of R5_PROBES) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const result = engine.deidentify(probe.text);
    for (const value of probe.hide) {
      strings++;
      if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
    }
    for (const value of probe.keep ?? []) if (!result.text.includes(value)) lost.push(`${JSON.stringify(result.text)} lost ${value}`);
    assert.deepEqual(reidentify(result.text, engine.map).unrestored, [], probe.text);
  }
  t.diagnostic(`${R5_PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through`);
  assert.deepEqual({ leaks, lost }, { leaks: [], lost: [] });
});

test("review round 5: ratios stay as written whatever the birthday, and a session date is read month first", () => {
  for (const text of R5_RATIOS) {
    for (const dateOfBirth of ["2020-03-14", "2020-08-10", "2020-10-08", "2020-09-10", "2019-10-09"]) {
      const sheet = { ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth } };
      assert.equal(new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(text).text, text, `${dateOfBirth}: ${text}`);
    }
  }
  const sheet = { ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth: "2019-02-10" } };
  const engine = new Deidentifier(sheet, { today: REVIEW_TODAY });
  // October 2 this year: a session date. February 10 this year: the birthday, hidden.
  assert.equal(engine.deidentify("Interview date | 10/02/2026").text, "Interview date | 10/02/2026");
  assert.notEqual(engine.deidentify("Party | 02/10/2026").text, "Party | 02/10/2026");
  // A header is not a name.
  assert.equal(engine.deidentify("Name | DOB | Sex").text, "Name | DOB | Sex");
});

test("review round 5: names in another case or without accents, and bracketed phones, come back exactly as written", () => {
  for (const text of R5_RESTORE) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const hidden = engine.deidentify(text);
    assert.notEqual(hidden.text, text);
    assert.doesNotMatch(hidden.text, /\[\[|\{\[/u, text);
    const back = reidentify(hidden.text, engine.map);
    assert.deepEqual(back.unrestored, [], text);
    assert.equal(back.text, text);
  }
});

test("review round 6: overlapping date-of-birth readings, spelled and held names and school short forms never survive, and every one restores exactly", (t) => {
  const leaks: string[] = [];
  let strings = 0;
  for (const probe of R6_PROBES) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const result = engine.deidentify(probe.text);
    for (const value of probe.hide) {
      strings++;
      if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
    }
    const back = reidentify(result.text, engine.map);
    assert.deepEqual(back.unrestored, [], probe.text);
    assert.equal(back.text, probe.text);
  }
  t.diagnostic(`${R6_PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through`);
  assert.deepEqual(leaks, []);
});

test("review round 6: norms, sessions, trials, item codes and CPT units stay as written", () => {
  for (const [dateOfBirth, line] of R6_CLINICAL) {
    const sheet = { ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth } };
    assert.equal(new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(line).text, line, `${dateOfBirth}: ${line}`);
  }
  const house = { client: { firstName: "Zed", lastName: "Qux", dateOfBirth: "2019-11-05" }, addresses: ["102 NW 5th St, Miami, FL 33128"] };
  for (const line of R6_HOUSE_KEEP) assert.equal(new Deidentifier(house, { today: REVIEW_TODAY }).deidentify(line).text, line, line);
  for (const line of ["dirección 102", "house number 102", "lives at # 102", "Address: 102", "102 NW 5th"]) {
    assert.doesNotMatch(new Deidentifier(house, { today: REVIEW_TODAY }).deidentify(line).text, /102/u, line);
  }
});

test("review round 6: every placeholder restores exactly the text it replaced", () => {
  const text = "Teo (Mateo) was born 3/14/2020; DOB March 14, 2020; cumple el 14 de marzo; Bday 3 14. TEO and MATEO.";
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  const hidden = engine.deidentify(text);
  assert.equal(hidden.text, "[CLIENT NICKNAME] ([CLIENT]) was born [DOB]; DOB [DOB 2]; cumple el [DOB MONTH AND DAY]; Bday [DOB MONTH AND DAY 2]. [CLIENT FIRST NAME 1] and [CLIENT FIRST NAME 2].");
  assert.equal(reidentify(hidden.text, engine.map).text, text);
  // What the model writes comes back as each form was written.
  assert.equal(reidentify("[CLIENT], called [CLIENT NICKNAME], born [DOB].", engine.map).text, "Mateo, called Teo, born 3/14/2020.");
});

test("review round 7: three-letter names spelled out or joined in handles, sites and file names never survive, and restore exactly", (t) => {
  const leaks: string[] = [];
  let strings = 0;
  for (const probe of R7_PROBES) {
    const engine = new Deidentifier(SHORT_SHEET, { today: REVIEW_TODAY });
    const result = engine.deidentify(probe.text);
    for (const value of probe.hide) {
      strings++;
      if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
    }
    assert.equal(reidentify(result.text, engine.map).text, probe.text);
  }
  // Inside a longer spelled run, or a three-letter name inside another word of a handle: listed, never passed silently.
  for (const text of ["X A N A", "A N A B", "@anabel"]) {
    const result = new Deidentifier(SHORT_SHEET, { today: REVIEW_TODAY }).deidentify(text);
    assert.ok(result.possible.some((p) => p.reason === "name-inside-word"), text);
  }
  t.diagnostic(`${R7_PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through`);
  assert.deepEqual(leaks, []);
});

test("review round 7: names and values broken across a line break restore exactly, the break kept", () => {
  for (const text of R7_RESTORE) {
    const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
    const hidden = engine.deidentify(text);
    assert.doesNotMatch(hidden.text, /mateo|ticio|cía|0142/iu, text);
    assert.equal(reidentify(hidden.text, engine.map).text, text);
  }
});

test("review round 7: one-digit date forms, ratios after a birthday word and birth weights stay as written", () => {
  for (const [dateOfBirth, line] of R7_CLINICAL) {
    const sheet = { ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth } };
    assert.equal(new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(line).text, line, `${dateOfBirth}: ${line}`);
  }
  // The birthday itself is still hidden after a birthday word.
  for (const text of ["Birthday: 3/14", "born on 3/14", "turns 7 on 3/14", "Bday 3 14", "DOB 1 2 2019"]) {
    const sheet = text.includes("2019") ? { ...REVIEW_SHEET, client: { ...REVIEW_SHEET.client, dateOfBirth: "2019-01-02" } } : REVIEW_SHEET;
    assert.notEqual(new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(text).text, text, text);
  }
});

test("review round 8: apostrophe surnames, kerned short names, long forms, a misplaced possessive, unit numbers and compound initials never survive", (t) => {
  const leaks: string[] = [];
  let strings = 0;
  for (const probe of R8_PROBES) {
    const engine = new Deidentifier(probe.sheet, { today: REVIEW_TODAY });
    const result = engine.deidentify(probe.text);
    for (const value of probe.hide) {
      strings++;
      if (survives(result.text, value)) leaks.push(`${probe.group}: ${JSON.stringify(probe.text)} -> ${JSON.stringify(result.text)} (${value})`);
    }
    assert.equal(reidentify(result.text, engine.map).text, probe.text);
  }
  t.diagnostic(`${R8_PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through`);
  assert.deepEqual(leaks, []);
  // Two everyday words alone ("A na" is also "n/a", "E va" is Spanish): listed for review, never passed silently.
  for (const text of ["Item A na, then.", "E va bien."]) {
    const result = new Deidentifier(SHORT_SHEET, { today: REVIEW_TODAY }).deidentify(text);
    assert.equal(result.text, text);
    assert.ok(result.possible.some((p) => p.reason === "split-name"), text);
  }
});

test("review round 8: ordinary words hyphenated at a line end and ordinary word pairs stay as written", () => {
  for (const line of R8_CLINICAL) {
    for (const sheet of [SHORT_SHEET, ENGLISH_SHEET, REVIEW_SHEET]) assert.equal(new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(line).text, line, line);
  }
  // A compound with a word after the hyphen is the name.
  assert.equal(new Deidentifier(SHORT_SHEET, { today: REVIEW_TODAY }).deidentify("Ana-led session; Paz-Ruiz.").text, "[CLIENT]-led session; [CLIENT LAST NAME 1]-Ruiz.");
});

test("review round 8: only placeholders in brackets are restored; a label in parentheses or without brackets stays as written", () => {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  engine.deidentify("Mateo Ficticio Gómez, DOB 03/14/2020, Lucía Ficticio.");
  for (const [written, expected] of R8_RESTORE) assert.equal(reidentify(written, engine.map).text, expected, written);
  // Bracketed text in a source that reads as a placeholder is sent under a placeholder of its own and comes back as written.
  const form = "Name: [CLIENT]  DOB: [DOB]  Caregiver: [Caregiver 1]  {Date}  [sic]";
  const hidden = engine.deidentify(form);
  assert.equal(hidden.text, "Name: [OTHER 1]  DOB: [OTHER 2]  Caregiver: [OTHER 3]  [OTHER 4]  [sic]");
  assert.equal(reidentify(hidden.text, engine.map).text, form);
});
