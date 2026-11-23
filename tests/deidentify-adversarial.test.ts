import assert from "node:assert/strict";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
import { Deidentifier, reidentify } from "../src/main/deidentify/index.ts";
import { CLINICAL, CLINICAL_ROUND2, PROBES, REIDENTIFY_CASES, REIDENTIFY_SOURCE, RESTORE_EXACT, RESTORE_NAMES, REVIEW_SHEET, REVIEW_TODAY } from "./deidentify-adversarial.ts";

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

test("dates: finding them stays linear on a hostile text (100,000 dates)", () => {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  for (const unit of ["on 05/01/2026 ", "birthday 3/14 ", "14 de marzo de 2020, "]) {
    const start = performance.now();
    engine.deidentify(unit.repeat(100_000));
    const ms = performance.now() - start;
    assert.ok(ms < 15_000, `${JSON.stringify(unit)} x100000: ${Math.round(ms)} ms`);
  }
});
