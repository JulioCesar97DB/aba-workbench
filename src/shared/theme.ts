/*
 * The few design values code outside the stylesheet needs. They repeat tokens from
 * src/renderer/src/styles/tokens.css, and tests/design-tokens.test.ts fails if the two
 * ever differ.
 */

/** --color-nav: the window's background before the interface paints (src/main/index.ts). */
export const WINDOW_BACKGROUND = "#1b2530";

/** --breakpoint-sidebar: from this width the sidebar shows and the Menu panel closes. */
export const SIDEBAR_BREAKPOINT = "48rem";

/**
 * The window's width from which the rail sits beside the content (owner's decision T2): the
 * sidebar (--spacing-sidebar) plus --container-split. Below it the rail is a panel opened from
 * the header, and the header's chip and version menu move to the top of the content.
 */
export const RAIL_BREAKPOINT = "64rem";
