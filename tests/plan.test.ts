import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CASE_FILE_NAME, CASE_SCHEMA_VERSION, newCaseData, readCaseFile, readableCaseFileText, serializeCaseFile, type CaseData } from "../src/main/case-file.ts";
import { addMapItem, caseMapView, decidePlanItems, markPlanCopied, planSummaryOf, planView, saveMapItem, type StoredCaseMap } from "../src/main/case-map.ts";
import { CaseMapService } from "../src/main/case-map-service.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { confirmHbiIntro, planInstructionsOf, readInstructionsFile } from "../src/main/instructions.ts";
import { acceptedPlan, fingerprint, functionBlocks, HBI_INTRO_DRAFT, planMapInputOf, type PlanView } from "../src/shared/plan.ts";
import { aversiveTerm, elopementFeet, latencySeconds, offsetSeconds, planChecks, type PlanFinding } from "../src/shared/plan-checks.ts";
import { ageInYears, caregiverBaseline, masteryPercent, parameterSeconds, programTarget, roundToTen, sessionPercent, skillBaseline } from "../src/shared/plan-compute.ts";
import { baselineSentence, isCopied, planCopy } from "../src/shared/plan-copy.ts";

/*
 * The plan by hand (the Plan step, PR 1): schema 6 and its migration, decisions per item,
 * the function blocks, every computation, every code check (texts that should pass and
 * texts that should fail), and the copy for ABA Matrix. Invented data only: Tomás V. is
 * invented, as every behavior, strategy and program here.
 */

const ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const T0 = "2026-11-28T10:00:00.000Z";
const T1 = "2026-11-28T10:01:00.000Z";
const T2 = "2026-11-28T10:02:00.000Z";

const claim = (value: string, check: string | null = null) => ({ value, check });
const fn = (primary: string[], secondary: string[] = []) => ({ primary, secondary, evidence: [], reasoning: null, check: null });
const param = (label: string, role: string, value: string, unit: string) => ({ label, role, value: claim(value), unit });

function blank(): CaseData {
  return newCaseData({ id: ID, label: "Invented plan case", clientAge: { years: 6, months: 4 }, now: new Date(T0) });
}

/** Adds an item by hand and returns the data and its id. */
function add(data: CaseData, part: Parameters<typeof addMapItem>[1], input: Record<string, unknown>): [CaseData, string] {
  const added = addMapItem(data, part, "items", input, null, T1);
  return [added.data, added.itemId];
}

/** An invented map: non-compliance (escape, latency 5 s), physical aggression (escape and attention, dangerous), elopement (escape, 6 ft), mouthing (sensory). */
function withMap(): CaseData {
  let data = blank();
  [data] = add(data, "behaviors", { name: claim("Non-compliant behavior"), definition: claim("Any instance in which Tomás does not begin a task within 5 seconds of an instruction."), offset: claim("He begins the task."), function: fn(["escape"]) });
  [data] = add(data, "behaviors", {
    name: claim("Physical aggression"),
    definition: claim("Any instance in which Tomás hits, kicks or pushes another person with his hand or foot."),
    offset: claim("The behavior has stopped for 10 consecutive seconds."),
    function: fn(["escape"], ["attention"]),
    risks: [claim("Hits younger peers at school.")],
  });
  [data] = add(data, "behaviors", { name: claim("Elopement"), definition: claim("Any instance in which Tomás moves more than 6 feet away from the supervising adult without permission."), function: fn(["escape"]) });
  [data] = add(data, "behaviors", { name: claim("Mouthing"), definition: claim("Any instance in which Tomás puts a non-food object past his lips."), function: fn(["sensory"]) });
  return data;
}

const kinds = (findings: PlanFinding[]) => findings.map((finding) => finding.kind);
const checksOf = (data: CaseData, hbiIntro: string | null = null) => planChecks({ plan: planView(data), map: planMapInputOf(caseMapView(data)), hbiIntro });

/* Schema 6 and its migration (D5) */

test("schema 6: a version 5 case with a map opens unchanged, with no plan, and is written as version 6 only when next saved", () => {
  const data = withMap();
  const v5 = { ...JSON.parse(serializeCaseFile(data)), schemaVersion: 5 };
  const read = readCaseFile(JSON.stringify(v5));
  assert.ok(read.ok);
  assert.equal(read.migratedFrom, 5);
  // Nothing added: the same data, in the current version.
  assert.deepEqual(read.data, { ...v5, schemaVersion: CASE_SCHEMA_VERSION });
  assert.equal(CASE_SCHEMA_VERSION, 6);
  const plan = planView(read.data);
  for (const part of Object.values(plan.parts)) assert.deepEqual(part.items, []);
  assert.deepEqual(plan.copied, {});
  assert.deepEqual(planSummaryOf(read.data), { decided: 0, total: 0 });
  // Saved again, it is a version 6 file holding the same map.
  const text = readableCaseFileText(read.data);
  assert.ok(text);
  assert.equal(JSON.parse(text).schemaVersion, 6);
  assert.deepEqual(JSON.parse(text).caseMap, v5.caseMap);
});

test("schema 6: a newer file (version 7, a plan this app might not understand) is never read for writing", () => {
  const text = JSON.stringify({ ...JSON.parse(serializeCaseFile(withMap())), schemaVersion: CASE_SCHEMA_VERSION + 1 });
  assert.deepEqual(readCaseFile(text), { ok: false, problem: "newer-version" });
});

test("schema 6: a plan reads back whole; a plan item past its limits makes the file damaged, never half read", () => {
  let data = withMap();
  [data] = add(data, "strategies", { name: claim("Effective instruction delivery"), kind: "antecedent", functions: ["escape"], parameters: [param("Wait before prompting", "prompt-delay", "5", "s")] });
  [data] = add(data, "programs", { kind: "replacement", title: claim("Requesting a break"), function: "escape", outcome: "break" });
  const text = readableCaseFileText(data);
  assert.ok(text, "a plan the app writes reads back whole");
  const read = readCaseFile(text);
  assert.ok(read.ok);
  assert.deepEqual(planView(read.data).parts.strategies.items[0].parameters[0], { label: "Wait before prompting", role: "prompt-delay", value: { value: "5", refs: [{ kind: "her" }], origin: "her", check: null }, unit: "s" });
  // Thirteen parameters: past the limit of twelve.
  const stored = JSON.parse(text);
  const strategy = stored.caseMap.parts.strategies.versions[0].content.items[0];
  strategy.parameters = Array.from({ length: 13 }, () => strategy.parameters[0]);
  assert.deepEqual(readCaseFile(JSON.stringify(stored)), { ok: false, problem: "damaged" });
  // An unknown key or decision word a newer app writes is kept.
  const kept = JSON.parse(text);
  kept.caseMap.parts.strategies.versions[0].content.items[0].decision = "deferred";
  kept.caseMap.parts.strategies.versions[0].content.items[0].later = { by: "a newer app" };
  const keptRead = readCaseFile(JSON.stringify(kept));
  assert.ok(keptRead.ok);
  assert.deepEqual(JSON.parse(serializeCaseFile(keptRead.data)).caseMap.parts.strategies.versions[0].content.items[0].later, { by: "a newer app" });
  assert.equal(planView(keptRead.data).parts.strategies.items[0].decision, "deferred");
});

/* Decisions (D2, D3, D4) */

/** A strategies part with an AI version (as PR 2 will write): two proposals. */
function withProposals(): CaseData {
  const ai = (id: string, name: string) => ({ id, name: { value: name, refs: [], origin: "proposed", check: null }, kind: "antecedent", functions: ["escape"], parameters: [], decision: "proposed", decidedAt: null, by: "ai" });
  const map: StoredCaseMap = {
    ...(withMap().caseMap as StoredCaseMap),
  };
  map.parts = { ...map.parts, strategies: { currentVersion: 1, approvedVersion: null, versions: [{ number: 1, kind: "ai", createdAt: T0, content: { items: [ai("stg-1", "First/Then"), ai("stg-2", "Visual timer"), ai("stg-3", "Scheduled breaks")] } }] } };
  return { ...withMap(), caseMap: map };
}

test("decisions: an item she adds is hers and accepted; an AI proposal waits as proposed", () => {
  let data = withMap();
  [data] = add(data, "strategies", { name: claim("Visual schedule") });
  const mine = planView(data).parts.strategies.items[0];
  assert.equal(mine.decision, "accepted");
  assert.equal(mine.by, "her");
  assert.equal(mine.decidedAt, T1);
  const proposed = planView(withProposals()).parts.strategies.items;
  assert.deepEqual(proposed.map((item) => item.decision), ["proposed", "proposed", "proposed"]);
  assert.deepEqual(planSummaryOf(withProposals()), { decided: 0, total: 3 });
});

test("decisions: editing a proposal accepts it (D3); the AI's version stays as it was", () => {
  const data = withProposals();
  const edited = saveMapItem(data, "strategies", "items", "stg-1", { name: claim("First/Then board") }, null, T1);
  assert.ok(edited && edited !== "item-not-found");
  const item = planView(edited.data).parts.strategies.items[0];
  assert.equal(item.decision, "accepted");
  assert.equal(item.editedAt, T1);
  assert.equal(item.by, "ai", "still the AI's item: shown as corrected by her");
  assert.equal(item.name?.origin, "her");
  const versions = edited.data.caseMap!.parts.strategies.versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[0].content.items[0].decision, "proposed", "the AI's version never changes");
  assert.equal(versions[1].kind, "edited");
});

test("decisions: accept, reject and recover go into her editing pass; Aceptar lo que queda never accepts what she rejected (D4)", () => {
  let data = withProposals();
  const rejected = decidePlanItems(data, [{ part: "strategies", itemId: "stg-2", decision: "rejected" }], {}, T1);
  assert.ok(rejected && rejected !== "item-not-found");
  data = rejected.data;
  const pass = rejected.versions.strategies!;
  assert.equal(pass, 2, "the first decision starts her editing pass");
  // "Aceptar lo que queda": every item of the view, undecided ones only.
  const rest = decidePlanItems(
    data,
    ["stg-1", "stg-2", "stg-3"].map((itemId) => ({ part: "strategies" as const, itemId, decision: "accepted" as const })),
    { strategies: pass },
    T2,
    true,
  );
  assert.ok(rest && rest !== "item-not-found");
  assert.equal(rest.versions.strategies, pass, "the same editing pass: no version per click");
  data = rest.data;
  assert.deepEqual(planView(data).parts.strategies.items.map((item) => item.decision), ["accepted", "rejected", "accepted"]);
  assert.deepEqual(planSummaryOf(data), { decided: 3, total: 3 });
  // Recuperar: back to undecided.
  const recovered = decidePlanItems(data, [{ part: "strategies", itemId: "stg-2", decision: "proposed" }], { strategies: pass }, T2);
  assert.ok(recovered && recovered !== "item-not-found");
  const back = planView(recovered.data).parts.strategies.items[1];
  assert.equal(back.decision, "proposed");
  assert.equal(back.decidedAt, null);
  assert.equal(decidePlanItems(recovered.data, [{ part: "strategies", itemId: "stg-2", decision: "proposed" }], {}, T2), null, "nothing to change");
  assert.equal(decidePlanItems(data, [{ part: "strategies", itemId: "stg-9", decision: "accepted" }], {}, T2), "item-not-found");
  assert.equal(recovered.data.caseMap!.parts.strategies.versions[0].content.items[1].decision, "proposed", "the AI's version never changes");
});

/* The function blocks (D7) */

test("blocks: one per function a behavior has, primary or secondary, in her order; a group is one unit", () => {
  let data = withMap();
  assert.deepEqual(
    functionBlocks(planMapInputOf(caseMapView(data))).map((block) => [block.function, block.behaviors.map((behavior) => behavior.name)]),
    [
      ["attention", ["Physical aggression"]],
      ["escape", ["Non-compliant behavior", "Physical aggression", "Elopement"]],
      ["sensory", ["Mouthing"]],
    ],
  );
  const escape = functionBlocks(planMapInputOf(caseMapView(data))).find((block) => block.function === "escape")!;
  assert.deepEqual(escape.units.map((unit) => [unit.name, unit.dangerous]), [["Non-compliant behavior", false], ["Physical aggression", true], ["Elopement", false]]);
  // Two escape behaviors in one group of the map: one management entry.
  data = addMapItem(data, "behaviors", "groups", { behaviorIds: ["beh-1", "beh-3"], nature: "Leaving the task", function: "escape", measure: "frequency", reason: "Same nature, same function." }, null, T1).data;
  const grouped = functionBlocks(planMapInputOf(caseMapView(data))).find((block) => block.function === "escape")!;
  assert.deepEqual(grouped.units.map((unit) => unit.name), ["Non-compliant behavior; Elopement", "Physical aggression"]);
});

/* Computations (§4.4: D10, D11, D12, D13) */

test("compute: the program count by her rule, and her override", () => {
  assert.deepEqual(programTarget({ ageYears: 4, hoursText: "20" }), { target: 25, rule: "under-5", openItem: false, ageYears: 4, hours: 20 });
  assert.deepEqual(programTarget({ ageYears: 6, hoursText: "20" }), { target: 20, rule: "hours", openItem: false, ageYears: 6, hours: 20 });
  assert.deepEqual(programTarget({ ageYears: 6, hoursText: "" }), { target: 30, rule: "default", openItem: true, ageYears: 6, hours: null });
  assert.equal(programTarget({ ageYears: null, hoursText: "about 20" }).rule, "default", "an unreadable number is no hours");
  assert.equal(programTarget({ ageYears: 6, hoursText: "0" }).rule, "default");
  assert.deepEqual(programTarget({ ageYears: 6, hoursText: "20", overrideText: "28" }).target, 28);
  assert.equal(programTarget({ ageYears: 6, hoursText: "20", overrideText: "lots" }).rule, "hours", "an unreadable override is ignored");
});

test("compute: the age from the map's client, or the case's", () => {
  assert.equal(ageInYears("6 years 4 months", null), 6);
  assert.equal(ageInYears("4 años", null), 4);
  assert.equal(ageInYears("6;4", null), 6);
  assert.equal(ageInYears("born in 2020", { years: 6 }), 6);
  assert.equal(ageInYears(null, null), null);
});

test("compute: a skill's baseline is the mean of its sessions, rounded to the nearest 10%; else the caregiver's report, checked", () => {
  const session = (correct: string, opportunities = "10") => ({ date: null, correct: { value: correct, refs: [], origin: "her", check: null }, opportunities: { value: opportunities, refs: [], origin: "her", check: null } });
  const base = { sessions: [], caregiverReport: null, caregiverPercent: null, override: null };
  assert.equal(skillBaseline({ ...base, sessions: [session("1"), session("0"), session("2")] }).percent, 10);
  assert.equal(skillBaseline({ ...base, sessions: [session("1"), session("2")] }).percent, 20, "15% rounds up to 20%");
  assert.equal(skillBaseline({ ...base, sessions: [session("3", "4")] }).percent, 80, "75% rounds up");
  const unreadable = skillBaseline({ ...base, sessions: [session("about 3")] });
  assert.equal(unreadable.percent, null);
  assert.equal(unreadable.unreadable, true);
  assert.equal(skillBaseline({ ...base, sessions: [session("11")] }).percent, null, "more correct than opportunities");
  const reported = skillBaseline({ ...base, caregiverPercent: { value: "15%", refs: [], origin: "her", check: null } });
  assert.deepEqual([reported.percent, reported.source, reported.check], [20, "caregiver", true]);
  const mine = skillBaseline({ ...base, sessions: [session("1")], override: { value: "30", refs: [], origin: "her", check: null } });
  assert.deepEqual([mine.percent, mine.source], [30, "override"]);
  assert.equal(skillBaseline(base).percent, null);
  assert.equal(sessionPercent("2", "0"), null);
  assert.equal(roundToTen(44.9), 40);
});

test("compute: mastery from its category (90, 95, 100), caregiver baselines, parameters in seconds", () => {
  assert.deepEqual(masteryPercent("general"), { percent: 90, source: "category" });
  assert.deepEqual(masteryPercent("safety"), { percent: 95, source: "category" });
  assert.deepEqual(masteryPercent("street-crossing"), { percent: 100, source: "category" });
  assert.deepEqual(masteryPercent("unknown-from-a-newer-app"), { percent: 90, source: "category" });
  assert.deepEqual(masteryPercent("general", "80"), { percent: 80, source: "override" });
  assert.deepEqual(caregiverBaseline("0"), { percent: 0, check: false });
  assert.deepEqual(caregiverBaseline("20%"), { percent: 20, check: true });
  assert.equal(caregiverBaseline(""), null);
  const p = (value: string, unit: string) => ({ value: { value, refs: [], origin: "her", check: null }, unit });
  assert.equal(parameterSeconds(p("3", "s")), 3);
  assert.equal(parameterSeconds(p("2", "min")), 120);
  assert.equal(parameterSeconds(p("Immediately", "other")), 0);
  assert.equal(parameterSeconds(p("3-5", "s")), null);
  assert.equal(parameterSeconds(p("6", "ft")), null);
});

/* The code checks (§5; D19 to D21): texts that should fail, and texts that should pass */

test("checks: her never-list and extinction or punishment, in English and Spanish, skipping negations", () => {
  const fail = [
    "The RBT uses planned ignoring when Tomás screams.",
    "Escape extinction: the task stays until he complies.",
    "Response blocking when he mouths objects.",
    "A time-out of 2 minutes after hitting.",
    "Hand-over-hand guidance to finish the worksheet.",
    "The RBT will ignore the behavior and wait.",
    "Do not allow escape from the demand.",
    "Remove the privilege of tablet time.",
    "Se usa tiempo fuera después de pegar.",
    "El RBT aplica extinción de escape.",
    "Se le quitan los privilegios.",
  ];
  for (const text of fail) assert.ok(aversiveTerm(text), `should flag: ${text}`);
  const pass = [
    "No extinction procedures are used.",
    "Instead of time-out, the RBT offers a break card.",
    "Extinction is not used in this plan.",
    "Punishment will never be used.",
    "The RBT redirects Tomás with the least intrusive prompt.",
    "Nunca se usa castigo.",
    "Sin tiempo fuera: el RBT redirige.",
    "He shows self-restraint when waiting.",
    "The RBT gives a full physical prompt, then fades it.",
    "The RBT ignores nothing: every request is honored.",
  ];
  for (const text of pass) assert.equal(aversiveTerm(text), null, `should pass: ${text}`);
});

test("checks: a behavior's thresholds are read only when plain", () => {
  const behavior = (definition: string, offset: string | null = null, name = "X") => ({ id: "beh-1", name: { value: name }, definition: { value: definition }, onset: null, offset: offset === null ? null : { value: offset } });
  assert.equal(latencySeconds(behavior("Tomás does not begin a task within 5 seconds of an instruction.")), 5);
  assert.equal(latencySeconds(behavior("Tomás hits with an open hand.")), null);
  assert.equal(latencySeconds(behavior("He does not begin within 5 seconds, or within 10 seconds at school.")), null, "two values: none");
  assert.equal(offsetSeconds(behavior("x", "The behavior has stopped for 10 consecutive seconds.")), 10);
  assert.equal(offsetSeconds(behavior("x", "He calms down.")), null);
  assert.equal(elopementFeet(behavior("Moving more than 6 feet away from the adult.", null, "Elopement")), 6);
  assert.equal(elopementFeet(behavior("Moving more than 6 feet away from the adult.", null, "Wandering in class")), null, "not an elopement by its words: no distance read");
});

test("checks: a prompt before the latency, a delivery before the offset and a proximity past the elopement distance, through the blocks only (D20)", () => {
  let data = withMap();
  [data] = add(data, "strategies", { name: claim("Effective instruction delivery"), kind: "antecedent", functions: ["escape"], parameters: [param("Wait before a gestural prompt", "prompt-delay", "3", "s")] });
  [data] = add(data, "strategies", { name: claim("Close supervision"), kind: "antecedent", functions: ["escape"], parameters: [param("Stay within", "proximity", "10", "ft")] });
  [data] = add(data, "strategies", { name: claim("Reinforcement after calm"), kind: "consequence", parameters: [param("Calm before delivery", "calm-before-delivery", "5", "s")] });
  [data] = add(data, "interventions", { function: "escape", kind: "maladaptive", behaviorIds: ["beh-2"], groupId: null, text: claim("The RBT keeps a safe distance and redirects."), strategyIds: ["stg-3"], safetyFirst: true });
  // A prompt delay in a block the behavior is not in is never compared with it.
  [data] = add(data, "strategies", { name: claim("Quick prompt for mouthing"), kind: "antecedent", functions: ["sensory"], parameters: [param("Prompt delay", "prompt-delay", "1", "s")] });
  const found = checksOf(data).filter((finding) => finding.kind === "prompt-before-latency" || finding.kind === "delivery-before-offset" || finding.kind === "proximity-beyond-elopement");
  assert.deepEqual(
    found.map((finding) => [finding.kind, "behaviorName" in finding ? finding.behaviorName : "", "itemName" in finding ? finding.itemName : ""]),
    [
      ["prompt-before-latency", "Non-compliant behavior", "Effective instruction delivery"],
      ["delivery-before-offset", "Physical aggression", "Reinforcement after calm"],
      ["proximity-beyond-elopement", "Elopement", "Close supervision"],
    ],
  );
  // Her wait of 5 s (or more), a calm of 10 s and a distance within 6 ft pass.
  const fixed = saveMapItem(data, "strategies", "items", "stg-1", { parameters: [param("Wait before a gestural prompt", "prompt-delay", "5", "s")] }, null, T2);
  assert.ok(fixed && fixed !== "item-not-found");
  let next = fixed.data;
  for (const [id, parameters] of [
    ["stg-2", [param("Stay within", "proximity", "6", "ft")]],
    ["stg-3", [param("Calm before delivery", "calm-before-delivery", "10", "s")]],
  ] as const) {
    const saved = saveMapItem(next, "strategies", "items", id, { parameters }, null, T2);
    assert.ok(saved && saved !== "item-not-found");
    next = saved.data;
  }
  const after = kinds(checksOf(next));
  for (const kind of ["prompt-before-latency", "delivery-before-offset", "proximity-beyond-elopement"]) assert.equal(after.includes(kind as PlanFinding["kind"]), false, kind);
  // A parameter whose role says nothing (other) is never compared, whatever its label says.
  const vague = saveMapItem(next, "strategies", "items", "stg-1", { parameters: [param("Prompt delay", "other", "1", "s")] }, null, T2);
  assert.ok(vague && vague !== "item-not-found");
  assert.equal(kinds(checksOf(vague.data)).includes("prompt-before-latency"), false);
});

test("checks: every function needs a functionally equivalent replacement (§5.2)", () => {
  let data = withMap();
  let found = checksOf(data);
  assert.deepEqual(found.filter((finding) => finding.kind === "no-replacement").map((finding) => finding.function), ["attention", "escape", "sensory"]);
  [data] = add(data, "programs", { kind: "replacement", title: claim("Requesting a break"), function: "escape", outcome: "break" });
  [data] = add(data, "programs", { kind: "replacement", title: claim("Waiting for a preferred item"), function: "attention", outcome: "item" });
  [data] = add(data, "programs", { kind: "replacement", title: claim("Chewing gum during table work"), function: "sensory", outcome: "other" });
  found = checksOf(data);
  assert.deepEqual(
    found.filter((finding) => finding.kind === "no-replacement" || finding.kind === "no-equivalent-replacement" || finding.kind === "replacement-outcome-other").map((finding) => [finding.kind, finding.function]),
    [
      ["no-equivalent-replacement", "attention"],
      ["replacement-outcome-other", "sensory"],
    ],
  );
  // A rejected replacement does not count.
  const rejected = decidePlanItems(data, [{ part: "programs", itemId: "prg-1", decision: "rejected" }], {}, T2);
  assert.ok(rejected && rejected !== "item-not-found");
  assert.ok(checksOf(rejected.data).some((finding) => finding.kind === "no-replacement" && finding.function === "escape"));
});

test("checks: one management entry per behavior or group, the safety step first for a dangerous one", () => {
  let data = withMap();
  [data] = add(data, "interventions", { function: "escape", kind: "maladaptive", behaviorIds: ["beh-2"], groupId: null, text: claim("The RBT redirects Tomás to ask for a break."), strategyIds: [], safetyFirst: false });
  [data] = add(data, "interventions", { function: "escape", kind: "maladaptive", behaviorIds: ["beh-1"], groupId: null, text: claim("The RBT repeats the instruction once."), strategyIds: [], safetyFirst: false });
  [data] = add(data, "interventions", { function: "escape", kind: "maladaptive", behaviorIds: ["beh-1"], groupId: null, text: claim("A second entry for the same behavior."), strategyIds: [], safetyFirst: false });
  const escape = checksOf(data).filter((finding) => finding.function === "escape");
  assert.deepEqual(
    escape.filter((finding) => ["no-management", "two-management", "safety-first-missing"].includes(finding.kind)).map((finding) => [finding.kind, "unitName" in finding ? finding.unitName : ""]),
    [
      ["two-management", "Non-compliant behavior"],
      ["safety-first-missing", "Physical aggression"],
      ["no-management", "Elopement"],
    ],
  );
});

test("checks: the extinction check reads every plan text, hers included, and a rejected item is never flagged", () => {
  let data = withMap();
  [data] = add(data, "interventions", { function: "attention", kind: "maladaptive", behaviorIds: ["beh-2"], groupId: null, text: claim("The RBT uses planned ignoring."), strategyIds: [], safetyFirst: true });
  [data] = add(data, "programs", { kind: "skill", title: claim("Washing hands"), procedure: [claim("Present the sink."), claim("No hand-over-hand guidance is used.")] });
  let found = checksOf(data, "Extinction is never part of these interventions.").filter((finding) => finding.kind === "aversive");
  assert.deepEqual(found.map((finding) => (finding.kind === "aversive" ? [finding.item.part, finding.term] : [])), [["interventions", "planned ignoring"]]);
  found = checksOf(data, "Time-out follows aggression.").filter((finding) => finding.kind === "aversive");
  assert.equal(found.length, 2, "her confirmed intro is checked too");
  const rejected = decidePlanItems(data, [{ part: "interventions", itemId: "hbi-1", decision: "rejected" }], {}, T2);
  assert.ok(rejected && rejected !== "item-not-found");
  assert.equal(checksOf(rejected.data).filter((finding) => finding.kind === "aversive").length, 0);
});

test("checks: the glossary covers every strategy by the same name, with its numbers, no Implementation: label, and varied openings", () => {
  let data = withMap();
  [data] = add(data, "strategies", { name: claim("Effective instruction delivery"), kind: "antecedent", functions: ["escape"], parameters: [param("Wait", "prompt-delay", "5", "s")] });
  [data] = add(data, "strategies", { name: claim("Visual timer"), kind: "antecedent", functions: ["escape"] });
  [data] = add(data, "glossary", { strategyId: "stg-1", definition: claim("Giving one clear instruction before waiting for a response."), implementation: claim("With Tomás, the RBT will wait 3 seconds before a gestural prompt.") });
  let found = checksOf(data);
  assert.deepEqual(
    found.filter((finding) => finding.view === "glossary").map((finding) => [finding.kind, "itemName" in finding ? finding.itemName : ""]),
    [
      ["glossary-missing", "Visual timer"],
      ["glossary-number", "Effective instruction delivery"],
    ],
  );
  // The entry with the strategy's own number passes; then the strategy changes and the entry is out of date.
  let saved = saveMapItem(data, "glossary", "items", "glo-1", { implementation: claim("With Tomás, the RBT will wait 5 seconds before a gestural prompt.") }, null, T2);
  assert.ok(saved && saved !== "item-not-found");
  data = saved.data;
  assert.equal(kinds(checksOf(data)).includes("glossary-number"), false);
  assert.equal(kinds(checksOf(data)).includes("glossary-stale"), false);
  saved = saveMapItem(data, "strategies", "items", "stg-1", { parameters: [param("Wait", "prompt-delay", "6", "s")] }, null, T2);
  assert.ok(saved && saved !== "item-not-found");
  data = saved.data;
  found = checksOf(data);
  assert.ok(kinds(found).includes("glossary-stale"));
  // An "Implementation:" label.
  saved = saveMapItem(data, "glossary", "items", "glo-1", { implementation: claim("Implementation: the RBT waits 6 seconds.") }, null, T2);
  assert.ok(saved && saved !== "item-not-found");
  assert.ok(kinds(checksOf(saved.data)).includes("implementation-label"));
  // Five entries opening alike: fewer than three openings.
  let many = withMap();
  for (let index = 1; index <= 5; index++) {
    [many] = add(many, "strategies", { name: claim(`Strategy ${index}`) });
    [many] = add(many, "glossary", { strategyId: `stg-${index}`, definition: claim("A procedure."), implementation: claim("With Tomás, the RBT will use it.") });
  }
  assert.ok(kinds(checksOf(many)).includes("few-openings"));
});

test("checks: task analyses of 4 to 6 steps, baselines in multiples of 10", () => {
  let data = withMap();
  [data] = add(data, "programs", { kind: "skill", title: claim("Washing hands"), measure: "task-analysis-steps", procedure: ["Turn on the water.", "Wet hands.", "Soap.", "Rub.", "Rinse.", "Dry.", "Throw the towel away.", "Turn off the water."].map((step) => claim(step)) });
  [data] = add(data, "programs", { kind: "skill", title: claim("Saying his address"), baseline: { sessions: [], caregiverReport: claim("Mother says he knows part of it."), caregiverPercent: claim("15"), override: null } });
  [data] = add(data, "programs", { kind: "skill", title: claim("Tacting colors"), measure: "task-analysis-steps", procedure: ["One.", "Two.", "Three.", "Four."].map((step) => claim(step)) });
  assert.deepEqual(
    checksOf(data).filter((finding) => finding.view === "programs" && finding.kind !== "aversive").map((finding) => finding.kind),
    ["task-analysis-steps", "baseline-not-ten"],
  );
});

/* Copy for ABA Matrix (D22, D23) */

function planForCopy(): CaseData {
  let data = withProposals();
  // Accepted by hand: a replacement, a skill with sessions, a management entry, glossary entries, a goal.
  [data] = add(data, "programs", {
    kind: "replacement",
    title: claim("Requesting a break"),
    function: "escape",
    outcome: "break",
    definition: claim("When presented with a task, Tomás requests a break by saying \"break\"."),
    procedure: [claim("Place the break card within reach."), claim("Wait 5 s for an independent request."), claim("Record each opportunity.")],
    baseline: { sessions: [1, 0, 2].map((correct) => ({ date: null, correct: claim(String(correct)), opportunities: claim("10") })), caregiverReport: null, caregiverPercent: null, override: null },
  });
  [data] = add(data, "programs", { kind: "skill", title: claim("Crossing the street with an adult"), mastery: { category: "street-crossing", override: null }, baseline: { sessions: [], caregiverReport: claim("Mother reports he stops at the curb some days."), caregiverPercent: claim("20"), override: null } });
  [data] = add(data, "interventions", { function: "escape", kind: "positive", behaviorIds: [], groupId: null, text: claim("When Tomás asks for a break, the RBT honors it at once."), strategyIds: [], safetyFirst: false });
  [data] = add(data, "interventions", { function: "escape", kind: "maladaptive", behaviorIds: ["beh-2"], groupId: null, text: claim("The RBT moves materials out of reach and redirects Tomás to ask for a break."), strategyIds: ["stg-1"], safetyFirst: true });
  [data] = add(data, "strategies", { name: claim("Visual schedule"), kind: "antecedent", functions: ["escape"] });
  [data] = add(data, "glossary", { strategyId: "stg-4", definition: claim("A sequence of pictures of the day's activities."), implementation: claim("For Tomás, the RBT will show three pictures.") });
  // An entry for a proposal not accepted yet: not copied.
  [data] = add(data, "glossary", { strategyId: "stg-1", definition: claim("A statement of what comes first."), implementation: claim("During homework, the RBT will show a card.") });
  [data] = add(data, "caregiverGoals", { kind: "interventions", title: claim("Caregivers will implement the interventions"), procedure: claim("The BCBA will model each strategy."), baselinePercent: claim("0") });
  return data;
}

const viewOf = (data: CaseData): { plan: PlanView; map: ReturnType<typeof planMapInputOf> } => ({ plan: planView(data), map: planMapInputOf(caseMapView(data)) });

test("copy: only accepted items, field by field, in ABA Matrix's order, plain text", () => {
  const groups = planCopy({ ...viewOf(planForCopy()), hbiIntro: null });
  assert.deepEqual(groups.map((group) => [group.section, group.label]), [
    [11, "Requesting a break"],
    [12, "Crossing the street with an adult"],
    [14, "Introduction"],
    [14, "Escape"],
    [15, "Glossary"],
    [16, "Caregivers will implement the interventions"],
  ]);
  const replacement = groups[0];
  assert.deepEqual(replacement.fields.map((field) => field.label), ["Name", "Definition", "Procedure", "Baseline"]);
  assert.equal(replacement.fields[2].text, "1. Place the break card within reach.\n2. Wait 5 s for an independent request.\n3. Record each opportunity.");
  assert.equal(replacement.fields[3].text, "A baseline of 10%.");
  assert.deepEqual(replacement.values, [
    { label: "Measure", value: "Percentage of opportunities" },
    { label: "Mastery criterion", value: "90%" },
  ]);
  assert.equal(groups[1].fields[3].text, "A baseline of 20%, per the caregiver's report. [CHECK: not measured in session]");
  assert.equal(groups[1].fields[3].markers, 1);
  assert.deepEqual(groups[1].values[1], { label: "Mastery criterion", value: "100%" });
  // The intro: our draft, marked to confirm, until she confirms hers.
  assert.equal(groups[2].fields[0].text, `${HBI_INTRO_DRAFT} [CHECK: confirm the intro]`);
  assert.equal(planCopy({ ...viewOf(planForCopy()), hbiIntro: "Her own intro." })[2].fields[0].text, "Her own intro.");
  const escape = groups[3];
  assert.deepEqual(
    escape.fields.map((field) => [field.label, field.text]),
    [
      ["Behaviors", "Non-compliant behavior, Physical aggression, Elopement"],
      ["Preventive Strategies", "Visual schedule"],
      ["Replacement Skills", "Requesting a break"],
      ["Management Strategies", "Positive:\nWhen Tomás asks for a break, the RBT honors it at once.\n\nMaladaptive:\nPhysical aggression: The RBT moves materials out of reach and redirects Tomás to ask for a break."],
    ],
  );
  assert.ok(escape.whole?.startsWith("Behaviors:\nNon-compliant behavior, Physical aggression, Elopement\n\nPreventive Strategies:\nVisual schedule"));
  // The glossary: only the entry whose strategy is accepted; the proposal's entry waits.
  assert.equal(groups[4].fields[0].text, "Visual schedule: A sequence of pictures of the day's activities. For Tomás, the RBT will show three pictures.");
  assert.deepEqual(groups[5].fields.map((field) => field.text), ["Caregivers will implement the interventions", "The BCBA will model each strategy.", "A baseline of 0%."]);
  for (const group of groups) for (const field of group.fields) assert.doesNotMatch(field.text, /\*\*|^#|<[a-z]/mu, "plain text: no markdown or HTML");
  // Accepting the proposals brings their names in, alphabetically.
  const accepted = decidePlanItems(planForCopy(), ["stg-1", "stg-2", "stg-3"].map((itemId) => ({ part: "strategies" as const, itemId, decision: "accepted" as const })), {}, T2, true);
  assert.ok(accepted && accepted !== "item-not-found");
  const after = planCopy({ ...viewOf(accepted.data), hbiIntro: null });
  assert.equal(after.find((group) => group.label === "Escape")!.fields[1].text, "First/Then\nVisual timer\nScheduled breaks\nVisual schedule");
  assert.match(after.find((group) => group.section === 15)!.fields[0].text, /^First\/Then: .*\n\nVisual schedule: /su);
  assert.equal(acceptedPlan(accepted.data && planView(accepted.data)).strategies.length, 4);
});

test("copy: a baseline that cannot be read is [MISSING], never a guess", () => {
  let data = withMap();
  [data] = add(data, "programs", { kind: "skill", title: claim("Tacting"), baseline: { sessions: [{ date: null, correct: claim("3 or 4"), opportunities: claim("10") }], caregiverReport: null, caregiverPercent: claim("40"), override: null } });
  assert.equal(baselineSentence(planView(data).parts.programs.items[0]), "[MISSING: baseline; a session's counts are not plain numbers]");
});

test("copy: a copied mark holds while the field's text is the same, and goes when it changes (D23)", () => {
  let data = planForCopy();
  const field = planCopy({ ...viewOf(data), hbiIntro: null })[0].fields[1];
  data = markPlanCopied(data, [{ id: field.id, fingerprint: fingerprint(field.text) }], T2);
  const marked = planView(data);
  assert.equal(isCopied(marked, field), true);
  assert.equal(marked.copied[field.id].copiedAt, T2);
  assert.equal(marked.copied[field.id].versions.programs, data.caseMap!.parts.programs.currentVersion);
  assert.ok(readableCaseFileText(data), "the marks read back whole");
  const edited = saveMapItem(data, "programs", "items", "prg-1", { definition: claim("When presented with a task, Tomás asks for a break.") }, null, T2);
  assert.ok(edited && edited !== "item-not-found");
  const now = planCopy({ ...viewOf(edited.data), hbiIntro: null })[0].fields[1];
  assert.equal(isCopied(planView(edited.data), now), false);
});

/* The HBI intro (D16) */

test("the HBI intro: our draft until she confirms it once; kept in the plan's standing instructions", () => {
  const empty = readInstructionsFile(null);
  assert.ok(empty.ok);
  assert.deepEqual(planInstructionsOf(empty.file), { text: "", hbiIntro: null });
  const confirmed = confirmHbiIntro(empty.file, "  Her intro, in two sentences. The second one.  ", new Date(T1));
  assert.deepEqual(planInstructionsOf(confirmed), { text: "", hbiIntro: { text: "Her intro, in two sentences. The second one.", confirmedAt: T1 } });
  assert.throws(() => confirmHbiIntro(empty.file, "   ", new Date(T1)), /Refused/);
  // A section's instructions are untouched, and an unknown key a newer app writes in the plan's entry is kept.
  assert.deepEqual(Object.keys(confirmed.sections), ["plan"]);
});

/* Through the service, as the interface reaches it */

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function serviceSetup() {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-plan-test-"));
  folders.push(folder);
  let ids = 0;
  const cases = new CaseLibrary({ location: async () => ({ folder, isDefault: false }), newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, log: () => undefined });
  const created = await cases.create({ label: "Invented plan case", clientAge: { years: 6, months: 4 } });
  assert.ok(created.outcome === "created");
  const clipboard: string[] = [];
  let intro: { text: string; confirmedAt: string } | null = null;
  const service = new CaseMapService({
    cases,
    instructions: { plan: async () => ({ text: "", hbiIntro: intro }), saveHbiIntro: async (text) => ((intro = { text, confirmedAt: T1 }), true) },
    writeClipboard: (text) => void clipboard.push(text),
  });
  return { cases, service, clipboard, caseId: created.case.id, caseFile: path.join(folder, "Invented plan case", CASE_FILE_NAME) };
}

const json = (value: unknown) => JSON.stringify(value);

test("plan service: add by hand, decide, copy a field and the whole block; the sidebar's count follows", async () => {
  const { service, cases, clipboard, caseId, caseFile } = await serviceSetup();
  const behavior = await service.addItem(caseId, "behaviors", "items", json({ name: claim("Non-compliant behavior"), function: fn(["escape"]) }), null);
  assert.ok(behavior.outcome === "saved");
  const strategy = await service.addItem(caseId, "strategies", "items", json({ name: claim("Visual schedule"), kind: "antecedent", functions: ["escape"] }), null);
  assert.ok(strategy.outcome === "saved" && strategy.itemId === "stg-1");
  assert.deepEqual(strategy.planSummary, { decided: 1, total: 1 });
  const typed = await service.saveItem(caseId, "strategies", "items", "stg-1", json({ name: claim("Visual schedule board") }), strategy.version);
  assert.ok(typed.outcome === "saved");
  assert.equal(typed.version, strategy.version, "her editing pass");
  const read = await service.getPlan(caseId);
  assert.ok(read.outcome === "read");
  assert.equal(read.plan.parts.strategies.items[0].name?.value, "Visual schedule board");
  assert.deepEqual(read.instructions, { text: "", hbiIntro: null });
  const rejected = await service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "rejected" }], { strategies: typed.version }, false);
  assert.ok(rejected.outcome === "saved");
  assert.deepEqual(rejected.planSummary, { decided: 1, total: 1 });
  const recovered = await service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "accepted" }], rejected.versions ?? {}, false);
  assert.ok(recovered.outcome === "saved");

  const copied = await service.copyPlanFields(caseId, ["hbi:escape:preventive"]);
  assert.ok(copied.outcome === "copied" && copied.result?.outcome === "saved");
  assert.deepEqual(clipboard, ["Visual schedule board"]);
  assert.ok(copied.result.plan.copied["hbi:escape:preventive"]);
  const whole = await service.copyPlanFields(caseId, ["hbi:escape:behaviors", "hbi:escape:preventive", "hbi:escape:replacement", "hbi:escape:management"]);
  assert.ok(whole.outcome === "copied");
  assert.match(clipboard[1], /^Behaviors:\nNon-compliant behavior\n\nPreventive Strategies:\nVisual schedule board\n\nReplacement Skills:\n\[MISSING: replacement skills\]/u);
  assert.equal(whole.markers, 2);
  assert.deepEqual(await service.copyPlanFields(caseId, ["hbi:tangibles:behaviors"]), { outcome: "field-not-found" });

  const intro = await service.confirmHbiIntro("Her intro.");
  assert.deepEqual(intro, { outcome: "saved", instructions: { text: "", hbiIntro: { text: "Her intro.", confirmedAt: T1 } } });
  await service.copyPlanFields(caseId, ["hbi-intro"]);
  assert.equal(clipboard.at(-1), "Her intro.");

  const opened = await cases.open(caseId);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(opened.case.plan, { decided: 1, total: 1 });
  assert.equal(JSON.parse(readFileSync(caseFile, "utf8")).schemaVersion, 6);
});

test("plan service: hostile input is refused before anything is written; the map's approval is not the plan's", async () => {
  const { service, caseId, caseFile } = await serviceSetup();
  const before = readFileSync(caseFile, "utf8");
  await assert.rejects(service.decide(caseId, [{ part: "planInputs", itemId: "plan", decision: "accepted" }], {}, false), /Refused/);
  await assert.rejects(service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "maybe" }], {}, false), /Refused/);
  await assert.rejects(service.decide(caseId, [], {}, false), /Refused/);
  await assert.rejects(service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "accepted" }], { strategies: 0 }, false), /Refused/);
  await assert.rejects(service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "accepted" }], {}, "yes"), /Refused/);
  await assert.rejects(service.copyPlanFields(caseId, ["../x"]), /Refused/);
  await assert.rejects(service.copyPlanFields(caseId, []), /Refused/);
  await assert.rejects(service.addItem(caseId, "strategies", "items", json({ decision: "accepted" }), null), /Refused/, "a decision is never typed in");
  await assert.rejects(service.addItem(caseId, "strategies", "items", json({ by: "ai" }), null), /Refused/);
  await assert.rejects(service.approve(caseId, "strategies", 1), /Refused: not a part/);
  await assert.rejects(service.setCurrent(caseId, "programs", 1), /Refused: not a part/);
  await assert.rejects(service.confirmHbiIntro(""), /Refused/);
  assert.equal(readFileSync(caseFile, "utf8"), before);
  assert.deepEqual(await service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "accepted" }], {}, false), { outcome: "item-not-found" });
});

test("plan service: a case from a newer app is never written to, through any plan call", async () => {
  const { service, caseId, caseFile, clipboard } = await serviceSetup();
  writeFileSync(caseFile, JSON.stringify({ ...JSON.parse(readFileSync(caseFile, "utf8")), schemaVersion: CASE_SCHEMA_VERSION + 1 }, null, 2));
  const before = readFileSync(caseFile, "utf8");
  assert.deepEqual(await service.getPlan(caseId), { outcome: "case-unavailable" });
  for (const call of [
    () => service.addItem(caseId, "strategies", "items", json({}), null),
    () => service.saveItem(caseId, "planInputs", "items", "plan", json({ weeklyHours: claim("20") }), null),
    () => service.decide(caseId, [{ part: "strategies", itemId: "stg-1", decision: "accepted" }], {}, false),
    () => service.copyPlanFields(caseId, ["glossary"]),
  ]) {
    assert.deepEqual(await call(), { outcome: "case-unavailable" });
  }
  assert.equal(readFileSync(caseFile, "utf8"), before);
  assert.deepEqual(clipboard, []);
});
