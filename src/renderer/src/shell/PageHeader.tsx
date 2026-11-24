import { useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { titleWhenCut } from "../components/truncate.ts";
import { WorkAreaContext, type WorkAreaState } from "./WorkArea.tsx";

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
 * It stays outside the scrolling content, and is one row of fixed height (--spacing-header,
 * 64 px) that never wraps (owner's decision T1, layout rule 3): the title and the detail line
 * shorten with an ellipsis (the whole title is its tooltip once cut), and the actions keep
 * their place. So a button never moves when a title is long or the screen is in Spanish.
 * From a 1024 px window the chip and what follows it (a version menu) sit after the title.
 * Below that (owner's decision T2) they move to the top of the content, and the rail's button
 * ("Revisión 2") joins the actions (WorkArea). Where the actions cannot fit beside the title
 * there they drop below it rather than leave the window: on a window under about 700 px, and
 * on the case map, whose actions carry a sentence under them.
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
  const { narrow, extrasSlot, rail } = useContext(WorkAreaContext);
  const windowTitle = t("app.pageTitle", { page: title });
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);
  const extras =
    chip || afterTitle ? (
      <>
        {chip}
        {afterTitle ? <div className="flex min-w-0 shrink-0 items-center">{afterTitle}</div> : null}
      </>
    ) : null;
  const moved = narrow && extrasSlot !== null;
  const toggle = narrow && rail ? <RailButton {...rail} /> : null;
  return (
    <header
      data-region="header"
      className={cn(
        "flex shrink-0 items-center justify-between gap-x-4 border-b border-border bg-surface px-5",
        narrow ? "min-h-header flex-wrap gap-y-2 py-2" : "h-header flex-nowrap py-1.5",
      )}
    >
      <div className={cn("flex flex-col justify-center gap-0.5", narrow ? "min-w-32 flex-1" : "min-w-0 flex-1")}>
        {eyebrow ? (
          <p data-testid="header-eyebrow" className="min-w-0 truncate text-2xs font-semibold tracking-eyebrow text-fg-muted uppercase">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-nowrap items-center gap-x-3">
          <h1
            id="page-title"
            tabIndex={-1}
            lang={titleLang}
            // The whole title as a tooltip only when it is cut (review M8).
            onPointerEnter={(event) => titleWhenCut(event.currentTarget, title)}
            onFocus={(event) => titleWhenCut(event.currentTarget, title)}
            className="min-w-0 truncate text-lg font-semibold"
          >
            {title}
          </h1>
          {extras && !moved ? extras : null}
        </div>
        {meta ? <p className="min-w-0 truncate text-xs text-fg-muted">{meta}</p> : null}
      </div>
      {extras && moved ? createPortal(extras, extrasSlot) : null}
      {status || actions || toggle ? (
        <div className={cn("flex shrink-0 items-center gap-1.5", narrow ? "flex-wrap" : "flex-nowrap")}>
          {status}
          {toggle}
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * On a narrow window, the button that opens the rail as a panel (owner's decision T2): the
 * rail's name and, when the screen counts something there, the count ("Revisión 2").
 */
function RailButton({ id, label, count, open, toggle, setToggle }: NonNullable<WorkAreaState["rail"]>) {
  const { t } = useTranslation();
  return (
    <Button ref={setToggle} data-testid="rail-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
      <Icon name="panel" />
      {label}
      {count ? (
        <>
          <span aria-hidden="true" className="rounded-sm bg-warning-subtle px-1.5 font-mono text-sm font-semibold text-warning tabular-nums">
            {count}
          </span>
          <span className="sr-only">, {t("rail.count", { count })}</span>
        </>
      ) : null}
    </Button>
  );
}

/**
 * The step header (owner's proposal §3.2): eyebrow, title, one state chip, and at most two
 * actions, the primary one last. Anything else (version details, the model, the cost, the
 * history) goes into a menu (`afterChip`) or the rail. The case's name is not repeated: it
 * is in the sidebar. One row of 64 px that never changes height.
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
