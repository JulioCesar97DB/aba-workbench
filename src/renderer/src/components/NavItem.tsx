import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "./cn.ts";

/*
 * Links of the dark sidebar. The current one is marked aria-current="page" (by NavLink)
 * and drawn as a light pill, as in the reference.
 */

const itemBase =
  "flex min-h-control items-center justify-between gap-2 rounded-md px-2 text-fg-on-nav no-underline transition-colors hover:bg-nav-hover aria-[current=page]:bg-nav-current aria-[current=page]:font-semibold aria-[current=page]:text-fg-on-nav-current";

/** A screen of the app (Cases, Settings) or a step of a case, with an optional number before and detail after. */
export function NavItem({ to, end, number, children, detail }: { to: string; end?: boolean; number?: number; children: ReactNode; detail?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={itemBase}>
      <span className="flex min-w-0 gap-1.5">
        {number !== undefined ? <span className="tabular-nums">{number}</span> : null}
        <span className="min-w-0">{children}</span>
      </span>
      {detail !== undefined ? <span className="font-mono text-xs">{detail}</span> : null}
    </NavLink>
  );
}

/**
 * A report section: a status dot, its English title, and its status in words (read by a
 * screen reader; the dot shows it). Every section is "not started" until drafting exists;
 * the reference's ready and draft states arrive with it.
 */
export function SectionNavItem({ to, title, statusLabel }: { to: string; title: string; statusLabel: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-on-nav no-underline transition-colors hover:bg-nav-hover",
          isActive && "bg-nav-hover font-semibold",
        )
      }
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-dot-empty" />
      <span lang="en" className="min-w-0 flex-1">
        {title}
      </span>
      <span className="sr-only">{statusLabel}</span>
    </NavLink>
  );
}
