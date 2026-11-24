import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router";
import type { DraftingProvider } from "../../../shared/api.ts";
import { modelLabel } from "../../../shared/models.ts";
import { findReportSection, REPORT_SECTIONS, type ReportSection } from "../../../shared/report-sections.ts";
import { checkStructure, countWords, findMarkers, hasLinesInParagraphs, linesAsParagraphs, MAX_REQUEST_LENGTH, splitParagraphs, type StructureIssue } from "../../../shared/section-text.ts";
import { isOlderRevision, type SectionDetail, type SectionRequestInput, type SectionSummary, type SectionVersion } from "../../../shared/sections.ts";
import type { FailedSave } from "../../../shared/sources.ts";
import { aiErrorCanRetry, aiErrorKind, aiErrorNeedsSettings } from "../ai-errors.ts";
import { useAutosave, useKeptText, type AutosaveStatus } from "../autosave.tsx";
import { onRetried, retry, useFailedSavesLoaded, useSectionFailures } from "../case-saves.tsx";
import { casePath, caseSummaryPath } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { NextStepCard } from "../components/NextStepCard.tsx";
import { Select } from "../components/Select.tsx";
import { StateChip } from "../components/StateChip.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { PROVIDER_NAMES, useProviders } from "../drafting-provider.tsx";
import { formatShortDate, formatTime, relativeDay } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { useOpenedCase, usePatchOpenedCase, useSetCaseSources } from "../open-case.tsx";
import {
  dismissSectionGeneration,
  isRunning,
  retrySectionGeneration,
  startSectionCheck,
  startSectionGeneration,
  stopSectionGeneration,
  useOnSectionSaved,
  useSectionGeneration,
  type SectionGeneration,
} from "../section-generation.tsx";
import { canImproveFromEditor, changedParagraphs, copiedLead, improveFromEditorVersion, isAiVersion, isCorrection, nextSection, nextStep, paragraphBeingWritten, versionChip } from "../section-view.ts";
import { sourceName, sourceNameLang } from "../source-labels.tsx";
import { Mono, StepHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

/*
 * One section of the report (#/cases/<id>/report/<section id>), as in the owner's proposal
 * §4 "4 · Informe" and its mockups 07, 08 and 09:
 *
 * - not started: the two ways, "A mano" (paste or type what she already wrote) and "Con la
 *   IA" (draft it), as two cards (TwoWays);
 * - the AI writing: an amber band, the text streaming with its paragraph numbers, the
 *   request box waiting at the foot, Stop in the header;
 * - written by hand: the two-ways bar, an editor that fills the pane and is its only scroll
 *   (T16), "Listo" in the header, "Mejorarla con la IA" at the foot;
 * - a version to review: the version menu (T3), one muted line on what this version is,
 *   numbered paragraphs (click one to change only it), the request box docked at the foot,
 *   Approve then Copy (P2).
 *
 * The rail: "Antes de aprobar", her instructions for the section, what the version used,
 * which AI writes; "Siguiente paso" first once the section is approved (§3.3).
 * Nothing is lost: every change is a new version (src/main/case-sections.ts).
 */

type Mode = "choose" | "paste" | "view" | "edit";

export function SectionScreen() {
  const opened = useOpenedCase();
  const { sectionId } = useParams();
  const section = findReportSection(sectionId);
  if (!section) return <Navigate to={casePath(opened.id, "report")} replace />;
  return <SectionLoader key={`${opened.id}/${section.id}`} caseId={opened.id} section={section} />;
}

function useEyebrow(section: ReportSection): string {
  const { t } = useTranslation();
  return t("section.eyebrow", { number: REPORT_SECTIONS.indexOf(section) + 1, total: REPORT_SECTIONS.length });
}

function SectionLoader({ caseId, section }: { caseId: string; section: ReportSection }) {
  const { t } = useTranslation();
  const eyebrow = useEyebrow(section);
  const [detail, setDetail] = useState<SectionDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    window.aba.getSection(caseId, section.id).then(
      (result) => {
        if (!live) return;
        if (result.outcome === "read") setDetail(result.section);
        else setFailed(true);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [caseId, section.id]);
  if (failed || !detail) {
    return (
      <WorkArea header={<StepHeader eyebrow={eyebrow} title={section.title} titleLang="en" />}>
        {failed ? (
          <p role="alert" className="text-md text-danger">
            {t("section.loadFailed")}
          </p>
        ) : (
          <span />
        )}
      </WorkArea>
    );
  }
  return <SectionWorkspace caseId={caseId} section={section} initial={detail} />;
}

type Providers = ReturnType<typeof useProviders>;

/** Marks where a value goes in a translated sentence, so the value can be a React node. */
const SLOT = "\u0000";

/** A translated sentence with one React node in place of its placeholder. */
function withSlot(sentence: string, node: ReactNode): ReactNode {
  const [before, after] = sentence.split(SLOT);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

/** What the editor tells the screen: its save state, the version this editing pass writes to, and how to save what is waiting. */
interface EditorState {
  status: AutosaveStatus;
  saved: number | null;
  /** What the box holds now. */
  text: string;
}

interface Copied {
  number: number;
  text: string;
}

function SectionWorkspace({ caseId, section, initial }: { caseId: string; section: ReportSection; initial: SectionDetail }) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const patch = usePatchOpenedCase();
  const eyebrow = useEyebrow(section);
  const [detail, setDetail] = useState(initial);
  const generation = useSectionGeneration(caseId, section.id);
  const running = isRunning(generation);
  // While the AI only checks the new version against her sections, she can already read, compare, approve and copy.
  const writing = running && generation?.phase !== "checking";
  const [mode, setMode] = useState<Mode>(initial.versions.length === 0 ? "choose" : "view");
  const [viewed, setViewed] = useState<number | null>(initial.currentVersion);
  const [actionFailed, setActionFailed] = useState(false);
  const [copied, setCopied] = useState<Copied | "failed" | null>(null);
  /** Whether the live region says what the last copy did: emptied while a copy runs, so the same sentence is announced again. */
  const [copyAnnounced, setCopyAnnounced] = useState(false);
  const failures = useSectionFailures(caseId);
  // Her text for this section that could not be saved: after a reload it goes back in the editor it came from (review round 2, B3).
  // The newest of them (the list is oldest first): never an older text over a newer one (review round 3, R3-1).
  const keptText = failures.filter((item) => item.about === "section" && item.sectionId === section.id && item.text !== null).at(-1) ?? null;
  const [keptOpen, setKeptOpen] = useState<FailedSave | null>(null);
  const setSources = useSetCaseSources();
  const providers = useProviders();
  /** The version this editing pass wrote (her pasted text, or her edit), once saved. */
  const editingSaved = useRef<number | null>(null);
  /** The version the editor opened on ("Editar a mano"); none when she pastes a new text. */
  const [editOpened, setEditOpened] = useState<SectionVersion | null>(null);
  const [editor, setEditor] = useState<EditorState>({ status: "idle", saved: null, text: "" });
  /** What the editor holds now, for "Mejorarla con la IA" at the moment she presses it. */
  const editorText = useRef("");
  const onEditorState = useCallback((state: EditorState) => {
    editorText.current = state.text;
    setEditor(state);
  }, []);
  /** After a copy that finished the section, the focus goes to what is now the primary (review round 1, S3). */
  const focusAfterCopy = useRef(false);
  const editorFlush = useRef<() => Promise<boolean>>(async () => true);
  /** The version whose changed paragraphs are marked ("ver qué cambió"); another version shown starts with none. */
  const [changesFor, setChangesFor] = useState<number | null>(null);

  /*
   * Every answer from the main process is a whole snapshot of the section. Answers can come
   * back in another order than the changes were saved (a slow or busy disk), so a snapshot
   * older than the one shown (its revision, the case's save time) is dropped: it would
   * undo a newer change on screen, such as an approval she just made or a version just saved.
   * (The revision is the case's save time, which each save makes later than the last; a
   * case file replaced by an older copy while the clock is behind would hold the screen on
   * what it shows until the section is opened again. Nothing on disk is affected.)
   */
  const shownRevision = useRef(initial.revision);
  /** The snapshot shown: the newest taken. */
  const shown = useRef(initial);
  const take = useCallback(
    (next: SectionDetail, sections?: SectionSummary[]): boolean => {
      if (isOlderRevision(next.revision, shownRevision.current)) return false;
      shownRevision.current = next.revision;
      shown.current = next;
      setDetail(next);
      if (sections) patch(caseId, { sections });
      return true;
    },
    [caseId, patch],
  );

  /**
   * The answer to what she just did (her newest action, her text, Try again): the version
   * it holds as current is shown. When a newer snapshot is shown already (a check saved
   * after her change, and its news came first), that one is kept, and its current version
   * shown: it already holds her change, so what she just did is never hidden.
   */
  const accept = useCallback(
    (next: SectionDetail, sections?: SectionSummary[]) => {
      const newest = take(next, sections) ? next : shown.current;
      setViewed(newest.currentVersion);
      // A version saved from elsewhere (Try again after a reload) shows the text instead of the two ways to start.
      setMode((current) => (current === "choose" && newest.versions.length > 0 ? "view" : current));
    },
    [take],
  );

  useOnSectionSaved(
    useCallback(
      (savedCase: string, result, kind) => {
        if (savedCase !== caseId || result.section.id !== section.id) return;
        if (!take(result.section)) return;
        // A check only adds its result: she stays on the version and the mode she is in.
        if (kind === "check") return;
        setViewed(result.section.currentVersion);
        setMode("view");
      },
      [caseId, section.id, take],
    ),
  );

  // Adjusted while rendering (React's pattern for state that follows other state), once per kept text.
  if (keptText && keptOpen?.id !== keptText.id && mode !== "paste" && mode !== "edit") {
    setKeptOpen(keptText);
    setEditOpened(detail.versions.find((version) => version.number === detail.currentVersion) ?? null);
    setMode(detail.versions.length === 0 ? "paste" : "edit");
  }

  const current = detail.versions.find((version) => version.number === viewed) ?? detail.versions.at(-1) ?? null;
  const nextNumber = detail.versions.reduce((max, v) => Math.max(max, v.number), 0) + 1;

  async function run(request: SectionRequestInput) {
    if (!providers.provider) return;
    setCopied(null);
    dismissSectionGeneration(caseId, section.id);
    setMode("view");
    await startSectionGeneration(caseId, section.id, providers.provider, request);
  }

  /** How many actions (approve, show a version, lines as paragraphs) she has started here. */
  const actionsStarted = useRef(0);

  async function act(work: () => Promise<{ outcome: string } & Partial<{ section: SectionDetail; sections: SectionSummary[] }>>) {
    const action = ++actionsStarted.current;
    setActionFailed(false);
    const result = await work().catch(() => null);
    if (result?.outcome !== "saved" || !result.section) {
      setActionFailed(true);
      return;
    }
    // Only the newest action's answer moves the version shown: Approve, then version 1 at
    // once, must not jump back to version 2 when the approval's answer comes back last (and
    // Copy then copy version 2). An older action's answer only updates the data, and only
    // when no newer snapshot is shown already (take).
    if (action === actionsStarted.current) accept(result.section, result.sections);
    else take(result.section, result.sections);
  }

  /** Approve a version, or take the approval away (null). A copy made before says something no longer true: its line goes. */
  async function approve(version: number | null) {
    setCopied(null);
    await act(() => window.aba.approveSection(caseId, section.id, version));
  }

  async function show(version: number) {
    setViewed(version);
    setCopied(null);
    await act(() => window.aba.setCurrentVersion(caseId, section.id, version));
  }

  // Read the section again when "Try again" saved what she had typed in it (review B3).
  useEffect(
    () =>
      onRetried((item) => {
        if (item.caseId !== caseId) return;
        if (item.about === "notes" || item.about === "map") return;
        void window.aba.getSection(caseId, section.id).then((result) => {
          if (result.outcome === "read") accept(result.section);
        });
      }),
    [caseId, section.id, accept],
  );

  async function copy() {
    if (!current) return;
    const version = current;
    // The copy button unmounts when this copy finishes the section (approved, not copied yet): "Copiar otra vez" replaces it.
    const finishes = detail.approvedVersion === version.number && !sectionDone;
    // The live region is emptied first, so the same sentence after "Copiar otra vez" is announced again (review round 1,
    // S2). The visible line and the header stay as they are meanwhile.
    setCopyAnnounced(false);
    const result = await window.aba.copySection(caseId, section.id, version.number).catch(() => null);
    // The line names where to paste it, what is still marked, and whether this is the approved version (P2).
    const done = result?.outcome === "copied";
    focusAfterCopy.current = done && finishes;
    setCopied(done ? { number: version.number, text: version.text } : "failed");
    setCopyAnnounced(true);
  }

  // The approved version copied for the first time: the copy button it was in becomes "Copiar otra vez" in another
  // place, so the focus moves to "Siguiente paso", the screen's primary now (review round 1, S3).
  useEffect(() => {
    if (!focusAfterCopy.current || copied === null) return;
    focusAfterCopy.current = false;
    const target = document.querySelector<HTMLElement>("[data-testid='next-step'] a") ?? document.querySelector<HTMLElement>("[data-testid='copy-again']");
    target?.focus();
  }, [copied]);

  /** "Editar a mano" or "Pegar o escribir": a new editing pass, on the version shown or on a new text. */
  function startEditing(next: "paste" | "edit") {
    editingSaved.current = null;
    editorText.current = "";
    setEditOpened(next === "edit" ? current : null);
    setMode(next);
  }

  /** "Treat each line as a paragraph" (review M3): a new version, hers kept as she pasted it. */
  async function linesToParagraphs(text: string) {
    setMode("view");
    await act(() => window.aba.saveSectionText(caseId, section.id, linesAsParagraphs(text), null));
  }

  async function recheck(version: number) {
    if (!providers.provider) return;
    dismissSectionGeneration(caseId, section.id);
    await startSectionCheck(caseId, section.id, providers.provider, version);
  }

  /** "Listo": what she typed is saved, and she reads it as a version (or, with nothing typed, is back at the two ways). */
  async function doneEditing() {
    await editorFlush.current();
    if (mode === "paste") {
      setMode(editingSaved.current !== null ? "view" : "choose");
      return;
    }
    setKeptOpen((open) => (open && keptText?.id === open.id ? open : null));
    setMode("view");
  }

  /**
   * "Mejorarla con la IA" from the editor (review round 1, S1): what she has on screen at that
   * moment is saved as her text first, and that version is improved; hers stays as it is
   * beside the AI's. Never an earlier version, and never an AI text she has not touched.
   */
  async function improveFromEditor() {
    const from = await improveFromEditorVersion({
      onScreen: editorText.current,
      opened: mode === "edit" ? editOpened : null,
      flush: () => editorFlush.current(),
      passVersion: () => editingSaved.current,
    });
    if (from !== null) void run({ kind: "improve", fromVersion: from });
  }

  const display: Mode | "writing" = writing ? "writing" : detail.versions.length === 0 && mode !== "paste" ? "choose" : mode === "edit" && !current ? "choose" : mode;
  const approvedHere = current !== null && detail.approvedVersion === current.number;
  const changesShown = current !== null && changesFor === current.number;
  const copiedNumber = copied !== null && copied !== "failed" ? copied.number : null;
  const next = nextSection(opened.sections, section.id);
  const step = nextStep(opened.sections, section.id);
  // The section's minimum (approved, then copied) makes "Siguiente paso" the primary: one primary per screen (layout rule 9).
  const sectionDone = approvedHere && copiedNumber === current?.number;

  const chip: ReactNode =
    display === "writing" ? (
      <StateChip state="writing" />
    ) : display === "choose" ? (
      <StateChip state="not-started" />
    ) : display === "paste" ? (
      <StateChip state="hers" detail={t("section.chipEditing")} />
    ) : display === "edit" && current ? (
      <StateChip state={isAiVersion(current) || isCorrection(detail.versions, current) ? "corrected" : "hers"} detail={t("section.chipEditing")} />
    ) : current ? (
      <StateChip state={versionChip(detail, current, copiedNumber)} />
    ) : null;

  let secondary: ReactNode = null;
  let primary: ReactNode = null;
  if (display === "writing" && generation) {
    secondary = <StopButton generation={generation} />;
  } else if (display === "paste" || display === "edit") {
    primary = (
      <Button variant="primary" data-testid="section-done" onClick={() => void doneEditing()}>
        {t("section.doneEditing")}
      </Button>
    );
  } else if (display === "view" && current) {
    if (approvedHere && sectionDone) {
      // Copied: "Siguiente paso" in the rail is now the screen's one primary (layout rule 9).
      secondary = (
        <Button data-testid="copy-again" onClick={() => void copy()}>
          <Icon name="copy" />
          {t("section.copyAgain")}
        </Button>
      );
    } else if (approvedHere) {
      primary = (
        <Button variant="primary" onClick={() => void copy()}>
          <Icon name="copy" />
          {t("section.copy")}
        </Button>
      );
    } else {
      secondary = (
        <Button onClick={() => void copy()}>
          <Icon name="copy" />
          {t("section.copyShort")}
        </Button>
      );
      primary = (
        <Button variant="primary" onClick={() => void approve(current.number)}>
          <Icon name="check" />
          {t("section.approve")}
        </Button>
      );
    }
  }

  const header = (
    <StepHeader
      eyebrow={eyebrow}
      title={section.title}
      titleLang="en"
      chip={chip}
      afterChip={
        display === "view" && current ? (
          <VersionMenu
            detail={detail}
            current={current}
            onShow={(n) => void show(n)}
            onUnapprove={() => void approve(null)}
          />
        ) : null
      }
      status={display === "paste" || display === "edit" ? <SaveState status={editor.status} saved={editor.saved !== null} /> : null}
      secondary={secondary}
      primary={primary}
    />
  );

  const editorProps = {
    caseId,
    sectionId: section.id,
    keptId: keptOpen?.id ?? null,
    editing: keptOpen?.editing ?? null,
    onState: onEditorState,
    flushRef: editorFlush,
    onTreatLines: async (text: string, flush: () => Promise<boolean>) => {
      if (await flush()) await linesToParagraphs(text);
    },
  };

  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (display === "choose") {
    body = (
      <>
        {generation && !running ? <GenerationOutcomeMessage generation={generation} providers={providers} /> : null}
        <TwoWays
          layout="cards"
          aiConnected={providers.provider !== null || providers.loading}
          hand={{
            title: t("section.startHandTitle"),
            body: t("section.startHandBody"),
            actions: (
              <Button onClick={() => startEditing("paste")}>
                <Icon name="pencil" />
                {t("section.startHandAction")}
              </Button>
            ),
          }}
          ai={{
            title: t("section.startAiTitle"),
            body: t("section.startAiBody"),
            actions: (
              <Button variant="ai" disabled={providers.provider === null} onClick={() => void run({ kind: "draft" })}>
                <Icon name="sparkle" />
                {t("section.startAiAction")}
              </Button>
            ),
          }}
        />
      </>
    );
  } else if (display === "writing" && generation) {
    body = <WritingView generation={generation} base={current} />;
    footer = <WaitingComposer nextNumber={nextNumber} />;
  } else if (display === "paste" || (display === "edit" && current)) {
    const correcting = display === "edit" && current !== null && (isAiVersion(current) || isCorrection(detail.versions, current));
    body = (
      <>
        <TwoWays layout="bar" active="hand" hand={{ body: t("section.handBarBody") }} ai={{ body: t("section.handBarAi") }} />
        {display === "paste" ? (
          <OwnTextEditor
            {...editorProps}
            initialText={keptOpen?.text ?? ""}
            savedValue={keptOpen ? null : ""}
            onSaved={(next, sections) => {
              editingSaved.current = next.currentVersion;
              accept(next, sections);
            }}
          />
        ) : current ? (
          <OwnTextEditor
            {...editorProps}
            initialText={keptOpen?.text ?? current.text}
            savedValue={keptOpen ? null : current.text}
            onSaved={(next, sections) => {
              editingSaved.current = next.currentVersion;
              accept(next, sections);
            }}
          />
        ) : null}
      </>
    );
    footer = (
      <div className="flex max-w-list flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-fg-muted">{withSlot(t(correcting ? "section.composerDoneCorrected" : "section.composerDone", { done: SLOT }), <strong className="font-semibold text-fg">{t("section.doneEditing")}</strong>)}</p>
        {providers.provider === null && !providers.loading ? (
          <ConnectButton />
        ) : (
          <Button
            variant="ai"
            data-testid="improve-from-editor"
            disabled={providers.provider === null || !canImproveFromEditor(editor.text, display === "edit" ? editOpened : null)}
            onClick={() => void improveFromEditor()}
          >
            <Icon name="sparkle" />
            {t("section.improve")}
          </Button>
        )}
      </div>
    );
  } else if (display === "view" && current) {
    body = (
      <SectionText
        key={current.number}
        detail={detail}
        version={current}
        generation={generation}
        providers={providers}
        changesShown={changesShown}
        onRequest={(request) => void run(request)}
        onTreatLines={() => void linesToParagraphs(current.text)}
      />
    );
    footer = <Composer key={current.number} version={current} nextNumber={nextNumber} providers={providers} onRequest={(request) => void run(request)} onEdit={() => startEditing("edit")} />;
  }

  return (
    <WorkArea
      header={header}
      contentClassName="flex min-h-full flex-col"
      footer={footer}
      rail={
        <SectionRail
          caseId={caseId}
          section={section}
          detail={detail}
          display={display}
          current={display === "view" ? current : null}
          generation={generation}
          providers={providers}
          step={step}
          approved={display === "view" && approvedHere}
          done={display === "view" && sectionDone}
          onRecheck={(version) => void recheck(version)}
        />
      }
    >
      <div className="flex flex-1 flex-col gap-4">
        {/*
         * One live region, always there and empty until it has news, so a screen reader hears
         * what changes (review round 1, S2 and M4): the paragraph the AI is writing, and what a
         * copy did. The visible lines say the same.
         */}
        <p role="status" data-testid="section-announcer" className="sr-only">
          {display === "writing" && generation ? bandTitle(t, generation) : display === "view" && copyAnnounced && copied !== null ? copiedSentence(t, copied, section, detail.approvedVersion, next) : ""}
        </p>
        {failures.map((item) => (
          <div key={item.id} role="alert" className="flex max-w-reading flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-danger px-3.5 py-2 text-md font-medium text-danger">
            <span>{t(`section.failedSave.${item.about}`)}</span>
            <Button size="sm" onClick={() => retry(item, (sources) => setSources(caseId, sources))}>
              {t("sources.tryAgain")}
            </Button>
          </div>
        ))}
        {display === "view" && current ? (
          copied !== null ? (
            <CopiedLine copied={copied} section={section} approvedVersion={detail.approvedVersion} next={next} caseId={caseId} />
          ) : (
            <VersionLine detail={detail} version={current} changesShown={changesShown} onToggleChanges={() => setChangesFor(changesShown ? null : current.number)} />
          )
        ) : null}
        {display === "view" && current ? <ChecksSummary detail={detail} version={current} /> : null}
        {actionFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("section.actionFailed")}
          </p>
        ) : null}
        {body}
      </div>
    </WorkArea>
  );
}

/** Stop, the only action while the AI writes. It takes the focus when the box or paragraph that had it is gone (review, low 3). */
function StopButton({ generation }: { generation: SectionGeneration }) {
  const { t } = useTranslation();
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) stop.current?.focus();
  }, []);
  return (
    <Button ref={stop} onClick={() => stopSectionGeneration(generation)}>
      <Icon name="stop" />
      {t("section.stop")}
    </Button>
  );
}

/** "Conectar la IA": the AI's way out when no AI is connected (owner's decision P7). */
function ConnectButton() {
  const { t } = useTranslation();
  return (
    <ButtonLink to="/settings" variant="ai" data-testid="connect-ai">
      <Icon name="sparkle" />
      {t("twoWays.connect")}
    </ButtonLink>
  );
}

/** "Todo guardado" / "Guardando…", in the header, in a space as wide as the longer of the two so the button beside it never moves. */
function SaveState({ status, saved }: { status: AutosaveStatus; saved: boolean }) {
  const { t } = useTranslation();
  const text = status === "saving" ? t("sources.saving") : status === "saved" || (status === "idle" && saved) ? t("section.allSaved") : "";
  return (
    <span data-testid="section-save-state" className="mr-2 inline-grid text-right text-sm text-fg-muted">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {t("sources.saving")}
      </span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {t("section.allSaved")}
      </span>
      <span className="col-start-1 row-start-1">{text}</span>
    </span>
  );
}

/** "Versión 2 de 2 ▾": every version with who made it, what was asked and when; the cost only for a Claude key (T3, P6). */
function VersionMenu({ detail, current, onShow, onUnapprove }: { detail: SectionDetail; current: SectionVersion; onShow: (number: number) => void; onUnapprove: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        data-testid="version-menu"
        className="inline-flex min-h-control-sm items-center gap-2 rounded-md border border-border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-muted"
      >
        {t("section.versionMenu", { number: current.number, total: detail.versions.length })}
        <Icon name="chevron" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} align="start" className="z-10 outline-none">
          <BaseMenu.Popup
            aria-label={t("section.versionMenuLabel")}
            className="max-h-[min(28rem,var(--available-height))] w-[min(26rem,var(--available-width))] overflow-y-auto rounded-md border border-border bg-surface py-1 text-fg shadow-popup outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <BaseMenu.RadioGroup value={current.number} onValueChange={(value: number) => onShow(value)}>
              {[...detail.versions].reverse().map((version) => (
                <BaseMenu.RadioItem
                  key={version.number}
                  value={version.number}
                  closeOnClick
                  className="flex cursor-default gap-2.5 px-3 py-2 outline-none select-none data-highlighted:bg-surface-muted"
                >
                  <span className="w-4 pt-0.5 text-accent">
                    <BaseMenu.RadioItemIndicator>
                      <Icon name="check" />
                    </BaseMenu.RadioItemIndicator>
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium break-words">
                      <Mono>v{version.number}</Mono> · {versionLabel(t, version)}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {[
                        versionWho(t, detail.versions, version),
                        versionWhen(t, language, version.createdAt),
                        detail.approvedVersion === version.number ? t("section.versionApproved") : null,
                        versionCost(t, language, version),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </BaseMenu.RadioItem>
              ))}
            </BaseMenu.RadioGroup>
            {detail.approvedVersion !== null ? (
              <>
                <BaseMenu.Separator className="my-1 border-t border-border" />
                <BaseMenu.Item onClick={onUnapprove} className="flex min-h-control cursor-default items-center px-3 pl-9.5 text-sm outline-none select-none data-highlighted:bg-surface-muted">
                  {t("section.unapprove")}
                </BaseMenu.Item>
              </>
            ) : null}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function versionLabel(t: TFunction, version: SectionVersion): string {
  switch (version.kind) {
    case "hers":
      return t("section.labelHers");
    case "draft":
      return t("section.labelDraft");
    case "change":
      return t("section.labelChange", { request: shorten(version.request ?? "") });
    case "paragraph":
      return t("section.labelParagraph", { number: (version.paragraphIndex ?? 0) + 1, request: shorten(version.request ?? "") });
    case "improve":
      return t("section.labelImprove");
    default:
      return t("section.labelEdited");
  }
}

function versionWho(t: TFunction, versions: readonly SectionVersion[], version: SectionVersion): string {
  const own = version.kind === "hers" || (version.kind === "edited" && !isCorrection(versions, version));
  const corrected = version.kind === "edited" && !own;
  if (own) return t("section.whoYou");
  if (corrected) return t("section.whoCorrected");
  return version.model ? t("section.whoAi", { model: modelLabel(version.model) }) : t("section.whoAiUnknown");
}

function versionWhen(t: TFunction, language: ReturnType<typeof useLanguage>["language"], iso: string): string {
  const time = formatTime(language, iso);
  const day = relativeDay(iso);
  return day === "today" ? t("section.whenToday", { time }) : day === "yesterday" ? t("section.whenYesterday", { time }) : t("section.whenOther", { date: formatShortDate(language, iso), time });
}

/** What a version cost, only when it was written with a Claude key (owner's decision P6): a ChatGPT plan spends no money per request. */
function versionCost(t: TFunction, language: ReturnType<typeof useLanguage>["language"], version: SectionVersion): string | null {
  if (version.provider !== "anthropic" || version.costUsd === null) return null;
  return t("section.versionCost", { cost: formatUsd(language, version.costUsd + (version.checkCostUsd ?? 0)) });
}

function shorten(text: string, length = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1).trimEnd()}…`;
}

/** An amount in dollars, as the screen's language writes it: "$0.18", "0,18 US$". */
export function formatUsd(language: string, amount: number): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: amount > 0 && amount < 0.1 ? 3 : 2 }).format(amount);
}

/**
 * The muted line under the header (owner's proposal §4): "v2: “shorter, and mention the
 * school” · today, 11:20 · see what changed", and which version is approved when it is
 * another. A sentence in Plex Sans; the version in Plex Mono (T17).
 */
function VersionLine({ detail, version, changesShown, onToggleChanges }: { detail: SectionDetail; version: SectionVersion; changesShown: boolean; onToggleChanges: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [before, after] = t("section.versionMeta", { version: SLOT, label: versionLabel(t, version) }).split(SLOT);
  const parts: ReactNode[] = [versionWhen(t, language, version.createdAt)];
  if (detail.approvedVersion !== null && detail.approvedVersion !== version.number) parts.push(t("section.approvedOther", { number: detail.approvedVersion }));
  return (
    <p data-testid="version-line" className="max-w-reading text-sm text-fg-muted">
      {before}
      <Mono>v{version.number}</Mono>
      {after}
      {parts.map((part, index) => (
        <span key={index}> · {part}</span>
      ))}
      {version.basedOn !== null ? (
        <>
          {" · "}
          <ChangesToggle on={changesShown} onToggle={onToggleChanges} />
        </>
      ) : null}
    </p>
  );
}

/** "ver qué cambió": marks the paragraphs this version changed from the one it was made from. */
function ChangesToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" aria-pressed={on} onClick={onToggle} className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover hover:decoration-2">
      {on ? t("section.hideChanges") : t("section.seeChanges")}
    </button>
  );
}

/**
 * After Copy (P2), in place of the muted line: what was copied, what is still marked, where
 * it goes in ABA Matrix, whether it is approved, and the next section.
 */
function CopiedLine({ copied, section, approvedVersion, next, caseId }: { copied: Copied | "failed"; section: ReportSection; approvedVersion: number | null; next: ReportSection | null; caseId: string }) {
  const { t } = useTranslation();
  if (copied === "failed") {
    return (
      <p data-testid="copied-line" className="text-sm font-medium text-danger">
        {t("section.copyFailed")}
      </p>
    );
  }
  const lead = copiedLead(copied.text);
  const warn = lead.key !== "copiedLead" || approvedVersion !== copied.number;
  return (
    <p data-testid="copied-line" className={cn("max-w-reading text-sm font-medium", warn ? "text-warning" : "text-success")}>
      {lead.key === "copiedLead" ? t("section.copiedLead") : t(`section.${lead.key}`, { count: lead.count })}{" "}
      {withSlot(t("section.pasteWhere", { section: SLOT }), <span lang="en">{section.title}</span>)}
      {approvedVersion === null ? ` ${t("section.copiedNotApprovedYet")}` : approvedVersion !== copied.number ? ` ${t("section.copiedOtherVersion", { number: copied.number, approved: approvedVersion })}` : null}
      {next ? (
        <>
          {" "}
          <TextLink to={casePath(caseId, "report", next.id)} className="inline-flex items-center gap-1">
            {withSlot(t("section.nextSectionLink", { section: SLOT }), <span lang="en">{next.title}</span>)}
            <Icon name="arrow" />
          </TextLink>
        </>
      ) : null}
    </p>
  );
}

/** What the copied line says, as one sentence for the screen's live region (review round 1, S2). */
function copiedSentence(t: TFunction, copied: Copied | "failed", section: ReportSection, approvedVersion: number | null, next: ReportSection | null): string {
  if (copied === "failed") return t("section.copyFailed");
  const lead = copiedLead(copied.text);
  const parts = [lead.key === "copiedLead" ? t("section.copiedLead") : t(`section.${lead.key}`, { count: lead.count }), t("section.pasteWhere", { section: section.title })];
  if (approvedVersion === null) parts.push(t("section.copiedNotApprovedYet"));
  else if (approvedVersion !== copied.number) parts.push(t("section.copiedOtherVersion", { number: copied.number, approved: approvedVersion }));
  if (next) parts.push(t("section.nextSectionLink", { section: next.title }));
  return parts.join(" ");
}

/** Text with single line breaks reads as one paragraph (review M3): say so, and offer each line as a paragraph. */
function LinesNotice({ onTreat }: { onTreat: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="lines-notice" className="flex max-w-reading flex-col items-start gap-2 rounded-md border border-border-control bg-surface-muted px-3.5 py-2.5 text-sm">
      <p>{t("section.linesNotice")}</p>
      <Button size="sm" onClick={onTreat}>
        {t("section.treatLines")}
      </Button>
    </div>
  );
}

/**
 * Her own text: pasted from ABA Matrix, typed, or an edit of a version. Saved as she types,
 * as one version per editing pass (the first save makes it; the next ones update it). The
 * box fills the pane and grows with the text, so the pane is the only scroll (T16).
 */
function OwnTextEditor({
  caseId,
  sectionId,
  initialText,
  savedValue,
  keptId,
  editing: initialEditing,
  onSaved,
  onTreatLines,
  onState,
  flushRef,
}: {
  caseId: string;
  sectionId: ReportSection["id"];
  initialText: string;
  /** What is on disk, when the box starts from a kept text instead (null: nothing of it saved yet). */
  savedValue: string | null;
  /** The kept text it starts from (review round 2, B3), told to the main process once shown. */
  keptId: string | null;
  editing: number | null;
  onSaved: (detail: SectionDetail, sections?: ReturnType<typeof useOpenedCase>["sections"]) => void;
  onTreatLines: (text: string, flush: () => Promise<boolean>) => Promise<void>;
  /** Told the save state and the version this pass writes to, for the header and the foot. */
  onState: (state: EditorState) => void;
  /** Set to this box's flush, for "Listo" and "Mejorarla con la IA". */
  flushRef: { current: () => Promise<boolean> };
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const hintId = useId();
  const editing = useRef<number | null>(initialEditing);
  const [saved, setSaved] = useState<number | null>(initialEditing);
  const text = useAutosave({
    caseId,
    initial: initialText,
    savedValue,
    save: async (value) => {
      const result = await window.aba.saveSectionText(caseId, sectionId, value, editing.current);
      if (result.outcome !== "saved") return false;
      // The newest version is the one this pass writes to from now on.
      editing.current = result.section.currentVersion;
      setSaved(result.section.currentVersion);
      onSaved(result.section, result.sections);
      return true;
    },
  });
  // Not before the page has read the kept texts (review round 4, L-2).
  const listLoaded = useFailedSavesLoaded();
  // The box shows the kept text: from now on its saves are built on it.
  useEffect(() => {
    if (keptId) void window.aba.failedSaveShown(keptId).catch(() => undefined);
  }, [keptId]);
  useEffect(() => {
    onState({ status: text.status, saved, text: text.value });
  }, [onState, text.status, saved, text.value]);
  // The button that opened the editor is gone: the focus goes to the text, at its end (review round 1, M5).
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || (document.activeElement !== document.body && document.activeElement !== null)) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useEffect(() => {
    flushRef.current = text.flush;
  }, [flushRef, text.flush]);
  // "Try again" saved what she typed: the box knows it is on disk, and her next keystroke updates that version.
  const markSaved = text.markSaved;
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);
  useEffect(
    () =>
      onRetried((item) => {
        if (item.about !== "section" || item.caseId !== caseId || item.sectionId !== sectionId || item.text === null) return;
        markSaved(item.text);
        void window.aba.getSection(caseId, sectionId).then((result) => {
          if (result.outcome !== "read") return;
          editing.current = result.section.currentVersion;
          setSaved(result.section.currentVersion);
          onSavedRef.current(result.section);
        });
      }),
    [caseId, sectionId, markSaved],
  );
  const paragraphs = splitParagraphs(text.value).length;
  const words = countWords(text.value);
  return (
    <div className="flex max-w-reading flex-1 flex-col gap-1.5">
      <label htmlFor={fieldId} className="sr-only">
        {t("section.herTextLabel")}
      </label>
      <textarea
        ref={box}
        id={fieldId}
        lang="en"
        aria-describedby={hintId}
        data-testid="section-text"
        readOnly={!listLoaded}
        value={text.value}
        onChange={(event) => text.setValue(event.target.value)}
        onBlur={() => void text.flush()}
        className="min-h-48 w-full flex-1 resize-none overflow-hidden rounded-md border-2 border-accent bg-surface px-4 py-3 text-md text-fg field-sizing-content"
      />
      <p id={hintId} className="text-sm text-fg-muted">
        {t("section.editorHint")} {t("section.editorParagraphs", { count: paragraphs })} · {t("section.editorWords", { count: words })}.
      </p>
      {text.status === "failed" ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
          {t("section.actionFailed")}
          <Button size="sm" onClick={() => void text.retry()}>
            {t("sources.tryAgain")}
          </Button>
        </p>
      ) : null}
      {hasLinesInParagraphs(text.value) ? <LinesNotice onTreat={() => void onTreatLines(text.value, text.flush)} /> : null}
    </div>
  );
}

/** A paragraph's number, in the gutter beside it (layout rule 6). */
function Gutter({ number }: { number: number }) {
  return (
    <span aria-hidden="true" className="pt-1.5 pr-3 text-right font-mono text-xs text-fg-muted tabular-nums select-none">
      {number}
    </span>
  );
}

/**
 * The AI writing: the amber band, and the text as it streams, its paragraphs numbered. A
 * change to one paragraph shows the others as they are and the marked one being rewritten.
 */
function WritingView({ generation, base }: { generation: SectionGeneration; base: SectionVersion | null }) {
  const { t } = useTranslation();
  const asked = generation.request;
  const markedIndex = asked?.kind === "paragraph" ? asked.paragraphIndex : null;
  const paragraphs = markedIndex !== null ? splitParagraphs(base?.text ?? "") : splitParagraphs(generation.text);
  const title = bandTitle(t, generation);
  return (
    <>
      <div className="flex max-w-reading gap-3 rounded-lg border border-accent bg-ai-subtle px-4 py-3 text-fg-on-accent-subtle">
        <Icon name="sparkle" size={18} className="mt-0.5" />
        {/* Announced by the screen's live region (review round 1, M4). */}
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold">{title}</p>
          <p className="text-sm">{t("section.bandBody")}</p>
        </div>
      </div>
      <ol lang="en" aria-busy="true" data-testid="streaming-text" className="flex max-w-reading flex-col gap-3 text-md">
        {paragraphs.map((paragraph, index) => (
          <li key={index} className="grid grid-cols-[2rem_minmax(0,1fr)]">
            <Gutter number={index + 1} />
            {index === markedIndex ? (
              <p className="rounded-md border border-accent bg-ai-subtle px-2.5 py-1.5 whitespace-pre-line">{generation.text || paragraph}</p>
            ) : (
              <p className="px-2.5 py-1.5 whitespace-pre-line">{paragraph}</p>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

/** The drafting band's first line: reading the case, writing paragraph N, or changing paragraph N. */
function bandTitle(t: TFunction, generation: SectionGeneration): string {
  const asked = generation.request;
  if (asked?.kind === "paragraph") return t("section.bandParagraph", { number: asked.paragraphIndex + 1 });
  if (generation.phase === "writing" && generation.text) return t("section.bandWriting", { number: paragraphBeingWritten(generation.text) });
  return t("section.bandReading");
}

/** The request box while the AI writes: visible, waiting. */
function WaitingComposer({ nextNumber }: { nextNumber: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-list items-center gap-2">
      <input
        disabled
        aria-label={t("section.askLabel")}
        placeholder={t("section.composerWaiting")}
        className="min-h-control min-w-0 flex-1 rounded-md border border-border-control bg-surface px-3 text-base disabled:cursor-not-allowed disabled:opacity-60"
      />
      <Button variant="ai" disabled>
        {t("section.createVersion", { number: nextNumber })}
      </Button>
    </div>
  );
}

/**
 * A version to read: what the last request did (failed, stopped, saved before Stop), the
 * text in numbered paragraphs, each of which can be marked (click, or Enter/Space) to ask
 * for a change to that paragraph only.
 */
function SectionText({
  detail,
  version,
  generation,
  providers,
  changesShown,
  onRequest,
  onTreatLines,
}: {
  detail: SectionDetail;
  version: SectionVersion;
  generation: SectionGeneration | null;
  providers: Providers;
  changesShown: boolean;
  onRequest: (request: SectionRequestInput) => void;
  onTreatLines: () => void;
}) {
  const { t } = useTranslation();
  const [marked, setMarked] = useState<number | null>(null);
  const [paragraphRequest, setParagraphRequest] = useState("");
  const paragraphs = useMemo(() => splitParagraphs(version.text), [version.text]);
  const markedRef = useRef<HTMLFormElement>(null);
  const paragraphRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const describedBy = useId();
  const base = version.basedOn === null ? null : (detail.versions.find((candidate) => candidate.number === version.basedOn) ?? null);
  const changed = useMemo(() => (base ? changedParagraphs(version.text, base.text) : null), [base, version.text]);

  useEffect(() => {
    if (marked !== null) markedRef.current?.querySelector("input")?.focus();
  }, [marked]);

  // A new version replaced the text she was in: the focus goes to its first paragraph rather than nowhere.
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) paragraphRefs.current[0]?.focus();
  }, []);

  /** Closes the paragraph form and puts the focus back on its paragraph (review, low 3). */
  function closeMarked(index: number) {
    setMarked(null);
    window.requestAnimationFrame(() => paragraphRefs.current[index]?.focus());
  }

  return (
    <>
      {generation && generation.phase === "done" ? <GenerationOutcomeMessage generation={generation} providers={providers} /> : null}
      {hasLinesInParagraphs(version.text) ? <LinesNotice onTreat={onTreatLines} /> : null}
      <ol lang="en" data-testid="section-view" className="flex max-w-reading flex-col gap-3 text-md">
        {paragraphs.map((paragraph, index) => {
          const isChanged = changesShown && changed?.[index] === true;
          return (
            <li key={index} className="flex flex-col gap-2">
              <div className="grid grid-cols-[2rem_minmax(0,1fr)]">
                <Gutter number={index + 1} />
                <p
                  id={`paragraph-${index + 1}`}
                  ref={(element) => {
                    paragraphRefs.current[index] = element;
                  }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={marked === index}
                  aria-describedby={`${describedBy}-${index}`}
                  title={t("section.selectParagraph", { number: index + 1 })}
                  onClick={() => setMarked(marked === index ? null : index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setMarked(marked === index ? null : index);
                    }
                  }}
                  className={cn(
                    "scroll-mt-4 cursor-pointer rounded-md border px-2.5 py-1.5 whitespace-pre-line",
                    marked === index ? "border-accent bg-ai-subtle" : "border-transparent hover:bg-surface-muted",
                    isChanged && marked !== index && "border-l-accent rounded-l-none border-l-[3px] bg-surface-muted",
                  )}
                >
                  <Highlighted text={paragraph} />
                </p>
              </div>
              <span id={`${describedBy}-${index}`} className="sr-only">
                {t("section.selectParagraph", { number: index + 1 })}
                {isChanged ? ` ${t("section.changedSr")}` : ""}
              </span>
              {marked === index ? (
                <form
                  ref={markedRef}
                  className="ml-8 flex flex-col gap-2 rounded-md border border-border bg-surface p-2.5 shadow-popup"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const asked = paragraphRequest.trim();
                    if (!asked || !providers.provider) return;
                    onRequest({ kind: "paragraph", fromVersion: version.number, paragraphIndex: index, request: asked });
                    setParagraphRequest("");
                    setMarked(null);
                    // The text is replaced while the AI writes: the focus goes to Stop.
                  }}
                >
                  <label htmlFor={`paragraph-request-${index}`} className="flex items-center gap-1.5 text-sm font-semibold">
                    <Icon name="sparkle" className="text-fg-on-accent-subtle" />
                    {t("section.changeParagraph", { number: index + 1 })}
                  </label>
                  <div className="flex flex-wrap items-center gap-2 @split:flex-nowrap">
                  <input
                    id={`paragraph-request-${index}`}
                    value={paragraphRequest}
                    maxLength={MAX_REQUEST_LENGTH}
                    placeholder={t("section.changeParagraphPlaceholder")}
                    onChange={(event) => setParagraphRequest(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeMarked(index);
                    }}
                    className="min-h-control min-w-48 flex-1 rounded-md border border-border-control bg-surface px-3 text-base @split:min-w-0"
                  />
                  {providers.provider === null && !providers.loading ? (
                    <ConnectButton />
                  ) : (
                    <Button type="submit" variant="ai" disabled={paragraphRequest.trim() === "" || providers.provider === null}>
                      {t("section.changeButton")}
                    </Button>
                  )}
                  <Button onClick={() => closeMarked(index)}>{t("section.cancel")}</Button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** The request box, docked at the foot of the pane (layout rule 3): Edit by hand on the left, the AI request on the right. */
function Composer({ version, nextNumber, providers, onRequest, onEdit }: { version: SectionVersion; nextNumber: number; providers: Providers; onRequest: (request: SectionRequestInput) => void; onEdit: () => void }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState("");
  const askId = useId();
  const hintId = useId();
  return (
    <form
      data-testid="composer"
      className="flex max-w-list flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const asked = request.trim();
        if (!asked || !providers.provider) return;
        onRequest({ kind: "change", fromVersion: version.number, request: asked });
        setRequest("");
      }}
    >
      {/* One row beside the rail (mockup 09): the request box gives way, the two buttons keep their width. */}
      <div className="flex flex-wrap items-center gap-2 @split:flex-nowrap">
        <Button onClick={onEdit} className="shrink-0">
          <Icon name="pencil" />
          {t("section.editByHand")}
        </Button>
        <div className="relative min-w-48 flex-1 @split:min-w-0">
          <Icon name="sparkle" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-on-accent-subtle" />
          <label htmlFor={askId} className="sr-only">
            {t("section.askLabel")}
          </label>
          <input
            id={askId}
            aria-describedby={hintId}
            value={request}
            maxLength={MAX_REQUEST_LENGTH}
            placeholder={t("section.askPlaceholder")}
            onChange={(event) => setRequest(event.target.value)}
            className="min-h-control w-full rounded-md border border-border-control bg-surface pr-3 pl-9 text-base"
          />
        </div>
        {providers.provider === null && !providers.loading ? (
          <ConnectButton />
        ) : (
          <Button type="submit" variant="ai" disabled={request.trim() === "" || providers.provider === null} className="shrink-0">
            {t("section.createVersion", { number: nextNumber })}
          </Button>
        )}
      </div>
      <p id={hintId} className="text-xs text-fg-muted">
        {t("section.askHint")}
      </p>
    </form>
  );
}

/** The markers the model leaves stand out in the text. */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[(?:MISSING|CHECK)\s*:[^\]]*\])/u);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-warning-subtle px-0.5 text-warning">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function GenerationOutcomeMessage({ generation, providers }: { generation: SectionGeneration; providers: Providers }) {
  const { t } = useTranslation();
  const outcome = generation.outcome;
  if (!outcome || outcome.kind === "saved" || outcome.kind === "checked") return null;
  if (outcome.kind === "saved-before-stop") {
    return (
      <p role="status" className="max-w-reading rounded-md border border-border px-3.5 py-2 text-sm font-medium text-fg">
        {t("section.savedBeforeStop")}
      </p>
    );
  }
  const message =
    outcome.kind === "stopped"
      ? t("section.stopped")
      : outcome.kind === "refused"
        ? t("section.refused")
        : outcome.kind === "incomplete"
          ? t("section.incomplete")
          : outcome.kind === "not-saved"
            ? t("section.saveFailed")
            : outcome.kind === "not-one-paragraph"
              ? t("section.notOneParagraph")
              : outcome.kind === "too-long"
                ? t("section.tooLong")
                : t("section.failed");
  // A failed request says what to do in her words; the provider's English text waits under "Technical details" (owner's decision T11).
  const kind = outcome.kind === "failed" ? aiErrorKind(outcome.code) : null;
  // "Try again" only where sending the same request again can work (UX-2 follow-up): a key or plan refused, a model not allowed, the app's rules, never.
  const canRetry = outcome.kind === "failed" && kind !== null && aiErrorCanRetry(kind) && generation.request !== null;
  // One way out to Settings: when no AI is connected any more, the AI's own "Conectar la IA" already leads there (UX-2 follow-up).
  const toSettings = kind !== null && aiErrorNeedsSettings(kind) && providers.available.length > 0;
  return (
    <div role="alert" className={cn("flex max-w-reading flex-col gap-2 rounded-md border px-3.5 py-2", outcome.kind === "stopped" ? "border-border" : "border-danger")}>
      <div className="flex flex-wrap items-center gap-3">
        <p className={cn("text-sm font-medium", outcome.kind === "stopped" ? "text-fg" : "text-danger")}>
          {message}
          {kind ? ` ${t(`section.failedWhy.${kind}`)}` : null}
        </p>
        {canRetry ? (
          <Button size="sm" data-testid="section-try-again" onClick={() => void retrySectionGeneration(generation)}>
            {t("sources.tryAgain")}
          </Button>
        ) : null}
        {toSettings ? (
          <ButtonLink to="/settings" size="sm">
            {t("section.openSettings")}
          </ButtonLink>
        ) : null}
      </div>
      {outcome.kind === "failed" && outcome.message ? (
        <details className="text-sm text-fg-muted">
          <summary className="w-fit cursor-pointer rounded-sm underline underline-offset-2 hover:decoration-2">{t("section.technicalDetails")}</summary>
          <p lang="en" data-testid="section-error-details" className="mt-1 break-words">
            {outcome.message}
          </p>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The rail, in the order of need (owner's proposal §4 and layout rule 7). Each part has a
 * key, so her instructions' box keeps its place (and what she is typing) whichever parts
 * show around it.
 */
function SectionRail({
  caseId,
  section,
  detail,
  display,
  current,
  generation,
  providers,
  step,
  approved,
  done,
  onRecheck,
}: {
  caseId: string;
  section: ReportSection;
  detail: SectionDetail;
  display: Mode | "writing";
  current: SectionVersion | null;
  generation: SectionGeneration | null;
  providers: Providers;
  step: ReturnType<typeof nextStep>;
  approved: boolean;
  done: boolean;
  onRecheck: (version: number) => void;
}) {
  const checking = generation?.phase === "checking" && isRunning(generation);
  const parts: Array<{ key: string; node: ReactNode }> = [];
  const nextCard = { key: "next", node: <SectionNextStep caseId={caseId} step={step} primary={done} /> };
  if (display === "view" && approved) parts.push(nextCard);
  if (display === "writing") {
    parts.push({ key: "reads", node: <ReadsList detail={detail} section={section} /> });
    parts.push({ key: "when-done", node: <WhenDone /> });
  }
  if (display === "paste" || display === "edit") {
    // Her text as last saved: the version this editing pass writes to, or none before the first save.
    const saved = detail.versions.find((candidate) => candidate.number === detail.currentVersion) ?? null;
    parts.push({ key: "live-checks", node: <LiveChecks detail={detail} version={saved} /> });
  }
  if (display === "view" && current) {
    parts.push({
      key: "before-approve",
      node: (
        <BeforeApprove
          detail={detail}
          version={current}
          approved={approved}
          checking={checking}
          generation={generation}
          canCheck={providers.provider !== null && !isRunning(generation)}
          onRecheck={onRecheck}
        />
      ),
    });
  }
  if (display !== "writing") parts.push({ key: "instructions", node: <InstructionsBox caseId={caseId} section={section} detail={detail} /> });
  if (display === "view" && current && current.sourcesUsed.length > 0) parts.push({ key: "used", node: <UsedLine version={current} /> });
  // Which AI writes, in every state: also while she edits by hand, for "Mejorarla con la IA" (review round 1, M2).
  parts.push({ key: "writes-with", node: <WritesWith providers={providers} /> });
  if (!(display === "view" && approved) && display !== "writing") parts.push(nextCard);
  return <>{parts.map((part) => <RailPart key={part.key}>{part.node}</RailPart>)}</>;
}

/** One part of the rail, keyed by what it is. */
function RailPart({ children }: { children: ReactNode }) {
  return children;
}

/**
 * "Siguiente paso" for a section: the next one not ready; with none left, the case's summary
 * (review round 1, M1), said "all ready" only once this section is ready too (round 2, S-1).
 * Revisión y copia is not built yet, so "Siguiente paso" skips it (owner's decision P3, UX-5).
 */
function SectionNextStep({ caseId, step, primary }: { caseId: string; step: ReturnType<typeof nextStep>; primary: boolean }) {
  const { t } = useTranslation();
  if (step.kind === "review") {
    const name = step.allReady ? t("section.allReadyName", { total: REPORT_SECTIONS.length }) : t("section.thenSummaryName");
    return <NextStepCard name={name} body={t(step.allReady ? "section.allReadyBody" : "section.thenSummaryBody")} to={caseSummaryPath(caseId)} action={t("section.toSummary")} primary={primary} />;
  }
  return <NextStepCard name={step.section.title} nameLang="en" body={t("section.nextSectionBody")} to={casePath(caseId, "report", step.section.id)} action={t("section.nextSectionAction")} primary={primary} />;
}

function RailHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Eyebrow id={id} className="text-fg-muted">
      {children}
    </Eyebrow>
  );
}

/** While the AI writes: what it is reading (owner's proposal §4, mockup 07). */
function ReadsList({ detail, section }: { detail: SectionDetail; section: ReportSection }) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const headingId = useId();
  const documents = opened.sources.sources.filter((source) => !source.removedAt).length;
  const states = new Map(opened.sections.map((summary) => [summary.id, summary.state]));
  const hers = REPORT_SECTIONS.filter((other) => other.id !== section.id && (states.get(other.id) === "hers" || states.get(other.id) === "approved"));
  const items: ReactNode[] = [documents > 0 ? t("section.readsDocuments", { count: documents }) : t("section.readsNoDocuments")];
  if (hers.length > 0) {
    items.push(
      <>
        {t("section.readsSections", { count: hers.length })}:{" "}
        {hers.map((other, index) => (
          <span key={other.id}>
            {index > 0 ? ", " : null}
            <span lang="en">{other.title}</span>
          </span>
        ))}
      </>,
    );
  }
  if (detail.instructions.trim()) items.push(t("section.readsInstructions"));
  if (opened.notes.trim()) items.push(t("section.readsNotes"));
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.readsHeading")}</RailHeading>
      <ul className="flex flex-col text-sm">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 border-b border-border py-2 last:border-b-0">
            <Icon name="check" className="mt-0.5 text-success" />
            <span className="break-words">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WhenDone() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.whenDoneHeading")}</RailHeading>
      <p className="text-sm">{t("section.whenDoneBody")}</p>
    </section>
  );
}

/** Which AI writes: its name, or the choice when both are connected. */
function WritesWith({ providers }: { providers: Providers }) {
  const { t } = useTranslation();
  const headingId = useId();
  const name = (provider: DraftingProvider) => (provider === "openai" ? t("section.providerChatgpt") : t("section.providerClaude"));
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.providerLabel")}</RailHeading>
      {providers.loading ? null : providers.available.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("section.notConnected")}</p>
      ) : providers.available.length === 1 || !providers.provider ? (
        <p className="text-sm">{name(providers.available[0])}</p>
      ) : (
        <Select
          label={t("section.providerLabel")}
          value={providers.provider}
          options={providers.available.map((id) => ({ value: id, label: PROVIDER_NAMES[id] }))}
          onValueChange={(value) => providers.choose(value)}
        />
      )}
    </section>
  );
}

/** Her standing instructions for the section, for all her cases; saved as she types. */
function InstructionsBox({ caseId, section, detail }: { caseId: string; section: ReportSection; detail: SectionDetail }) {
  const { t } = useTranslation();
  const instructionsId = useId();
  const hintId = useId();
  const instructions = useAutosave({
    caseId,
    initial: detail.instructions,
    save: async (text) => (await window.aba.saveSectionInstructions(caseId, section.id, text)).outcome === "saved",
  });
  // Instructions she typed that could not be saved come back in this box after a reload, from whichever case (review round 2, B3).
  const instructionsReady = useKeptText(
    instructions,
    useCallback((item: FailedSave) => item.about === "instructions" && item.sectionId === section.id, [section.id]),
  );
  return (
    <section aria-labelledby={instructionsId} className="flex flex-col gap-1.5">
      <RailHeading id={instructionsId}>{t("section.instructionsHeading")}</RailHeading>
      <textarea
        aria-labelledby={instructionsId}
        aria-describedby={hintId}
        data-testid="section-instructions"
        readOnly={!instructionsReady}
        value={instructions.value}
        placeholder={t("section.instructionsPlaceholder")}
        onChange={(event) => instructions.setValue(event.target.value)}
        onBlur={() => void instructions.flush()}
        className="min-h-24 w-full resize-none rounded-md border border-border-control bg-surface px-2.5 py-2 text-sm text-fg field-sizing-content"
      />
      <p id={hintId} className="text-xs text-fg-muted">
        {instructions.status === "saving" ? t("sources.saving") : t("section.instructionsHint")}
      </p>
      {instructions.status === "failed" ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {t("section.actionFailed")}
        </p>
      ) : null}
    </section>
  );
}

/** "Usó": how many documents this version was written from, and which, behind "ver". */
function UsedLine({ version }: { version: SectionVersion }) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.usedHeading")}</RailHeading>
      <details className="text-sm">
        <summary className="cursor-pointer list-none">
          {t("section.usedDocuments", { count: version.sourcesUsed.length })} · <span className="font-medium text-accent underline underline-offset-2">{t("section.usedSee")}</span>
        </summary>
        <ul className="mt-1.5 flex flex-col gap-1">
          {version.sourcesUsed.map((entry) => {
            // Named as the Documents step names it; a document changed or gone since keeps the name it was sent with.
            const source = opened.sources.sources.find((candidate) => candidate.id === entry.id);
            return (
              <li key={entry.id} className="break-words">
                {source ? <span lang={sourceNameLang(source)}>{sourceName(t, source)}</span> : <span lang="en">{entry.title}</span>}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

/** A point to look at before approving: a dot (or a check when all is well) and its words. */
function CheckItem({ tone, children }: { tone: "warning" | "success" | "neutral"; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 border-b border-border py-2 text-sm last:border-b-0">
      {tone === "success" ? (
        <Icon name="check" className="mt-0.5 text-success" />
      ) : (
        <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone === "warning" ? "bg-warning" : "bg-border-control")} />
      )}
      <div className="flex min-w-0 flex-col items-start gap-1 break-words">{children}</div>
    </li>
  );
}

/** A link to a paragraph of the text: it scrolls there and takes the focus. */
function ParagraphLink({ number }: { number: number }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => {
        const target = document.getElementById(`paragraph-${number}`);
        target?.scrollIntoView({ block: "center" });
        target?.focus({ preventScroll: true });
      }}
      className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover hover:decoration-2"
    >
      {t("section.paragraphLink", { number })}
    </button>
  );
}

/** Whether a version is the AI's (or her edit of one): the versions the consistency check is for. */
function checkable(version: SectionVersion): boolean {
  return version.kind !== "hers" && (version.kind !== "edited" || version.consistency !== null || version.model !== null);
}

/**
 * "Antes de aprobar" (owner's proposal §4): each check in words, with a link to its
 * paragraph, and that approving anyway is fine.
 */
function BeforeApprove({
  detail,
  version,
  approved,
  checking,
  generation,
  canCheck,
  onRecheck,
}: {
  detail: SectionDetail;
  version: SectionVersion;
  approved: boolean;
  checking: boolean;
  generation: SectionGeneration | null;
  canCheck: boolean;
  onRecheck: (version: number) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const issues = checkStructure(version.text, detail.shape);
  const markers = findMarkers(version.text);
  const consistency = version.consistency;
  const contradictions = consistency?.status === "found" ? consistency.items.length : 0;
  const recheck =
    !checking && checkable(version) && (!consistency || consistency.status === "failed" || consistency.stale) ? (
      <Button size="sm" disabled={!canCheck} onClick={() => onRecheck(version.number)}>
        {t("section.checkAgain")}
      </Button>
    ) : null;
  return (
    <section id="section-checks" aria-labelledby={headingId} className="flex scroll-mt-20 flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.beforeApproveHeading")}</RailHeading>
      <ul data-testid="section-checks" className="flex flex-col">
        {markers.map((marker, index) => (
          <CheckItem key={`marker-${index}`} tone="warning">
            <span>
              {marker.kind === "missing" ? t("section.missingLabel") : t("section.checkLabel")}: <span lang="en">{marker.note}</span>
            </span>
            <ParagraphLink number={marker.paragraph + 1} />
          </CheckItem>
        ))}
        {issues.map((issue, index) => (
          <CheckItem key={`structure-${index}`} tone="warning">
            <span>
              {t("section.checkStructure")}: {structureIssueText(t, issue)}
            </span>
            {issue.kind === "formatting" ? <ParagraphLink number={issue.paragraph + 1} /> : null}
          </CheckItem>
        ))}
        {markers.length === 0 && issues.length === 0 ? <CheckItem tone="success">{t("section.nothingMarked")}</CheckItem> : null}
        {checking ? (
          <CheckItem tone="neutral">
            <span role="status">{t("section.checking")}</span>
            {generation ? (
              <Button size="sm" onClick={() => stopSectionGeneration(generation)}>
                {t("section.skipCheck")}
              </Button>
            ) : null}
          </CheckItem>
        ) : !checkable(version) ? null : consistency?.status === "none" ? (
          <CheckItem tone="success">
            {t("section.consistencyOk")}
            {consistency.stale ? <span className="text-xs text-warning">{t("section.consistencyStale")}</span> : null}
            {recheck}
          </CheckItem>
        ) : consistency?.status === "found" ? (
          <CheckItem tone="warning">
            <span>{t("section.consistencyContradicts")}</span>
            <ul lang="en" className="flex list-disc flex-col gap-0.5 pl-4 text-xs">
              {consistency.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            {consistency.stale ? <span className="text-xs text-warning">{t("section.consistencyStale")}</span> : null}
            {recheck}
          </CheckItem>
        ) : (
          <CheckItem tone="neutral">
            <span className="text-fg-muted">
              {consistency?.status === "nothing-to-compare" ? t("section.consistencyNothing") : consistency?.status === "failed" ? t("section.consistencyFailed") : t("section.consistencyNotChecked")}
            </span>
            {recheck}
          </CheckItem>
        )}
      </ul>
      {!approved && (markers.length > 0 || issues.length > 0 || contradictions > 0) ? <p className="text-xs text-fg-muted">{t("section.approveAnyway")}</p> : null}
    </section>
  );
}

function CheckRow({ name, value, tone, children }: { name: string; value: string; tone: "success" | "warning" | "neutral"; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-1.5 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{name}</span>
        <span className={cn("text-right font-semibold", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "neutral" && "font-normal text-fg-muted")}>{value}</span>
      </div>
      {children}
    </div>
  );
}

/** While she writes by hand: the code's checks on her text as saved, and the consistency check said to come at the end (mockup 08). */
function LiveChecks({ detail, version }: { detail: SectionDetail; version: SectionVersion | null }) {
  const { t } = useTranslation();
  const headingId = useId();
  const text = version?.text ?? "";
  const issues = checkStructure(text, detail.shape);
  const markers = findMarkers(text);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <RailHeading id={headingId}>{t("section.checksHeading")}</RailHeading>
      <div data-testid="section-checks" className="flex flex-col">
        <CheckRow name={t("section.checkStructure")} value={issues.length === 0 ? t("section.structureComplete") : t("section.structureIssues", { count: issues.length })} tone={issues.length === 0 ? "success" : "warning"}>
          {issues.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
              {issues.map((issue, index) => (
                <li key={index}>{structureIssueText(t, issue)}</li>
              ))}
            </ul>
          ) : null}
        </CheckRow>
        <CheckRow name={t("section.checkMissing")} value={markers.length === 0 ? t("section.missingNone") : t("section.missingCount", { count: markers.length })} tone={markers.length === 0 ? "success" : "warning"} />
        <CheckRow name={t("section.checkConsistency")} value={t("section.consistencyAtEnd")} tone="neutral" />
      </div>
    </section>
  );
}

/**
 * At a narrow window the rail falls below the text and its request box (review, low 5): a
 * line near the top says how the checks stand and leads to them.
 */
function ChecksSummary({ detail, version }: { detail: SectionDetail; version: SectionVersion }) {
  const { t } = useTranslation();
  const count = checkStructure(version.text, detail.shape).length + findMarkers(version.text).length + (version.consistency?.status === "found" ? version.consistency.items.length : 0);
  return (
    <a
      href="#section-checks"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("section-checks")?.scrollIntoView();
      }}
      className="text-sm font-medium text-accent underline underline-offset-2 @split:hidden"
    >
      {count === 0 ? t("section.checksSummaryClear") : t("section.checksSummary", { count })}
    </a>
  );
}

function structureIssueText(t: TFunction, issue: StructureIssue): string {
  if (issue.kind === "paragraphs") return t("section.structureParagraphs", { count: issue.count, min: issue.min, max: issue.max });
  if (issue.kind === "words") return t("section.structureWords", { count: issue.count, min: issue.min, max: issue.max });
  return t("section.structureFormatting", { number: issue.paragraph + 1 });
}

