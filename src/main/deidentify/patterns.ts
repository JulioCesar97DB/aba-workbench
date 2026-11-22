/*
 * Identifiers found by their shape, whether or not they are on the client sheet:
 * email addresses, phone numbers, ID-like numbers (and the last four digits of one),
 * street addresses (with their unit, city, state and ZIP code, "Calle Ocho" style too),
 * ZIP codes after a state or a city, post office boxes, and names the sheet does not
 * list when they follow a label at the start of a line ("Examinee:", "Respondent |"), a
 * title or a relation used as one ("Dr.", "Ms.", "Sra.", "Abuela", "Coach"), or come
 * before a credential ("Ana Prado, BCBA"). A sheet name always wins over these.
 * Also the days part of an age ("6;8;8", "6 years, 8 months, 8 days"), which with a
 * test date gives the date of birth: it is dropped (owner's decision, 2026-11-22).
 *
 * Clinical codes and scores never match: CPT codes (97153) have five digits, ICD-10
 * codes (F84.0) and test names (BASC-3, Vineland-3) too few; an ID needs seven digits
 * in a row, or four or more after a label such as "Medicaid ID".
 */

export type PatternKind = "email" | "phone" | "id" | "address" | "unlisted-name";

export interface PatternMatch {
  kind: PatternKind;
  start: number;
  end: number;
  /** Two matches with the same key are the same value: they get the same placeholder. */
  key: string;
}

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu;

const EXTENSION = "(?:\\s*(?:ext\\.?|x|extension|extensi[oó]n)\\s*\\d{1,5})?";
const PHONE_US = new RegExp(`(?<![\\p{L}\\p{N}+])(?:\\+?1[\\s.\\-]?)?(?:\\(\\d{3}\\)[\\s.\\-/]?|\\d{3}[\\s.\\-/])\\d{3}[\\s.\\-/]?\\d{4}${EXTENSION}(?![\\p{N}])`, "gu");
const PHONE_INTERNATIONAL = /(?<![\p{L}\p{N}])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?![\p{N}])/gu;
const PHONE_LABEL = "(?:phone|ph|tel|telephone|cell|cel|cellphone|mobile|fax|home|work|contact|whatsapp|tel[eé]fono|celular|m[oó]vil|call|llamar)";
const PHONE_LOCAL = new RegExp(`(?<=${PHONE_LABEL}\\b[^\\n\\d]{0,15})(?<![\\p{N}])\\d{3}[\\s.\\-]\\d{4}(?![\\p{N}])`, "giu");
const PHONE_PLAIN = new RegExp(`(?<=${PHONE_LABEL}\\b[^\\n\\d]{0,15})(?<![\\p{N}])\\d{10}(?![\\p{N}])`, "giu");

const SSN = /(?<![\p{N}-])\d{3}-\d{2}-\d{4}(?![\p{N}-])/gu;
const ID_LABEL =
  "(?:medicaid|medicare|member|subscriber|policy|insurance|insurer|carrier|payer|health\\s+plan|authorization|claim|kidcare|florida\\s+kidcare|aetna|sunshine(?:\\s+health)?|humana|simply(?:\\s+healthcare)?|molina|staywell|cigna|united(?:\\s*healthcare)?|wellcare|ambetter|prestige|cms|mrn|medical\\s+record|record|chart|patient|client|case|account|ssn|social\\s+security|dcf|apd|student|recipient|id|identification|n[uú]mero\\s+de\\s+(?:seguro|miembro|caso|estudiante|identificaci[oó]n))";
const ID_LABELLED = new RegExp(
  `(?<=\\b${ID_LABEL}(?:\\s*(?:id|number|no\\.?|num\\.?|#|n[uú]mero))?(?:\\s+(?:is|es))?\\s*[:#|\\-]?\\s*)(?=[A-Za-z0-9\\-]*(?:\\d[\\s\\-]?){4})[A-Za-z0-9](?:[A-Za-z0-9]|[\\-\\s](?=[A-Za-z0-9]*\\d)){3,24}(?![\\p{L}\\p{N}])`,
  "giu",
);
/** The last digits of an ID or a phone: "Medicaid ending in 3210", "last 4 of Medicaid: 6789". */
const ID_LAST_DIGITS =
  /(?<=\b(?:ending\s+in|ends\s+in|last\s+(?:4|four)(?:\s+digits)?(?:\s+of(?:\s+[\p{L}#]+){0,2})?|terminad[oa]\s+en|termina\s+en|[uú]ltimos\s+(?:4|cuatro)(?:\s+d[ií]gitos)?(?:\s+de(?:\s+[\p{L}#]+){0,2})?)\s*[:#]?\s*)\d{4}(?![\p{N}])/giu;
const ID_DIGITS = /(?<![\p{N}\-/.,:])\d{7,}(?![\p{N}]|[.,]\d)/gu;
const ID_MIXED = /(?<![\p{L}\p{N}-])(?=[A-Z0-9-]*\d{5})(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{5,}(?![\p{L}\p{N}])/gu;

/** "Street" or "street", from one spelling. */
function either(words: string[]): string {
  return words.map((w) => `[${w[0]}${w[0].toLowerCase()}]${w.slice(1)}`).join("|");
}
const STREET_TYPES = either([
  "Street", "St", "Avenue", "Ave", "Av", "Road", "Rd", "Boulevard", "Blvd", "Drive", "Dr", "Lane", "Ln", "Court", "Ct", "Way",
  "Place", "Pl", "Terrace", "Terr", "Ter", "Trce", "Circle", "Cir", "Highway", "Hwy", "Parkway", "Pkwy", "Trail", "Trl", "Causeway",
  "Plaza", "Plz", "Square", "Sq", "Loop", "Path", "Row", "Pike", "Alley", "Crescent", "Point", "Str", "Blv", "Crt", "Calle", "Avenida", "Camino",
]);
/** Spanish-style streets name their type first: "22 Calle Ocho", "1500 Avenida Ponce de León". */
const TYPE_FIRST = "(?:Calle|Avenida|Av\\.|Ave\\.|Camino|Carrera|Cra\\.|Paseo|Callej[oó]n|Diagonal|Transversal)";
const DIRECTION = "(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\\.?";
const STATES =
  "(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Florida|Georgia|Texas|New\\s+York|California|Puerto\\s+Rico)";
const PLACE_WORD = "\\p{Lu}[\\p{L}'.\\-]*";
/** A unit written before the street: "Apartment 3B at 22 Calle Ocho". */
const UNIT_FIRST = "(?:(?:Apt|Apartment|Unit|Suite|Ste|Apto|Apartamento)\\.?\\s*#?\\s*[\\p{L}\\p{N}\\-]+,?\\s+(?:at\\s+|en\\s+|in\\s+)?)?";
/** A city after the street with no state: "22 Calle Ocho, Miami". */
const CITY_ONLY = `(?:,\\s*${PLACE_WORD}(?:\\s+${PLACE_WORD}){0,2}(?![\\p{L}]))?`;
const CITY_STATE_ZIP = `(?:,\\s*${PLACE_WORD}(?:\\s+${PLACE_WORD}){0,3},?\\s+${STATES}\\.?(?:\\s+\\d{5}(?:-\\d{4})?)?|,?\\s+${STATES}\\s+\\d{5}(?:-\\d{4})?)`;
const UNIT = "(?:,?\\s*(?:Apt|Apartment|Unit|Suite|Ste|Bldg|Building|Lot|Room|Rm|Apto|Apartamento)\\.?\\s*#?\\s*[\\p{L}\\p{N}\\-]+|,?\\s*#\\s*[\\p{L}\\p{N}\\-]+)?";
const STREET = new RegExp(
  `(?<![\\p{L}\\p{N}])${UNIT_FIRST}\\d{1,6}[A-Za-z]?(?:\\s+${DIRECTION})?(?:\\s+(?:${PLACE_WORD}|\\d+(?:st|nd|rd|th)|\\d+)){1,4}?\\s+(?:${STREET_TYPES})\\b\\.?(?:\\s+${DIRECTION}(?![\\p{L}]))?${UNIT}(?:${CITY_STATE_ZIP}|${CITY_ONLY})`,
  "gu",
);
const STREET_TYPE_FIRST = new RegExp(
  `(?<![\\p{L}\\p{N}])${UNIT_FIRST}\\d{1,6}[A-Za-z]?\\s+${TYPE_FIRST}(?:\\s+(?:${PLACE_WORD}|\\d+(?:st|nd|rd|th)?|de|del|la|los|las)){1,4}${UNIT}(?:${CITY_STATE_ZIP}|${CITY_ONLY})`,
  "gu",
);
/** A Florida ZIP code after a city, with no state: "Doral 33172". The words before must look like a place, not a label ("Code 33533"). */
const CITY_NO_STATE_ZIP = /(?<![\p{L}\p{N}])(\p{Lu}\p{Ll}[\p{L}'.-]*(?:\s+\p{Lu}\p{Ll}[\p{L}'.-]*){0,2}),?\s+(\d{5}(?:-\d{4})?)(?![\p{N}])/gu;
const NOT_PLACES = new Set(
  `code codes cpt hcpcs icd procedure procedures item items page pages room form forms score scores total units unit hours minutes session
  sessions case claim claims authorization auth invoice account member policy group number no grade test tests level levels step steps
  week weeks day days month months year years age total raw standard percentile composite index item line lines box boxes table tables`.split(/\s+/u),
);
const CITY_ZIP = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PLACE_WORD}(?:\\s+${PLACE_WORD}){0,3},\\s*)?${STATES}\\.?\\s+\\d{5}(?:-\\d{4})?(?![\\p{N}])`, "gu");
const ZIP_LABELLED = /(?<=\b(?:zip|zip\s+code|c[oó]digo\s+postal)\s*:?\s*)\d{5}(?:-\d{4})?(?![\p{N}])/giu;
const PO_BOX = /(?<![\p{L}])(?:P\.?\s?O\.?\s*Box|Post\s+Office\s+Box|Apartado(?:\s+[Pp]ostal)?)\s+#?\s*\d+/gu;

/** Each letter of a pattern written to match both cases, so the rest of the pattern can stay case-sensitive. */
function anyCase(pattern: string): string {
  // An escape (backslash and a letter) stays as it is.
  return pattern.replace(/\\.|\p{L}/gu, (ch) => (ch.length > 1 || ch.toLowerCase() === ch.toUpperCase() ? ch : `[${ch.toLowerCase()}${ch.toUpperCase()}]`));
}

/** A name after a label, on the same line: "Examinee: Mateo Ficticio", "Respondent | Lucía Ficticio (mother)". */
const NAME_LABEL = anyCase(
  "(?:examinee|student|child|child's\\s+name|client|client\\s+name|patient|patient\\s+name|name|full\\s+name|respondent|informant|parent|parent/guardian|guardian|caregiver|mother|father|teacher|examiner|interviewer|rater|therapist|physician|pediatrician|referred\\s+by|referring\\s+physician|nombre|paciente|madre|padre|informante|maestra|maestro|tutor|tutora|evaluador|evaluadora|evaluator|referral\\s+source|referred\\s+by|psychologist|provider|bcba|bcaba|rbt|supervisor|analyst|lead\\s+analyst|signed\\s+by|prepared\\s+by|completed\\s+by|administered\\s+by|observer)",
);
const NAME_AFTER_LABEL = new RegExp(
  `(?<=(?:^|\\n|\\|)[ \\t]*(?:[-*+\\u{2022}][ \\t]+)?(?:\\*\\*|__)?${NAME_LABEL}(?:\\*\\*|__)?[ \\t]*(?::|\\||-)(?:\\*\\*|__)?[ \\t]*)\\p{Lu}[\\p{L}'\\-]+(?:[ ](?:\\p{Lu}\\.|\\p{Lu}[\\p{L}'\\-]+|de|del|la|y)){0,4}`,
  "gu",
);
/** Words a label can be followed by that are not a name. */
const NOT_NAMES = new Set([
  "male", "female", "mother", "father", "parent", "teacher", "caregiver", "grandmother", "grandfather", "guardian", "self",
  "unknown", "none", "not", "n/a", "na", "spanish", "english", "other", "low", "high", "average", "madre", "padre", "abuela",
  "abuelo", "ninguno", "desconocido", "maestra", "maestro", "both", "parents",
]);

/** Titles, and relation words used as one before a name: never a name themselves. */
const TITLE_WORDS =
  "Dr|Dra|Mr|Mrs|Ms|Miss|Mx|Sr|Sra|Srta|Prof|Lic|Lcda|Lcdo|Abuela|Abuelo|Abuelita|Abuelito|Tia|T\u{ED}a|Tio|T\u{ED}o|Primo|Prima|Grandma|Grandpa|Granny|Nana|Aunt|Auntie|Uncle|Cousin|Coach|Madrina|Padrino|Profe|Teacher|Maestra|Maestro";
const TITLE_SET = new Set(TITLE_WORDS.toLowerCase().split("|"));

/** A name before a credential: "Ana María Prado-Ilustre, BCBA", "Elena Placeholder, Psy.D.". */
const CREDENTIALS =
  "(?:BCBA-D|BCBA|BCaBA|RBT|M\\.?S\\.?(?:Ed\\.?)?|M\\.?A\\.?|M\\.?Ed\\.?|Ph\\.?D\\.?|Psy\\.?D\\.?|Ed\\.?D\\.?|M\\.?D\\.?|D\\.?O\\.?|LMHC|LCSW|LMFT|LPC|CCC-SLP|SLP|OTR/L|OTR|COTA|DPT|PT|APRN|ARNP|PA-C|NP|RN|LPN)";
const NAME_BEFORE_CREDENTIAL = new RegExp(
  `(?<![\\p{L}])\\p{Lu}[\\p{L}'\\-]+(?:[ ](?:\\p{Lu}\\.|\\p{Lu}[\\p{L}'\\-]+|de|del|la|y)){0,3}(?=,\\s*${CREDENTIALS}(?![\\p{L}]))`,
  "gu",
);
/** Capitalized words that start a sentence or a field, never the start of a name. */
const STARTERS = new Set(["the", "then", "by", "and", "signed", "reviewed", "prepared", "completed", "per", "from", "with", "dear", "cc", "attn", "report", "evaluator", "supervisor", "therapist", "provider", "el", "la", "por", "firmado", "y"]);

/** Words that start the next field on a form line. */
const FIELD_WORDS = new Set(["dob", "date", "age", "sex", "gender", "grade", "phone", "id", "school", "address", "birth", "fecha", "edad", "sexo"]);

/** A name after a title: "Dr. Tomás Ilustre", "Ms. Whitfield", "Sra. Prado". */
const TITLED_NAME = new RegExp(
  `(?<=(?<![\\p{L}])(?:${anyCase(TITLE_WORDS)})\\.?[ \\t]+)\\p{Lu}[\\p{L}'\\-]+(?:[ ](?:\\p{Lu}\\.|\\p{Lu}[\\p{L}'\\-]+|de|del|la|y)){0,3}`,
  "gu",
);

function digits(text: string): string {
  return text.replace(/\D/g, "");
}
function alnum(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function phoneKey(text: string): string {
  const d = digits(text.replace(/(?:ext\.?|x|extension|extensi[oó]n)\s*\d+$/iu, ""));
  return d.length >= 10 ? d.slice(-10) : d;
}

/** Street words read the same however they are written: "Street", "St." and "Str" match; "Twelfth" is "12". */
export const ADDRESS_WORDS: Record<string, string> = {
  street: "st", str: "st", avenue: "ave", av: "ave", avenida: "ave", road: "rd", boulevard: "blvd", blv: "blvd", drive: "dr",
  lane: "ln", court: "ct", crt: "ct", place: "pl", terrace: "ter", terr: "ter", trce: "ter", circle: "cir", highway: "hwy",
  parkway: "pkwy", trail: "trl", plaza: "plz", square: "sq", calle: "cl", cl: "cl",
  apartment: "apt", apto: "apt", apartamento: "apt", unit: "apt", suite: "apt", ste: "apt",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw", florida: "fl",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10",
  eleventh: "11", twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15", sixteenth: "16", seventeenth: "17",
  eighteenth: "18", nineteenth: "19", twentieth: "20", thirtieth: "30", fortieth: "40", fiftieth: "50",
};
export function addressKey(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => ADDRESS_WORDS[w] ?? w.replace(/^(\d+)(?:st|nd|rd|th)$/, "$1"))
    .join(" ");
}

function add(out: PatternMatch[], kind: PatternKind, regex: RegExp, text: string, key: (value: string) => string): void {
  for (const m of text.matchAll(regex)) {
    const value = m[0].replace(/[\s,.]+$/u, (tail) => (tail.startsWith(".") && /\b(?:St|Ave|Rd|Dr|Blvd|Ln|Ct|Pl|Apt|Ste)\.$/u.test(m[0]) ? "." : ""));
    if (!value) continue;
    out.push({ kind, start: m.index, end: m.index + value.length, key: `${kind}:${key(value)}` });
  }
}

/** Every pattern match in `text` (original text, not folded), possibly overlapping. */
export function findPatterns(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  add(out, "email", EMAIL, text, (v) => v.toLowerCase());
  for (const regex of [PHONE_US, PHONE_INTERNATIONAL, PHONE_LOCAL, PHONE_PLAIN]) add(out, "phone", regex, text, phoneKey);
  for (const regex of [SSN, ID_LABELLED, ID_LAST_DIGITS, ID_DIGITS, ID_MIXED]) add(out, "id", regex, text, alnum);
  for (const regex of [STREET, STREET_TYPE_FIRST, CITY_ZIP, ZIP_LABELLED, PO_BOX]) add(out, "address", regex, text, addressKey);
  for (const m of text.matchAll(CITY_NO_STATE_ZIP)) {
    if (m[1].split(/\s+/u).some((w) => NOT_PLACES.has(w.toLowerCase()))) continue;
    // Only Florida's ZIP codes (32004 to 34997): a CPT code such as 97153 after a capitalized word is not one.
    const zip = Number(m[2].slice(0, 5));
    if (zip < 32004 || zip > 34997) continue;
    out.push({ kind: "address", start: m.index, end: m.index + m[0].length, key: `address:${addressKey(m[0])}` });
  }
  for (const m of [...text.matchAll(NAME_AFTER_LABEL), ...text.matchAll(TITLED_NAME), ...text.matchAll(NAME_BEFORE_CREDENTIAL)]) {
    let all = m[0].split(" ");
    let start = m.index;
    // Leading words that start a sentence or are a title ("Teacher: Ms. Rivera": the title is not the name; the title rule finds Rivera).
    while (all.length && (STARTERS.has(all[0].toLowerCase()) || TITLE_SET.has(all[0].toLowerCase().replace(/\.$/u, "")))) {
      start += all[0].length + 1;
      all = all.slice(1);
    }
    if (all.length === 0) continue;
    // Stop at a word that starts the next field ("DOB", "Age", an acronym), and drop trailing particles.
    let n = all.findIndex((w, i) => i > 0 && (FIELD_WORDS.has(w.toLowerCase()) || /^\p{Lu}{2,5}$/u.test(w)));
    if (n === -1) n = all.length;
    const words = all.slice(0, n);
    while (words.length > 1 && /^(?:de|del|la|y)$/iu.test(words.at(-1)!)) words.pop();
    if (NOT_NAMES.has(words[0].toLowerCase())) continue;
    const value = words.join(" ").replace(/['\u{2019}]s$/u, "");
    out.push({ kind: "unlisted-name", start, end: start + value.length, key: `unlisted-name:${alnum(value)}` });
  }
  return out;
}

/** The days part of an age, to drop: ", 8 days" in "6 years, 8 months, 8 days"; ";8" in "6;8;8" (and "6-8-8", "6:8:8" after "age" or "CA"). */
const AGE_WORDS_DAYS =
  /\b\d{1,2}\s*(?:years?|yrs?\.?|y\.?|a[nñ]os?)\s*,?\s*(?:and\s+|y\s+)?\d{1,2}\s*(?:months?|mos?\.?|m\.?|meses?)(\s*,?\s*(?:and\s+|y\s+)?\d{1,2}\s*(?:days?|d\.?|d[ií]as?))(?![\p{L}])/giu;
const AGE_SEMICOLON_DAYS = /(?<![\p{N};])\d{1,2};(?:0?\d|1[01])(;\d{1,2})(?![\p{N}]|;\d)/gu;
const AGE_NUMBERS_DAYS =
  /(?<=\b(?:age|ages|chronological\s+age|c\.?a\.?|edad|edad\s+cronol[oó]gica)\s*(?:at\s+testing|al\s+evaluar)?\s*[:=]?\s*)\d{1,2}([:.-])(?:0?\d|1[01])(\1\d{1,2})(?![\p{N}]|[:.-]\d)/giu;

export function findAgeDays(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(AGE_WORDS_DAYS)) out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length });
  for (const m of text.matchAll(AGE_SEMICOLON_DAYS)) out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length });
  for (const m of text.matchAll(AGE_NUMBERS_DAYS)) out.push({ start: m.index + m[0].length - m[2].length, end: m.index + m[0].length });
  return out;
}
