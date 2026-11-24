import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonItemScanner, type ClosedItem } from "../src/lib/json-items.ts";

/*
 * The scanner that finds the case map's items as the answer arrives (case map speed,
 * 2026-11-23): each item of a top-level list, and each top-level object, the moment its
 * JSON closes, however the text is cut into pieces.
 */

const ANSWER = JSON.stringify({
  client: { age: { value: "6 years", refs: [], origin: "extracted", check: "" }, medications: [] },
  caregivers: [
    { key: "new-1", role: { value: 'Mother "Ana" {not a brace}', refs: [{ kind: "source", id: "s", quote: "a \\ backslash ] and [ brackets" }], origin: "her", check: "" } },
    { key: "new-2", role: { value: "Grandmother", refs: [], origin: "extracted", check: "" } },
  ],
  settings: [],
  report: [{ kind: "thread-gap", text: "x", sections: ["a", "b"], refs: [] }],
  openItems: [{ kind: "missing", text: "No severity level.", homeSection: 4 }],
});

function scanAll(pieces: string[]): ClosedItem[] {
  const scanner = new JsonItemScanner();
  return pieces.flatMap((piece) => scanner.feed(piece));
}

test("each item closes once, with its exact text, whatever the pieces", () => {
  const whole = scanAll([ANSWER]);
  assert.deepEqual(
    whole.map((item) => [item.list, item.index]),
    [
      ["client", null],
      ["caregivers", 0],
      ["caregivers", 1],
      ["report", 0],
      ["openItems", 0],
    ],
  );
  for (const item of whole) assert.doesNotThrow(() => JSON.parse(item.text), item.text);
  assert.equal(JSON.parse(whole[1].text).role.value, 'Mother "Ana" {not a brace}', "braces and quotes inside strings are text");
  // One character at a time, and in uneven pieces: the same items.
  assert.deepEqual(scanAll([...ANSWER]), whole);
  const pieces: string[] = [];
  for (let at = 0; at < ANSWER.length; at += 7) pieces.push(ANSWER.slice(at, at + 7));
  assert.deepEqual(scanAll(pieces), whole);
});

test("an item is reported as soon as it closes, before the rest arrives", () => {
  const scanner = new JsonItemScanner();
  const cut = ANSWER.indexOf('{"key":"new-2"');
  const before = scanner.feed(ANSWER.slice(0, cut));
  assert.deepEqual(
    before.map((item) => item.list),
    ["client", "caregivers"],
  );
  assert.deepEqual(
    scanner.feed(ANSWER.slice(cut)).map((item) => item.list),
    ["caregivers", "report", "openItems"],
  );
});

test("text before the answer (a code fence, a sentence) is skipped; an answer cut short reports what closed", () => {
  const fenced = scanAll(["Here it is:\n```json\n", ANSWER, "\n```"]);
  assert.equal(fenced.length, 5);
  const cut = scanAll([ANSWER.slice(0, ANSWER.indexOf('"report"'))]);
  assert.deepEqual(
    cut.map((item) => item.list),
    ["client", "caregivers", "caregivers"],
  );
  // Indices count every element of the list, strings and numbers too.
  assert.deepEqual(
    scanAll([JSON.stringify({ behaviors: ["x", 3, { key: "a" }, null, { key: "b" }] })]).map((item) => item.index),
    [2, 4],
  );
});
