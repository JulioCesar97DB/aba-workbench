import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router";
import { checkSourceTitle, isSourceType, MAX_SOURCE_TEXT_LENGTH, type SourceType } from "../../../shared/sources.ts";
import { sourceAnswer, useCaseSaves } from "../case-saves.tsx";
import { casePath } from "../case-steps.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { TextField } from "../components/TextField.tsx";
import { useLanguage } from "../language.tsx";
import { useOpenedCase } from "../open-case.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";
import { formatCount, sourceName, sourceNameLang } from "../source-labels.tsx";
import { CaseRail, useStepMeta } from "./Case.tsx";
import { SaveFailure, SaveStatus, SourceDateField, SourceFields, SourceTypeSelect, TYPING_PAUSE_MS } from "./Sources.tsx";

/*
 * A pasted text, to read and edit: #/cases/<id>/sources/text/<source id>, or a new one
 * of a type, #/cases/<id>/sources/new/<type>. The text is saved as the clinician types
 * (when typing pauses, when she leaves the field, and when she leaves the screen); a new
 * text becomes a source with its first characters. The text area is not controlled by
 * React, so a very long paste stays quick: only its length is kept in state.
 */

type Loaded = { status: "loading" } | { status: "loaded"; text: string } | { status: "not-found" } | { status: "failed" };

export function SourceTextScreen() {
  const { sourceId, type } = useParams();
  const opened = useOpenedCase();
  if (type !== undefined) {
    if (!isSourceType(type)) return <Navigate to={casePath(opened.id, "sources")} replace />;
    return <TextEditor key={`new-${type}`} initialType={type} existingId={null} />;
  }
  return <TextEditor key={sourceId} initialType="other" existingId={sourceId ?? null} />;
}

function TextEditor({ initialType, existingId }: { initialType: SourceType; existingId: string | null }) {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const meta = useStepMeta("sources");
  const { run } = useCaseSaves();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const id = existingId ?? createdId;
  const source = id ? opened.sources.sources.find((entry) => entry.id === id && entry.kind === "text") : undefined;
  const [loaded, setLoaded] = useState<Loaded>(existingId ? { status: "loading" } : { status: "loaded", text: "" });
  const [length, setLength] = useState(0);
  // A new text's details, until it is created with them.
  const [draftType, setDraftType] = useState<SourceType>(initialType);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const saved = useRef<string | null>(null);
  // The text as typed, kept outside the field: the field is gone by the time leaving the
  // screen saves it. Null until an existing text has loaded, so nothing is saved over it before.
  const typed = useRef<string | null>(existingId ? null : "");
  const creating = useRef<Promise<string | null> | null>(null);
  const textId = useId();
  const counterId = useId();

  useEffect(() => {
    if (!existingId) return;
    let current = true;
    window.aba.readSourceText(caseId, existingId).then(
      (result) => {
        if (!current) return;
        if (result.outcome === "read") {
          saved.current = result.text;
          typed.current = result.text;
          setLength(result.text.length);
          setLoaded({ status: "loaded", text: result.text });
        } else setLoaded({ status: result.outcome === "source-not-found" ? "not-found" : "failed" });
      },
      () => {
        if (current) setLoaded({ status: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [caseId, existingId]);

  const draft = useRef({ type: draftType, title: draftTitle, date: draftDate });
  useEffect(() => {
    draft.current = { type: draftType, title: draftTitle, date: draftDate };
  }, [draftType, draftTitle, draftDate]);
  const idRef = useRef(id);
  useEffect(() => {
    if (id) idRef.current = id;
  }, [id]);

  /**
   * Saves the text as it is in the field now, if it changed: the first time, a new text
   * is created with its type, title and date; then only its text changes.
   */
  const save = useCallback(async () => {
    clearTimeout(timer.current);
    for (;;) {
      const text = typed.current;
      if (text === null || text === saved.current) return;
      const target = idRef.current;
      if (!target && creating.current) {
        // Being created: wait, then save what was typed meanwhile.
        await creating.current;
        continue;
      }
      if (!target) {
        // Nothing is created for an empty text.
        if (text.trim() === "") return;
        const { type, title, date } = draft.current;
        const checkedTitle = checkSourceTitle(title);
        saved.current = text;
        creating.current = run(`text:new-${caseId}`, async () =>
          sourceAnswer(await window.aba.addTextSource(caseId, { type, title: checkedTitle.ok ? checkedTitle.title : null, date: date || null, text })),
        ).then((answer) => {
          creating.current = null;
          if (!answer.ok) {
            saved.current = null;
            return null;
          }
          idRef.current = answer.value;
          setCreatedId(answer.value);
          return answer.value;
        });
        if ((await creating.current) === null && !idRef.current) return;
        continue;
      }
      saved.current = text;
      const answer = await run(`text:${target}`, async () => sourceAnswer(await window.aba.changeSource(caseId, target, { text })));
      if (!answer.ok && saved.current === text) saved.current = null;
      return;
    }
  }, [caseId, run]);

  // Leaving the screen (or the window going away) saves what was typed.
  useEffect(() => {
    const flush = () => void save();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [save]);

  const title = source ? sourceName(t, source) : existingId ? t("sources.textLabel") : t("sources.newText");
  const header = (
    <PageHeader
      title={title}
      titleLang={source ? sourceNameLang(source) : undefined}
      meta={meta}
      actions={
        <>
          <SaveStatus />
          <ButtonLink to={casePath(caseId, "sources")} onClick={() => void save()}>
            {t("sources.backToSources")}
          </ButtonLink>
        </>
      }
    />
  );

  if (loaded.status !== "loaded") {
    const message = loaded.status === "loading" ? t("sources.loadingText") : loaded.status === "not-found" ? t("sources.textNotFound") : t("sources.textLoadFailed");
    return (
      <WorkArea header={header} rail={<CaseRail />}>
        <p role={loaded.status === "loading" ? "status" : "alert"} className="text-md">
          {message}
        </p>
      </WorkArea>
    );
  }

  const full = length >= MAX_SOURCE_TEXT_LENGTH;
  return (
    <WorkArea header={header} rail={<CaseRail />}>
      <div className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-col gap-4 @split:flex-row @split:flex-wrap @split:items-start">
          {source ? (
            <SourceFields caseId={caseId} source={source} />
          ) : (
            <NewTextFields type={draftType} onType={setDraftType} title={draftTitle} onTitle={setDraftTitle} date={draftDate} onDate={setDraftDate} />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="font-medium">
            {t("sources.textLabel")}
          </label>
          <p id={`${textId}-description`} className="max-w-measure text-sm text-fg-muted">
            {t("sources.textDescription")}
            {source ? null : <> {t("sources.textEmptyNote")}</>}
          </p>
          <textarea
            id={textId}
            defaultValue={loaded.text}
            maxLength={MAX_SOURCE_TEXT_LENGTH}
            aria-describedby={`${textId}-description ${counterId}`}
            spellCheck
            autoFocus={!existingId}
            onInput={(event) => {
              typed.current = event.currentTarget.value;
              setLength(event.currentTarget.value.length);
              clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void save(), TYPING_PAUSE_MS);
            }}
            onBlur={() => void save()}
            className="min-h-[24rem] w-full resize-y rounded-md border border-border-control bg-surface px-3 py-2 text-md text-fg"
          />
          <TextCounter id={counterId} length={length} full={full} />
        </div>
        <SaveFailure />
      </div>
    </WorkArea>
  );
}

function TextCounter({ id, length, full }: { id: string; length: number; full: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const max = formatCount(language, MAX_SOURCE_TEXT_LENGTH);
  return (
    <div id={id} className="flex flex-col gap-1">
      <p className="font-mono text-xs text-fg-muted tabular-nums">{t("sources.textCounter", { count: formatCount(language, length), max })}</p>
      {full ? (
        <p role="alert" className="max-w-measure text-sm font-medium text-danger">
          {t("sources.textTooLong", { max })}
        </p>
      ) : null}
    </div>
  );
}

/** A new text's type, title and date, kept here until the text is created with them. */
function NewTextFields(props: { type: SourceType; onType: (type: SourceType) => void; title: string; onTitle: (title: string) => void; date: string; onDate: (date: string) => void }) {
  const { t } = useTranslation();
  const checked = checkSourceTitle(props.title);
  return (
    <>
      <SourceTypeSelect value={props.type} onChange={props.onType} />
      <TextField
        label={t("sources.titleLabel")}
        description={t("sources.titleDescription")}
        value={props.title}
        error={checked.ok ? null : checked.problem === "too-long" ? t("sources.titleTooLong") : t("sources.titleControlCharacters")}
        autoComplete="off"
        maxLength={300}
        onChange={(event) => props.onTitle(event.currentTarget.value)}
      />
      <SourceDateField value={props.date} onChange={props.onDate} />
    </>
  );
}
