import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** A number, a version or a path inside a sentence: the one thing in Plex Mono (owner's decision T17). */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/**
 * The compact header of the working area: the screen's title (its only h1), a line of
 * detail, and the screen's actions. The detail line is a sentence, so it is in Plex Sans;
 * only a number, a version or a path inside it is in Plex Mono, wrapped in <Mono> by the
 * screen (owner's decision T17). It also sets the window title.
 * The h1 can take focus (tabIndex -1) so the skip link and a navigation can land on it.
 *
 * A step's screen gives it an eyebrow ("PASO 2 DE 5", "INFORME · SECCIÓN 2 DE 9") above the
 * title and one state chip after it (the step header, owner's proposal §3.2; `StepHeader`
 * below names the parts).
 *
 * It stays outside the scrolling content, and from --container-split up it is one row of
 * fixed height (--spacing-header, 64 px) that never wraps (owner's decision T1): the title
 * and the detail line shorten with an ellipsis (the whole title is its tooltip once cut), what
 * follows the title (a version menu) keeps its place, and the actions keep theirs. So a
 * button never moves when a title is long or the screen is in Spanish. On a narrower working
 * area it may wrap.
 */
export function PageHeader({
  title,
  titleLang,
  eyebrow,
  chip,
  meta,
  afterTitle,
  status,
  actions,
}: {
  title: string;
  titleLang?: string;
  /** A short line above the title, in small capitals. */
  eyebrow?: ReactNode;
  /** One state chip right after the title (StateChip). */
  chip?: ReactNode;
  /** A line of detail under the title. A step header has none (its eyebrow takes the room). */
  meta?: ReactNode;
  /** After the title and the chip: a version menu, say. */
  afterTitle?: ReactNode;
  /** The save state ("Todo guardado", "Guardando…"), right before the actions, in a space that does not change width. */
  status?: ReactNode;
  actions?: ReactNode;
}) {
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
        {eyebrow ? (
          <p data-testid="header-eyebrow" className="min-w-0 text-2xs font-semibold tracking-eyebrow text-fg-muted uppercase @split:truncate">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @split:flex-nowrap">
          <h1
            id="page-title"
            tabIndex={-1}
            lang={titleLang}
            // The whole title as a tooltip only when it is cut (review M8).
            onPointerEnter={(event) => {
              const element = event.currentTarget;
              if (element.scrollWidth > element.clientWidth) element.title = title;
              else element.removeAttribute("title");
            }}
            className="min-w-0 text-lg font-semibold break-words @split:truncate"
          >
            {title}
          </h1>
          {chip}
          {afterTitle ? <div className="flex min-w-0 shrink-0 items-center">{afterTitle}</div> : null}
        </div>
        {meta ? <p className="min-w-0 text-xs text-fg-muted @split:truncate">{meta}</p> : null}
      </div>
      {status || actions ? (
        <div className="flex flex-wrap items-center gap-1.5 @split:shrink-0 @split:flex-nowrap">
          {status}
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * The step header (owner's proposal §3.2): eyebrow, title, one state chip, and at most two
 * actions, the primary one last. Anything else (version details, the model, the cost, the
 * history) goes into a menu (`afterChip`) or the rail. The case's name is not repeated: it
 * is in the sidebar. One row of 64 px that never changes height from --container-split up.
 * Props in docs/interface.md, "Shared pieces".
 */
export function StepHeader({
  eyebrow,
  title,
  titleLang,
  chip,
  afterChip,
  status,
  secondary,
  primary,
}: {
  eyebrow: ReactNode;
  title: string;
  titleLang?: string;
  chip?: ReactNode;
  afterChip?: ReactNode;
  status?: ReactNode;
  /** The secondary action (a Button or ButtonLink), shown first. */
  secondary?: ReactNode;
  /** The primary action, shown last. */
  primary?: ReactNode;
}) {
  const actions =
    secondary || primary ? (
      <>
        {secondary}
        {primary}
      </>
    ) : undefined;
  return <PageHeader eyebrow={eyebrow} title={title} titleLang={titleLang} chip={chip} afterTitle={afterChip} status={status} actions={actions} />;
}
