import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "./cn.ts";

/*
 * A modal dialog (Base UI: focus moves into it and stays there, Escape and the backdrop
 * close it, focus returns to the trigger). Three shapes: "center", a small message box;
 * "sheet", a panel from the left edge (the navigation on a narrow window); and "panel", a
 * light panel from the right edge that leaves the screen usable beside it (today's notes):
 * it is not modal, so a press outside it closes it and still reaches what was pressed, and
 * it stays mounted while closed (hidden), so what it holds lives as long as the screen does:
 * a box saved as she types keeps its one queue of saves, its status and what is waiting.
 */

export interface DialogProps {
  /** The element that opens it, usually a <Button>; none for a dialog the screen opens itself (controlled with `open`). */
  trigger?: ReactElement;
  title: ReactNode;
  children: ReactNode;
  variant?: "center" | "sheet" | "panel";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the popup (the sheet sets its own surface). */
  popupClassName?: string;
  /** Hides the title visually; it still names the dialog for a screen reader. */
  titleHidden?: boolean;
  /** Where focus goes when it opens (Base UI's initialFocus): by default the first control in it. */
  initialFocus?: ComponentProps<typeof BaseDialog.Popup>["initialFocus"];
  /** Where focus goes when it closes (Base UI's finalFocus): by default back to what opened it. */
  finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
  /** The popup's id, for a button elsewhere that opens it (aria-controls). */
  id?: string;
}

const popupClasses = {
  center:
    "fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-fg shadow-popup transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
  sheet:
    "fixed inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] flex-col overflow-hidden shadow-popup transition-transform data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
  panel:
    "fixed inset-y-0 right-0 flex w-[min(22rem,calc(100vw-3rem))] flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-5 text-fg shadow-popup transition-transform data-ending-style:translate-x-full data-starting-style:translate-x-full",
};

export function Dialog({ trigger, title, children, variant = "center", open, onOpenChange, popupClassName, titleHidden, initialFocus, finalFocus, id }: DialogProps) {
  const modal = variant !== "panel";
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined} modal={modal}>
      {trigger ? <BaseDialog.Trigger render={trigger} /> : null}
      <BaseDialog.Portal keepMounted={!modal}>
        {modal ? <BaseDialog.Backdrop className="fixed inset-0 bg-backdrop transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" /> : null}
        <BaseDialog.Popup id={id} className={cn(popupClasses[variant], popupClassName)} initialFocus={initialFocus} finalFocus={finalFocus}>
          <BaseDialog.Title className={titleHidden ? "sr-only" : "text-lg font-semibold"}>{title}</BaseDialog.Title>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export const DialogClose = BaseDialog.Close;
export const DialogDescription = BaseDialog.Description;
