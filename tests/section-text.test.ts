import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStructure, countWords, findMarkers, replaceParagraph, splitParagraphs, tidySectionText } from "../src/shared/section-text.ts";

test("paragraphs are split on blank lines, whatever the line endings; single line breaks stay inside a paragraph", () => {
  assert.deepEqual(splitParagraphs("One\r\n\r\nTwo\nstill two\n \n\n\nThree  "), ["One", "Two\nstill two", "Three"]);
  assert.deepEqual(splitParagraphs("  \n\n "), []);
  assert.equal(tidySectionText("\n\nA\n\n\n\nB\n"), "A\n\nB");
});

test("replacing a paragraph keeps every other one exactly; out of range or empty is refused", () => {
  const text = "First, with a [MISSING: x].\n\nSecond.\n\nThird.";
  assert.equal(replaceParagraph(text, 1, "  New second.\n"), "First, with a [MISSING: x].\n\nNew second.\n\nThird.");
  assert.equal(replaceParagraph(text, 2, "Third a.\n\nThird b."), "First, with a [MISSING: x].\n\nSecond.\n\nThird a.\n\nThird b.");
  assert.equal(replaceParagraph(text, 3, "x"), null);
  assert.equal(replaceParagraph(text, -1, "x"), null);
  assert.equal(replaceParagraph(text, 0, "   "), null);
});

test("markers are found with their paragraph, in order", () => {
  const markers = findMarkers("A [MISSING: Socialization score].\n\nB [CHECK:  dates differ ] and [MISSING:x].");
  assert.deepEqual(markers, [
    { kind: "missing", note: "Socialization score", paragraph: 0 },
    { kind: "check", note: "dates differ", paragraph: 1 },
    { kind: "missing", note: "x", paragraph: 1 },
  ]);
  assert.deepEqual(findMarkers("No [brackets] that matter."), []);
});

test("the structure check counts paragraphs and words against the rules, and finds formatting ABA Matrix would not take", () => {
  const shape = { paragraphs: { min: 2, max: 3 }, words: { min: 3, max: 10 } };
  assert.deepEqual(checkStructure("One two.\n\nThree four.", shape), []);
  assert.deepEqual(checkStructure("One.", shape), [
    { kind: "paragraphs", count: 1, min: 2, max: 3 },
    { kind: "words", count: 1, min: 3, max: 10 },
  ]);
  assert.deepEqual(checkStructure("## Heading\n\n- a list item here\n\nSome **bold** text", { paragraphs: null, words: null }), [
    { kind: "formatting", paragraph: 0 },
    { kind: "formatting", paragraph: 1 },
    { kind: "formatting", paragraph: 2 },
  ]);
  assert.deepEqual(checkStructure("Scored 3 - 5 times per hour.", { paragraphs: null, words: null }), [], "a dash inside a sentence is not a list");
  assert.equal(countWords("The 2nd score — 68 (low)."), 5);
});
