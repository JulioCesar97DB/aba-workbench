import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useParams } from "react-router";
import { isSourceType, MAX_SOURCE_TEXT_LENGTH, type SourceType } from "../../../shared/sources.ts";
import { registerFlusher, sourceAnswer, useCaseSaves } from "../case-saves.tsx";
import { casePath, sourceTextPath, stepTitle } from "../case-steps.tsx";
import { ButtonLink } from "../components/Link.tsx";
import { useLanguage } from "../language.tsx";
import { useOpenedCase } from "../open-case.tsx";
import { StepHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";
import { SourceDetailFields, TYPING_PAUSE_MS, useSourceDetails } from "../source-details.tsx";
import { formatCount, sourceName, sourceNameLang } from "../source-labels.tsx";
import { SaveFailure, SaveStatus, useDocumentsEyebrow } from "./Sources.tsx";

/*
 * A pasted text, to read and edit: #/cases/<id>/sources/text/<source id>, or a new one
 * of a type, #/cases/<id>/sources/new/<type>. The text is saved as the clinician types
 * (when typing pauses, when she leaves the field, when she leaves the screen, and when
 * the window is about to close); a new text becomes a source with its first characters.
 * Its type, title and date are one set of fields before and after that (source-details.tsx).
 * The text area is not controlled by React, so a very long paste stays quick: only its
 * length is kept in state.
 *
 * Its type, title and date are one row above the text; the text box fills the pane down to
 * its foot and grows with the text, so the pane is its only scroll, with no resize handle
 * (owner's decision T16). The character count shows only from 80% of what a text holds.
 */

/** From this many characters the count shows under the text: 80% of the most a text holds. */
export const COUNTER_FROM = MAX_SOURCE_TEXT_LENGTH * 0.8;

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
  const eyebrow = useDocumentsEyebrow();
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
  const typeHintId = useId();
  // Opened from the generic "Pegar un texto" (header or the A mano card), not from a checklist row:
  // its type is still to be chosen (UX-4 review round 2, minor 1). "Otro documento → Pegar texto" chose "Otro".
  const pickType = (useLocation().state as { pickType?: boolean } | null)?.pickType === true;

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
    <StepHeader
      eyebrow={`${eyebrow} · ${stepTitle(t, "sources")}`}
      title={title}
      titleLang={source ? sourceNameLang(source) : undefined}
      status={<SaveStatus />}
      secondary={
        <ButtonLink to={casePath(caseId, "sources")} onClick={() => void save()}>
          {t("sources.backToSources")}
        </ButtonLink>
      }
    />
  );

  if (loaded.status !== "loaded") {
    const message = loaded.status === "loading" ? t("sources.loadingText") : loaded.status === "not-found" ? t("sources.textNotFound") : t("sources.textLoadFailed");
    return (
      <WorkArea header={header}>
        <p role={loaded.status === "loading" ? "status" : "alert"} className="text-md">
          {message}
        </p>
      </WorkArea>
    );
  }

  const showTypeHint = !existingId && pickType && details.type === "other";
  const full = length >= MAX_SOURCE_TEXT_LENGTH;
  const counted = length >= COUNTER_FROM;
  return (
    <WorkArea header={header} contentClassName="flex min-h-full max-w-list flex-col">
      <div className="flex flex-1 flex-col gap-4">
        <div data-testid="text-details" className="flex flex-col gap-4 @split:flex-row @split:items-start [&>*:nth-child(2)]:flex-1">
          <SourceDetailFields details={details} typeHintId={showTypeHint ? typeHintId : undefined} />
        </div>
        {/* A new text of no type yet ("Pegar un texto"): say that the type is chosen here (review, minor 2), and describe the type field with it. */}
        {showTypeHint ? (
          <p id={typeHintId} className="max-w-reading text-sm text-fg-muted">
            {t("sources.otherTypeHint")}
          </p>
        ) : null}
        <div className="flex flex-1 flex-col gap-1.5">
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
            aria-describedby={counted || oneLongParagraph ? `${textId}-description ${counterId}` : `${textId}-description`}
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
            data-testid="source-text"
            className="min-h-48 w-full flex-1 resize-none overflow-hidden rounded-md border border-border-control bg-surface px-3 py-2 text-md text-fg field-sizing-content"
          />
          {counted || oneLongParagraph ? <TextCounter id={counterId} length={length} counted={counted} full={full} oneLongParagraph={oneLongParagraph} /> : null}
        </div>
        <SaveFailure />
      </div>
    </WorkArea>
  );
}

function TextCounter({ id, length, counted, full, oneLongParagraph }: { id: string; length: number; counted: boolean; full: boolean; oneLongParagraph: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const max = formatCount(language, MAX_SOURCE_TEXT_LENGTH);
  return (
    <div id={id} className="flex flex-col gap-1">
      {counted ? <p className="text-xs text-fg-muted tabular-nums">{t("sources.textCounter", { count: formatCount(language, length), max })}</p> : null}
      {full ? (
        <p role="alert" className="max-w-measure text-sm font-medium text-danger">
          {t("sources.textTooLong", { max })}
        </p>
      ) : null}
      {oneLongParagraph ? <p className="max-w-measure text-sm text-fg-muted">{t("sources.oneLongParagraph")}</p> : null}
    </div>
  );
}
