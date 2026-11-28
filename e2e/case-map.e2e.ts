import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultCasesFolder, expect, firstScreen, goTo, SAMPLE_CASE, seedCase, test } from "./app.ts";

/*
 * The case map by hand (step 1, pull request 1: no AI yet): she adds a behavior, types it,
 * approves the part, corrects it again and goes back to the approved version. Everything
 * is saved as she types, into aba-case.json (schema version 4). Invented case only.
 */

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const caseMapOf = (caseFile: string) => JSON.parse(readFileSync(caseFile, "utf8")).caseMap;

test("the case map by hand: add a behavior, type it, approve the part, correct it, go back", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  seedCase(casesFolder);
  const caseFile = path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json");
  const page = await firstScreen(await launch());
  await goTo(page, `/cases/${SAMPLE_CASE.id}/case-map`);
  await expect(heading(page)).toHaveText("Case map");
  const parts = page.getByRole("navigation", { name: "Parts of the case map" });
  await expect(parts.getByRole("link", { name: /Behaviors and groups/ })).toHaveAttribute("aria-current", "true");
  // An empty map offers two ways: by hand, or with the AI (here no AI is connected, so the AI card leads to Settings, never greyed out: P7).
  await expect(page.getByRole("heading", { name: "By hand" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "With the AI" })).toBeVisible();
  const aiCard = page.getByTestId("two-ways").locator("[data-way='ai']");
  await expect(aiCard).toContainText("Connect ChatGPT in Settings to use this way.");
  await expect(aiCard.getByRole("link", { name: "Connect the AI" })).toHaveAttribute("href", "#/settings");
  // Said once: no line of the panel, and no greyed-out header button (review round 1 of case map speed, M4).
  await expect(page.getByText("Connect ChatGPT or Claude to have the AI draft the map.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft the map with the AI" })).toHaveCount(0);

  // A behavior, typed by hand: saved as she types, hers.
  await page.getByRole("button", { name: "Add a behavior" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Hair pulling");
  await page.getByRole("group", { name: "Examples", exact: true }).getByRole("button", { name: "Add a line" }).click();
  await page.getByRole("textbox", { name: "Examples 1", exact: true }).fill("During the home observation, the child pulled his sister's hair when she took the tablet.");
  await expect.poll(() => caseMapOf(caseFile)?.parts?.behaviors?.versions?.[0]?.content?.items?.[0]?.examples?.length ?? 0).toBe(1);
  const first = caseMapOf(caseFile).parts.behaviors;
  expect(first.versions).toHaveLength(1);
  expect(first.versions[0].content.items[0].name).toEqual({ value: "Hair pulling", refs: [{ kind: "her" }], origin: "her", check: null });
  expect(JSON.parse(readFileSync(caseFile, "utf8")).schemaVersion).toBe(5);

  // Approve the part: the sidebar counts it.
  await page.getByRole("button", { name: "Approve this part" }).click();
  await expect(page.getByTestId("map-part-status")).toHaveText("Approved");
  await expect.poll(() => caseMapOf(caseFile).parts.behaviors.approvedVersion).toBe(1);
  await expect(page.getByRole("navigation", { name: "Steps of the case" }).getByRole("link", { name: /Case map/ })).toContainText("1/1");
  // With content, the AI's action is in the header, waiting for an AI, and the panel says to connect one.
  // It ships as a beta, before the map's evaluation (owner's decision, 2026-11-23).
  await expect(page.getByRole("button", { name: "Update the map with the AI" })).toBeDisabled();
  await expect(page.getByText("Connect ChatGPT or Claude to have the AI draft the map.")).toBeVisible();
  await expect(page.getByText("Beta", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Its evaluation is in progress: check each value against your documents.").first()).toBeVisible();

  // A correction after approval is a new version; the approved one stays as it was.
  await page.getByLabel("Name", { exact: true }).fill("Hair pulling (any person)");
  await expect.poll(() => caseMapOf(caseFile).parts.behaviors.versions.length).toBe(2);
  await expect.poll(() => caseMapOf(caseFile).parts.behaviors.approvedVersion).toBe(null);
  expect(caseMapOf(caseFile).parts.behaviors.versions[0].content.items[0].name.value).toBe("Hair pulling");
  await expect(page.getByTestId("map-part-status")).toHaveText("Typed by you");

  // Going back shows the approved text again.
  await page.getByRole("button", { name: "Show v1" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Hair pulling");
  await expect.poll(() => caseMapOf(caseFile).parts.behaviors.currentVersion).toBe(1);

  // The report on her sections waits for the AI (a later pull request).
  await parts.getByRole("link", { name: /Report on your sections/ }).click();
  await expect(page.getByText(/This part fills in when the AI reads the sections you already wrote/)).toBeVisible();
});

test("the intensity her rule suggests (owner's decision 2A, 2026-11-28): shown next to the mean for a frequency behavior, saved as hers only when she clicks Use it", async ({ launch, home }) => {
  const casesFolder = defaultCasesFolder(home);
  seedCase(casesFolder);
  const caseFile = path.join(casesFolder, SAMPLE_CASE.label, "aba-case.json");
  const page = await firstScreen(await launch());
  await goTo(page, `/cases/${SAMPLE_CASE.id}/case-map`);
  await expect(heading(page)).toHaveText("Case map");
  await page.getByRole("button", { name: "Add a behavior" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Off task behavior");
  await page.getByLabel("Measure", { exact: true }).selectOption("frequency");
  const observations = page.getByRole("group", { name: "Observations", exact: true });
  for (const [index, count] of ["12", "11", "10"].entries()) {
    await observations.getByRole("button", { name: "Add a row" }).click();
    await page.getByRole("textbox", { name: `Count or minutes ${index + 1}`, exact: true }).fill(count);
  }
  // A mean of 11: more than 10 is 3.
  await expect(page.getByText(/^Suggested intensity: 3, by your rule/)).toBeVisible();
  const item = () => caseMapOf(caseFile)?.parts?.behaviors?.versions?.at(-1)?.content?.items?.[0];
  await expect.poll(() => item()?.baseline?.observations?.length ?? 0).toBe(3);
  // Nothing is saved until she clicks.
  expect(item()?.intensity ?? null).toBe(null);
  await page.getByRole("button", { name: "Use it", exact: true }).click();
  await expect(page.getByLabel("Intensity", { exact: true })).toHaveValue("3");
  await expect.poll(() => item()?.intensity).toEqual({ value: "3", refs: [{ kind: "her" }], origin: "her", check: null });
  // Already used: the suggestion stays, the button goes.
  await expect(page.getByRole("button", { name: "Use it", exact: true })).toHaveCount(0);
  // A duration behavior gets none: she rates it.
  await page.getByLabel("Measure", { exact: true }).selectOption("duration");
  await expect(page.getByText(/^Suggested intensity:/)).toHaveCount(0);
  // And its mean is a duration: counts with no unit give none.
  await expect(page.getByText(/every duration must be a number with the same unit/)).toBeVisible();
});
