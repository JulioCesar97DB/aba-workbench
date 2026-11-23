import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "../components/StatusBadge.tsx";

/** An honest placeholder: says the screen is not built yet and what it will hold. */
export function Placeholder({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-measure flex-col items-start gap-3">
      <StatusBadge tone="accent">{t("workspace.placeholderBadge")}</StatusBadge>
      <p className="text-md">{children}</p>
    </div>
  );
}
