/*
 * deidentify(text, sheet): the text with every value of the client sheet and every
 * identifying pattern replaced by a stable placeholder, the list of what was found,
 * and the map that puts the values back (reidentify.ts). Runs on the clinician's
 * computer only; the map and the findings never leave it.
 *
 * One Deidentifier keeps its placeholders across calls, so every source of one
 * request (the notes, each PDF's text) uses the same [CAREGIVER 1] for the same person.
 *
 * When two findings overlap, the longer wins ("1234 Ficticio Street" is one address);
 * at equal length the sheet wins over a pattern. Any part of the shorter one left
 * outside the longer is hidden too, so nothing is left half-hidden.
 */
import { findDates, parseIsoDate, ymdKey, type YMD } from "./dates.ts";
import { fold, foldString, originalRange, type Folded } from "./fold.ts";
import { findNames, peopleOf, type NameForm, type Person } from "./names.ts";
import { addressKey, findPatterns, phoneKey, type PatternMatch } from "./patterns.ts";
import { birthDatePlaceholder, numberedPlaceholder, personPlaceholder, type BirthDateForm, type NumberedKind } from "./placeholders.ts";
import type { ClientSheet, FoundKind } from "./sheet.ts";

export interface DeidentifyOptions {
  /** Today, for the date rule. */
  today?: Date;
  /**
   * A sheet name that is also an everyday word ("Will", "Rosa"), standing alone:
   * "capitalized" hides it when it starts with a capital and reports a lowercase one
   * as possible; "always" hides it in any case.
   */
  commonWordNames?: "capitalized" | "always";
  /**
   * Full dates other than the date of birth: "older-than-a-year" hides those more than
   * 12 months before today (they could be a birth date), "all" hides every one.
   */
  dates?: "older-than-a-year" | "all";
}

export interface MapEntry {
  placeholder: string;
  /** What the placeholder is restored as. */
  value: string;
  kind: FoundKind;
}

/** What reidentify needs. Stays on the clinician's computer. */
export interface RestoreMap {
  entries: MapEntry[];
}

export interface Finding {
  placeholder: string;
  kind: FoundKind;
  /** "sheet": a value on the client sheet; "pattern": found by its shape. */
  source: "sheet" | "pattern";
  /** How many times it was replaced in this text. */
  count: number;
  /** Each different way it was written, as in the text. */
  originals: string[];
}

/** Something that may be identifying and was left as it is, for the review screen. */
export interface Possible {
  text: string;
  start: number;
  end: number;
  reason: "common-word-name";
  /** The placeholder it would get if she chooses to hide it. */
  placeholder: string;
  kind: FoundKind;
}

export interface DeidentifyResult {
  text: string;
  found: Finding[];
  possible: Possible[];
  map: RestoreMap;
}

interface Candidate {
  start: number;
  end: number;
  key: string;
  kind: FoundKind;
  source: "sheet" | "pattern";
  /** Lower wins at equal length. */
  rank: number;
  /** Assigns the placeholder, once the span is kept: numbers follow the reading order and only kept values enter the map. */
  create: () => void;
  /** Cut from a longer value that another span partly covers. */
  piece?: boolean;
}

interface Slot {
  placeholder: string;
  value: string;
  kind: FoundKind;
}

const SCHOOL_GENERIC = new Set(
  `elementary middle high school academy preparatory prep preschool pre k prek vpk k8 8 center centre charter montessori learning
  early childhood primary senior junior escuela colegio daycare day care institute of the de la el and kindergarten program magnet
  christian catholic community public private international bilingual elem el sr jr`.split(/\s+/u),
);

const ARTICLES = new Set(["of", "the", "de", "la", "el", "and"]);

const ADDRESS_SYNONYMS: Record<string, string[]> = {};
for (const [long, short] of Object.entries({
  street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct", place: "pl", terrace: "ter",
  circle: "cir", highway: "hwy", parkway: "pkwy", trail: "trl", plaza: "plz", square: "sq", apartment: "apt", suite: "ste",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw", florida: "fl",
})) {
  ADDRESS_SYNONYMS[long] = [long, short];
  ADDRESS_SYNONYMS[short] = [long, short];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEPARATOR = "[\\s\\-.,'/#]+";
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

function tokensOf(value: string): string[] {
  return foldString(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Matches the words of a value with any punctuation, spacing or line break between them. */
function phraseRegex(tokens: string[][]): RegExp | null {
  if (tokens.length === 0) return null;
  const body = tokens.map((alternatives) => `(?:${alternatives.map(escape).join("|")})`).join(SEPARATOR);
  return new RegExp(`${B}${body}${E}`, "gu");
}

/** Matches a number or a code with or without its spaces, dashes, dots and brackets: "305 555 0142", "1234-567-890". */
function compactRegex(value: string): RegExp | null {
  const chars = foldString(value).replace(/[^\p{L}\p{N}]/gu, "");
  if (chars.length < 4) return null;
  return new RegExp(`${B}${[...chars].map(escape).join("[\\s\\-.()]{0,2}")}${E}`, "gu");
}

const NAME_FORMS: NameForm[] = ["first", "full", "last", "initials"];

function isPerson(kind: FoundKind): boolean {
  return kind === "client" || kind === "caregiver" || kind === "family" || kind === "professional";
}

function personKey(person: Person, form: NameForm): string {
  return `person:${person.priority}:${form}`;
}

function canonicalDate({ year, month, day }: YMD): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(month)}/${pad(day ?? 1)}/${year}`;
}

export class Deidentifier {
  readonly #sheet: ClientSheet;
  readonly #people: Person[];
  readonly #today: Date;
  readonly #commonWordNames: "capitalized" | "always";
  readonly #dates: "older-than-a-year" | "all";
  readonly #dob: YMD | null;
  /** key -> placeholder, value and kind, once assigned. */
  readonly #slots = new Map<string, Slot>();
  readonly #counters = new Map<NumberedKind, number>();
  /** Keys of the values that come from the sheet. */
  readonly #sheetKeys = new Set<string>();
  readonly #literals: Array<{ regex: RegExp; key: string; kind: FoundKind; capitalizedOnly: boolean }> = [];
  /** Street-line keys of the sheet's addresses, to give a pattern-found address the sheet's number. */
  readonly #sheetAddressKeys: Array<{ key: string; slot: string }> = [];

  constructor(sheet: ClientSheet, options: DeidentifyOptions = {}) {
    this.#sheet = sheet;
    this.#people = peopleOf(sheet);
    this.#today = options.today ?? new Date();
    this.#commonWordNames = options.commonWordNames ?? "capitalized";
    this.#dates = options.dates ?? "older-than-a-year";
    this.#dob = parseIsoDate(sheet.client.dateOfBirth);
    this.#prepareSheetValues();
  }

  #prepareSheetValues(): void {
    const sheet = this.#sheet;
    const reserve = (kind: NumberedKind, key: string, value: string) => {
      const n = (this.#counters.get(kind) ?? 0) + 1;
      this.#counters.set(kind, n);
      this.#slots.set(key, { placeholder: numberedPlaceholder(kind, n), value, kind });
      this.#sheetKeys.add(key);
    };
    (sheet.schools ?? []).forEach((school, i) => {
      const key = `school:sheet:${i}`;
      reserve("school", key, school.trim());
      const tokens = tokensOf(school);
      const full = phraseRegex(tokens.map((t) => [t]));
      if (full) this.#literals.push({ regex: full, key, kind: "school", capitalizedOnly: false });
      const core = tokens.filter((t) => !SCHOOL_GENERIC.has(t));
      // The distinctive words alone ("José Martí"), with any of the generic ones around them ("José Martí Elementary").
      const generic = `(?:${SEPARATOR}(?:${[...SCHOOL_GENERIC].filter((w) => !ARTICLES.has(w)).map(escape).join("|")}))*`;
      const coreBody = core.map(escape).join(SEPARATOR);
      const coreRegex = core.length && core.length < tokens.length ? new RegExp(`${B}${coreBody}${generic}${E}`, "gu") : null;
      if (coreRegex) this.#literals.push({ regex: coreRegex, key, kind: "school", capitalizedOnly: true });
    });
    (sheet.addresses ?? []).forEach((address, i) => {
      const key = `address:sheet:${i}`;
      reserve("address", key, address.trim());
      const alternatives = (value: string) => tokensOf(value).map((t) => ADDRESS_SYNONYMS[t] ?? [t.replace(/^(\d+)(?:st|nd|rd|th)$/u, "$1"), t]);
      for (const part of [address, address.split(",")[0]]) {
        const regex = phraseRegex(alternatives(part));
        if (regex) this.#literals.push({ regex, key, kind: "address", capitalizedOnly: false });
      }
      this.#sheetAddressKeys.push({ key: addressKey(address.split(",")[0]), slot: key });
    });
    (sheet.phones ?? []).forEach((phone) => {
      const key = `phone:${phoneKey(phone)}`;
      if (this.#slots.has(key)) return;
      reserve("phone", key, phone.trim());
      const regex = compactRegex(phoneKey(phone));
      if (regex) this.#literals.push({ regex, key, kind: "phone", capitalizedOnly: false });
    });
    (sheet.emails ?? []).forEach((email) => {
      const key = `email:${email.trim().toLowerCase()}`;
      if (this.#slots.has(key)) return;
      reserve("email", key, email.trim());
      this.#literals.push({ regex: new RegExp(`${B}${escape(foldString(email.trim()))}${E}`, "gu"), key, kind: "email", capitalizedOnly: false });
    });
    (sheet.ids ?? []).forEach((id) => {
      const key = `id:${id.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")}`;
      if (this.#slots.has(key)) return;
      reserve("id", key, id.trim());
      const regex = compactRegex(id);
      if (regex) this.#literals.push({ regex, key, kind: "id", capitalizedOnly: false });
    });
    (sheet.other ?? []).forEach((other, i) => {
      const key = `other:sheet:${i}`;
      reserve("other", key, other.trim());
      const regex = phraseRegex(tokensOf(other).map((t) => [t]));
      if (regex) this.#literals.push({ regex, key, kind: "other", capitalizedOnly: false });
    });
  }

  /** The placeholders assigned so far and what each is restored as. */
  get map(): RestoreMap {
    const seen = new Set<string>();
    const entries: MapEntry[] = [];
    for (const slot of this.#slots.values()) {
      if (seen.has(slot.placeholder)) continue;
      seen.add(slot.placeholder);
      entries.push({ placeholder: slot.placeholder, value: slot.value, kind: slot.kind });
    }
    return { entries };
  }

  #personSlot(person: Person, form: NameForm): void {
    const key = personKey(person, form);
    if (!this.#slots.has(key)) {
      const { firstName, lastName, nicknames, preferredName } = person.sheet;
      const first = (preferredName ?? firstName ?? nicknames?.[0] ?? lastName ?? "").trim();
      const full = [firstName ?? preferredName, lastName].filter(Boolean).join(" ").trim();
      const value = { first, full: full || first, last: (lastName ?? first).trim(), initials: person.initials?.toUpperCase() ?? first }[form];
      this.#slots.set(key, { placeholder: personPlaceholder(person.group, person.index, form), value, kind: person.group });
    }
  }

  #numberedSlot(key: string, kind: NumberedKind, original: string): void {
    if (!this.#slots.has(key)) {
      const n = (this.#counters.get(kind) ?? 0) + 1;
      this.#counters.set(kind, n);
      this.#slots.set(key, { placeholder: numberedPlaceholder(kind, n), value: original, kind });
    }
  }

  #birthSlot(key: string, form: BirthDateForm, original: string): void {
    if (!this.#slots.has(key)) {
      this.#slots.set(key, { placeholder: birthDatePlaceholder(form), value: form === "full" && this.#dob ? canonicalDate(this.#dob) : original, kind: "dob" });
    }
  }

  deidentify(input: string): DeidentifyResult {
    const text = input.normalize("NFC");
    const folded = fold(text);
    const candidates: Candidate[] = [];
    const possible: Possible[] = [];
    const range = (start: number, end: number) => originalRange(folded, start, end);

    for (const match of findNames(folded, this.#people)) {
      const [start, end] = range(match.start, match.end);
      const { person, form } = match;
      if (match.ambiguous && this.#commonWordNames === "capitalized" && !/^\p{Lu}/u.test(text.slice(start, end))) {
        possible.push({ text: text.slice(start, end), start, end, reason: "common-word-name", placeholder: personPlaceholder(person.group, person.index, form), kind: person.group });
        continue;
      }
      candidates.push({ start, end, key: personKey(person, form), kind: person.group, source: "sheet", rank: 0, create: () => this.#personSlot(person, form) });
    }
    for (const literal of this.#literals) {
      for (const m of folded.text.matchAll(literal.regex)) {
        const [start, end] = range(m.index, m.index + m[0].length);
        if (literal.capitalizedOnly && !/^\p{Lu}/u.test(text.slice(start, end))) continue;
        candidates.push({ start, end, key: literal.key, kind: literal.kind, source: "sheet", rank: 1, create: () => {} });
      }
    }
    this.#dateCandidates(text, folded, candidates);
    for (const match of findPatterns(text)) candidates.push(this.#patternCandidate(text, match));

    const accepted = resolve(text, candidates);
    accepted.sort((a, b) => a.start - b.start);

    let out = "";
    let at = 0;
    const found = new Map<string, Finding>();
    for (const span of accepted) {
      const original = text.slice(span.start, span.end);
      if (span.piece) {
        // A piece is restored as itself, under a placeholder of its own.
        const kind: NumberedKind = span.kind === "dob" ? "date" : isPerson(span.kind) ? "unlisted-name" : (span.kind as NumberedKind);
        span.key = `piece:${kind}:${original}`;
        this.#numberedSlot(span.key, kind, original);
      } else {
        span.create();
        // Once a person is mentioned, the model may use any form of their name: all of them restore.
        const person = this.#people.find((p) => span.key.startsWith(`person:${p.priority}:`));
        if (person) for (const form of NAME_FORMS) if (form !== "initials" || person.initials) this.#personSlot(person, form);
      }
      const slot = this.#slots.get(span.key)!;
      out += text.slice(at, span.start) + slot.placeholder;
      at = span.end;
      const finding = found.get(slot.placeholder) ?? { placeholder: slot.placeholder, kind: slot.kind, source: span.source, count: 0, originals: [] };
      finding.count++;
      if (!finding.originals.includes(original)) finding.originals.push(original);
      found.set(slot.placeholder, finding);
    }
    out += text.slice(at);
    const hidden = (p: Possible) => accepted.some((s) => s.start < p.end && p.start < s.end);
    return { text: out, found: [...found.values()], possible: possible.filter((p) => !hidden(p)), map: this.map };
  }

  #dateCandidates(text: string, folded: Folded, candidates: Candidate[]): void {
    const dob = this.#dob;
    const yearAgo = new Date(this.#today);
    yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
    const cutoff = ymdKey({ year: yearAgo.getUTCFullYear(), month: yearAgo.getUTCMonth() + 1, day: yearAgo.getUTCDate() });
    for (const date of findDates(folded, this.#today)) {
      const [start, end] = originalRange(folded, date.start, date.end);
      const original = text.slice(start, end);
      const isBirthDate =
        dob !== null &&
        date.readings.some((r) =>
          date.precision === "full"
            ? r.year === dob.year && r.month === dob.month && r.day === dob.day
            : date.precision === "month-year"
              ? r.year === dob.year && r.month === dob.month
              : r.month === dob.month && r.day === dob.day,
        );
      if (isBirthDate) {
        const key = `dob:${date.precision}`;
        candidates.push({ start, end, key, kind: "dob", source: "sheet", rank: 0, create: () => this.#birthSlot(key, date.precision, original) });
        continue;
      }
      if (date.precision !== "full") continue;
      const hide = this.#dates === "all" || date.readings.some((r) => ymdKey(r) < cutoff);
      if (!hide) continue;
      const key = `date:${ymdKey(date.readings[0])}`;
      candidates.push({ start, end, key, kind: "date", source: "pattern", rank: 2, create: () => this.#numberedSlot(key, "date", original) });
    }
  }

  #patternCandidate(text: string, match: PatternMatch): Candidate {
    const original = text.slice(match.start, match.end);
    let key = match.key;
    if (match.kind === "address") {
      const sheet = this.#sheetAddressKeys.find((a) => a.key && ` ${addressKey(original)} `.includes(` ${a.key} `));
      if (sheet) key = sheet.slot;
    }
    return {
      start: match.start,
      end: match.end,
      key,
      kind: match.kind,
      source: this.#sheetKeys.has(key) ? "sheet" : "pattern",
      rank: 2,
      create: () => this.#numberedSlot(key, match.kind, original),
    };
  }
}

/**
 * Picks the spans to replace: longest first, the sheet before patterns at equal length,
 * never overlapping. The part of a shorter span left outside the longer ones is kept as
 * a span of its own, so a phone number half inside an address is still hidden whole.
 */
function resolve(text: string, candidates: Candidate[]): Candidate[] {
  // Names found only after a label ("Examinee:") come last: the sheet's own reading of a name wins.
  const tier = (c: Candidate) => (c.kind === "unlisted-name" ? 1 : 0);
  const ordered = [...candidates].sort((a, b) => tier(a) - tier(b) || b.end - b.start - (a.end - a.start) || a.rank - b.rank || a.start - b.start);
  const accepted: Candidate[] = [];
  const queue = [...ordered];
  while (queue.length) {
    const candidate = queue.shift()!;
    if (candidate.end <= candidate.start) continue;
    const overlaps = accepted.filter((s) => s.start < candidate.end && candidate.start < s.end);
    if (overlaps.length === 0) {
      accepted.push(candidate);
      continue;
    }
    // Keep only the uncovered pieces that still hold a letter or a digit.
    let pieces: Array<[number, number]> = [[candidate.start, candidate.end]];
    for (const s of overlaps) {
      pieces = pieces.flatMap(([a, b]) => [
        [a, Math.min(b, s.start)],
        [Math.max(a, s.end), b],
      ]).filter(([a, b]) => b > a) as Array<[number, number]>;
    }
    for (const [a, b] of pieces) {
      const piece = text.slice(a, b);
      const lead = piece.length - piece.replace(/^[^\p{L}\p{N}]+/u, "").length;
      const trail = piece.length - piece.replace(/[^\p{L}\p{N}]+$/u, "").length;
      if (a + lead < b - trail) accepted.push({ ...candidate, start: a + lead, end: b - trail, piece: true });
    }
  }
  return accepted.filter((s) => s.end > s.start);
}

/** De-identifies one text. For several texts of one request, use one Deidentifier. */
export function deidentify(text: string, sheet: ClientSheet, options?: DeidentifyOptions): DeidentifyResult {
  return new Deidentifier(sheet, options).deidentify(text);
}

