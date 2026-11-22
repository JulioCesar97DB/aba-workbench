import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { checkSourceTitle, type SourceChange, type SourceType } from "../../shared/sources.ts";
import { registerFlusher, sourceAnswer, useCaseSaves } from "./case-saves.tsx";
import { TextField } from "./components/TextField.tsx";
import { SOURCE_TYPES } from "../../shared/sources.ts";
import { Select } from "./components/Select.tsx";
import { sourceTypeLang, sourceTypeName } from "./source-labels.tsx";

/*
 * A source's type, title and date, as the clinician edits them: one set of fields and
 * one state, whether the source exists yet or not, so creating a new text never swaps
 * the fields (which would empty what she is typing and lose the focus).
 *
 * Before the source exists, the fields are a draft that the text is created with
 * (draft()). Once it exists, each change is saved: the type and the date at once, the
 * title when typing pauses, when the field is left, when the fields go away and when the
 * window is about to close. A change made while the text was being created is saved
 * right after (created()).
 */

export interface SourceDetails {
  type: SourceType;
  title: string;
  date: string;
}

/** How long typing must pause before a title (or a text) is saved. */
export const TYPING_PAUSE_MS = 600;

function checkedTitle(title: string): string | null | undefined {
  const checked = checkSourceTitle(title);
  return checked.ok ? checked.title : undefined;
}

export function useSourceDetails({ caseId, sourceId, initial }: { caseId: string; sourceId: string | null; initial: SourceDetails }) {
  const { t } = useTranslation();
  const { run } = useCaseSaves();
  const [type, setType] = useState(initial.type);
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.date);
  const [titleError, setTitleError] = useState<string | null>(null);
  // What the fields hold now, and what the saved source holds; read in handlers, never while rendering.
  const latest = useRef<SourceDetails>(initial);
  const saved = useRef<{ type: SourceType; title: string | null; date: string | null }>({ type: initial.type, title: checkedTitle(initial.title) ?? null, date: initial.date || null });
  const id = useRef<string | null>(sourceId);
  const timer = useRef<number | undefined>(undefined);

  const send = useCallback(
    (change: SourceChange) => {
      const target = id.current;
      if (!target) return Promise.resolve();
      saved.current = { ...saved.current, ...change };
      return run(async () => sourceAnswer(await window.aba.changeSource(caseId, target, change))).then(() => undefined);
    },
    [caseId, run],
  );

  /** Saves the title as typed, if it is valid and changed. */
  const saveTitle = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = latest.current.title;
    const checked = checkSourceTitle(value);
    if (!checked.ok) {
      setTitleError(checked.problem === "too-long" ? t("sources.titleTooLong") : t("sources.titleControlCharacters"));
      return Promise.resolve();
    }
    setTitleError(null);
    if (checked.title === saved.current.title) return Promise.resolve();
    return send({ title: checked.title });
  }, [send, t]);

  // Typing still waiting for its pause is saved when the window is about to close, and when the fields go away.
  useEffect(() => {
    const unregister = registerFlusher(saveTitle);
    return () => {
      unregister();
      void saveTitle();
    };
  }, [saveTitle]);

  const changeType = (value: SourceType) => {
    latest.current = { ...latest.current, type: value };
    setType(value);
    void send({ type: value });
  };
  const changeTitle = (value: string) => {
    latest.current = { ...latest.current, title: value };
    setTitle(value);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveTitle(), TYPING_PAUSE_MS);
  };
  const changeDate = (value: string) => {
    latest.current = { ...latest.current, date: value };
    setDate(value);
    void send({ date: value === "" ? null : value });
  };

  /** A new source's details, to create it with (an invalid title is left out, and shown as an error). */
  const draft = useCallback(() => {
    const { type: draftType, title: draftTitle, date: draftDate } = latest.current;
    return { type: draftType, title: checkedTitle(draftTitle) ?? null, date: draftDate || null };
  }, []);

  /** The source now exists, made with `sent`: saves whatever changed in the fields meanwhile. */
  const created = useCallback(
    (newId: string, sent: { type: SourceType; title: string | null; date: string | null }) => {
      id.current = newId;
      saved.current = { ...sent };
      const now = latest.current;
      if (now.type !== sent.type) void send({ type: now.type });
      if ((now.date || null) !== sent.date) void send({ date: now.date || null });
      void saveTitle();
    },
    [saveTitle, send],
  );

  return { type, title, date, titleError, changeType, changeTitle, changeDate, saveTitle, draft, created };
}

export type SourceDetailsState = ReturnType<typeof useSourceDetails>;

/** The type, title and date fields. */
export function SourceDetailFields({ details }: { details: SourceDetailsState }) {
  const { t } = useTranslation();
  return (
    <>
      <SourceTypeSelect value={details.type} onChange={details.changeType} />
      <TextField
        label={t("sources.titleLabel")}
        description={t("sources.titleDescription")}
        value={details.title}
        error={details.titleError}
        autoComplete="off"
        maxLength={300}
        onChange={(event) => details.changeTitle(event.currentTarget.value)}
        onBlur={() => void details.saveTitle()}
      />
      <SourceDateField value={details.date} onChange={details.changeDate} />
    </>
  );
}

export function SourceTypeSelect({ value, onChange }: { value: SourceType; onChange: (type: SourceType) => void }) {
  const { t } = useTranslation();
  return (
    <Select
      label={t("sources.typeLabel")}
      value={value}
      options={SOURCE_TYPES.map((type) => ({ value: type, label: sourceTypeName(t, type), lang: sourceTypeLang(type) }))}
      onValueChange={onChange}
    />
  );
}

/** A date field (the system's own, keyboard-friendly); "" when cleared. Only a whole, valid date is passed on. */
export function SourceDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <TextField
      className="max-w-56"
      type="date"
      min="1900-01-01"
      max="2100-12-31"
      label={t("sources.dateLabel")}
      description={t("sources.dateDescription")}
      value={value}
      onChange={(event) => {
        const next = event.currentTarget.value;
        // A half-typed date reads as "" while invalid; only a full one or a cleared field is saved.
        if (next === "" || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(next)) onChange(next);
      }}
    />
  );
}

