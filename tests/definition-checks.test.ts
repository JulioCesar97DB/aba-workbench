import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewPrompt, parseReviewAnswer, reviewAnswerSchema, reviewedBehaviors } from "../src/lib/definition-review.ts";
import { lineText, shownFindings, warningLines } from "../src/renderer/src/case-map/warnings.ts";
import { definitionWarnings, namesResponse, onlyAbsence, reviewFingerprint, type CheckedBehavior } from "../src/shared/definition-checks.ts";

/*
 * The checks before QA (T3, owner's decisions of 2026-11-28): the dead-man test and the
 * overlap between two definitions, in code, and the AI review's answer as the app reads it.
 * Every definition here is invented; the child is "Leo" and shares nothing with the cases.
 */

const claim = (value: string) => ({ value, refs: [], origin: "ai-drafted", check: null });
const textOf = (claim: unknown) => (claim as { value?: string } | null)?.value ?? "";
const behavior = (id: string, fields: { name?: string; definition?: string; onset?: string; offset?: string; topographies?: string[]; examples?: string[]; nonExamples?: string[] }): CheckedBehavior => ({
  id,
  name: fields.name === undefined ? null : claim(fields.name),
  definition: fields.definition === undefined ? null : claim(fields.definition),
  onset: fields.onset === undefined ? null : claim(fields.onset),
  offset: fields.offset === undefined ? null : claim(fields.offset),
  topographies: (fields.topographies ?? []).map(claim),
  examples: (fields.examples ?? []).map(claim),
  nonExamples: (fields.nonExamples ?? []).map(claim),
});

/* The dead-man test: each pattern, on definitions that should fail and on ones that should pass */

const DEAD_MAN: Array<[string, string]> = [
  ["stops interacting", "Any instance in which Leo stops interacting with the adult or the task."],
  ["stops working", "Any instance in which Leo stops working on the assigned task."],
  ["does nothing", "Any instance in which Leo does nothing to begin the task within 5 seconds of an instruction."],
  ["not begin", "Any instance in which Leo does not begin the task within 5 seconds of an instruction."],
  ["not start", "Any instance in which Leo is asked to put the toys away and does not start within 5 seconds."],
  ["not attending", "Any period of 3 seconds or more in which Leo is not attending to the task."],
  ["n't respond", "Any instance in which Leo doesn't respond to an instruction."],
  ["not respond", "Any instance in which Leo does not respond to his name."],
  ["never completes", "Any instance in which Leo never completes the worksheet."],
  ["fails to follow", "Any instance in which Leo fails to follow an instruction within 5 seconds."],
  ["failure to comply", "Failure to comply with an adult's direction within 5 seconds."],
  ["refuses", "Any instance in which Leo refuses to complete a demand."],
  ["refusal", "Task refusal: any refusal of a presented demand."],
  ["ignores", "Any instance in which Leo ignores the instruction."],
  ["no response", "No response within 5 seconds of a direction."],
  ["without starting", "Any instance in which 5 seconds pass after an instruction without starting the task."],
  ["unresponsive", "Any period in which Leo is unresponsive to adult directions."],
  ["non compliant", "Any instance in which Leo is non-compliant with a demand."],
  ["off task", "Any period in which Leo is off task for 3 seconds or more."],
  ["lack of", "Lack of engagement with the materials for 3 seconds or more."],
  ["disengaged", "Any period in which Leo is disengaged from the group activity."],
  // Spanish, if she types in Spanish
  ["deja de interactuar", "Cualquier instancia en la que Leo deja de interactuar con el adulto."],
  ["no hace nada", "Cualquier instancia en la que Leo no hace nada para iniciar la tarea en 5 segundos."],
  ["no responde", "Cualquier instancia en la que Leo no responde a una instrucción."],
  ["no inicia", "Cualquier instancia en la que Leo no inicia la tarea en 5 segundos."],
  ["no sigue", "Cualquier instancia en la que Leo no sigue la instrucción del adulto."],
  ["se niega", "Cualquier instancia en la que Leo se niega a hacer la tarea."],
  ["sin empezar", "Pasan 5 segundos después de la instrucción sin empezar la tarea."],
  ["fuera de tarea", "Cualquier periodo en que Leo está fuera de tarea por 3 segundos o más."],
  ["no presta", "Cualquier periodo en que Leo no presta atención a la tarea."],
  // Review of T3, finding 2: more refusals and absences, in both languages
  ["se rehúsa", "El niño se rehúsa a hacer la tarea."],
  ["negarse", "Negarse a realizar la tarea indicada por el adulto."],
  ["no quiere hacer", "El niño no quiere hacer la tarea cuando se le pide."],
  ["incumplimiento", "Incumplimiento de instrucciones en 5 segundos."],
  ["no cumple", "Cualquier instancia en que el niño no cumple la instrucción."],
  ["cannot begin", "Any instance in which the child cannot begin the task within 5 seconds."],
  ["unable to start", "Any instance in which the child is unable to start the task when asked."],
  ["not compliant", "The child is not compliant with adult demands."],
  ["not take part", "Any instance in which the child does not take part in the group activity."],
  ["remains seated", "Any instance in which the child remains seated and does not begin the task."],
];

const PASSES: string[] = [
  // An absence together with the observable forms
  "Any instance in which Leo does not begin the task within 5 seconds of an instruction and instead says no, walks away, keeps playing or pushes the materials away.",
  "Any instance in which Leo refuses a demand by saying no, putting his head on the table or throwing the materials.",
  "Any period of 3 seconds or more in which Leo looks away from the task materials, leaves his seat or plays with an item not related to the task.",
  "Any instance in which Leo stops working and runs to the door.",
  // The real check's case B (2026-11-28): forms named by argument, a statement and sitting down
  "Any instance in which Leo does not start an instructed action within 5 seconds and instead argues about starting or sits on the floor.",
  "Any instance in which Leo does not begin the worksheet and states that he will not do it.",
  "Cualquier instancia en la que Leo no inicia la tarea en 5 segundos y en su lugar dice que no, se aleja o empuja los materiales.",
  "Cualquier instancia en la que Leo se niega gritando o tirando los materiales al piso.",
  // Active definitions, with exclusions and offsets that hold a negation
  "Any instance in which Leo hits, kicks or pushes a peer or an adult with his hand or foot. Exclusions: high fives and accidental contact are not counted.",
  "Any episode in which Leo cries, screams and drops to the floor. Offset: 30 seconds without crying or screaming.",
  "Any instance in which Leo leaves the supervising adult by more than 6 feet without permission.",
  "Any instance in which Leo throws an object at least 2 feet. Not counted: tossing a ball during play.",
  "Any instance in which Leo spits toward a person, onto the floor or onto materials.",
  "Any instance in which Leo bangs his head against a wall or the floor.",
  "Any instance in which Leo puts a non-food item in his mouth past his lips.",
  // Review of T3, finding 1: the default latency with any observable form passes, whatever the verb
  "Any instance in which the child does not start the task within 10 seconds of the instruction and instead asks for a different activity, signs finished, or engages in a preferred activity.",
  "Cualquier ocasión en que el niño no inicia la tarea en 5 segundos y en su lugar aparta los materiales, se sienta en el piso o pide otra actividad.",
  "Cualquier ocasión en que el niño no empieza lo que se le pidió en 5 segundos y en su lugar pone la cabeza en la mesa o se queja.",
  "Any period of 3 seconds or more without attending to the task, in which the child gazes out the window, doodles or chats with a peer.",
  "Any period in which the child is not looking at the materials or the teacher, for example looking out the window, fidgeting with objects or chatting with peers.",
  "Failure to initiate the instruction within 5 seconds, together with a verbal protest, crumpling the worksheet or sliding under the table.",
  "Any instance in which the child refuses to stand and lies on the floor.",
  "Any instance in which Leo does not start within 5 seconds and hums, rocks or flips the pages of a book.",
  "Cualquier ocasión en que el niño no responde a la instrucción y voltea la cara o se cubre los ojos.",
  "Any instance in which Leo does not follow the direction and instead whistles.",
  // No absence at all: the check has nothing to say about a definition it cannot read as one
  "Any instance in which Leo raises both feet off the floor onto furniture not made for sitting.",
  "Any instance in which Leo repeats words or phrases he heard, out of context.",
  "",
];

test("dead-man: a definition made only of an absence is flagged, with the absence it rests on", () => {
  for (const [phrase, text] of DEAD_MAN) assert.equal(onlyAbsence(text), phrase, text);
});

test("dead-man: an absence with any other word that may be a form, an active definition, and one with no absence pass", () => {
  for (const text of PASSES) assert.equal(onlyAbsence(text), null, text);
});

test("dead-man: the adult's instruction is not the child's response, and a name is not either", () => {
  assert.equal(onlyAbsence("Any instance in which Leo is told to sit down and does not start within 5 seconds."), "not start");
  assert.equal(onlyAbsence("Any instance in which Leo does not follow the instruction to put away the blocks."), "not follow");
  assert.equal(onlyAbsence("Cualquier ocasión en que el niño no inicia la tarea cuando se le pide que recoja los juguetes."), "no inicia");
  assert.equal(namesResponse("Any instance in which Leo does not follow the instruction and puts the blocks on the floor."), true);
  assert.equal(namesResponse("Any instance in which Leo does not look at the materials."), false, "a negated response is not a response");
  // A name opening a sentence is read as one when the behavior's other texts use it inside a sentence.
  assert.equal(onlyAbsence("Leo does not start within 5 seconds."), null, "when in doubt (an unknown first word), it passes");
  assert.equal(onlyAbsence("Leo does not start within 5 seconds.", new Set(["leo"])), "not start");
});

test("dead-man: the definition and the onset are checked; a latency onset passes when the definition names the forms", () => {
  const warnings = definitionWarnings([
    behavior("beh-1", { name: "Task refusal", definition: "Any instance in which Leo refuses a demand.", onset: "Leo does not start within 5 seconds of the instruction." }),
    // Its definition uses the name inside a sentence, so the onset's first word reads as the name.
    behavior("beh-2", { name: "Non-compliant behavior", definition: "Any instance in which Leo says no or walks away after an instruction.", onset: "Leo does not start within 5 seconds of the instruction." }),
    behavior("beh-3", { name: "Off task", definition: "Any period in which Leo looks away from the task for 3 seconds or more.", onset: "Leo stops working." }),
  ]);
  assert.deepEqual(warnings.get("beh-1"), [
    { kind: "dead-man", field: "definition", phrase: "refuses" },
    { kind: "dead-man", field: "onset", phrase: "not start" },
  ]);
  assert.equal(warnings.has("beh-2"), false, "a latency onset with the observable forms in the definition");
  assert.equal(warnings.has("beh-3"), false);
});

/*
 * What the code leaves to the AI review (owner's decision after review round 2, 2026-11-28):
 * the code check stays cautious, with few false alarms. It flags only a definition made of
 * absences and framing words. An absence-only definition that also names a setting, an object
 * or an adjective ("verbal", "academic", "table") passes the code and is the AI review's to
 * catch, after each draft and with "Review the definitions again" after an edit. These are the
 * review's probes; the record says which the code flags today.
 */
const FLAGGED_BY_CODE: Array<[string, string]> = [
  ["not begin", "Any instance in which Sofía does not begin a presented task within 5 seconds of an instruction from an adult."],
  ["not follow", "Any instance in which the child does not follow an instruction within 5 seconds."],
  ["refuses", "Any instance in which the child refuses a demand."],
];
const LEFT_TO_THE_AI_REVIEW: string[] = [
  "Any instance in which Sofía does not begin a presented task within 5 seconds of a verbal instruction from an adult.",
  "Any instance in which the child does not start an academic task within 5 seconds of the teacher's instruction.",
  "Any instance in which the child does not follow a one step instruction within 5 seconds.",
  "Any instance in which the child stops working on the assigned worksheet at the table for 10 seconds or longer.",
  "Any instance in which the child does not respond to a greeting or to his name within 5 seconds.",
  "The child is not engaged in the classroom activity for 3 seconds or more during circle time.",
  "Any instance in which the child refuses a non preferred task at home or at school.",
  "Any instance in which the child does not transition to the next activity within 5 seconds of the cue.",
  "Any instance in which the child ignores the adult's directions during the session.",
  "Off task: the child is not attending to the task or the speaker for 3 consecutive seconds.",
  "Cualquier ocasión en que el niño no sigue una instrucción verbal del adulto dentro de 5 segundos.",
  "Cualquier ocasión en que la niña no inicia la tarea académica en la mesa en 5 segundos.",
  "El niño deja de trabajar en la hoja de actividades durante 10 segundos o más.",
];

test("dead-man, the record of the review's probes: the code flags the plainest absence-only definitions, and leaves the rest to the AI review", () => {
  for (const [phrase, text] of FLAGGED_BY_CODE) assert.equal(onlyAbsence(text, new Set(["sofía"])), phrase, text);
  for (const text of LEFT_TO_THE_AI_REVIEW) assert.equal(onlyAbsence(text, new Set(["sofía"])), null, "left to the AI review: " + text);
});

/* Overlap */

test("overlap: the same example in two behaviors, with no exclusion naming the other, flags both", () => {
  const scene = "Leo screamed and dropped to the floor when the tablet was taken away.";
  const warnings = definitionWarnings([
    behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries and drops to the floor.", examples: [scene] }),
    behavior("beh-2", { name: "Screaming", definition: "Any instance in which Leo screams above conversational volume.", examples: ["  " + scene.toUpperCase() + " "] }),
  ]);
  assert.deepEqual(warnings.get("beh-1"), [{ kind: "overlap", via: "example", phrase: "leo screamed and dropped to the floor when the tablet was taken away", otherId: "beh-2", otherName: "Screaming" }]);
  const other = warnings.get("beh-2")?.[0];
  assert.ok(other?.kind === "overlap" && other.otherName === "Tantrum");
});

test("overlap: the same topography phrase, or one behavior's topography inside another's definition", () => {
  const same = definitionWarnings([
    behavior("beh-1", { name: "Physical aggression", definition: "Any instance in which Leo pushes a person.", topographies: ["Pushes the adult with both hands"] }),
    behavior("beh-2", { name: "Task refusal", definition: "Any instance in which Leo pushes the adult away from the table.", topographies: ["pushes the adult with both hands."] }),
  ]);
  const first = same.get("beh-1")?.[0];
  assert.ok(first?.kind === "overlap" && first.via === "topography");
  assert.equal(same.get("beh-2")?.length, 1);
  const inside = definitionWarnings([
    behavior("beh-1", { name: "Screaming", definition: "Any instance in which Leo screams above conversational volume.", topographies: ["screaming"] }),
    behavior("beh-2", { name: "Tantrum", definition: "Any episode of crying, screaming and dropping to the floor." }),
  ]);
  assert.deepEqual(inside.get("beh-1"), [{ kind: "overlap", via: "topography", phrase: "screaming", otherId: "beh-2", otherName: "Tantrum" }]);
  assert.deepEqual(inside.get("beh-2"), [{ kind: "overlap", via: "topography", phrase: "screaming", otherId: "beh-1", otherName: "Screaming" }]);
});

test("overlap: exclusions that name each other end it; one that names the other only quiets its own side", () => {
  const both = definitionWarnings([
    behavior("beh-1", { name: "Screaming", definition: "Any instance in which Leo screams. Exclusions: screaming during a tantrum is counted as Tantrum.", topographies: ["screaming"] }),
    behavior("beh-2", { name: "Tantrum", definition: "Any episode of crying, screaming and dropping to the floor. Screaming outside an episode is counted as Screaming." }),
  ]);
  assert.equal(both.size, 0);
  const one = definitionWarnings([
    behavior("beh-1", { name: "Screaming", definition: "Any instance in which Leo screams.", nonExamples: ["Leo screams during one of his tantrums (counted as Tantrum)."], topographies: ["screaming"] }),
    behavior("beh-2", { name: "Tantrum", definition: "Any episode of crying, screaming and dropping to the floor." }),
  ]);
  assert.equal(one.has("beh-1"), false, "a non-example that names the other is an exclusion; a plural name counts");
  assert.equal(one.get("beh-2")?.length, 1);
  const shortName = definitionWarnings([
    behavior("beh-1", { name: "Self injury behavior", definition: "Any instance in which Leo hits his own head with his hand.", topographies: ["hits his own head"] }),
    behavior("beh-2", { name: "Head banging", definition: "Any instance in which Leo hits his own head against a surface. Hitting with his hand is counted as self injury.", topographies: ["hits his own head"] }),
  ]);
  assert.equal(shortName.has("beh-2"), false, "the name without a final behavior counts");
  assert.equal(shortName.get("beh-1")?.length, 1);
});

test("overlap: a name mentioned as a form, after such as, or after de is not an exclusion: both sides are flagged (review of T3, finding 3)", () => {
  const pairs: Array<[CheckedBehavior, CheckedBehavior]> = [
    [behavior("beh-1", { name: "Tantrum", definition: "Screaming, crying and dropping to the floor for 10 seconds or more." }), behavior("beh-2", { name: "Screaming", definition: "Any instance of screaming above conversational volume.", topographies: ["screaming"] })],
    [behavior("beh-1", { name: "Tantrum", definition: "An episode of crying with forms such as screaming and dropping to the floor." }), behavior("beh-2", { name: "Screaming", definition: "Any instance of screaming above conversational volume.", topographies: ["screaming"] })],
    [behavior("beh-1", { name: "Berrinche", definition: "Episodio de gritos, llanto y tirarse al piso." }), behavior("beh-2", { name: "Gritos", definition: "Cualquier grito por encima del volumen de conversación.", topographies: ["gritos"] })],
  ];
  for (const pair of pairs) {
    const warnings = definitionWarnings(pair);
    assert.equal(warnings.get("beh-1")?.length, 1, String(textOf(pair[0].definition)));
    assert.equal(warnings.get("beh-2")?.length, 1, String(textOf(pair[0].definition)));
  }
  // An explicit exclusion in Spanish quiets its side.
  const spanish = definitionWarnings([
    behavior("beh-1", { name: "Berrinche", definition: "Episodio de gritos, llanto y tirarse al piso. Los gritos fuera de un episodio se cuentan como Gritos." }),
    behavior("beh-2", { name: "Gritos", definition: "Cualquier grito por encima del volumen de conversación. Un grito dentro de un episodio se cuenta como Berrinche.", topographies: ["gritos"] }),
  ]);
  assert.equal(spanish.size, 0);
});

test("overlap: a form after instead is not an exclusion, so the side that holds the shared response is flagged (review of T3, round 2, finding 2)", () => {
  const warnings = definitionWarnings([
    behavior("beh-1", { name: "Task refusal", definition: "Any instance in which Leo does not begin a task within 5 seconds of the instruction and instead starts screaming." }),
    behavior("beh-2", { name: "Screaming", definition: "Any instance in which Leo screams above conversational volume. A scream when a demand is presented is counted as Screaming; see Task refusal.", topographies: ["screaming"] }),
  ]);
  assert.deepEqual(warnings.get("beh-1"), [{ kind: "overlap", via: "topography", phrase: "screaming", otherId: "beh-2", otherName: "Screaming" }]);
  assert.equal(warnings.has("beh-2"), false, "Screaming names Task refusal in an exclusion clause (see)");
  // "rather than" and "en lugar de" introduce a form the same way.
  const rather = definitionWarnings([
    behavior("beh-1", { name: "Task refusal", definition: "Any instance in which Leo does not begin a task within 5 seconds, screaming rather than starting." }),
    behavior("beh-2", { name: "Screaming", definition: "Any instance in which Leo screams.", topographies: ["screaming"] }),
  ]);
  assert.equal(rather.get("beh-1")?.length, 1);
  const enLugar = definitionWarnings([
    behavior("beh-1", { name: "Berrinche", definition: "Episodio de llanto en lugar de gritos." }),
    behavior("beh-2", { name: "Gritos", definition: "Cualquier grito.", topographies: ["gritos"] }),
  ]);
  assert.equal(enLugar.get("beh-1")?.length, 1);
});

test("overlap: distinct behaviors stay quiet, a short word is not a topography, and a behavior with no name is skipped", () => {
  const warnings = definitionWarnings([
    behavior("beh-1", { name: "Elopement", definition: "Any instance in which Leo moves more than 6 feet away from the supervising adult without permission.", topographies: ["runs to the door"], examples: ["Leo ran to the door of the clinic."] }),
    behavior("beh-2", { name: "Mouthing", definition: "Any instance in which Leo puts a non-food item past his lips.", topographies: ["puts toys in his mouth", "to"], examples: ["Leo put a block in his mouth."] }),
    behavior("beh-3", { definition: "Any instance in which Leo runs to the door.", topographies: ["runs to the door"] }),
  ]);
  assert.equal(warnings.size, 0);
});

test("the warnings run on her own text too, in Spanish", () => {
  const warnings = definitionWarnings([behavior("beh-1", { name: "Off task", definition: "Cualquier periodo en que Leo deja de trabajar en la tarea." })]);
  assert.deepEqual(warnings.get("beh-1"), [{ kind: "dead-man", field: "definition", phrase: "deja de trabajar" }]);
});

/* The AI review's answer */

test("review: its fingerprint changes when any field it read changes, and only then", () => {
  const first = behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries." });
  assert.equal(reviewFingerprint(first), reviewFingerprint(behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries." })));
  assert.notEqual(reviewFingerprint(first), reviewFingerprint(behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries and screams." })));
  assert.notEqual(reviewFingerprint(first), reviewFingerprint(behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries.", nonExamples: ["Leo cries when hurt."] })));
  assert.match(reviewFingerprint(first), /^[0-9a-f]{8}$/);
});

test("review: the schema is strict, every object closed and fully required, with no union", () => {
  const schema = reviewAnswerSchema() as { properties: Record<string, { items: { required: string[]; additionalProperties: boolean } }>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.required, ["deadMan", "overlaps"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.deadMan.items.required, ["behavior", "why"]);
  assert.deepEqual(schema.properties.overlaps.items.required, ["first", "second", "response", "exclusion"]);
  assert.equal(schema.properties.overlaps.items.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(schema), /anyOf|"type":\[/);
});

test("review: an answer is read by the ids it was sent; unknown ids, a pair with itself, repeats and empty reasons are left out", () => {
  const ids = new Set(["beh-1", "beh-2", "beh-3"]);
  const answer = {
    deadMan: [
      { behavior: "beh-1", why: "Task refusal names only that Leo refuses." },
      { behavior: "beh-1", why: "Again." },
      { behavior: "beh-9", why: "Not sent." },
      { behavior: "beh-2", why: "  " },
    ],
    overlaps: [
      { first: "beh-2", second: "beh-3", response: "Leo screams while on the floor.", exclusion: "Tantrum should count it; Screaming should exclude it." },
      { first: "beh-3", second: "beh-2", response: "The same pair again.", exclusion: "" },
      { first: "beh-3", second: "beh-3", response: "Itself.", exclusion: "" },
    ],
  };
  const read = parseReviewAnswer(JSON.stringify(answer), ids);
  assert.ok(read.ok);
  assert.deepEqual(read.findings, [
    { kind: "dead-man", behaviorId: "beh-1", why: "Task refusal names only that Leo refuses." },
    { kind: "overlap", behaviorIds: ["beh-2", "beh-3"], response: "Leo screams while on the floor.", exclusion: "Tantrum should count it; Screaming should exclude it." },
  ]);
  assert.equal(read.dropped, 5);
});

test("review: a long name where an id belongs is dropped, not a failure; an overlap with no exclusion is dropped; trailing text is read", () => {
  const ids = new Set(["beh-1", "beh-2"]);
  const read = parseReviewAnswer(
    JSON.stringify({
      deadMan: [
        { behavior: "Non-compliant behavior during demands at school and at home", why: "Named by its name." },
        { behavior: "beh-1", why: "Kept." },
      ],
      overlaps: [{ first: "beh-1", second: "beh-2", response: "Leo screams on the floor.", exclusion: "" }],
    }) + " done",
    ids,
  );
  assert.ok(read.ok);
  assert.deepEqual(read.findings, [{ kind: "dead-man", behaviorId: "beh-1", why: "Kept." }]);
  assert.equal(read.dropped, 2);
});

const FENCE = String.fromCharCode(96).repeat(3);

test("review: plain JSON in a code fence is read; anything else that is not the shape is refused", () => {
  const ids = new Set(["beh-1"]);
  const fenced = parseReviewAnswer(FENCE + 'json\n{"deadMan":[],"overlaps":[]}\n' + FENCE, ids);
  assert.ok(fenced.ok && fenced.findings.length === 0);
  assert.equal(parseReviewAnswer("not json", ids).ok, false);
  assert.equal(parseReviewAnswer(JSON.stringify({ deadMan: [] }), ids).ok, false, "a missing list");
  assert.equal(parseReviewAnswer(JSON.stringify({ deadMan: [{ behavior: "beh-1", why: "x", rewrite: "a new definition" }], overlaps: [] }), ids).ok, false, "no field of its own, such as a rewrite");
  const long = parseReviewAnswer(JSON.stringify({ deadMan: [{ behavior: "beh-1", why: "x".repeat(5000) }], overlaps: [] }), ids);
  assert.ok(long.ok && long.findings[0].kind === "dead-man" && long.findings[0].why.length <= 1500, "a long reason is cut to fit");
});

test("review: the prompt sends the behaviors' fields only, no sources, with its own kind", () => {
  const sent = reviewedBehaviors([
    behavior("beh-1", { name: "Tantrum", definition: "Any episode in which Leo cries.", examples: ["Leo cried at the table."] }),
    behavior("beh-2", {}),
  ]);
  assert.deepEqual(sent, [{ id: "beh-1", name: "Tantrum", topographies: [], definition: "Any episode in which Leo cries.", onset: "", offset: "", examples: ["Leo cried at the table."], nonExamples: [] }], "an empty behavior is not sent");
  const prompt = buildReviewPrompt("RULES", sent, "json-schema");
  assert.equal(prompt.kind, "definition-review");
  assert.equal(prompt.system, "RULES");
  assert.deepEqual(prompt.sources, []);
  assert.match(prompt.task, /<behaviors>[\s\S]*"beh-1"[\s\S]*<\/behaviors>/);
  assert.match(prompt.task, /Answer in the structured format/);
  assert.match(buildReviewPrompt("RULES", sent, "plain-json").task, /following this JSON schema exactly:\n\{"type":"object"/);
});

/* On screen: each behavior's lines (src/renderer/src/case-map/warnings.ts) */

test("on screen: the code's warnings and the review's findings on each behavior; a finding on a behavior changed since is marked", () => {
  const t = ((key: string, options?: Record<string, unknown>) => `${key} ${JSON.stringify(options ?? {})}`) as unknown as Parameters<typeof warningLines>[0];
  const items = [
    behavior("beh-1", { name: "Task refusal", definition: "Any instance in which Leo refuses a demand." }),
    behavior("beh-2", { name: "Tantrum", definition: "Any episode in which Leo cries and drops to the floor." }),
    behavior("beh-3", { name: "Screaming", definition: "Any instance in which Leo screams." }),
  ];
  const fingerprints = Object.fromEntries(items.map((item) => [item.id, reviewFingerprint(item)]));
  fingerprints["beh-3"] = "00000000";
  const map = {
    parts: { behaviors: { items } },
    definitionReview: {
      at: "2026-11-28T10:00:00.000Z",
      status: "done",
      failure: null,
      behaviorsVersion: 1,
      fingerprints,
      findings: [
        { kind: "dead-man", behaviorId: "beh-1", why: "Task refusal names only an absence." },
        { kind: "overlap", behaviorIds: ["beh-2", "beh-3"], response: "Leo screams while on the floor.", exclusion: "Tantrum should count it." },
        { kind: "dead-man", behaviorId: "beh-7", why: "A behavior she removed since." },
      ],
    },
  } as never;
  const lines = warningLines(t, map);
  const one = lines.get("beh-1") ?? [];
  assert.equal(one.length, 2);
  assert.match(lineText(one[0]), /^caseMap\.qa\.deadManDefinition .*"phrase":"refuses"/);
  assert.deepEqual(one[0].parts.map((part) => part.lang), [undefined], "the app's words are in her language");
  assert.match(lineText(one[1]), /^caseMap\.qa\.aiDeadMan \{\} Task refusal names only an absence\.$/);
  assert.deepEqual(one[1].parts.map((part) => part.lang), [undefined, "en"], "the app's prefix in her language, the AI's reason marked English (nit 8)");
  assert.equal(one[1].stale, false);
  const tantrum = lines.get("beh-2") ?? [];
  assert.match(lineText(tantrum[0]), /"other":"Screaming"/);
  assert.deepEqual(tantrum[0].parts.map((part) => part.lang), [undefined, "en", undefined, "en"]);
  assert.equal(tantrum[0].stale, true, "the other behavior changed after the review");
  assert.match(lineText((lines.get("beh-3") ?? [])[0]), /"other":"Tantrum"/);
  assert.equal(lines.has("beh-7"), false);
  // The status line counts what is shown: not the finding on a behavior removed since (nit 9).
  assert.equal(shownFindings((map as { definitionReview: never }).definitionReview, new Set(["beh-1", "beh-2", "beh-3"])).length, 2);
  const failed = warningLines(t, { parts: { behaviors: { items } }, definitionReview: { ...(map as { definitionReview: object }).definitionReview, status: "failed" } } as never);
  assert.equal(failed.get("beh-1")?.length, 1, "a failed review shows no findings, only the code's");
});
