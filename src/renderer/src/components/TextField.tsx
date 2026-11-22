import { Field } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

/**
 * A labelled text input (Base UI Field): the label, the description and the error are
 * wired to the input, so a screen reader announces them with it. `error` shows the
 * message and marks the field invalid; the interface checks its own fields and the main
 * process checks them again.
 */
export function TextField({
  label,
  description,
  error,
  className,
  ...inputProps
}: { label: ReactNode; description?: ReactNode; error?: string | null } & Omit<ComponentProps<typeof Field.Control>, "className"> & { className?: string }) {
  return (
    <Field.Root invalid={Boolean(error)} className={cn("flex flex-col gap-1.5", className)}>
      <Field.Label className="font-medium">{label}</Field.Label>
      {description ? <Field.Description className="max-w-measure text-sm text-fg-muted">{description}</Field.Description> : null}
      <Field.Control
        {...inputProps}
        className="min-h-control w-full rounded-md border border-border-control bg-surface px-3 text-base text-fg data-invalid:border-danger"
      />
      <Field.Error match={Boolean(error)} className="text-sm font-medium text-danger">
        {error}
      </Field.Error>
    </Field.Root>
  );
}
