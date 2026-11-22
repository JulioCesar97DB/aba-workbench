import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "accent";

const tones: Record<StatusTone, string> = {
  neutral: "bg-neutral-subtle text-neutral",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  accent: "bg-accent-subtle text-fg-on-accent-subtle",
};

/** A short status in words ("Not started", "Done"): the color only repeats what the words say. */
export function StatusBadge({ tone = "neutral", children, className }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}
