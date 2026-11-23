import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "./cn.ts";
import type { StepState } from "../step-states.ts";

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

const stepBase =
  "group flex items-center gap-2.5 rounded-md px-2 text-fg-on-nav no-underline transition-colors hover:bg-nav-hover aria-[current=page]:bg-nav-current aria-[current=page]:font-semibold aria-[current=page]:text-fg-on-nav-current";

/**
 * A step of the case: a circle with its number (or a check once done) that shows its
 * state (filled green once done, filled amber while in progress, hollow before, dashed
 * when not built yet), its name, and a count after it. The state is also said in words to a screen
 * reader; a step not built yet says "Soon" on screen too. Under its name, a few words on
 * what it holds (`subtitle`, shown only: the name says the step). `compact` trims the row
 * to 36 px and leaves the subtitle out while the report's sections are listed under it,
 * so the whole sidebar fits a 1366x768 window.
 */
export function StepNavItem({ to, number, state, stateText, laterTag, detail, subtitle, compact, children }: { to: string; number: number; state: StepState; stateText: string; laterTag: string; detail?: ReactNode; subtitle?: string; compact?: boolean; children: ReactNode }) {
  return (
    <NavLink to={to} className={cn(stepBase, compact ? "min-h-9" : "min-h-control py-1")}>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5.5 shrink-0 place-items-center rounded-full font-mono text-2xs font-semibold tabular-nums",
          state === "done" && "bg-dot-done text-nav group-aria-[current=page]:bg-success group-aria-[current=page]:text-fg-on-accent",
          state === "in-progress" && "bg-dot-draft text-nav group-aria-[current=page]:bg-warning group-aria-[current=page]:text-fg-on-accent",
          state === "not-started" && "border border-dot-empty text-fg-on-nav-muted group-aria-[current=page]:border-fg-muted group-aria-[current=page]:text-fg",
          state === "later" && "border border-dashed border-dot-empty text-fg-on-nav-muted group-aria-[current=page]:border-fg-muted group-aria-[current=page]:text-fg",
        )}
      >
        {state === "done" ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5l2.2 2.2L9.5 3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          number
        )}
      </span>
      <span className="min-w-0 flex-1">
        {children}
        <span className="sr-only">, {stateText}</span>
        {subtitle && !compact ? (
          <span aria-hidden="true" className="block text-xs leading-snug font-normal text-fg-on-nav-muted group-aria-[current=page]:text-fg-muted">
            {subtitle}
          </span>
        ) : null}
      </span>
      {state === "later" ? (
        <span aria-hidden="true" className="shrink-0 rounded-sm border border-dashed border-fg-on-nav-muted px-1 text-2xs font-semibold tracking-eyebrow text-fg-on-nav-muted uppercase group-aria-[current=page]:border-fg-muted group-aria-[current=page]:text-fg-muted">
          {laterTag}
        </span>
      ) : detail !== undefined ? (
        // Shown only: the step's label says the count in words (review M6).
        <span aria-hidden="true" className="shrink-0 font-mono text-xs text-fg-on-nav-muted group-aria-[current=page]:text-fg-muted">
          {detail}
        </span>
      ) : null}
    </NavLink>
  );
}

/**
 * A report section: a status dot, its English title, and its state in words after it
 * ("Yours", "v3", "Approved"; read by a screen reader too). The dot repeats the state:
 * hollow when not started, green when hers or approved, amber when an AI draft waits.
 */
export function SectionNavItem({ to, title, state, detail, statusLabel }: { to: string; title: string; state: "not-started" | "hers" | "drafted" | "approved"; detail: string | null; statusLabel: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex min-h-6.75 items-center gap-2 rounded-md px-2 py-1 text-sm leading-tight text-fg-on-nav no-underline transition-colors hover:bg-nav-hover",
          isActive && "bg-nav-hover font-semibold",
        )
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          state === "not-started" && "border border-dot-empty",
          (state === "hers" || state === "approved") && "bg-dot-done",
          state === "drafted" && "bg-dot-draft",
        )}
      />
      <span lang="en" className="min-w-0 flex-1">
        {title}
      </span>
      {detail ? (
        <span aria-hidden="true" className="shrink-0 text-xs font-normal text-fg-on-nav-muted">
          {detail}
        </span>
      ) : null}
      <span className="sr-only">{statusLabel}</span>
    </NavLink>
  );
}
