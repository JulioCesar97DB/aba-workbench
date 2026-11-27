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

/**
 * The people of each invented evaluation case (child, caregivers, siblings, professionals), by first name,
 * with the usual short forms. The rules and the examples must never name one of them, so the evaluation
 * scores rules that were not written for its cases (review round 1, S9 and B2). A new case adds its
 * people here; the test below fails until it does.
 */
const CASE_PEOPLE: Record<string, string[]> = {
  "case-a-mateo": ["Mateo", "Teo", "Mati", "Lucía", "Lu", "Lucy", "Andrés", "Andy", "Valeria", "Vale", "Vali", "Daniela", "Dani", "Ramón", "Moncho", "Elena", "Ele"],
  "case-b-sofia": ["Sofía", "Sofi", "Carmen", "Carmencita", "Diego", "Dieguito", "Daniela", "Dani", "Marta", "Martita", "Ramón", "Moncho", "Iván", "Ivancito"],
};

/** Lower case, accents removed, so "Sofía" and "Sofia" are the same word. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Whole words of a text, as plain(). */
function wordsOf(text: string): Set<string> {
  return new Set(plain(text).match(/\p{L}+/gu) ?? []);
}

test("every invented case lists its people for the name check", () => {
  for (const { dir, meta } of cases()) {
    const people = CASE_PEOPLE[dir];
    assert.ok(people, `add the people of fixtures/cases/${dir} (child, caregivers, siblings, professionals, with short forms) to CASE_PEOPLE`);
    const child = plain(meta.label.split(/[ ,]/)[0]);
    assert.ok(people.map(plain).includes(child), `${dir}: CASE_PEOPLE lacks the child's first name`);
  }
});

test("the rules and the examples never name a person of an invented case, as a whole word", () => {
  const words = new Map([...rulesById()].map(([id, text]) => [id, wordsOf(text)]));
  for (const { dir } of cases()) {
    for (const name of CASE_PEOPLE[dir] ?? []) {
      for (const [id, found] of words) assert.equal(found.has(plain(name)), false, `rules file ${id} names ${name} (${dir})`);
    }
  }
});

test("each planted gap is still anticipated by the rules files case.json lists", () => {
  const rules = rulesById();
  for (const { dir, meta } of cases()) {
    for (const gap of meta.plantedGaps) {
      assert.ok(gap.keywords.length > 0, `${dir}: a planted gap has no keywords`);
      for (const id of gap.anticipatedBy) {
        const text = rules.get(id);
        assert.ok(text, `${dir}: anticipatedBy names ${id}, which is not a rules file`);
        assert.ok(
          gap.keywords.some((keyword) => text.includes(keyword.toLowerCase())),
          `${dir}: ${id} should anticipate "${gap.gap.slice(0, 60)}…" but contains none of [${gap.keywords.join(", ")}]`,
        );
      }
    }
  }
});

test("the case map's definition example lives in the behaviors rules, sent with map requests only, and stays out of examples.md (owner's decision on review S9)", () => {
  const behaviors = readFileSync("rules/behaviors.md", "utf8");
  assert.match(behaviors, /## An example[\s\S]*Climbing furniture/);
  assert.match(behaviors, /Never reuse its sentences, names, dates or numbers/);
  // examples.md is in the cached prefix of every section request: the case map's example stays out of it.
  // Version 4 (2026-11-27) rewrote its examples to her questionnaire answers, still without the case map's.
  const examples = readFileSync("rules/examples.md", "utf8");
  assert.doesNotMatch(examples, /Climbing furniture|Case map/);
  assert.match(examples, /^version: 4$/m);
});

test("the examples stay labeled as invented, with the rule never to reuse them", () => {
  const text = readFileSync("rules/examples.md", "utf8");
  assert.match(text, /about an invented child/);
  assert.match(text, /Never reuse their sentences, names, dates or numbers/);
});

test("the whole-assessment rules keep the four kinds of content and the line on proposals", () => {
  const text = readFileSync("rules/assessment.md", "utf8");
  assert.match(text, /## Four kinds of content/);
  assert.match(text, /Her standard practice/);
  assert.match(text, /you never write a proposal into a section/);
});

test("the interventions rules wait for the Plan step: listed in the README, sent with no request yet (2026-11-27)", async () => {
  const text = readFileSync("rules/interventions.md", "utf8");
  assert.match(text, /^id: interventions$/m);
  assert.match(text, /No request loads this file yet/);
  assert.match(readFileSync("rules/README.md", "utf8"), /`interventions.md`/);
  for (const section of ["medical-necessity", "crisis-plan", "family-caregiver-involvement"] as const) {
    const { prompt, rulesVersions } = await buildPrompt(section, [{ id: "a", title: "A", kind: "text", text: "x" }]);
    assert.equal("interventions" in rulesVersions, false, section);
    assert.doesNotMatch(prompt.system + prompt.task, /# Interventions: what she uses/, section);
  }
});

test("the points of her answers that bear on sections drafted today are in those sections' rules (2026-11-27)", () => {
  const read = (file: string) => readFileSync(`rules/${file}`, "utf8");
  assert.match(read("sections/family-caregiver-involvement.md"), /never given by telehealth/);
  assert.match(read("sections/crisis-plan.md"), /Never restraint or seclusion/);
  assert.match(read("sections/medical-necessity.md"), /never name extinction or a punishment procedure/);
  assert.match(read("sections/medical-necessity.md"), /Never state, mark or mention a DSM-5 severity level/);
  const style = read("style.md");
  for (const rule of [/No dates in narrative text/, /Never quote anyone/, /by their role only/, /Never "the BCBA observed"/, /"utilize", "facilitate", "leverage"/, /Never "hypothesized"/]) assert.match(style, rule);
});

test("fix round 1 of T1: the family's safety measures stay in the Crisis Plan, her practice in Risk Assessment, the Florida checklist from the official text", () => {
  const read = (file: string) => readFileSync(`rules/${file}`, "utf8");
  assert.match(read("sections/crisis-plan.md"), /## The family's safety measures[\s\S]*no firearms in the home/);
  assert.match(read("sections/risk-assessment.md"), /her standard practice, confirmed by her questionnaire answers of 2026-11-27, so write it as hers, not as a proposal/);
  const mn = read("sections/medical-necessity.md");
  assert.match(mn, /applies only to recipients aged 21 or older/);
  assert.match(mn, /how progress will be measured/);
  const fci = read("sections/family-caregiver-involvement.md");
  assert.match(fci, /Name no procedure, routine or starting point for training/);
  assert.match(fci, /a caregiver who is absent/);
  assert.match(read("sections/discharge-and-service-fading-plan.md"), /releases as the basis for the coordination, without their date/);
});
