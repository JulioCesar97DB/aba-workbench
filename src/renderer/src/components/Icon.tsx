import { cn } from "./cn.ts";

/*
 * The app's own icons (owner's decision T5): a handful of inline SVGs, no icon library.
 * Each is drawn on a 16x16 grid in the current text color, so it follows the button or the
 * chip it sits in. An icon never carries meaning alone: the words beside it do, so it is
 * hidden from screen readers.
 */

const PATHS = {
  // "A mano": what she writes herself.
  pencil: <path d="M11.2 2.3a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L5.5 13 2.5 13.5 3 10.5z M9.8 3.7l2.5 2.5" />,
  // "Con la IA": what the AI does or proposes. A four-point star and a small one.
  sparkle: <path d="M6.5 1.5 7.6 5.4 11.5 6.5 7.6 7.6 6.5 11.5 5.4 7.6 1.5 6.5 5.4 5.4z M12.5 10.5v4 M10.5 12.5h4" />,
  check: <path d="M2.8 8.4 6.3 11.8 13.2 4.6" />,
  arrow: <path d="M2.5 8h11 M9 3.5 13.5 8 9 12.5" />,
  chevron: <path d="M4 6 8 10 12 6" />,
  copy: <path d="M5.5 5.5h8v8h-8z M10.5 5.5v-3h-8v8h3" />,
  upload: <path d="M8 10.5v-8 M4.5 6 8 2.5 11.5 6 M2.5 10.5v3h11v-3" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  panel: <path d="M2.5 3h11v10h-11z M10 3v10" />,
  // "⋯": a row's other actions (layout rule 5).
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </g>
  ),
} as const;

export type IconName = keyof typeof PATHS;

/** An icon at the size of the text around it (1em), or `size` in px. */
export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      viewBox="0 0 16 16"
      width={size ?? "1em"}
      height={size ?? "1em"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      {PATHS[name]}
    </svg>
  );
}
