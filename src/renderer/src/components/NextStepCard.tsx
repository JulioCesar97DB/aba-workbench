import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button.tsx";
import { cn } from "./cn.ts";
import { Icon } from "./Icon.tsx";
import { ButtonLink } from "./Link.tsx";

/*
 * "Siguiente paso" (owner's proposal §3.3): a card in the rail naming where to go next,
 * one sentence on what happens there, and its button. The button is the primary one once
 * the current step has its minimum (a soft rule, never a gate: P5); before that it is
 * secondary, and she can still go on. A step's rail starts with it once it is primary.
 * Props in docs/interface.md, "Shared pieces".
 */
export function NextStepCard({
  name,
  nameLang,
  body,
  to,
  action,
  primary = false,
  disabledNote,
}: {
  /** The next step's (or section's) name. */
  name: string;
  /** Its language, when it is an English title in a Spanish screen ("en"). */
  nameLang?: string;
  /** One sentence on what happens there. */
  body: string;
  /** Where the button goes; none when there is nowhere to go (everything done). */
  to?: string;
  /** The button's words ("Abrir la sección"). */
  action?: string;
  /** True once the current step has its minimum: the button becomes the screen's primary. */
  primary?: boolean;
  /**
   * Before the step has its minimum, when moving on makes no sense yet (Documentos with no
   * document): the button shows disabled, with this sentence under it saying when it turns on.
   */
  disabledNote?: string;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const noteId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="next-step"
      data-primary={primary || undefined}
      className={cn("flex flex-col items-start gap-1.5 rounded-lg border bg-surface p-3.5", primary ? "border-accent" : "border-border")}
    >
      <h2 id={headingId} className="text-2xs font-semibold tracking-eyebrow text-fg-muted uppercase">
        {t("nextStep.heading")}
      </h2>
      <p lang={nameLang} className="text-base font-semibold">
        {name}
      </p>
      <p className="text-sm text-fg-muted">{body}</p>
      {action && disabledNote ? (
        <>
          <Button size="sm" className="mt-1" disabled focusableWhenDisabled aria-describedby={noteId}>
            {action}
            <Icon name="arrow" />
          </Button>
          <p id={noteId} className="text-xs text-fg-muted">
            {disabledNote}
          </p>
        </>
      ) : to && action ? (
        <ButtonLink to={to} variant={primary ? "primary" : "secondary"} size="sm" className="mt-1">
          {action}
          <Icon name="arrow" />
        </ButtonLink>
      ) : null}
    </section>
  );
}
