/*
 * Builds the hostile and awkward PDFs of the adversarial review (2026-11-22) at test
 * time, so no large file is committed: zip bombs, a letter-spaced page, a page loop,
 * a form that draws itself, deep nesting, thousands of declared pages. Invented text only.
 */
import { deflateSync } from "node:zlib";

type Body = string | Buffer;

export function pdf(objects: Body[], trailer = ""): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\nendobj\n")]);
    offsets.push(length);
    length += part.length;
    parts.push(part);
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

function stream(dict: string, data: Buffer, compress: boolean): Buffer {
  const bytes = compress ? deflateSync(data, { level: 9 }) : data;
  return Buffer.concat([Buffer.from(`<< ${dict}${compress ? " /Filter /FlateDecode" : ""} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from("\nendstream")]);
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

export function onePage(content: Buffer | string, compress = false): Uint8Array {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", Buffer.isBuffer(content) ? content : Buffer.from(content), compress),
    FONT,
  ]);
}

/** A deflated page of `megabytes` of "draw an A" operators: a few hundred KB that expand to millions of text items. */
export function textBomb(megabytes: number): Uint8Array {
  const op = Buffer.from("BT /F1 1 Tf 10 10 Td (A) Tj ET\n");
  const count = Math.floor((megabytes * 1024 * 1024) / op.length);
  const data = Buffer.alloc(count * op.length);
  for (let i = 0; i < count; i++) op.copy(data, i * op.length);
  return onePage(data, true);
}

/** A deflated page of `megabytes` of spaces. */
export function whitespaceBomb(megabytes: number): Uint8Array {
  return onePage(Buffer.alloc(megabytes * 1024 * 1024, 0x20), true);
}

/** Names drawn one glyph at a time, with character spacing, split across pieces, and with kerning. */
export function spacedNames(): Uint8Array {
  return onePage(
    "BT /F1 12 Tf 72 700 Td (Examinee) Tj ET\n" +
      [..."Mateo Ficticio"].map((ch, i) => `BT /F1 12 Tf ${200 + i * 12} 700 Td (${ch}) Tj ET`).join("\n") +
      "\n" +
      "BT /F1 12 Tf 72 650 Td 6 Tc (Lucia Ficticio is the mother of the child.) Tj ET\n" +
      "BT /F1 12 Tf 72 600 Td (Client: Ma) Tj ET BT /F1 12 Tf 140 600 Td (teo Ficti) Tj ET BT /F1 12 Tf 196 600 Td (cio) Tj ET\n" +
      "BT /F1 12 Tf 72 550 Td (Name: Mateo) Tj ET BT /F1 12 Tf 300 550 Td (Ficticio) Tj ET\n" +
      "BT /F1 12 Tf 72 500 Td [(Ma) -200 (teo) -300 (Fic) -150 (ticio)] TJ ET\n" +
      "BT /F1 12 Tf 72 450 Td (Born 3/14/2020 and seen at 4471 SW 12th Terrace) Tj ET\n",
  );
}

/** `count` pages declared, all sharing one small content stream. */
export function manyPages(count: number): Uint8Array {
  const objects: Body[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", stream("", Buffer.from("BT /F1 12 Tf 72 700 Td (Hello page text here ok) Tj ET"), false), FONT];
  const kids: string[] = [];
  for (let i = 0; i < count; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>");
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  return pdf(objects);
}

export function deepNesting(depth: number): Uint8Array {
  return onePage("[".repeat(depth) + "]".repeat(depth) + " BT /F1 12 Tf 72 700 Td (Some text on this page here) Tj ET");
}

export function selfDrawingForm(): Uint8Array {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /X 6 0 R >> >> /Contents 4 0 R >>",
    stream("", Buffer.from("BT /F1 12 Tf 72 700 Td (Some text on this page here) Tj ET /X Do"), false),
    FONT,
    stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X 6 0 R >> /Font << /F1 5 0 R >> >>", Buffer.from("BT /F1 12 Tf (loop) Tj ET /X Do"), false),
  ]);
}

export function pagesLoop(): Uint8Array {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    stream("", Buffer.from("BT /F1 12 Tf 72 700 Td (Some text on this page here) Tj ET"), false),
  ]);
}

/** A paragraph hyphenated the way a word processor does, the hyphen at the end of a line: "Lucia Fic-" then "ticio". */
export function hyphenatedParagraph(): Uint8Array {
  const lines = [
    "The client lives at home with his mother, Lucia Fic-",
    "ticio, who works nights. His sister, Valeria Ficticio Go-",
    "mez, attends the same school, Jose Marti Ele-",
    "mentary, near their home in Mia-",
    "mi. He was born on Mar-",
    "ch 14, 2020, and is now six years old.",
  ];
  return onePage(lines.map((line, i) => `BT /F1 11 Tf 72 ${700 - i * 13} Td (${line}) Tj ET`).join("\n"));
}
