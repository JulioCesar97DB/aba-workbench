import type { ReactNode } from "react";
import { cn } from "./cn.ts";

/** "neutral" for a state ("Not started"), "accent" to draw the eye ("Not built yet"). More tones come with the screens that need them. */
export type StatusTone = "neutral" | "accent";

const tones: Record<StatusTone, string> = {
  neutral: "bg-neutral-subtle text-neutral",
  accent: "bg-accent-subtle text-fg-on-accent-subtle",
};

/** A short status in words: the color only repeats what the words say. */
export function StatusBadge({ tone = "neutral", children, className }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}
