import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The compact header of the working area: the screen's title (its only h1), a line of
 * technical detail in Plex Mono, and the screen's actions. It also sets the window title.
 * The h1 can take focus (tabIndex -1) so the skip link and a navigation can land on it.
 */
export function PageHeader({ title, titleLang, meta, afterTitle, actions }: { title: string; titleLang?: string; meta?: ReactNode; afterTitle?: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  const windowTitle = t("app.pageTitle", { page: title });
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);
  return (
    <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h1 id="page-title" tabIndex={-1} lang={titleLang} className="text-lg font-semibold break-words">
          {title}
        </h1>
        {afterTitle}
        {meta ? <p className="font-mono text-xs text-fg-muted">{meta}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-1.5">{actions}</div> : null}
    </header>
  );
}
