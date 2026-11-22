import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export type ButtonVariant = "primary" | "secondary" | "nav";
export type ButtonSize = "md" | "sm";

const base =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-base leading-tight whitespace-nowrap select-none transition-colors data-disabled:cursor-not-allowed data-disabled:opacity-60";

const variants: Record<ButtonVariant, string> = {
  // The one main action of a screen.
  primary: "bg-accent font-semibold text-fg-on-accent hover:bg-accent-hover data-disabled:hover:bg-accent",
  secondary: "border border-border-control bg-surface font-medium text-fg hover:bg-surface-muted",
  // On the dark sidebar.
  nav: "font-medium text-fg-on-nav hover:bg-nav-hover",
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
