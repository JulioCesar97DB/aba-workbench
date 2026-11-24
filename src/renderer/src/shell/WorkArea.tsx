import { createContext, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { RAIL_BREAKPOINT } from "../../../shared/theme.ts";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";

/*
 * A screen: its header (title, detail, actions), its content and, when given, the right
 * rail, all inside <main id="content">, so the skip link and a screen reader's "main"
 * landmark start at the screen's title.
 *
 * The header never scrolls. Below it, the content and the rail each scroll on their own
 * (owner's decision T1, layout rule "one scroll area per region"): reading a long section
 * moves only its text, while the header and the rail stay where they are. A `footer` is
 * docked under the content (a section's request box) at every width.
 *
 * From a window 1024 px wide (RAIL_BREAKPOINT: the sidebar plus --container-split) the rail
 * sits beside the content. Below it (owner's decision T2) the rail is a panel over the right
 * side of the content, opened by a button in the header that carries the rail's name and,
 * when the screen gives one, a count ("Revisión 2": the open checks of a section). The panel
 * is not modal: Escape, a press outside it or the focus leaving it close it, and so do a
 * navigation and a wider window. It is the same element at every width, so what it holds
 * (her instructions as she types them) is never mounted twice. Below 1024 px the header's
 * chip and version menu move to the top of the content, so the header keeps one row
 * (PageHeader).
 *
 * `contentClassName` shapes the content (a maximum width, say), not its scroll area, whose
 * scroll bar stays at the pane's edge.
 */
export function WorkArea({
  header,
  children,
  rail,
  railLabel,
  railCount,
  footer,
  contentClassName,
}: {
  header: ReactNode;
  children: ReactNode;
  rail?: ReactNode;
  /** The rail's name: its landmark's label and, on a narrow window, the button that opens it. "Detalles" when not given. */
  railLabel?: string;
  /** A count for the rail's button on a narrow window (a section's open checks); none or 0 shows only the name. */
  railCount?: number | null;
  /** Docked at the foot of the content pane, outside its scroll (layout rule 3): a section's request box. */
  footer?: ReactNode;
  contentClassName?: string;
}) {
  const { t } = useTranslation();
  const narrow = useNarrowWindow();
  const railId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [extrasSlot, setExtrasSlot] = useState<HTMLDivElement | null>(null);
  const label = railLabel ?? t("rail.label");

  // Adjusted while rendering (React's pattern for state that follows other state): a wider
  // window shows the rail beside the content, and a navigation starts with the panel closed.
  const { pathname } = useLocation();
  const [openedAt, setOpenedAt] = useState(pathname);
  if (open && (!narrow || openedAt !== pathname)) setOpen(false);
  if (openedAt !== pathname) setOpenedAt(pathname);

  const setToggle = useCallback((element: HTMLButtonElement | null) => {
    toggleRef.current = element;
  }, []);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // Opened: the focus goes into the panel, so the keyboard and a screen reader are in it.
  const panelOpen = narrow && open && rail !== undefined;
  useEffect(() => {
    if (panelOpen) asideRef.current?.focus();
  }, [panelOpen]);

  // A press outside the panel (and outside its button) closes it, and still reaches what was pressed.
  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || asideRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panelOpen]);

  const context = useMemo<WorkAreaState>(
    () => ({
      narrow,
      extrasSlot,
      rail:
        rail === undefined
          ? null
          : { id: railId, label, count: railCount ?? null, open: panelOpen, toggle: () => setOpen((value) => !value), setToggle },
    }),
    [narrow, extrasSlot, rail, railId, label, railCount, panelOpen, setToggle],
  );

  return (
    <WorkAreaContext value={context}>
      <main id="content" className="flex min-h-0 flex-1 flex-col">
        {header}
        <div
          data-region="body"
          className={cn(
            "relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden",
            rail !== undefined && !narrow ? "grid-cols-[minmax(0,1fr)_var(--spacing-rail)] @split-wide:grid-cols-[minmax(0,1fr)_var(--spacing-rail-wide)]" : "grid-cols-[minmax(0,1fr)]",
          )}
        >
          <div data-region="content" className="col-start-1 row-start-1 min-h-0 min-w-0 overflow-y-auto">
            <div className={cn("px-6 py-5", contentClassName)}>
              {/* On a narrow window, the header's chip and version menu (PageHeader puts them here). */}
              <div ref={setExtrasSlot} data-region="header-extras" className="mb-4 flex shrink-0 flex-wrap items-center gap-2 empty:hidden" />
              {children}
            </div>
          </div>
          {footer ? (
            <div data-region="footer" className="col-start-1 row-start-2 min-w-0 border-t border-border bg-surface px-6 py-3">
              {footer}
            </div>
          ) : null}
          {rail !== undefined ? (
            <aside
              ref={asideRef}
              id={railId}
              aria-label={label}
              data-region="rail"
              data-panel={narrow ? (panelOpen ? "open" : "closed") : undefined}
              tabIndex={panelOpen ? -1 : undefined}
              onKeyDown={(event) => {
                if (panelOpen && event.key === "Escape") {
                  event.stopPropagation();
                  close(true);
                }
              }}
              onBlur={(event) => {
                // The focus leaving the panel (Tab past its end, a link to a paragraph) closes it.
                const next = event.relatedTarget as Node | null;
                if (panelOpen && next && !event.currentTarget.contains(next) && !toggleRef.current?.contains(next)) setOpen(false);
              }}
              className={cn(
                "flex min-h-0 flex-col gap-5 overflow-y-auto bg-surface-muted px-4.5 py-4 outline-none",
                !narrow && "col-start-2 row-[1/span_2] border-l border-border",
                narrow && !panelOpen && "hidden",
                narrow && panelOpen && "absolute inset-y-0 right-0 z-10 w-[min(22rem,calc(100%-3rem))] border-l border-border shadow-popup",
              )}
            >
              {panelOpen ? (
                <div className="-mb-2 flex justify-end">
                  <Button size="sm" data-testid="rail-close" onClick={() => close(true)}>
                    {t("rail.close")}
                  </Button>
                </div>
              ) : null}
              {rail}
            </aside>
          ) : null}
        </div>
      </main>
    </WorkAreaContext>
  );
}

/** What a screen's header needs from its WorkArea on a narrow window. */
export interface WorkAreaState {
  /** The window is narrower than RAIL_BREAKPOINT: the rail is a panel, and the header gives its chip and menu to the content. */
  narrow: boolean;
  /** Where the header's chip and version menu go on a narrow window. */
  extrasSlot: HTMLElement | null;
  /** The rail's panel, when the screen has a rail. */
  rail: { id: string; label: string; count: number | null; open: boolean; toggle: () => void; setToggle: (element: HTMLButtonElement | null) => void } | null;
}

export const WorkAreaContext = createContext<WorkAreaState>({ narrow: false, extrasSlot: null, rail: null });

const RAIL_QUERY = `(min-width: ${RAIL_BREAKPOINT})`;

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(RAIL_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window is narrower than RAIL_BREAKPOINT (1024 px): the rail is a panel there. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !window.matchMedia(RAIL_QUERY).matches,
    () => false,
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
