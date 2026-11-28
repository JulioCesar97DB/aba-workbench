/*
 * The definition checks (T3, owner's decisions of 2026-11-28): what the code catches in the
 * behaviors' definitions before her agency's QA or a payer does. Free, run on every behavior
 * of the map as it is shown (after every draft and every edit, hers included), and soft: they
 * only flag, she can approve with them open, and nothing is ever rewritten.
 *
 * - Dead-man test: a definition or an onset made only of an absence ("does nothing", "stops
 *   interacting", "does not begin within 5 seconds", "refuses"), with no observable response
 *   the child makes. A latency onset passes when the definition names an observable response.
 * - Overlap: the same example, or the same topography phrase, in two behaviors, when a behavior
 *   does not name the other one (its exclusion), so one event could be scored twice.
 *
 * The patterns are kept narrow on purpose: when in doubt a definition passes, and the AI
 * review (one request per draft) catches the subtle ones. English and Spanish, since she may
 * type in either.
 */

/** A behavior as the checks read it: the stored item, or what the form holds. */
export interface CheckedBehavior {
  id: string;
  name?: unknown;
  topographies?: unknown;
  definition?: unknown;
  onset?: unknown;
  offset?: unknown;
  examples?: unknown;
  nonExamples?: unknown;
}

export type DefinitionWarning =
  /** The field names only an absence: `phrase` is the first absence found, as written. */
  | { kind: "dead-man"; field: "definition" | "onset"; phrase: string }
  /** The same example or topography phrase as another behavior, which this one does not name. */
  | { kind: "overlap"; via: "example" | "topography"; phrase: string; otherId: string; otherName: string };

const L = "\\p{L}";
const START = "(?<!\\p{L})";
const END = "(?!\\p{L})";

/** The text of a claim (or a plain string), or "". */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && typeof (value as { value?: unknown }).value === "string") return (value as { value: string }).value;
  return "";
}

function textsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(textOf).filter((text) => text.trim() !== "") : [];
}

/** Lower case, curly quotes made straight, hyphens and underscores as spaces, spaces collapsed. */
export function plainText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[-‐-―_]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/* The dead-man test */

/** What the child is expected to do, so that its negation is an absence (English stems). */
const EXPECTED_EN = "(?:respond|begin|began|begun|start|initiat|comply|complie|complied|complian|complet|follow|attend|engag|interact|participat|work|answer|do|does|make|try|tries|tried|attempt|perform|move|look|focus|pay|use|pick|get|go|play|stay|remain|on task|take part|react|reply|repl|transition|join|sit|listen|respon)";
/** The same in Spanish. */
const EXPECTED_ES = "(?:respond|inici|comenz|comienz|comienc|empez|empiez|empiec|sigu|segu|cumpl|complet|atiend|atend|prest|particip|interact|contest|realiz|intent|hac|hag|trabaj|mir|obedec|obedez|reaccion|escuch|jug|jueg|se muev|mov|quier)";

/** Absences and negations: a dead man could "do" each of them. */
const ABSENCE_CORE = [
  // English
  `(?:${START}(?:not|never|cannot|unable\\s+to)|n't)\\s+(?:${L}+ly\\s+|even\\s+|yet\\s+|be\\s+)?${EXPECTED_EN}${L}*`,
  `${START}fail(?:s|ed|ing|ure)?\\s+to\\s+${L}+`,
  `${START}(?:stop|stops|stopped|stopping|cease|ceases|ceased)\\s+(?:to\\s+)?${EXPECTED_EN}${L}*`,
  `${START}(?:does|do|did|doing)\\s+nothing${END}`,
  `${START}no\\s+(?:response|responses|attempt|attempts|initiation|start|answer|movement|engagement|interaction|participation|eye contact|reply)${END}`,
  `${START}without\\s+(?:any\\s+)?${EXPECTED_EN}${L}*`,
  `${START}without\\s+(?:any\\s+)?(?:response|attempt|reply)${END}`,
  `${START}refus(?:e|es|ed|ing|al)${END}`,
  `${START}ignor(?:e|es|ed|ing)${END}`,
  `${START}(?:un|non\\s?)responsive${END}`,
  `${START}non\\s?complian(?:t|ce)${END}`,
  `${START}(?:inattentive|disengaged|passive|inactive|idle)${END}`,
  `${START}(?:remains?|remained|remaining|stays?|stayed|staying)\\s+(?:seated|still|silent|quiet|idle|in\\s+(?:his|her|their)\\s+seat)${END}`,
  `${START}off task${END}`,
  `${START}(?:lack|absence) of${END}`,
  // Spanish
  `${START}(?:no\\s+)?(?:hace|hacer|haciendo)\\s+nada${END}`,
  `${START}no\\s+quiere\\s+${L}+`,
  `${START}no\\s+(?:se\\s+)?${EXPECTED_ES}${L}*`,
  `${START}sin\\s+hacer\\s+nada${END}`,
  `${START}(?:deja|dejar|deje|dejando|dejó)\\s+de\\s+${EXPECTED_ES}${L}*`,
  `${START}deja\\s+de\\s+interactuar${END}`,
  `${START}sin\\s+${EXPECTED_ES}${L}*`,
  `${START}sin\\s+(?:respuesta|intento)${END}`,
  `${START}(?:se\\s+)?nieg${L}*|${START}neg(?:arse|ándose|andose|ó|aba|arse)${END}`,
  `${START}(?:se\\s+)?(?:rehús|rehus)${L}*`,
  `${START}(?:negativa|rechaz${L}*|ignor${L}*|incumpl${L}*|desobedien${L}*)`,
  `${START}(?:falta|ausencia)\\s+de${END}`,
  `${START}fuera\\s+de\\s+(?:la\\s+)?tarea${END}`,
].join("|");
const ABSENCE = new RegExp(ABSENCE_CORE, "giu");
/** An absence with the verb or noun it governs ("refuses to complete", "se niega a hacer", "lack of engagement"). */
const ABSENCE_WITH_OBJECT = new RegExp(`(?:${ABSENCE_CORE})(?:\\s+(?:to|of|a|de|para)\\s+${L}+)?`, "giu");

/**
 * What the adult does, never the child's response: an instruction and what it asks for
 * ("asked to put the toys away", "the instruction to sit down", "se le pide que recoja").
 */
const ADULT_PART = new RegExp(
  [
    `${START}(?:asked|told|instructed|directed|requested|prompted|expected|required)\\s+to\\s+[^,.;:]*?(?=\\s+(?:and|or|but)\\s|[,.;:]|$)`,
    `${START}(?:instructions?|directions?|requests?|demands?|prompts?|commands?)\\s+to\\s+[^,.;:]*?(?=\\s+(?:and|or|but)\\s|[,.;:]|$)`,
    `${START}se\\s+le\\s+(?:pide|pidió|indica|indicó|dice|dijo|da|dio|presenta|presentó)(?:\\s+que)?[^,.;:]*?(?=\\s+(?:y|o|pero)\\s|[,.;:]|$)`,
  ].join("|"),
  "giu",
);

/**
 * The words that frame a definition without naming a response: articles, prepositions,
 * pronouns and auxiliaries; the instance, the time and the threshold; the task, the
 * instruction and the people around the child; the counting words. Whatever else is left
 * once the absences are taken out may be a response, so the definition passes: the code
 * catches the obvious cases only (owner's decision, 2026-11-28; review of T3, finding 1).
 */
const FRAMING = new Set(
  (
    // English
    "a an the any each every all some one this that these those it its in on at of to for from with within by during after before until when whenever while which who whom whose what where or and nor but either neither if than then as so not no " +
    "instance instances episode episodes period periods occurrence occurrences occasion occasions time times event events moment more less least most longer second seconds sec secs s minute minutes min mins hour hours feet foot ft " +
    "is are was were be been being am does do did doing has have had will would shall should can could may might must he she they him her his hers their theirs them himself herself themselves " +
    "child student client learner boy girl task tasks activity activities group demand demands instruction instructions direction directions request requests prompt prompts command commands materials material worksheet assignment part " +
    "adult adults teacher teachers parent parents caregiver caregivers mother father peer peers therapist staff rbt bcba person people name " +
    "presented given assigned delivered issued asked told instructed directed requested placed provided made pass passes passed elapse elapses elapsed " +
    "count counts counted counting once separately onset offset exclusion exclusions behavior behaviors behaviour target attention engagement participation compliance response responses expected required appropriate related same following " +
    // Spanish
    "un una unos unas el la los las lo le les se su sus cualquier cada todo toda todos todas en de del al a por para con que quien cual cuando mientras durante dentro después antes hasta o u y e ni pero si como más menos " +
    "instancia instancias ocasión ocasiones episodio episodios periodo período periodos vez veces momento evento segundo segundos minuto minutos hora horas pie pies " +
    "es son está están era fue ser estar ha han hay él ella ellos ellas niño niña niños alumno alumna estudiante cliente tarea tareas actividad actividades grupo demanda demandas instrucción instrucciones indicación indicaciones petición orden órdenes materiales material " +
    "adulto adultos maestro maestra maestros padre madre padres cuidador cuidadora compañero compañeros terapeuta persona nombre presentada presentado dada dado asignada asignado indicada indicado pedida pedido solicitada pasan pasa transcurren transcurre " +
    "cuenta cuentan contada inicio fin exclusión exclusiones conducta conductas atención participación respuesta mismo misma nada"
  ).split(" "),
);

/** Capitalized words inside a sentence (never its first word): names, such as the child's, which frame like a pronoun. */
function namesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?<=[\p{L}\p{N},)]\s+)(\p{Lu}\p{L}*)/gu)) out.add(match[1].toLowerCase());
  return out;
}

/** The words of a text once its absences and the adult's part are taken out, that do not frame it: what may be a response. */
function responseWords(text: string, known: ReadonlySet<string> = new Set()): string[] {
  const names = new Set([...known, ...namesIn(text)]);
  const rest = plainText(text).replace(ADULT_PART, " ").replace(ABSENCE_WITH_OBJECT, " ");
  return (rest.match(/\p{L}+(?:'\p{L}+)?/gu) ?? []).map((word) => word.replace(/'s$/u, "")).filter((word) => !FRAMING.has(word) && !names.has(word));
}

/**
 * The first absence the text names, as written, when that is all it names: once every
 * absence (with what it governs) and the adult's instruction are taken out, nothing but
 * framing words is left. Null when the text names no absence, or names anything else that
 * could be a response: when in doubt, it passes.
 */
export function onlyAbsence(text: string, names: ReadonlySet<string> = new Set()): string | null {
  const plain = plainText(text);
  if (plain === "") return null;
  const found = [...plain.matchAll(ABSENCE)];
  if (found.length === 0) return null;
  return responseWords(text, names).length === 0 ? found[0][0] : null;
}

/** Whether the text names anything, outside its absences and its framing, that could be a response. */
export function namesResponse(text: string, names: ReadonlySet<string> = new Set()): boolean {
  return responseWords(text, names).length > 0;
}

/** The names a behavior's texts use inside their sentences (the child's), so an onset that opens with the name reads it as one. */
export function namesOfBehavior(texts: readonly string[]): Set<string> {
  return namesIn(texts.join(" \n "));
}

/* Overlap */

/** A phrase as compared: plain text, with punctuation as spaces. */
function phraseOf(text: string): string {
  return plainText(text)
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Whether `phrase` is in `text` as whole words. */
function containsPhrase(text: string, phrase: string): boolean {
  if (phrase === "") return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** A topography worth comparing: at least one word of four letters or more. */
const meaningful = (phrase: string) => /\p{L}{4,}/u.test(phrase);

/**
 * The ways a behavior's name can be written in another's exclusion: the name, with or without
 * a final "behavior", singular or plural ("Tantrum", "tantrums"; "Self injury behavior",
 * "self injury").
 */
function namesOf(name: string): string[] {
  const base = phraseOf(name);
  if (!meaningful(base)) return [];
  const short = base.replace(/\s+(?:behaviors?|behaviours?|conductas?)$/u, "");
  return [...new Set([base, short].filter(meaningful))];
}

/**
 * What makes a clause an exclusion: it says where a response is (or is not) scored
 * ("Exclusions: …", "is counted as Tantrum", "belongs to Property destruction", "score it as
 * Elopement instead", "do not also count", "se cuenta como Berrinche", "en lugar de"). A name
 * mentioned anywhere else ("screaming, crying and dropping", "forms such as screaming",
 * "episodio de gritos") is not an exclusion (review of T3, finding 3).
 */
const EXCLUSION_CUE = new RegExp(
  [
    "exclu\\p{L}*",
    "not\\s+(?:be\\s+)?(?:counted|scored|recorded|coded|included)",
    "(?:does|do|did)\\s+not\\s+(?:also\\s+)?(?:include|count|score)",
    "not\\s+also",
    "instead",
    "rather\\s+than",
    "belongs?\\s+to",
    "(?:counted|scored|recorded|coded|tallied)\\s+(?:as|under|toward|towards|in)",
    "(?:count|score|record|code)\\s+(?:it|them|this|these|that)?\\s*(?:as|under)",
    "see",
    "no\\s+se\\s+(?:cuentan?|registran?|incluyen?)",
    "no\\s+(?:cuenta|incluye)",
    "en\\s+lugar\\s+de",
    "pertenece\\s+a",
    "se\\s+(?:cuentan?|registran?)\\s+como",
    "(?:cuentan?|registran?)\\s+como",
    "ver",
  ]
    .map((cue) => "(?<!\\p{L})" + cue + "(?!\\p{L})")
    .join("|"),
  "iu",
);

/** Whether a behavior's own text names the other behavior in an explicit exclusion: a clause that says where a response is scored, and holds the other's name. */
function names(text: string, other: string): boolean {
  const variants = namesOf(other);
  return text
    .split(/[.;\n]+/u)
    .map(phraseOf)
    .some((clause) => EXCLUSION_CUE.test(clause) && variants.some((name) => containsPhrase(clause, name) || containsPhrase(clause, name + "s") || containsPhrase(clause, name + "es")));
}

/* The AI review (one request per map draft) */

/** One finding of the AI review, as stored, by behavior id. Its texts are the AI's, in English, citing the behaviors by name. */
export type DefinitionReviewFinding =
  | { kind: "dead-man"; behaviorId: string; why: string }
  | { kind: "overlap"; behaviorIds: [string, string]; response: string; exclusion: string };

/** The newest review of the map's definitions, as the screen reads it (caseMap.extractions, kind "map-review"). */
export interface DefinitionReviewView {
  /** When it ran. */
  at: string;
  /** "failed": the review could not run (the map is saved all the same). */
  status: "done" | "failed";
  /** Why it could not run: the provider's error code, or the app's ("unreadable_answer", "no_behaviors"…). */
  failure: string | null;
  /** The behaviors' version it read. */
  behaviorsVersion: number | null;
  /** Each behavior it read, by id, with the fingerprint of the text it read: a behavior changed since was reviewed before the edit. */
  fingerprints: Record<string, string>;
  findings: DefinitionReviewFinding[];
}

/** What the review reads of a behavior, and what its fingerprint covers. */
export function reviewedFields(behavior: CheckedBehavior) {
  return {
    name: textOf(behavior.name).trim(),
    topographies: textsOf(behavior.topographies),
    definition: textOf(behavior.definition),
    onset: textOf(behavior.onset),
    offset: textOf(behavior.offset),
    examples: textsOf(behavior.examples),
    nonExamples: textsOf(behavior.nonExamples),
  };
}

/** A short fingerprint of what the review read of a behavior (FNV-1a, 32 bits, hex): it changes when she edits any of it. */
export function reviewFingerprint(behavior: CheckedBehavior): string {
  const text = JSON.stringify(reviewedFields(behavior));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/* All the checks */

/** The warnings of every behavior, by its id. A behavior with none has no entry. */
export function definitionWarnings(behaviors: readonly CheckedBehavior[]): Map<string, DefinitionWarning[]> {
  const out = new Map<string, DefinitionWarning[]>();
  const add = (id: string, warning: DefinitionWarning) => out.set(id, [...(out.get(id) ?? []), warning]);
  const read = behaviors.map((behavior) => ({
    id: behavior.id,
    name: textOf(behavior.name).trim(),
    definition: textOf(behavior.definition),
    onset: textOf(behavior.onset),
    names: namesOfBehavior([textOf(behavior.definition), textOf(behavior.onset), textOf(behavior.offset), ...textsOf(behavior.examples), ...textsOf(behavior.nonExamples)]),
    topographies: textsOf(behavior.topographies).map(phraseOf).filter(meaningful),
    examples: textsOf(behavior.examples).map(phraseOf).filter((example) => example !== ""),
    // Where a behavior names another one: its exclusions are in its definition, onset, offset or non-examples.
    own: [textOf(behavior.definition), textOf(behavior.onset), textOf(behavior.offset), ...textsOf(behavior.nonExamples)].join(" \n "),
    body: phraseOf([textOf(behavior.definition), textOf(behavior.onset), ...textsOf(behavior.topographies)].join(" \n ")),
  }));
  for (const behavior of read) {
    const definition = onlyAbsence(behavior.definition, behavior.names);
    if (definition !== null) add(behavior.id, { kind: "dead-man", field: "definition", phrase: definition });
    // A latency onset ("no start within 5 seconds") is allowed when the definition names anything that may be a form.
    const onset = onlyAbsence(behavior.onset, behavior.names);
    if (onset !== null && !namesResponse(behavior.definition, behavior.names)) add(behavior.id, { kind: "dead-man", field: "onset", phrase: onset });
  }
  for (const a of read) {
    for (const b of read) {
      if (a === b || a.name === "" || b.name === "") continue;
      // One warning per pair, on each side that does not name the other.
      if (names(a.own, b.name)) continue;
      const example = a.examples.find((phrase) => b.examples.includes(phrase));
      if (example !== undefined) {
        add(a.id, { kind: "overlap", via: "example", phrase: example, otherId: b.id, otherName: b.name });
        continue;
      }
      const topography = a.topographies.find((phrase) => b.topographies.includes(phrase) || containsPhrase(b.body, phrase)) ?? b.topographies.find((phrase) => a.topographies.includes(phrase) || containsPhrase(a.body, phrase));
      if (topography !== undefined) add(a.id, { kind: "overlap", via: "topography", phrase: topography, otherId: b.id, otherName: b.name });
    }
  }
  return out;
}
