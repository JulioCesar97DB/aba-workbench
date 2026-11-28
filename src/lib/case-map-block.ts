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
 * The approved case map as section requests get it (step 1's D8 to D11, owner's decisions
 * of 2026-11-23; the Plan step's PR 0): one block of compact tagged text, rendered by code,
 * never the map's JSON. It goes after the sources as a third cached block on every route
 * (src/lib/providers/anthropic.ts and openai.ts), so the same map gives the same bytes:
 * the parts come in a fixed order, the fields of each item in a fixed order, and nothing
 * in it depends on the section asked for or on the time.
 *
 * - Only approved parts are written out (D9). Every other part is named in one line, so the
 *   model never reads a missing part as "none".
 * - Each value carries where it came from (the source's id as the sources block names it,
 *   her section, her notes, her own typing), but never the verbatim quotes (D10).
 * - The whole approved map goes to every section (D11); each section's rules say which parts
 *   it uses.
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

type Quote = (text: string) => string;

/** One line of text: values she typed may hold line breaks, which would break "one line per field". */
function oneLine(text: string, quote: Quote): string {
  return quote(text.replace(/\s*\n\s*/g, " "));
}

function attribute(text: string, quote: Quote): string {
  return oneLine(text, quote).replace(/"/g, "'");
}

const SECTION_TITLES = new Map<string, string>(REPORT_SECTIONS.map(({ id, title }) => [id, title]));

/** Where a value came from, without its quote. A kind a newer app writes is left out. */
function refLabel(ref: MapRef): string | null {
  switch (ref.kind) {
    case "source":
      return ref.sourceId ? `source ${ref.sourceId}` : null;
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
  const labels = [...new Set(refs.map(refLabel).filter((label): label is string => label !== null))];
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
 * The block, from the map's parts. `quote` makes text unable to break out of a tag
 * (quoteForPrompt in src/lib/rules.ts); every value goes through it.
 */
export function renderCaseMapBlock(input: CaseMapBlockInput, quote: Quote): string {
  const settings = input.settings.approved ? names(input.settings.items, (item) => item.name) : new Map<string, string>();
  const behaviors = input.behaviors.approved ? names(input.behaviors.items, (item) => item.name) : new Map<string, string>();
  const sections = CASE_MAP_BLOCK_PARTS.map((part) => {
    const entry = input[part];
    if (!entry.approved) return notApprovedLine(part);
    const version = ` version="${entry.version}"`;
    const groups = part === "behaviors" ? (entry.groups ?? []) : [];
    if (entry.items.length === 0 && groups.length === 0) return `${PART_LABELS[part]}: approved; none.`;
    const items: string[] = [];
    for (const item of entry.items) {
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
    for (const group of groups) items.push(element("group", ` id="${attribute(group.id, quote)}"`, groupLines(group, behaviors, quote)));
    return element(part, version, items);
  });
  return [
    "<case-map>",
    "The case map, approved by the BCBA part by part and rendered by the app. Ids in [from: ...] name the sources above.",
    ...sections,
    "</case-map>",
  ].join("\n\n");
}
