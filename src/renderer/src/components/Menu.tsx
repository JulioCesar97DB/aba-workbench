import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ReactElement } from "react";

export interface MenuItemSpec {
  key: string;
  label: string;
  /** The label's language, when it differs from the screen's (an English clinical term). */
  lang?: string;
  onSelect: () => void;
}

/**
 * A button that opens a short list of actions (Base UI Menu): Enter, Space or the down
 * arrow open it, the arrows move through it, Escape closes it and focus returns to the button.
 */
export function MenuButton({ trigger, items, label }: { trigger: ReactElement; items: MenuItemSpec[]; label?: string }) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} align="end" className="z-10 outline-none">
          <BaseMenu.Popup
            aria-label={label}
            className="min-w-56 rounded-md border border-border bg-surface py-1 text-fg shadow-popup outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {items.map((item) => (
              <BaseMenu.Item
                key={item.key}
                lang={item.lang}
                onClick={item.onSelect}
                className="flex min-h-control cursor-default items-center px-3 outline-none select-none data-highlighted:bg-surface-muted"
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
