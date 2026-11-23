import { useTranslation } from "react-i18next";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";

/**
 * The plain warning that the app is not ready for real client data (de-identification is
 * not plugged in yet), as one slim line above every screen instead of a box on each
 * section (owner's decision T12). "What this means" opens the explanation.
 */
export function TrialBar() {
  const { t } = useTranslation();
  return (
    // A landmark of its own, so moving by landmarks reaches it too (review M10).
    <aside
      aria-label={t("trial.region")}
      data-testid="not-ready-notice"
      data-region="trial-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-warning-subtle px-5 py-1 text-xs text-warning"
    >
      <p>
        <span className="font-semibold">{t("trial.label")}</span> {t("trial.bar")}
      </p>
      <Dialog
        title={t("trial.title")}
        trigger={
          <button type="button" className="rounded-sm text-warning underline underline-offset-2 hover:decoration-2">
            {t("trial.more")}
          </button>
        }
      >
        <DialogDescription className="mt-2 text-md">{t("trial.body")}</DialogDescription>
        <div className="mt-5 flex justify-end">
          <DialogClose render={<Button variant="primary" />}>{t("trial.close")}</DialogClose>
        </div>
      </Dialog>
    </aside>
  );
}
