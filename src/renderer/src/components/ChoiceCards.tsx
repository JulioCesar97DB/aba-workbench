import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useId } from "react";
import { cn } from "./cn.ts";

/*
 * A choice of one among a few, each option a card with its title and one sentence (Base
 * UI RadioGroup: arrow keys move between the options, the group is one Tab stop). New
 * case's "¿Cómo empiezas?" (mockup 02). The chosen card is edged in the accent on its light
 * tint (`--color-choice-subtle`); its radio repeats it, and the radio's state is what a
 * screen reader hears, with the title as its name and the sentence as its description.
 */
export interface ChoiceOption<Value extends string> {
  value: Value;
  title: string;
  body: string;
}

export function ChoiceCards<Value extends string>({
  legend,
  options,
  value,
  onChange,
  testId,
}: {
  legend: string;
  options: ReadonlyArray<ChoiceOption<Value>>;
  value: Value;
  onChange: (value: Value) => void;
  testId?: string;
}) {
  const legendId = useId();
  const optionId = useId();
  return (
    <div className="flex flex-col gap-2">
      <p id={legendId} className="font-medium">
        {legend}
      </p>
      <RadioGroup aria-labelledby={legendId} value={value} onValueChange={(next) => onChange(next as Value)} data-testid={testId} className="flex flex-col gap-2">
        {options.map((option, index) => (
          <Radio.Root
            key={option.value}
            value={option.value}
            aria-labelledby={`${optionId}-${index}-title`}
            aria-describedby={`${optionId}-${index}-body`}
            className={cn(
              "group flex cursor-default items-start gap-2.5 rounded-lg border px-3.5 py-3 text-left",
              "border-border-control bg-surface data-checked:border-accent data-checked:bg-choice-subtle data-checked:shadow-[inset_0_0_0_1px_var(--color-accent)]",
            )}
          >
            <span aria-hidden="true" className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-control group-data-checked:border-4 group-data-checked:border-accent" />
            <span className="flex flex-col gap-0.5">
              <span id={`${optionId}-${index}-title`} className="text-base font-semibold">
                {option.title}
              </span>
              <span id={`${optionId}-${index}-body`} className="text-sm text-fg-muted">
                {option.body}
              </span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  );
}
