/*
 * Identifiers found by their shape, whether or not they are on the client sheet:
 * email addresses, phone numbers, ID-like numbers, street addresses (with their city,
 * state and ZIP code), ZIP codes after a state, post office boxes, and names the sheet
 * does not list when they follow a label at the start of a line ("Examinee:",
 * "Respondent |") or a title ("Dr.", "Ms.", "Sra."). A sheet name always wins over these.
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
const PHONE_US = new RegExp(`(?<![\\p{L}\\p{N}+])(?:\\+?1[\\s.\\-]?)?(?:\\(\\d{3}\\)[\\s.\\-]?|\\d{3}[\\s.\\-])\\d{3}[\\s.\\-]\\d{4}${EXTENSION}(?![\\p{N}])`, "gu");
const PHONE_INTERNATIONAL = /(?<![\p{L}\p{N}])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?![\p{N}])/gu;
const PHONE_LABEL = "(?:phone|tel|telephone|cell|cellphone|mobile|fax|home|work|tel[eé]fono|celular|m[oó]vil|call|llamar)";
const PHONE_LOCAL = new RegExp(`(?<=${PHONE_LABEL}\\b[^\\n\\d]{0,15})(?<![\\p{N}])\\d{3}[.\\-]\\d{4}(?![\\p{N}])`, "giu");
const PHONE_PLAIN = new RegExp(`(?<=${PHONE_LABEL}\\b[^\\n\\d]{0,15})(?<![\\p{N}])\\d{10}(?![\\p{N}])`, "giu");

const SSN = /(?<![\p{N}-])\d{3}-\d{2}-\d{4}(?![\p{N}-])/gu;
const ID_LABEL =
  "(?:medicaid|medicare|member|subscriber|policy|insurance|mrn|medical\\s+record|record|chart|patient|client|case|account|ssn|social\\s+security|dcf|apd|student|recipient|id|identification|n[uú]mero\\s+de\\s+(?:seguro|miembro|caso|estudiante|identificaci[oó]n))";
const ID_LABELLED = new RegExp(
  `(?<=\\b${ID_LABEL}(?:\\s*(?:id|number|no\\.?|num\\.?|#|n[uú]mero))?\\s*[:#|\\-]?\\s*)(?=[A-Za-z0-9\\-]*(?:\\d[\\s\\-]?){4})[A-Za-z0-9](?:[A-Za-z0-9]|[\\-\\s](?=[A-Za-z0-9]*\\d)){3,24}(?![\\p{L}\\p{N}])`,
  "giu",
);
const ID_DIGITS = /(?<![\p{N}\-/.,:])\d{7,}(?![\p{N}]|[.,]\d)/gu;
const ID_MIXED = /(?<![\p{L}\p{N}-])(?=[A-Z0-9-]*\d{5})(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{5,}(?![\p{L}\p{N}])/gu;

/** "Street" or "street", from one spelling. */
function either(words: string[]): string {
  return words.map((w) => `[${w[0]}${w[0].toLowerCase()}]${w.slice(1)}`).join("|");
}
const STREET_TYPES = either([
  "Street", "St", "Avenue", "Ave", "Av", "Road", "Rd", "Boulevard", "Blvd", "Drive", "Dr", "Lane", "Ln", "Court", "Ct", "Way",
  "Place", "Pl", "Terrace", "Ter", "Circle", "Cir", "Highway", "Hwy", "Parkway", "Pkwy", "Trail", "Trl", "Causeway", "Plaza",
  "Plz", "Square", "Sq", "Loop", "Path", "Row", "Pike", "Alley", "Crescent", "Point", "Calle", "Avenida", "Camino",
]);
const DIRECTION = "(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\\.?";
const STATES =
  "(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Florida|Georgia|Texas|New\\s+York|California|Puerto\\s+Rico)";
const PLACE_WORD = "\\p{Lu}[\\p{L}'.\\-]*";
const CITY_STATE_ZIP = `(?:,\\s*${PLACE_WORD}(?:\\s+${PLACE_WORD}){0,3},?\\s+${STATES}\\.?(?:\\s+\\d{5}(?:-\\d{4})?)?|,?\\s+${STATES}\\s+\\d{5}(?:-\\d{4})?)`;
const UNIT = "(?:,?\\s*(?:Apt|Apartment|Unit|Suite|Ste|Bldg|Building|Lot|Room|Rm|Apto|Apartamento)\\.?\\s*#?\\s*[\\p{L}\\p{N}\\-]+|,?\\s*#\\s*[\\p{L}\\p{N}\\-]+)?";
const STREET = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d{1,6}[A-Za-z]?(?:\\s+${DIRECTION})?(?:\\s+(?:${PLACE_WORD}|\\d+(?:st|nd|rd|th)|\\d+)){1,4}?\\s+(?:${STREET_TYPES})\\b\\.?(?:\\s+${DIRECTION}(?![\\p{L}]))?${UNIT}(?:${CITY_STATE_ZIP})?`,
  "gu",
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

/** Words that start the next field on a form line. */
const FIELD_WORDS = new Set(["dob", "date", "age", "sex", "gender", "grade", "phone", "id", "school", "address", "birth", "fecha", "edad", "sexo"]);

/** A name after a title: "Dr. Tomás Ilustre", "Ms. Whitfield", "Sra. Prado". */
const TITLED_NAME = /(?<=(?<![\p{L}])(?:Dr|Dra|Mr|Mrs|Ms|Miss|Mx|Sr|Sra|Srta|Prof|Lic|Lcda|Lcdo|Dr\.\s*a)\.?[ \t]+)\p{Lu}[\p{L}'-]+(?:[ ](?:\p{Lu}\.|\p{Lu}[\p{L}'-]+|de|del|la|y)){0,3}/gu;

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

/** Street words read the same however they are abbreviated: "Street" and "St." match. */
const ADDRESS_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct", place: "pl",
  terrace: "ter", circle: "cir", highway: "hwy", parkway: "pkwy", trail: "trl", plaza: "plz", square: "sq", apartment: "apt",
  suite: "ste", north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  florida: "fl", avenida: "ave", apto: "apt", apartamento: "apt",
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
  for (const regex of [SSN, ID_LABELLED, ID_DIGITS, ID_MIXED]) add(out, "id", regex, text, alnum);
  for (const regex of [STREET, CITY_ZIP, ZIP_LABELLED, PO_BOX]) add(out, "address", regex, text, addressKey);
  for (const m of [...text.matchAll(NAME_AFTER_LABEL), ...text.matchAll(TITLED_NAME)]) {
    const all = m[0].split(" ");
    // Stop at a word that starts the next field ("DOB", "Age", an acronym), and drop trailing particles.
    let n = all.findIndex((w, i) => i > 0 && (FIELD_WORDS.has(w.toLowerCase()) || /^\p{Lu}{2,5}$/u.test(w)));
    if (n === -1) n = all.length;
    const words = all.slice(0, n);
    while (words.length > 1 && /^(?:de|del|la|y)$/iu.test(words.at(-1)!)) words.pop();
    if (NOT_NAMES.has(words[0].toLowerCase())) continue;
    const value = words.join(" ").replace(/['\u{2019}]s$/u, "");
    out.push({ kind: "unlisted-name", start: m.index, end: m.index + value.length, key: `unlisted-name:${alnum(value)}` });
  }
  return out;
}
