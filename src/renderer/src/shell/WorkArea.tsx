import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../components/cn.ts";

/*
 * A screen: its header (title, detail, actions), its content and, when given, the right
 * rail (sources and checks), all inside <main id="content">, so the skip link and a
 * screen reader's "main" landmark start at the screen's title. The rail sits beside the
 * content when the screen is at least --container-split wide and below it otherwise (a
 * container query: it follows the working area's width, not the window's, so it also
 * works with the sidebar shown or hidden).
 */
export function WorkArea({ header, children, rail, contentClassName }: { header: ReactNode; children: ReactNode; rail?: ReactNode; contentClassName?: string }) {
  const { t } = useTranslation();
  return (
    <main id="content" className="flex flex-1 flex-col">
      {header}
      <div className="flex flex-1 flex-col @split:flex-row">
        <div className={cn("min-w-0 flex-1 px-6 py-5", contentClassName)}>{children}</div>
        {rail ? (
          <aside
            aria-label={t("rail.label")}
            className="flex flex-col gap-5 border-t border-border bg-surface-muted px-4.5 py-4 @split:w-rail @split:shrink-0 @split:border-t-0 @split:border-l @split-wide:w-rail-wide"
          >
            {rail}
          </aside>
        ) : null}
      </div>
    </main>
  );
}

/** A heading inside the rail or the sidebar: small, uppercase, spaced. */
export function Eyebrow({ id, children, className, as: Tag = "h2" }: { id?: string; children: ReactNode; className?: string; as?: "h2" | "p" }) {
  return (
    <Tag id={id} className={cn("text-2xs font-semibold tracking-eyebrow uppercase", className)}>
      {children}
    </Tag>
  );
}
