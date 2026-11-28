import { expect, type Page } from "@playwright/test";
import { PLAN_CASE } from "./plan-fixture.ts";

/*
 * The Plan step's main flows (PR 1, by hand), written once and driven by the window tests
 * (plan.e2e.ts, in CI) and by the headless check the worker uses to take screenshots
 * without a window. Invented case only (plan-fixture.ts).
 */

export interface PlanFlowDeps {
  /** Shows a screen by its address (the part after #). */
  goTo: (address: string) => Promise<void>;
  /** The case's data file as saved now. */
  caseData: () => Record<string, unknown> & { caseMap?: { parts: Record<string, { versions: Array<{ kind: string; content: { items: Array<Record<string, unknown>> } }>; currentVersion: number }>; planCopied?: Record<string, unknown> } };
  /** What the clipboard holds. */
  clipboard: () => Promise<string>;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const PLAN = `/cases/${PLAN_CASE.id}/interventions`;
const card = (page: Page, id: string) => page.locator(`[data-testid="plan-item"][data-item="${id}"]`);
const tabs = (page: Page) => page.getByRole("navigation", { name: "Parts of the plan" });

function itemOf(deps: PlanFlowDeps, part: string, id: string): Record<string, unknown> | undefined {
  const stored = deps.caseData().caseMap?.parts[part];
  const current = stored?.versions.find((version) => (version as unknown as { number: number }).number === stored.currentVersion) ?? stored?.versions.at(-1);
  return current?.content.items.find((item) => item.id === id);
}

/** The AI's proposals (as PR 2 will write them) decided by hand: the blocks, accept, edit, reject and recover, "Aceptar lo que queda", the checks, and copy with its marks. */
export async function proposalsFlow(page: Page, deps: PlanFlowDeps): Promise<void> {
  await deps.goTo(`${PLAN}?view=fn:escape`);
  await expect(heading(page)).toHaveText("Escape");
  // The blocks come from the map's functions, in her order; a behavior is in every block of its functions.
  // Every function has its tab; one with no behavior is dashed ("no behaviors").
  await expect(tabs(page).getByRole("button")).toHaveText([/^Tangiblesno behaviors/, /^Attention/, /^Escape/, /^Sensory/, /^Automatic Reinforcementno behaviors/, /^Programs/, /^Interventions glossary/, /^Caregiver goals/, /^Before QA/, /^Copy for ABA Matrix/]);
  await expect(page.getByTestId("plan-block-behaviors")).toHaveText("Non-compliant behavior · Physical aggression · Elopement");
  await expect(page.getByTestId("plan-view-count")).toHaveText("0 of 6 decided");
  // The clash of her definition at 5 s with a prompt at 3 s, on the item itself.
  await expect(card(page, "stg-1").getByTestId("plan-item-findings")).toContainText("Non-compliant behavior is counted when it does not start within 5 s");

  // Accept one: a decision is an edit, in a new version; the AI's version keeps the proposal.
  await card(page, "stg-2").getByRole("button", { name: "Accept", exact: true }).click();
  await expect(card(page, "stg-2")).toHaveAttribute("data-decision", "accepted");
  // The button she pressed is gone: the focus is on the item, not back at the top.
  await expect(card(page, "stg-2").getByRole("heading")).toBeFocused();
  await expect.poll(() => itemOf(deps, "strategies", "stg-2")?.decision).toBe("accepted");
  expect(deps.caseData().caseMap!.parts.strategies.versions[0].content.items[1].decision).toBe("proposed");

  // Edit one: it becomes hers and accepted, "Corrected by you"; the clash goes once her wait is 5 s.
  await card(page, "stg-1").getByRole("button", { name: "Edit", exact: true }).click();
  const form = card(page, "stg-1").getByTestId("plan-form");
  // The form takes the focus on its first field.
  await expect(form.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
  await form.getByRole("textbox", { name: "Value 1", exact: true }).fill("5");
  await form.getByRole("button", { name: "Done", exact: true }).click();
  await expect(card(page, "stg-1").getByRole("heading")).toBeFocused();
  await expect(card(page, "stg-1")).toHaveAttribute("data-decision", "corrected");
  await expect(card(page, "stg-1").getByTestId("plan-item-findings")).toHaveCount(0);
  await expect.poll(() => (itemOf(deps, "strategies", "stg-1")?.parameters as Array<{ value: { value: string; origin: string } }> | undefined)?.[0]?.value).toEqual({ value: "5", refs: [{ kind: "her" }], origin: "her", check: null });

  // Reject one: it goes under "Rejected (1)"; Recover brings it back undecided.
  await card(page, "stg-3").getByRole("button", { name: "Reject", exact: true }).click();
  const rejected = page.getByTestId("plan-rejected");
  await expect(rejected).toContainText("Rejected (1)");
  await expect(rejected.locator("summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await card(page, "stg-3").getByRole("button", { name: "Recover", exact: true }).click();
  await expect(page.getByTestId("plan-rejected")).toHaveCount(0);
  await expect(card(page, "stg-3").getByRole("heading")).toBeFocused();
  await expect(card(page, "stg-3")).toHaveAttribute("data-decision", "proposed");

  // Reject it again, then "Accept what is left": it stays rejected.
  await card(page, "stg-3").getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByTestId("plan-accept-rest").click();
  await expect(page.getByTestId("plan-view-count")).toHaveText("6 of 6 decided");
  await expect(page.getByTestId("plan-accept-rest")).toHaveCount(0);
  await expect.poll(() => itemOf(deps, "programs", "prg-1")?.decision).toBe("accepted");
  expect(itemOf(deps, "strategies", "stg-3")?.decision).toBe("rejected");
  // The sidebar counts the plan's items decided.
  await expect(page.getByRole("navigation", { name: "Steps of the case" }).getByRole("link", { name: /Plan/ })).toContainText("6/13");

  // Before QA: every check together; See opens the item's view.
  await tabs(page).getByRole("button", { name: /^Before QA/ }).click();
  await expect(heading(page)).toHaveText("Before QA");
  await expect(page.locator('[data-testid="plan-finding"][data-kind="aversive"]')).toContainText("planned ignoring");
  await expect(page.locator('[data-testid="plan-finding"][data-kind="no-equivalent-replacement"]')).toContainText("Attention has no equivalent replacement");
  await expect(page.locator('[data-testid="plan-finding"][data-kind="prompt-before-latency"]')).toHaveCount(0);
  await page.locator('[data-testid="plan-finding"][data-kind="aversive"]').getByRole("button", { name: "See" }).click();
  await expect(heading(page)).toHaveText("Attention");

  // Copy for ABA Matrix: only what she accepted, field by field, marked once copied.
  await tabs(page).getByRole("button", { name: /^Copy for ABA Matrix/ }).click();
  await expect(heading(page)).toHaveText("Copy for ABA Matrix");
  // One row per program and block, as mockup 07; a block opens on its fields.
  await expect(page.locator('[data-group="prg-1"]')).toContainText("Requesting a break4 fields");
  await page.locator('[data-group="hbi:escape"]').click();
  const field = page.locator('[data-field="hbi:escape:preventive"]');
  await field.click();
  await expect(page.getByTestId("plan-copy-text")).toHaveText("Effective instruction delivery\nScheduled breaks");
  await page.getByTestId("plan-copy-field").click();
  await expect.poll(() => deps.clipboard()).toBe("Effective instruction delivery\nScheduled breaks");
  await expect(field.getByTestId("plan-copied")).toBeVisible();
  await expect.poll(() => Object.keys(deps.caseData().caseMap?.planCopied ?? {})).toContain("hbi:escape:preventive");
  await page.getByTestId("plan-copy-block").click();
  await expect.poll(() => deps.clipboard()).toMatch(/^Behaviors:\nNon-compliant behavior, Physical aggression, Elopement\n\nPreventive Strategies:\nEffective instruction delivery\nScheduled breaks\n\nReplacement Skills:\nRequesting a break\n\nManagement Strategies:\nPositive:/);

  // A change to a copied field takes its mark away.
  await deps.goTo(`${PLAN}?view=fn:escape`);
  await card(page, "stg-2").getByRole("button", { name: "Edit", exact: true }).click();
  await card(page, "stg-2").getByRole("textbox", { name: "Name", exact: true }).fill("Scheduled breaks during table work");
  await card(page, "stg-2").getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => (itemOf(deps, "strategies", "stg-2")?.name as { value: string } | undefined)?.value).toBe("Scheduled breaks during table work");
  await tabs(page).getByRole("button", { name: /^Copy for ABA Matrix/ }).click();
  await page.locator('[data-group="hbi:escape"]').click();
  await expect(page.locator('[data-field="hbi:escape:preventive"]').getByTestId("plan-copied")).toHaveCount(0);
  await expect(page.locator('[data-field="hbi:escape:behaviors"]').getByTestId("plan-copied")).toBeVisible();

  // Review and copy lists the same fields, with the same marks.
  await deps.goTo(`/cases/${PLAN_CASE.id}/review`);
  const fields = page.getByTestId("review-plan-fields");
  await expect(fields).toContainText("14 · Hypothesis Based Interventions");
  await expect(fields.locator('[data-field="hbi:escape:behaviors"]').getByTestId("plan-copied")).toBeVisible();
}

/** An empty plan, written by hand: the two ways, her weekly hours and the count, a strategy, a program with its computed baseline and mastery. */
export async function byHandFlow(page: Page, deps: PlanFlowDeps): Promise<void> {
  await deps.goTo(PLAN);
  await expect(heading(page)).toHaveText("Plan");
  await expect(page.getByRole("heading", { name: "Write it yourself, function by function" })).toBeVisible();
  await expect(page.getByTestId("plan-ai-soon").first()).toHaveText("In the next version");
  // No hours yet: the app counts 30 and says so; her hours give the count by her rule.
  await expect(page.getByTestId("plan-target")).toContainText("~30");
  await page.getByLabel("Weekly hours of direct therapy (97153)").fill("20");
  await expect(page.getByTestId("plan-target")).toContainText("~20");
  await expect.poll(() => (itemOf(deps, "planInputs", "plan")?.weeklyHours as { value: string } | undefined)?.value).toBe("20");

  await page.getByRole("button", { name: "Start with Attention" }).click();
  await expect(heading(page)).toHaveText("Attention");
  await page.getByRole("button", { name: "Add a preventive strategy" }).click();
  const form = page.getByTestId("plan-form");
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Noncontingent attention");
  await expect.poll(() => (itemOf(deps, "strategies", "stg-1")?.name as { value: string } | undefined)?.value).toBe("Noncontingent attention");
  const stored = itemOf(deps, "strategies", "stg-1")!;
  expect([stored.decision, stored.by, stored.functions]).toEqual(["accepted", "her", ["attention"]]);
  await form.getByRole("button", { name: "Done", exact: true }).click();
  await expect(card(page, "stg-1")).toHaveAttribute("data-decision", "hers");
  // Its management entry: the block lists each behavior without one.
  await expect(page.getByTestId("plan-missing-entry")).toHaveCount(2);

  await tabs(page).getByRole("button", { name: /^Programs/ }).click();
  await page.getByRole("button", { name: "Add a skill program" }).click();
  const program = page.getByTestId("plan-form");
  await program.getByRole("textbox", { name: "Title", exact: true }).fill("Tacting colors");
  await program.getByRole("button", { name: "Add a session" }).click();
  await program.getByRole("button", { name: "Add a session" }).click();
  await program.getByRole("textbox", { name: "Correct 1", exact: true }).fill("3");
  await program.getByRole("textbox", { name: "Correct 2", exact: true }).fill("4");
  await program.getByRole("button", { name: "Done", exact: true }).click();
  // 30% and 40%: a mean of 35%, rounded to the nearest 10%.
  await expect(page.getByTestId("plan-baseline")).toContainText("A baseline of 40%.");
  await expect(page.getByTestId("plan-mastery")).toContainText("Mastery criterion: 90%");
  await expect(page.getByTestId("plan-program-count")).toHaveText("Programs · 1 of ~20");
}
