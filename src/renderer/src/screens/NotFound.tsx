import { useTranslation } from "react-i18next";
import { TextLink } from "../components/Link.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

export function NotFound() {
  const { t } = useTranslation();
  return (
    <WorkArea header={<PageHeader title={t("notFound.title")} />}>
      <div className="flex max-w-measure flex-col items-start gap-3">
        <p className="text-md">{t("notFound.body")}</p>
        <TextLink to="/">{t("notFound.backToCases")}</TextLink>
      </div>
    </WorkArea>
  );
}
