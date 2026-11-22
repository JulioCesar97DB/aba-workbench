import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPdfText, NO_TEXT_NOTE, PdfReadError, type PdfReader } from "../src/main/pdf-text/extract.ts";
import { pageText, type TextPiece } from "../src/main/pdf-text/layout.ts";

// Invented values only.

/** A piece of text at x, baseline y, 10.5 points high, about 5.5 points per character. */
function at(str: string, x: number, y: number, height = 10.5): TextPiece {
  return { str, x, y, width: str.length * 5.5, height };
}

test("layout: a table row stays on one line when a cell wraps, cells joined by |", () => {
  const pieces = [
    at("Domain", 58, 530), at("Standard score", 200, 530), at("Percentile rank", 300, 536), at("rank note", 300, 524),
    at("Communication", 58, 505), at("62", 200, 505), at("1", 300, 505),
    // A wrapped first cell with the other cells centred between its lines.
    at("Adaptive Behavior", 58, 486), at("Composite", 58, 474), at("66", 200, 480), at("1", 300, 480),
    // A three-line cell: the other cells sit on its middle line.
    at("Maladaptive", 58, 455), at("Behavior", 58, 443), at("Index", 58, 431), at("20", 200, 443), at("Elevated", 300, 443),
  ];
  assert.equal(
    pageText(pieces),
    ["Domain | Standard score | Percentile rank rank note", "Communication | 62 | 1", "Adaptive Behavior Composite | 66 | 1", "Maladaptive Behavior Index | 20 | Elevated"].join("\n"),
  );
});

test("layout: label and value pairs, paragraphs joined, blocks separated, reading order top to bottom", () => {
  const pieces = [
    at("Examinee", 53, 700), at(" ", 102, 700), at("Pablo Desconocido", 305, 700),
    at("Respondent", 53, 685), at("Marta Inexistente (mother)", 305, 685),
    // Pieces given out of order still read top to bottom, left to right.
    at("line of a note that wraps", 53, 600), at("The first", 53, 612), at("onto a third one.", 53, 588),
    at("Score", 53, 540, 9), at("note", 85, 540, 9),
  ];
  assert.equal(pageText(pieces), "Examinee | Pablo Desconocido\nRespondent | Marta Inexistente (mother)\n\nThe first line of a note that wraps onto a third one.\n\nScore note");
});

test("layout: ligatures and odd spacing are normalized", () => {
  assert.equal(pageText([at("ﬁne motor", 53, 700), at("  skills  ", 103, 700)]), "fine motor skills");
});

function fakeReader(pages: TextPiece[][], options: { fail?: PdfReadError | Error; delayMs?: number } = {}): PdfReader & { closed: number } {
  const reader = {
    closed: 0,
    async open() {
      if (options.fail) throw options.fail;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return {
        pageCount: pages.length,
        page: async (n: number) => pages[n - 1],
        close: async () => {
          reader.closed++;
        },
      };
    },
  };
  return reader;
}

const PDF = new TextEncoder().encode("%PDF-1.7 invented");
const textPage = [at("Communication standard score 62, percentile 1.", 53, 700)];

test("extract: pages marked, a page without text marked and listed", async () => {
  const reader = fakeReader([textPage, [], [at("12", 300, 40)]]);
  const result = await extractPdfText(PDF, reader);
  assert.deepEqual(result, {
    status: "text",
    pageCount: 3,
    pagesWithoutText: [2, 3],
    text: `--- Page 1 of 3 ---\nCommunication standard score 62, percentile 1.\n\n--- Page 2 of 3 ---\n${NO_TEXT_NOTE}\n\n--- Page 3 of 3 ---\n${NO_TEXT_NOTE}`,
  });
  assert.equal(reader.closed, 1);
});

test("extract: a scan (no page with text) and a page of unreadable glyphs", async () => {
  assert.deepEqual(await extractPdfText(PDF, fakeReader([[], [at("Page 2", 300, 40)]])), { status: "no-text", pageCount: 2 });
  const garbled = [at("\u{E001}\u{E002}\u{E003}\u{E004} \u{E005}\u{E006}\u{E007}\u{E008}\u{E009} \u{E00A}\u{E00B}\u{E00C}\u{E00D}\u{E00E}\u{E00F}\u{E010}\u{E011}\u{E012}\u{E013}\u{E014}\u{E015} ab12", 53, 700)];
  assert.deepEqual(await extractPdfText(PDF, fakeReader([garbled])), { status: "no-text", pageCount: 1 });
});

test("extract: unreadable files say why", async () => {
  assert.deepEqual(await extractPdfText(new TextEncoder().encode("PK zip file"), fakeReader([textPage])), { status: "unreadable", reason: "not-a-pdf" });
  assert.deepEqual(await extractPdfText(PDF, fakeReader([], { fail: new PdfReadError("password") })), { status: "unreadable", reason: "password" });
  assert.deepEqual(await extractPdfText(PDF, fakeReader([], { fail: new Error("bad xref") })), { status: "unreadable", reason: "damaged" });
  const many = fakeReader([textPage, textPage, textPage]);
  assert.deepEqual(await extractPdfText(PDF, many, { maxPages: 2, timeoutMs: 1000 }), { status: "unreadable", reason: "too-many-pages" });
  assert.equal(many.closed, 1);
  assert.deepEqual(await extractPdfText(PDF, fakeReader([textPage], { delayMs: 200 }), { maxPages: 10, timeoutMs: 20 }), { status: "unreadable", reason: "timed-out" });
});
