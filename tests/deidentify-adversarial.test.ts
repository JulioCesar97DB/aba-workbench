import assert from "node:assert/strict";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
import { Deidentifier, reidentify } from "../src/main/deidentify/index.ts";
import { CLINICAL, PROBES, REIDENTIFY_CASES, REIDENTIFY_SOURCE, REVIEW_SHEET, REVIEW_TODAY } from "./deidentify-adversarial.ts";

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
  for (const text of CLINICAL) {
    const result = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY }).deidentify(text);
    if (result.text !== text) lost.push(`clinical: ${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
  }
  t.diagnostic(`${PROBES.length} probes, ${strings} identifying strings, ${leaks.length} slipped through; ${CLINICAL.length} clinical lines, ${lost.length} changed`);
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
