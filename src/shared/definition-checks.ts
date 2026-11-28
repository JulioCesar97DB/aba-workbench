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
const EXPECTED_EN = "(?:respond|begin|began|begun|start|initiat|comply|complie|complied|complet|follow|attend|engag|interact|participat|work|answer|do|does|make|try|tries|tried|attempt|perform|move|look|focus|pay|use|pick|get|go|play|stay|remain|on task|react|reply|repl|transition|join|sit|listen|respon)";
/** The same in Spanish. */
const EXPECTED_ES = "(?:respond|inici|comenz|comienz|comienc|empez|empiez|empiec|sigu|segu|cumpl|complet|atiend|atend|prest|particip|interact|contest|realiz|intent|hac|hag|trabaj|mir|obedec|obedez|reaccion|escuch|jug|jueg|se muev|mov)";

/** Absences and negations: a dead man could "do" each of them. */
const ABSENCE = new RegExp(
  [
    // English
    `${START}(?:not|n't|never)\\s+(?:${L}+ly\\s+|even\\s+|yet\\s+)?${EXPECTED_EN}${L}*`,
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
    `${START}off task${END}`,
    `${START}(?:lack|absence) of${END}`,
    // Spanish
    `${START}no\\s+(?:se\\s+)?${EXPECTED_ES}${L}*`,
    `${START}(?:no\\s+)?(?:hace|hacer|haciendo)\\s+nada${END}`,
    `${START}sin\\s+hacer\\s+nada${END}`,
    `${START}(?:deja|dejar|deje|dejando|dejó)\\s+de\\s+${EXPECTED_ES}${L}*`,
    `${START}deja\\s+de\\s+interactuar${END}`,
    `${START}sin\\s+${EXPECTED_ES}${L}*`,
    `${START}sin\\s+(?:respuesta|intento)${END}`,
    `${START}se\\s+nieg${L}*`,
    `${START}(?:negativa|rechaz${L}*|ignor${L}*)`,
    `${START}(?:falta|ausencia)\\s+de${END}`,
    `${START}fuera\\s+de\\s+(?:la\\s+)?tarea${END}`,
  ].join("|"),
  "giu",
);

/**
 * Observable responses the child makes: inflected forms only (third person, past, gerund), so
 * an instruction's infinitive ("asked to sit down", "told to put the toys away") is never read
 * as the child's response.
 */
const ACTIVE = new RegExp(
  [
    // Words and sounds
    "say(?:s|ing)|said|yell(?:s|ed|ing)|scream(?:s|ed|ing)|shout(?:s|ed|ing)|cr(?:ies|ied|ying)|whin(?:es|ed|ing)|vocaliz(?:es|ed|ing)|hum(?:s|med|ming)|laugh(?:s|ed|ing)|talk(?:s|ed|ing)|speak(?:s|ing)|spoke|sing(?:s|ing)|sang|growl(?:s|ed|ing)|grunt(?:s|ed|ing)|curs(?:es|ed|ing)|swear(?:s|ing)|swore|protest(?:s|ed|ing)|whimper(?:s|ed|ing)|squeal(?:s|ed|ing)",
    // Moving away and the body
    "walk(?:s|ed|ing)|run(?:s|ning)|ran|leav(?:es|ing)|left|exit(?:s|ed|ing)|elop(?:es|ed|ing)|bolt(?:s|ed|ing)|mov(?:es|ed|ing)\\s+away|turn(?:s|ed|ing)\\s+(?:away|around|his|her|their|back)|look(?:s|ed|ing)\\s+away|avert(?:s|ed|ing)|put(?:s|ting)|lay(?:s|ing)|laid|lies\\s+down|lying|drop(?:s|ped|ping)|fall(?:s|ing)|fell|flop(?:s|ped|ping)|sits\\s+down|sat\\s+down|stands\\s+up|stood\\s+up|climb(?:s|ed|ing)|crawl(?:s|ed|ing)|hid(?:es|ing)?|hidden|clos(?:es|ed|ing)\\s+(?:his|her|their)\\s+eyes|cross(?:es|ed|ing)\\s+(?:his|her|their)\\s+arms|fold(?:s|ed|ing)\\s+(?:his|her|their)\\s+arms|cover(?:s|ed|ing)|shak(?:es|ing)|shook|nod(?:s|ded|ding)|gestur(?:es|ed|ing)|point(?:s|ed|ing)\\s+(?:at|to)|flap(?:s|ped|ping)|rock(?:s|ed|ing)|spin(?:s|ning)|spun|jump(?:s|ed|ing)|pac(?:es|ed|ing)|stomp(?:s|ed|ing)|tens(?:es|ed|ing)",
    // Objects and people
    "push(?:es|ed|ing)|pull(?:s|ed|ing)|throw(?:s|ing)|threw|thrown|toss(?:es|ed|ing)|swip(?:es|ed|ing)|sweep(?:s|ing)|swept|knock(?:s|ed|ing)|hit(?:s|ting)|kick(?:s|ed|ing)|bit(?:es|ing)|scratch(?:es|ed|ing)|pinch(?:es|ed|ing)|slap(?:s|ped|ping)|grab(?:s|bed|bing)|snatch(?:es|ed|ing)|tear(?:s|ing)|tore|torn|rip(?:s|ped|ping)|break(?:s|ing)|broke|bang(?:s|ed|ing)|slam(?:s|med|ming)|spit(?:s|ting)|spat|head\\s?butt(?:s|ed|ing)|hand(?:s|ed|ing)\\s+(?:back|away)|mouth(?:s|ed|ing)|lick(?:s|ed|ing)|chew(?:s|ed|ing)|touch(?:es|ed|ing)|rub(?:s|bed|bing)|tap(?:s|ped|ping)|squeez(?:es|ed|ing)|tug(?:s|ged|ging)|play(?:s|ed|ing)|keep(?:s|ing)|kept|continu(?:es|ed|ing)|reach(?:es|ed|ing)|tak(?:es|ing)|took|draw(?:s|ing)|drew|scribbl(?:es|ed|ing)",
    // Spanish
    "dice|dijo|diciendo|grit(?:a|ó|ando)|llor(?:a|ó|ando)|chill(?:a|ó|ando)|habl(?:a|ó|ando)|protest(?:a|ó|ando)|camin(?:a|ó|ando)|corr(?:e|ió|iendo)|sale|salió|saliendo|se\\s+va|se\\s+fue|se\\s+alej(?:a|ó)|alejándose|se\\s+tir(?:a|ó)|se\\s+acuest(?:a)|se\\s+levant(?:a|ó)|se\\s+escond(?:e|ió)|cierr(?:a)\\s+los\\s+ojos|cruz(?:a|ó)\\s+los\\s+brazos|tap(?:a|ó)\\s+(?:sus|los)\\s+oídos|sacud(?:e|ió)|señal(?:a|ó)|salt(?:a|ó|ando)|gir(?:a|ó|ando)|balance(?:a|ó|ándose)|empuj(?:a|ó|ando)|tir(?:a|ó|ando)|lanz(?:a|ó|ando)|arroj(?:a|ó|ando)|golpe(?:a|ó|ando)|pate(?:a|ó|ando)|muerde|mordió|mordiendo|araña|arañó|arañando|pellizc(?:a|ó|ando)|agarr(?:a|ó|ando)|arrebat(?:a|ó|ando)|romp(?:e|ió|iendo)|escup(?:e|ió|iendo)|sigue\\s+jugando|continúa|continuó|jueg(?:a)|jugando|toc(?:a|ó|ando)|muev(?:e)|se\\s+mete|se\\s+lleva",
  ]
    .map((group) => `${START}(?:${group})${END}`)
    .join("|"),
  "iu",
);

/**
 * The first absence the text names, as written, when the text names only absences: no
 * observable response is left once every absence (with the verb it negates) is taken out.
 * Null when the text names no absence, or names an observable response besides.
 */
export function onlyAbsence(text: string): string | null {
  const plain = plainText(text);
  if (plain === "") return null;
  const found = [...plain.matchAll(ABSENCE)];
  if (found.length === 0) return null;
  const rest = plain.replace(ABSENCE, " ");
  if (ACTIVE.test(rest)) return null;
  return found[0][0];
}

/** Whether the text names an observable response, outside its absences. */
export function namesResponse(text: string): boolean {
  return ACTIVE.test(plainText(text).replace(ABSENCE, " "));
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

function names(text: string, other: string): boolean {
  return namesOf(other).some((name) => containsPhrase(text, name) || containsPhrase(text, `${name}s`) || containsPhrase(text, `${name}es`));
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
    topographies: textsOf(behavior.topographies).map(phraseOf).filter(meaningful),
    examples: textsOf(behavior.examples).map(phraseOf).filter((example) => example !== ""),
    // Where a behavior names another one: its exclusions are in its definition, onset, offset or non-examples.
    own: phraseOf([textOf(behavior.definition), textOf(behavior.onset), textOf(behavior.offset), ...textsOf(behavior.nonExamples)].join(" \n ")),
    body: phraseOf([textOf(behavior.definition), textOf(behavior.onset), ...textsOf(behavior.topographies)].join(" \n ")),
  }));
  for (const behavior of read) {
    const definition = onlyAbsence(behavior.definition);
    if (definition !== null) add(behavior.id, { kind: "dead-man", field: "definition", phrase: definition });
    // A latency onset ("no start within 5 seconds") is allowed when the definition names the observable forms.
    const onset = onlyAbsence(behavior.onset);
    if (onset !== null && !namesResponse(behavior.definition)) add(behavior.id, { kind: "dead-man", field: "onset", phrase: onset });
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
