import assert from "node:assert/strict";
import { test } from "node:test";
import { foldString } from "../src/main/deidentify/fold.ts";
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
  for (let i = 0; i < 2000; i++) {
    const word = pick(NAMES);
    const kind = rng();
    const variant = kind < 0.75 ? nameVariant(word) : kind < 0.88 ? joinedVariant(word, pick(NAMES.filter((n) => n !== word))) : ocrVariant(word);
    const text = pick(SENTENCES).replace("{X}", variant);
    const { result, engine } = hide(text);
    count++;
    const left = residue(result.text);
    const forbidden = [residue(word), residue(variant.replace(/\.(?:pdf|docx)$/u, "").replace(/^[@#]/u, "").replace(/^Team/u, ""))].filter((f) => f.length >= 4);
    if (forbidden.some((f) => left.includes(f))) failures.push(`${JSON.stringify(variant)} -> ${JSON.stringify(result.text)}`);
    const back = reidentify(result.text, engine.map);
    if (back.unrestored.length || PLACEHOLDER.test(back.text)) failures.push(`restore: ${JSON.stringify(result.text)}`);
  }
  t.diagnostic(`${count} name variants, ${failures.length} survived`);
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
    for (const template of ["His birthday is {X}.", "He turns 7 on {X}.", "Cumple años el {X}.", "Party on {X} every year."]) {
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
