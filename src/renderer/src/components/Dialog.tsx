import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn.ts";

/*
 * A modal dialog (Base UI: focus moves into it and stays there, Escape and the backdrop
 * close it, focus returns to the trigger). Two shapes: "center", a small message box,
 * and "sheet", a panel from the left edge (the navigation on a narrow window).
 */

export interface DialogProps {
  /** The element that opens it, usually a <Button>. */
  trigger: ReactElement;
  title: ReactNode;
  children: ReactNode;
  variant?: "center" | "sheet";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the popup (the sheet sets its own surface). */
  popupClassName?: string;
  /** Hides the title visually; it still names the dialog for a screen reader. */
  titleHidden?: boolean;
}

const popupClasses = {
  center:
    "fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-fg shadow-popup transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
  sheet:
    "fixed inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] flex-col overflow-hidden shadow-popup transition-transform data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
};

export function Dialog({ trigger, title, children, variant = "center", open, onOpenChange, popupClassName, titleHidden }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <BaseDialog.Trigger render={trigger} />
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-backdrop transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <BaseDialog.Popup className={cn(popupClasses[variant], popupClassName)}>
          <BaseDialog.Title className={titleHidden ? "sr-only" : "text-lg font-semibold"}>{title}</BaseDialog.Title>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export const DialogClose = BaseDialog.Close;
export const DialogDescription = BaseDialog.Description;
