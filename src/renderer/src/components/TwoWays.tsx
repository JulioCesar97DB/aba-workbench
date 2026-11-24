import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./cn.ts";
import { Icon } from "./Icon.tsx";
import { ButtonLink } from "./Link.tsx";

/*
 * The two ways of doing a step, shown the same way on every step (owner's proposal §3.1):
 * "A mano" on the left (neutral, a pencil), "Con la IA" on the right (the AI's amber tint,
 * a sparkle). Two cards while the step is empty; a slim bar once it has content.
 *
 * When no AI is connected the AI side keeps its color: its button becomes "Conectar la
 * IA", which goes to Settings, with one sentence saying so (owner's decision P7). It is
 * never greyed out.
 *
 * Used by a report section (screens/Section.tsx), Documentos, and the empty case map
 * (case-map/MapDraft.tsx). Props in docs/interface.md, "Shared pieces".
 */

export interface Way {
  /** The card's title (cards only; the bar has none). */
  title?: string;
  /** One sentence on what this way does here. */
  body: ReactNode;
  /** Its button or buttons. On the AI side, AI-style buttons (`variant="ai"`), or none when the AI has no role in the step. */
  actions?: ReactNode;
}

export function TwoWays({
  layout,
  hand,
  ai,
  aiConnected = true,
  connectWithoutActions = false,
  active,
}: {
  /** "cards" while the step is empty; "bar" once it has content. */
  layout: "cards" | "bar";
  hand: Way;
  ai: Way;
  /** False when no AI is connected: the AI side's actions become "Conectar la IA" (to Settings). Ignored when `ai.actions` is empty, unless `connectWithoutActions`. */
  aiConnected?: boolean;
  /**
   * Also offer "Conectar la IA" on an AI side with no actions of its own (one that only says
   * what the AI does with the step later, Documentos) while no AI is connected (P7: inside
   * every AI card).
   */
  connectWithoutActions?: boolean;
  /** The way she is using now (the bar), marked by a bar on its edge and in words to a screen reader. */
  active?: "hand" | "ai";
}) {
  const { t } = useTranslation();
  const connect = !aiConnected && (ai.actions !== undefined || connectWithoutActions);
  const aiSide: Way = connect
    ? {
        ...ai,
        body: (
          <>
            {ai.body} {t("twoWays.connectSentence")}
          </>
        ),
        actions: (
          <ButtonLink to="/settings" variant="ai" size={layout === "bar" ? "sm" : "md"} data-testid="connect-ai">
            <Icon name="sparkle" />
            {t("twoWays.connect")}
          </ButtonLink>
        ),
      }
    : ai;
  const sides = [
    { key: "hand" as const, way: hand, icon: "pencil" as const, label: t("twoWays.hand") },
    { key: "ai" as const, way: aiSide, icon: "sparkle" as const, label: t("twoWays.ai") },
  ];

  if (layout === "cards") {
    return (
      <div data-testid="two-ways" data-layout="cards" className="grid gap-3 @split:grid-cols-2">
        {sides.map(({ key, way, icon, label }) => (
          <section
            key={key}
            data-way={key}
            aria-label={label}
            className={cn("flex flex-col items-start gap-2 rounded-lg border p-4.5", key === "hand" ? "border-border-control bg-surface" : "border-accent bg-ai-subtle")}
          >
            <p aria-hidden="true" className={cn("flex items-center gap-2 text-2xs font-semibold tracking-eyebrow uppercase", key === "ai" ? "text-fg-on-accent-subtle" : "text-fg")}>
              <Icon name={icon} size={14} />
              {label}
            </p>
            {way.title ? <h2 className={cn("text-md font-semibold", key === "ai" && "text-fg-on-accent-subtle")}>{way.title}</h2> : null}
            <p className={cn("text-sm", key === "ai" ? "text-fg-on-accent-subtle" : "text-fg-muted")}>{way.body}</p>
            {way.actions ? <div className="mt-auto flex flex-wrap gap-2 pt-1.5">{way.actions}</div> : null}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="two-ways" data-layout="bar" className="grid overflow-hidden rounded-lg border border-border-control @split:grid-cols-2">
      {sides.map(({ key, way, icon, label }) => (
        <section
          key={key}
          data-way={key}
          data-active={active === key || undefined}
          aria-label={label}
          className={cn(
            "flex items-center gap-3 px-4 py-2.5 text-sm",
            key === "hand" ? "bg-surface" : "border-t border-border-control bg-ai-subtle text-fg-on-accent-subtle @split:border-t-0 @split:border-l",
            active === key && "shadow-[inset_3px_0_0_var(--color-accent)]",
          )}
        >
          <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5 text-2xs font-semibold tracking-eyebrow uppercase">
            <Icon name={icon} size={14} />
            {label}
          </span>
          <p className="min-w-0 flex-1">
            {active === key ? <span className="sr-only">{t("twoWays.activeNow")} </span> : null}
            {way.body}
          </p>
          {way.actions ? <div className="flex shrink-0 flex-wrap gap-2">{way.actions}</div> : null}
        </section>
      ))}
    </div>
  );
}
