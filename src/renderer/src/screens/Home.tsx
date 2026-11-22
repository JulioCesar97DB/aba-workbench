import { useId } from "react";
import { useTranslation } from "react-i18next";
import { PREVIEW_CASE_ID, casePath } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { Dialog, DialogClose, DialogDescription } from "../components/Dialog.tsx";
import { ButtonLink, TextLink } from "../components/Link.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

/** The list of cases. There are none until cases can be created (the next task). */
export function Home() {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <WorkArea header={<PageHeader title={t("home.title")} actions={<NewCaseDialog />} />}>
      <section aria-labelledby={headingId} className="flex max-w-xl flex-col items-start gap-3 rounded-lg border border-border bg-surface-muted p-6">
        <h2 id={headingId} className="text-lg font-semibold">
          {t("home.emptyTitle")}
        </h2>
        <p className="text-md">{t("home.emptyBody")}</p>
        <p className="text-md text-fg-muted">{t("home.emptyNext")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ButtonLink to={casePath(PREVIEW_CASE_ID)}>{t("home.previewCase")}</ButtonLink>
          <TextLink to="/settings">{t("home.openSettings")}</TextLink>
        </div>
      </section>
    </WorkArea>
  );
}

function NewCaseDialog() {
  const { t } = useTranslation();
  return (
    <Dialog title={t("home.newCaseDialogTitle")} trigger={<Button variant="primary">{t("home.newCase")}</Button>}>
      <DialogDescription className="mt-2 text-md">{t("home.newCaseDialogBody")}</DialogDescription>
      <div className="mt-5 flex justify-end">
        <DialogClose render={<Button variant="primary" />}>{t("home.newCaseDialogClose")}</DialogClose>
      </div>
    </Dialog>
  );
}
