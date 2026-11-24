import { useTranslation } from "react-i18next";
import { cn } from "./cn.ts";
import type { ChipState } from "./chip-state.ts";
import { Icon, type IconName } from "./Icon.tsx";

/*
 * A step's or a section's state, in words (layout rule 12): "Sin empezar", "Tuya",
 * "Borrador de la IA", "Corregida por ti", "Aprobada", "Copiada", and "La IA está
 * escribiendo" while it writes. The color and the icon only repeat the words: hers in the
 * success tint with a pencil, the AI's in the AI tint with a sparkle (owner's decision P9).
 * One chip per header (the step header, §3.2).
 */

export type { ChipState };

// The words' keys are camelCase: hyphenated keys make the translation types too deep for TypeScript.
const LOOK: Record<ChipState, { key: "notStarted" | "hers" | "aiDraft" | "corrected" | "approved" | "copied" | "writing"; icon: IconName | null; className: string }> = {
  "not-started": { key: "notStarted", icon: null, className: "border-transparent bg-neutral-subtle text-neutral" },
  hers: { key: "hers", icon: "pencil", className: "border-transparent bg-success-subtle text-success" },
  corrected: { key: "corrected", icon: "pencil", className: "border-transparent bg-success-subtle text-success" },
  "ai-draft": { key: "aiDraft", icon: "sparkle", className: "border-accent bg-ai-subtle text-fg-on-accent-subtle" },
  writing: { key: "writing", icon: "sparkle", className: "border-accent bg-ai-subtle text-fg-on-accent-subtle" },
  approved: { key: "approved", icon: "check", className: "border-transparent bg-success-subtle text-success" },
  copied: { key: "copied", icon: "copy", className: "border-transparent bg-success-subtle text-success" },
};

/**
 * The chip. `detail` follows the state after a middle dot ("Tuya · editando"); it is part of
 * the chip's words, so a screen reader hears it too.
 */
export function StateChip({ state, detail, className }: { state: ChipState; detail?: string; className?: string }) {
  const { t } = useTranslation();
  const look = LOOK[state];
  return (
    <span
      data-testid="state-chip"
      data-state={state}
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm font-medium whitespace-nowrap", look.className, className)}
    >
      {look.icon ? <Icon name={look.icon} /> : null}
      {t(`chip.${look.key}`)}
      {detail ? ` · ${detail}` : null}
    </span>
  );
}
