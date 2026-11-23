import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SIDEBAR_BREAKPOINT, WINDOW_BACKGROUND } from "../src/shared/theme.ts";

/*
 * Text contrast (WCAG 2.2, 1.4.3): every pair of text and background tokens the
 * interface puts together reaches 4.5:1; control borders, focus rings and status dots
 * reach 3:1 (1.4.11). Add a pair here when a component uses a new combination.
 */
const tokensCss = readFileSync(path.join(import.meta.dirname, "../src/renderer/src/styles/tokens.css"), "utf8");
const colors = new Map([...tokensCss.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1], match[2]]));

const TEXT_PAIRS: Array<[text: string, background: string]> = [
  ["fg", "surface"],
  ["fg-muted", "surface"],
  ["fg", "surface-muted"],
  ["fg-muted", "surface-muted"],
  ["accent", "surface"], // links
  ["accent-hover", "surface"],
  ["accent", "surface-muted"],
  ["fg-on-accent", "accent"], // primary button
  ["fg-on-accent", "accent-hover"],
  ["fg-on-accent-subtle", "accent-subtle"], // accent badge, text selection
  ["fg-on-nav", "nav"],
  ["fg-on-nav-muted", "nav"],
  ["fg-on-nav", "nav-hover"],
  ["fg-on-nav-muted", "nav-hover"],
  ["fg-on-nav-current", "nav-current"],
  ["surface", "fg"], // tooltip
  ["neutral", "neutral-subtle"], // status badge
  ["success", "success-subtle"], // status badge: connected
  ["warning", "warning-subtle"], // status badge: needs attention; the trial bar above every screen
  ["warning", "surface"],
  ["danger", "surface"], // error message
  ["fg-on-nav-warning", "nav"], // error message on the sidebar
  ["fg-on-nav-warning", "nav-hover"],
  ["fg", "ai-subtle"], // what the AI does or proposes
  ["fg-muted", "ai-subtle"],
  ["fg-on-accent-subtle", "ai-subtle"],
  ["accent", "ai-subtle"],
  ["warning", "ai-subtle"],
  ["fg-on-accent", "success"], // the current step, done: its check
  ["fg-on-accent", "warning"], // the current step, in progress: its number
  ["nav", "dot-done"], // a step done: its check
  ["nav", "dot-draft"], // a step in progress: its number
  ["fg", "nav-current"], // the current step, not started: its number
  ["fg-muted", "nav-current"], // the current step's count, "Soon" and subtitle
];

const NON_TEXT_PAIRS: Array<[element: string, background: string]> = [
  ["border-control", "surface"],
  ["focus", "surface"],
  ["focus", "surface-muted"],
  ["focus-on-nav", "nav"],
  ["focus-on-nav", "nav-hover"],
  ["dot-empty", "nav"],
  ["dot-done", "nav"], // a step done, on the sidebar
  ["dot-draft", "nav"], // a step in progress
  ["focus", "ai-subtle"],
  ["focus", "warning-subtle"], // "What this means" in the trial bar
  ["fg-muted", "nav-current"], // the current step's hollow circle
];

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function color(name: string): string {
  const value = colors.get(name);
  assert.ok(value, `--color-${name} is not a hex color in tokens.css`);
  return value;
}

test("design tokens: text reaches 4.5:1 on every background it is used on", () => {
  for (const [text, background] of TEXT_PAIRS) {
    const ratio = contrast(color(text), color(background));
    assert.ok(ratio >= 4.5, `${text} on ${background}: ${ratio.toFixed(2)}:1`);
  }
});

test("design tokens: control borders, focus rings and status dots reach 3:1", () => {
  for (const [element, background] of NON_TEXT_PAIRS) {
    const ratio = contrast(color(element), color(background));
    assert.ok(ratio >= 3, `${element} on ${background}: ${ratio.toFixed(2)}:1`);
  }
});

test("design tokens: the values code repeats (src/shared/theme.ts) match the tokens", () => {
  assert.equal(WINDOW_BACKGROUND, color("nav"));
  assert.equal(/--breakpoint-sidebar:\s*([^;]+);/.exec(tokensCss)?.[1], SIDEBAR_BREAKPOINT);
});
