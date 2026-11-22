import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useMatch } from "react-router";
import { SIDEBAR_BREAKPOINT } from "../../../shared/theme.ts";
import { formatAge } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { OpenCaseContext, SetCaseSourcesContext, useCaseLoader } from "../open-case.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose } from "../components/Dialog.tsx";
import { AppSidebar, CaseSidebar } from "./Sidebar.tsx";
import { Eyebrow } from "./WorkArea.tsx";

/*
 * The frame of every screen, rendered once for the whole app: the dark sidebar on the
 * left and the working area (each screen's header, content and right rail) on the right.
 * Inside a case the sidebar shows the case; elsewhere, the app's screens. Below
 * --breakpoint-sidebar the sidebar leaves the screen: a dark bar with a Menu button takes
 * its place and opens it as a panel. Each part scrolls on its own.
 */
export function AppShell() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const inCase = useMatch("/cases/:caseId/*");
  const { state: openCase, setSources } = useCaseLoader(inCase?.params.caseId);
  const sidebar =
    openCase?.outcome === "opened" ? (
      <CaseSidebar
        caseId={openCase.case.id}
        caseName={openCase.case.label}
        caseDetail={formatAge(t, language, openCase.case.clientAge) ?? t("case.ageNotGiven")}
      />
    ) : (
      <AppSidebar />
    );
  return (
    <OpenCaseContext value={openCase}>
    <SetCaseSourcesContext value={setSources}>
    <div className="flex h-dvh overflow-hidden">
      <SkipLink />
      <div data-surface="nav" className="hidden w-sidebar shrink-0 bg-nav text-fg-on-nav sidebar:block">
        {sidebar}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <NarrowBar sidebar={sidebar} />
        <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </div>
      </div>
      <RouteAnnouncer />
    </div>
    </SetCaseSourcesContext>
    </OpenCaseContext>
  );
}

/** The screen's title: where the skip link and a navigation that loses focus land. */
function focusPageTitle() {
  document.getElementById("page-title")?.focus();
}

/** The first thing the keyboard reaches: jumps past the sidebar to the screen's title. */
function SkipLink() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={focusPageTitle}
      className="fixed top-2 left-2 z-20 -translate-y-24 rounded-md bg-surface px-3 py-2 font-medium text-fg shadow-popup focus:translate-y-0"
    >
      {t("app.skipToContent")}
    </button>
  );
}

function NarrowBar({ sidebar }: { sidebar: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Widening the window brings the sidebar back, so the panel closes.
  useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${SIDEBAR_BREAKPOINT})`);
    const close = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  return (
    <div data-surface="nav" className="flex items-center justify-between gap-3 bg-nav px-3.5 py-1 text-fg-on-nav sidebar:hidden">
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

/**
 * After each navigation: tells a screen reader which screen it is on (the window title),
 * and when the link that was followed is gone (moving into or out of a case changes the
 * sidebar), puts focus on the new screen's title rather than leaving it nowhere.
 */
function RouteAnnouncer() {
  const location = useLocation();
  const region = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After the new screen's header has set the title, and after any panel has closed.
    const timer = setTimeout(() => {
      if (region.current) region.current.textContent = document.title;
      const focused = document.activeElement;
      if (!focused || focused === document.body || !focused.isConnected) focusPageTitle();
    }, 100);
    return () => clearTimeout(timer);
  }, [location.pathname]);
  return <p ref={region} aria-live="polite" className="sr-only" />;
}
