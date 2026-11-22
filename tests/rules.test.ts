import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { buildPrompt } from "../src/lib/rules.ts";

test("the prompt carries every rules file and its version", async () => {
  const { prompt, rulesVersions } = await buildPrompt("medical-necessity", [{ id: "a", title: "A", kind: "text", text: "x" }]);
  assert.deepEqual(Object.keys(rulesVersions).sort(), ["assessment", "instruments", "payer-florida-molina", "section-medical-necessity"]);
  assert.match(prompt.system, /Nothing invented/);
  assert.match(prompt.system, /Reading the standardized score reports/);
  assert.match(prompt.task, /Required structure/);
  assert.doesNotMatch(prompt.system, /Required structure/, "section rules stay out of the cached prefix");
});

test("the rules never name an invented case or quote its planted gaps", () => {
  const files = ["rules/assessment.md", "rules/instruments.md", "rules/payers/florida-medicaid-molina.md", "rules/sections/medical-necessity.md"];
  const rules = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const dir of readdirSync("fixtures/cases")) {
    const meta = JSON.parse(readFileSync(`fixtures/cases/${dir}/case.json`, "utf8"));
    const [first, last] = meta.label.split(" ");
    assert.equal(rules.includes(first), false, `rules mention ${first}`);
    assert.equal(rules.includes(last.replace(",", "")), false, `rules mention ${last}`);
  }
  for (const leak of ["Socialization standard score was 64", "tablet", "VPK", "Level 1", "Level 2"]) {
    assert.equal(rules.includes(leak), false, leak);
  }
});
