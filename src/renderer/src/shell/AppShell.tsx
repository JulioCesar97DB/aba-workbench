import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useOnSectionSaved } from "../section-generation.tsx";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useMatch } from "react-router";
import { SIDEBAR_BREAKPOINT } from "../../../shared/theme.ts";
import { formatAge } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { OpenCaseContext, PatchOpenedCaseContext, SetCaseSourcesContext, useCaseLoader } from "../open-case.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose } from "../components/Dialog.tsx";
import { AppSidebar, CaseSidebar } from "./Sidebar.tsx";
import { TrialBar } from "./TrialBar.tsx";
import { isNotesOf, NotesPanel, OpenNotesContext, type NotesControl } from "./NotesPanel.tsx";
import { useFailedSaveList } from "../case-saves.tsx";
import { Eyebrow } from "./WorkArea.tsx";

/*
 * The frame of every screen, rendered once for the whole app: the dark sidebar on the
 * left and the working area (each screen's header, content and right rail) on the right.
 * Inside a case the sidebar shows the case; elsewhere, the app's screens. Below
 * --breakpoint-sidebar the sidebar leaves the screen: a dark bar with a Menu button takes
 * its place and opens it as a panel. Above the working area, one slim line says the app is
 * not ready for real client data. Nothing here scrolls: each screen's WorkArea scrolls its
 * own content and rail, and the sidebar its own list.
 */
export function AppShell() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const inCase = useMatch("/cases/:caseId/*");
  const { state: openCase, setSources, patch } = useCaseLoader(inCase?.params.caseId);
  // A version the AI saved changes the section's state in the sidebar, wherever she is.
  useOnSectionSaved(useCallback((caseId, result) => patch(caseId, { sections: result.sections }), [patch]));
  // Today's notes: one panel for the open case, opened from the sidebar (review round 1, S1).
  // Open for the case it was opened in only, so another case never opens with it open.
  const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null);
  const openedId = openCase?.outcome === "opened" ? openCase.case.id : null;
  const notesId = useId();
  // What had the focus when the notes opened: it gets it back when they close (UX-1 follow-up m3).
  const notesOpener = useRef<HTMLElement | null>(null);
  const openNotes = useCallback(() => {
    notesOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotesOpenFor(openedId);
  }, [openedId]);
  const notesControl = useMemo<NotesControl>(() => ({ open: openNotes, isOpen: openedId !== null && notesOpenFor === openedId, panelId: notesId }), [openNotes, openedId, notesOpenFor, notesId]);
  const sidebar =
    openCase?.outcome === "opened" ? (
      <CaseSidebar
        caseId={openCase.case.id}
        caseName={openCase.case.label}
        sections={openCase.case.sections}
        notes={openCase.case.notes}
        caseMap={openCase.case.caseMap}
        plan={openCase.case.plan}
        sourceCount={openCase.case.sources.sources.filter((source) => !source.removedAt).length}
        caseDetail={formatAge(t, language, openCase.case.clientAge) ?? t("case.ageNotGiven")}
      />
    ) : (
      <AppSidebar />
    );
  return (
    <OpenNotesContext value={notesControl}>
    <OpenCaseContext value={openCase}>
    <SetCaseSourcesContext value={setSources}>
    <PatchOpenedCaseContext value={patch}>
    <div className="flex h-dvh overflow-hidden">
      <SkipLink />
      <div data-surface="nav" className="hidden w-sidebar shrink-0 bg-nav text-fg-on-nav sidebar:block">
        {sidebar}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <NarrowBar sidebar={sidebar} caseId={openedId} />
        <TrialBar />
        <div className="@container flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
      {openCase?.outcome === "opened" ? (
        <NotesPanel
          key={openCase.case.id}
          caseId={openCase.case.id}
          notes={openCase.case.notes}
          open={notesOpenFor === openCase.case.id}
          onOpenChange={(next) => setNotesOpenFor(next ? openCase.case.id : null)}
          id={notesId}
          opener={notesOpener}
        />
      ) : null}
      <RouteAnnouncer />
    </div>
    </PatchOpenedCaseContext>
    </SetCaseSourcesContext>
    </OpenCaseContext>
    </OpenNotesContext>
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

/**
 * Below --breakpoint-sidebar: the app's name and the Menu button, which opens the sidebar as
 * a panel. Inside a case, today's notes that could not be saved are said here too, where the
 * sidebar's notes button is out of view, and pressing it opens them (UX-1 follow-up m1).
 */
function NarrowBar({ sidebar, caseId }: { sidebar: ReactNode; caseId: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const notes = useContext(OpenNotesContext);
  const failedSaves = useFailedSaveList();
  const notesUnsaved = caseId !== null && failedSaves.some(isNotesOf(caseId));
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
      {notesUnsaved ? (
        <button
          type="button"
          data-testid="notes-unsaved-bar"
          aria-haspopup="dialog"
          aria-expanded={notes?.isOpen ?? false}
          aria-controls={notes?.panelId}
          onClick={() => notes?.open()}
          className="ml-auto min-h-control-sm rounded-md px-2 text-xs font-semibold text-fg-on-nav-warning underline underline-offset-2 hover:bg-nav-hover"
        >
          {t("section.notesUnsavedBar")}
        </button>
      ) : null}
      <Dialog
        variant="sheet"
        open={open}
        onOpenChange={setOpen}
        title={t("nav.menuTitle")}
        titleHidden
        trigger={
          <Button variant="nav" data-menu-button="">
            {t("nav.menu")}
          </Button>
        }
        popupClassName="bg-nav text-fg-on-nav"
      >
        <div
          data-surface="nav"
          className="flex min-h-0 flex-1 flex-col"
          // Following a link closes the panel, and so does opening today's notes.
          onClickCapture={(event) => {
            if ((event.target as Element).closest("a, [data-closes-menu]")) setOpen(false);
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
