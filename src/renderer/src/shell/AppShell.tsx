import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose } from "../components/Dialog.tsx";
import { Eyebrow } from "./WorkArea.tsx";

/*
 * The frame of every screen: the dark sidebar on the left and the working area (each
 * screen's header, content and right rail) on the right. Below 48rem the sidebar leaves
 * the screen: a dark bar with a Menu button takes its place and opens it as a panel.
 * Each part scrolls on its own.
 */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <SkipLink />
      <div data-surface="nav" className="hidden w-sidebar shrink-0 bg-nav text-fg-on-nav md:block">
        {sidebar}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <NarrowBar sidebar={sidebar} />
        <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">{children ?? <Outlet />}</div>
      </div>
      <RouteAnnouncer />
    </div>
  );
}

/** The first thing the keyboard reaches: jumps past the sidebar to the screen's content. */
function SkipLink() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => document.getElementById("content")?.focus()}
      className="fixed top-2 left-2 z-20 -translate-y-24 rounded-md bg-surface px-3 py-2 font-medium text-fg shadow-popup focus:translate-y-0"
    >
      {t("app.skipToContent")}
    </button>
  );
}

/** The md breakpoint (tokens: Tailwind's default 48rem), where the sidebar comes back. */
const WIDE = "(min-width: 48rem)";

function NarrowBar({ sidebar }: { sidebar: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Widening the window brings the sidebar back, so the panel closes.
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const close = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  return (
    <div data-surface="nav" className="flex items-center justify-between gap-3 bg-nav px-3.5 py-1 text-fg-on-nav md:hidden">
      <Eyebrow as="p" className="text-xs text-fg-on-nav-muted">
        {t("app.name")}
      </Eyebrow>
      <Dialog
        variant="sheet"
        open={open}
        onOpenChange={setOpen}
        title={t("nav.menuTitle")}
        titleHidden
        trigger={<Button variant="nav">{t("nav.menu")}</Button>}
        popupClassName="bg-nav text-fg-on-nav"
      >
        <div
          data-surface="nav"
          className="flex min-h-0 flex-1 flex-col"
          // Following a link closes the panel.
          onClickCapture={(event) => {
            if ((event.target as Element).closest("a")) setOpen(false);
          }}
        >
          <div className="flex justify-end px-3.5 pt-2">
            <DialogClose render={<Button variant="nav" size="sm" />}>{t("nav.closeMenu")}</DialogClose>
          </div>
          {sidebar}
        </div>
      </Dialog>
    </div>
  );
}

/** Tells a screen reader which screen it is on after each navigation (the window title). */
function RouteAnnouncer() {
  const location = useLocation();
  const region = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After the new screen's header has set the title.
    const timer = setTimeout(() => {
      if (region.current) region.current.textContent = document.title;
    }, 100);
    return () => clearTimeout(timer);
  }, [location.pathname]);
  return <p ref={region} aria-live="polite" className="sr-only" />;
}
