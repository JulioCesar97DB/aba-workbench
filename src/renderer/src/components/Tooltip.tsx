import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/**
 * A short label shown on hover and on keyboard focus. It repeats what the control's
 * accessible name already says (a tooltip is not read as the name), so put the full
 * wording in the control's own label too. `children` must be one focusable element.
 */
export function Tooltip({ content, children, lang }: { content: ReactNode; children: ReactElement; lang?: string }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup
            data-slot="tooltip"
            lang={lang}
            className="max-w-64 rounded-md bg-fg px-2 py-1 text-xs text-surface shadow-popup transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** Shares one hover delay between all tooltips; rendered once around the app. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={400}>{children}</BaseTooltip.Provider>;
}
