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
 *
 * The days part of an age ("6;8;8") is dropped, not replaced: with a test date it would
 * give the date of birth (owner's decision, 2026-11-22). It is listed in `dropped`.
 */
import { isCommonWordName } from "./common-words.ts";
import { findDates, parseIsoDate, ymdKey, type YMD } from "./dates.ts";
import { fold, foldString, originalRange, type Folded } from "./fold.ts";
import { findJoinedNames, findNames, findSpacedNames, peopleOf, type NameForm, type Person } from "./names.ts";
import { ADDRESS_WORDS, addressKey, findAgeDays, findPatterns, phoneKey, type PatternMatch } from "./patterns.ts";
import { birthDatePlaceholder, numberedPlaceholder, personPlaceholder, type BirthDateForm, type NumberedKind } from "./placeholders.ts";
import type { ClientSheet, FoundKind } from "./sheet.ts";
import { Spans } from "./spans.ts";

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

/**
 * Something for the review screen to show:
 * - left as it is but may identify: a sheet name that is also a common word, in lowercase
 *   ("common-word-name"); a sheet name inside a longer word ("name-inside-word", "Luciana");
 *   a distinctive word of the school alone ("school-word", "Martí"); a word that could be
 *   a shortened sheet name ("possible-nickname", "Vale" for Valeria);
 * - hidden, but she should check who it is: a name two people on the sheet share
 *   ("shared-name"), sent as [NAME n] and restored as written.
 */
export interface Possible {
  text: string;
  start: number;
  end: number;
  reason: "common-word-name" | "name-inside-word" | "school-word" | "possible-nickname" | "shared-name";
  /** The placeholder it has (hidden) or would get if she chooses to hide it. */
  placeholder: string;
  kind: FoundKind;
  hidden: boolean;
}

/** Removed from what is sent, with no placeholder: the days part of an age. */
export interface Dropped {
  text: string;
  start: number;
  end: number;
  reason: "age-days";
}

export interface DeidentifyResult {
  text: string;
  found: Finding[];
  possible: Possible[];
  dropped: Dropped[];
  map: RestoreMap;
}

/** The longest text one call accepts: far beyond any case's sources (a PDF is cut at 2M characters). */
export const MAX_TEXT_LENGTH = 5_000_000;

interface Candidate {
  start: number;
  end: number;
  key: string;
  kind: FoundKind;
  source: "sheet" | "pattern";
  /** Lower wins at equal length. */
  rank: number;
  /** For a surname alone: which of the sheet's surname words it used. */
  surnameWords?: string;
  /** Assigns the placeholder, once the span is kept: numbers follow the reading order and only kept values enter the map. */
  create: () => void;
  /** Cut from a longer value that another span partly covers. */
  piece?: boolean;
  /** Removed, not replaced (the days part of an age). */
  drop?: boolean;
  /** A name that several people on the sheet share. */
  sharedWith?: Person[];
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

/** Every way of writing each canonical street word ("ter": terrace, terr, trce, ter). */
const ADDRESS_SPELLINGS = new Map<string, Set<string>>();
for (const [word, canonical] of Object.entries(ADDRESS_WORDS)) {
  if (!ADDRESS_SPELLINGS.has(canonical)) ADDRESS_SPELLINGS.set(canonical, new Set([canonical]));
  ADDRESS_SPELLINGS.get(canonical)!.add(word);
}
const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
const STREET_TYPES = new Set(["st", "ave", "rd", "blvd", "dr", "ln", "ct", "pl", "ter", "cir", "hwy", "pkwy", "trl", "plz", "sq", "way", "loop", "path", "row", "pike", "cl", "camino"]);
const TYPE_FIRST = new Set(["cl", "ave", "camino", "carrera", "paseo"]);
const UNIT_WORD = "(?:apt|apartment|apto|apartamento|unit|suite|ste|no|#)\\.?";
/** City names that are also ordinary words: hidden only when capitalized. */
const COMMON_PLACE_WORDS = new Set(["sunrise", "plantation", "homestead", "sweetwater", "weston", "davie", "bay", "beach", "lakes", "gardens", "springs", "point", "park", "city", "village", "island", "key", "keys", "palm", "palms", "lake", "west", "north", "south", "east", "coral", "pines", "hollywood", "victoria", "paradise"]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEPARATOR = "[\\s\\-.,'/#]+";
/** Between the words of the sheet's address: also nothing ("4471SW12th", from PDF text with lost spaces). */
const ADDRESS_SEPARATOR = "[\\s\\-.,'/#]*";
/** Before the house number: no digit (a letter may touch it: "at4471"). */
const NUMBER_START = "(?<![\\p{N}])";
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

/** Matches a number or a code with or without spaces, dashes, dots, slashes or brackets: "305 555 0142", "FL 123 - 456 - 789". */
function compactRegex(value: string): RegExp | null {
  const chars = foldString(value).replace(/[^\p{L}\p{N}]/gu, "");
  if (chars.length < 4) return null;
  return new RegExp(`${B}${[...chars].map(escape).join("[\\s\\-.()/]{0,4}")}${E}`, "gu");
}

function canonicalAddressWord(word: string): string {
  return ADDRESS_WORDS[word] ?? word.replace(/^(\d+)(?:st|nd|rd|th)$/u, "$1");
}

/** A regex fragment for every way of writing one canonical street word, on folded text. */
function streetWord(canonical: string): string {
  if (/^\d+$/u.test(canonical)) {
    const words = Object.entries(ADDRESS_WORDS).filter(([, c]) => c === canonical).map(([w]) => w);
    return `(?:${[`${canonical}(?:st|nd|rd|th)?`, ...words].join("|")})`;
  }
  if (DIRECTIONS.has(canonical)) {
    const words = Object.entries(ADDRESS_WORDS).filter(([, c]) => c === canonical).map(([w]) => w);
    return `(?:${[...words, [...canonical].join("\\.?\\s?") + "\\.?"].join("|")})`;
  }
  return `(?:${[...(ADDRESS_SPELLINGS.get(canonical) ?? [canonical])].map(escape).join("|")})`;
}

interface SheetAddress {
  /** Number and street-name words, canonical: what a pattern-found address must contain to be this one. */
  core: string[];
  regexes: RegExp[];
  places: string[];
}

/** Reads a sheet address: "4471 SW 12th Terrace, Apt 3, Miami, FL 33135". */
function parseAddress(address: string): SheetAddress {
  const segments = address.split(",").map((s) => s.trim()).filter(Boolean);
  const places: string[] = [];
  let unit: string[] = [];
  let state = "";
  let zip = "";
  let streetTokens: string[] = [];
  segments.forEach((segment, i) => {
    const tokens = tokensOf(segment);
    if (i === 0 && tokens.some((t) => /\d/u.test(t))) {
      streetTokens = tokens.map(canonicalAddressWord);
      return;
    }
    if (/^(?:apt|apartment|apto|apartamento|unit|suite|ste|#)/iu.test(segment)) {
      unit = tokens.slice(1);
      return;
    }
    // "FL 33135", "Miami FL 33135", "Florida": the state and the ZIP code come off the end.
    const last = tokens.at(-1);
    if (last && /^\d{5}$/u.test(last)) zip = tokens.pop()!;
    if (tokens.length && /^(?:[a-z]{2}|florida|georgia|texas)$/u.test(tokens.at(-1)!) && (zip || tokens.length === 1 || i === segments.length - 1)) state = tokens.pop()!;
    if (tokens.length) places.push(segment.replace(/\s+(?:[A-Z]{2}|Florida|Georgia|Texas)?\s*\d{5}(?:-\d{4})?$/u, "").replace(/\s+(?:[A-Z]{2}|Florida)$/u, "").trim());
  });
  const rest = [...streetTokens];
  const number = rest[0] && /^\d+[a-z]?$/u.test(rest[0]) ? rest.shift()! : "";
  const dir = rest[0] && DIRECTIONS.has(rest[0]) ? rest.shift()! : "";
  let typeFirst = "";
  let type = "";
  if (rest.length > 1 && TYPE_FIRST.has(rest[0])) typeFirst = rest.shift()!;
  else if (rest.length > 1 && STREET_TYPES.has(rest.at(-1)!)) type = rest.pop()!;
  const name = rest;
  const regexes: RegExp[] = [];
  if (name.length) {
    const nameBody = name.map(streetWord).join(SEPARATOR);
    const dirPart = dir ? `(?:${streetWord(dir)}${ADDRESS_SEPARATOR})?` : "";
    const tail = [
      unit.length ? `(?:${ADDRESS_SEPARATOR}${UNIT_WORD}[\\s#]*${unit.map(escape).join(SEPARATOR)})?` : "",
      ...places.map((p) => `(?:${ADDRESS_SEPARATOR}${tokensOf(p).map(escape).join(SEPARATOR)})?`),
      state ? `(?:${ADDRESS_SEPARATOR}(?:${escape(state)}|${state === "fl" ? "florida" : escape(state)}))?` : "",
      zip ? `(?:${ADDRESS_SEPARATOR}${escape(zip)}(?:-\\d{4})?)?` : "",
    ].join("");
    if (typeFirst) {
      const body = `${streetWord(typeFirst)}${ADDRESS_SEPARATOR}${nameBody}`;
      regexes.push(new RegExp(`${B}${number ? `(?:${escape(number)}${ADDRESS_SEPARATOR})?` : ""}${body}${tail}${E}`, "gu"));
    } else {
      const typePart = type ? `(?:${ADDRESS_SEPARATOR}${streetWord(type)})` : "";
      // With its number, the type may be left out ("4471 SW 12th"); without it, the type must be there ("SW 12th Terrace").
      if (number) regexes.push(new RegExp(`${NUMBER_START}${escape(number)}${ADDRESS_SEPARATOR}${dirPart}${nameBody}${typePart}?${tail}${E}`, "gu"));
      if (type) regexes.push(new RegExp(`${B}${dirPart}${nameBody}${typePart}${tail}${E}`, "gu"));
    }
  }
  return { core: [number, ...name].filter(Boolean), regexes, places };
}

/** Whether the canonical words of an address contain `core` in order (a direction may sit between the number and the name). */
function containsCore(words: string[], core: string[]): boolean {
  if (core.length === 0) return false;
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== core[0]) continue;
    let j = i + 1;
    if (DIRECTIONS.has(words[j]) && !DIRECTIONS.has(core[1])) j++;
    if (core.slice(1).every((w, k) => words[j + k] === w)) return true;
  }
  return false;
}

const NAME_FORMS: NameForm[] = ["first", "full", "last", "initials"];

function isPerson(kind: FoundKind): boolean {
  return kind === "client" || kind === "caregiver" || kind === "family" || kind === "professional";
}

function personKey(person: Person, form: NameForm, surnamePart = ""): string {
  return `person:${person.priority}:${form}${form === "last" ? `:${surnamePart}` : ""}`;
}

function canonicalDate({ year, month, day }: YMD): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(month)}/${pad(day ?? 1)}/${year}`;
}

interface Literal {
  regex: RegExp;
  key: string;
  kind: FoundKind;
  capitalizedOnly: boolean;
  /** Matched on the original text, case-sensitive (school acronyms). */
  original?: boolean;
  /** Reported as possible, not hidden. */
  possible?: Possible["reason"];
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
  readonly #literals: Literal[] = [];
  /** The sheet's addresses, to give a pattern-found address the sheet's number. */
  readonly #sheetAddresses: Array<{ core: string[]; slot: string }> = [];
  /** For each surname-alone placeholder, how often each written form of it was used. */
  readonly #surnamesSeen = new Map<string, Map<string, number>>();

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
      if (this.#slots.has(key)) return;
      const n = (this.#counters.get(kind) ?? 0) + 1;
      this.#counters.set(kind, n);
      this.#slots.set(key, { placeholder: numberedPlaceholder(kind, n), value, kind });
      this.#sheetKeys.add(key);
    };
    const literal = (regex: RegExp | null, key: string, kind: FoundKind, capitalizedOnly = false) => {
      if (regex) this.#literals.push({ regex, key, kind, capitalizedOnly });
    };
    const genericWords = [...SCHOOL_GENERIC].filter((w) => !ARTICLES.has(w)).map(escape).join("|");
    (sheet.schools ?? []).forEach((school, i) => {
      const key = `school:sheet:${i}`;
      reserve("school", key, school.trim());
      const tokens = tokensOf(school);
      literal(phraseRegex(tokens.map((t) => [t])), key, "school");
      const core = tokens.filter((t) => !SCHOOL_GENERIC.has(t));
      if (core.length && core.length < tokens.length) {
        // The distinctive words alone ("José Martí"), with any generic words after them ("José Martí Elementary").
        literal(new RegExp(`${B}${core.map(escape).join(SEPARATOR)}(?:${SEPARATOR}(?:${genericWords}))*${E}`, "gu"), key, "school", true);
        for (const word of core.filter((w) => w.length >= 4)) {
          // One distinctive word with a generic word after it ("Martí Elementary"): hidden. Alone ("Martí."): possible.
          literal(new RegExp(`${B}${escape(word)}(?:${SEPARATOR}(?:${genericWords}))+${E}`, "gu"), key, "school", true);
          this.#literals.push({ regex: new RegExp(`${B}${escape(word)}${E}`, "gu"), key, kind: "school", capitalizedOnly: true, possible: "school-word" });
        }
      }
      // Its initials, in capitals: "JMES", "JME".
      const initials = tokens.filter((t) => !ARTICLES.has(t)).map((t) => t[0].toUpperCase());
      const acronyms = new Set([initials.join(""), initials.slice(0, -1).join(""), core.length ? core.map((t) => t[0].toUpperCase()).join("") + (tokens.find((t) => SCHOOL_GENERIC.has(t) && !ARTICLES.has(t))?.[0].toUpperCase() ?? "") : ""]);
      for (const acronym of [...acronyms].filter((a) => a.length >= 3)) {
        this.#literals.push({ regex: new RegExp(`(?<![\\p{L}\\p{N}])${acronym}(?![\\p{L}\\p{N}])`, "gu"), key, kind: "school", capitalizedOnly: false, original: true });
      }
    });
    const places = new Map<string, string>();
    (sheet.addresses ?? []).forEach((address, i) => {
      const key = `address:sheet:${i}`;
      reserve("address", key, address.trim());
      const parsed = parseAddress(address);
      for (const regex of parsed.regexes) literal(regex, key, "address");
      literal(phraseRegex(tokensOf(address).map((t) => [...(ADDRESS_SPELLINGS.get(canonicalAddressWord(t)) ?? [t]), t])), key, "address");
      this.#sheetAddresses.push({ core: parsed.core, slot: key });
      for (const place of parsed.places) if (!places.has(foldString(place))) places.set(foldString(place), place);
    });
    // The city or neighborhood of each sheet address, also alone ("lives in Hialeah"): HIPAA Safe Harbor counts it (owner's decision, 2026-11-22).
    for (const [folded, place] of places) {
      const key = `city:sheet:${folded}`;
      reserve("city", key, place);
      const tokens = tokensOf(place);
      const common = tokens.every((t) => isCommonWordName(t) || COMMON_PLACE_WORDS.has(t));
      literal(phraseRegex(tokens.map((t) => [t])), key, "city", common);
    }
    (sheet.phones ?? []).forEach((phone) => {
      const digits = phoneKey(phone);
      const key = `phone:${digits}`;
      reserve("phone", key, phone.trim());
      literal(compactRegex(digits), key, "phone");
      // The number without its area code: "555-0142".
      if (digits.length === 10) literal(compactRegex(digits.slice(3)), key, "phone");
    });
    (sheet.emails ?? []).forEach((email) => {
      const key = `email:${email.trim().toLowerCase()}`;
      reserve("email", key, email.trim());
      literal(new RegExp(`${B}${escape(foldString(email.trim()))}${E}`, "gu"), key, "email");
    });
    (sheet.ids ?? []).forEach((id) => {
      const compact = id.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const key = `id:${compact}`;
      reserve("id", key, id.trim());
      literal(compactRegex(id), key, "id");
      // The digits without a letter prefix: "123456789" for "FL123456789".
      const digitsPart = compact.replace(/^\p{L}+/u, "");
      if (digitsPart !== compact && digitsPart.length >= 6) literal(compactRegex(digitsPart), key, "id");
    });
    (sheet.other ?? []).forEach((other, i) => {
      const key = `other:sheet:${i}`;
      reserve("other", key, other.trim());
      literal(phraseRegex(tokensOf(other).map((t) => [t])), key, "other");
    });
  }

  /** The placeholders assigned so far and what each is restored as. */
  get map(): RestoreMap {
    const seen = new Set<string>();
    const entries: MapEntry[] = [];
    for (const [key, slot] of this.#slots) {
      if (seen.has(slot.placeholder)) continue;
      // A value reserved from the sheet but never met in the text is not sent, so not in the map.
      if (this.#sheetKeys.has(key) && !this.#used.has(key)) continue;
      seen.add(slot.placeholder);
      entries.push({ placeholder: slot.placeholder, value: this.#surnameAsWritten(key) ?? slot.value, kind: slot.kind });
    }
    return { entries };
  }

  /** Sheet keys met in a text so far. */
  readonly #used = new Set<string>();

  /** A surname placeholder restores as the text wrote it most often, in the sheet's own spelling ("de la Fuente" or "Fuente"). */
  #surnameAsWritten(key: string): string | undefined {
    const seen = this.#surnamesSeen.get(key);
    const person = this.#people.find((p) => key.startsWith(`person:${p.priority}:last:`));
    const lastName = person?.sheet.lastName?.normalize("NFC").trim();
    if (!seen || !lastName) return undefined;
    const [words] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
    const parts = lastName.split(/([\s-]+)/u);
    const folded = parts.map((part, i) => (i % 2 === 0 ? foldString(part).replace(/[^\p{L}']/gu, "") : ""));
    const wanted = words.split(" ");
    for (let i = 0; i < parts.length; i += 2) {
      const j = i + 2 * (wanted.length - 1);
      if (j < parts.length && wanted.every((w, k) => folded[i + 2 * k] === w)) return parts.slice(i, j + 1).join("");
    }
    return undefined;
  }

  #personSlot(person: Person, form: NameForm, surnamePart = ""): void {
    const key = personKey(person, form, surnamePart);
    if (this.#slots.has(key)) return;
    const { firstName, lastName, nicknames, preferredName } = person.sheet;
    const first = (preferredName ?? firstName ?? nicknames?.[0] ?? lastName ?? "").trim();
    const full = [firstName ?? preferredName, lastName].filter(Boolean).join(" ").trim();
    let last = (lastName ?? first).trim();
    if (form === "last" && surnamePart) {
      const wanted = surnamePart.split(" ").map((n) => person.surnames[Number(n) - 1]);
      last = lastName?.split(/[\s-]+/u).filter((w) => wanted.includes(foldString(w).replace(/[^\p{L}']/gu, ""))).join(" ") || last;
    }
    const value = { first, full: full || first, last, initials: person.initials?.toUpperCase() ?? first }[form];
    this.#slots.set(key, { placeholder: personPlaceholder(person.group, person.index, form, surnamePart), value, kind: person.group });
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

  #nameCandidate(person: Person, form: NameForm, start: number, end: number, surnamePart: string, surnameWords: string): Candidate {
    return {
      start,
      end,
      key: personKey(person, form, surnamePart),
      kind: person.group,
      source: "sheet",
      rank: 0,
      surnameWords,
      create: () => this.#personSlot(person, form, surnamePart),
    };
  }

  deidentify(input: string): DeidentifyResult {
    if (input.length > MAX_TEXT_LENGTH) throw new RangeError(`A text to de-identify is limited to ${MAX_TEXT_LENGTH} characters.`);
    const text = input.normalize("NFC");
    const folded = fold(text);
    const candidates: Candidate[] = [];
    const possible: Possible[] = [];
    const range = (start: number, end: number) => originalRange(folded, start, end);
    const capitalized = (start: number) => /^\p{Lu}/u.test(text.slice(start, start + 2));

    for (const match of findNames(folded, this.#people)) {
      const [start, end] = range(match.start, match.end);
      const { person, form } = match;
      if (match.ambiguous && this.#commonWordNames === "capitalized" && !capitalized(start)) {
        possible.push({ text: text.slice(start, end), start, end, reason: "common-word-name", placeholder: personPlaceholder(person.group, person.index, form, match.surnamePart), kind: person.group, hidden: false });
        continue;
      }
      if (match.shared) {
        // Two people on the sheet fit: sent as a neutral [NAME n], restored as written, and shown for review.
        const original = text.slice(start, end);
        const key = `shared:${foldString(original)}`;
        candidates.push({ start, end, key, kind: "unlisted-name", source: "sheet", rank: 0, create: () => this.#numberedSlot(key, "unlisted-name", original), sharedWith: match.shared });
        continue;
      }
      candidates.push(this.#nameCandidate(person, form, start, end, match.surnamePart, match.surnameWords));
    }
    for (const part of [...findJoinedNames(folded, text, this.#people), ...findSpacedNames(folded, text, this.#people)]) {
      const [start, end] = range(part.start, part.end);
      const form: NameForm = part.role === "given" ? "first" : "last";
      if (!part.joined) {
        possible.push({ text: text.slice(start, end), start, end, reason: "name-inside-word", placeholder: personPlaceholder(part.person.group, part.person.index, form, part.surnamePart), kind: part.person.group, hidden: false });
        continue;
      }
      candidates.push(this.#nameCandidate(part.person, form, start, end, part.surnamePart, part.role === "surname" ? part.word : ""));
    }
    this.#nicknameCandidates(text, folded, possible);
    for (const literal of this.#literals) {
      const haystack = literal.original ? text : folded.text;
      for (const m of haystack.matchAll(literal.regex)) {
        const [start, end] = literal.original ? [m.index, m.index + m[0].length] : range(m.index, m.index + m[0].length);
        if (literal.capitalizedOnly && !capitalized(start)) continue;
        if (literal.possible) {
          possible.push({ text: text.slice(start, end), start, end, reason: literal.possible, placeholder: this.#slots.get(literal.key)!.placeholder, kind: literal.kind, hidden: false });
          continue;
        }
        candidates.push({ start, end, key: literal.key, kind: literal.kind, source: "sheet", rank: 1, create: () => {} });
      }
    }
    this.#dateCandidates(text, folded, candidates);
    for (const match of findPatterns(text)) candidates.push(this.#patternCandidate(text, match));
    for (const { start, end } of findAgeDays(text)) {
      candidates.push({ start, end, key: "", kind: "date", source: "pattern", rank: -1, create: () => {}, drop: true });
    }

    const accepted = resolve(text, candidates);

    let out = "";
    let at = 0;
    const found = new Map<string, Finding>();
    const dropped: Dropped[] = [];
    for (const span of accepted.items) {
      const original = text.slice(span.start, span.end);
      if (span.drop) {
        out += text.slice(at, span.start);
        at = span.end;
        dropped.push({ text: original, start: span.start, end: span.end, reason: "age-days" });
        continue;
      }
      if (span.piece) {
        // A piece is restored as itself, under a placeholder of its own.
        const kind: NumberedKind = span.kind === "dob" ? "date" : isPerson(span.kind) ? "unlisted-name" : (span.kind as NumberedKind);
        span.key = `piece:${kind}:${original}`;
        this.#numberedSlot(span.key, kind, original);
      } else {
        span.create();
        if (this.#sheetKeys.has(span.key)) this.#used.add(span.key);
        // Once a person is mentioned, the model may use any form of their name: all of them restore.
        const person = this.#people.find((p) => span.key.startsWith(`person:${p.priority}:`));
        if (person) {
          for (const form of NAME_FORMS) if (form !== "initials" || person.initials) this.#personSlot(person, form);
          if (span.surnameWords && span.key.includes(":last:")) {
            const seen = this.#surnamesSeen.get(span.key) ?? new Map<string, number>();
            seen.set(span.surnameWords, (seen.get(span.surnameWords) ?? 0) + 1);
            this.#surnamesSeen.set(span.key, seen);
          }
        }
      }
      const slot = this.#slots.get(span.key)!;
      out += text.slice(at, span.start) + slot.placeholder;
      at = span.end;
      const finding = found.get(slot.placeholder) ?? { placeholder: slot.placeholder, kind: slot.kind, source: span.source, count: 0, originals: [] };
      finding.count++;
      if (!finding.originals.includes(original)) finding.originals.push(original);
      found.set(slot.placeholder, finding);
      if (span.sharedWith) possible.push({ text: original, start: span.start, end: span.end, reason: "shared-name", placeholder: slot.placeholder, kind: "unlisted-name", hidden: true });
    }
    out += text.slice(at);
    const reported = possible.filter((p) => p.hidden || accepted.overlapping(p.start, p.end).length === 0);
    const unique = reported.filter((p, i) => reported.findIndex((o) => o.start === p.start && o.end === p.end) === i).sort((a, b) => a.start - b.start);
    return { text: out, found: [...found.values()], possible: unique, dropped, map: this.map };
  }

  /** A capitalized word that is the start of a long sheet given name ("Vale" for Valeria): possible. */
  #nicknameCandidates(text: string, folded: Folded, possible: Possible[]): void {
    const prefixes = new Map<string, Person>();
    for (const person of this.#people) {
      for (const { word, role } of person.longWords) {
        if (role !== "given" || word.length < 6) continue;
        for (let n = 3; n <= word.length - 2; n++) if (!person.roles.has(word.slice(0, n))) prefixes.set(word.slice(0, n), person);
      }
    }
    if (prefixes.size === 0) return;
    for (const m of folded.text.matchAll(/\p{L}+/gu)) {
      const person = prefixes.get(m[0]);
      if (!person) continue;
      const [start, end] = originalRange(folded, m.index, m.index + m[0].length);
      if (!/^\p{Lu}/u.test(text.slice(start, end))) continue;
      possible.push({ text: text.slice(start, end), start, end, reason: "possible-nickname", placeholder: personPlaceholder(person.group, person.index, "first"), kind: person.group, hidden: false });
    }
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
      // A birthday in another year ("he turned 6 on 03/14/2026") gives the date of birth away: always hidden.
      const anniversary = dob !== null && date.readings.some((r) => r.month === dob.month && r.day === dob.day);
      const hide = anniversary || this.#dates === "all" || date.readings.some((r) => ymdKey(r) < cutoff);
      if (!hide) continue;
      const key = `date:${ymdKey(date.readings[0])}`;
      candidates.push({ start, end, key, kind: "date", source: "pattern", rank: 2, create: () => this.#numberedSlot(key, "date", original) });
    }
  }

  #patternCandidate(text: string, match: PatternMatch): Candidate {
    const original = text.slice(match.start, match.end);
    let key = match.key;
    if (match.kind === "address") {
      const words = addressKey(original).split(" ");
      const sheet = this.#sheetAddresses.find((a) => containsCore(words, a.core));
      if (sheet) key = sheet.slot;
    }
    return {
      start: match.start,
      end: match.end,
      key,
      kind: match.kind,
      source: this.#sheetKeys.has(key) ? "sheet" : "pattern",
      rank: 2,
      create: () => {
        if (!this.#slots.has(key)) this.#numberedSlot(key, match.kind, original);
      },
    };
  }
}

/**
 * Picks the spans to replace: longest first, the sheet before patterns at equal length,
 * never overlapping. The part of a shorter span left outside the longer ones is kept as
 * a span of its own, so a phone number half inside an address is still hidden whole.
 * Linear apart from the sort: overlaps are found by binary search.
 */
function resolve(text: string, candidates: Candidate[]): Spans<Candidate> {
  // Names found only after a label ("Examinee:") come last: the sheet's own reading of a name wins.
  const tier = (c: Candidate) => (c.kind === "unlisted-name" && !c.key.startsWith("shared:") ? 1 : 0);
  const ordered = [...candidates].sort((a, b) => tier(a) - tier(b) || b.end - b.start - (a.end - a.start) || a.rank - b.rank || a.start - b.start);
  const accepted = new Spans<Candidate>();
  for (const candidate of ordered) {
    if (candidate.end <= candidate.start) continue;
    const overlaps = accepted.overlapping(candidate.start, candidate.end);
    if (overlaps.length === 0) {
      accepted.add(candidate);
      continue;
    }
    if (candidate.drop) continue;
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
      if (a + lead < b - trail) accepted.add({ ...candidate, start: a + lead, end: b - trail, piece: true });
    }
  }
  return accepted;
}

/** De-identifies one text. For several texts of one request, use one Deidentifier. */
export function deidentify(text: string, sheet: ClientSheet, options?: DeidentifyOptions): DeidentifyResult {
  return new Deidentifier(sheet, options).deidentify(text);
}
