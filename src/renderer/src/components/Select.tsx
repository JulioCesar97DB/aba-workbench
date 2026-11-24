import { Select as BaseSelect } from "@base-ui/react/select";
import { useId } from "react";

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
  /** The language of the label, when it differs from the screen's (a language's own name). */
  lang?: string;
}

/**
 * A labelled single-choice list (Base UI Select): opens with Enter, Space or the arrow
 * keys, and the label and description are announced with the control.
 */
export function Select<Value extends string>({
  label,
  description,
  value,
  options,
  onValueChange,
  describedBy,
}: {
  label: string;
  description?: React.ReactNode;
  /** The id of a hint shown elsewhere that the control is described by too. */
  describedBy?: string;
  value: Value;
  options: SelectOption<Value>[];
  onValueChange: (value: Value) => void;
}) {
  const descriptionId = useId();
  const selected = options.find((option) => option.value === value);
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as Value);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <BaseSelect.Label className="font-medium">{label}</BaseSelect.Label>
        {description ? (
          <p id={descriptionId} className="max-w-measure text-sm text-fg-muted">
            {description}
          </p>
        ) : null}
        <BaseSelect.Trigger
          aria-describedby={[description ? descriptionId : null, describedBy ?? null].filter(Boolean).join(" ") || undefined}
          className="inline-flex min-h-control w-full max-w-72 items-center justify-between gap-3 rounded-md border border-border-control bg-surface px-3 text-left hover:bg-surface-muted data-popup-open:bg-surface-muted"
        >
          <BaseSelect.Value>{() => <span lang={selected?.lang}>{selected?.label}</span>}</BaseSelect.Value>
          <BaseSelect.Icon className="text-fg-muted">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
      </div>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-10 outline-none">
          <BaseSelect.Popup className="min-w-(--anchor-width) rounded-md border border-border bg-surface py-1 text-fg shadow-popup outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                className="grid min-h-control cursor-default grid-cols-[1rem_1fr] items-center gap-2 px-3 outline-none select-none data-highlighted:bg-surface-muted data-selected:font-semibold"
              >
                <BaseSelect.ItemIndicator className="text-accent">
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="m2 6.5 2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText lang={option.lang} className="col-start-2">
                  {option.label}
                </BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
