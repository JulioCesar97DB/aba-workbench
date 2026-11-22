import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Deidentifier, type ClientSheet } from "../src/main/deidentify/index.ts";
import { extractPdfText } from "../src/main/pdf-text/extract.ts";
import { pdfjsReader } from "../src/main/pdf-text/pdfjs-reader.ts";

/*
 * The real reader (PDF.js) on the invented fixture PDFs: the score reports rendered from
 * fixtures/cases/<case>/reports/*.html and the extraction fixtures in fixtures/pdf-text/
 * (scripts/render-fixture-pdfs.mts). Expected texts are in fixtures/pdf-text/expected/.
 */
const fixtures = path.join(import.meta.dirname, "..", "fixtures");
const pdf = (file: string) => new Uint8Array(readFileSync(path.join(fixtures, file)));
const expected = (file: string) => readFileSync(path.join(fixtures, "pdf-text", "expected", file), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");

const GOLDEN: Array<[string, string, number]> = [
  ["cases/case-a-mateo/vineland-3.pdf", "case-a-mateo-vineland-3.txt", 2],
  ["cases/case-a-mateo/basc-3-prq.pdf", "case-a-mateo-basc-3-prq.txt", 1],
  ["cases/case-b-sofia/vineland-3.pdf", "case-b-sofia-vineland-3.txt", 2],
  ["cases/case-b-sofia/basc-3-prq.pdf", "case-b-sofia-basc-3-prq.txt", 1],
  ["pdf-text/layout-check.pdf", "layout-check.txt", 2],
];

for (const [file, text, pages] of GOLDEN) {
  test(`PDF fixture: ${file} gives its expected text`, async () => {
    const result = await extractPdfText(pdf(file), pdfjsReader);
    assert.equal(result.status, "text");
    if (result.status !== "text") return;
    assert.equal(result.pageCount, pages);
    assert.deepEqual(result.pagesWithoutText, []);
    assert.equal(result.text, expected(text));
  });
}

test("PDF fixture: score tables keep a score's name, standard score and percentile on one line", async () => {
  const result = await extractPdfText(pdf("cases/case-a-mateo/vineland-3.pdf"), pdfjsReader);
  assert.equal(result.status, "text");
  const text = result.status === "text" ? result.text : "";
  for (const row of [
    "Domain | Sum of v-scale scores | Standard score | 90% confidence interval | Percentile rank | Adaptive level",
    "Communication | 23 | 62 | 57–67 | 1 | Low",
    "Socialization | 21 | 64 | 59–69 | — | Low",
    "Adaptive Behavior Composite | 93 | 66 | 62–70 | 1 | Low",
    "Socialization | Interpersonal Relationships | 21 | 7 | 1:5 | Low",
  ]) {
    assert.ok(text.split("\n").includes(row), row);
  }
  const layout = await extractPdfText(pdf("pdf-text/layout-check.pdf"), pdfjsReader);
  const lines = layout.status === "text" ? layout.text.split("\n") : [];
  assert.ok(lines.includes("Area of adaptive functioning assessed | Standard score | Percentile | Descriptor"));
  assert.ok(lines.includes("Daily living skills at home and in the community | 68 | 2 | Low"));
});

test("PDF fixture: a scan has no text, a scanned page in a mixed PDF is marked and listed", async () => {
  assert.deepEqual(await extractPdfText(pdf("pdf-text/scan.pdf"), pdfjsReader), { status: "no-text", pageCount: 1 });
  const mixed = await extractPdfText(pdf("pdf-text/mixed.pdf"), pdfjsReader);
  assert.deepEqual(mixed, { status: "text", pageCount: 2, pagesWithoutText: [2], text: expected("mixed.txt") });
});

/** A minimal PDF with the objects given, its cross-reference table computed. */
function buildPdf(objects: string[], trailer: string): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("PDF fixture: a password, a damaged file and a file that is not a PDF say so", async () => {
  const hex = (byte: string) => `<${byte.repeat(32)}>`;
  const locked = buildPdf(
    ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>", `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O ${hex("11")} /U ${hex("22")} >>`],
    `/Encrypt 3 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]`,
  );
  assert.deepEqual(await extractPdfText(locked, pdfjsReader), { status: "unreadable", reason: "password" });
  const truncated = pdf("cases/case-a-mateo/vineland-3.pdf").subarray(0, 3000);
  assert.deepEqual(await extractPdfText(truncated, pdfjsReader), { status: "unreadable", reason: "damaged" });
  assert.deepEqual(await extractPdfText(pdf("pdf-text/layout-check.html"), pdfjsReader), { status: "unreadable", reason: "not-a-pdf" });
  // A valid PDF with no pages.
  const empty = buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"], "");
  assert.deepEqual(await extractPdfText(empty, pdfjsReader), { status: "no-text", pageCount: 0 });
});

test("PDF fixture: the extracted text de-identifies like any text, scores intact", async () => {
  const sheets: Array<[string, ClientSheet, string[]]> = [
    [
      "cases/case-a-mateo/vineland-3.pdf",
      { client: { firstName: "Mateo", lastName: "Ficticio", dateOfBirth: "2022-08-03" }, caregivers: [{ firstName: "Lucía", lastName: "Ficticio" }] },
      ["Mateo", "Ficticio", "Lucía", "Daniela", "Muestra", "08/03/2022"],
    ],
    [
      "cases/case-b-sofia/basc-3-prq.pdf",
      { client: { firstName: "Sofía", lastName: "Inventada", dateOfBirth: "2017-05-09" } },
      ["Sofía", "Inventada", "Carmen", "Daniela", "Muestra"],
    ],
    [
      "pdf-text/layout-check.pdf",
      { client: { firstName: "Bruno", lastName: "Desconocido Prueba", dateOfBirth: "2019-11-30" }, caregivers: [{ firstName: "Inés", lastName: "Prueba-Salcedo" }] },
      ["Bruno", "Desconocido", "Prueba", "Inés", "Salcedo", "11/30/2019"],
    ],
  ];
  for (const [file, sheet, hidden] of sheets) {
    const result = await extractPdfText(pdf(file), pdfjsReader);
    assert.equal(result.status, "text");
    const text = new Deidentifier(sheet, { today: new Date("2026-11-22T12:00:00Z") }).deidentify(result.status === "text" ? result.text : "").text;
    for (const value of hidden) assert.ok(!text.includes(value), `${file}: ${value}`);
    assert.ok(/--- Page 1 of \d ---/.test(text), file);
  }
  const vineland = await extractPdfText(pdf("cases/case-a-mateo/vineland-3.pdf"), pdfjsReader);
  const hiddenVineland = new Deidentifier(sheets[0][1], { today: new Date("2026-11-22T12:00:00Z") }).deidentify(vineland.status === "text" ? vineland.text : "").text;
  for (const line of ["Examinee | [CLIENT FULL NAME]", "Date of birth | [DOB]", "Respondent | [CAREGIVER 1 FULL NAME] (mother)", "Interviewer | [NAME 1], M.S., BCBA", "Interview date | 10/02/2026", "Communication | 23 | 62 | 57–67 | 1 | Low"]) {
    assert.ok(hiddenVineland.split("\n").includes(line), line);
  }
});
