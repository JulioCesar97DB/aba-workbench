import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import type { MapSaveResult } from "../../../shared/api.ts";
import { MAP_PARTS, isMapPartId, type CaseMapView, type MapCollection, type MapPartId, type MapPartView } from "../../../shared/case-map.ts";
import { isOlderRevision } from "../../../shared/sections.ts";
import type { FailedSave } from "../../../shared/sources.ts";
import { useAutosave, useKeptText } from "../autosave.tsx";
import { onRetried, retry, useMapFailures } from "../case-saves.tsx";
import { MapFields, type MapFormContext } from "../case-map/CaseMapFields.tsx";
import { checksOf, countChecks, fieldsOf, itemInput, itemTitle } from "../case-map/specs.ts";
import { MAP_TERMS } from "../i18n/terms.ts";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { StatusBadge, type StatusTone } from "../components/StatusBadge.tsx";
import { cn } from "../components/cn.ts";
import { useLanguage } from "../language.tsx";
import { useOpenedCase, usePatchOpenedCase, useSetCaseSources } from "../open-case.tsx";
import { sourceName } from "../source-labels.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { Eyebrow, WorkArea } from "../shell/WorkArea.tsx";
import { useStepMeta } from "./Case.tsx";

/*
 * Step 2 of a case: the case map (owner's decisions D1-D35, step 1 of the AI knowledge
 * plan). Its parts (client, caregivers, settings, deficits, strengths, behaviors and
 * groups, risks, facts, open items, the report on her sections) each have their own
 * versions, status and approval. In this first pull request she types, corrects and
 * approves the map by hand; the AI drafts it from the next one on.
 *
 * What she types in an item is saved as she types (no Save button), like a section's
 * text: into the part's editing pass, kept by the main process when it cannot be saved,
 * and put back in its form after a reload.
 */

type MapState = { status: "loading" } | { status: "failed" } | { status: "ready"; map: CaseMapView };

/** The part whose items are behaviors also holds groups; an id says which list it is in. */
function collectionOf(itemId: string): MapCollection {
  return itemId.startsWith("grp-") ? "groups" : "items";
}

export function CaseMapScreen() {
  const { t } = useTranslation();
  const opened = useOpenedCase();
  const caseId = opened.id;
  const patch = usePatchOpenedCase();
  const meta = useStepMeta("case-map");
  const [params, setParams] = useSearchParams();
  const part: MapPartId = isMapPartId(params.get("part")) ? (params.get("part") as MapPartId) : "behaviors";
  const selectedId = params.get("item");
  const [state, setState] = useState<MapState>({ status: "loading" });
  const [actionFailed, setActionFailed] = useState(false);
  const [removing, setRemoving] = useState<{ part: MapPartId; collection: MapCollection; id: string; title: string } | null>(null);
  // Each part's editing pass: the version her changes keep writing to (the last answer's).
  const editing = useRef<Partial<Record<MapPartId, number>>>({});
  // Grows when another version is shown, so the forms start again from what it holds.
  const [epoch, setEpoch] = useState(0);
  const failures = useMapFailures(caseId);
  const setSources = useSetCaseSources();

  const load = useCallback(async () => {
    const result = await window.aba.getCaseMap(caseId).catch(() => null);
    setState(result?.outcome === "read" ? { status: "ready", map: result.map } : { status: "failed" });
  }, [caseId]);

  useEffect(() => {
    // Read once when the screen opens; every change answers with the whole map.
    void load(); // eslint-disable-line react-hooks/set-state-in-effect -- the first read of the map
  }, [load]);

  /**
   * Every answer is a whole snapshot: an older one (an answer that came back late) never
   * replaces a newer one. Only her own changes (an item saved, added or removed) set the
   * part's editing pass: an approval or a version shown never does, so an edit after
   * taking an approval back starts a new version and the approved content stays recorded
   * (review round 1, minor 3).
   */
  const accept = useCallback(
    (result: MapSaveResult | null, changedPart: MapPartId, ownChange: boolean): boolean => {
      if (result?.outcome !== "saved") return false;
      setState((previous) => (previous.status === "ready" && isOlderRevision(result.map.revision, previous.map.revision) ? previous : { status: "ready", map: result.map }));
      patch(caseId, { caseMap: result.summary });
      // An approval, a take-back or a version shown ends her editing pass: her next change starts a new version (review round 2, R2-1).
      if (!ownChange) delete editing.current[changedPart];
      else if (result.version !== null) editing.current[changedPart] = result.version;
      return true;
    },
    [caseId, patch],
  );

  // "Try again" saved what she typed in an item: read the map again.
  useEffect(
    () =>
      onRetried((item) => {
        if (item.about === "map" && item.caseId === caseId) void load();
      }),
    [caseId, load],
  );

  const act = useCallback(
    async (changedPart: MapPartId, work: () => Promise<MapSaveResult>, ownChange = false): Promise<MapSaveResult | null> => {
      setActionFailed(false);
      const result = await work().catch(() => null);
      if (!accept(result, changedPart, ownChange)) setActionFailed(true);
      return result;
    },
    [accept],
  );
  // The item just added, whose first field takes the focus; after a removal, the list's Add button does (review round 1, minor 7).
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusItem(null), []);
  const addButton = useRef<HTMLButtonElement | null>(null);

  const select = (nextPart: MapPartId, item: string | null) => setParams(item ? { part: nextPart, item } : { part: nextPart });

  async function add(collection: MapCollection) {
    const result = await act(part, () => window.aba.addMapItem(caseId, part, collection, "{}", editing.current[part] ?? null), true);
    if (result?.outcome === "saved" && result.itemId) {
      setFocusItem(result.itemId);
      select(part, result.itemId);
    }
  }

  async function show(version: number) {
    const result = await act(part, () => window.aba.setMapPartVersion(caseId, part, version));
    if (result?.outcome === "saved") setEpoch((value) => value + 1);
  }

  async function remove() {
    if (!removing) return;
    const target = removing;
    const result = await act(target.part, () => window.aba.removeMapItem(caseId, target.part, target.collection, target.id, editing.current[target.part] ?? null), true);
    if (result?.outcome === "saved") {
      select(target.part, null);
      requestAnimationFrame(() => addButton.current?.focus());
    }
  }

  const view = state.status === "ready" ? state.map.parts[part] : null;
  const header = (
    <PageHeader
      title={t("steps.caseMap")}
      meta={meta}
      afterTitle={view ? <PartStatus view={view} /> : null}
      actions={
        view && view.currentVersion !== null ? (
          view.status === "approved" ? (
            <Button onClick={() => void act(part, () => window.aba.approveMapPart(caseId, part, null))}>{t("caseMap.unapprove")}</Button>
          ) : (
            <Button variant="primary" onClick={() => void act(part, () => window.aba.approveMapPart(caseId, part, view.currentVersion))}>
              {t("caseMap.approve")}
            </Button>
          )
        ) : null
      }
    />
  );

  if (state.status !== "ready" || !view) {
    return (
      <WorkArea header={header}>
        {state.status === "failed" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-md">
              {t("caseMap.loadFailed")}
            </p>
            <Button onClick={() => void load()}>{t("home.retry")}</Button>
          </div>
        ) : (
          <p className="text-md text-fg-muted">{t("caseMap.loading")}</p>
        )}
      </WorkArea>
    );
  }

  const map = state.map;
  const context: MapFormContext = {
    part,
    behaviors: map.parts.behaviors.items.map((item) => ({ id: item.id, title: itemTitle("behaviors", item as unknown as Record<string, unknown>) ?? t("caseMap.untitled") })),
    settings: map.parts.settings.items.map((item) => ({ id: item.id, title: itemTitle("settings", item as unknown as Record<string, unknown>) ?? t("caseMap.untitled") })),
    sourceLabel: (id) => {
      const source = opened.sources.sources.find((entry) => entry.id === id);
      return source ? sourceName(t, source) : null;
    },
  };
  /** For a group's form: the other group each behavior is in, by its name. */
  const groupContext = (groupId: string): MapFormContext => ({
    ...context,
    otherGroupOf: (behaviorId) => {
      const other = map.parts.behaviors.groups.find((group) => group.id !== groupId && group.behaviorIds.includes(behaviorId));
      return other ? (itemTitle("groups", other as unknown as Record<string, unknown>) ?? other.id) : null;
    },
  });
  const selectedCollection = selectedId ? collectionOf(selectedId) : "items";
  const selected = selectedId ? (selectedCollection === "groups" ? view.groups : view.items).find((item) => item.id === selectedId) : undefined;
  const clientItem = part === "client" ? view.items[0] : undefined;
  const editorItem = part === "client" ? clientItem : selected;
  const editorCollection = part === "client" ? "items" : selectedCollection;
  const editor = editorItem ? (
    <ItemEditor
      key={`${part}/${editorItem.id}/${epoch}`}
      caseId={caseId}
      part={part}
      collection={editorCollection}
      item={editorItem as unknown as Record<string, unknown>}
      context={editorCollection === "groups" ? groupContext(editorItem.id) : context}
      autoFocus={focusItem === editorItem.id}
      onFocused={clearFocus}
      editingFor={() => editing.current[part] ?? null}
      onSaved={(result) => accept(result, part, true)}
      onRemove={
        part === "client"
          ? null
          : () =>
              setRemoving({
                part,
                collection: editorCollection,
                id: editorItem.id,
                title: itemTitle(editorCollection === "groups" ? "groups" : part, editorItem as unknown as Record<string, unknown>) ?? t("caseMap.untitled"),
              })
      }
    />
  ) : null;

  return (
    <WorkArea header={header} rail={<PartRail view={view} part={part} onShow={(version) => void show(version)} onSelect={(id) => select(part, id)} />}>
      <div className="flex flex-col gap-4">
        <PartBar map={map} part={part} />
        {failures.map((item) => (
          <div key={item.id} role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-danger px-3.5 py-2 text-md font-medium text-danger">
            <span>{t("caseMap.failedSave")}</span>
            <Button size="sm" onClick={() => retry(item, (sources) => setSources(caseId, sources))}>
              {t("sources.tryAgain")}
            </Button>
          </div>
        ))}
        {actionFailed ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("caseMap.actionFailed")}
          </p>
        ) : null}
        {view.outOfDate ? <p className="text-sm text-warning">{t("caseMap.outOfDate", { reasons: view.outOfDate.reasons.join("; ") })}</p> : null}
        {part === "report" && view.items.length === 0 ? (
          <p className="max-w-measure text-md text-fg-muted">{t("caseMap.reportEmpty")}</p>
        ) : part === "client" ? (
          editor ?? (
            <div className="flex flex-col items-start gap-3">
              <p className="max-w-measure text-md text-fg-muted">{t("caseMap.clientEmpty")}</p>
              <Button onClick={() => void add("items")}>{t("caseMap.add.client")}</Button>
            </div>
          )
        ) : (
          <div className="grid items-start gap-5 @3xl:grid-cols-[15rem_1fr]">
            <ItemList view={view} part={part} selectedId={selectedId} addRef={addButton} onAdd={(collection) => void add(collection)} onSelect={(id) => select(part, id)} />
            <div className="min-w-0">{editor ?? <p className="text-md text-fg-muted">{view.items.length === 0 ? t("caseMap.emptyPart") : t("caseMap.chooseItem")}</p>}</div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("caseMap.removeTitle", { name: removing?.title ?? "" })}
        confirmLabel={t("caseMap.remove")}
        cancelLabel={t("caseMap.cancel")}
        onConfirm={() => void remove()}
      >
        <p>{t("caseMap.removeBody")}</p>
      </ConfirmDialog>
    </WorkArea>
  );
}

const STATUS_TONES: Record<MapPartView["status"], StatusTone> = { empty: "neutral", draft: "neutral", corrected: "accent", approved: "success" };

/** A part's status in words. A part she typed with no AI version is "typed by you". */
function statusText(t: ReturnType<typeof useTranslation>["t"], view: MapPartView): string {
  if (view.status === "corrected" && !view.versions.some((version) => version.kind !== "edited")) return t("caseMap.status.typed");
  return t(`caseMap.status.${view.status}`);
}

function PartStatus({ view }: { view: MapPartView }) {
  const { t } = useTranslation();
  if (view.status === "empty") return null;
  return (
    <span data-testid="map-part-status">
      <StatusBadge tone={STATUS_TONES[view.status]}>{statusText(t, view)}</StatusBadge>
    </span>
  );
}

/** The status dot of a part: hollow when empty, amber while it waits for her, green once approved. */
function Dot({ status }: { status: MapPartView["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", status === "empty" && "border border-border-control", status === "approved" && "bg-dot-done", (status === "draft" || status === "corrected") && "bg-dot-draft")}
    />
  );
}

function PartName({ part }: { part: MapPartId }) {
  const { t } = useTranslation();
  return <span>{t(`caseMap.parts.${part}`)}</span>;
}

/** The parts, each with its status and how many items it holds; the one shown is the current page. */
function PartBar({ map, part }: { map: CaseMapView; part: MapPartId }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("caseMap.partsLabel")}>
      <ul className="flex flex-wrap gap-1 rounded-md bg-surface-muted p-1.5">
        {MAP_PARTS.map((id) => {
          const view = map.parts[id];
          const count = view.items.length;
          return (
            <li key={id}>
              <Link
                to={`?part=${id}`}
                aria-current={id === part ? "true" : undefined}
                className="flex min-h-control-sm items-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm text-fg no-underline hover:bg-surface aria-[current=true]:border-border-control aria-[current=true]:bg-surface aria-[current=true]:font-semibold"
              >
                <Dot status={view.status} />
                <PartName part={id} />
                {count > 0 ? <span className="font-mono text-xs text-fg-muted">{id === "behaviors" ? `${count} · ${view.groups.length}` : count}</span> : null}
                <span className="sr-only">{view.status === "empty" ? t("caseMap.status.empty") : statusText(t, view)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The items of a part (and its groups, for behaviors), to choose one; and the buttons that add one. */
function ItemList({
  view,
  part,
  selectedId,
  addRef,
  onAdd,
  onSelect,
}: {
  view: MapPartView;
  part: MapPartId;
  selectedId: string | null;
  addRef: RefObject<HTMLButtonElement | null>;
  onAdd: (collection: MapCollection) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  /** A behavior's functions, primary first, as clinical terms ("Escape · Attention"). */
  const functionsOf = (item: Record<string, unknown>): string | null => {
    const fn = item.function as { primary?: string[]; secondary?: string[] } | undefined;
    const names = [...(fn?.primary ?? []), ...(fn?.secondary ?? [])].map((name) => (MAP_TERMS.functions as Record<string, string>)[name] ?? name);
    return names.length > 0 ? names.join(" · ") : null;
  };
  const row = (item: Record<string, unknown> & { id: string; editedAt: string | null }, collection: MapCollection) => {
    const checks = countChecks(item);
    return (
      <li key={item.id}>
        <button
          type="button"
          aria-current={selectedId === item.id ? "true" : undefined}
          onClick={() => onSelect(item.id)}
          className="flex w-full flex-col items-start gap-0.5 rounded-md border border-transparent px-2.5 py-2 text-left hover:bg-surface-muted aria-current:border-border-control aria-current:bg-mark"
        >
          <span lang="en" className="text-sm font-semibold break-words">
            {itemTitle(collection === "groups" ? "groups" : part, item) ?? t("caseMap.untitled")}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            {item.editedAt ? <StatusBadge tone="accent">{t("caseMap.editedByYou")}</StatusBadge> : <StatusBadge>{t("caseMap.status.draft")}</StatusBadge>}
            {part === "behaviors" && collection === "items" && functionsOf(item) ? <span lang="en">{functionsOf(item)}</span> : null}
            {checks > 0 ? <span>{t("caseMap.checks", { count: checks })}</span> : null}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {part !== "report" ? (
        <div>
          <Button ref={addRef} size="sm" onClick={() => onAdd("items")}>
            {t(`caseMap.add.${part as Exclude<MapPartId, "report">}`)}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-0.5">{view.items.map((item) => row(item as unknown as Record<string, unknown> & { id: string; editedAt: string | null }, "items"))}</ul>
      {part === "behaviors" ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Eyebrow className="text-fg-muted">{t("caseMap.groupsHeading")}</Eyebrow>
          <p className="text-xs text-fg-muted">{t("caseMap.groupsHint")}</p>
          <ul className="flex flex-col gap-0.5">{view.groups.map((group) => row(group as unknown as Record<string, unknown> & { id: string; editedAt: string | null }, "groups"))}</ul>
          <div>
            <Button size="sm" onClick={() => onAdd("groups")}>
              {t("caseMap.add.groups")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One item's form, saved as she types. The form's text is the item's fields as JSON
 * (values and [CHECK]s), so the autosave and the kept-text paths of a section's text
 * serve it as they are.
 */
function ItemEditor({
  caseId,
  part,
  collection,
  item,
  context,
  autoFocus,
  onFocused,
  editingFor,
  onSaved,
  onRemove,
}: {
  caseId: string;
  part: MapPartId;
  collection: MapCollection;
  item: Record<string, unknown>;
  context: MapFormContext;
  autoFocus: boolean;
  /** The first field took the focus: it never takes it again (review round 2, R2-4). */
  onFocused: () => void;
  editingFor: () => number | null;
  onSaved: (result: MapSaveResult | null) => boolean;
  onRemove: (() => void) | null;
}) {
  const { t } = useTranslation();
  const itemId = String(item.id);
  const fields = fieldsOf(part, collection);
  const [initial] = useState(() => JSON.stringify(itemInput(fields, item)));
  const save = useCallback(
    async (text: string) => {
      const result = await window.aba.saveMapItem(caseId, part, collection, itemId, text, editingFor()).catch(() => null);
      return onSaved(result);
    },
    [caseId, part, collection, itemId, editingFor, onSaved],
  );
  const box = useAutosave({ caseId, initial, save });
  const mapItem = `${part}/${collection}/${itemId}`;
  const ready = useKeptText(
    box,
    useCallback((failed: FailedSave) => failed.about === "map" && failed.caseId === caseId && failed.mapItem === mapItem, [caseId, mapItem]),
  );
  const value = useMemo(() => {
    try {
      return JSON.parse(box.value) as Record<string, unknown>;
    } catch {
      return JSON.parse(initial) as Record<string, unknown>;
    }
  }, [box.value, initial]);
  const labelPart = collection === "groups" ? "groups" : part;
  const sectionRef = useRef<HTMLElement | null>(null);
  // A new item: its first field takes the focus, so she types at once (review round 1, minor 7).
  useEffect(() => {
    if (!autoFocus) return;
    sectionRef.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    onFocused();
  }, [autoFocus, onFocused]);
  return (
    <section ref={sectionRef} aria-label={itemTitle(labelPart, item) ?? t("caseMap.untitled")} className="@container flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 lang="en" className="text-md font-semibold break-words">
          {itemTitle(labelPart, item) ?? t("caseMap.untitled")}
        </h2>
        <span className="flex-1" />
        <span aria-live="polite" className="text-xs text-fg-muted">
          {box.status === "saving" ? t("sources.saving") : box.status === "saved" ? t("caseMap.saved") : ""}
        </span>
        {onRemove ? (
          // What she typed is saved before she is asked: never sent after the item is gone. When
          // it cannot be saved she is not asked (the failure shows, with Try again: review round 2, R2-5).
          <Button
            size="sm"
            onClick={() =>
              void box.flush().then((saved) => {
                if (saved) onRemove();
              })
            }
          >
            {t("caseMap.remove")}
          </Button>
        ) : null}
      </div>
      {part === "report" ? <ReportText item={item} /> : null}
      {box.status === "failed" ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-danger">
          {t("caseMap.actionFailed")}
          <Button size="sm" onClick={() => void box.retry()}>
            {t("sources.tryAgain")}
          </Button>
        </p>
      ) : null}
      <fieldset disabled={!ready} className="contents" onBlur={() => void box.flush()}>
        <MapFields fields={fields} labelPart={labelPart} value={value} saved={item} onChange={(next) => box.setValue(JSON.stringify(next))} context={context} />
      </fieldset>
    </section>
  );
}

/** A report item is the AI's: its kind and text are read here; she marks its status. */
function ReportText({ item }: { item: Record<string, unknown> }) {
  const { t } = useTranslation();
  const kind = typeof item.kind === "string" ? item.kind : "";
  return (
    <div className="flex flex-col gap-1">
      <Eyebrow as="p" className="text-fg-muted">
        {t(`caseMap.reportKinds.${kind}` as "caseMap.title", { defaultValue: kind })}
      </Eyebrow>
      <p lang="en" className="max-w-measure text-md">
        {typeof item.text === "string" ? item.text : ""}
      </p>
    </div>
  );
}

/** The rail: what approving means, what is still to check in this part, and its versions, newest first, to show another one. */
function PartRail({ view, part, onShow, onSelect }: { view: MapPartView; part: MapPartId; onShow: (version: number) => void; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const when = (iso: string) => new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  const toCheck = [...view.items.map((item) => ({ item: item as unknown as Record<string, unknown> & { id: string }, list: part })), ...view.groups.map((group) => ({ item: group as unknown as Record<string, unknown> & { id: string }, list: "groups" as const }))].flatMap(({ item, list }) =>
    checksOf(item).map((text, index) => ({ key: `${item.id}-${index}`, id: item.id, title: itemTitle(list, item) ?? t("caseMap.untitled"), text })),
  );
  return (
    <>
      <section className="flex flex-col gap-2">
        <Eyebrow className="text-fg-muted">{t("caseMap.aboutHeading")}</Eyebrow>
        <p className="text-sm">{t("caseMap.approvalNote")}</p>
        <p className="text-sm text-fg-muted">{t("caseMap.chipsNote")}</p>
      </section>
      <section className="flex flex-col gap-2">
        <Eyebrow className="text-fg-muted">{t("caseMap.toCheckHeading", { count: toCheck.length })}</Eyebrow>
        {toCheck.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("caseMap.toCheckEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {toCheck.map((entry) => (
              <li key={entry.key} className="text-sm">
                <button type="button" onClick={() => onSelect(entry.id)} className="text-left underline-offset-2 hover:underline">
                  <span lang="en" className="font-semibold">
                    {entry.title}
                  </span>
                  : <span lang="en">{entry.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <Eyebrow className="text-fg-muted">{t("caseMap.history")}</Eyebrow>
        {view.versions.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("caseMap.historyEmpty")}</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {[...view.versions].reverse().map((version) => (
              <li key={version.number} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-mono">v{version.number}</span> · {t(`caseMap.versionKind.${version.kind}`)}
                  <span className="block font-mono text-xs text-fg-muted">{when(version.updatedAt ?? version.createdAt)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {view.approvedVersion === version.number ? <StatusBadge tone="success">{t("caseMap.status.approved")}</StatusBadge> : null}
                  {view.currentVersion === version.number ? (
                    <StatusBadge>{t("caseMap.versionShown")}</StatusBadge>
                  ) : (
                    <Button size="sm" onClick={() => onShow(version.number)}>
                      {t("caseMap.show", { number: version.number })}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
