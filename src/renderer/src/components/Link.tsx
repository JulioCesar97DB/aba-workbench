import type { ComponentProps } from "react";
import { Link as RouterLink } from "react-router";
import { buttonClassName, type ButtonSize, type ButtonVariant } from "./Button.tsx";
import { cn } from "./cn.ts";

/** A link inside text: underlined, in the accent color. Every link goes to a screen of the app. */
export function TextLink({ className, ...props }: ComponentProps<typeof RouterLink>) {
  return (
    <RouterLink
      className={cn("font-medium text-accent underline underline-offset-2 hover:text-accent-hover hover:decoration-2", className)}
      {...props}
    />
  );
}

/** A link that looks like a button: for "go somewhere" actions next to buttons. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof RouterLink> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <RouterLink className={buttonClassName(variant, size, className)} {...props} />;
}
