import { useId, type ReactNode } from "react";
import { StatusBadge } from "../components/StatusBadge.tsx";

/** One part of Settings: a heading (with an optional badge) and what belongs under it. */
export function SettingsSection({ heading, badge, children }: { heading: string; badge?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5 border-b border-border py-5 first:pt-0 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          {heading}
        </h2>
        {badge ? <StatusBadge>{badge}</StatusBadge> : null}
      </div>
      {children}
    </section>
  );
}
