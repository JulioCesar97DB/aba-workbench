import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../components/cn.ts";

/*
 * A screen: its header (title, detail, actions), its content and, when given, the right
 * rail (sources and checks), all inside <main id="content">, so the skip link and a
 * screen reader's "main" landmark start at the screen's title.
 *
 * The header never scrolls. Below it, the content and the rail each scroll on their own
 * (owner's decision T1, layout rule "one scroll area per region"): reading a long section
 * moves only its text, while the header and the rail stay where they are. The rail sits
 * beside the content when the screen is at least --container-split wide; below that it
 * follows the content, and the two scroll together as one region. It is a container
 * query: it follows the working area's width, not the window's, so it also works with the
 * sidebar shown or hidden. `contentClassName` shapes the content (a maximum width, say),
 * not its scroll area, whose scroll bar stays at the pane's edge. A `footer` is docked
 * under the content (a section's request box).
 */
export function WorkArea({
  header,
  children,
  rail,
  footer,
  contentClassName,
}: {
  header: ReactNode;
  children: ReactNode;
  rail?: ReactNode;
  /**
   * Docked at the foot of the content pane, outside its scroll (layout rule 3): a section's
   * request box. Beside the rail from --container-split up; below that it sticks to the
   * foot of the one scroll area while the content is in view.
   */
  footer?: ReactNode;
  contentClassName?: string;
}) {
  const { t } = useTranslation();
  return (
    <main id="content" className="flex min-h-0 flex-1 flex-col">
      {header}
      <div
        data-region="body"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto @split:grid @split:grid-rows-[minmax(0,1fr)_auto] @split:overflow-hidden",
          rail ? "@split:grid-cols-[minmax(0,1fr)_var(--spacing-rail)] @split-wide:grid-cols-[minmax(0,1fr)_var(--spacing-rail-wide)]" : "@split:grid-cols-[minmax(0,1fr)]",
        )}
      >
        <div data-region="content" className="min-w-0 shrink-0 grow @split:col-start-1 @split:row-start-1 @split:min-h-0 @split:overflow-y-auto">
          <div className={cn("px-6 py-5", contentClassName)}>{children}</div>
        </div>
        {footer ? (
          <div
            data-region="footer"
            className="sticky bottom-0 z-1 shrink-0 border-t border-border bg-surface px-6 py-3 @split:static @split:col-start-1 @split:row-start-2"
          >
            {footer}
          </div>
        ) : null}
        {rail ? (
          <aside
            aria-label={t("rail.label")}
            data-region="rail"
            className="flex shrink-0 flex-col gap-5 border-t border-border bg-surface-muted px-4.5 py-4 @split:col-start-2 @split:row-[1/span_2] @split:min-h-0 @split:overflow-y-auto @split:border-t-0 @split:border-l"
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
