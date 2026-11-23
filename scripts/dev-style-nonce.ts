import { randomBytes } from "node:crypto";
import type { Plugin } from "vite";

/*
 * Development only (pnpm dev). Vite's dev server injects every stylesheet as a <style>
 * element, which the interface's content security policy (style-src 'self') blocks; a
 * built app links .css files and needs nothing. Under the dev server only, this plugin
 * adds a nonce, new on each run, to style-src, and Vite (html.cspNonce) puts the same
 * nonce on the styles it injects. The policy of the built and packaged app is untouched
 * (apply: "serve"; e2e/shell.e2e.ts checks the built page's policy).
 */

/** The directive exactly as index.html writes it, ";" included, so a changed style-src is noticed. */
const STYLE_SRC = "style-src 'self';";

/** Returns `html` with the nonce added to the policy's style-src. Throws if the policy changed shape. */
export function addStyleNonce(html: string, nonce: string): string {
  const occurrences = html.split(STYLE_SRC).length - 1;
  if (occurrences !== 1) throw new Error(`Expected "${STYLE_SRC}" once in index.html's content security policy, found it ${occurrences} times.`);
  return html.replace(STYLE_SRC, () => `style-src 'self' 'nonce-${nonce}';`);
}

export function devStyleNonce(): Plugin {
  const nonce = randomBytes(16).toString("base64");
  return {
    name: "aba-workbench:dev-style-nonce",
    apply: "serve",
    config: () => ({ html: { cspNonce: nonce } }),
    transformIndexHtml: { order: "pre", handler: (html) => addStyleNonce(html, nonce) },
  };
}
