import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The compact header of the working area: the screen's title (its only h1), a line of
 * technical detail in Plex Mono, and the screen's actions. It also sets the window title.
 * The h1 can take focus (tabIndex -1) so the skip link and a navigation can land on it.
 *
 * It stays outside the scrolling content, and from --container-split up it is one row of
 * fixed height (--spacing-header, 64 px) that never wraps (owner's decision T1): the title
 * and the detail line shorten with an ellipsis (the whole title is its tooltip), what
 * follows the title (a section's versions) scrolls sideways within its place, and the
 * actions keep theirs. So a button never moves when a title is long, a section has many
 * versions or the screen is in Spanish. On a narrower working area it may wrap.
 */
export function PageHeader({ title, titleLang, meta, afterTitle, actions }: { title: string; titleLang?: string; meta?: ReactNode; afterTitle?: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  const windowTitle = t("app.pageTitle", { page: title });
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);
  return (
    <header
      data-region="header"
      className="flex min-h-header shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-5 py-2 @split:h-header @split:flex-nowrap @split:py-1.5"
    >
      <div className="flex min-w-0 flex-col justify-center gap-0.5 @split:flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @split:flex-nowrap">
          <h1 id="page-title" tabIndex={-1} lang={titleLang} title={title} className="min-w-0 text-lg font-semibold break-words @split:truncate">
            {title}
          </h1>
          {afterTitle ? (
            <div className="flex min-w-0 items-center [scrollbar-width:thin] @split:shrink-[4] @split:overflow-x-auto @split:[&>*]:flex-nowrap">{afterTitle}</div>
          ) : null}
        </div>
        {meta ? <p className="min-w-0 font-mono text-xs text-fg-muted @split:truncate">{meta}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5 @split:shrink-0 @split:flex-nowrap">{actions}</div> : null}
    </header>
  );
}
