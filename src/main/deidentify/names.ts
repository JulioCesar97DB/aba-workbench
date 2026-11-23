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
import { isCommonWordName, isEverydayWord } from "./common-words.ts";
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
  /** The words of the name as found, folded, initials with their period: what a full-name placeholder stands for. */
  words: string[];
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
      // English and Spanish short forms of a given name ("Lucy" for Lucía, "Andy" for Andrés, "Pepe" for José), and "Mª" or "Ma." for María.
      for (const word of given) for (const short of HYPOCORISTICS[word] ?? []) if (!roles.has(short)) addRole(roles, short, "given");
      // The other way: a sheet short form also hides its long forms and their other short forms ("Joe": "Joseph", "José", "Joey").
      for (const word of given) {
        for (const long of LONG_FORMS.get(word) ?? []) {
          if (!roles.has(long)) addRole(roles, long, "given");
          for (const short of HYPOCORISTICS[long] ?? []) if (!roles.has(short) && !isCommonWordName(short)) addRole(roles, short, "given");
        }
      }
      // Spanish diminutives of each given name and nickname: "Mateíto", "Teíto", "Carmencita", "Valerita".
      for (const word of given) for (const d of diminutives(word)) if (!roles.has(d) && !isCommonWordName(d)) addRole(roles, d, "given");
      for (const word of surnames) addRole(roles, word, PARTICLES.has(word) ? "particle" : "surname");
      // A name word with an apostrophe, as forms and EMR exports write it without one: "O'Neill" as "ONEILL", "Oneill"; "D'Angelo" as "DANGELO".
      // (Spaced or hyphenated, "O Neill", "D-Angelo", it is found as a broken name word.)
      for (const [word, set] of [...roles]) if (word.includes("'")) for (const role of set) addRole(roles, word.replace(/'/gu, ""), role);
      // A surname written joined to its particles: "Delrío", "Delafuente".
      surnames.forEach((word, k) => {
        if (PARTICLES.has(word)) return;
        let joined = word;
        for (let p = k - 1; p >= 0 && PARTICLES.has(surnames[p]); p--) {
          joined = surnames[p] + joined;
          addRole(roles, joined, "surname");
        }
      });
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

/** Usual short forms of Spanish given names, in English and Spanish, folded. */
const HYPOCORISTICS: Record<string, string[]> = {
  lucia: ["lucy", "lu", "luci"], andres: ["andy", "andre"], jose: ["joe", "joey", "pepe", "pepito", "chepe"], guillermo: ["will", "bill", "memo", "guille"],
  maria: ["mary", "mari", "maru", "ma"], francisco: ["frank", "paco", "pancho", "cisco", "fco", "kiko"], alejandro: ["alex", "ale", "alejo"],
  alejandra: ["alex", "ale", "aleja"], roberto: ["bob", "rob", "robbie", "beto"], eduardo: ["eddie", "ed", "lalo"], antonio: ["tony", "tono"],
  manuel: ["manny", "manolo", "manu"], enrique: ["henry", "kike", "quique"], jesus: ["chuy", "chucho"], ignacio: ["nacho"], rafael: ["rafa", "ralph"],
  daniela: ["dani", "danny"], daniel: ["dani", "danny", "dan"], valeria: ["vale", "val"], sofia: ["sophie", "sofi"], isabel: ["isa", "bella", "chabela"],
  guadalupe: ["lupe", "lupita"], dolores: ["lola", "lolita"], concepcion: ["concha", "conchita"], rosario: ["charo"], teresa: ["tere", "terry"],
  gabriela: ["gaby", "gabi"], gabriel: ["gabe", "gabi"], fernanda: ["fer"], fernando: ["fer", "nando"], mateo: ["matt", "matty", "teo", "mati"],
  santiago: ["santi", "tiago"], sebastian: ["sebas", "seba", "bastian"], nicolas: ["nico", "nick"], samuel: ["sam", "sammy"], benjamin: ["ben", "benja"],
  emiliano: ["emi"], juan: ["johnny", "juanito"], carlos: ["charlie", "carlitos"], luis: ["lucho", "lou"], pedro: ["pete", "perico"],
  miguel: ["mike", "mickey"], andrea: ["andy", "andre"], patricia: ["patty", "pati", "tricia"], elena: ["ellie", "lena", "nena"],
  victoria: ["vicky", "tori"], catalina: ["cata", "cathy", "kate"], camila: ["cami", "milly"], valentina: ["vale", "valen", "tina"],
  ximena: ["xime"], jimena: ["jime"], lucas: ["luke"], diego: ["dieguito"], josefina: ["pepa", "fina", "josie"], margarita: ["maggie", "marga", "rita"],
  ana: ["anita", "annie"], carmen: ["carmencita", "mencha"], beatriz: ["bea", "betty"], cristina: ["cris", "tina"], ricardo: ["ricky", "rick"],
  // English long forms, so a sheet short form finds them too ("Joe" for "Joseph").
  joseph: ["joe", "joey"], josephine: ["josie", "jo"], michael: ["mike", "mikey", "mick"], william: ["will", "bill", "billy", "liam", "willy"],
  robert: ["rob", "bob", "bobby", "robbie"], richard: ["rick", "ricky"], james: ["jim", "jimmy", "jamie"], john: ["johnny", "jack"],
  thomas: ["tom", "tommy"], christopher: ["chris"], matthew: ["matt", "matty"], nicholas: ["nick", "nicky"], anthony: ["tony"],
  elizabeth: ["liz", "lizzie", "beth", "betty", "eliza"], katherine: ["kate", "katie", "kathy", "kat"], catherine: ["cathy", "kate", "katie"],
  margaret: ["maggie", "meg", "peggy"], jennifer: ["jen", "jenny"], rebecca: ["becky", "becca"], samantha: ["sam", "sammy"], alexander: ["alex", "xander"],
  edward: ["ed", "eddie", "ted", "teddy"], timothy: ["tim", "timmy"],
};

/** Each short form's long forms: "joe" → "jose", "joseph". */
const LONG_FORMS: ReadonlyMap<string, string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [long, shorts] of Object.entries(HYPOCORISTICS)) for (const short of shorts) out.set(short, [...(out.get(short) ?? []), long]);
  return out;
})();

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
    // "Smither's" for "Smithers": the possessive written over the name's own last s. The whole word is the name.
    const own = bestRole(person.roles.get(`${base.slice(0, -2)}s`));
    if (own && own !== "particle" && base.length > 5) return { last: i, start: word.start, end, role: own, word: `${base.slice(0, -2)}s` };
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
    // "Ficticio, Mateo": the comma stays with the word before it, so the name restores in the order and form written.
    const nameWords = kept.map((p, k) => {
      const word = p.role === "given-initial" || p.role === "surname-initial" ? `${p.word}.` : p.word;
      return k + 1 < kept.length && text.slice(p.end, kept[k + 1].start).includes(",") ? `${word},` : word;
    });
    matches.push({ person: best.person, form, start: kept[0].start, end: kept.at(-1)!.end, ambiguous, surnameWords, surnamePart: form === "last" ? surnamePart(best.person, surnameWords) : "", words: nameWords, shared });
    i = best.next;
  }
  // Dotted initials: "M.F.", "M. F."
  for (const m of text.matchAll(/(?<![\p{L}\p{N}.])(\p{L})\.[ \t]?(\p{L})\.(?![\p{L}\p{N}])/gu)) {
    const initials = `${m[1]}.${m[2]}.`;
    const person = people.find((p) => p.initials === initials);
    const start = m.index;
    const end = m.index + m[0].length;
    if (person && !matches.some((n) => n.start < end && start < n.end)) matches.push({ person, form: "initials", start, end, ambiguous: false, surnameWords: "", surnamePart: "", words: [] });
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Which of the person's surnames `words` uses, 1-based ("2" for "de la Fuente" of "Ejemplar de la Fuente"), or "" for all. */
function surnamePart(person: Person, words: string): string {
  const used = words.split(" ").filter((w) => !PARTICLES.has(w));
  const plain = person.surnames.map((w) => w.replace(/'/gu, ""));
  const indices = used.map((w) => plain.indexOf(w.replace(/'/gu, "")) + 1).filter((n) => n > 0);
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
  /** Split only by spaces with an everyday short word as one piece ("mate o", "and res"): hidden, but restored as written and shown for review. */
  uncertain?: boolean;
}

/** After a word: a file extension, or a web domain's ending, so the word is part of a file or site name. */
const FILE_EXTENSION = /^\.(?:pdf|docx?|xlsx?|csv|txt|rtf|jpe?g|png|heic|gif|mp4|mov|m4a|zip|com|net|org|edu|gov|io|us|info|co|me|app|online|site|biz)\b/u;

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
  let runEnd = 0;
  let runIsLink = false;
  let runWords = new Set<string>();
  for (const m of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = m[0];
    const at = m.index;
    // The run of text without spaces the word sits in: "ana.paz.docx", "www.anapaz.com", "@ana_paz". Read once per run.
    if (at >= runEnd) {
      let runStart = at;
      while (runStart > 0 && !/\s/u.test(text[runStart - 1])) runStart--;
      runEnd = at + token.length;
      while (runEnd < text.length && !/\s/u.test(text[runEnd])) runEnd++;
      const run = text.slice(runStart, runEnd).replace(/[.,;:!?)\]]+$/u, "");
      runIsLink = /^[@#]|www\.|:\/\/|@|\.(?:pdf|docx?|xlsx?|csv|txt|rtf|jpe?g|png|heic|gif|mp4|mov|m4a|zip|com|net|org|edu|gov|io)$/u.test(run);
      // The name words of the sheet in that run, each apart: "ana", "paz", "docx".
      runWords = new Set(run.split(/[^\p{L}]+/u).filter(Boolean));
    }
    const handle =
      text[at - 1] === "@" ||
      text[at - 1] === "#" ||
      FILE_EXTENSION.test(text.slice(at + token.length, at + token.length + 8)) ||
      /(?:www\.|:\/\/|\.)$/u.test(text.slice(Math.max(0, at - 6), at)) ||
      runIsLink;
    for (const person of people) {
      for (const { word, role } of person.longWords) {
        for (let k = token.indexOf(word); k !== -1; k = token.indexOf(word, k + 1)) {
          const s = at + k;
          const e = s + word.length;
          // In a handle, a site or a file name that holds another sheet name word, a common-word name is the name too ("ana_paz_cde.pdf", "luz.rey.docx").
          const withName = handle && people.some((p) => p.longWords.some((w) => w.word !== word && (runWords.has(w.word) || token.includes(w.word))));
          // The whole word, or the word with a plural s, is found by findNames (which leaves a lowercase common-word name: taken here in a link).
          const whole = k === 0 && (e === at + token.length || (e === at + token.length - 1 && token.endsWith("s")));
          if (whole && !(handle && withName && isCommonWordName(word))) continue;
          const leftEdge = k === 0 || /[\p{N}_]/u.test(text[s - 1]) || (upper(s) && lower(s - 1));
          const rightEdge = e === at + token.length || /[\p{N}_]/u.test(text[e]) || (upper(e) && lower(e - 1));
          const common = isCommonWordName(word);
          const joined = handle || (leftEdge && rightEdge);
          if (common && !(joined && (upper(s) || withName))) continue;
          // A three-letter name ("Teo") only when clearly joined at both ends; inside a handle, a site or a file name otherwise, reported.
          if (word.length < 4 && !(leftEdge && rightEdge)) {
            if (handle) out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: s, end: e, joined: false, spaced: false });
            continue;
          }
          out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: s, end: e, joined, spaced: false });
        }
      }
    }
  }
  return out;
}

/**
 * Name words of the sheet (4 letters or more) broken inside: hyphenated ("Fic-ticio",
 * "Fic- ticio", "Fic-⏎ticio", as PDF paragraph hyphenation and typing give it), split by
 * a space or a line break ("M ateo", "Fi cticio"), or written letter by letter
 * ("L u c i a", "M a t | e o", "Ma | teo"). A name that is also a common word only
 * when capitalized.
 */
export function findBrokenNames(folded: Folded, original: string, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  const gap = "(?:[ \\t]*-[ \\t]*(?:\\r?\\n[ \\t]*)?|[ \\t]{1,6}|[ \\t]*\\|[ \\t]*|[ \\t]*\\r?\\n[ \\t]*)?";
  const seen = new Set<string>();
  for (const person of people) {
    for (const { word, role } of person.longWords.filter((w) => w.word.length >= 4)) {
      if (seen.has(`${person.priority}:${word}`)) continue;
      seen.add(`${person.priority}:${word}`);
      // A plural or possessive s may follow ("Mu-estras", "Ficti-cio's").
      const regex = new RegExp(`(?<![\\p{L}\\p{N}])${[...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(gap)}(?='?s(?![\\p{L}\\p{N}])|(?![\\p{L}\\p{N}]))`, "gu");
      for (const m of folded.text.matchAll(regex)) {
        if (m[0].length === word.length) continue;
        if (isCommonWordName(word) && !/\p{Lu}/u.test(original[folded.from[m.index]] ?? "")) continue;
        // Split by spaces only into everyday words ("a dam", "no el", "to mas"): maybe ordinary text, maybe the name. Reported, not hidden.
        // A piece that is not a word ("AN DRES", "M ateo") makes it the name: hidden.
        const pieces = m[0].split(/[ \t]+/u);
        const uncertain = !/[-|\n]/u.test(m[0]) && pieces.length === 2 && pieces.every((p) => isEverydayWord(p));
        out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: m.index, end: m.index + m[0].length, joined: true, spaced: true, uncertain });
      }
      // Spelled out with the same mark between every pair of letters ("M.A.T.E.O.", "M_A_T_E_O", "M/A/T/E/O", "M · A · T · E · O").
      const letters = [...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const spelled = new RegExp(`(?<![\\p{L}\\p{N}])${letters[0]}([ \\t]*[^\\p{L}\\p{N}\\s][ \\t]*)${letters.slice(1).join("\\1")}(?:\\1)?(?![\\p{L}\\p{N}])`, "gu");
      for (const m of folded.text.matchAll(spelled)) {
        out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: m.index, end: m.index + m[0].length, joined: true, spaced: true });
      }
    }
  }
  // Three-letter name words spelled out, the same mark or the same run of spaces between every pair of letters, standing alone ("A-N-A", "A N A", "A  N  A", "a.n.a.").
  for (const person of people) {
    for (const { word, role } of person.longWords.filter((w) => w.word.length === 3)) {
      if (seen.has(`${person.priority}:${word}`)) continue;
      seen.add(`${person.priority}:${word}`);
      const letters = [...word].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const spelled = new RegExp(`(?<![\\p{L}\\p{N}])${letters[0]}([ \\t]*[^\\p{L}\\p{N}\\s][ \\t]*|[ \\t]+)${letters.slice(1).join("\\1")}(?:\\1(?![\\p{L}\\p{N}]))?(?![\\p{L}\\p{N}])`, "gu");
      for (const m of folded.text.matchAll(spelled)) {
        // Standing alone: not one more spelled letter on either side ("A N A B", "X.A.N.A").
        const mark = m[1];
        const escaped = mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const before = folded.text.slice(Math.max(0, m.index - mark.length - 2), m.index);
        const after = folded.text.slice(m.index + m[0].length, m.index + m[0].length + mark.length + 2);
        // Inside a longer spelled run ("X A N A", "A N A B"): maybe another word, so reported, never passed silently.
        const inside =
          new RegExp(`(?:^|[^\\p{L}\\p{N}])[\\p{L}\\p{N}]${escaped}$`, "u").test(before) || (new RegExp(`^${escaped}[\\p{L}\\p{N}](?![\\p{L}\\p{N}])`, "u").test(after) && !m[0].endsWith(mark));
        out.push({ person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start: m.index, end: m.index + m[0].length, joined: !inside, spaced: true });
      }
    }
  }
  out.push(...findSplitShortNames(folded, original, people), ...findCompoundInitials(folded, original, people));
  out.push(...findElongatedNames(folded, people), ...findConcatenatedNames(folded, people), ...findSpelledConcatenations(folded, people));
  return out;
}

/** A label right before a value on its line: "Client: ", "Mother: ", "Examinee name: ". */
const LABEL_BEFORE = /(?:^|\n)[ \t]*\p{L}[\p{L} .'-]{0,30}:[ \t]*$/u;

/**
 * A three-letter name word split once inside by a space or a hyphen, as a kerned PDF heading
 * gives it ("Client: T eo Ficticio", "Mother: A na Paz") or typing does ("Pa z", "A-ni"). Hidden
 * when a piece is not an everyday word, next to another name word of the same person, or after
 * a label; two everyday words ("E va", "An a") are listed for review when the first is a lone
 * capital letter, and otherwise left as ordinary text ("is a", "no a").
 */
function findSplitShortNames(folded: Folded, original: string, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  const text = folded.text;
  const seen = new Set<string>();
  for (const person of people) {
    for (const { word, role } of person.longWords) {
      if (word.length !== 3 || seen.has(`${person.priority}:${word}`)) continue;
      seen.add(`${person.priority}:${word}`);
      const letters = [...word];
      if (letters.length !== 3 || !letters.every((ch) => /\p{L}/u.test(ch))) continue;
      for (const k of [1, 2]) {
        const left = letters.slice(0, k).join("");
        const right = letters.slice(k).join("");
        const regex = new RegExp(`(?<![\\p{L}\\p{N}'])${left}(?:[ \\t]|[ \\t]?-[ \\t]?)${right}(?![\\p{L}\\p{N}])`, "gu");
        for (const m of text.matchAll(regex)) {
          const start = m.index;
          const end = start + m[0].length;
          const capital = /\p{Lu}/u.test(original[folded.from[start]] ?? "");
          if (isCommonWordName(word) && !capital) continue;
          // The last piece starts a hyphenated word ("A na-⏎tural", "T eo-⏎retical"): ordinary text.
          if (/^-[ \t]*(?:\r?\n[ \t]*)?\p{L}/u.test(text.slice(end, end + 6))) continue;
          const next = /^[ \t]*,?[ \t]*(\p{L}+(?:'\p{L}+)*)/u.exec(text.slice(end, end + 40))?.[1];
          const prev = /(\p{L}+(?:'\p{L}+)*)[ \t]*,?[ \t]*$/u.exec(text.slice(Math.max(0, start - 40), start))?.[1];
          const beside = [next, prev].some((w) => w !== undefined && w !== word && person.roles.has(w) && !person.roles.get(w)!.has("particle"));
          const labelled = LABEL_BEFORE.test(text.slice(Math.max(0, start - 40), start));
          const everyday = isEverydayWord(left) && isEverydayWord(right);
          const part = { person, role, surnamePart: role === "surname" ? surnamePart(person, word) : "", word, start, end, joined: true, spaced: true };
          // Lowercase ("a ni", "t eo"): a name is capitalized; listed for review unless both pieces are everyday words.
          if (beside || labelled || (!everyday && capital)) out.push(part);
          else if ((left.length === 1 && capital) || !everyday) out.push({ ...part, uncertain: true });
        }
      }
    }
  }
  return out;
}

/**
 * The initials of a given name of two words, in capitals, with or without dots ("MK", "M.K.",
 * "M. K." for "Mary-Kate", "MJ" for "María José"): hidden, restored as written.
 */
function findCompoundInitials(folded: Folded, original: string, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  for (const person of people) {
    const given = parts(person.sheet.firstName).filter((w) => !PARTICLES.has(w));
    if (given.length !== 2) continue;
    const [a, b] = given.map((w) => w[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = new RegExp(`(?<![\\p{L}\\p{N}.])${a}(?:\\.[ \\t]?)?${b}\\.?(?![\\p{L}\\p{N}])`, "gu");
    for (const m of folded.text.matchAll(regex)) {
      const written = original.slice(folded.from[m.index], folded.to[m.index + m[0].length - 1]);
      if (written.replace(/[^\p{L}]/gu, "") !== written.replace(/[^\p{L}]/gu, "").toUpperCase()) continue;
      // "M.K" with no last dot before a letter-dot ("M.K.S.") is part of longer initials: left.
      out.push({ person, role: "given", surnamePart: "", word: given.join(" "), start: m.index, end: m.index + m[0].length, joined: true, spaced: false });
    }
  }
  return out;
}

/** The fewest name words of one person that make up `token` exactly ("anapaz" = "ana" + "paz": 2); Infinity when they cannot. */
function nameWordCount(token: string, words: string[]): number {
  const best = new Array<number>(token.length + 1).fill(Infinity);
  best[0] = 0;
  for (let i = 0; i < token.length; i++) {
    if (best[i] === Infinity) continue;
    for (const w of words) if (token.startsWith(w, i) && best[i] + 1 < best[i + w.length]) best[i + w.length] = best[i] + 1;
  }
  return best[token.length];
}

/**
 * A run of single letters spelled with the same mark or the same spaces between each pair
 * whose letters are exactly two or more name words of one sheet person ("A-N-A-P-A-Z",
 * "A N A P A Z", "e.v.a.g.i.l."): hidden whole. (Each three-letter word inside such a run
 * is otherwise only listed, since the run may spell another word.)
 */
function findSpelledConcatenations(folded: Folded, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  const run = /(?<![\p{L}\p{N}])\p{L}([ \t]*[^\p{L}\p{N}\s][ \t]*|[ \t]+)\p{L}(?:\1\p{L})+(?:\1(?![\p{L}\p{N}]))?(?![\p{L}\p{N}])/gu;
  for (const m of folded.text.matchAll(run)) {
    const token = [...m[0]].filter((ch) => /\p{L}/u.test(ch)).join("");
    if (token.length < 6 || token.length > 40) continue;
    for (const person of people) {
      const count = nameWordCount(token, person.longWords.map((w) => w.word));
      if (count === Infinity || count < 2) continue;
      const first = person.longWords.find((w) => token.startsWith(w.word))!;
      out.push({ person, role: first.role, surnamePart: "", word: first.word, start: m.index, end: m.index + m[0].length, joined: true, spaced: true });
      break;
    }
  }
  return out;
}

/**
 * A word made only of two or more name words of one sheet person, whatever their length
 * ("anapaz", "@anagil", "www.evarey.com", "mateoficticio"): hidden. One that is also an
 * everyday word is reported instead.
 */
function findConcatenatedNames(folded: Folded, people: Person[]): PartMatch[] {
  const out: PartMatch[] = [];
  for (const m of folded.text.matchAll(/(?<![\p{L}])\p{L}{6,40}(?![\p{L}])/gu)) {
    const token = m[0];
    for (const person of people) {
      const count = nameWordCount(token, person.longWords.map((w) => w.word));
      if (count === Infinity || count < 2) continue;
      const first = person.longWords.find((w) => token.startsWith(w.word))!;
      out.push({ person, role: first.role, surnamePart: "", word: first.word, start: m.index, end: m.index + token.length, joined: !isEverydayWord(token), spaced: false });
      break;
    }
  }
  return out;
}

/**
 * Name words of the sheet written with a letter held ("Mateooo", "MATEOOO!", "Mmmateo",
 * "Lucíaaa"): every run of three or more of one letter read as one or two of it.
 */
function findElongatedNames(folded: Folded, people: Person[]): PartMatch[] {
  const words = new Map<string, { person: Person; word: string; role: "given" | "surname" }>();
  for (const person of people) for (const { word, role } of person.longWords) if (word.length >= 3 && !words.has(word)) words.set(word, { person, word, role });
  const out: PartMatch[] = [];
  if (words.size === 0) return out;
  for (const m of folded.text.matchAll(/(?<![\p{L}\p{N}])\p{L}*(\p{L})\1\1\p{L}*(?![\p{L}\p{N}])/gu)) {
    const hit = words.get(m[0].replace(/(\p{L})\1{2,}/gu, "$1")) ?? words.get(m[0].replace(/(\p{L})\1{2,}/gu, "$1$1"));
    if (!hit) continue;
    out.push({ person: hit.person, role: hit.role, surnamePart: hit.role === "surname" ? surnamePart(hit.person, hit.word) : "", word: hit.word, start: m.index, end: m.index + m[0].length, joined: true, spaced: true });
  }
  return out;
}

/** A word as OCR may misread it: 0 and o, 1, l, i and |, rn and m, vv and w, c and e, 5 and s read the same. */
function ocrSkeleton(word: string): string {
  return word.replace(/rn/gu, "m").replace(/vv/gu, "w").replace(/0/gu, "o").replace(/[1il|!]/gu, "l").replace(/e/gu, "c").replace(/5/gu, "s");
}

/**
 * Name words of the sheet (5 letters or more, not common words) misread by OCR in a
 * scanned report's text layer: "Mate0", "Luc1a", "FlCTlClO", "Matco".
 */
export function findOcrNames(folded: Folded, people: Person[]): PartMatch[] {
  const skeletons = new Map<string, { person: Person; word: string; role: "given" | "surname" }>();
  for (const person of people) {
    for (const { word, role } of person.longWords) {
      if (word.length < 5 || isCommonWordName(word)) continue;
      const key = ocrSkeleton(word);
      if (!skeletons.has(key)) skeletons.set(key, { person, word, role });
    }
  }
  const out: PartMatch[] = [];
  if (skeletons.size === 0) return out;
  for (const m of folded.text.matchAll(/(?<![\p{L}\p{N}|!])[\p{L}\p{N}|!]{5,}(?![\p{L}\p{N}|!])/gu)) {
    const hit = skeletons.get(ocrSkeleton(m[0]));
    if (!hit || hit.person.roles.has(m[0])) continue;
    out.push({ person: hit.person, role: hit.role, surnamePart: hit.role === "surname" ? surnamePart(hit.person, hit.word) : "", word: hit.word, start: m.index, end: m.index + m[0].length, joined: true, spaced: false });
  }
  return out;
}
