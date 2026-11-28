import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapSaveResult } from "../../../shared/api.ts";
import { TEMPLATE_SECTIONS } from "../../../shared/case-map.ts";
import { isCopied, type CopyField, type CopyGroup } from "../../../shared/plan-copy.ts";
import type { PlanView } from "../../../shared/plan.ts";
import { Button } from "../components/Button.tsx";
import { cn } from "../components/cn.ts";
import { Icon } from "../components/Icon.tsx";
import { Eyebrow } from "../shell/WorkArea.tsx";

/*
 * Copy for ABA Matrix, field by field (the Plan step's D22 and D23): the fields of her
 * accepted plan in ABA Matrix's order (11, 12, 14 per function and per column, 15, 16's
 * goals), each with "✓ Copiado" while what she copied last is what she would copy now, the
 * plain text exactly as pasted, "Copiar este campo", and "Copiar el bloque entero" for a
 * function block. The text is rendered and put on the clipboard by the main process, from
 * what is saved (src/shared/plan-copy.ts); the screen only shows the same rendering.
 * Revisión y copia lists the same fields (`compact`).
 */

export function sectionTitle(section: number): string {
  return `${section} · ${TEMPLATE_SECTIONS[section - 1]}`;
}

/** Copies fields (one, or a block's), and gives the plan as saved with its marks. */
export function useCopyFields(caseId: string, onSaved: (result: MapSaveResult) => void) {
  const [last, setLast] = useState<{ ids: string[]; ok: boolean; markers: number; serial: number } | null>(null);
  const serial = useRef(0);
  const copy = async (ids: string[]) => {
    const result = await window.aba.copyPlanFields(caseId, ids).catch(() => null);
    if (result?.outcome === "copied") {
      if (result.result) onSaved(result.result);
      setLast({ ids, ok: true, markers: result.markers, serial: ++serial.current });
    } else setLast({ ids, ok: false, markers: 0, serial: ++serial.current });
  };
  return { copy, last };
}

function CopiedMark() {
  const { t } = useTranslation();
  return (
    <span data-testid="plan-copied" className="flex shrink-0 items-center gap-1 text-sm font-medium text-success">
      <Icon name="check" />
      {t("planStep.copy.copied")}
    </span>
  );
}

/** The list of fields, grouped by ABA Matrix section: in the Plan's copy view, each row selects its field. */
export function CopyList({ groups, plan, selected, onSelect }: { groups: readonly CopyGroup[]; plan: PlanView; selected: string | null; onSelect: (fieldId: string) => void }) {
  const { t } = useTranslation();
  const sections = [...new Set(groups.map((group) => group.section))];
  return (
    <nav aria-label={t("planStep.copy.listLabel")} className="flex flex-col gap-3">
      {sections.map((section) => (
        <section key={section} className="flex flex-col gap-1.5">
          <Eyebrow className="text-fg-muted">
            <span lang="en">{sectionTitle(section)}</span>
          </Eyebrow>
          <ul className="flex flex-col gap-1">
            {groups
              .filter((group) => group.section === section)
              .flatMap((group) =>
                group.fields.map((field) => (
                  <li key={field.id}>
                    <button
                      type="button"
                      data-field={field.id}
                      aria-current={selected === field.id ? "true" : undefined}
                      onClick={() => onSelect(field.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm",
                        selected === field.id ? "border-accent bg-ai-subtle" : "border-border bg-surface hover:bg-surface-muted",
                      )}
                    >
                      <span lang="en" className="min-w-0 flex-1 break-words">
                        {group.fields.length > 1 ? `${group.label} · ${field.label}` : group.label}
                      </span>
                      {field.markers > 0 ? <span className="text-xs text-warning">{t("planStep.copy.markers", { count: field.markers })}</span> : null}
                      {isCopied(plan, field) ? <CopiedMark /> : null}
                    </button>
                  </li>
                )),
              )}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** The field chosen: its text exactly as pasted, where it goes, and its copy buttons. */
export function CopyPreview({ group, field, plan, onCopy, last }: { group: CopyGroup; field: CopyField; plan: PlanView; onCopy: (ids: string[]) => void; last: ReturnType<typeof useCopyFields>["last"] }) {
  const { t } = useTranslation();
  const headingId = useId();
  const words = field.text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  const lastHere = last && last.ids.includes(field.id) ? last : null;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} lang="en" className="text-md font-semibold">
          {group.fields.length > 1 ? `${group.label} · ${field.label}` : group.label}
        </h2>
        <p className="text-sm text-fg-muted">{t("planStep.copy.plain", { count: words })}</p>
      </div>
      <pre data-testid="plan-copy-text" lang="en" className="max-h-[28rem] overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-sm whitespace-pre-wrap">
        {field.text}
      </pre>
      {group.values.length > 0 ? (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {group.values.map((entry) => (
            <div key={entry.label} className="flex gap-1.5">
              <dt className="text-fg-muted" lang="en">
                {entry.label}:
              </dt>
              <dd lang="en" className="font-medium">
                {entry.value}
              </dd>
            </div>
          ))}
          <p className="w-full text-xs text-fg-muted">{t("planStep.copy.valuesNote")}</p>
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" data-testid="plan-copy-field" onClick={() => onCopy([field.id])}>
          <Icon name="copy" />
          {t("planStep.copy.field")}
        </Button>
        {group.whole ? (
          <Button data-testid="plan-copy-block" onClick={() => onCopy(group.fields.map((item) => item.id))}>
            {t("planStep.copy.block", { name: group.label })}
          </Button>
        ) : null}
        {isCopied(plan, field) ? <CopiedMark /> : null}
      </div>
      <p className="text-sm text-fg-muted">{t("planStep.copy.where", { field: field.label, group: group.label })}</p>
      <p role="status" className="text-sm">
        {lastHere ? (lastHere.ok ? (lastHere.markers > 0 ? t("planStep.copy.doneMarked", { count: lastHere.markers }) : t("planStep.copy.done")) : t("planStep.copy.failed")) : ""}
      </p>
    </section>
  );
}

/** Revisión y copia's list of the plan's fields: each with its mark and its own Copiar, and a block's "entero". */
export function CompactCopyList({ groups, plan, onCopy, last }: { groups: readonly CopyGroup[]; plan: PlanView; onCopy: (ids: string[]) => void; last: ReturnType<typeof useCopyFields>["last"] }) {
  const { t } = useTranslation();
  const sections = [...new Set(groups.map((group) => group.section))];
  return (
    <div data-testid="review-plan-fields" className="flex flex-col gap-3">
      {sections.map((section) => (
        <section key={section} className="flex flex-col gap-1.5">
          <Eyebrow className="text-fg-muted">
            <span lang="en">{sectionTitle(section)}</span>
          </Eyebrow>
          <ul className="flex flex-col rounded-lg border border-border bg-surface">
            {groups
              .filter((group) => group.section === section)
              .map((group) => (
                <li key={group.id} className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span lang="en" className="flex-1 text-sm font-semibold">
                      {group.label}
                    </span>
                    {group.whole ? (
                      <Button size="sm" onClick={() => onCopy(group.fields.map((field) => field.id))}>
                        {t("planStep.copy.block", { name: group.label })}
                      </Button>
                    ) : null}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {group.fields.map((field) => (
                      <li key={field.id} data-field={field.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span lang="en" className="min-w-0 flex-1">
                          {field.label}
                        </span>
                        {field.markers > 0 ? <span className="text-xs text-warning">{t("planStep.copy.markers", { count: field.markers })}</span> : null}
                        {isCopied(plan, field) ? <CopiedMark /> : null}
                        <Button size="sm" aria-label={t("planStep.copy.fieldNamed", { name: `${group.label} · ${field.label}` })} onClick={() => onCopy([field.id])}>
                          <Icon name="copy" />
                          {t("section.copyShort")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <p role="status" className="text-sm">
        {last ? (last.ok ? t("planStep.copy.done") : t("planStep.copy.failed")) : ""}
      </p>
    </div>
  );
}
