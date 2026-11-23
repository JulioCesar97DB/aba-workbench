import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { checkCaseLabel, type CaseList, type CaseProgress, type CasesFolderInfo, type CaseSummary, type ClientAge, type Language, type ListedCase, type UnreadableFolder } from "../../../shared/api.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { CASE_STEPS, casePath, caseSummaryPath, stepTitle, type CaseStep } from "../case-steps.tsx";
import { casesFolderProblemText, useShowInFolderLabel } from "../cases-folder.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { StepProgressBar } from "../components/StepMarks.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TextField } from "../components/TextField.tsx";
import { useProviders } from "../drafting-provider.tsx";
import { formatAge, formatDate, formatShortDate, formatTime, relativeDay } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { useFailedSaves } from "../case-saves.tsx";
import { currentStep, nextThing, nextThingPath, stepStates, type NextInputs, type NextThing } from "../next-thing.ts";
import { useNextWords } from "../next-thing-words.tsx";
import { readySections } from "../step-states.ts";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";

type ListState = { status: "loading" } | { status: "error" } | { status: "loaded"; list: CaseList };

/**
 * Home (owner's proposal §4, mockup 01): "Sigue donde lo dejaste" with the last case and its
 * next thing, then one row per case with its step and progress in words and the five-segment
 * bar; below them the folders in the cases folder that cannot be opened as cases. With no
 * case, what a case is and "Nuevo caso"; with no AI connected, "Conecta la IA" (P7). The main
 * process reads the folder and each case's progress (T7: computed, nothing stored); this
 * screen only shows what it reports.
 */
export function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const load = useCallback(() => {
    window.aba.listCases().then(
      (list) => setState({ status: "loaded", list }),
      () => setState({ status: "error" }),
    );
  }, []);
  useEffect(load, [load]);
  // "Nuevo caso" is the primary action only while there is no case to continue (§4).
  const hasCases = state.status === "loaded" && state.list.cases.length > 0;

  return (
    <WorkArea
      header={
        <PageHeader
          title={t("home.title")}
          actions={<NewCaseDialog open={newCaseOpen} onOpenChange={setNewCaseOpen} primary={!hasCases} onCreated={(created) => navigate(casePath(created.id))} />}
        />
      }
      contentClassName="max-w-list"
    >
      <div className="flex flex-col gap-6">
        <UnsavedChanges />
        {state.status === "loading" ? (
          <p role="status" className="text-md text-fg-muted">
            {t("home.loading")}
          </p>
        ) : null}
        {state.status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-md">
              {t("home.loadFailed")}
            </p>
            <Button
              onClick={() => {
                setState({ status: "loading" });
                load();
              }}
            >
              {t("home.retry")}
            </Button>
          </div>
        ) : null}
        {state.status === "loaded" ? <CasesView list={state.list} onFolderChosen={load} onNewCase={() => setNewCaseOpen(true)} /> : null}
      </div>
    </WorkArea>
  );
}

/** A change to a case that could not be saved after the clinician left it: never silently lost. */
function UnsavedChanges() {
  const { t } = useTranslation();
  const failed = useFailedSaves();
  if (failed.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger px-3.5 py-2.5 text-md">
      {failed.map((item) => (
        <p key={item.caseId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium text-danger">{t("home.unsavedChange", { label: item.label })}</span>
          <TextLink to={caseSummaryPath(item.caseId)}>{t("home.openToTryAgain")}</TextLink>
        </p>
      ))}
    </div>
  );
}

function CasesView({ list, onFolderChosen, onNewCase }: { list: CaseList; onFolderChosen: () => void; onNewCase: () => void }) {
  const { folder, cases, unreadable } = list;
  const usable = folder.state === "ready" || folder.state === "not-created-yet" || folder.state === "not-writable";
  const providers = useProviders();
  const noAi = !providers.loading && providers.available.length === 0;
  const unsaved = new Set(useFailedSaves().map((item) => item.caseId));
  // The list comes with the case saved last first (owner's decision on review round 1, S1): that one is to continue.
  const last = cases.at(0);
  return (
    <>
      {usable && folder.state !== "not-writable" ? null : <FolderProblem folder={folder} onChosen={onFolderChosen} />}
      {usable && cases.length === 0 && unreadable.length === 0 ? (
        <>
          <EmptyState onNewCase={onNewCase} />
          {noAi ? <ConnectAi layout="card" /> : null}
        </>
      ) : null}
      {last ? <ContinueCard item={last} unsaved={unsaved.has(last.id)} /> : null}
      {cases.length > 0 && noAi ? <ConnectAi layout="bar" /> : null}
      {cases.length > 0 ? <CasesList cases={cases} unsaved={unsaved} /> : null}
      {unreadable.length > 0 ? <UnreadableFolders folders={unreadable} /> : null}
    </>
  );
}

/**
 * A case's next thing and its step, from its progress; null when its progress could not be
 * read (the case is listed all the same, and opens on its summary).
 */
function caseWork(item: ListedCase, unsaved: boolean): { progress: CaseProgress; thing: NextThing; step: CaseStep | null } | null {
  if (!item.progress) return null;
  const inputs: NextInputs = { unsaved, ...item.progress };
  return { progress: item.progress, thing: nextThing(inputs), step: currentStep(inputs) };
}

/** "guardado hoy, 11:23", "ayer, 9:05", "20 nov": when the case was last saved. */
function savedWhen(t: TFunction, language: Language, iso: string): string {
  const day = relativeDay(iso);
  if (day === "today") return t("home.today", { time: formatTime(language, iso) });
  if (day === "yesterday") return t("home.yesterday", { time: formatTime(language, iso) });
  return new Date(iso).getFullYear() === new Date().getFullYear() ? formatShortDate(language, iso) : formatDate(language, iso);
}

/** The progress of the step the case is at, in a few words: "3 de 9 secciones listas". */
function progressWords(t: TFunction, progress: CaseProgress, step: CaseStep | null): string {
  const { sources, caseMap, sections } = progress;
  const total = REPORT_SECTIONS.length;
  if (step === "sources") return t("home.progress.noDocuments");
  if (step === "case-map") return caseMap.withContent === 0 ? t("home.progress.mapNotStarted", { count: sources }) : t("home.progress.mapParts", { approved: caseMap.approved, total: caseMap.withContent });
  if (step === "report") return t("home.progress.reportReady", { ready: readySections(sections), total });
  return t("home.progress.allReady", { total });
}

/** The step the case is at and its progress: "Informe · 3 de 9 secciones listas"; "Lista · …" once done. */
function stepWords(t: TFunction, work: NonNullable<ReturnType<typeof caseWork>>): string {
  return `${work.step ? stepTitle(t, work.step) : t("home.allDoneLine")} · ${progressWords(t, work.progress, work.step)}`;
}

/** "Sigue donde lo dejaste": the case saved last, its step, what comes next, and "Continuar". */
function ContinueCard({ item, unsaved }: { item: ListedCase; unsaved: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const headingId = useId();
  const labelId = useId();
  const nextId = useId();
  const work = caseWork(item, unsaved);
  const where = work
    ? `${work.step ? t("home.stepLine", { number: CASE_STEPS.indexOf(work.step) + 1, total: CASE_STEPS.length, step: stepTitle(t, work.step) }) : t("home.allDoneLine")} · ${progressWords(t, work.progress, work.step)} · `
    : "";
  return (
    <section aria-labelledby={headingId} data-testid="continue-card" className="flex flex-col gap-3 rounded-lg border border-border-control bg-surface px-5 py-4 @split:flex-row @split:items-center @split:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Eyebrow id={headingId} className="text-fg-muted">
          {t("home.continueHeading")}
        </Eyebrow>
        <p id={labelId} className="text-md font-semibold break-words">
          {item.label}
        </p>
        <p className="text-sm text-fg-muted">
          {where}
          {t("home.savedLine", { when: savedWhen(t, language, item.updatedAt) })}
        </p>
        {work ? <NextLine id={nextId} thing={work.thing} /> : null}
      </div>
      {/* Its name says the case and its next thing, not only the card's heading (review round 1, M3). */}
      <ButtonLink
        to={work ? nextThingPath(item.id, work.thing) : caseSummaryPath(item.id)}
        variant="primary"
        className="shrink-0 self-start @split:self-auto"
        aria-describedby={work ? `${labelId} ${nextId}` : labelId}
      >
        {t("home.continue")}
        <Icon name="arrow" />
      </ButtonLink>
    </section>
  );
}

function NextLine({ id, thing }: { id: string; thing: NextThing }) {
  const { t } = useTranslation();
  const words = useNextWords(thing);
  return (
    <p id={id} className="text-sm">
      {t("home.nextLine")} {words.title}
    </p>
  );
}

/** "Tus casos": one row per case, its step and progress in words, the five-segment bar, when it was saved, and Continuar or Abrir. */
function CasesList({ cases, unsaved }: { cases: ListedCase[]; unsaved: Set<string> }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="flex items-baseline gap-2 text-base font-semibold">
        {t("home.listHeading")}
        <span className="font-mono text-sm font-normal text-fg-muted">{cases.length}</span>
      </h2>
      <ul data-testid="cases-list" className="flex flex-col rounded-lg border border-border">
        {cases.map((item) => (
          <CaseRow key={item.id} item={item} unsaved={unsaved.has(item.id)} />
        ))}
      </ul>
      <p className="text-sm text-fg-muted">
        {t("home.folderNote")} <TextLink to="/settings">{t("home.folderNoteLink")}</TextLink>
      </p>
    </section>
  );
}

function CaseRow({ item, unsaved }: { item: ListedCase; unsaved: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const nameId = useId();
  const work = caseWork(item, unsaved);
  // Done, or its progress could not be read: "Abrir", to its summary.
  const open = !work || work.thing.kind === "all-ready";
  const age = formatAge(t, language, item.clientAge) ?? t("case.ageNotGiven");
  return (
    <li data-testid="case-row" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-60 flex-col">
        <Link id={nameId} data-testid="case-name" to={caseSummaryPath(item.id)} className="self-start rounded-sm text-base font-semibold break-words text-fg underline-offset-2 hover:underline">
          {item.label}
        </Link>
        <span className="text-sm text-fg-muted">{work ? `${age} · ${stepWords(t, work)}` : age}</span>
      </div>
      {work ? <StepProgressBar steps={stepStates(work.progress)} /> : <span aria-hidden="true" className="w-32 shrink-0" />}
      <span className="w-28 shrink-0 text-right text-sm text-fg-muted">
        <span className="sr-only">{t("home.lastSaved", { when: savedWhen(t, language, item.updatedAt) })}</span>
        <time aria-hidden="true" dateTime={item.updatedAt}>
          {savedWhen(t, language, item.updatedAt)}
        </time>
      </span>
      <ButtonLink to={open || !work ? caseSummaryPath(item.id) : nextThingPath(item.id, work.thing)} size="sm" className="w-28 shrink-0" aria-describedby={nameId}>
        {open ? t("home.open") : t("home.continue")}
      </ButtonLink>
    </li>
  );
}

function EmptyState({ onNewCase }: { onNewCase: () => void }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="empty-home" className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface-muted p-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {t("home.emptyTitle")}
      </h2>
      <p className="text-md">{t("home.emptyBody")}</p>
      <Button onClick={onNewCase}>{t("home.newCase")}</Button>
      <p className="text-sm text-fg-muted">
        {t("home.folderNote")} <TextLink to="/settings">{t("home.folderNoteLink")}</TextLink>
      </p>
    </section>
  );
}

/** No AI connected: what the AI is for and where to connect it (owner's decision P7). A card on an empty Home, a slim bar above the list. */
function ConnectAi({ layout }: { layout: "card" | "bar" }) {
  const { t } = useTranslation();
  const headingId = useId();
  const button = (
    <ButtonLink to="/settings" variant="ai" size={layout === "bar" ? "sm" : "md"} data-testid="connect-ai" className="shrink-0">
      <Icon name="sparkle" />
      {t("home.connectAction")}
    </ButtonLink>
  );
  if (layout === "bar") {
    return (
      <section aria-labelledby={headingId} data-testid="connect-ai-home" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-accent bg-ai-subtle px-4 py-2.5 text-sm text-fg-on-accent-subtle">
        <p className="min-w-0 flex-1">
          <Icon name="sparkle" className="mr-1.5 inline align-[-2px]" />
          <span id={headingId} className="font-semibold">
            {t("home.connectTitle")}.
          </span>{" "}
          {t("home.connectBody")}
        </p>
        {button}
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} data-testid="connect-ai-home" className="flex flex-col items-start gap-2 rounded-lg border border-accent bg-ai-subtle p-6 text-fg-on-accent-subtle">
      <p aria-hidden="true" className="flex items-center gap-2 text-2xs font-semibold tracking-eyebrow uppercase">
        <Icon name="sparkle" size={14} />
        {t("twoWays.ai")}
      </p>
      <h2 id={headingId} className="text-lg font-semibold">
        {t("home.connectTitle")}
      </h2>
      <p className="text-md">{t("home.connectBody")}</p>
      {button}
    </section>
  );
}

/** The cases folder is missing, not allowed or not writable: say so, and offer another. */
function FolderProblem({ folder, onChosen }: { folder: CasesFolderInfo; onChosen: () => void }) {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const headingId = useId();
  const [failed, setFailed] = useState<string | null>(null);
  if (folder.state === "ready" || folder.state === "not-created-yet") return null;

  async function choose() {
    try {
      const result = await window.aba.chooseCasesFolder();
      if (result.outcome === "chosen") onChosen();
      else if (result.outcome === "unusable") setFailed(`${t("casesFolder.unusable")} ${casesFolderProblemText(t, result.problem, platform)}`);
      else if (result.outcome === "inside-app") setFailed(t("casesFolder.insideApp"));
      else if (result.outcome === "not-saved") setFailed(t("casesFolder.notSaved"));
    } catch {
      setFailed(t("casesFolder.failed"));
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex max-w-xl flex-col items-start gap-3 rounded-lg border border-border bg-surface-muted p-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {t("casesFolder.problemHeading")}
      </h2>
      <p className="text-md">{casesFolderProblemText(t, folder.state, platform)}</p>
      <p className="font-mono text-sm break-all text-fg-muted">{folder.displayPath}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" onClick={() => void choose()}>
          {t("casesFolder.choose")}
        </Button>
        <TextLink to="/settings">{t("home.openSettings")}</TextLink>
      </div>
      <p role="status" className="text-sm font-medium text-danger">
        {failed}
      </p>
    </section>
  );
}

/** Folders in the cases folder that are not cases this version can open. The app never changes them. */
function UnreadableFolders({ folders }: { folders: UnreadableFolder[] }) {
  const { t } = useTranslation();
  const showLabel = useShowInFolderLabel();
  const headingId = useId();
  const rowId = useId();
  const [gone, setGone] = useState(false);
  return (
    <section aria-labelledby={headingId} className="flex max-w-4xl flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t("home.unreadableHeading")}
      </h2>
      <p className="max-w-measure text-md text-fg-muted">{t("home.unreadableBody")}</p>
      <div className="overflow-x-auto">
        <Table className="text-base">
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("home.unreadableFolderColumn")}</TableHeaderCell>
              <TableHeaderCell>{t("home.unreadableReasonColumn")}</TableHeaderCell>
              <TableHeaderCell className="text-right">
                <span className="sr-only">{t("home.unreadableActionColumn")}</span>
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {folders.map((folder, index) => (
              <TableRow key={folder.folderName}>
                <TableRowHeader id={`${rowId}-${index}`} className="py-2 break-all">
                  {folder.folderName}
                </TableRowHeader>
                <TableCell className="py-2">{t(`unreadable.${folder.reason}`)}</TableCell>
                <TableCell className="py-2 text-right">
                  <Button
                    size="sm"
                    aria-describedby={`${rowId}-${index}`}
                    onClick={() => {
                      void window.aba.showUnreadableFolder(folder.folderName).then(
                        (shown) => setGone(!shown),
                        () => setGone(true),
                      );
                    }}
                  >
                    {showLabel}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p role="status" className="text-sm text-fg-muted">
        {gone ? t("home.showFolderFailed") : null}
      </p>
    </section>
  );
}

/** Whole numbers only, as typed ("" when empty). */
function parseWhole(text: string, max: number): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^[0-9]{1,3}$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  return value <= max ? value : "invalid";
}

interface FormErrors {
  label?: string;
  years?: string;
  months?: string;
}

/**
 * New case: a label, and the client's age if the user wants to give it. Opened from the
 * header or from the empty Home's card (`open` is Home's). The form lives only while the
 * dialog is open, so each opening starts empty.
 */
function NewCaseDialog({ open, onOpenChange, primary, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; primary: boolean; onCreated: (created: CaseSummary) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog title={t("newCase.title")} open={open} onOpenChange={onOpenChange} trigger={<Button variant={primary ? "primary" : "secondary"}>{t("home.newCase")}</Button>}>
      <NewCaseForm
        onCreated={(created) => {
          onOpenChange(false);
          onCreated(created);
        }}
      />
    </Dialog>
  );
}

function NewCaseForm({ onCreated }: { onCreated: (created: CaseSummary) => void }) {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const [label, setLabel] = useState("");
  const [years, setYears] = useState("");
  const [months, setMonths] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const labelId = useId();
  const yearsId = useId();
  const monthsId = useId();

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (creating) return;
    const found: FormErrors = {};
    const checked = checkCaseLabel(label);
    if (!checked.ok) {
      found.label = checked.problem === "empty" ? t("newCase.labelEmpty") : checked.problem === "too-long" ? t("newCase.labelTooLong") : t("newCase.labelControlCharacters");
    }
    const y = parseWhole(years, 120);
    const m = parseWhole(months, 11);
    if (y === "invalid") found.years = t("newCase.yearsInvalid");
    if (m === "invalid") found.months = t("newCase.monthsInvalid");
    setErrors(found);
    setFormError(null);
    const firstInvalid = found.label ? labelId : found.years ? yearsId : found.months ? monthsId : null;
    if (firstInvalid || !checked.ok || y === "invalid" || m === "invalid") {
      if (firstInvalid) document.getElementById(firstInvalid)?.focus();
      return;
    }
    // Months without years: a child under one.
    const clientAge: ClientAge | null = y === null && m === null ? null : m === null ? { years: y ?? 0 } : { years: y ?? 0, months: m };
    setCreating(true);
    try {
      const result = await window.aba.createCase({ label: checked.label, clientAge });
      if (result.outcome === "created") {
        onCreated(result.case);
      } else if (result.outcome === "folder-problem") {
        setFormError(casesFolderProblemText(t, result.problem, platform));
      } else {
        setFormError(t("newCase.notSaved"));
      }
    } catch {
      setFormError(t("newCase.failed"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <DialogDescription className="mt-2 text-md">{t("newCase.body")}</DialogDescription>
      <form noValidate onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-4">
        <TextField
          id={labelId}
          label={t("newCase.labelLabel")}
          description={t("newCase.labelDescription")}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          error={errors.label}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          required
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 font-medium">{t("newCase.ageLegend")}</legend>
          <div className="flex flex-wrap gap-3">
            <TextField
              id={yearsId}
              className="w-28"
              label={t("newCase.years")}
              value={years}
              onChange={(event) => setYears(event.currentTarget.value)}
              error={errors.years}
              inputMode="numeric"
              autoComplete="off"
              maxLength={3}
            />
            <TextField
              id={monthsId}
              className="w-28"
              label={t("newCase.months")}
              value={months}
              onChange={(event) => setMonths(event.currentTarget.value)}
              error={errors.months}
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
            />
          </div>
        </fieldset>
        <p role="alert" className="text-sm font-medium text-danger empty:hidden">
          {formError}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose render={<Button />}>{t("newCase.cancel")}</DialogClose>
          <Button type="submit" variant="primary" disabled={creating} focusableWhenDisabled>
            {creating ? t("newCase.creating") : t("newCase.create")}
          </Button>
        </div>
      </form>
    </>
  );
}
