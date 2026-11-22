import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router";
import { isSourceType, MAX_SOURCE_TEXT_LENGTH, type SourceType } from "../../../shared/sources.ts";
import { registerFlusher, sourceAnswer, useCaseSaves } from "../case-saves.tsx";
import { casePath, sourceTextPath } from "../case-steps.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { useLanguage } from "../language.tsx";
import { useOpenedCase } from "../open-case.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";
import { SourceDetailFields, TYPING_PAUSE_MS, useSourceDetails } from "../source-details.tsx";
import { formatCount, sourceName, sourceNameLang } from "../source-labels.tsx";
import { CaseRail, useStepMeta } from "./Case.tsx";
import { SaveFailure, SaveStatus } from "./Sources.tsx";

/*
 * A pasted text, to read and edit: #/cases/<id>/sources/text/<source id>, or a new one
 * of a type, #/cases/<id>/sources/new/<type>. The text is saved as the clinician types
 * (when typing pauses, when she leaves the field, when she leaves the screen, and when
 * the window is about to close); a new text becomes a source with its first characters.
 * Its type, title and date are one set of fields before and after that (source-details.tsx).
 * The text area is not controlled by React, so a very long paste stays quick: only its
 * length is kept in state.
 */

/** Over this many characters with no line break, typing in the text area gets slow (Chromium lays it out as one paragraph). */
export const LONG_PARAGRAPH_NOTICE_AT = 100_000;

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
  const [initialSource] = useState(source);
  const details = useSourceDetails({
    caseId,
    sourceId: existingId,
    initial: initialSource ? { type: initialSource.type, title: initialSource.title ?? "", date: initialSource.date ?? "" } : { type: initialType, title: "", date: "" },
  });
  const { draft, created } = details;
  const [loaded, setLoaded] = useState<Loaded>(existingId ? { status: "loading" } : { status: "loaded", text: "" });
  const [length, setLength] = useState(0);
  const [oneLongParagraph, setOneLongParagraph] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const saved = useRef<string | null>(null);
  // The text as typed, kept outside the field: the field is gone by the time leaving the
  // screen saves it. Null until an existing text has loaded, so nothing is saved over it before.
  const typed = useRef<string | null>(existingId ? null : "");
  const creating = useRef<Promise<string | null> | null>(null);
  const idRef = useRef(existingId);
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
        const sent = draft();
        saved.current = text;
        creating.current = run(async () => sourceAnswer(await window.aba.addTextSource(caseId, { ...sent, text }))).then((answer) => {
          creating.current = null;
          if (!answer.ok) {
            saved.current = null;
            return null;
          }
          idRef.current = answer.value;
          setCreatedId(answer.value);
          // The address now names the text, so a reload opens it, not a new empty one. Set on
          // the window's history directly, not through the router: navigating would remount
          // the editor, losing what is being typed and the focus.
          const url = new URL(window.location.href);
          url.hash = sourceTextPath(caseId, answer.value);
          window.history.replaceState(window.history.state, "", url);
          // A type, title or date changed while it was being created is saved now.
          created(answer.value, sent);
          return answer.value;
        });
        if ((await creating.current) === null && !idRef.current) return;
        continue;
      }
      saved.current = text;
      const answer = await run(async () => sourceAnswer(await window.aba.changeSource(caseId, target, { text })));
      if (!answer.ok && saved.current === text) saved.current = null;
      return;
    }
  }, [caseId, run, draft, created]);

  // Leaving the screen saves what was typed; so does the window being about to close.
  useEffect(() => {
    const unregister = registerFlusher(save);
    return () => {
      unregister();
      void save();
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
          <SourceDetailFields details={details} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="font-medium">
            {t("sources.textLabel")}
          </label>
          <p id={`${textId}-description`} className="max-w-measure text-sm text-fg-muted">
            {t("sources.textDescription")}
            {id ? null : <> {t("sources.textEmptyNote")}</>}
          </p>
          <textarea
            id={textId}
            defaultValue={loaded.text}
            maxLength={MAX_SOURCE_TEXT_LENGTH}
            aria-describedby={`${textId}-description ${counterId}`}
            spellCheck
            autoFocus={!existingId}
            onInput={(event) => {
              const value = event.currentTarget.value;
              typed.current = value;
              setLength(value.length);
              setOneLongParagraph(value.length > LONG_PARAGRAPH_NOTICE_AT && !value.includes("\n"));
              clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void save(), TYPING_PAUSE_MS);
            }}
            onBlur={() => void save()}
            className="min-h-[24rem] w-full resize-y rounded-md border border-border-control bg-surface px-3 py-2 text-md text-fg"
          />
          <TextCounter id={counterId} length={length} full={full} oneLongParagraph={oneLongParagraph} />
        </div>
        <SaveFailure />
      </div>
    </WorkArea>
  );
}

function TextCounter({ id, length, full, oneLongParagraph }: { id: string; length: number; full: boolean; oneLongParagraph: boolean }) {
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
      {oneLongParagraph ? <p className="max-w-measure text-sm text-fg-muted">{t("sources.oneLongParagraph")}</p> : null}
    </div>
  );
}
