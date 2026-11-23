import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

/*
 * Plain HTML tables with the project's styles: column headers (TableHeaderCell, scope
 * "col") or row headers (TableRowHeader, scope "row"), so a screen reader names each cell.
 */

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full border-collapse text-sm", className)} {...props} />;
}

export function TableHead(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border last:border-b-0", className)} {...props} />;
}

export function TableHeaderCell({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn("border-b border-border py-1.5 pr-3 text-left text-2xs font-semibold tracking-eyebrow text-fg-muted uppercase last:pr-0", className)}
      {...props}
    />
  );
}

export function TableRowHeader({ className, ...props }: ComponentProps<"th">) {
  return <th scope="row" className={cn("py-1.5 pr-3 text-left align-top font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("py-1.5 pr-3 align-top last:pr-0", className)} {...props} />;
}
