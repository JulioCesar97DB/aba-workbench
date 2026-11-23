import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildPrompt } from "../src/lib/rules.ts";

test("the prompt carries every rules file and its version", async () => {
  const { prompt, rulesVersions } = await buildPrompt("medical-necessity", [{ id: "a", title: "A", kind: "text", text: "x" }]);
  assert.deepEqual(Object.keys(rulesVersions).sort(), ["assessment", "examples", "guide", "instruments", "payer-florida-molina", "section-medical-necessity", "style"]);
  assert.match(prompt.system, /Nothing invented/);
  assert.match(prompt.system, /The section map/);
  assert.match(prompt.system, /# How she writes/);
  assert.match(prompt.system, /# Examples of the writing she expects/);
  assert.match(prompt.system, /Reading the standardized score reports/);
  assert.match(prompt.task, /Required structure/);
  assert.doesNotMatch(prompt.system, /Required structure/, "section rules stay out of the cached prefix");
});

/** Every rules file, keyed by the id in its front matter, lower-cased for matching. */
function rulesById(): Map<string, string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md") && entry.name !== "README.md") files.push(full);
    }
  };
  walk("rules");
  return new Map(
    files.map((file) => {
      const text = readFileSync(file, "utf8");
      const id = /^id:\s*(\S+)/m.exec(text)?.[1];
      assert.ok(id, `${file} has no id`);
      return [id, text.toLowerCase()];
    }),
  );
}

interface PlantedGap {
  gap: string;
  keywords: string[];
  anticipatedBy: string[];
}

function cases() {
  return readdirSync("fixtures/cases").map((dir) => ({
    dir,
    meta: JSON.parse(readFileSync(`fixtures/cases/${dir}/case.json`, "utf8")) as { label: string; plantedGaps: PlantedGap[] },
  }));
}

test("the rules never name an invented case", () => {
  const rules = [...rulesById().values()].join("\n");
  for (const { meta } of cases()) {
    for (const word of meta.label.split(" ").slice(0, 2)) {
      const name = word.replace(",", "").toLowerCase();
      assert.equal(rules.includes(name), false, `rules mention ${name}`);
    }
  }
});

test("each planted gap appears in exactly the rules files case.json says anticipate it", () => {
  const rules = rulesById();
  for (const { dir, meta } of cases()) {
    for (const gap of meta.plantedGaps) {
      assert.ok(gap.keywords.length > 0, `${dir}: a planted gap has no keywords`);
      const found = [...rules]
        .filter(([, text]) => gap.keywords.some((keyword) => text.includes(keyword.toLowerCase())))
        .map(([id]) => id)
        .sort();
      assert.deepEqual(
        found,
        [...gap.anticipatedBy].sort(),
        `${dir}: keywords [${gap.keywords.join(", ")}] appear in [${found.join(", ")}] but case.json says [${gap.anticipatedBy.join(", ")}]`,
      );
    }
  }
});
