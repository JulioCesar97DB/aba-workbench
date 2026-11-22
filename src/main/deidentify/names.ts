/*
 * Finds the sheet's people in a text: full names, first names, nicknames and surnames
 * alone, in any case, with or without accents, with possessives ("Mateo's"), across a
 * line break, with a surname hyphenated or split at the end of a line ("Fic-\nticio"),
 * as "Last, First", with initials ("Mateo F.", "M. Ficticio") and as dotted initials ("M.F.").
 *
 * A name is read as a run of words that all belong to one person. The longest run
 * wins; when two people share it (a surname alone shared by the client and a
 * caregiver), the one listed first wins: client, caregivers, family, professionals.
 */
import { isCommonWordName } from "./common-words.ts";
import { foldString, type Folded } from "./fold.ts";
import type { ClientSheet, PersonGroup, SheetPerson } from "./sheet.ts";

export type NameForm = "first" | "full" | "last" | "initials";

/** Words that join surnames ("de la Cruz", "Ficticio y Gómez") and are never hidden alone. */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e", "van", "von", "der", "den", "da", "di", "do", "dos", "das", "du", "le", "st"]);

type Role = "given" | "surname" | "particle";

export interface Person {
  group: PersonGroup;
  /** Position in its group (caregiver 1 is 0). */
  index: number;
  /** Lower is preferred when two people share a run. */
  priority: number;
  sheet: SheetPerson;
  roles: Map<string, Set<Role>>;
  givenInitials: Set<string>;
  surnameInitials: Set<string>;
  /** "m.f." style initials, folded with no spaces. */
  initials?: string;
  /** The surname's words in order, particles included: "ejemplar de la fuente". */
  surnameSequence: string;
  /** The surname's words without particles, in order: what [CLIENT LAST NAME 1], [CLIENT LAST NAME 2] stand for. */
  surnames: string[];
  /** Every name word of 3 letters or more, with its role: for names joined to other text or letter-spaced (3-letter ones only when clearly joined). */
  longWords: Array<{ word: string; role: "given" | "surname" }>;
}

export interface NameMatch {
  person: Person;
  form: NameForm;
  start: number;
  end: number;
  /** One full word only, and that word is an everyday word ("Will", "Rosa"). */
  ambiguous: boolean;
  /** The surname words used, folded, in order ("ficticio", "de la fuente"). */
  surnameWords: string;
  /** For a surname alone: which of the sheet's surnames it is ("1", "2", "1 2"), or "" for all of them. */
  surnamePart: string;
  /** Two or more people on the sheet fit this mention equally (a father who shares the client's first name). */
  shared?: Person[];
}

function parts(name: string | undefined): string[] {
  if (!name) return [];
  return foldString(name)
    .split(/[\s-]+/u)
    .map((part) => part.replace(/[^\p{L}']/gu, ""))
    .filter(Boolean);
}

function addRole(roles: Map<string, Set<Role>>, word: string, role: Role): void {
  if (!roles.has(word)) roles.set(word, new Set());
  roles.get(word)!.add(role);
}

export function peopleOf(sheet: ClientSheet): Person[] {
  const groups: Array<[PersonGroup, SheetPerson[]]> = [
    ["client", [sheet.client]],
    ["caregiver", sheet.caregivers ?? []],
    ["family", sheet.family ?? []],
    ["professional", sheet.professionals ?? []],
  ];
  const people: Person[] = [];
  for (const [group, list] of groups) {
    list.forEach((sheetPerson, index) => {
      const roles = new Map<string, Set<Role>>();
      const given = [...parts(sheetPerson.firstName), ...(sheetPerson.nicknames ?? []).flatMap(parts), ...parts(sheetPerson.preferredName)];
      const surnames = parts(sheetPerson.lastName);
      for (const word of given) if (!PARTICLES.has(word)) addRole(roles, word, "given");
      // Spanish diminutives of each given name and nickname: "Mateíto", "Teíto", "Carmencita", "Valerita".
      for (const word of given) for (const d of diminutives(word)) if (!roles.has(d) && !isCommonWordName(d)) addRole(roles, d, "given");
      for (const word of surnames) addRole(roles, word, PARTICLES.has(word) ? "particle" : "surname");
      if (roles.size === 0) return;
      const firstGiven = parts(sheetPerson.firstName).find((w) => !PARTICLES.has(w));
      const firstSurname = surnames.find((w) => !PARTICLES.has(w));
      people.push({
        group,
        index,
        priority: people.length,
        sheet: sheetPerson,
        roles,
        givenInitials: new Set(given.filter((w) => !PARTICLES.has(w)).map((w) => w[0])),
        surnameInitials: new Set(surnames.filter((w) => !PARTICLES.has(w)).map((w) => w[0])),
        initials: firstGiven && firstSurname ? `${firstGiven[0]}.${firstSurname[0]}.` : undefined,
        surnameSequence: ` ${surnames.join(" ")} `,
        surnames: surnames.filter((w) => !PARTICLES.has(w)),
        longWords: [...roles.entries()].flatMap(([word, set]) =>
          word.length >= 3 && !set.has("particle") ? [{ word, role: set.has("given") ? ("given" as const) : ("surname" as const) }] : [],
        ),
      });
    });
  }
  return people;
}

/** -ito/-ita, -cito/-cita, -illo/-illa forms of a given name, folded. */
function diminutives(word: string): string[] {
  if (word.length < 3 || PARTICLES.has(word)) return [];
  const stem = word.replace(/[aeo]$/u, "");
  const out = new Set<string>();
  for (const suffix of ["ito", "ita", "illo", "illa"]) out.add(stem.endsWith("i") ? `${stem}${suffix.slice(1)}` : `${stem}${suffix}`);
  if (/[nrl]$/u.test(word) || /[eo]$/u.test(word)) for (const suffix of ["cito", "cita"]) out.add(`${word}${suffix}`);
  return [...out].filter((d) => d.length >= 5 && d !== word);
}

interface Word {
  start: number;
  end: number;
  text: string;
}

const WORD = /\p{L}+(?:'\p{L}+)*/gu;

function wordsOf(folded: string): Word[] {
  return [...folded.matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}

/** What may stand between two words of one name. */
const JOIN = /^(?:[ \t]*(?:\r?\n)?[ \t]*|[ \t]*-[ \t]*(?:\r?\n)?[ \t]*)$/u;
const JOIN_AFTER_INITIAL = /^\.[ \t]*(?:\r?\n)?[ \t]*$/u;
const HYPHEN_BREAK = /^-[ \t]*\r?\n[ \t]*$/u;
const COMMA = /^,[ \t]*(?:\r?\n)?[ \t]*$/u;

/** The most words one name can have. */
const MAX_RUN = 8;

interface Piece {
  /** Index of the last word used (a hyphenated line break uses two). */
  last: number;
  start: number;
  end: number;
  role: Role | "given-initial" | "surname-initial";
  word: string;
}

/** The word at `i` as a part of `person`'s name, joining "Fic-\nticio" when that makes a name. */
function pieceAt(text: string, words: Word[], i: number, person: Person): Piece | null {
  const word = words[i];
  const next = words[i + 1];
  if (next && HYPHEN_BREAK.test(text.slice(word.end, next.start))) {
    const joined = word.text + next.text;
    const role = bestRole(person.roles.get(joined));
    if (role) return { last: i + 1, start: word.start, end: next.end, role, word: joined };
  }
  let base = word.text;
  let end = word.end;
  if (base.endsWith("'s") && !person.roles.has(base)) {
    base = base.slice(0, -2);
    end -= 2;
  }
  const role = bestRole(person.roles.get(base));
  if (role) return { last: i, start: word.start, end, role, word: base };
  // "the Ficticios", "Valerias toys", "Mateos": a name with a plural or possessive s and no apostrophe.
  if (base.length > 3 && base.endsWith("s")) {
    const plural = bestRole(person.roles.get(base.slice(0, -1)));
    if (plural && plural !== "particle") return { last: i, start: word.start, end: end - 1, role: plural, word: base.slice(0, -1) };
  }
  if (base.length === 1 && text[word.end] === ".") {
    if (person.givenInitials.has(base)) return { last: i, start: word.start, end: word.end + 1, role: "given-initial", word: base };
    if (person.surnameInitials.has(base)) return { last: i, start: word.start, end: word.end + 1, role: "surname-initial", word: base };
  }
  return null;
}

function bestRole(roles: Set<Role> | undefined): Role | null {
  if (!roles) return null;
  if (roles.has("given")) return "given";
  if (roles.has("surname")) return "surname";
  return roles.has("particle") ? "particle" : null;
}

function runAt(text: string, words: Word[], i: number, person: Person): { pieces: Piece[]; next: number } | null {
  const pieces: Piece[] = [];
  let j = i;
  let usedComma = false;
  let initialsInARow = 0;
  while (j < words.length && pieces.length < MAX_RUN) {
    const piece = pieceAt(text, words, j, person);
    // "Will will": the same word twice is not one name.
    if (!piece || pieces.some((p) => p.word === piece.word && p.role !== "given-initial" && p.role !== "surname-initial")) break;
    // At most two initials in a row ("J. M. Peña"): "M. M. M. ..." is not a name, and stays linear.
    initialsInARow = piece.role === "given-initial" || piece.role === "surname-initial" ? initialsInARow + 1 : 0;
    if (initialsInARow > 2) break;
    pieces.push(piece);
    j = piece.last + 1;
    if (j >= words.length) break;
    // A possessive or a plural s ends a name.
    if (piece.end !== words[piece.last].end && piece.role !== "given-initial" && piece.role !== "surname-initial") break;
    const between = text.slice(piece.end, words[j].start);
    if (piece.role === "given-initial" || piece.role === "surname-initial") {
      if (!JOIN.test(between) && !JOIN_AFTER_INITIAL.test(between) && between !== "") break;
      continue;
    }
    if (JOIN.test(between)) continue;
    // "Ficticio, Mateo": surnames, a comma, then a given name of the same person.
    if (!usedComma && COMMA.test(between) && pieces.every((p) => p.role === "surname" || p.role === "particle")) {
      const after = pieceAt(text, words, j, person);
      if (after && after.role === "given") {
        usedComma = true;
        continue;
      }
    }
    break;
  }
  // Particles only count between surnames; initials only next to a full word.
  while (pieces.length && pieces.at(-1)!.role === "particle") pieces.pop();
  // Leading particles stay when the sheet's surname has them there ("de la Fuente"), not otherwise ("la Cruz").
  const lead = pieces.findIndex((p) => p.role !== "particle");
  if (lead > 0 && !(pieces[lead].role === "surname" && person.surnameSequence.includes(` ${pieces.slice(0, lead + 1).map((p) => p.word).join(" ")} `))) pieces.splice(0, lead);
  if (!pieces.some((p) => p.role === "given" || p.role === "surname")) return null;
  return { pieces, next: pieces.at(-1)!.last + 1 };
}

function formOf(pieces: Piece[]): NameForm {
  const given = pieces.some((p) => p.role === "given" || p.role === "given-initial");
  const surname = pieces.some((p) => p.role === "surname" || p.role === "surname-initial");
  if (given && surname) return "full";
  return given ? "first" : "last";
}

/** Every mention of the sheet's people in `folded`, left to right, never overlapping. */
export function findNames(folded: Folded, people: Person[]): NameMatch[] {
  const text = folded.text;
  const words = wordsOf(text);
  const matches: NameMatch[] = [];
  let i = 0;
  while (i < words.length) {
    let best: { person: Person; pieces: Piece[]; next: number } | null = null;
    let tied: Person[] = [];
    for (const person of people) {
      const run = runAt(text, words, i, person);
      if (!run) continue;
      const end = run.pieces.at(-1)!.end;
      if (!best || end > best.pieces.at(-1)!.end) {
        best = { person, ...run };
        tied = [person];
      } else if (end === best.pieces.at(-1)!.end) {
        tied.push(person);
      }
    }
    if (!best) {
      i++;
      continue;
    }
    const { pieces } = best;
    const full = pieces.filter((p) => p.role === "given" || p.role === "surname");
    const ambiguous = full.length === 1 && isCommonWordName(full[0].word);
    // A lone initial before or after an ambiguous word does not make it a name.
    const kept = ambiguous ? full : pieces;
    const surnameWords = kept.filter((p) => p.role === "surname" || p.role === "particle").map((p) => p.word).join(" ");
    const form = formOf(kept);
    // A surname alone shared by several people is the same family name: it restores the same. A given name is not.
    const shared = tied.length > 1 && form !== "last" ? tied : undefined;
    matches.push({ person: best.person, form, start: kept[0].start, end: kept.at(-1)!.end, ambiguous, surnameWords, surnamePart: form === "last" ? surnamePart(best.person, surnameWords) : "", shared });
    i = best.next;
  }
  // Dotted initials: "M.F.", "M. F."
  for (const m of text.matchAll(/(?<![\p{L}\p{N}.])(\p{L})\.[ \t]?(\p{L})\.(?![\p{L}\p{N}])/gu)) {
    const initials = `${m[1]}.${m[2]}.`;
    const person = people.find((p) => p.initials === initials);
    const start = m.index;
    const end = m.index + m[0].length;
    if (person && !matches.some((n) => n.start < end && start < n.end)) matches.push({ person, form: "initials", start, end, ambiguous: false, surnameWords: "", surnamePart: "" });
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Which of the person's surnames `words` uses, 1-based ("2" for "de la Fuente" of "Ejemplar de la Fuente"), or "" for all. */
function surnamePart(person: Person, words: string): string {
  const used = words.split(" ").filter((w) => !PARTICLES.has(w));
  const indices = used.map((w) => person.surnames.indexOf(w) + 1).filter((n) => n > 0);
  if (indices.length === 0 || indices.length === person.surnames.length) return "";
  return [...new Set(indices)].sort((a, b) => a - b).join(" ");
}

export interface PartMatch {
  person: Person;
  role: "given" | "surname";
  /** Which surname, as in NameMatch.surnamePart. */
  surnamePart: string;
  word: string;
  start: number;
  end: number;
  /** Clearly joined to other text (a file name, a handle, a hashtag, CamelCase): hide. Otherwise only possible. */
  joined: boolean;
  /** Found letter-spaced ("L u c i a", "Ma | teo"). */
  spaced: boolean;
}

const FILE_EXTENSION = /^\.(?:pdf|docx?|xlsx?|csv|txt|rtf|jpe?g|png|heic|gif|mp4|mov|m4a|zip)\b/u;

/**
 * Name words of the sheet (4 letters or more) inside a longer word: "MateoFicticio.pdf",
 * "@mateoficticio", "#TeamMateo", "mateo_ficticio_cde". Hidden when the word is a file
 * name, a handle or a hashtag, or the name sits at a CamelCase, digit or underscore
 * boundary; otherwise ("Luciana" for Lucía) reported as possible.
 */
export function findJoinedNames(folded: Folded, original: string, people: Person[]): PartMatch[] {
  const text = folded.text;
  const out: PartMatch[] = [];
  const upper = (i: number) => /\p{Lu}/u.test(original[folded.from[i]] ?? "");
  const lower = (i: number) => /\p{Ll}/u.test(original[folded.from[i]] ?? "");
  for (const m of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = m[0];
    const at = m.index;
    const handle = text[at - 1] === "@" || text[at - 1] === "#" || FILE_EXTENSION.test(text.slice(at + token.length, at + token.length + 6));
    for (const person of people) {
      for (const { word, role } of person.longWords) {
        for (let k = token.indexOf(word); k !== -1; k = token.indexOf(word, k + 1)) {
          const s = at + k;
          const e = s + word.length;
          // The whole word, or the word with a plural s, is found by findNames.
          if (k === 0 && (e === at + token.length || (e === at + token.length - 1 && token.endsWith("s")))) continue;
          const leftEdge = k === 0 || /[\p{N}_]/u.test(text[s - 1]) || (upper(s) && lower(s - 1));
          const rightEdge = e === at + token.length || /[\p{N}_]/u.test(text[e]) || (upper(e) && lower(e - 1));
          const common = isCommonWordName(word);
          const joined = handle || (leftEdge && rightEdge);
          if (common && !(joined && upper(s))) continue;
          // A three-letter name ("Teo") only when clearly joined at both ends; never reported inside an ordinary word.
          if (word.length < 4 && !(leftEdge && rightEdge)) continue;
          out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: s, end: e, joined, spaced: false });
        }
      }
    }
  }
  return out;
}

/**
 * Name words of the sheet (4 letters or more) written letter by letter, as some PDFs
 * draw them: "L u c i a", "M a t | e o", "Ma | teo". Only matches with at least two
 * gaps, or a cell break, count.
 */
export function findSpacedNames(folded: Folded, original: string, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  const gap = "(?:[ \\t]{1,3}|[ \\t]*\\|[ \\t]*)?";
  for (const person of people) {
    for (const { word, role } of person.longWords.filter((w) => w.word.length >= 4)) {
      const regex = new RegExp(`(?<![\\p{L}\\p{N}])${[...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(gap)}(?![\\p{L}\\p{N}])`, "gu");
      for (const m of folded.text.matchAll(regex)) {
        const gaps = (m[0].match(/[ \t|]+/g) ?? []).length;
        if (gaps < 2 && !m[0].includes("|")) continue;
        if (isCommonWordName(word) && !/\p{Lu}/u.test(original[folded.from[m.index]] ?? "")) continue;
        out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: m.index, end: m.index + m[0].length, joined: true, spaced: true });
      }
    }
  }
  return out;
}
