import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { checkCaseLabel, type CaseList, type CasesFolderInfo, type CaseSummary, type ClientAge, type UnreadableFolder } from "../../../shared/api.ts";
import { useAppInfo } from "../app-info.tsx";
import { casePath } from "../case-steps.tsx";
import { casesFolderProblemText, useShowInFolderLabel } from "../cases-folder.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { TextLink } from "../components/Link.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "../components/Table.tsx";
import { TextField } from "../components/TextField.tsx";
import { formatAge, formatDate, formatDateTime } from "../format.ts";
import { useLanguage } from "../language.tsx";
import { useFailedSaves } from "../case-saves.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

type ListState = { status: "loading" } | { status: "error" } | { status: "loaded"; list: CaseList };

/**
 * The list of cases in the cases folder, newest first, and below it the folders there
 * that cannot be opened as cases. The main process reads the folder; this screen only
 * shows what it reports.
 */
export function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const load = useCallback(() => {
    window.aba.listCases().then(
      (list) => setState({ status: "loaded", list }),
      () => setState({ status: "error" }),
    );
  }, []);
  useEffect(load, [load]);

  return (
    <WorkArea header={<PageHeader title={t("home.title")} actions={<NewCaseDialog onCreated={(created) => navigate(casePath(created.id))} />} />}>
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
        {state.status === "loaded" ? <CasesView list={state.list} onFolderChosen={load} /> : null}
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
    <div role="alert" className="flex max-w-4xl flex-col gap-2 rounded-md border border-danger px-3.5 py-2.5 text-md">
      {failed.map((item) => (
        <p key={item.caseId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium text-danger">{t("home.unsavedChange", { label: item.label })}</span>
          <TextLink to={casePath(item.caseId)}>{t("home.openToTryAgain")}</TextLink>
        </p>
      ))}
    </div>
  );
}

function CasesView({ list, onFolderChosen }: { list: CaseList; onFolderChosen: () => void }) {
  const { folder, cases, unreadable } = list;
  const usable = folder.state === "ready" || folder.state === "not-created-yet" || folder.state === "not-writable";
  return (
    <>
      {usable && folder.state !== "not-writable" ? null : <FolderProblem folder={folder} onChosen={onFolderChosen} />}
      {usable && cases.length === 0 && unreadable.length === 0 ? <EmptyState /> : null}
      {cases.length > 0 ? <CasesTable cases={cases} /> : null}
      {unreadable.length > 0 ? <UnreadableFolders folders={unreadable} /> : null}
    </>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex max-w-xl flex-col items-start gap-3 rounded-lg border border-border bg-surface-muted p-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {t("home.emptyTitle")}
      </h2>
      <p className="text-md">{t("home.emptyBody")}</p>
      <p className="text-md text-fg-muted">{t("home.emptyNext")}</p>
      <TextLink to="/settings">{t("home.openSettings")}</TextLink>
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

function CasesTable({ cases }: { cases: CaseSummary[] }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex max-w-4xl flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {t("home.listHeading")}
      </h2>
      <div className="overflow-x-auto">
        <Table className="text-base">
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t("home.columnCase")}</TableHeaderCell>
              <TableHeaderCell>{t("home.columnAge")}</TableHeaderCell>
              <TableHeaderCell>{t("home.columnCreated")}</TableHeaderCell>
              <TableHeaderCell>{t("home.columnUpdated")}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t("home.columnPdfs")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {cases.map((item) => (
              <TableRow key={item.id}>
                <TableRowHeader className="py-2">
                  <TextLink to={casePath(item.id)} className="break-words">
                    {item.label}
                  </TextLink>
                </TableRowHeader>
                <TableCell className="py-2">{formatAge(t, language, item.clientAge) ?? <span className="text-fg-muted">{t("home.ageNotGiven")}</span>}</TableCell>
                <TableCell className="py-2">
                  <time dateTime={item.createdAt}>{formatDate(language, item.createdAt)}</time>
                </TableCell>
                <TableCell className="py-2">
                  <time dateTime={item.updatedAt}>{formatDateTime(language, item.updatedAt)}</time>
                </TableCell>
                <TableCell className="py-2 text-right font-mono text-sm tabular-nums">{item.pdfCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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

/** New case: a label, and the client's age if the user wants to give it. */
function NewCaseDialog({ onCreated }: { onCreated: (created: CaseSummary) => void }) {
  const { t } = useTranslation();
  const platform = useAppInfo()?.platform;
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [years, setYears] = useState("");
  const [months, setMonths] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const labelId = useId();
  const yearsId = useId();
  const monthsId = useId();

  function onOpenChange(next: boolean) {
    if (next) {
      setLabel("");
      setYears("");
      setMonths("");
      setErrors({});
      setFormError(null);
    }
    setOpen(next);
  }

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
        setOpen(false);
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
    <Dialog title={t("newCase.title")} open={open} onOpenChange={onOpenChange} trigger={<Button variant="primary">{t("home.newCase")}</Button>}>
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
    </Dialog>
  );
}
