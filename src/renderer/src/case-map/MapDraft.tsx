import { useState } from "react";
import { useTranslation } from "react-i18next";
import { THRESHOLDS_DRAFT } from "../../../shared/case-map-thresholds.ts";
import { trackSave } from "../case-saves.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose } from "../components/Dialog.tsx";
import { TextLink } from "../components/Link.tsx";
import { PROVIDER_NAMES, useProviders } from "../drafting-provider.tsx";
import { Eyebrow } from "../shell/WorkArea.tsx";
import { dismissMapDraft, isDrafting, startMapDraft, stopMapDraft, useMapDraft, type MapDraft } from "./draft.ts";

/*
 * The case map's AI way (step 1, pull request 2): the action that drafts or updates the
 * map, its progress per part, and her definition thresholds. Kept apart from the screen
 * so it moves as it is into the "Con la IA" side of the two-ways bar when that lands
 * (the UX redesign, UX-3).
 */

/** "Draft the map with the AI" / "Update the map with the AI": the AI's action, in the AI's color. */
export function MapAiButton({ caseId, hasMap }: { caseId: string; hasMap: boolean }) {
  const { t } = useTranslation();
  const providers = useProviders();
  const draft = useMapDraft(caseId);
  const running = isDrafting(draft);
  const [refused, setRefused] = useState<string | null>(null);
  async function start() {
    if (!providers.provider) return;
    setRefused(null);
    dismissMapDraft(caseId);
    const outcome = await startMapDraft(caseId, providers.provider);
    if (outcome !== "started") setRefused(outcome);
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="primary" disabled={running || providers.provider === null} onClick={() => void start()}>
        {hasMap ? t("caseMap.ai.update") : t("caseMap.ai.draft")}
      </Button>
      {refused ? (
        <span role="alert" className="text-xs font-medium text-danger">
          {refused === "busy" ? t("caseMap.ai.busy") : refused === "not-connected" ? t("caseMap.ai.notConnected") : t("caseMap.ai.notStarted")}
        </span>
      ) : null}
    </span>
  );
}

const PARTS_OF_STEP = { "map-facts": "caseMap.ai.stepFacts", "map-behaviors": "caseMap.ai.stepBehaviors" } as const;

/** Where a draft is, while it runs, and how it ended. Nothing shows when no draft was started here. */
export function MapDraftPanel({ caseId }: { caseId: string }) {
  const { t } = useTranslation();
  const draft = useMapDraft(caseId);
  const providers = useProviders();
  if (!draft) {
    return providers.provider === null ? (
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

function Running({ draft }: { draft: MapDraft }) {
  const { t } = useTranslation();
  const step = draft.step ?? "map-facts";
  const phase =
    draft.phase === "repairing"
      ? t("caseMap.ai.repairing")
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
      </ol>
      <p className="text-sm">{phase}</p>
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
  const detail = outcome?.kind === "failed" || outcome?.kind === "partial" ? outcome.message : null;
  return (
    <>
      <p role={outcome?.kind === "saved" ? undefined : "alert"} className="text-sm font-medium">
        {message}
        {detail ? <span className="block font-normal text-fg-muted">{detail}</span> : null}
      </p>
      {draft.problems > 0 ? <p className="text-sm text-warning">{t("caseMap.ai.problems", { count: draft.problems })}</p> : null}
      {draft.kept.length > 0 ? <p className="text-sm text-fg-muted">{t("caseMap.ai.kept")}</p> : null}
      <div>
        <Button size="sm" onClick={() => dismissMapDraft(draft.caseId)}>
          {t("caseMap.ai.dismiss")}
        </Button>
      </div>
    </>
  );
}

/** The two ways to start an empty map: by hand, or with the AI. */
export function MapWays({ caseId, onByHand }: { caseId: string; onByHand: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 @3xl:grid-cols-2">
      <section className="flex flex-col items-start gap-2 rounded-lg border border-border p-4">
        <h2 className="text-md font-semibold">{t("caseMap.ways.byHandTitle")}</h2>
        <p className="text-sm text-fg-muted">{t("caseMap.ways.byHandBody")}</p>
        <Button onClick={onByHand}>{t("caseMap.add.behaviors")}</Button>
      </section>
      <section className="flex flex-col items-start gap-2 rounded-lg border border-accent bg-mark p-4">
        <h2 className="text-md font-semibold">{t("caseMap.ways.withAiTitle")}</h2>
        <p className="text-sm">{t("caseMap.ways.withAiBody")}</p>
        <MapAiButton caseId={caseId} hasMap={false} />
        <p className="text-xs text-fg-muted">{t("caseMap.ai.time")}</p>
      </section>
    </div>
  );
}

/**
 * Her thresholds for behavior definitions (D16): offered once from what her assessments
 * show, confirmed by her, and from then on her standing instructions for the map. Until
 * she confirms them, the AI leaves each threshold as [MISSING] in the definitions.
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
