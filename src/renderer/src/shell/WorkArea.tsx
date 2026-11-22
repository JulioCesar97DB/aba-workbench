import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../components/cn.ts";

/*
 * Below the header: the screen's main content and, when given, the right rail (sources
 * and checks). The rail sits beside the content when the working area is at least 50rem
 * wide and below it otherwise (a container query: it follows the working area's width,
 * not the window's, so it also works with the sidebar shown or hidden).
 */
export function WorkArea({ children, rail, mainClassName }: { children: ReactNode; rail?: ReactNode; mainClassName?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col @min-[50rem]:flex-row">
      <main id="content" tabIndex={-1} className={cn("min-w-0 flex-1 px-6 py-5 focus:outline-none", mainClassName)}>
        {children}
      </main>
      {rail ? (
        <aside
          aria-label={t("rail.label")}
          className="flex flex-col gap-5 border-t border-border bg-surface-muted px-[18px] py-4 @min-[50rem]:w-rail @min-[50rem]:shrink-0 @min-[50rem]:border-t-0 @min-[50rem]:border-l @min-[72rem]:w-80"
        >
          {rail}
        </aside>
      ) : null}
    </div>
  );
}

/** A heading inside the rail or the sidebar: small, uppercase, spaced. */
export function Eyebrow({ id, children, className, as: Tag = "h2" }: { id?: string; children: ReactNode; className?: string; as?: "h2" | "h3" | "p" }) {
  return (
    <Tag id={id} className={cn("text-2xs font-semibold tracking-eyebrow uppercase", className)}>
      {children}
    </Tag>
  );
}
