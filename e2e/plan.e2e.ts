import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultCasesFolder, firstScreen, goTo, test } from "./app.ts";
import { byHandFlow, proposalsFlow, type PlanFlowDeps } from "./plan-flow.ts";
import { PLAN_CASE, planCaseText } from "./plan-fixture.ts";

/*
 * The Plan step by hand (PR 1): an approved map, its function blocks, the AI's proposals
 * (as PR 2 will write them) accepted, edited, rejected and recovered, "Aceptar lo que
 * queda", the checks before QA, and copy for ABA Matrix with its marks; and an empty plan
 * written by hand. Invented case only (plan-fixture.ts). No AI request is made.
 */

function seed(home: string, withPlan: boolean): string {
  const folder = path.join(defaultCasesFolder(home), PLAN_CASE.label);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "aba-case.json");
  writeFileSync(file, planCaseText({ withPlan }));
  return file;
}

test("the plan: proposals accepted, edited, rejected and recovered; Accept what is left; Before QA; copy with its marks", async ({ launch, home }) => {
  const caseFile = seed(home, true);
  const app = await launch();
  const page = await firstScreen(app);
  const deps: PlanFlowDeps = {
    goTo: (address) => goTo(page, address),
    caseData: () => JSON.parse(readFileSync(caseFile, "utf8")),
    clipboard: () => app.evaluate(({ clipboard }) => clipboard.readText()),
  };
  await proposalsFlow(page, deps);
});

test("the plan by hand: the two ways, the weekly hours and the count, a strategy and a program with its computed baseline", async ({ launch, home }) => {
  const caseFile = seed(home, false);
  const app = await launch();
  const page = await firstScreen(app);
  await byHandFlow(page, {
    goTo: (address) => goTo(page, address),
    caseData: () => JSON.parse(readFileSync(caseFile, "utf8")),
    clipboard: () => app.evaluate(({ clipboard }) => clipboard.readText()),
  });
});
