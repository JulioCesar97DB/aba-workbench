import type {
  BehaviorItem,
  CaregiverItem,
  Claim,
  ClientItem,
  DeficitItem,
  FactItem,
  GroupItem,
  MapRef,
  RiskItem,
  SettingItem,
  StrengthItem,
} from "../shared/case-map.ts";
import { TEMPLATE_SECTIONS } from "../shared/case-map.ts";
import { REPORT_SECTIONS } from "../shared/report-sections.ts";

/*
 * The approved case map as section requests get it (step 1's D8 to D10, owner's decisions
 * of 2026-11-23; the Plan step's PR 0; D11 as the owner changed it on 2026-11-28): one block
 * of compact tagged text, rendered by code, never the map's JSON. It goes after the sources
 * (src/lib/providers/anthropic.ts and openai.ts): the rules and the sources before it are the
 * same for every section and stay cached across them, and the block is the part that differs
 * per section. The same map and section give the same bytes: the parts come in a fixed order,
 * the fields of each item in a fixed order, and nothing in it depends on the time.
 *
 * - Only approved parts are written out (D9). Every other part is named in one line, so the
 *   model never reads a missing part as "none".
 * - Each value carries where it came from (the source's id as the sources block names it,
 *   her section, her notes, her own typing), but never the verbatim quotes (D10).
 * - Each section gets in full only the items whose home is that section (D11, 2026-11-28):
 *   a fact's own home section, and for the other parts the guide's section map
 *   (rules/guide.md, "Owns"; PART_HOMES below). Every other item comes by name only: its
 *   name and nothing else, no examples, incidents, dates or wording. The one exception is a
 *   number the guide's "Refers to" column gives a section (NAMED_WITH_NUMBERS below).
 *
 * The Plan step's PR 4 adds the accepted plan items to this block, after the map's parts:
 * CASE_MAP_BLOCK_PARTS is the place they join, and the block's order stays fixed.
 */

/** The parts the block carries, in its fixed order. The open items and the report on her sections stay out: they are her to-do list and a check of her own sections, which travel first anyway. */
export const CASE_MAP_BLOCK_PARTS = ["client", "caregivers", "settings", "deficits", "strengths", "behaviors", "risks", "facts"] as const;
export type CaseMapBlockPart = (typeof CASE_MAP_BLOCK_PARTS)[number];

export interface BlockItems {
  client: ClientItem;
  caregivers: CaregiverItem;
  settings: SettingItem;
  deficits: DeficitItem;
  strengths: StrengthItem;
  behaviors: BehaviorItem;
  risks: RiskItem;
  facts: FactItem;
}

/** One part as the block gets it: the items of the version she approved, or that it is not approved. */
export type BlockPart<P extends CaseMapBlockPart = CaseMapBlockPart> =
  | { approved: true; version: number; items: ReadonlyArray<BlockItems[P]>; groups?: ReadonlyArray<GroupItem> }
  | { approved: false };

export type CaseMapBlockInput = { [P in CaseMapBlockPart]: BlockPart<P> };

/** Which approved version of each part a request sent, for the version's record. */
export type MapUsed = Array<{ part: CaseMapBlockPart; version: number }>;

export function mapUsedOf(input: CaseMapBlockInput): MapUsed {
  return CASE_MAP_BLOCK_PARTS.flatMap((part) => {
    const entry = input[part];
    return entry.approved ? [{ part, version: entry.version }] : [];
  });
}

const PART_LABELS: Record<CaseMapBlockPart, string> = {
  client: "Client",
  caregivers: "Caregivers",
  settings: "Settings",
  deficits: "Deficits",
  strengths: "Strengths",
  behaviors: "Behaviors",
  risks: "Risks",
  facts: "Facts",
};

/** The tags of the block: text in it can never open or close one (src/lib/rules.ts quotes every value). */
export const CASE_MAP_BLOCK_TAGS = ["case-map", ...CASE_MAP_BLOCK_PARTS, "caregiver", "setting", "deficit", "strength", "behavior", "group", "risk", "fact"] as const;

/** The line for a part that is not approved (D9). */
export function notApprovedLine(part: CaseMapBlockPart): string {
  return `${PART_LABELS[part]}: not approved yet; use her sections and the sources.`;
}

/** Makes text unable to break out of a tag (quoteForPrompt), and knows the block's source names. */
type Quote = ((text: string) => string) & { sources?: SourceNames };

/** How the block names the sources sent: S1, S2, ... in the order they are sent, each defined once at the top (D10: source ids, compactly). */
type SourceNames = ReadonlyMap<string, string>;

/** One line of text: values she typed may hold line breaks, which would break "one line per field". */
function oneLine(text: string, quote: Quote): string {
  return quote(text.replace(/\s*\n\s*/g, " "));
}

function attribute(text: string, quote: Quote): string {
  return oneLine(text, quote).replace(/"/g, "'");
}

const SECTION_TITLES = new Map<string, string>(REPORT_SECTIONS.map(({ id, title }) => [id, title]));

/** Where a value came from, without its quote. A kind a newer app writes is left out. */
function refLabel(ref: MapRef, sources: SourceNames): string | null {
  switch (ref.kind) {
    case "source":
      // A source no longer sent (she removed it) is named by its id, so nothing reads as a source it is not.
      return ref.sourceId ? (sources.get(ref.sourceId) ?? `a source not sent (${ref.sourceId})`) : null;
    case "section": {
      const title = ref.sectionId ? SECTION_TITLES.get(ref.sectionId) : undefined;
      return title ? `her section "${title}"` : "her section";
    }
    case "note":
      return "her notes";
    case "her":
      return "typed by her";
    case "app":
      return "computed by the app";
    default:
      return null;
  }
}

function fromText(refs: ReadonlyArray<MapRef>, quote: Quote): string {
  const labels = [...new Set(refs.map((ref) => refLabel(ref, quote.sources ?? new Map())).filter((label): label is string => label !== null))];
  return labels.length > 0 ? ` [from: ${attribute(labels.join("; "), quote)}]` : "";
}

function checkText(check: string | null | undefined, quote: Quote): string {
  const text = check?.trim();
  return text ? ` [CHECK: ${oneLine(text, quote)}]` : "";
}

function hasValue(claim: Claim<string> | null | undefined): claim is Claim<string> {
  return !!claim && (claim.value.trim() !== "" || (claim.check ?? "").trim() !== "");
}

/** "label: value [from: ...] [CHECK: ...]", or nothing when the claim is empty. */
function claimLine(label: string, claim: Claim<string> | null | undefined, quote: Quote): string[] {
  if (!hasValue(claim)) return [];
  const prefix = claim.origin === "hypothesis" ? "hypothesis, approved by the BCBA: " : "";
  return [`${label}: ${prefix}${oneLine(claim.value, quote)}${fromText(claim.refs, quote)}${checkText(claim.check, quote)}`];
}

function listLines(label: string, claims: ReadonlyArray<Claim<string>>, quote: Quote): string[] {
  return claims.flatMap((claim) => claimLine(label, claim, quote));
}

/** Several claims that make one entry (a score, an observation): "label: a X, b Y [from: ...]". */
function compoundLine(label: string, fields: ReadonlyArray<[string, Claim<string> | null | undefined]>, quote: Quote): string[] {
  const present = fields.filter((entry): entry is [string, Claim<string>] => hasValue(entry[1]));
  if (present.length === 0) return [];
  const values = present.map(([name, claim]) => `${name} ${oneLine(claim.value, quote)}${checkText(claim.check, quote)}`).join(", ");
  return [`${label}: ${values}${fromText(present.flatMap(([, claim]) => claim.refs), quote)}`];
}

function idList(ids: ReadonlyArray<string>, names: ReadonlyMap<string, string>, quote: Quote): string {
  return ids.map((id) => (names.has(id) ? `${id} (${oneLine(names.get(id) ?? "", quote)})` : id)).join(", ");
}

function clientLines(item: ClientItem, quote: Quote): string[] {
  return [
    ...claimLine("age", item.age, quote),
    ...claimLine("diagnosis", item.diagnosis, quote),
    ...claimLine("severity level", item.severityLevel, quote),
    ...claimLine("evaluator", item.evaluator, quote),
    ...claimLine("evaluation date", item.evaluationDate, quote),
    ...listLines("medication", item.medications, quote),
    ...claimLine("school", item.school, quote),
    ...claimLine("grade", item.grade, quote),
    ...claimLine("schedule", item.schedule, quote),
    ...claimLine("IEP", item.iep, quote),
    ...item.otherServices.flatMap((service) => compoundLine("other service", [["name", service.name], ["provider", service.provider], ["paid", service.paid]], quote)),
    ...listLines("language", item.languages, quote),
  ];
}

function caregiverLines(item: CaregiverItem, quote: Quote): string[] {
  return [
    ...claimLine("role", item.role, quote),
    ...claimLine("language", item.language, quote),
    ...claimLine("availability", item.availability, quote),
    ...claimLine("participation", item.participation, quote),
    ...claimLine("limits", item.limits, quote),
    ...claimLine("mitigation", item.mitigation, quote),
  ];
}

function settingLines(item: SettingItem, quote: Quote): string[] {
  return [...claimLine("name", item.name, quote), ...claimLine("kind", item.kind, quote), ...claimLine("evidence", item.evidence, quote), ...claimLine("by", item.by, quote), ...claimLine("dates", item.dates, quote)];
}

function deficitLines(item: DeficitItem, quote: Quote): string[] {
  return [
    ...claimLine("area", item.area, quote),
    ...item.scores.flatMap((score) => compoundLine("score", [["instrument", score.instrument], ["scale", score.scale], ["score", score.score], ["percentile", score.percentile], ["level", score.level]], quote)),
    ...listLines("evidence", item.evidence, quote),
    ...claimLine("impact", item.impact, quote),
  ];
}

function strengthLines(item: StrengthItem, quote: Quote): string[] {
  return [...claimLine("text", item.text, quote), ...claimLine("kind", item.kind, quote), ...claimLine("setting", item.setting, quote)];
}

function functionLines(item: BehaviorItem, quote: Quote): string[] {
  const fn = item.function;
  const names = [...fn.primary.map((name) => `${name} (primary)`), ...fn.secondary.map((name) => `${name} (secondary)`)];
  const lines: string[] = [];
  if (names.length > 0 || (fn.check ?? "").trim() !== "") {
    const label = fn.origin === "hypothesis" ? "hypothesized function, approved by the BCBA" : fn.origin === "her" ? "function, as she set it" : "function";
    lines.push(`${label}: ${names.length > 0 ? attribute(names.join("; "), quote) : "none named"}${checkText(fn.check, quote)}`);
  }
  for (const evidence of fn.evidence) {
    const who = evidence.respondent?.trim() ? `, respondent ${oneLine(evidence.respondent, quote)}` : "";
    const supports = evidence.supports.length > 0 ? ` (supports ${attribute(evidence.supports.join(", "), quote)})` : "";
    const result = hasValue(evidence.result) ? `: ${oneLine(evidence.result.value, quote)}${checkText(evidence.result.check, quote)}` : "";
    lines.push(`function evidence: ${oneLine(evidence.tool, quote)}${who}${result}${supports}${evidence.result ? fromText(evidence.result.refs, quote) : ""}`);
  }
  if (fn.reasoning?.trim()) lines.push(`function reasoning: ${oneLine(fn.reasoning, quote)}`);
  return lines;
}

function behaviorLines(item: BehaviorItem, settings: ReadonlyMap<string, string>, quote: Quote): string[] {
  const barriers = item.barriers && (item.barriers.value.length > 0 || (item.barriers.check ?? "").trim() !== "")
    ? [`barriers: ${attribute(item.barriers.value.join(", "), quote)}${fromText(item.barriers.refs, quote)}${checkText(item.barriers.check, quote)}`]
    : [];
  return [
    ...listLines("topography", item.topographies, quote),
    ...claimLine("measure", item.measure, quote),
    ...claimLine("definition", item.definition, quote),
    ...claimLine("onset", item.onset, quote),
    ...claimLine("offset", item.offset, quote),
    ...listLines("example", item.examples, quote),
    ...listLines("non-example", item.nonExamples, quote),
    ...item.baseline.observations.flatMap((observation) =>
      compoundLine("baseline observation", [["date", observation.date], ["setting", observation.setting], ["length", observation.length], ["minutes", observation.minutes], ["value", observation.value]], quote),
    ),
    ...listLines("baseline, other", item.baseline.other, quote),
    ...claimLine("intensity", item.intensity, quote),
    ...(item.settingIds.length > 0 ? [`settings: ${idList(item.settingIds, settings, quote)}`] : []),
    ...listLines("antecedent", item.antecedents, quote),
    ...listLines("consequence", item.consequences, quote),
    ...functionLines(item, quote),
    ...barriers,
    ...listLines("risk", item.risks, quote),
  ];
}

function groupLines(group: GroupItem, behaviors: ReadonlyMap<string, string>, quote: Quote): string[] {
  const lines: string[] = [];
  if (group.behaviorIds.length > 0) lines.push(`behaviors: ${idList(group.behaviorIds, behaviors, quote)}`);
  if (group.nature.trim()) lines.push(`nature: ${oneLine(group.nature, quote)}`);
  if (group.function?.trim()) lines.push(`${group.origin === "hypothesis" ? "hypothesized function, approved by the BCBA" : "function"}: ${oneLine(group.function, quote)}`);
  if (group.measure?.trim()) lines.push(`measure: ${oneLine(group.measure, quote)}`);
  if (group.reason.trim()) lines.push(`reason: ${oneLine(group.reason, quote)}`);
  return lines;
}

function riskLines(item: RiskItem, behaviors: ReadonlyMap<string, string>, quote: Quote): string[] {
  return [
    ...(item.behaviorIds.length > 0 ? [`behaviors: ${idList(item.behaviorIds, behaviors, quote)}`] : []),
    ...claimLine("what", item.what, quote),
    ...listLines("evidence", item.evidence, quote),
    ...claimLine("level", item.level, quote),
  ];
}

function factLines(item: FactItem, quote: Quote): string[] {
  const home = item.homeSection !== null && item.homeSection >= 1 && item.homeSection <= TEMPLATE_SECTIONS.length ? [`home section: ${item.homeSection} ${TEMPLATE_SECTIONS[item.homeSection - 1]}`] : [];
  return [...claimLine("text", item.text, quote), ...home];
}

function element(tag: string, attributes: string, lines: string[]): string {
  return [`<${tag}${attributes}>`, ...lines, `</${tag}>`].join("\n");
}

function names<T extends { id: string }>(items: ReadonlyArray<T>, name: (item: T) => Claim<string> | null): Map<string, string> {
  return new Map(items.flatMap((item) => {
    const claim = name(item);
    return claim && claim.value.trim() ? [[item.id, claim.value]] : [];
  }));
}

/**
 * The home section of each part's items (template numbers), from the guide's section map
 * (rules/guide.md, "Owns"). Facts carry their own home section. Settings are where the
 * observations were made, which Assessments Conducted (13) owns; behaviors are the Maladaptive
 * Behaviors Summary's (8), with their topography and baselines in 10 and their functions in 13.
 */
export const PART_HOMES: Readonly<Record<Exclude<CaseMapBlockPart, "facts">, number>> = {
  client: 3,
  caregivers: 16,
  settings: 13,
  deficits: 4,
  strengths: 6,
  behaviors: 8,
  risks: 19,
};

/**
 * The numbers a section gets with an item's name, from the guide's "Refers to" column: Discharge
 * (18) refers to "behaviors and baselines by name and number". Taken from the guide, never case by case.
 */
export const NAMED_WITH_NUMBERS: Readonly<Partial<Record<number, ReadonlyArray<CaseMapBlockPart>>>> = {
  18: ["behaviors"],
};

function sectionName(number: number): string {
  return `section ${number} ${TEMPLATE_SECTIONS[number - 1] ?? ""}`.trim();
}

/** A name, alone on its line: "- name". */
function nameLine(value: string | null | undefined, quote: Quote): string[] {
  const text = value?.trim();
  return text ? [`- ${oneLine(text, quote)}`] : [];
}

/**
 * The name at the head of a value that says more ("Mother; lives with her and works during the day",
 * "Home: homework, dinner", "Speech-language therapy, 60 minutes per week"): the text before its first
 * colon, semicolon or comma, so the rest of the value stays with its home section.
 */
export function headName(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  const cut = text.search(/[:;]|,\s/);
  return (cut > 0 ? text.slice(0, cut) : text).trim().replace(/[.]$/, "");
}

/** A behavior's name and, where the guide gives the section its numbers, the baseline's numbers: no dates, settings or wording. */
function behaviorNameLine(item: BehaviorItem, withNumbers: boolean, quote: Quote): string[] {
  const name = item.name?.value.trim();
  if (!name) return [];
  if (!withNumbers) return [`- ${oneLine(name, quote)}`];
  const values = item.baseline.observations.flatMap((observation) => {
    const value = observation.value?.value.trim();
    if (!value) return [];
    const minutes = observation.minutes?.value.trim();
    return [minutes ? `${value} in ${minutes} minutes` : value];
  });
  const measure = item.measure?.value.trim();
  const numbers = [measure ? `measure ${measure}` : "", values.length > 0 ? `baseline ${values.join("; ")}` : ""].filter((text) => text !== "");
  return [`- ${oneLine(name, quote)}${numbers.length > 0 ? `: ${oneLine(numbers.join(", "), quote)}` : ""}`];
}

/** One part, by name only: the names and nothing else. Parts whose items have no name (strengths, facts) are counted. */
function namesOnly(part: CaseMapBlockPart, entry: Extract<BlockPart, { approved: true }>, withNumbers: boolean, behaviors: ReadonlyMap<string, string>, quote: Quote): string[] {
  switch (part) {
    case "client": {
      const item = entry.items[0] as ClientItem | undefined;
      if (!item) return [];
      // The diagnosis is named as the CDE writes it (it must match everywhere); the other services by name.
      // Medications, school and languages are Background's to state, and have no name apart from their wording.
      return [
        ...(item.diagnosis?.value.trim() ? [`- diagnosis: ${oneLine(item.diagnosis.value, quote)}`] : []),
        ...item.otherServices.flatMap((service) => nameLine(headName(service.name?.value), quote).map((line) => line.replace(/^- /, "- other service: "))),
      ];
    }
    case "caregivers":
      return entry.items.flatMap((item) => nameLine(headName((item as CaregiverItem).role?.value), quote));
    case "settings":
      return entry.items.flatMap((item) => nameLine(headName((item as SettingItem).name?.value), quote));
    case "deficits":
      return entry.items.flatMap((item) => nameLine((item as DeficitItem).area?.value, quote));
    case "behaviors":
      return [
        ...entry.items.flatMap((item) => behaviorNameLine(item as BehaviorItem, withNumbers, quote)),
        ...(entry.groups ?? []).flatMap((group) => {
          const named = group.behaviorIds.flatMap((id) => (behaviors.has(id) ? [behaviors.get(id) ?? ""] : []));
          return named.length > 1 ? [`- a group: ${oneLine(named.join(", "), quote)}`] : [];
        }),
      ];
    case "risks": {
      // A risk has no name of its own: it is named by the behaviors it comes from; the others are counted.
      const risks = entry.items as ReadonlyArray<RiskItem>;
      const tied = risks.map((risk) => risk.behaviorIds.flatMap((id) => (behaviors.has(id) ? [behaviors.get(id) ?? ""] : [])));
      const named = [...new Set(tied.filter((of) => of.length > 0).map((of) => `- a risk from ${oneLine(of.join(", "), quote)}`))];
      const others = tied.filter((of) => of.length === 0).length;
      return [...named, ...(others > 0 ? [`${others} other ${others === 1 ? "risk" : "risks"}, not tied to a behavior, not given here.`] : [])];
    }
    case "strengths":
      return entry.items.length > 0 ? [`${entry.items.length} ${entry.items.length === 1 ? "strength" : "strengths"}, not given here.`] : [];
    case "facts":
      return [];
  }
}

/** The facts of other sections, counted by home and never given: a fact has no name to refer to it by. */
function otherFactsLine(facts: ReadonlyArray<FactItem>): string[] {
  const counts = new Map<number | null, number>();
  for (const fact of facts) {
    const home = fact.homeSection !== null && fact.homeSection >= 1 && fact.homeSection <= TEMPLATE_SECTIONS.length ? fact.homeSection : null;
    counts.set(home, (counts.get(home) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const homes = [...counts.entries()].sort(([a], [b]) => (a ?? 99) - (b ?? 99)).map(([home, count]) => `${count} in ${home === null ? "no home section" : sectionName(home)}`);
  return [`Facts of other sections, not given here: ${homes.join("; ")}.`];
}

/**
 * The block for one section, from the map's parts. `section` is the template number of the
 * section asked for (1 to 22). `quote` makes text unable to break out of a tag
 * (quoteForPrompt in src/lib/rules.ts); every value goes through it.
 * `sources` are the sources the request sends, in its order: S1, S2, ... name them.
 */
export function renderCaseMapBlock(input: CaseMapBlockInput, quoteText: (text: string) => string, sources: ReadonlyArray<{ id: string; title: string }>, section: number): string {
  const quote: Quote = Object.assign((text: string) => quoteText(text), { sources: new Map(sources.map((source, index) => [source.id, `S${index + 1}`])) });
  const settings = input.settings.approved ? names(input.settings.items, (item) => item.name) : new Map<string, string>();
  const behaviors = input.behaviors.approved ? names(input.behaviors.items, (item) => item.name) : new Map<string, string>();
  const sections = CASE_MAP_BLOCK_PARTS.map((part) => {
    const entry = input[part];
    if (!entry.approved) return notApprovedLine(part);
    const groups = part === "behaviors" ? (entry.groups ?? []) : [];
    if (entry.items.length === 0 && groups.length === 0) return `${PART_LABELS[part]}: approved; none.`;
    const home = part === "facts" ? null : PART_HOMES[part];
    const own = part === "facts" ? entry.items.filter((item) => (item as FactItem).homeSection === section) : home === section ? entry.items : [];
    const ownGroups = home === section ? groups : [];
    const items: string[] = [];
    for (const item of own) {
      const id = ` id="${attribute(item.id, quote)}"`;
      switch (part) {
        case "client":
          items.push(...clientLines(item as ClientItem, quote));
          break;
        case "caregivers":
          items.push(element("caregiver", id, caregiverLines(item as CaregiverItem, quote)));
          break;
        case "settings":
          items.push(element("setting", id, settingLines(item as SettingItem, quote)));
          break;
        case "deficits":
          items.push(element("deficit", id, deficitLines(item as DeficitItem, quote)));
          break;
        case "strengths":
          items.push(element("strength", id, strengthLines(item as StrengthItem, quote)));
          break;
        case "behaviors": {
          const behavior = item as BehaviorItem;
          const name = behavior.name?.value.trim() ? ` name="${attribute(behavior.name.value, quote)}"` : "";
          items.push(element("behavior", `${id}${name}`, [...claimLine("name", behavior.name, quote), ...behaviorLines(behavior, settings, quote)]));
          break;
        }
        case "risks":
          items.push(element("risk", id, riskLines(item as RiskItem, behaviors, quote)));
          break;
        case "facts":
          items.push(element("fact", id, factLines(item as FactItem, quote)));
          break;
      }
    }
    for (const group of ownGroups) items.push(element("group", ` id="${attribute(group.id, quote)}"`, groupLines(group, behaviors, quote)));
    if (part === "facts") {
      items.push(...otherFactsLine(entry.items.filter((item) => (item as FactItem).homeSection !== section) as FactItem[]));
    } else if (home !== section && home !== null) {
      const withNumbers = (NAMED_WITH_NUMBERS[section] ?? []).includes(part);
      const lines = namesOnly(part, entry, withNumbers, behaviors, quote);
      const how = withNumbers ? "by name, with the numbers this section refers to" : "by name only";
      items.push(`Home: ${sectionName(home)}, which states them in full; here ${how}.`, ...lines);
    }
    const attributes = ` version="${entry.version}"${home === section ? ' home="this section"' : ""}`;
    return element(part, attributes, items);
  });
  const anyFrom = sections.some((text) => text.includes("[from: "));
  const legend = anyFrom && sources.length > 0
    ? [["Sources, by the short names [from: ...] uses below:", ...sources.map((source, index) => `S${index + 1} = ${attribute(source.id, quote)} (${attribute(source.title, quote)})`)].join("\n")]
    : [];
  const intro = `The case map, approved by the BCBA part by part and rendered by the app, as ${sectionName(section)} gets it: in full, the items whose home is this section; every other item by name only.`;
  return ["<case-map>", intro, ...legend, ...sections, "</case-map>"].join("\n\n");
}
