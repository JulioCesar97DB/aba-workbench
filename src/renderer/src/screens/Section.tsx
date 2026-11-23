import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router";
import type { DraftingProvider } from "../../../shared/api.ts";
import { modelLabel } from "../../../shared/models.ts";
import { findReportSection, REPORT_SECTIONS, type ReportSection } from "../../../shared/report-sections.ts";
import { checkStructure, findMarkers, hasLinesInParagraphs, linesAsParagraphs, MAX_REQUEST_LENGTH, splitParagraphs, type StructureIssue } from "../../../shared/section-text.ts";
import type { SectionDetail, SectionRequestInput, SectionSummary, SectionVersion } from "../../../shared/sections.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import type { FailedSave } from "../../../shared/sources.ts";
import { onRetried, retry, useFailedSavesLoaded, useSectionFailures } from "../case-saves.tsx";
import { casePath } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { ButtonLink } from "../components/Link.tsx";
import { Select } from "../components/Select.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { useConnections } from "../connections.tsx";
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
import { sourceName, sourceNameLang } from "../source-labels.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

/*
 * One section of the report (#/cases/<id>/report/<section id>), as in the approved
 * mockups (direction C, "Flujo 1" and "Flujo 2"): start it by pasting what she already
 * wrote in ABA Matrix or by drafting it with the AI; then read it, mark a paragraph to
 * change only that one, ask for changes in her own words, edit it, go back to any
 * version, approve it and copy it for ABA Matrix. The rail holds her standing
 * instructions for the section, the sources used and the checks.
 *
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

function SectionLoader({ caseId, section }: { caseId: string; section: ReportSection }) {
  const { t } = useTranslation();
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
      <WorkArea header={<PageHeader title={section.title} titleLang="en" />}>
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

/** The connected providers, and the one to write with: the last she used when it is still connected. */
function useProviders(): { available: DraftingProvider[]; provider: DraftingProvider | null; choose: (provider: DraftingProvider) => void } {
  const { connections } = useConnections();
  const [chosen, setChosen] = useState<DraftingProvider | null>(null);
  const [last, setLast] = useState<DraftingProvider | null>(null);
  useEffect(() => {
    let live = true;
    window.aba.getAiPreferences().then(
      (preferences) => {
        if (live) setLast(preferences.lastProvider);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const available: DraftingProvider[] = [];
  if (connections && !connections.problem) {
    if (connections.claude.state === "connected") available.push("anthropic");
    if (connections.chatgpt.state === "connected") available.push("openai");
  }
  const pick = [chosen, last].find((candidate): candidate is DraftingProvider => candidate !== null && available.includes(candidate));
  return { available, provider: pick ?? available[0] ?? null, choose: setChosen };
}

const PROVIDER_NAMES: Record<DraftingProvider, string> = { anthropic: "Claude", openai: "ChatGPT" };

function SectionWorkspace({ caseId, section, initial }: { caseId: string; section: ReportSection; initial: SectionDetail }) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const patch = usePatchOpenedCase();
  const [detail, setDetail] = useState(initial);
  const generation = useSectionGeneration(caseId, section.id);
  const running = isRunning(generation);
  // While the AI only checks the new version against her sections, she can already read, compare, approve and copy.
  const writing = running && generation?.phase !== "checking";
  const [mode, setMode] = useState<Mode>(initial.versions.length === 0 ? "choose" : "view");
  const [viewed, setViewed] = useState<number | null>(initial.currentVersion);
  const [actionFailed, setActionFailed] = useState(false);
  const [copied, setCopied] = useState<Copied | "failed" | null>(null);
  const failures = useSectionFailures(caseId);
  // Her text for this section that could not be saved: after a reload it goes back in the editor it came from (review round 2, B3).
  // The newest of them (the list is oldest first): never an older text over a newer one (review round 3, R3-1).
  const keptText = failures.filter((item) => item.about === "section" && item.sectionId === section.id && item.text !== null).at(-1) ?? null;
  const [keptOpen, setKeptOpen] = useState<FailedSave | null>(null);
  const setSources = useSetCaseSources();
  const providers = useProviders();
  /** The version her pasted text made, once saved. */
  const editingSaved = useRef<number | null>(null);

  const accept = useCallback(
    (next: SectionDetail, sections?: SectionSummary[]) => {
      setDetail(next);
      setViewed(next.currentVersion);
      // A version saved from elsewhere (Try again after a reload) shows the text instead of the two ways to start.
      setMode((current) => (current === "choose" && next.versions.length > 0 ? "view" : current));
      if (sections) patch(caseId, { sections });
    },
    [caseId, patch],
  );

  useOnSectionSaved(
    useCallback(
      (savedCase: string, result, kind) => {
        if (savedCase !== caseId || result.section.id !== section.id) return;
        setDetail(result.section);
        // A check only adds its result: she stays on the version and the mode she is in.
        if (kind === "check") return;
        setViewed(result.section.currentVersion);
        setMode("view");
      },
      [caseId, section.id],
    ),
  );

  // Adjusted while rendering (React's pattern for state that follows other state), once per kept text.
  if (keptText && keptOpen?.id !== keptText.id && mode !== "paste" && mode !== "edit") {
    setKeptOpen(keptText);
    setMode(detail.versions.length === 0 ? "paste" : "edit");
  }

  const current = detail.versions.find((version) => version.number === viewed) ?? detail.versions.at(-1) ?? null;
  const number = REPORT_SECTIONS.indexOf(section) + 1;

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
    // Only the newest action's answer moves the version shown. An older answer that comes
    // back late (a slow disk) keeps its data but must not undo what she chose since: Approve,
    // then version 1 at once, would otherwise jump back to version 2, and Copy copy it.
    if (action === actionsStarted.current) accept(result.section, result.sections);
    else {
      setDetail(result.section);
      if (result.sections) patch(caseId, { sections: result.sections });
    }
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
        if (item.about === "notes") return;
        void window.aba.getSection(caseId, section.id).then((result) => {
          if (result.outcome === "read") accept(result.section);
        });
      }),
    [caseId, section.id, accept],
  );

  async function copy() {
    if (!current) return;
    const result = await window.aba.copySection(caseId, section.id, current.number).catch(() => null);
    // The message names the version copied, and the approved one when it is another (review M6):
    // that one is read when the message shows (CopiedMessage), so an approval still being saved is named too.
    setCopied(result?.outcome === "copied" ? { markers: result.markers, number: current.number } : "failed");
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

  const approvedHere = current !== null && detail.approvedVersion === current.number;
  const header = (
    <PageHeader
      title={section.title}
      titleLang="en"
      afterTitle={
        mode === "view" || mode === "edit" ? <VersionBar detail={detail} current={current} disabled={writing || mode === "edit"} onShow={(n) => void show(n)} /> : null
      }
      meta={mode === "view" && current ? <VersionLine version={current} /> : `${opened.label} · ${t("workspace.sectionPosition", { number, total: REPORT_SECTIONS.length })}`}
      actions={
        mode === "view" && current && !writing ? (
          <>
            {approvedHere ? (
              <Button onClick={() => void act(() => window.aba.approveSection(caseId, section.id, null))}>{t("section.unapprove")}</Button>
            ) : (
              <Button onClick={() => void act(() => window.aba.approveSection(caseId, section.id, current.number))}>{t("section.approve")}</Button>
            )}
            <Button variant="primary" onClick={() => void copy()}>
              {t("section.copy")}
            </Button>
          </>
        ) : null
      }
    />
  );

  return (
    <WorkArea
      header={header}
      rail={
        <SectionRail
          caseId={caseId}
          section={section}
          detail={detail}
          current={mode === "view" ? current : null}
          checking={generation?.phase === "checking"}
          canCheck={providers.provider !== null && !running}
          onRecheck={(version) => void recheck(version)}
        />
      }
    >
      <div className="flex max-w-measure flex-col gap-4">
        <NotReadyNotice />
        {failures.map((item) => (
          <div key={item.id} role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-danger px-3.5 py-2 text-md font-medium text-danger">
            <span>{t(`section.failedSave.${item.about === "source" ? "section" : item.about}`)}</span>
            <Button size="sm" onClick={() => retry(item, (sources) => setSources(caseId, sources))}>
              {t("sources.tryAgain")}
            </Button>
          </div>
        ))}
        {mode === "view" && current ? <ChecksSummary detail={detail} version={current} /> : null}
        {actionFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("section.actionFailed")}
          </p>
        ) : null}
        <CopiedMessage copied={copied} approvedVersion={detail.approvedVersion} />
        {approvedHere ? (
          <p className="flex items-center gap-2 text-sm">
            <StatusBadge tone="success">{t("section.approvedBadge")}</StatusBadge>
          </p>
        ) : detail.approvedVersion !== null ? (
          <p className="text-sm text-fg-muted">{t("section.approvedOther", { number: detail.approvedVersion })}</p>
        ) : null}
        {detail.versions.length === 0 && generation && !running && mode !== "paste" ? <GenerationOutcomeMessage generation={generation} /> : null}
        {detail.versions.length === 0 && !running && mode !== "paste" ? (
          <StartChooser canDraft={providers.provider !== null} onPaste={() => setMode("paste")} onDraft={() => void run({ kind: "draft" })} />
        ) : null}
        {mode === "paste" ? (
          <OwnTextEditor
            caseId={caseId}
            sectionId={section.id}
            initialText={keptOpen?.text ?? ""}
            savedValue={keptOpen ? null : ""}
            keptId={keptOpen?.id ?? null}
            editing={keptOpen?.editing ?? null}
            label={t("section.herTextLabel")}
            hint={t("section.herTextHint")}
            onSaved={(next, sections) => {
              editingSaved.current = next.currentVersion;
              accept(next, sections);
            }}
            onTreatLines={async (text, flush) => {
              if (await flush()) await linesToParagraphs(text);
            }}
            footer={(saved, flush) => (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={async () => {
                      await flush();
                      setMode(editingSaved.current !== null ? "view" : "choose");
                    }}
                  >
                    {t("section.keepAsIs")}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={saved === null || providers.provider === null}
                    onClick={async () => {
                      await flush();
                      if (editingSaved.current !== null) void run({ kind: "improve", fromVersion: editingSaved.current });
                    }}
                  >
                    {t("section.improve")}
                  </Button>
                </div>
                <p className="text-sm text-fg-muted">{t("section.improveHint")}</p>
              </>
            )}
          />
        ) : null}
        {mode === "edit" && current ? (
          <OwnTextEditor
            caseId={caseId}
            sectionId={section.id}
            initialText={keptOpen?.text ?? current.text}
            savedValue={keptOpen ? null : current.text}
            keptId={keptOpen?.id ?? null}
            editing={keptOpen?.editing ?? null}
            label={t("section.herTextLabel")}
            hint={t("section.editHint")}
            onSaved={accept}
            onTreatLines={async (text, flush) => {
              if (await flush()) await linesToParagraphs(text);
            }}
            footer={(_saved, flush) => (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={async () => {
                    await flush();
                    setKeptOpen((open) => (open && keptText?.id === open.id ? open : null));
                    setMode("view");
                  }}
                >
                  {t("section.doneEditing")}
                </Button>
              </div>
            )}
          />
        ) : null}
        {mode === "view" && current && !writing && hasLinesInParagraphs(current.text) ? (
          <LinesNotice onTreat={() => void linesToParagraphs(current.text)} />
        ) : null}
        {(mode === "view" && detail.versions.length > 0) || running ? (
          <SectionView
            key={current?.number ?? "none"}
            version={current}
            generation={generation}
            canGenerate={providers.provider !== null}
            onRequest={(request) => void run(request)}
            onEdit={() => setMode("edit")}
            nextNumber={detail.versions.reduce((max, v) => Math.max(max, v.number), 0) + 1}
          />
        ) : null}
        <ProviderLine providers={providers} />
      </div>
    </WorkArea>
  );
}

/** The plain warning that the app is not ready for real client data: de-identification is not plugged in yet. */
function NotReadyNotice() {
  const { t } = useTranslation();
  return (
    <div data-testid="not-ready-notice" className="flex flex-col gap-1 rounded-md border border-warning bg-warning-subtle px-3.5 py-2.5 text-warning">
      <p className="text-sm font-semibold">{t("section.notReadyTitle")}</p>
      <p className="text-sm">{t("section.notReadyBody")}</p>
    </div>
  );
}

interface Copied {
  markers: number;
  number: number;
}

/** What was copied; the section's approved version as it is now, named when it is not the one copied. */
function CopiedMessage({ copied, approvedVersion }: { copied: Copied | "failed" | null; approvedVersion: number | null }) {
  const { t } = useTranslation();
  const approvedOther = copied !== null && copied !== "failed" && approvedVersion !== null && approvedVersion !== copied.number ? approvedVersion : null;
  const text =
    copied === null
      ? null
      : copied === "failed"
        ? t("section.copyFailed")
        : [
            copied.markers > 0 ? t("section.copiedMarkers", { count: copied.markers, number: copied.number }) : t("section.copied", { number: copied.number }),
            approvedOther !== null ? t("section.copiedNotApproved", { number: approvedOther }) : null,
          ]
            .filter(Boolean)
            .join(" ");
  return (
    <p role="status" className={cn("text-sm font-medium", copied === "failed" || approvedOther !== null ? "text-warning" : "text-success", copied === "failed" && "text-danger")}>
      {text}
    </p>
  );
}

/** Text with single line breaks reads as one paragraph (review M3): say so, and offer each line as a paragraph. */
function LinesNotice({ onTreat }: { onTreat: () => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid="lines-notice" className="flex flex-col items-start gap-2 rounded-md border border-border-control bg-surface-muted px-3.5 py-2.5 text-sm">
      <p>{t("section.linesNotice")}</p>
      <Button size="sm" onClick={onTreat}>
        {t("section.treatLines")}
      </Button>
    </div>
  );
}

/** Which AI writes, and how to connect one when none is. */
function ProviderLine({ providers }: { providers: ReturnType<typeof useProviders> }) {
  const { t } = useTranslation();
  if (providers.available.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{t("section.notConnected")}</span>
        <ButtonLink to="/settings" size="sm">
          {t("section.openSettings")}
        </ButtonLink>
      </div>
    );
  }
  if (providers.available.length === 1 || !providers.provider) {
    return (
      <p className="text-xs text-fg-muted">
        {t("section.providerLabel")}: {PROVIDER_NAMES[providers.available[0]]}
      </p>
    );
  }
  return (
    <div className="max-w-60">
      <Select
        label={t("section.providerLabel")}
        value={providers.provider}
        options={providers.available.map((id) => ({ value: id, label: PROVIDER_NAMES[id] }))}
        onValueChange={(value) => providers.choose(value)}
      />
    </div>
  );
}

function StartChooser({ canDraft, onPaste, onDraft }: { canDraft: boolean; onPaste: () => void; onDraft: () => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  const card = "flex flex-col items-start gap-1.5 rounded-lg border border-border-control bg-surface p-4 text-left hover:bg-surface-muted data-disabled:cursor-not-allowed data-disabled:opacity-60";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-md font-semibold">
        {t("section.startHeading")}
      </h2>
      <div className="grid gap-3 @split:grid-cols-2">
        <button type="button" className={card} onClick={onPaste}>
          <span className="text-md font-semibold">{t("section.alreadyWroteTitle")}</span>
          <span className="text-sm text-fg-muted">{t("section.alreadyWroteBody")}</span>
        </button>
        <button type="button" className={card} onClick={onDraft} disabled={!canDraft} data-disabled={!canDraft || undefined}>
          <span className="text-md font-semibold">{t("section.draftTitle")}</span>
          <span className="text-sm text-fg-muted">{t("section.draftBody")}</span>
        </button>
      </div>
    </section>
  );
}

/**
 * Her own text: pasted from ABA Matrix, or an edit of a version. Saved as she types, as
 * one version per editing pass (the first save makes it; the next ones update it).
 */
function OwnTextEditor({
  caseId,
  sectionId,
  initialText,
  savedValue,
  keptId,
  editing: initialEditing,
  label,
  hint,
  onSaved,
  onTreatLines,
  footer,
}: {
  caseId: string;
  sectionId: ReportSection["id"];
  initialText: string;
  /** What is on disk, when the box starts from a kept text instead (null: nothing of it saved yet). */
  savedValue: string | null;
  /** The kept text it starts from (review round 2, B3), told to the main process once shown. */
  keptId: string | null;
  editing: number | null;
  label: string;
  hint: string;
  onSaved: (detail: SectionDetail, sections?: ReturnType<typeof useOpenedCase>["sections"]) => void;
  onTreatLines: (text: string, flush: () => Promise<boolean>) => Promise<void>;
  footer: (saved: number | null, flush: () => Promise<boolean>) => ReactNode;
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="font-medium">
          {label}
        </label>
        <textarea
          id={fieldId}
          lang="en"
          aria-describedby={hintId}
          data-testid="section-text"
          readOnly={!listLoaded}
          value={text.value}
          onChange={(event) => text.setValue(event.target.value)}
          onBlur={() => void text.flush()}
          className="min-h-[22rem] w-full resize-y rounded-md border border-border-control bg-surface px-3 py-2 text-md text-fg"
        />
        <p id={hintId} className="text-sm text-fg-muted">
          {text.status === "saving" ? t("sources.saving") : hint}
        </p>
        {text.status === "failed" ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
            {t("section.actionFailed")}
            <Button size="sm" onClick={() => void text.retry()}>
              {t("sources.tryAgain")}
            </Button>
          </p>
        ) : null}
      </div>
      {hasLinesInParagraphs(text.value) ? <LinesNotice onTreat={() => void onTreatLines(text.value, text.flush)} /> : null}
      {footer(saved, text.flush)}
    </div>
  );
}

/** The version buttons beside the title: v1 v2 v3, the shown one pressed. */
function VersionBar({ detail, current, disabled, onShow }: { detail: SectionDetail; current: SectionVersion | null; disabled: boolean; onShow: (number: number) => void }) {
  const { t } = useTranslation();
  if (detail.versions.length === 0) return null;
  return (
    <div role="group" aria-label={t("section.versionsLabel")} className="flex flex-wrap gap-1">
      {detail.versions.map((version) => (
        <Button
          key={version.number}
          size="sm"
          aria-label={
            detail.approvedVersion === version.number
              ? t("section.versionButtonApproved", { number: version.number })
              : version.kind === "hers"
                ? t("section.versionButtonHers", { number: version.number })
                : t("section.versionButton", { number: version.number })
          }
          aria-pressed={current?.number === version.number}
          disabled={disabled}
          onClick={() => onShow(version.number)}
          className="min-w-10 font-mono aria-pressed:border-fg aria-pressed:bg-fg aria-pressed:text-surface aria-pressed:hover:bg-fg"
        >
          v{version.number}
        </Button>
      ))}
    </div>
  );
}

export function versionLabel(t: ReturnType<typeof useTranslation>["t"], version: SectionVersion): string {
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

function shorten(text: string, length = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1).trimEnd()}…`;
}

/** An amount in dollars, as the screen's language writes it: "$0.18", "0,18 US$". */
export function formatUsd(language: string, amount: number): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: amount > 0 && amount < 0.1 ? 3 : 2 }).format(amount);
}

/** "v3: “shorter, and mention the school”", who wrote it and what it cost. */
function VersionLine({ version }: { version: SectionVersion }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const cost = version.costUsd === null ? null : formatUsd(language, version.costUsd);
  return (
    <span>
      {t("section.versionMeta", { number: version.number, label: versionLabel(t, version) })}
      {version.model ? ` · ${t("section.writtenBy", { model: modelLabel(version.model) })}` : ""}
      {cost ? ` · ${cost}` : ""}
    </span>
  );
}

/**
 * The text: the version shown, or the AI's text as it streams in. Each paragraph can be
 * selected (click, or Enter/Space) to ask for a change to that paragraph only.
 */
function SectionView({
  version,
  generation,
  canGenerate,
  onRequest,
  onEdit,
  nextNumber,
}: {
  version: SectionVersion | null;
  generation: SectionGeneration | null;
  canGenerate: boolean;
  onRequest: (request: SectionRequestInput) => void;
  onEdit: () => void;
  nextNumber: number;
}) {
  const { t } = useTranslation();
  const running = isRunning(generation);
  const streaming = running && generation !== null && generation.phase !== "checking";
  const [marked, setMarked] = useState<number | null>(null);
  const [paragraphRequest, setParagraphRequest] = useState("");
  const [request, setRequest] = useState("");
  const askId = useId();
  const askHintId = useId();
  const paragraphs = useMemo(() => splitParagraphs(version?.text ?? ""), [version?.text]);
  const markedRef = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const describedBy = useId();

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

  if (streaming && generation) {
    const asked = generation.request;
    const markedIndex = asked?.kind === "paragraph" ? asked.paragraphIndex : null;
    const streamed = markedIndex !== null ? null : splitParagraphs(generation.text);
    return (
      <div className="flex flex-col gap-4">
        <GenerationStatus generation={generation} />
        <div lang="en" aria-busy="true" data-testid="streaming-text" className="flex flex-col gap-4 text-md">
          {(streamed ?? paragraphs).map((paragraph, index) =>
            index === markedIndex ? (
              <p key={index} className="rounded-md border border-accent bg-mark px-2.5 py-1.5 whitespace-pre-line">
                {generation.text || paragraph}
              </p>
            ) : (
              <p key={index} className="whitespace-pre-line">
                {paragraph}
              </p>
            ),
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {generation && generation.phase === "done" ? <GenerationOutcomeMessage generation={generation} /> : null}
      {generation?.phase === "checking" ? <GenerationStatus generation={generation} /> : null}
      {version ? (
        <>
          <div lang="en" data-testid="section-view" className="flex flex-col gap-3 text-md">
            {paragraphs.map((paragraph, index) => (
              <div key={index} ref={marked === index ? markedRef : undefined} className="flex flex-col gap-2">
                <p
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
                    "-mx-2.5 cursor-pointer rounded-md border px-2.5 py-1.5 whitespace-pre-line",
                    marked === index ? "border-accent bg-mark" : "border-transparent hover:bg-surface-muted",
                  )}
                >
                  <Highlighted text={paragraph} />
                </p>
                {marked === index ? (
                  <form
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2 shadow-popup"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const asked = paragraphRequest.trim();
                      if (!asked) return;
                      onRequest({ kind: "paragraph", fromVersion: version.number, paragraphIndex: index, request: asked });
                      setParagraphRequest("");
                      setMarked(null);
                      // The text is replaced while the AI writes: the focus goes to Stop (GenerationStatus).
                    }}
                  >
                    <label htmlFor={`paragraph-${index}`} className="text-sm font-semibold">
                      {t("section.changeParagraph")}
                    </label>
                    <input
                      id={`paragraph-${index}`}
                      value={paragraphRequest}
                      maxLength={MAX_REQUEST_LENGTH}
                      placeholder={t("section.changeParagraphPlaceholder")}
                      onChange={(event) => setParagraphRequest(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeMarked(index);
                      }}
                      className="min-h-control min-w-48 flex-1 rounded-md border border-border-control bg-surface px-3 text-base"
                    />
                    <Button type="submit" variant="primary" disabled={!canGenerate || paragraphRequest.trim() === ""} className="bg-fg hover:bg-fg">
                      {t("section.changeButton")}
                    </Button>
                    <Button onClick={() => closeMarked(index)}>{t("section.cancel")}</Button>
                  </form>
                ) : null}
                <span id={`${describedBy}-${index}`} className="sr-only">
                  {t("section.selectParagraph", { number: index + 1 })}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
            <span>{t("section.paragraphHint")}</span>
            <Button size="sm" onClick={onEdit}>
              {t("section.edit")}
            </Button>
          </div>
          <form
            className="mt-4 flex flex-col gap-2 border-t border-border pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              const asked = request.trim();
              if (!asked) return;
              onRequest({ kind: "change", fromVersion: version.number, request: asked });
              setRequest("");
            }}
          >
            <label htmlFor={askId} className="text-md font-semibold">
              {t("section.askHeading")}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={askId}
                aria-describedby={askHintId}
                value={request}
                maxLength={MAX_REQUEST_LENGTH}
                placeholder={t("section.askPlaceholder")}
                onChange={(event) => setRequest(event.target.value)}
                className="min-h-control min-w-60 flex-1 rounded-md border border-border-control bg-surface px-3 text-base"
              />
              <Button type="submit" variant="primary" disabled={!canGenerate || request.trim() === ""}>
                {t("section.createVersion", { number: nextNumber })}
              </Button>
            </div>
            <p id={askHintId} className="text-sm text-fg-muted">
              {t("section.askHint")}
            </p>
          </form>
        </>
      ) : null}
    </div>
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

/** "The AI is writing…" and Stop. */
function GenerationStatus({ generation }: { generation: SectionGeneration }) {
  const { t } = useTranslation();
  const stop = useRef<HTMLButtonElement>(null);
  const checking = generation.phase === "checking";
  // The paragraph or the request box that had the focus is gone while the AI writes: Stop takes it (review, low 3).
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) stop.current?.focus();
  }, []);
  const text = checking ? t("section.checking") : generation.phase === "writing" ? t("section.writing") : t("section.thinking");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-sm font-medium">
        {text}
      </p>
      {/* While only the check runs, the version is already saved: stopping skips the check (review M5). */}
      <Button ref={stop} size="sm" onClick={() => stopSectionGeneration(generation)}>
        {checking ? t("section.skipCheck") : t("section.stop")}
      </Button>
    </div>
  );
}

function GenerationOutcomeMessage({ generation }: { generation: SectionGeneration }) {
  const { t } = useTranslation();
  const outcome = generation.outcome;
  if (!outcome || outcome.kind === "saved" || outcome.kind === "checked") return null;
  if (outcome.kind === "saved-before-stop") {
    return (
      <p role="status" className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-fg">
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
                : t("section.failed", { message: outcome.message || t("section.unknownError") });
  // A failed request can be sent again as it was (the first Improve of the real runs failed on a dropped connection, 2026-11-23).
  const canRetry = outcome.kind === "failed" && generation.request !== null;
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-3 rounded-md border px-3.5 py-2", outcome.kind === "stopped" ? "border-border" : "border-danger")}>
      <p className={cn("text-sm font-medium", outcome.kind === "stopped" ? "text-fg" : "text-danger")}>{message}</p>
      {canRetry ? (
        <Button size="sm" data-testid="section-try-again" onClick={() => void retrySectionGeneration(generation)}>
          {t("sources.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}

/** The rail: her standing instructions for the section, the sources used, and the checks. */
function SectionRail({
  caseId,
  section,
  detail,
  current,
  checking,
  canCheck,
  onRecheck,
}: {
  caseId: string;
  section: ReportSection;
  detail: SectionDetail;
  current: SectionVersion | null;
  checking: boolean;
  canCheck: boolean;
  onRecheck: (version: number) => void;
}) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const instructionsId = useId();
  const hintId = useId();
  const sourcesId = useId();
  const checksId = useId();
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
  const caseSources = opened.sources.sources.filter((source) => !source.removedAt);
  const used = current && current.sourcesUsed.length > 0 ? current.sourcesUsed : null;
  return (
    <>
      <section aria-labelledby={instructionsId} className="flex flex-col gap-1.5">
        <Eyebrow id={instructionsId} className="text-fg-muted">
          {t("section.instructionsHeading")}
        </Eyebrow>
        <textarea
          aria-labelledby={instructionsId}
          aria-describedby={hintId}
          data-testid="section-instructions"
          readOnly={!instructionsReady}
          value={instructions.value}
          placeholder={t("section.instructionsPlaceholder")}
          onChange={(event) => instructions.setValue(event.target.value)}
          onBlur={() => void instructions.flush()}
          rows={4}
          className="min-h-24 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-fg"
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
      <section aria-labelledby={sourcesId} className="flex flex-col gap-1.5">
        <Eyebrow id={sourcesId} className="text-fg-muted">
          {t("section.sourcesUsedHeading")}
        </Eyebrow>
        {used ? (
          <ul className="flex flex-col gap-1 text-sm">
            {used.map((entry) => {
              // Named as the Sources step names it; a source changed or gone since keeps the name it was sent with.
              const source = opened.sources.sources.find((candidate) => candidate.id === entry.id);
              return (
                <li key={entry.id} className="flex gap-1.5 break-words">
                  <span aria-hidden="true">☑</span>
                  {source ? <span lang={sourceNameLang(source)}>{sourceName(t, source)}</span> : <span lang="en">{entry.title}</span>}
                </li>
              );
            })}
          </ul>
        ) : caseSources.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {caseSources.map((source) => (
              <li key={source.id} className="flex gap-1.5 break-words">
                <span aria-hidden="true">☑</span>
                <span lang={sourceNameLang(source)}>{sourceName(t, source)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{t("rail.noSources")}</p>
        )}
      </section>
      <section id="section-checks" aria-labelledby={checksId} className="flex scroll-mt-20 flex-col gap-1.5">
        <Eyebrow id={checksId} className="text-fg-muted">
          {t("section.checksHeading")}
        </Eyebrow>
        <SectionChecks detail={detail} version={current} checking={checking} canCheck={canCheck} onRecheck={onRecheck} />
      </section>
    </>
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

/** Whether a version is the AI's (or her edit of one): the versions the consistency check is for. */
function checkable(version: SectionVersion): boolean {
  return version.kind !== "hers" && (version.kind !== "edited" || version.consistency !== null || version.model !== null);
}

/**
 * At a narrow window the rail falls below the text and its request box (review, low 5): a
 * line near the top says how the checks stand and leads to them.
 */
function ChecksSummary({ detail, version }: { detail: SectionDetail; version: SectionVersion }) {
  const { t } = useTranslation();
  const count = checkStructure(version.text, detail.shape).length + findMarkers(version.text).length + (version.consistency?.status === "found" ? version.consistency.items.length : 0);
  return (
    <a href="#section-checks" onClick={(event) => { event.preventDefault(); document.getElementById("section-checks")?.scrollIntoView(); }} className="text-sm font-medium text-accent underline underline-offset-2 @split:hidden">
      {count === 0 ? t("section.checksSummaryClear") : t("section.checksSummary", { count })}
    </a>
  );
}

function SectionChecks({ detail, version, checking, canCheck, onRecheck }: { detail: SectionDetail; version: SectionVersion | null; checking: boolean; canCheck: boolean; onRecheck: (version: number) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  if (!version) {
    return <p className="text-sm text-fg-muted">{t("section.nothingToCheck")}</p>;
  }
  const issues = checkStructure(version.text, detail.shape);
  const markers = findMarkers(version.text);
  const consistency = version.consistency;
  const consistencyText = checking
    ? t("section.checking")
    : !consistency
      ? t("section.consistencyNotChecked")
      : consistency.status === "none"
        ? t("section.consistencyNone")
        : consistency.status === "found"
          ? t("section.consistencyFound", { count: consistency.items.length })
          : consistency.status === "nothing-to-compare"
            ? t("section.consistencyNothing")
            : t("section.consistencyFailed");
  return (
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
      <CheckRow name={t("section.checkMissing")} value={markers.length === 0 ? t("section.missingNone") : t("section.missingCount", { count: markers.length })} tone={markers.length === 0 ? "success" : "warning"}>
        {markers.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-xs">
            {markers.map((marker, index) => (
              <li key={index}>
                <span className="font-semibold">{marker.kind === "missing" ? t("section.markerMissing") : t("section.markerCheck")}</span>{" "}
                <span lang="en">{marker.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CheckRow>
      <CheckRow
        name={t("section.checkConsistency")}
        value={consistencyText}
        tone={checking || !consistency || consistency.status === "nothing-to-compare" || consistency.status === "failed" ? "neutral" : consistency.status === "none" ? "success" : "warning"}
      >
        {consistency?.status === "found" ? (
          <ul lang="en" className="flex flex-col gap-0.5 text-xs">
            {consistency.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : null}
        {consistency?.stale && !checking ? <p className="text-xs text-warning">{t("section.consistencyStale")}</p> : null}
        {version.checkCostUsd !== null && !checking ? (
          <p className="text-xs text-fg-muted">{t("section.checkCost", { cost: formatUsd(language, version.checkCostUsd) })}</p>
        ) : null}
        {!checking && checkable(version) && (!consistency || consistency.status === "failed" || consistency.stale) ? (
          <Button size="sm" className="self-start" disabled={!canCheck} onClick={() => onRecheck(version.number)}>
            {t("section.checkAgain")}
          </Button>
        ) : null}
      </CheckRow>
    </div>
  );
}

function structureIssueText(t: ReturnType<typeof useTranslation>["t"], issue: StructureIssue): string {
  if (issue.kind === "paragraphs") return t("section.structureParagraphs", { count: issue.count, min: issue.min, max: issue.max });
  if (issue.kind === "words") return t("section.structureWords", { count: issue.count, min: issue.min, max: issue.max });
  return t("section.structureFormatting", { number: issue.paragraph + 1 });
}
