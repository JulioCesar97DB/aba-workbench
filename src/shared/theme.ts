/*
 * The few design values code outside the stylesheet needs. They repeat tokens from
 * src/renderer/src/styles/tokens.css, and tests/design-tokens.test.ts fails if the two
 * ever differ.
 */

/** --color-nav: the window's background before the interface paints (src/main/index.ts). */
export const WINDOW_BACKGROUND = "#1b2530";

/** --breakpoint-sidebar: from this width the sidebar shows and the Menu panel closes. */
export const SIDEBAR_BREAKPOINT = "48rem";
