import type { TFunction } from "i18next";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { THRESHOLDS_DRAFT } from "../../../shared/case-map-thresholds.ts";
import { aiErrorKind, aiErrorNeedsSettings } from "../ai-errors.ts";
import { trackSave } from "../case-saves.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { TwoWays } from "../components/TwoWays.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { PROVIDER_NAMES, useProviders } from "../drafting-provider.tsx";
import { Eyebrow } from "../shell/WorkArea.tsx";
import { draftOffered } from "./draft-state.ts";
import { dismissMapDraft, isDrafting, previewsNotSaved, startMapDraft, stopMapDraft, useMapDraft, useMapReview, type MapDraft } from "./draft.ts";

/*
 * The case map's AI way (step 1, pull request 2): the action that drafts or updates the
 * map, its progress per part, and her definition thresholds. An empty map offers it in the
 * "Con la IA" card of the shared two ways (UX-3's TwoWays); once the map has content it
 * stays in the header until the step adopts the two-ways bar.
 */

/**
 * "Draft the map with the AI" / "Update the map with the AI": the AI's action, in the AI's
 * color, marked Beta with one line saying its evaluation is in progress (owner's decision,
 * 2026-11-23: it ships in v0.2.0 before the map's evaluation). The line describes the
 * button, so the header's and the empty map's buttons each say it (review round 1, M10).
 */
export function MapAiButton({ caseId, hasMap, align = "end" }: { caseId: string; hasMap: boolean; align?: "start" | "end" }) {
  const { t } = useTranslation();
  const providers = useProviders();
  const draft = useMapDraft(caseId);
  const running = isDrafting(draft);
  // Never while a review she started runs: the draft ends with its own review (review of T3, nit 10).
  const offered = draftOffered({ connected: providers.provider !== null, drafting: running, reviewing: useMapReview(caseId)?.phase === "running" });
  const [refused, setRefused] = useState<string | null>(null);
  const noteId = useId();
  async function start() {
    if (!providers.provider) return;
    setRefused(null);
    dismissMapDraft(caseId);
    const outcome = await startMapDraft(caseId, providers.provider);
    if (outcome !== "started") setRefused(outcome);
  }
  return (
    <span className={align === "end" ? "inline-flex flex-col items-end gap-1" : "inline-flex flex-col items-start gap-1"}>
      <span className="inline-flex items-center gap-2">
        <Button variant="ai" disabled={!offered} onClick={() => void start()} aria-describedby={noteId}>
          <Icon name="sparkle" />
          {hasMap ? t("caseMap.ai.update") : t("caseMap.ai.draft")}
        </Button>
        <span className="rounded-sm border border-accent px-1.5 py-0.5 text-xs font-semibold tracking-wide text-accent uppercase">{t("caseMap.ai.beta")}</span>
      </span>
      <span id={noteId} className="text-xs text-fg-muted">
        {t("caseMap.ai.betaNote")}
      </span>
      {refused ? (
        <span role="alert" className="text-xs font-medium text-danger">
          {refused === "busy" ? t("caseMap.ai.busy") : refused === "not-connected" ? t("caseMap.ai.notConnected") : t("caseMap.ai.notStarted")}
        </span>
      ) : null}
    </span>
  );
}

const PARTS_OF_STEP = { "map-facts": "caseMap.ai.stepFacts", "map-behaviors": "caseMap.ai.stepBehaviors" } as const;

/**
 * Where a draft is, while it runs, and how it ended. With no draft started here, a line
 * says to connect the AI when none is, unless `quiet`: the empty map's AI card says it
 * already (review round 1 of case map speed, M4).
 */
export function MapDraftPanel({ caseId, quiet = false }: { caseId: string; quiet?: boolean }) {
  const { t } = useTranslation();
  const draft = useMapDraft(caseId);
  const providers = useProviders();
  if (!draft) {
    return providers.provider === null && !quiet ? (
      <p className="max-w-measure text-sm text-fg-muted">
        {t("caseMap.ai.notConnected")} <TextLink to="/settings">{t("caseMap.ai.settingsLink")}</TextLink>
      </p>
    ) : null;
  }
  return (
    <section aria-live="polite" className="flex flex-col gap-2 rounded-md border border-accent bg-mark px-3.5 py-3">
      {isDrafting(draft) ? <Running draft={draft} /> : <Finished draft={draft} />}
    </section>
  );
}

/** The time now, again every second while a draft runs, so the time shown is the time it took. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A length of time as "12 min 5 s" ("min" and "s" in both screen languages). */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/**
 * What a repair asks for, by its scope (review round 1 of case map speed, S5): those values
 * only, the items that hold them, or the whole answer again.
 */
function repairLine(t: TFunction, draft: MapDraft): string {
  if (draft.scope === "values" && draft.values > 0) return t("caseMap.ai.repairingValues", { count: draft.values });
  if (draft.scope === "items") return draft.values > 0 ? t("caseMap.ai.repairingItems", { count: draft.values }) : t("caseMap.ai.repairing");
  return draft.values > 0 ? t("caseMap.ai.repairingWhole", { count: draft.values }) : t("caseMap.ai.repairingAnswer");
}

function Running({ draft }: { draft: MapDraft }) {
  const { t } = useTranslation();
  const now = useNow();
  const step = draft.step ?? "map-facts";
  const phase =
    draft.phase === "repairing"
      ? repairLine(t, draft)
      : draft.phase === "plain-json"
        ? t("caseMap.ai.plainJson")
        : draft.characters > 0
          ? t("caseMap.ai.writing", { count: draft.characters })
          : t("caseMap.ai.reading", { provider: PROVIDER_NAMES[draft.provider] });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow as="p" className="text-fg-on-accent-subtle">
          {t("caseMap.ai.working")}
        </Eyebrow>
        <span className="flex-1" />
        <Button size="sm" onClick={() => stopMapDraft(draft)}>
          {t("caseMap.ai.stop")}
        </Button>
      </div>
      <ol className="flex flex-col gap-1 text-sm">
        {(["map-facts", "map-behaviors"] as const).map((kind) => (
          <li key={kind} className={kind === step ? "font-semibold" : draft.saved.includes(kind) ? "text-success" : "text-fg-muted"}>
            {draft.saved.includes(kind) ? t("caseMap.ai.done") : kind === step ? t("caseMap.ai.now") : t("caseMap.ai.next")} {t(PARTS_OF_STEP[kind])}
          </li>
        ))}
        {/* The review of the definitions that follows the behaviors (T3): one short request. */}
        <li className={draft.reviewing ? "font-semibold" : draft.review ? "text-success" : "text-fg-muted"}>
          {draft.review ? t("caseMap.ai.done") : draft.reviewing ? t("caseMap.ai.now") : t("caseMap.ai.next")} {t("caseMap.ai.stepReview")}
        </li>
      </ol>
      <p className="text-sm">{draft.reviewing ? t("caseMap.qa.reviewing") : phase}</p>
      {/* Two sentences, each with its own count, so each plural follows its own number (M3). */}
      {draft.arrived > 0 && draft.phase !== "repairing" ? (
        <p className="text-sm">
          {t("caseMap.ai.arrived", { count: draft.arrived })} {t("caseMap.ai.shown", { count: draft.shown })}
        </p>
      ) : null}
      {/* The time it has taken, measured; no estimate of the time left (owner's decision, 2026-11-23). */}
      <p className="text-xs tabular-nums" data-testid="map-elapsed">
        {t("caseMap.ai.elapsed", { total: formatElapsed(now - draft.startedAt), step: formatElapsed(now - draft.stepStartedAt) })}
      </p>
      <p className="text-xs text-fg-muted">{t("caseMap.ai.time")}</p>
    </>
  );
}

function Finished({ draft }: { draft: MapDraft }) {
  const { t } = useTranslation();
  const outcome = draft.outcome;
  const message =
    outcome?.kind === "saved"
      ? t("caseMap.ai.saved")
      : outcome?.kind === "partial"
        ? t("caseMap.ai.partial")
        : outcome?.kind === "stopped"
          ? t("caseMap.ai.stopped")
          : outcome?.kind === "refused"
            ? t("caseMap.ai.refused")
            : t("caseMap.ai.failed");
  // What went wrong in her words, by kind; the provider's English text only under "Technical details" (owner's decision T11).
  const failure = outcome?.kind === "failed" || outcome?.kind === "partial" ? outcome : null;
  const kind = failure?.code ? aiErrorKind(failure.code) : null;
  return (
    <>
      <p role={outcome?.kind === "saved" ? undefined : "alert"} className="text-sm font-medium">
        {message}
        {kind ? ` ${t(`section.failedWhy.${kind}`)}` : null}
      </p>
      {kind && aiErrorNeedsSettings(kind) ? (
        <div>
          <ButtonLink to="/settings" size="sm">
            {t("caseMap.ai.settingsLink")}
          </ButtonLink>
        </div>
      ) : null}
      {failure?.message ? (
        <details className="text-sm text-fg-muted">
          <summary className="w-fit cursor-pointer rounded-sm underline underline-offset-2 hover:decoration-2">{t("section.technicalDetails")}</summary>
          <p lang="en" data-testid="map-error-details" className="mt-1 break-words">
            {failure.message}
          </p>
        </details>
      ) : null}
      {/* The items she saw arrive went with the request that did not save: said, not left to be guessed (M5). */}
      {outcome?.kind !== "saved" && previewsNotSaved(draft) ? <p className="text-sm">{t("caseMap.ai.previewsNotSaved")}</p> : null}
      {draft.problems > 0 ? <p className="text-sm text-warning">{t("caseMap.ai.problems", { count: draft.problems })}</p> : null}
      {draft.kept.length > 0 ? <p className="text-sm text-fg-muted">{t("caseMap.ai.kept")}</p> : null}
      {draft.review === "failed" ? <p className="text-sm text-warning">{t("caseMap.qa.reviewFailed")}</p> : null}
      <div>
        <Button size="sm" onClick={() => dismissMapDraft(draft.caseId)}>
          {t("caseMap.ai.dismiss")}
        </Button>
      </div>
    </>
  );
}

/**
 * The two ways to start an empty map, as on every step (UX-3's TwoWays): by hand, or with
 * the AI. With no AI connected, the AI card offers "Connect the AI" instead (P7).
 */
export function MapWays({ caseId, onByHand }: { caseId: string; onByHand: () => void }) {
  const { t } = useTranslation();
  const providers = useProviders();
  return (
    <TwoWays
      layout="cards"
      aiConnected={providers.provider !== null || providers.loading}
      hand={{
        title: t("caseMap.ways.byHandTitle"),
        body: t("caseMap.ways.byHandBody"),
        actions: (
          <Button onClick={onByHand}>
            <Icon name="pencil" />
            {t("caseMap.add.behaviors")}
          </Button>
        ),
      }}
      ai={{
        title: t("caseMap.ways.withAiTitle"),
        body: (
          <>
            {t("caseMap.ways.withAiBody")} {t("caseMap.ai.time")}
          </>
        ),
        actions: <MapAiButton caseId={caseId} hasMap={false} align="start" />,
      }}
    />
  );
}

/**
 * Her thresholds for behavior definitions (D16). Her defaults from the questionnaire are in
 * the rules for every user (owner's decision, 2026-11-28); what she saves here becomes her
 * standing instructions for the map and overrides them. "confirmed" means she saved her own.
 */
export function ThresholdsBlock({ caseId, instructions, onSaved }: { caseId: string; instructions: string; onSaved: (text: string) => void }) {
  const { t } = useTranslation();
  const confirmed = instructions.trim() !== "";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(confirmed ? instructions : THRESHOLDS_DRAFT);
  const [failed, setFailed] = useState(false);
  async function save() {
    setFailed(false);
    const ok = await trackSave(
      caseId,
      window.aba.saveSectionInstructions(caseId, "case-map", text).then((result) => result.outcome === "saved"),
    );
    if (!ok) return setFailed(true);
    onSaved(text);
    setOpen(false);
  }
  return (
    <section className="flex flex-col gap-2">
      <Eyebrow className="text-fg-muted">{t("caseMap.thresholds.heading")}</Eyebrow>
      <p className="text-sm">{confirmed ? t("caseMap.thresholds.confirmed") : t("caseMap.thresholds.notConfirmed")}</p>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setText(confirmed ? instructions : THRESHOLDS_DRAFT);
        }}
        trigger={<Button size="sm">{confirmed ? t("caseMap.thresholds.edit") : t("caseMap.thresholds.review")}</Button>}
        title={t("caseMap.thresholds.dialogTitle")}
        popupClassName="w-[min(40rem,calc(100vw-2rem))]"
      >
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-sm">{confirmed ? t("caseMap.thresholds.dialogBodyConfirmed") : t("caseMap.thresholds.dialogBody")}</p>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t("caseMap.thresholds.label")}
            <textarea lang="en" value={text} onChange={(event) => setText(event.target.value)} className="field-sizing-content min-h-48 max-h-[60dvh] w-full resize-y rounded-md border border-border-control bg-surface px-3 py-2 text-md font-normal text-fg" />
          </label>
          {failed ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t("caseMap.actionFailed")}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose render={<Button />}>{t("caseMap.cancel")}</DialogClose>
            <Button variant="primary" disabled={text.trim() === ""} onClick={() => void save()}>
              {confirmed ? t("caseMap.thresholds.save") : t("caseMap.thresholds.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
