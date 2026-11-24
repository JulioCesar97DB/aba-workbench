import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RAIL_BREAKPOINT, SIDEBAR_BREAKPOINT, WINDOW_BACKGROUND } from "../src/shared/theme.ts";

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
  ["warning", "warning-subtle"], // status badge: needs attention; the trial bar above every screen; Revisión y copia: "1 dato por completar"
  ["warning", "surface"],
  ["danger", "surface"], // error message
  ["fg-on-nav-warning", "nav"], // error message on the sidebar
  ["fg-on-nav-warning", "nav-hover"],
  ["fg", "ai-subtle"], // what the AI does or proposes
  ["fg-muted", "ai-subtle"],
  ["fg-on-accent-subtle", "ai-subtle"], // also Revisión y copia: the AI review's "Pronto"
  ["accent", "ai-subtle"],
  ["warning", "ai-subtle"],
  ["fg-on-accent", "success"], // the current step, done: its check
  ["fg-on-accent", "warning"], // the current step, in progress: its number
  ["nav", "dot-done"], // a step done: its check (the sidebar, the case summary)
  ["nav", "dot-draft"], // a step in progress: its number (the sidebar, the case summary)
  ["fg", "nav-current"], // the current step, not started: its number
  ["fg-muted", "nav-current"], // the current step's count, "Soon" and subtitle
  ["success", "surface"], // a section's copied line; Revisión y copia: "✓ Copiada" and "Las 9 secciones están copiadas"
  ["success", "surface-muted"], // the rail's checks: "None", "Complete"
  ["warning", "surface-muted"], // the rail's checks: "1 to look at"
  ["danger", "surface-muted"], // Documentos' rail: the PDFs too large for the AI
  ["fg-on-accent-subtle", "next-subtle"], // the case summary's "Lo siguiente": its heading
  ["fg", "next-subtle"], // its sentence
  ["fg-muted", "next-subtle"], // its second sentence
  ["fg", "choice-subtle"], // New case's "¿Cómo empiezas?": the chosen option's title
  ["fg-muted", "choice-subtle"], // and its sentence
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
  ["accent", "ai-subtle"], // the AI's cards, buttons and chips: their edge; the dashed "Pronto" on the AI review's card
  ["fg-on-accent-subtle", "surface"], // the sparkle in the request box
  ["success", "surface-muted"], // a check passed, in the rail
  ["warning", "surface-muted"], // a point to look at, in the rail; Revisión y copia's "Antes de pegar" dots
  ["border-control", "surface-muted"], // Documentos: the buttons of the card for the folder's PDFs
  ["accent", "next-subtle"], // the case summary's "Lo siguiente": its edge
  ["accent", "choice-subtle"], // New case's chosen option: its edge and its radio
  ["focus", "choice-subtle"],
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
  // The rail sits beside the content from a 1024 px window (T2): the sidebar plus the working area's split width.
  const rem = (name: string) => Number(/^([0-9.]+)rem$/.exec(new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss)?.[1] ?? "")?.[1]);
  assert.equal(`${rem("spacing-sidebar") + rem("container-split")}rem`, RAIL_BREAKPOINT);
  assert.equal(RAIL_BREAKPOINT, "64rem");
});
