import assert from "node:assert/strict";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
import { readdirSync, readFileSync } from "node:fs";
import { Deidentifier, reidentify } from "../src/main/deidentify/index.ts";
import { REVIEW_SHEET, REVIEW_TODAY } from "./deidentify-adversarial.ts";

/*
 * Property-style tests: many variants of each value on the (invented) client sheet,
 * generated from a fixed seed, each put in a sentence and de-identified. None may survive.
 * A failure prints the variant, so it can be added to the adversarial battery.
 */

/** A small seeded random generator (mulberry32): the same variants on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = random(20261122);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const at = (word: string) => 1 + Math.floor(rng() * (word.length - 1));

const PLACEHOLDER = /\[[A-Z][A-Z0-9 ]*\]/gu;
/** Letters and digits only, folded: what is left once placeholders are taken out. */
const residue = (text: string) => foldString(text.replace(PLACEHOLDER, " ")).replace(/[^\p{L}\p{N}]/gu, "");

function hide(text: string) {
  const engine = new Deidentifier(REVIEW_SHEET, { today: REVIEW_TODAY });
  const result = engine.deidentify(text);
  return { result, engine };
}

// ---------------------------------------------------------------- names
const NAMES = ["Mateo", "Ficticio", "Gómez", "Lucía", "Andrés", "Valeria", "Daniela", "Muestra"];
const FULLWIDTH = (s: string) => s.replace(/[A-Za-z]/gu, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0));
const INVISIBLES = ["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{00AD}", "\u{FEFF}"];
const ENTITIES: Record<string, string> = { "á": "&aacute;", "é": "&eacute;", "í": "&iacute;", "ó": "&oacute;", "ú": "&uacute;" };

const nameTransforms: Record<string, (w: string) => string> = {
  lower: (w) => w.toLowerCase(),
  upper: (w) => w.toUpperCase(),
  noAccents: (w) => w.normalize("NFD").replace(/\p{M}/gu, ""),
  decomposed: (w) => w.normalize("NFD"),
  hyphen: (w) => {
    const i = at(w);
    return w.slice(0, i) + pick(["-", "- ", "-\n", "\u{00AD}", "-\n  "]) + w.slice(i);
  },
  split: (w) => {
    const i = at(w);
    return w.slice(0, i) + pick([" ", "\n"]) + w.slice(i);
  },
  letterSpaced: (w) => [...w].join(pick([" ", "  "])),
  fullwidth: FULLWIDTH,
  ligature: (w) => w.replace(/fi/gu, "\u{FB01}").replace(/fl/gu, "\u{FB02}"),
  invisible: (w) => {
    const i = at(w);
    return w.slice(0, i) + pick(INVISIBLES) + w.slice(i);
  },
  entity: (w) => w.replace(/[áéíóú]/gu, (c) => ENTITIES[c]),
};
/** One of these at most per variant: they all break the word. */
const BREAKERS = ["hyphen", "split", "letterSpaced"];

function nameVariant(word: string): string {
  const chosen = Object.keys(nameTransforms).filter(() => rng() < 0.3);
  const breakers = chosen.filter((k) => BREAKERS.includes(k));
  // An HTML reference comes from pasted HTML: never together with a word broken by layout or typing.
  const kept = chosen.filter((k) => (!BREAKERS.includes(k) || k === breakers[0]) && !(k === "entity" && breakers.length));
  // Apply the breaking transform last, after case, accents and the rest.
  kept.sort((a, b) => Number(BREAKERS.includes(a)) - Number(BREAKERS.includes(b)));
  let out = word;
  for (const k of kept) out = nameTransforms[k](out);
  if (rng() < 0.2) out += pick(["'s", "s", "\u{2019}s"]);
  return out;
}

function joinedVariant(a: string, b: string): string {
  const plain = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "");
  return pick([
    `${plain(a)}${plain(b)}.pdf`,
    `@${plain(a).toLowerCase()}${plain(b).toLowerCase()}`,
    `#Team${plain(a)}`,
    `${plain(a).toLowerCase()}_${plain(b).toLowerCase()}_notes.docx`,
    `${plain(a)}2026`,
  ]);
}

function ocrVariant(word: string): string {
  const plain = word.normalize("NFD").replace(/\p{M}/gu, "");
  const swaps: Array<[RegExp, string]> = [[/o/u, "0"], [/i/u, "1"], [/l/u, "1"], [/e/u, "c"], [/m/u, "rn"], [/i/u, "l"]];
  const usable = swaps.filter(([re]) => re.test(plain));
  if (usable.length === 0) return plain;
  const [re, to] = pick(usable);
  return plain.replace(re, to);
}

const SENTENCES = ["Notes: {X} attended the session today.", "{X} lives with the family.", "Seen with {X}, per the BCBA.", "Report written for {X}."];

test("generated: sheet names under random hyphenation, splits, spacing, case, accents, Unicode forms, joins and OCR never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  let reported = 0;
  for (let i = 0; i < 2000; i++) {
    const word = pick(NAMES);
    const kind = rng();
    const variant = kind < 0.75 ? nameVariant(word) : kind < 0.88 ? joinedVariant(word, pick(NAMES.filter((n) => n !== word))) : ocrVariant(word);
    const text = pick(SENTENCES).replace("{X}", variant);
    const { result, engine } = hide(text);
    count++;
    const left = residue(result.text);
    const forbidden = [residue(word), residue(variant.replace(/\.(?:pdf|docx)$/u, "").replace(/^[@#]/u, "").replace(/^Team/u, ""))].filter((f) => f.length >= 4);
    if (forbidden.some((f) => left.includes(f))) {
      // Two everyday words ("MATE O"): maybe ordinary text, so left as written and listed for the mandatory review, not hidden.
      if (result.possible.some((p) => p.reason === "split-name" && !p.hidden)) reported++;
      else failures.push(`${JSON.stringify(variant)} -> ${JSON.stringify(result.text)}`);
    }
    const back = reidentify(result.text, engine.map);
    if (back.unrestored.length || PLACEHOLDER.test(back.text)) failures.push(`restore: ${JSON.stringify(result.text)}`);
  }
  t.diagnostic(`${count} name variants, ${reported} left as two everyday words and reported for review, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- the date of birth (2020-03-14)
const MONTHS = ["3", "03", "March", "march", "MARCH", "Mar", "Mar.", "MAR", "marzo", "Marzo", "mar."];
const DAYS = ["14", "14th", "fourteenth", "Fourteenth", "the 14th", "the fourteenth"];
const YEARS = ["2020", "'20"];

function dobVariants(): string[] {
  const out = new Set<string>();
  const spaced = (sep: string) => [sep, ` ${sep} `, `${sep} `];
  for (const sep of ["/", "-", "."]) {
    for (const s of spaced(sep)) {
      for (const m of ["3", "03"]) for (const d of ["14"]) for (const y of ["2020", "20", "'20"]) {
        out.add(`${m}${s}${d}${s}${y}`);
        out.add(`${d}${s}${m}${s}${y}`);
      }
      out.add(`2020${s}03${s}14`);
      out.add(`2020${s}3${s}14`);
      out.add(`14${s}III${s}2020`);
    }
  }
  for (const m of MONTHS.filter((m) => !/^\d/u.test(m))) {
    for (const d of DAYS) for (const y of YEARS) {
      out.add(`${m} ${d}, ${y}`);
      out.add(`${m} ${d} ${y}`);
      out.add(`${m} ${d} , ${y}`);
      out.add(`${d} ${m} ${y}`);
      out.add(`${d} of ${m}, ${y}`);
      out.add(`${d} de ${m} de ${y}`);
      out.add(`${d} de ${m} del año ${y}`);
    }
    out.add(`${m}-14-2020`);
    out.add(`14-${m}-2020`);
    out.add(`14-${m}-20`);
    out.add(`14${m.replace(".", "")}2020`);
    out.add(`14${m.replace(".", "")}20`);
    out.add(`${m} the 14th, 2020`);
    out.add(`el catorce de ${m} de 2020`);
  }
  for (const c of ["031420", "03142020", "14032020"]) out.add(c);
  return [...out];
}

function monthDayVariants(): string[] {
  const out = new Set<string>();
  for (const m of MONTHS.filter((m) => !/^\d/u.test(m))) for (const d of DAYS) {
    out.add(`${m} ${d}`);
    out.add(`${d} of ${m}`);
    out.add(`${d} ${m}`);
  }
  for (const m of ["marzo", "Marzo"]) for (const d of ["14", "catorce"]) out.add(`${d} de ${m}`);
  for (const s of ["3/14", "3-14", "14/3", "03/14", "14/03"]) out.add(s);
  return [...out];
}

test("generated: the date of birth in every combination of month, day, year, order and separator never survives", (t) => {
  const failures: string[] = [];
  const variants = dobVariants();
  for (const variant of variants) {
    for (const template of ["DOB: {X}.", "He was born on {X} in a hospital.", "Fecha de nacimiento: {X}", "Birth date {X}; seen today."]) {
      const text = template.replace("{X}", variant);
      const { result } = hide(text);
      const left = residue(result.text).replace(/2020|20$/gu, "");
      if (result.text.includes(variant) || /14|fourteenth|catorce|march|marzo|mar|iii/u.test(left)) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
    }
  }
  const pairs = monthDayVariants();
  for (const variant of pairs) {
    for (const template of ["His birthday is {X}.", "He turns 7 on {X}.", "Cumple años el {X}.", "Birthday party on {X} every year."]) {
      const text = template.replace("{X}", variant);
      const { result } = hide(text);
      if (result.text.includes(variant) || /14|fourteenth|catorce/u.test(residue(result.text))) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${variants.length * 4} date-of-birth sentences and ${pairs.length * 4} birthday sentences, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- phones, IDs, school, city, address
function phoneVariant(): string {
  const sep = () => pick(["", " ", "-", ".", "/", " - ", "  "]);
  const area = pick(["305", "(305)", "(305) "]);
  return pick([`${pick(["", "+1 ", "1-"])}${area}${sep()}555${sep()}0142`, `555${pick(["-", ".", " "])}0142`]);
}
function idVariant(): string {
  const sep = () => pick(["", " ", "-", ".", " - "]);
  const digits = pick(["123456789", "9876543210"]);
  const spaced = digits.match(/.{1,3}/gu)!.join(sep());
  return pick([`FL${sep()}${spaced}`, `fl${spaced}`, spaced, digits]);
}
function schoolVariant(): string {
  const base = pick(["José Martí Elementary School", "Jose Marti Elementary", "JOSÉ MARTÍ ELEMENTARY", "Martí Elementary", "Marti Elementary School", "JMES", "JME"]);
  if (base.length <= 4) return base;
  const words = base.split(" ");
  const k = Math.floor(rng() * words.length);
  if (words[k].length >= 5 && rng() < 0.5) words[k] = nameTransforms.hyphen(words[k]);
  return words.join(" ");
}
function cityVariant(): string {
  const base = pick(["Miami", "MIAMI", "miami"]);
  return rng() < 0.4 ? nameTransforms.hyphen(base) : base;
}
function addressVariant(): string {
  const number = pick(["4471", ""]);
  const dir = pick(["SW", "S.W.", "Southwest", "sw"]);
  const name = pick(["12th", "12", "Twelfth"]);
  const type = pick(["Terrace", "Terr.", "Ter", "Trce", "terrace"]);
  const unit = pick(["", ", Apt 3", " #3", ", Unit 3"]);
  const tail = pick(["", ", Miami, FL 33135", " Miami FL 33135", ", Miami"]);
  return `${number ? `${number} ` : ""}${dir} ${name} ${type}${number ? unit : ""}${tail}`;
}

test("generated: phones, IDs, the school, the city and the address under random separators and abbreviations never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const checks: Array<[() => string, (left: string) => boolean]> = [
    [phoneVariant, (left) => /5550142/u.test(left)],
    [idVariant, (left) => /123456789|9876543210/u.test(left)],
    [schoolVariant, (left) => /marti|jmes|jme/u.test(left)],
    [cityVariant, (left) => /miami/u.test(left)],
    [addressVariant, (left) => /4471|12thter|twelfth|33135|miami/u.test(left) || /sw12|southwest12/u.test(left)],
  ];
  for (let i = 0; i < 400; i++) {
    for (const [make, leaked] of checks) {
      const variant = make();
      const text = `Contact: ${variant}. Next visit soon.`;
      const { result } = hide(text);
      count++;
      if (leaked(residue(result.text))) failures.push(`${JSON.stringify(variant)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${count} phone, ID, school, city and address variants, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- every separator between every pair of characters
const SEPARATORS = [" ", "  ", "|", " | ", "-", " - ", ".", "/", " / ", "\n", "\u{200B}", "\u{200F}", " \u{2066}", "\t", ":"];
const SEQUENCES: Array<[string, string]> = [
  ["03142020", "date of birth"], ["3142020", "date of birth"], ["14032020", "date of birth"], ["20200314", "date of birth"], ["031420", "date of birth"],
  ["3055550142", "phone"], ["5550142", "phone"], ["FL123456789", "Medicaid ID"], ["123456789", "Medicaid ID"], ["9876543210", "ID"],
  ["33135", "ZIP"], ["4471", "street number"], ["Miami", "city"], ["Marti", "school"],
];

test("generated: each sheet value with any separator between every pair of its characters, uniform or mixed, in prose and in table cells, never survives", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const [value, label] of SEQUENCES) {
    const chars = [...value];
    const layouts: string[] = [];
    for (const sep of SEPARATORS) layouts.push(chars.join(sep));
    for (let k = 0; k < 20; k++) layouts.push(chars.map((c, i) => (i === 0 ? c : pick(SEPARATORS) + c)).join(""));
    for (const written of layouts) {
      for (const template of [`${label}: {X}.`, `${label} | {X} | ok`, `| ${label} | {X} |`]) {
        const text = template.replace("{X}", written);
        const { result } = hide(text);
        count++;
        const left = residue(result.text);
        // Short values (a ZIP, a street number) only when written with one separator throughout or whole: a mixed one is not that value's form.
        const uniform = new Set(written.split(/[\p{L}\p{N}]/u).slice(1, -1)).size <= 1;
        if (value.length <= 5 && !uniform) continue;
        if (left.includes(foldString(value).replace(/[^\p{L}\p{N}]/gu, ""))) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  t.diagnostic(`${count} written forms of ${SEQUENCES.length} sheet values, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- review round 4: every separator, OCR digits, page breaks

/** Every printable ASCII character that is not a letter or a digit, and the other separators text and PDFs carry. */
const ALL_SEPARATORS = [
  ...[...Array(95).keys()].map((k) => String.fromCharCode(32 + k)).filter((c) => !/[A-Za-z0-9]/u.test(c)),
  "  ", " | ", " - ", " / ", " , ", " ; ", "\n", "\r\n", "\t", "\u{00A0}", "\u{2013}", "\u{2014}", "\u{2022}", "\u{00B7}", "\u{3000}", "\u{FF0F}", "\u{200B}", "\u{200F}", "\u{2066}",
];

test("generated: every non-alphanumeric separator between every pair of characters of each sheet value never lets it survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const [value, label] of SEQUENCES) {
    const chars = [...value];
    const layouts = ALL_SEPARATORS.map((sep) => chars.join(sep));
    // Mixed: a different separator between each pair (for the values long enough not to be a score: see the short-value rule).
    if (value.length > 5) for (let k = 0; k < 30; k++) layouts.push(chars.map((c, i) => (i === 0 ? c : pick(ALL_SEPARATORS) + c)).join(""));
    for (const written of layouts) {
      for (const template of [`${label}: {X}.`, `${label} | {X} | ok`, `| ${label} | {X} |`]) {
        const text = template.replace("{X}", written);
        const { result } = hide(text);
        count++;
        if (residue(result.text).includes(foldString(value).replace(/[^\p{L}\p{N}]/gu, ""))) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  t.diagnostic(`${count} written forms of ${SEQUENCES.length} sheet values with ${ALL_SEPARATORS.length} separators, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

/** OCR's usual misreadings of each digit. */
const OCR_LETTERS: Record<string, string[]> = { "0": ["O", "o", "D", "Q"], "1": ["I", "l", "i", "!"], "2": ["Z"], "5": ["S"], "8": ["B"] };
const ocrBack = (s: string) => s.replace(/[OoDQ]/gu, "0").replace(/[Ili!]/gu, "1").replace(/Z/gu, "2").replace(/S/gu, "5").replace(/B/gu, "8");
const NUMBERS: Array<[string, string, string]> = [
  ["03/14/2020", "03142020", "DOB"], ["3/14/2020", "3142020", "DOB"], ["(305) 555-0142", "3055550142", "Phone"], ["305-555-0142", "3055550142", "Phone"],
  ["FL123456789", "123456789", "Medicaid"], ["9876543210", "9876543210", "ID"], ["33135", "33135", "ZIP"],
];

test("generated: sheet numbers with OCR's misread digits (each one, and every 0 and 1 at once) never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const [written, digits, label] of NUMBERS) {
    const forms: string[] = [];
    [...written].forEach((c, i) => {
      for (const letter of OCR_LETTERS[c] ?? []) forms.push(written.slice(0, i) + letter + written.slice(i + 1));
    });
    // Every 0 and 1 at once ("O3/I4/2O2O"), in each of their misreadings.
    for (let k = 0; k < 4; k++) forms.push([...written].map((c) => (c === "0" || c === "1" ? OCR_LETTERS[c][k] : c)).join(""));
    for (const form of forms) {
      const text = `${label}: ${form}. Seen today.`;
      const { result } = hide(text);
      count++;
      const left = ocrBack(result.text.replace(PLACEHOLDER, " ")).replace(/[^0-9]/gu, "");
      if (left.includes(digits)) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${count} OCR-misread sheet numbers, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: a PDF page break at every position inside a sheet value never lets a part of it survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const parts: Array<[string, RegExp]> = [
    ["03/14/2020", /0314|1420|314/u], ["3/14/2020", /314|1420/u], ["(305) 555-0142", /5550142|3055|0142/u], ["FL123456789", /123456789|1234|6789/u], ["9876543210", /98765|43210/u],
  ];
  for (const [value, leak] of parts) {
    for (let i = 1; i < value.length; i++) {
      for (const marker of ["\n\n--- Page 2 of 3 ---\n", "\n--- Page 1 of 12 ---\n\n"]) {
        const text = `Record: ${value.slice(0, i)}${marker}${value.slice(i)} (continued).`;
        const { result, engine } = hide(text);
        count++;
        const left = result.text.replace(PLACEHOLDER, " ").replace(/--- Page \d+ of \d+ ---/gu, " ").replace(/[^0-9]/gu, "");
        if (leak.test(left) || reidentify(result.text, engine.map).unrestored.length) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  t.diagnostic(`${count} page-break splits, ${failures.length} let a part survive`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- review round 4, H1: score tables stay as they are

/** The fixtures' score lines (numbers, no date), and an item-score table of 0, 1 and 2, raw scores and trials. */
const SCORE_LINES: string[] = (() => {
  const dir = new URL("../fixtures/pdf-text/expected/", import.meta.url);
  const lines = readdirSync(dir)
    .flatMap((f) => readFileSync(new URL(f, dir), "utf8").split("\n"))
    .filter((l) => /\d/u.test(l) && !/\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}|birth|dob|phone|\d{5}/iu.test(l));
  // (the generated lines below are added after this filter)
  const local = random(4749);
  // Round 6: sessions by month, norms by age and edition, trials by year, raw-score rows with a norm year, item codes, CPT units.
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  MONTHS.forEach((month, k) => lines.push(`In ${month}, ${(k % 28) + 1} sessions were held; ${((k * 7) % 28) + 1} targets mastered.`));
  for (let a = 1; a <= 12; a++) {
    lines.push(`Norms for ages ${a}-${a + 3}, ${2012 + a} edition`, `Ages ${a}–${a + 11} (${2012 + a} norms)`, `Trials by year: ${a} ${a + 2} ${2012 + a} ${2013 + a}`);
    lines.push(`Raw ${a} | ${a + 5} | ${2012 + a} norm table | ${a + 9}`, `Score table: ${a} | ${a + 13} | ${2011 + a} | norms`, `ABLLS-R item C${a} and G${a + 10}; Grade ${a}, ${a + 13} students, ${2012 + a} cohort`);
    lines.push(`CPT 97153 x ${a} units; 97155 x ${a + 2} units`, `Session ${a}: ${a + 4} trials, ${a + 1} prompts, ${a + 2} independent`);
  }
  // Round 7: two-digit numbers next to a year, ratios after birthday words, birth weights, and what held up.
  for (let year = 2012; year <= 2024; year++) {
    for (const n of ["12", "21", "13"]) lines.push(`Session ${n} — ${year} plan; VB-MAPP ${n} ${year}; Mand ${n} | ${year} update`, `Scored ${n} in ${year}. ${n}/${year} manual.`);
    lines.push(`Mand 3 | Tact 14 | ${year} goal bank`, `Session 3, 14 trials, ${year} plan revision`, `VB-MAPP ${year}: level 3, 14 milestones`, `Percentile 3 | SS 14 | ${year} norms`);
  }
  lines.push(
    "Bday week data: 8/10, 3/14, 9/10, 2/7, 11/5.",
    "On his birthday he scored 8/10 on mands and 3/14 on tacts.",
    "Born premature; Apgar 7/9; birth weight 6 lb 14 oz",
    "3 of 14 targets (2020 curriculum); Item 3.14 (2020 manual)",
    "Probe dates: 3 14, 4 2, 5 6 (all 2026)",
    "Hours: 3, 14 and 20 per week in 2020, 2021 and 2022",
  );
  // Trial data and rates: ratios, never a birthday.
  lines.push("Rates: 3 per hour, 1.5 per minute, 12 of 20 opportunities, 8/10, 9/10, 7/10, 6/10");
  for (let r = 1; r <= 12; r++) lines.push(`Target ${r}: ${r}/10 correct, ${(r % 5) + 1}/5 independent; IOA ${r}/12`, `Accuracy ${r}/${r + 2} on probe`);
  for (let r = 0; r < 40; r++) {
    lines.push(`Item ${r + 1} | ${Array.from({ length: 12 }, () => String(Math.floor(local() * 3))).join(" | ")}`);
    lines.push(`Raw scores | ${Array.from({ length: 8 }, () => String(Math.floor(local() * 31))).join(" | ")}`);
    lines.push(`Trials ${Array.from({ length: 6 }, () => String(Math.floor(local() * 25))).join(" ")} correct`);
    lines.push(`Receptive ${Array.from({ length: 6 }, () => String(Math.floor(local() * 3))).join(" ")}`);
  }
  return [...new Set(lines)];
})();

test("generated: every birth date from 2012 to 2024 (4,749) leaves the fixtures' score lines and an item-score table unchanged", (t) => {
  const text = SCORE_LINES.join("\n");
  const changed: string[] = [];
  let dates = 0;
  let reported = 0;
  for (let day = Date.UTC(2012, 0, 1); day <= Date.UTC(2024, 11, 31); day += 86_400_000) {
    const dob = new Date(day).toISOString().slice(0, 10);
    dates++;
    const result = new Deidentifier({ client: { firstName: "Zorvan", lastName: "Quillfeather", dateOfBirth: dob } }, { today: REVIEW_TODAY }).deidentify(text);
    reported += result.possible.filter((p) => p.reason === "possible-sheet-value").length;
    if (result.text !== text) {
      const outLines = result.text.split("\n");
      SCORE_LINES.forEach((line, i) => {
        if (outLines[i] !== line) changed.push(`${dob}: ${line} -> ${outLines[i]}`);
      });
    }
  }
  t.diagnostic(`${dates} birth dates x ${SCORE_LINES.length} score lines: ${changed.length} lines changed, ${reported} possible sheet values listed for review`);
  assert.deepEqual(changed.slice(0, 20), []);
});

test("generated: every 3-digit house number leaves the score lines unchanged", (t) => {
  const text = SCORE_LINES.join("\n");
  const changed: string[] = [];
  let reported = 0;
  for (let n = 100; n <= 999; n++) {
    // Counts and codes with the house number itself, round 6.
    const own = [`Street-crossing program: ${n} trials.`, `Lives nearby; ${n} correct responses.`, `Casa: ${n} ensayos.`, `ABLLS-R item C${n}. Seen at clinic suite ${n}.`, `CPT 97153 x ${n} units.`];
    const ownResult = new Deidentifier({ client: { firstName: "Zorvan", lastName: "Quillfeather" }, addresses: [`${n} NW 5th St, Miami, FL 33128`] }, { today: REVIEW_TODAY }).deidentify(own.join("\n"));
    if (ownResult.text !== own.join("\n")) changed.push(`${n}: ${ownResult.text}`);
    const result = new Deidentifier({ client: { firstName: "Zorvan", lastName: "Quillfeather" }, addresses: [`${n} NW 5th St, Miami, FL 33128`] }, { today: REVIEW_TODAY }).deidentify(text);
    reported += result.possible.filter((p) => p.reason === "possible-sheet-value").length;
    if (result.text !== text) {
      const outLines = result.text.split("\n");
      SCORE_LINES.forEach((line, i) => {
        if (outLines[i] !== line) changed.push(`${n}: ${line} -> ${outLines[i]}`);
      });
    }
  }
  t.diagnostic(`900 house numbers x (${SCORE_LINES.length} score lines + 5 lines of counts and codes with that number): ${changed.length} lines changed, ${reported} possible sheet values listed for review`);
  assert.deepEqual(changed.slice(0, 20), []);
});

// ---------------------------------------------------------------- review round 5: the date of birth in any layout, birthday words, the house number

const pad2 = (n: number) => String(n).padStart(2, "0");

test("generated: a date of birth with its four-digit year in any row or line, labelled or not, and its short forms by the client's name, never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const local = random(5659);
  const forms4 = (y: number, m: number, d: number) => [`${m} ${d} ${y}`, `${pad2(m)} | ${pad2(d)} | ${y}`, `${y} ${m} ${d}`, `${d} | ${m} | ${y}`, `${pad2(m)}  ${pad2(d)}  ${y}`];
  const rows4 = [(x: string) => `Client: Zed Qux | ${x} | M | 6:8`, (x: string) => `Intake | ${x} | referral`, (x: string) => `${x}`, (x: string) => `Notes ${x} reviewed`, (x: string) => `Date of Birth:\n------------\n${x}`];
  const forms2 = (y: number, m: number, d: number) => [`${m} ${d} ${String(y).slice(2)}`, `${pad2(m)} | ${pad2(d)} | ${String(y).slice(2)}`];
  const rows2 = [(x: string) => `Zed, ${x}, ABA.`, (x: string) => `Zed b. ${x}.`, (x: string) => `Qux | ${x} | M`, (x: string) => `Date of Birth\n\n_____\n${x}`, (x: string) => `born ${x}`];
  for (let k = 0; k < 150; k++) {
    const day = Date.UTC(2012, 0, 1) + Math.floor(local() * 4749) * 86_400_000;
    const date = new Date(day);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const sheet = { client: { firstName: "Zed", lastName: "Qux", dateOfBirth: date.toISOString().slice(0, 10) } };
    const cases = [...forms4(y, m, d).flatMap((x) => rows4.map((row) => [x, row(x)])), ...forms2(y, m, d).flatMap((x) => rows2.map((row) => [x, row(x)]))];
    for (const [written, text] of cases) {
      count++;
      const result = new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(text);
      if (result.text.includes(written)) failures.push(`${sheet.client.dateOfBirth}: ${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${count} dates of birth in rows and lines with or without a label, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: the birthday's month and day after a birthday word, with any separator, in both languages, never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const words = ["Bday", "B-day", "Birthday", "birthday:", "DOB", "Born", "cumple", "Cumpleaños:", "cumple el", "nacido el", "Fecha de nacimiento"];
  const separators = [" ", "  ", " | ", "\t", "|"];
  for (const word of words) {
    for (const sep of separators) {
      for (const [a, b] of [["3", "14"], ["03", "14"], ["14", "3"], ["14", "03"]]) {
        const written = `${a}${sep}${b}`;
        const text = `${word} ${written}`;
        const { result } = hide(text);
        count++;
        if (result.text.includes(written)) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  t.diagnostic(`${count} birthday sentences with a space or a bar, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: the house number written whole after an address word never survives", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const word of ["dirección", "Dirección:", "house number", "House #", "lives at", "lives at #", "Address:", "casa", "vive en el", "street number"]) {
    for (const tail of ["", ".", ", near the park", " | apt 3"]) {
      const text = `${word} 4471${tail}`;
      const { result } = hide(text);
      count++;
      if (/4471/u.test(result.text)) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${count} house numbers after an address word, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: sheet names in every case and without accents come back exactly as written", (t) => {
  const failures: string[] = [];
  let count = 0;
  const forms = (w: string) => [w, w.toLowerCase(), w.toUpperCase(), w.normalize("NFD").replace(/\p{M}/gu, ""), w.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()];
  for (const name of ["Mateo", "Lucía", "Andrés", "Valeria", "Mateo Ficticio Gómez", "Lucía Ficticio", "Valeria Ficticio Gómez", "Ficticio Gómez", "Gómez", "Teo"]) {
    for (const form of forms(name)) {
      const text = `Seen with ${form} today.`;
      const { result, engine } = hide(text);
      count++;
      const back = reidentify(result.text, engine.map).text;
      if (back !== text) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)} -> ${JSON.stringify(back)}`);
    }
  }
  t.diagnostic(`${count} names in another case or without accents, ${failures.length} not restored exactly`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- review round 6: repeated and adjacent dates of birth, spelled and held names, school short forms

test("generated: the date of birth repeated, or next to its own month and day, in every layout, never leaves a fragment and restores exactly", (t) => {
  const failures: string[] = [];
  let count = 0;
  const forms = ["03 14 2020", "3 14 2020", "03 | 14 | 2020", "3/14/2020", "2020 3 14", "03-14-2020", "March 14, 2020"];
  const pairs = ["3 14", "03 | 14", "3/14", "14 3"];
  const joins = [" ", " | ", "  ", ", ", "; ", "\n", " and "];
  for (const a of forms) {
    for (const join of joins) {
      const cases = [`${a}${join}${a}`, ...forms.map((b) => `${a}${join}${b}`), ...pairs.map((p) => `${a}${join}${p}`), ...pairs.map((p) => `${p}${join}${a}`)];
      for (const body of cases) {
        for (const text of [body, `Date of birth | ${body}`, `Child | ${body} | M`]) {
          const { result, engine } = hide(text);
          count++;
          const left = result.text.replace(PLACEHOLDER, " ");
          if (/\b0?3\D{1,3}14\b|\b14\D{1,3}0?3\b|2020/u.test(left) || reidentify(result.text, engine.map).text !== text) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(result.text)}`);
        }
      }
    }
  }
  t.diagnostic(`${count} repeated or adjacent dates of birth, ${failures.length} left a fragment or did not restore exactly`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: sheet names spelled with any mark between their letters, or with a letter held, never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const marks = [".", ". ", "-", "_", "/", " / ", "*", "·", " · ", "•", ":", "|", "~", "+", ","];
  for (const name of ["Mateo", "MATEO", "Lucía", "Lucia", "Ficticio", "Valeria", "Andrés", "Daniela"]) {
    for (const mark of marks) {
      for (const tail of ["", mark.trim()]) {
        const written = [...name].join(mark) + tail;
        const { result } = hide(`He wrote ${written} today.`);
        count++;
        if (residue(result.text).includes(foldString(name))) failures.push(`${JSON.stringify(written)} -> ${JSON.stringify(result.text)}`);
      }
    }
    for (let i = 0; i < name.length; i++) {
      for (const times of [3, 5]) {
        const written = name.slice(0, i) + name[i].repeat(times) + name.slice(i + 1);
        const { result } = hide(`She called ${written}!`);
        count++;
        if (residue(result.text).includes(foldString(written).replace(/[^\p{L}]/gu, ""))) failures.push(`${JSON.stringify(written)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  t.diagnostic(`${count} names spelled letter by letter or with a held letter, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: short forms of the sheet school before a school word never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const head of ["Marti", "Martí", "MARTI", "JM", "J.M.", "J. M.", "Jose Marti", "José Martí"]) {
    for (const word of ["ES", "MS", "HS", "K-8", "K8", "Elem.", "Elementary", "School", "Academy", "Escuela"]) {
      const written = `${head} ${word}`;
      const { result } = hide(`Attends ${written} this year.`);
      count++;
      if (/marti|\bj\.? ?m\b/iu.test(foldString(result.text.replace(PLACEHOLDER, " ")))) failures.push(`${JSON.stringify(written)} -> ${JSON.stringify(result.text)}`);
    }
  }
  t.diagnostic(`${count} school short forms, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

// ---------------------------------------------------------------- review round 7: three-letter names, joined names, line breaks

test("generated: three-letter sheet names spelled with any mark, and every name joined to another of the same person, never survive", (t) => {
  const failures: string[] = [];
  let count = 0;
  const sheet = { client: { firstName: "Ana", lastName: "Paz Gil", nicknames: ["Ani"], dateOfBirth: "2018-09-05" }, caregivers: [{ firstName: "Eva", lastName: "Gil" }, { firstName: "Luz", lastName: "Rey" }] };
  const marks = [" ", "-", ".", "_", "/", " / ", "*", "·", "•", ":", "|", "~", "+", ",", ". "];
  for (const name of ["Ana", "ANA", "ana", "Eva", "Luz", "Paz", "Gil", "Rey", "Ani"]) {
    for (const mark of marks) {
      for (const tail of ["", mark.trim()]) {
        const written = [...name].join(mark) + tail;
        const result = new Deidentifier(sheet, { today: REVIEW_TODAY }).deidentify(`She wrote ${written} today.`);
        count++;
        if (residue(result.text).includes(foldString(name))) failures.push(`${JSON.stringify(written)} -> ${JSON.stringify(result.text)}`);
      }
    }
  }
  const people = [["ana", "paz", "gil", "ani"], ["eva", "gil"], ["luz", "rey"]];
  for (const words of people) {
    for (const a of words) {
      for (const b of words) {
        if (a === b) continue;
        for (const form of [`@${a}${b}`, `www.${a}${b}.com`, `${a}_${b}_cde.pdf`, `${a}${b}@mail.com`, `#${a}${b}`, `${a}.${b}.docx`]) {
          const engine = new Deidentifier(sheet, { today: REVIEW_TODAY });
          const result = engine.deidentify(`See ${form} today.`);
          count++;
          const left = residue(result.text);
          if (left.includes(a + b) || new RegExp(`(?:^|[^a-z])(?:${a}|${b})(?:[^a-z]|$)`, "u").test(result.text.replace(PLACEHOLDER, " ").toLowerCase()) || reidentify(result.text, engine.map).text !== `See ${form} today.`) {
            failures.push(`${JSON.stringify(form)} -> ${JSON.stringify(result.text)}`);
          }
        }
      }
    }
  }
  t.diagnostic(`${count} spelled three-letter names and joined names, ${failures.length} survived`);
  assert.deepEqual(failures.slice(0, 20), []);
});

test("generated: a name or a value broken by a line break at every position restores exactly", (t) => {
  const failures: string[] = [];
  let count = 0;
  for (const value of ["Mateo", "Ficticio", "Lucía", "Mateo Ficticio Gómez", "Valeria", "305-555-0142", "Martí"]) {
    for (let i = 1; i < value.length; i++) {
      for (const brk of ["-\n", "\n", "-\r\n", "- \n"]) {
        if (value[i - 1] === " " || value[i] === " ") continue;
        const text = `Seen with ${value.slice(0, i)}${brk}${value.slice(i)} today.`;
        const { result, engine } = hide(text);
        count++;
        if (reidentify(result.text, engine.map).text !== text) failures.push(`${JSON.stringify(text)} -> ${JSON.stringify(reidentify(result.text, engine.map).text)}`);
      }
    }
  }
  t.diagnostic(`${count} line-broken names and values, ${failures.length} not restored exactly`);
  assert.deepEqual(failures.slice(0, 20), []);
});
