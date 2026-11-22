import type { ReactNode } from "react";
import { cn } from "./cn.ts";

/**
 * "neutral" for a state ("Not started"), "accent" to draw the eye ("Not built yet"),
 * "success" for something that works ("Connected"), "warning" for something that needs
 * the user ("Needs attention"). More tones come with the screens that need them.
 */
export type StatusTone = "neutral" | "accent" | "success" | "warning";

const tones: Record<StatusTone, string> = {
  neutral: "bg-neutral-subtle text-neutral",
  accent: "bg-accent-subtle text-fg-on-accent-subtle",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
};

/** A short status in words: the color only repeats what the words say. */
export function StatusBadge({ tone = "neutral", children, className }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}
