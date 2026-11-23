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
import { findBrokenNames, findJoinedNames, findNames, findOcrNames, peopleOf, type NameForm, type Person } from "./names.ts";
import { ADDRESS_WORDS, findAgeDays, findPatterns, phoneKey, type PatternMatch } from "./patterns.ts";
import { birthDatePlaceholder, nicknamePlaceholder, numberedPlaceholder, personPlaceholder, type BirthDateForm, type NumberedKind } from "./placeholders.ts";
import type { ClientSheet, FoundKind } from "./sheet.ts";
import { findSequences, type SequenceValue } from "./sequences.ts";
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
 *   ("shared-name"), or a sheet name split by a space next to a short word that may be two
 *   ordinary words ("split-name", "mate o"), sent as [NAME n] and restored as written;
 * - left as it is, to check: a short sheet value (a date of birth with a two-digit year, a
 *   house number, a ZIP code with separators) met where it may be a score ("possible-sheet-value",
 *   "Raw scores | 19 | 3 | 14"): hidden only next to a label or written as a date.
 */
export interface Possible {
  text: string;
  start: number;
  end: number;
  reason: "common-word-name" | "name-inside-word" | "school-word" | "possible-nickname" | "shared-name" | "split-name" | "possible-sheet-value";
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

/** The longest text one call accepts: what a PDF can give (2M characters); a typed source is far shorter. */
export const MAX_TEXT_LENGTH = 2_000_000;

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
  /** A sheet name split by a space next to a short word: maybe two words. */
  split?: boolean;
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

/** A word of 4 letters or more, also hyphenated or broken across a line ("Mar-tí", "Mia-⏎mi"). */
function brokenWord(word: string): string {
  if (word.length < 4 || !/^\p{L}+$/u.test(word)) return escape(word);
  return [...word].map(escape).join("(?:-[ \\t]*(?:\\r?\\n[ \\t]*)?|[ \\t]*\\r?\\n[ \\t]*)?");
}

/** Matches the words of a value with any punctuation, spacing or line break between them; `broken` also takes each word hyphenated. */
function phraseRegex(tokens: string[][], broken = false): RegExp | null {
  if (tokens.length === 0) return null;
  const body = tokens.map((alternatives) => `(?:${alternatives.map(broken ? brokenWord : escape).join("|")})`).join(SEPARATOR);
  return new RegExp(`${B}${body}${E}`, "gu");
}

/** The key of a value found in a text: the same written form shares a placeholder; any other form has its own. */
function valueKey(kind: FoundKind, original: string): string {
  // Each written form has its own placeholder and restores exactly as written: "(305) 555-0142" and "305.555.0142" are two,
  // and so are "305-555-⏎0142" and "305-555- 0142".
  return `${kind}:${original}`;
}

/** Matches a number or a code with or without spaces, dashes, dots, slashes or brackets: "305 555 0142", "FL 123 - 456 - 789". */
function compactRegex(value: string): RegExp | null {
  const chars = foldString(value).replace(/[^\p{L}\p{N}]/gu, "");
  if (chars.length < 4) return null;
  // Digits at an end may touch letters ("fl9876543210", "ID9876543210x"), never other digits.
  const start = /^\p{N}/u.test(chars) ? "(?<![\\p{N}])" : B;
  const end = /\p{N}$/u.test(chars) ? "(?![\\p{N}])" : E;
  return new RegExp(`${start}${[...chars].map(escape).join("[\\s\\-.()/]{0,4}")}${end}`, "gu");
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
      // "15 Calle del Mar", "C/ del Mar", and the number after the street: "c. del Mar #15", "Calle del Mar no. 15".
      const numberAfter = number ? `(?:${ADDRESS_SEPARATOR}(?:#|no\\.?|num\\.?|numero)?${ADDRESS_SEPARATOR}${escape(number)})?` : "";
      regexes.push(new RegExp(`${B}${number ? `(?:${escape(number)}(?![\\p{N}])${ADDRESS_SEPARATOR})?` : ""}${body}${numberAfter}${tail}${E}`, "gu"));
    } else {
      const typePart = type ? `(?:${ADDRESS_SEPARATOR}${streetWord(type)})` : "";
      // With its number, the type may be left out ("4471 SW 12th"); without it, the type must be there ("SW 12th Terrace").
      // The number ends before the street ("201 5th", never "2015").
      if (number) regexes.push(new RegExp(`${NUMBER_START}${escape(number)}(?![\\p{N}])${ADDRESS_SEPARATOR}${dirPart}${nameBody}${typePart}?${tail}${E}`, "gu"));
      if (type) regexes.push(new RegExp(`${B}${dirPart}${nameBody}${typePart}${tail}${E}`, "gu"));
    }
  }
  return { regexes, places };
}

/** A URL, a query string, an email address or a file name. */
// Each open-ended part starts where its run of characters starts, so a long run ("a.b.c.d…") is read once, not once per character.
const LINKS = /(?:https?:\/\/|www\.)[^\s<>"'()[\]]+|mailto:[^\s<>"']+|(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|(?<![^\s/\\<>"'|])[^\s/\\<>"'|]+\.(?:pdf|docx?|xlsx?|csv|txt|rtf|jpe?g|png|heic|gif|mp4|mov|m4a|zip)\b|\?[^\s?]*=[^\s]*|(?<!\S)[^\s]*%[0-9A-Fa-f]{2}[^\s]*/gu;

/**
 * Whether a sheet sequence could be scores rather than the value: a short one (a two-digit
 * year, a house number, a ZIP code written apart), one spread over table cells, and a date of
 * birth not written as a date ("2 | 0 | 1 | 2 | 1 | 2" in an item-score row is not 2012-01-02).
 */
function needsContext(match: { tag: string; short: boolean; whole: boolean; dateLike: boolean; gaps: string[]; pieces: number[] }): boolean {
  // A date of birth written as a date ("3/14/20"): the value. A house number written so ("1-0-2") is still a score's form.
  if (match.tag === "dob" && match.dateLike) return false;
  if (match.short) return !(match.whole && match.tag === "zip");
  if (match.whole) return false;
  if (match.tag !== "dob" && match.tag !== "address" && match.tag !== "zip") return false;
  if (match.tag === "dob") {
    // Written as a date with its four-digit year, in any layout and with any label or none ("Client: Mateo | 03 | 14 | 2020"): the value.
    // No score row holds a month, a day and a matching birth year in a row. Single digits apart ("2 | 0 | 1 | 2 | 1 | 2") can be scores.
    const p = match.pieces;
    const asDate = (p.length === 3 && ((p[2] === 4 && p[0] <= 2 && p[1] <= 2) || (p[0] === 4 && p[1] <= 2 && p[2] <= 2))) || (p.length === 2 && (p[0] === 4 || p[1] === 4));
    return !asDate;
  }
  return match.gaps.some((g) => g.includes("|"));
}

/** A birthday, birth or date-of-birth word, in English or Spanish. */
const BIRTHDAY_WORD = /(?<![\p{L}])(?:dob|d\.o\.b\.?|b-?day|birthday|birthdate|date[ \t]+of[ \t]+birth|cumple\p{L}*|naci[oó]|nacid[oa][ \t]+el|nacimiento|f\.?[ \t]?nac\.?)(?![\p{L}])/iu;
/** Words that make the next number pair a birthday only right before it: "born on 3/14", "b. 3/14", "turns 7 on 3/14". */
const BIRTHDAY_RIGHT_BEFORE = /(?<![\p{L}])(?:born(?:[ \t]+on)?|b\.|turns?[ \t]+\d{1,2}[ \t]+(?:on|el))[ \t]*:?[ \t]*$/iu;

/** Whether a birthday word stands before `start` in the same clause, or in the first cell of its table row. */
function birthdayBefore(text: string, start: number): boolean {
  const from = Math.max(0, start - 120);
  const lineStart = from + text.slice(from, start).lastIndexOf("\n") + 1;
  const before = text.slice(lineStart, start);
  const clause = before.slice(Math.max(before.lastIndexOf(". "), before.lastIndexOf(";"), before.lastIndexOf("?"), before.lastIndexOf("!")) + 1);
  if (BIRTHDAY_WORD.test(clause) || BIRTHDAY_RIGHT_BEFORE.test(before)) return true;
  return before.includes("|") && BIRTHDAY_WORD.test(before.split("|").find((c) => c.trim() !== "") ?? "");
}

/** Whether a number pair reads as a ratio: one of a list of them, or next to a trial word ("8/10 correct", "accuracy 9/10"). */
function ratioContext(text: string, start: number, end: number): boolean {
  // One of a list of ratios: another ratio right before or after it, apart only by a comma, a bar, a semicolon or "and" ("8/10, 9/10").
  const RATIO = "\\d{1,3}[ \\t]*\\/[ \\t]*\\d{1,3}";
  const JOIN = "[ \\t]*(?:[,;|]|and|y|or)[ \\t]*";
  if (new RegExp(`(?<![\\d/])${RATIO}${JOIN}$`, "u").test(text.slice(Math.max(0, start - 20), start))) return true;
  if (new RegExp(`^${JOIN}${RATIO}(?![\\d/])`, "u").test(text.slice(end, end + 20))) return true;
  if (/^[ \t]*(?:\(?\d+[ \t]*%|correct\p{L}*|incorrect|trials?|opportunit\p{L}*|prompt\p{L}*|independ\p{L}*|responses?|ioa|apgar|ensayos?|oportunidades|aciertos|correctas?|intentos|on[ \t]+(?:mands?|tacts?|intraverbals?|echoics?|listener|probes?|targets?|programs?|goals?|trials?))/iu.test(text.slice(end, end + 25))) return true;
  return /(?<![\p{L}])(?:of|per|de|rate|rates|accuracy|score|scored|scores|got|earned|reached|apgar|mands?|tacts?|ioa|trials?|ensayos?|aciertos|precisi[oó]n|data)[ \t]*[:=]?[ \t]*$/iu.test(text.slice(Math.max(0, start - 25), start));
}

/**
 * Whether three numbers that read as the date of birth with its four-digit year belong to
 * something else: an age range before a year ("ages 2-5, 2019 edition", "Ages 3–14 (2020
 * norms)"), a list of numbers ("Trials by year: 3 14 2018 2019"), a score or norm word before
 * or after them ("Raw 11 | 5 | 2019 norm table", "Score table: 3 | 14 | 2020 | norms"). Then
 * they are hidden only in context, like the short forms. The birthday's own month and day
 * after them ("3 14 2020 3 14") is no list.
 */
function numbersListContext(text: string, start: number, end: number, original: string, dob: YMD | null): boolean {
  if (/^\d{1,2}[ \t]*[-\u{2013}\u{2014}][ \t]*\d{1,2}[ \t]*[,(]/u.test(original) || /[()[\]]/u.test(original)) return true;
  const after = text.slice(end, end + 40);
  const before = text.slice(Math.max(0, start - 40), start);
  const pair = /^[ \t|,;]*(\d{1,2})[ \t|/.-]+(\d{1,2})(?!\d)/u.exec(after);
  const birthday = pair && dob && ((+pair[1] === dob.month && +pair[2] === dob.day) || (+pair[2] === dob.month && +pair[1] === dob.day));
  // Another reading of the date of birth right after ("03 14 2020 2020 3 14") is no list either.
  const triple = /^[ \t|,;]*(\d{1,4})[ \t|/.-]+(\d{1,2})[ \t|/.-]+(\d{1,4})(?!\d)/u.exec(after);
  const again = triple && dob && [[triple[1], triple[2], triple[3]], [triple[3], triple[1], triple[2]], [triple[3], triple[2], triple[1]]].some(([y, m, d]) => +y === dob.year && ((+m === dob.month && +d === dob.day) || (+d === dob.month && +m === dob.day)));
  // The first item of a list of years that starts at the birth year ("Seen 3 14 2020 2021 2022 for evaluations"): the date of birth.
  const years = /^(?:[ \t|,;]+(?:19|20)\d{2}(?!\d))+/u.exec(after);
  const yearList = years !== null && !/^[ \t|,;]*\d/u.test(after.slice(years[0].length)) && !/\d/u.test(before) && !/(?:trials?|years?|by)[ \t:]*$/iu.test(before);
  if (/^[ \t|,;]*\(?\d/u.test(after) && !birthday && !again && !yearList) return true;
  const noun = /^[ \t|,;)\]]*(norm|edition|ed\.|version|table|cohort|session|trial|item|student|point|score|standard|scaled|percentile|%|raw|ensayo|edici)/iu.exec(after);
  // "3 14 2020 trials." with no other number around: the date of birth, then a word.
  const lone = noun !== null && /^(?:session|trial)/iu.test(noun[1]) && !/\d/u.test(before) && !/\d/u.test(after.slice(noun[0].length, noun[0].length + 20));
  if (noun && !lone) return true;
  return /(?<![\p{L}])(?:ages?|edad(?:es)?|grades?|raw|scores?|tables?|norms?|items?|trials?|years?|percentiles?|standard|scaled|range|rango|puntuaci\p{L}*)(?![\p{L}])[^|\n\d]{0,12}[|:]?[ \t]*$/iu.test(before);
}

/** A house-number word right before a number ("dirección 4471", "house number 4471", "lives at # 4471"). */
const HOUSE_BEFORE = /(?<![\p{L}])(?:address|addr\.?|direcci[oó]n|domicilio|house(?:[ \t]+(?:number|no\.?|#))?|casa|lives[ \t]+at|vive[ \t]+en(?:[ \t]+el)?|street[ \t]+number|n[uú]mero(?:[ \t]+de[ \t]+casa)?|calle)[ \t]*(?:[:#|]|no\.?|n[º°]\.?)?[ \t]*#?[ \t]*$/iu;
/** A count noun right after a number: "102 trials", "102 correct responses", "102 ensayos". */
const COUNT_AFTER = /^[ \t]*(?:%|x\b|trials?|responses?|correct|incorrect|ensayos?|times|minutes?|mins?|sessions?|items?|points?|opportunit\p{L}*|prompts?|units?|targets?|veces|respuestas|aciertos)/iu;
/** A street direction or a street after a number: "4471 SW 12th", "102 NW 5th St", "4471 Main Street". */
const STREET_AFTER = /^[ \t]+(?:(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\.?(?=[ \t,]|$)|\S+[ \t]+(?:street|st|avenue|ave|av|terrace|terr|ter|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|highway|hwy|parkway|pkwy)\b\.?)/iu;

/** Whether a house number written on its own is the house number: right after a house word or right before its street, never a count or part of a code. */
function houseInContext(text: string, start: number, end: number): boolean {
  if (/[\p{L}\p{N}]/u.test(text[start - 1] ?? "") || /[\p{L}\p{N}]/u.test(text[end] ?? "")) return false;
  const after = text.slice(end, end + 40);
  if (COUNT_AFTER.test(after)) return false;
  return HOUSE_BEFORE.test(text.slice(Math.max(0, start - 40), start)) || STREET_AFTER.test(after);
}

/** A counting word right before a number: "Room 33135" is a room. */
const COUNT_BEFORE = /(?<![\p{L}])(?:room|page|pages|total|code|item|items|score|scores|raw|trials?|session|cpt|claim|invoice|units?\s+of|count|n)[ \t]*[:=#]?[ \t]*$/iu;

/** Labels that make a short number on their line or in their cell a sheet value, not a score. */
const VALUE_LABEL = /(?<![\p{L}])(?:house(?:\s+number)?|casa|lives\s+at|vive\s+en|n[uú]mero|sw|nw|ne|se|street|st|avenue|ave|av|terrace|terr|ter|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|apt|apto|suite|unit|calle|cll|dob|d\.o\.b|birth\w*|born|bday|cumple\w*|nacimiento|naci[oó]|fecha\s+de\s+nac\w*|f\.?\s?nac\w*|address\w*|addr|street|calle|direcci[oó]n|domicilio|zip|zip\s*code|postal|c[oó]digo\s+postal|phone|tel\w*|cell\w*|cel|mobile|celular|m[oó]vil|medicaid|member|mrn|policy|ssn|record|id)(?![\p{L}])/iu;

/**
 * Whether a short sheet value found at [start, end) is in its context: written with one date
 * separator throughout ("03/14/20"), or next to a label on its line (prose) or in its row's first
 * cell or its own cell (a table). A table row whose first cell is not such a label is a score row.
 */
function shortInContext(text: string, start: number, end: number, match: { dateLike: boolean }, names?: RegExp | null): boolean {
  if (match.dateLike) return true;
  // "b." (born) right before it: "Mateo b. 3 14 20".
  if (/(?<![\p{L}])b\.?[ \t]*$/iu.test(text.slice(Math.max(0, start - 6), start))) return true;
  // The line around it, at most 200 characters each way (a text without line breaks stays linear).
  const from = Math.max(0, start - 200);
  const lineStart = from + text.slice(from, start).lastIndexOf("\n") + 1;
  const after = text.slice(end, end + 200);
  const lineEnd = after.includes("\n") ? end + after.indexOf("\n") : end + after.length;
  const line = text.slice(lineStart, lineEnd);
  // The client's name on the line or the row: "Mateo, 3 14 20".
  if (names && names.test(foldString(line))) return true;
  // A label alone up to three lines above, past blank lines and rule lines ("Date of Birth:" over "-----" over its boxes).
  const above = text.slice(Math.max(0, lineStart - 300), Math.max(0, lineStart - 1)).split("\n").slice(-3).reverse();
  for (const previous of above) {
    if (/^[-_=.\s|]*$/u.test(previous)) continue;
    if (previous.length <= 40 && !/\d/u.test(previous) && VALUE_LABEL.test(previous)) return true;
    break;
  }
  if (!line.includes("|")) return VALUE_LABEL.test(line);
  const first = line.split("|").find((c) => c.trim() !== "") ?? "";
  const own = text.slice(lineStart + text.slice(lineStart, start).lastIndexOf("|") + 1, start);
  return VALUE_LABEL.test(first) || (VALUE_LABEL.test(own) && !/\d/u.test(own));
}

/** An age label right before a number: "Age", "CA =", "Chronological age |", "Edad:". */
const AGE_BEFORE = /(?:\bages?|\baged|\bchronological\s+age|\bc\.?a\.?|\bedad(?:\s+cronol[oó]gica)?)\s*(?:at\s+testing|al\s+evaluar)?\s*(?:\([^)\n]{0,15}\))?\s*[:=|]?\s*$/iu;

const NAME_FORMS: NameForm[] = ["first", "full", "last", "initials"];

function isPerson(kind: FoundKind): boolean {
  return kind === "client" || kind === "caregiver" || kind === "family" || kind === "professional";
}

function personKey(person: Person, form: NameForm): string {
  return `person:${person.priority}:${form}`;
}

interface Literal {
  regex: RegExp;
  kind: NumberedKind;
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
  /** Sheet values read as a sequence of characters, whatever separates them. */
  readonly #sequences: SequenceValue[] = [];
  /** How many written forms of each part of the date of birth have a placeholder. */
  readonly #birthCounts = new Map<BirthDateForm, number>();
  /** The client's name words, folded: context for a short date of birth ("Mateo, 3 14 20"). */
  #clientNames: RegExp | null = null;

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
    // Each match gets a placeholder for its own written value (restored exactly as written); the same value written
    // the same way, or in another format of the same value, shares it. No value of the sheet is reserved in advance.
    const literal = (regex: RegExp | null, kind: NumberedKind, capitalizedOnly = false) => {
      if (regex) this.#literals.push({ regex, kind, capitalizedOnly });
    };
    const sequence = (chars: string, tag: string, minGaps = 0, uniform = false, more: { short?: boolean; capitals?: boolean; sentences?: boolean } = {}) => {
      const clean = foldString(chars).replace(/[^\p{L}\p{N}]/gu, "");
      if (clean.length >= 3 && !this.#sequences.some((s) => s.chars === clean && s.tag === tag)) this.#sequences.push({ chars: clean, minGaps, uniform, tag, ...more });
    };
    const client = this.#people.find((p) => p.group === "client");
    if (client) {
      const { firstName, lastName, nicknames, preferredName } = client.sheet;
      const words = [firstName, lastName, preferredName, ...(nicknames ?? [])].flatMap((n) => tokensOf(n ?? "")).filter((w) => /^\p{L}{3,}$/u.test(w) && !["del", "las", "los", "van", "von", "der", "den", "dos", "das"].includes(w));
      if (words.length) this.#clientNames = new RegExp(`(?<![\\p{L}])(?:${[...new Set(words)].join("|")})(?![\\p{L}])`, "u");
    }
    const dob = this.#dob;
    if (dob) {
      const p = (n: number) => String(n).padStart(2, "0");
      const [y4, y2, mm, dd, m1, d1] = [String(dob.year), String(dob.year).slice(2), p(dob.month), p(dob.day!), String(dob.month), String(dob.day)];
      // Each order of its parts. A form with a one-digit month or day needs a separator between every two parts: "1 2 2019" is a date,
      // "12 2019" ("Session 12 — 2019 plan") is not.
      const forms = (parts: string[][], more: { short?: boolean }) => {
        for (const p of parts) {
          const oneDigit = p.some((x) => x.length === 1);
          const apart = oneDigit ? [p[0].length, p[0].length + p[1].length] : undefined;
          sequenceParts(p.join(""), { sentences: true, apart, ...more });
        }
      };
      const sequenceParts = (chars: string, more: { short?: boolean; sentences?: boolean; apart?: number[] }) => {
        if (!this.#sequences.some((s) => s.chars === chars && s.tag === "dob" && String(s.apart) === String(more.apart))) this.#sequences.push({ chars, minGaps: 0, uniform: false, tag: "dob", ...more });
      };
      forms([[mm, dd, y4], [m1, d1, y4], [dd, mm, y4], [d1, m1, y4], [y4, mm, dd], [y4, m1, d1]], {});
      // With a two-digit year the digits are few enough to occur by chance in a score row: hidden in a date's or a label's context only.
      forms([[mm, dd, y2], [dd, mm, y2], [m1, d1, y2], [d1, m1, y2]], { short: true });
    }
    // The last four digits of a sheet phone or ID after "ends", "ending", "ext." or "extension" ("ID ends 3210", "ext 0142").
    for (const [values, kind] of [[sheet.phones ?? [], "phone"], [sheet.ids ?? [], "id"]] as const) {
      for (const value of values) {
        const last4 = foldString(value).replace(/\D/gu, "").slice(-4);
        if (last4.length === 4) literal(new RegExp(`(?<=(?<![\\p{L}])(?:ends|ending|ext\\.?|extension)[ \\t]*[:#]?[ \\t]*)${last4}(?![\\p{N}])`, "gu"), kind);
      }
    }
    for (const phone of sheet.phones ?? []) {
      const digits = phoneKey(phone);
      sequence(digits, "phone");
      if (digits.length === 10) sequence(digits.slice(3), "phone");
    }
    for (const id of sheet.ids ?? []) {
      sequence(id, "id");
      const digitsPart = foldString(id).replace(/[^\p{L}\p{N}]/gu, "").replace(/^\p{L}+/u, "");
      if (digitsPart.length >= 6) sequence(digitsPart, "id");
    }
    for (const address of sheet.addresses ?? []) {
      const line = address.split(",")[0];
      sequence(line, "address", 3);
      // The ZIP code: whole anywhere ("33135", "FL,33135", "33135-0000"); with separators, in context only.
      const zips: string[] = address.match(/\b\d{5}\b/gu) ?? [];
      for (const zip of zips) sequence(zip, "zip", 0, false, { short: true });
      // The house number: with separators and in context only ("4 4 7 1 SW…").
      for (const n of address.match(/\b\d{3,}\b/gu) ?? []) {
        if (zips.includes(n)) continue;
        sequence(n, "address", 2, true, { short: true });
        // Written whole: after an address word only ("dirección 4471", "house number 4471", "lives at # 4471").
        sequence(n, "house", 0, false, { short: true });
      }
      for (const place of address.split(",").slice(1)) for (const word of tokensOf(place).filter((w) => /^\p{L}{4,}$/u.test(w))) sequence(word, "city", 2, true);
    }
    for (const school of sheet.schools ?? []) {
      const tokens = tokensOf(school);
      const core = tokens.filter((w) => !SCHOOL_GENERIC.has(w));
      for (const word of core.filter((w) => w.length >= 4)) sequence(word, "school", 2, true);
      // The distinctive words written as one ("sanjuanbosco"), and the initials, with dots or spaces, in capitals ("S.J.B.", "E S J B").
      if (core.length >= 2) sequence(core.join(""), "school");
      const initials = (words: string[]) => words.filter((w) => !ARTICLES.has(w)).map((w) => w[0]).join("");
      for (const acronym of [initials(tokens), initials(core), initials(tokens.slice(0, -1))]) if (acronym.length >= 3) sequence(acronym, "school", 0, false, { capitals: true });
    }
    const genericWords = [...SCHOOL_GENERIC].filter((w) => !ARTICLES.has(w)).map(brokenWord).join("|");
    (sheet.schools ?? []).forEach((school) => {
      const tokens = tokensOf(school);
      literal(phraseRegex(tokens.map((t) => [t]), true), "school");
      const core = tokens.filter((t) => !SCHOOL_GENERIC.has(t));
      if (core.length && core.length < tokens.length) {
        // The distinctive words alone ("José Martí"), with any generic words after them ("José Martí Elementary").
        literal(new RegExp(`${B}${core.map(brokenWord).join(SEPARATOR)}(?:${SEPARATOR}(?:${genericWords}))*${E}`, "gu"), "school", true);
        // Two or more distinctive words in a row ("Juan Bosco", "San Juan"): hidden; one alone: reported.
        for (let a = 0; a < core.length; a++) {
          for (let b = a + 2; b <= core.length; b++) {
            if (b - a === core.length) continue;
            literal(new RegExp(`${B}${core.slice(a, b).map(brokenWord).join(SEPARATOR)}(?:${SEPARATOR}(?:${genericWords}))*${E}`, "gu"), "school", true);
          }
        }
        for (const word of core.filter((w) => w.length >= 4)) {
          // One distinctive word with a generic word after it ("Martí Elementary"): hidden. Alone ("Martí."): possible.
          literal(new RegExp(`${B}${brokenWord(word)}(?:${SEPARATOR}(?:${genericWords}))+${E}`, "gu"), "school", true);
          this.#literals.push({ regex: new RegExp(`${B}${brokenWord(word)}${E}`, "gu"), kind: "school", capitalizedOnly: true, possible: "school-word" });
        }
      }
      // Its initials, in capitals: "JMES", "JME".
      const initials = tokens.filter((t) => !ARTICLES.has(t)).map((t) => t[0].toUpperCase());
      const acronyms = new Set([
        initials.join(""),
        initials.slice(0, -1).join(""),
        core.length ? core.map((t) => t[0].toUpperCase()).join("") + (tokens.find((t) => SCHOOL_GENERIC.has(t) && !ARTICLES.has(t))?.[0].toUpperCase() ?? "") : "",
        // The distinctive words alone: "SJB" for Escuela San Juan Bosco.
        core.map((t) => t[0].toUpperCase()).join(""),
      ]);
      for (const acronym of [...acronyms].filter((a) => a.length >= 3)) {
        this.#literals.push({ regex: new RegExp(`(?<![\\p{L}\\p{N}])${acronym}(?![\\p{L}\\p{N}])`, "gu"), kind: "school", capitalizedOnly: false, original: true });
      }
    });
    const places = new Map<string, string>();
    (sheet.addresses ?? []).forEach((address) => {
      const parsed = parseAddress(address);
      for (const regex of parsed.regexes) literal(regex, "address");
      literal(phraseRegex(tokensOf(address).map((t) => [...(ADDRESS_SPELLINGS.get(canonicalAddressWord(t)) ?? [t]), t])), "address");
      for (const place of parsed.places) if (!places.has(foldString(place))) places.set(foldString(place), place);
    });
    // The city or neighborhood of each sheet address, also alone ("lives in Hialeah"): HIPAA Safe Harbor counts it (owner's decision, 2026-11-22).
    for (const place of places.values()) {
      const tokens = tokensOf(place);
      const common = tokens.every((t) => isCommonWordName(t) || COMMON_PLACE_WORDS.has(t));
      literal(phraseRegex(tokens.map((t) => [t]), true), "city", common);
    }
    (sheet.phones ?? []).forEach((phone) => {
      const digits = phoneKey(phone);
      literal(compactRegex(digits), "phone");
      // The number without its area code: "555-0142".
      if (digits.length === 10) literal(compactRegex(digits.slice(3)), "phone");
    });
    (sheet.emails ?? []).forEach((email) => {
      literal(new RegExp(`${B}${escape(foldString(email.trim()))}${E}`, "gu"), "email");
    });
    (sheet.ids ?? []).forEach((id) => {
      const compact = id.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      literal(compactRegex(id), "id");
      // The digits without a letter prefix: "123456789" for "FL123456789".
      const digitsPart = compact.replace(/^\p{L}+/u, "");
      if (digitsPart !== compact && digitsPart.length >= 6) literal(compactRegex(digitsPart), "id");
    });
    (sheet.other ?? []).forEach((other) => {
      literal(phraseRegex(tokensOf(other).map((t) => [t]), true), "other");
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

  /** How many numbered variants each person's forms have, for their numbers. */
  readonly #variantCounts = new Map<string, number>();

  /** A base form: the sheet's preferred name (or first name), whole name, whole surname, initials. */
  #baseSlot(person: Person, form: NameForm): void {
    const key = personKey(person, form);
    if (this.#slots.has(key)) return;
    const { firstName, lastName, nicknames, preferredName } = person.sheet;
    const first = (preferredName ?? firstName ?? nicknames?.[0] ?? lastName ?? "").trim();
    const full = [firstName ?? preferredName, lastName].filter(Boolean).join(" ").trim();
    const value = { first, full: full || first, last: (lastName ?? first).trim(), initials: person.initials?.toUpperCase() ?? first }[form];
    this.#slots.set(key, { placeholder: personPlaceholder(person.group, person.index, form), value, kind: person.group });
  }

  /** A form written otherwise ("José" of "María José", "la Fuente", "Gómez-Ficticio", "Lucy"): its own number, restored as those words. */
  #variantSlot(person: Person, form: NameForm, key: string, value: string): void {
    if (this.#slots.has(key)) return;
    const counter = `${person.priority}:${form}`;
    const n = (this.#variantCounts.get(counter) ?? 0) + 1;
    this.#variantCounts.set(counter, n);
    this.#slots.set(key, { placeholder: personPlaceholder(person.group, person.index, form, String(n)), value, kind: person.group });
  }

  /** Whether the words found are the sheet's own whole form: the whole given name or a whole nickname, the whole name, the whole surname. */
  /**
   * Whether the text wrote the sheet's own whole form exactly, case, accents and spaces included:
   * the preferred (or first) name, the whole name, the whole surname. "MATEO", "Lucia",
   * "ficticio gómez" and "Mateo⏎Ficticio Gómez" are other forms, each restored as written.
   */
  #isBase(person: Person, form: NameForm, original: string): boolean {
    if (form === "initials") return true;
    const clean = (s: string | undefined) => (s ? s.normalize("NFC").trim().replace(/\s+/gu, " ") : undefined);
    const used = original.normalize("NFC");
    const { firstName, lastName, preferredName } = person.sheet;
    // [CLIENT] is the preferred name the model writes in its own prose, restored as such: the base form is that name exactly.
    if (form === "first") return used === clean(preferredName ?? firstName);
    if (form === "last") return used === clean(lastName);
    return used === clean([firstName ?? preferredName, lastName].filter(Boolean).join(" "));
  }

  #nameCandidate(person: Person, form: NameForm, start: number, end: number, original: string, _words: string[], asWritten: boolean): Candidate {
    // A sheet nickname written exactly as the sheet writes it: [CLIENT NICKNAME], restored as written.
    const nicknames = (person.sheet.nicknames ?? []).filter((n) => n.trim() !== person.sheet.preferredName?.trim());
    const nickname = form === "first" && !asWritten ? nicknames.findIndex((n) => n.normalize("NFC").trim().replace(/\s+/gu, " ") === original.normalize("NFC")) : -1;
    if (nickname !== -1) {
      const key = `person:${person.priority}:nickname:${nickname}`;
      const value = nicknames[nickname].trim();
      return { start, end, key, kind: person.group, source: "sheet", rank: 0, create: () => this.#slots.has(key) || this.#slots.set(key, { placeholder: nicknamePlaceholder(person.group, person.index, nickname, nicknames.length), value, kind: person.group }) };
    }
    if (!asWritten && this.#isBase(person, form, original)) {
      return { start, end, key: personKey(person, form), kind: person.group, source: "sheet", rank: 0, create: () => this.#baseSlot(person, form) };
    }
    // Written otherwise: its own number, restored byte for byte as written ("Del Rio de la Fuente", "Fic-⏎ticio": line breaks kept).
    const value = original;
    const key = asWritten ? `person:${person.priority}:${form}:w:${original}` : `person:${person.priority}:${form}:v:${original}`;
    return { start, end, key, kind: person.group, source: "sheet", rank: 0, create: () => this.#variantSlot(person, form, key, value) };
  }

  #numberedSlot(key: string, kind: NumberedKind, original: string): void {
    if (!this.#slots.has(key)) {
      const n = (this.#counters.get(kind) ?? 0) + 1;
      this.#counters.set(kind, n);
      this.#slots.set(key, { placeholder: numberedPlaceholder(kind, n), value: original, kind });
    }
  }

  /**
   * Short forms of a sheet school: a distinctive word or the distinctive words' initials before
   * a school word ("Marti ES", "Martí MS", "JM Elementary", "J.M. Elem.", "SJB Escuela"). "ES",
   * "MS", "HS" and the initials count in capitals only ("Martí es" is Spanish for "Martí is").
   */
  #schoolShortForms(text: string, folded: Folded, candidates: Candidate[]): void {
    const schools = this.#sheet.schools ?? [];
    if (schools.length === 0) return;
    const after = "(?:es|ms|hs|k-?8|elem\\.?|elementary|middle|high|school|academy|esc\\.?|escuela|colegio|prep|charter)";
    for (const school of schools) {
      const core = tokensOf(school).filter((t) => !SCHOOL_GENERIC.has(t) && !ARTICLES.has(t));
      if (core.length === 0) continue;
      const initials = core.length >= 2 ? core.map((t) => `${t[0]}\\.?[ \\t]?`).join("") : "";
      const words = core.filter((w) => w.length >= 4);
      const heads = [...words, ...(initials ? [initials] : [])];
      if (heads.length === 0) continue;
      const regex = new RegExp(`(?<![\\p{L}\\p{N}])(${heads.join("|")})[ \\t]+(${after})(?![\\p{L}\\p{N}])`, "gdu");
      for (const m of folded.text.matchAll(regex)) {
        if (!m.indices) continue;
        const [start, end] = originalRange(folded, m.index, m.index + m[0].length);
        const [hs, he] = originalRange(folded, m.indices[1][0], m.indices[1][1]);
        const [gs, ge] = originalRange(folded, m.indices[2][0], m.indices[2][1]);
        const head = text.slice(hs, he);
        const generic = text.slice(gs, ge);
        const isInitials = !words.includes(m[1]);
        if (isInitials && head.replace(/[^\p{L}]/gu, "") !== head.replace(/[^\p{L}]/gu, "").toUpperCase()) continue;
        if (!isInitials && !/^\p{Lu}/u.test(head)) continue;
        if (/^(?:es|ms|hs)$/iu.test(generic) && generic !== generic.toUpperCase()) continue;
        const original = text.slice(start, end);
        const key = valueKey("school", original);
        candidates.push({ start, end, key, kind: "school", source: "sheet", rank: 1, create: () => this.#numberedSlot(key, "school", original) });
      }
    }
  }

  /**
   * The birthday's month and day written right next to a date of birth ("3 14 2020 3 14",
   * "3 14 | 03 14 2020"): hidden as [DOB MONTH AND DAY], whatever reading of the numbers wins.
   */
  #adjacentBirthdays(text: string, candidates: Candidate[]): void {
    const dob = this.#dob;
    if (!dob) return;
    const isBirthday = (a: string, b: string) => (+a === dob.month && +b === dob.day) || (+b === dob.month && +a === dob.day);
    const extra: Candidate[] = [];
    for (const c of candidates) {
      if (c.kind !== "dob" || !c.key.startsWith("dob:full:")) continue;
      const after = /^(?:[ \t|,;]|\r?\n|(?<![\p{L}])(?:and|y|or|o|then|also)(?![\p{L}])){1,6}(\d{1,2})[ \t|/.-]{1,3}(\d{1,2})(?![\d/.-]*\d)/iu.exec(text.slice(c.end, c.end + 20));
      if (after && isBirthday(after[1], after[2])) {
        const start = c.end + after[0].indexOf(after[1]);
        const end = c.end + after[0].length;
        extra.push(this.#dobCandidate(start, end, "month-day", text.slice(start, end), 0));
      }
      const before = /(?<![\d/.-])(\d{1,2})[ \t|/.-]{1,3}(\d{1,2})(?:[ \t|,;]|\r?\n|(?<![\p{L}])(?:and|y|or|o|then|also)(?![\p{L}])){1,6}$/u.exec(text.slice(Math.max(0, c.start - 20), c.start));
      if (before && isBirthday(before[1], before[2])) {
        const start = c.start - before[0].length;
        const end = start + before[0].length - (before[0].length - before[0].lastIndexOf(before[2]) - before[2].length);
        extra.push(this.#dobCandidate(start, end, "month-day", text.slice(start, end), 0));
      }
    }
    candidates.push(...extra);
  }

  /** The date of birth, or a part of it, as written: each written form its own placeholder, restored exactly as written. */
  #dobCandidate(start: number, end: number, form: BirthDateForm, original: string, rank: number): Candidate {
    const key = `dob:${form}:${original}`;
    return { start, end, key, kind: "dob", source: "sheet", rank, create: () => this.#birthSlot(key, form, original) };
  }

  /** [DOB] for the first written form met, [DOB 2], [DOB 3] for the others ("03/14/2020", then "March 14, 2020"); the same for each part. */
  #birthSlot(key: string, form: BirthDateForm, original: string): void {
    if (this.#slots.has(key)) return;
    const n = (this.#birthCounts.get(form) ?? 0) + 1;
    this.#birthCounts.set(form, n);
    this.#slots.set(key, { placeholder: birthDatePlaceholder(form, n), value: original, kind: "dob" });
  }

  deidentify(input: string): DeidentifyResult {
    if (input.length > MAX_TEXT_LENGTH) throw new RangeError(`A text to de-identify is limited to ${MAX_TEXT_LENGTH} characters.`);
    const text = input.normalize("NFC");
    const folded = fold(text);
    const candidates: Candidate[] = [];
    const possible: Possible[] = [];
    const range = (start: number, end: number) => originalRange(folded, start, end);
    const capitalized = (start: number) => /^\p{Lu}/u.test(text.slice(start, start + 2));

    // Inside a URL, an email address or a file name a name is restored byte for byte, never respelled.
    const links = [...text.matchAll(LINKS)].map((m) => [m.index, m.index + m[0].length] as const);
    const inLink = (start: number, end: number) => links.some(([a, b]) => a < end && start < b);
    for (const match of findNames(folded, this.#people)) {
      const [start, end] = range(match.start, match.end);
      const { person, form } = match;
      if (match.ambiguous && this.#commonWordNames === "capitalized" && !capitalized(start)) {
        possible.push({ text: text.slice(start, end), start, end, reason: "common-word-name", placeholder: personPlaceholder(person.group, person.index, form), kind: person.group, hidden: false });
        continue;
      }
      if (match.shared) {
        // Two people on the sheet fit: sent as a neutral [NAME n], restored as written, and shown for review.
        const original = text.slice(start, end);
        const key = `shared:${foldString(original)}`;
        candidates.push({ start, end, key, kind: "unlisted-name", source: "sheet", rank: 0, create: () => this.#numberedSlot(key, "unlisted-name", original), sharedWith: match.shared });
        continue;
      }
      candidates.push(this.#nameCandidate(person, form, start, end, text.slice(start, end), match.words, inLink(start, end)));
    }
    for (const part of [...findJoinedNames(folded, text, this.#people), ...findBrokenNames(folded, text, this.#people), ...findOcrNames(folded, this.#people)]) {
      const [start, end] = range(part.start, part.end);
      const form: NameForm = part.role === "given" ? "first" : "last";
      if (part.uncertain) {
        // "a dam", "no el", "mate o": two ordinary words as likely as a split name. Left as written, shown for review.
        possible.push({ text: text.slice(start, end), start, end, reason: "split-name", placeholder: personPlaceholder(part.person.group, part.person.index, form), kind: part.person.group, hidden: false });
        continue;
      }
      if (!part.joined) {
        possible.push({ text: text.slice(start, end), start, end, reason: "name-inside-word", placeholder: personPlaceholder(part.person.group, part.person.index, form), kind: part.person.group, hidden: false });
        continue;
      }
      candidates.push(this.#nameCandidate(part.person, form, start, end, text.slice(start, end), [part.word], true));
    }
    this.#nicknameCandidates(text, folded, possible);
    for (const literal of this.#literals) {
      const haystack = literal.original ? text : folded.text;
      for (const m of haystack.matchAll(literal.regex)) {
        const [start, end] = literal.original ? [m.index, m.index + m[0].length] : range(m.index, m.index + m[0].length);
        if (literal.capitalizedOnly && !capitalized(start)) continue;
        if (literal.possible) {
          possible.push({ text: text.slice(start, end), start, end, reason: literal.possible, placeholder: numberedPlaceholder(literal.kind, (this.#counters.get(literal.kind) ?? 0) + 1), kind: literal.kind, hidden: false });
          continue;
        }
        let from = start;
        if (literal.kind === "phone" && text[start - 1] === "(" && text.slice(start, end).includes(")")) from--;
        const original = text.slice(from, end);
        const key = valueKey(literal.kind, original);
        candidates.push({ start: from, end, key, kind: literal.kind, source: "sheet", rank: 1, create: () => this.#numberedSlot(key, literal.kind, original) });
      }
    }
    // Where a possible sheet value is already listed: one report for overlapping matches.
    const reportedValue = new Uint8Array(text.length);
    for (const match of findSequences(folded, text, this.#sequences).sort((a, b) => b.end - b.start - (a.end - a.start))) {
      const [found, foundEnd] = range(match.start, match.end);
      // "(305)555-0142": the opening bracket goes with the number, so the text keeps no lone "(".
      // The same for "[305] 555 0142" and "{305}5550142": the bracket goes with the number, never left to pair with the placeholder's.
      const opening = text[found - 1];
      const closing = opening === "(" ? ")" : opening === "[" ? "]" : opening === "{" ? "}" : "";
      const start = match.tag === "phone" && closing && text.slice(found, foundEnd).includes(closing) ? found - 1 : found;
      // A ZIP code takes its +4: "33135-0000".
      const plus4 = match.tag === "zip" ? /^[-\u{2013}]\d{4}(?!\d)/u.exec(text.slice(foundEnd, foundEnd + 6)) : null;
      const end = plus4 ? foundEnd + plus4[0].length : foundEnd;
      const original = text.slice(start, end);
      // A value that can occur by chance in a score row: hidden in a date's or a label's context only, otherwise listed for review.
      // A whole ZIP code after a counting word ("Room 33135", "Total 33135") is that count; anywhere else it is the ZIP.
      const counted = (match.tag === "zip" || match.tag === "house") && match.whole && !plus4 && COUNT_BEFORE.test(text.slice(Math.max(0, start - 20), start));
      const house = match.tag === "house" || (match.tag === "address" && match.short);
      const listed = match.tag === "dob" && !match.dateLike && numbersListContext(text, start, end, original, this.#dob);
      const inContext = house ? houseInContext(text, start, end) : shortInContext(text, start, end, { dateLike: match.tag === "dob" && match.dateLike }, this.#clientNames);
      if (counted || ((needsContext(match) || listed) && !inContext)) {
        if (reportedValue.subarray(start, end).some((v) => v === 1)) continue;
        reportedValue.fill(1, start, end);
        possible.push({ text: original, start, end, reason: "possible-sheet-value", placeholder: match.tag === "dob" ? "[DOB]" : numberedPlaceholder("address", (this.#counters.get("address") ?? 0) + 1), kind: match.tag === "dob" ? "dob" : "address", hidden: false });
        continue;
      }
      if (match.tag === "dob") {
        candidates.push(this.#dobCandidate(start, end, "full", original, 1));
        continue;
      }
      const kind = (match.tag === "zip" || match.tag === "house" ? "address" : match.tag) as NumberedKind;
      const key = valueKey(kind, original);
      candidates.push({ start, end, key, kind, source: "sheet", rank: 1, create: () => this.#numberedSlot(key, kind, original) });
    }
    this.#dateCandidates(text, folded, candidates, possible);
    for (const match of findPatterns(text)) candidates.push(this.#patternCandidate(text, match));
    for (const { start, end } of findAgeDays(text)) {
      candidates.push({ start, end, key: "", kind: "date", source: "pattern", rank: -1, create: () => {}, drop: true });
    }

    this.#schoolShortForms(text, folded, candidates);
    this.#adjacentBirthdays(text, candidates);
    const accepted = resolve(text, pickDates(candidates));

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
        if (span.source === "sheet") this.#sheetKeys.add(span.key);
        // Once a person is mentioned, the model may use any form of their name: all of them restore.
        const person = this.#people.find((p) => span.key.startsWith(`person:${p.priority}:`));
        if (person) for (const form of NAME_FORMS) if (form !== "initials" || person.initials) this.#baseSlot(person, form);
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
    const seen = new Set<string>();
    const unique = reported
      .filter((p) => {
        const at = `${p.start}:${p.end}`;
        if (seen.has(at)) return false;
        seen.add(at);
        return true;
      })
      .sort((a, b) => a.start - b.start);
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

  #dateCandidates(text: string, folded: Folded, candidates: Candidate[], possible: Possible[]): void {
    const dob = this.#dob;
    if (dob) {
      // The date of birth as a day of the year: "the 74th day of 2020", "2020-074", "día 74 de 2020".
      const doy = Math.round((Date.UTC(dob.year, dob.month - 1, dob.day!) - Date.UTC(dob.year, 0, 0)) / 86_400_000);
      const day = `0{0,2}${doy}(?:st|nd|rd|th|o)?`;
      const dayOfYear = new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${day}[ \\t]+day[ \\t]+of[ \\t]+(?:the[ \\t]+year[ \\t]+)?${dob.year}|${dob.year}[-/. ]?0{0,2}${doy}|dia[ \\t]+${day}[ \\t]+(?:del?[ \\t]+)?(?:ano[ \\t]+)?${dob.year})(?![\\p{N}])`,
        "gu",
      );
      for (const m of folded.text.matchAll(dayOfYear)) {
        const [start, end] = originalRange(folded, m.index, m.index + m[0].length);
        const original = text.slice(start, end);
        candidates.push(this.#dobCandidate(start, end, "full", original, 0));
      }
      // The month and day after a birthday word, with a space or a bar between them: "Bday 3 14", "cumple 14 3", "DOB | 3 | 14".
      const birthdayPair = /(?<![\p{L}])(?:dob|d\.o\.b\.?|b-?day|birthday|birthdate|born|b\.|cumple\p{L}*|nacid[oa]|nacimiento|f\.?\s?nac\.?)(?![\p{L}])[^.;!?\n\d]{0,25}?(?<!\d)(\d{1,2})(?:[ \t]+|[ \t]*\|[ \t]*)(\d{1,2})(?!\d)(?![ \t]*[|/.\-,]?[ \t]*\d)/dgu;
      for (const m of folded.text.matchAll(birthdayPair)) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (!((a === dob.month && b === dob.day) || (b === dob.month && a === dob.day)) || !m.indices) continue;
        const [start, end] = originalRange(folded, m.indices[1][0], m.indices[2][1]);
        const original = text.slice(start, end);
        candidates.push(this.#dobCandidate(start, end, "month-day", original, 0));
      }
    }
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
      // Six or eight bare digits, or "3/14": only when they are the date of birth. Numbers apart only by spaces: also after a date label.
      if ((date.compact || date.pair) && !isBirthDate) continue;
      // A month and day in numbers ("3/14") equal to the birthday: only after a birthday word in the same clause. Alone it is as often a
      // trial ratio ("8/10, 9/10"): left as written, and listed for review unless it reads as a ratio.
      // The month and year of birth in numbers ("12/2012") only after a birth word or label: alone it is as often an edition or a session month.
      if (isBirthDate && date.precision === "month-year" && /^\d/u.test(original) && !birthdayBefore(text, start) && !/(?<![\p{L}])born(?:[ \t]+in)?[ \t]*:?[ \t]*$/iu.test(text.slice(Math.max(0, start - 12), start)) && !shortInContext(text, start, end, { dateLike: false }, null)) {
        possible.push({ text: original, start, end, reason: "possible-sheet-value", placeholder: "[DOB MONTH AND YEAR]", kind: "dob", hidden: false });
        continue;
      }
      // A ratio stays a ratio, birthday word or not: "Bday week data: 8/10, 3/14, 9/10", "On his birthday he scored 8/10".
      if (date.pair && (ratioContext(text, start, end) || !birthdayBefore(text, start))) {
        // Listed for review unless it is only a ratio; a ratio after a birthday word is listed too, never passed silently.
        if (!ratioContext(text, start, end) || birthdayBefore(text, start)) possible.push({ text: original, start, end, reason: "possible-sheet-value", placeholder: "[DOB MONTH AND DAY]", kind: "dob", hidden: false });
        continue;
      }
      if (date.loose && !isBirthDate && !date.labelled) continue;
      // Three numbers apart only by spaces or bars that read as the date of birth: in a label's context only ("DOB 03 14 2020"), never in a
      // score row ("Raw scores | 21 | 7 | 19 | 3 | 14 | 20"), where it is listed for review.
      if (date.loose && isBirthDate && (!/\d{4}/u.test(original) || numbersListContext(text, start, end, original, dob)) && !shortInContext(text, start, end, { dateLike: false }, this.#clientNames)) {
        possible.push({ text: original, start, end, reason: "possible-sheet-value", placeholder: "[DOB]", kind: "dob", hidden: false });
        continue;
      }
      // Labelled fields: only the values are hidden, the labels stay ("Birth month: [DOB MONTH]; birth day: [DOB DAY]; birth year: 2020").
      if (date.fields) {
        const parts: Array<[[number, number], BirthDateForm]> = [[date.fields.month, "month"], [date.fields.day, "day"]];
        for (const [[a, b], form] of parts) {
          const [s, e] = originalRange(folded, a, b);
          const written = text.slice(s, e);
          if (isBirthDate) candidates.push(this.#dobCandidate(s, e, form, written, 0));
          else {
            const key = `date:${ymdKey(date.readings[0])}:${form}:${written}`;
            candidates.push({ start: s, end: e, key, kind: "date", source: "pattern", rank: 2, create: () => this.#numberedSlot(key, "date", written) });
          }
        }
        continue;
      }
      // "CA = 6-08-08" after an age label is an age (its days are dropped), not a date, unless it is the date of birth.
      if (!isBirthDate && AGE_BEFORE.test(text.slice(Math.max(0, start - 40), start))) continue;
      if (isBirthDate) {
        candidates.push(this.#dobCandidate(start, end, date.precision, original, 0));
        continue;
      }
      if (date.precision !== "full") continue;
      // A birthday in another year ("he turned 6 on 03/14/2026") gives the date of birth away: always hidden.
      // In this year or a later one, a numeric date is a session date read month first ("10/02/2026" is October 2), unless its day is over 12.
      const thisYear = this.#today.getUTCFullYear();
      const readings = date.readings.length > 1 && date.readings[0].year >= thisYear ? [date.readings[0]] : date.readings;
      const anniversary = dob !== null && readings.some((r) => r.month === dob.month && r.day === dob.day);
      const hide = anniversary || this.#dates === "all" || date.readings.some((r) => ymdKey(r) < cutoff);
      if (!hide) continue;
      // Each written form of a date has its own placeholder, restored as written ("Jan 5 '24" and "5 Jan 24" are two).
      const key = `date:${ymdKey(date.readings[0])}:${original}`;
      candidates.push({ start, end, key, kind: "date", source: "pattern", rank: 2, create: () => this.#numberedSlot(key, "date", original) });
    }
  }

  #patternCandidate(text: string, match: PatternMatch): Candidate {
    const original = text.slice(match.start, match.end);
    const key = match.kind === "unlisted-name" ? match.key : valueKey(match.kind, original);
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
  const accepted = new Spans<Candidate>(text.length);
  for (const candidate of ordered) {
    if (candidate.end <= candidate.start) continue;
    const overlaps = accepted.overlapping(candidate.start, candidate.end);
    if (overlaps.length === 0) {
      accepted.add(candidate);
      continue;
    }
    // A losing date is dropped, never cut into new dates ("2020. 03 14" against "3 14 2020"): what it covered is someone else's.
    if (candidate.drop || candidate.kind === "date" || candidate.kind === "dob") continue;
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
      // A leftover that is only a particle ("de" of "Lucía Ficticio de Gómez") is not a name.
      if (a + lead < b - trail && !/^(?:de|del|la|las|los|y|e|da|di|do|du|van|von|le)$/iu.test(text.slice(a + lead, b - trail))) {
        accepted.add({ ...candidate, start: a + lead, end: b - trail, piece: true });
      }
    }
  }
  return accepted;
}

/**
 * Overlapping readings of dates, the date of birth included, are settled left to right: the
 * reading that starts first wins (at the same start, the longer one; one that holds the
 * other whole wins over it), and the others are dropped, never cut into pieces. So
 * "03 14 2020 | 03 14 2020" is two dates of birth, never "03 14 [DOB] 2020" through the
 * year-first reading "2020 | 03 14" that straddles them.
 */
function pickDates(candidates: Candidate[]): Candidate[] {
  const dates = candidates.filter((c) => c.kind === "dob" || c.kind === "date").sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.rank - b.rank);
  const lost = new Set<Candidate>();
  let last: Candidate | null = null;
  for (const c of dates) {
    if (last === null || c.start >= last.end) {
      last = c;
      continue;
    }
    if (c.start <= last.start && c.end >= last.end && c.end - c.start > last.end - last.start) {
      lost.add(last);
      last = c;
    } else lost.add(c);
  }
  return lost.size ? candidates.filter((c) => !lost.has(c)) : candidates;
}

/** De-identifies one text. For several texts of one request, use one Deidentifier. */
export function deidentify(text: string, sheet: ClientSheet, options?: DeidentifyOptions): DeidentifyResult {
  return new Deidentifier(sheet, options).deidentify(text);
}
