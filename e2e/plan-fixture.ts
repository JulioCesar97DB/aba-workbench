import { newCaseData, serializeCaseFile, type CaseData } from "../src/main/case-file.ts";
import { addMapItem, approveMapPart, type StoredCaseMap } from "../src/main/case-map.ts";

/*
 * An invented case for the Plan step's window tests and screenshots: Tomás V., 6 years 4
 * months (invented, as everything here). His case map is typed and its behaviors part
 * approved; his plan holds proposals as the AI will write them from PR 2 on (versions of
 * kind "ai", every item "proposed"), with planted problems for the checks: a prompt at 3 s
 * against a non-compliance counted at 5 s, planned ignoring, and an attention replacement
 * that gets an item.
 */

export const PLAN_CASE = {
  id: "8b2c4d6e-1f3a-4b5c-9d7e-2a4b6c8d0e1f",
  label: "Tomás V. (invented)",
  clientAge: { years: 6, months: 4 },
  createdAt: "2026-11-28T09:00:00.000Z",
  updatedAt: "2026-11-28T09:00:00.000Z",
};

const T = "2026-11-28T09:00:00.000Z";
const claim = (value: string) => ({ value, check: null });
const fn = (primary: string[], secondary: string[] = []) => ({ primary, secondary, evidence: [], reasoning: null, check: null });
const ai = (value: string) => ({ value, refs: [], origin: "proposed", check: null });
const proposed = { decision: "proposed", decidedAt: null, by: "ai" };
const param = (label: string, role: string, value: string, unit: string) => ({ label, role, value: ai(value), unit });
const version = (items: Array<Record<string, unknown>>) => ({ currentVersion: 1, approvedVersion: null, versions: [{ number: 1, kind: "ai", createdAt: T, content: { items } }] });

/** His case data, schema 6: the map approved, the plan proposed (or none, `withPlan: false`). */
export function planCaseData({ withPlan = true }: { withPlan?: boolean } = {}): CaseData {
  let data = newCaseData({ id: PLAN_CASE.id, label: PLAN_CASE.label, clientAge: PLAN_CASE.clientAge, now: new Date(T) });
  const add = (part: Parameters<typeof addMapItem>[1], input: Record<string, unknown>) => {
    const added = addMapItem(data, part, "items", input, null, T);
    data = added.data;
    return added;
  };
  add("client", { age: claim("6 years 4 months") });
  add("behaviors", { name: claim("Non-compliant behavior"), measure: claim("frequency"), definition: claim("Any instance in which Tomás does not begin a task within 5 seconds of an instruction."), function: fn(["escape"]) });
  add("behaviors", {
    name: claim("Physical aggression"),
    measure: claim("frequency"),
    definition: claim("Any instance in which Tomás hits, kicks or pushes another person with his hand or foot."),
    offset: claim("The behavior has stopped for 10 consecutive seconds."),
    function: fn(["escape"], ["attention"]),
    risks: [claim("Hits younger peers at school.")],
  });
  add("behaviors", { name: claim("Elopement"), measure: claim("frequency"), definition: claim("Any instance in which Tomás moves more than 6 feet away from the supervising adult without permission."), function: fn(["escape"]) });
  add("behaviors", { name: claim("Screaming"), measure: claim("frequency"), definition: claim("Any instance in which Tomás yells above conversational volume for 3 seconds or longer."), function: fn(["attention"]) });
  const last = add("behaviors", { name: claim("Mouthing"), measure: claim("frequency"), definition: claim("Any instance in which Tomás puts a non-food object past his lips."), function: fn(["sensory"]) });
  data = approveMapPart(data, "behaviors", last.version, T) ?? data;
  if (!withPlan) return data;

  const map = data.caseMap as StoredCaseMap;
  const parts: Record<string, unknown> = {
    strategies: version([
      { id: "stg-1", name: ai("Effective instruction delivery"), kind: "antecedent", functions: ["escape"], parameters: [param("Wait before a gestural prompt", "prompt-delay", "3", "s")], tracesTo: [], ...proposed },
      { id: "stg-2", name: ai("Scheduled breaks"), kind: "antecedent", functions: ["escape"], parameters: [param("Break every", "interval", "5", "min")], tracesTo: [], ...proposed },
      { id: "stg-3", name: ai("First/Then"), kind: "antecedent", functions: ["escape"], parameters: [], tracesTo: [], ...proposed },
      { id: "stg-4", name: ai("Noncontingent attention"), kind: "antecedent", functions: ["attention"], parameters: [param("Attention every", "interval", "3", "min")], tracesTo: [], ...proposed },
    ]),
    interventions: version([
      { id: "hbi-1", function: "escape", kind: "positive", behaviorIds: [], groupId: null, text: ai("When Tomás asks for a break or for help, the RBT honors it at once with specific praise, then returns to the task with a smaller step."), strategyIds: [], safetyFirst: false, ...proposed },
      { id: "hbi-2", function: "escape", kind: "maladaptive", behaviorIds: ["beh-2"], groupId: null, text: ai("The RBT moves materials and other children out of reach, keeps a safe distance and redirects Tomás to ask for a break with his card."), strategyIds: [], safetyFirst: true, ...proposed },
      { id: "hbi-3", function: "attention", kind: "maladaptive", behaviorIds: ["beh-4"], groupId: null, text: ai("The RBT uses planned ignoring and gives attention once Tomás asks appropriately."), strategyIds: [], safetyFirst: false, ...proposed },
    ]),
    programs: version([
      {
        id: "prg-1",
        kind: "replacement",
        title: ai("Requesting a break"),
        function: "escape",
        outcome: "break",
        area: "communication",
        definition: ai('When presented with a task, Tomás requests a break by saying "break", signing break or handing the break card to the adult.'),
        procedure: [ai("Place the break card within reach before each work period."), ai("Wait 5 s for an independent request."), ai("Honor the request at once."), ai("Record each opportunity.")],
        targets: [],
        measure: "percent-opportunities",
        parameters: [],
        baseline: { sessions: [1, 0, 2].map((correct, index) => ({ date: ai(`Session ${index + 1}`), correct: ai(String(correct)), opportunities: ai("10") })), caregiverReport: null, caregiverPercent: null, override: null },
        mastery: { category: "general", override: null },
        ...proposed,
      },
      { id: "prg-2", kind: "replacement", title: ai("Waiting for a preferred item"), function: "attention", outcome: "item", area: "waiting-tolerance", definition: ai("Tomás waits for a preferred item without screaming."), procedure: [], targets: [], measure: "percent-opportunities", parameters: [], ...proposed },
      {
        id: "prg-3",
        kind: "skill",
        title: ai("Washing hands"),
        area: "daily-living",
        definition: ai("Tomás washes his hands after using the bathroom."),
        procedure: [ai("Turn on the water."), ai("Wet both hands."), ai("Apply soap."), ai("Rinse."), ai("Dry with a towel.")],
        measure: "task-analysis-steps",
        baseline: { sessions: [], caregiverReport: ai("His mother says he washes alone some days."), caregiverPercent: ai("20"), override: null },
        mastery: { category: "general", override: null },
        ...proposed,
      },
    ]),
    glossary: version([
      { id: "glo-1", strategyId: "stg-1", definition: ai("Giving one clear instruction, close to the child and with his attention, before waiting for a response."), implementation: ai("With Tomás, the RBT will say his name, give one short instruction and wait 3 seconds before a gestural prompt."), writtenFrom: null, ...proposed },
      { id: "glo-2", strategyId: "stg-3", definition: ai("A statement that a less preferred activity comes first and a preferred one follows."), implementation: ai("During homework, the RBT will show Tomás a two-picture card."), writtenFrom: null, ...proposed },
    ]),
    caregiverGoals: version([{ id: "cgg-1", kind: "interventions", title: ai("Caregivers will implement the interventions and environmental manipulations"), procedure: ai("The BCBA will model each strategy, then watch the caregivers use it and give feedback."), baselinePercent: ai("0"), masteryOverride: null, ...proposed }]),
  };
  return { ...data, caseMap: { ...map, parts: { ...map.parts, ...(parts as StoredCaseMap["parts"]) } } };
}

export function planCaseText(options?: { withPlan?: boolean }): string {
  return serializeCaseFile(planCaseData(options));
}
