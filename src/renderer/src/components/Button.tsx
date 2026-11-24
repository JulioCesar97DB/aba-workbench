import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export type ButtonVariant = "primary" | "secondary" | "ai" | "nav";
export type ButtonSize = "md" | "sm";

const base =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border text-base leading-tight whitespace-nowrap select-none transition-colors data-disabled:cursor-not-allowed";

/*
 * A disabled button looks the same whatever its kind (audit L9): grey on grey with a grey
 * edge, so a disabled primary or AI button never reads as a faded colour of its own. It stays
 * focusable where the screen says why it is off (focusableWhenDisabled).
 */
const disabled = "data-disabled:border-border data-disabled:bg-surface-muted data-disabled:text-fg-muted data-disabled:hover:bg-surface-muted";

/*
 * Layout rule 9: one primary per screen; the others secondary (outlined); what asks the AI in
 * the AI style; nothing destructive in plain sight (it goes in a "⋯" menu, with a confirmation
 * or an Undo). 44 px by default, 32 px (size "sm") inside rows, rails and messages.
 */
const variants: Record<ButtonVariant, string> = {
  // The one main action of a screen.
  primary: `border-transparent bg-accent font-semibold text-fg-on-accent hover:bg-accent-hover ${disabled}`,
  secondary: `border-border-control bg-surface font-medium text-fg hover:bg-surface-muted ${disabled}`,
  // What asks the AI to do something (owner's decision P9): the AI's amber tint, edged in the accent.
  ai: `border-accent bg-ai-subtle font-semibold text-fg-on-accent-subtle hover:bg-accent-subtle ${disabled}`,
  // On the dark sidebar.
  nav: "border-transparent font-medium text-fg-on-nav hover:bg-nav-hover data-disabled:opacity-60",
};

const sizes: Record<ButtonSize, string> = {
  md: "min-h-control px-4",
  sm: "min-h-control-sm px-3 text-sm",
};

/** The classes of a button, for elements that look like one without being one (ButtonLink). */
export function buttonClassName(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** A button (Base UI's, so it can stay focusable while disabled). Always type="button" unless given. */
export function Button({ variant = "secondary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return <BaseButton type={type} className={buttonClassName(variant, size, className)} {...props} />;
}
