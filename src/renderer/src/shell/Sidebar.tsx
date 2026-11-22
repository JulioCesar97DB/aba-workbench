import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { LANGUAGES } from "../../../shared/api.ts";
import { REPORT_SECTIONS } from "../../../shared/report-sections.ts";
import { useAppInfo } from "../app-info.tsx";
import { CASE_STEPS, casePath, StepLabel } from "../case-steps.tsx";
import { Button } from "../components/Button.tsx";
import { NavItem, SectionNavItem } from "../components/NavItem.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { useLanguage } from "../language.ts";
import { Eyebrow } from "./WorkArea.tsx";

/*
 * The dark sidebar. Outside a case it lists the app's screens; inside a case it shows the
 * case, its five steps and the report's sections, as in the reference. Its footer holds
 * the AI connection's state and the screen language.
 */

function Brand() {
  const { t } = useTranslation();
  return <Eyebrow as="p" className="text-xs text-fg-on-nav-muted">{t("app.name")}</Eyebrow>;
}

export function AppSidebar() {
  const { t } = useTranslation();
  const info = useAppInfo();
  return (
    <SidebarFrame
      top={
        <div className="px-2">
          <Brand />
        </div>
      }
    >
      <nav aria-label={t("nav.mainLabel")}>
        <ul className="flex flex-col gap-0.5">
          <li>
            <NavItem to="/" end>
              {t("nav.cases")}
            </NavItem>
          </li>
          <li>
            <NavItem to="/settings">{t("nav.settings")}</NavItem>
          </li>
          {info?.developmentBuild ? (
            <li>
              {/* Development builds only; the packaged app has no link to it. */}
              <NavItem to="/dev-check" detail="dev">
                {t("nav.devCheck")}
              </NavItem>
            </li>
          ) : null}
        </ul>
      </nav>
    </SidebarFrame>
  );
}

export function CaseSidebar({ caseId, caseName, caseDetail }: { caseId: string; caseName: string; caseDetail: string }) {
  const { t } = useTranslation();
  const sectionsHeadingId = useId();
  return (
    <SidebarFrame
      top={
        <div className="flex flex-col gap-0.5 px-2">
          <Brand />
          <p className="text-lg font-semibold">{caseName}</p>
          <p className="text-xs text-fg-on-nav-muted">{caseDetail}</p>
          <Link to="/" className="mt-1 self-start rounded-sm text-xs text-fg-on-nav underline underline-offset-2 hover:decoration-2">
            {t("nav.allCases")}
          </Link>
        </div>
      }
      footerExtra={
        <NavItem to="/settings">{t("nav.settings")}</NavItem>
      }
    >
      <nav aria-label={t("nav.stepsLabel")}>
        <ol className="flex flex-col gap-0.5">
          {CASE_STEPS.map((step, index) => (
            <li key={step}>
              <NavItem to={casePath(caseId, step)} number={index + 1}>
                <StepLabel t={t} step={step} />
              </NavItem>
            </li>
          ))}
        </ol>
      </nav>
      <nav aria-labelledby={sectionsHeadingId} className="flex flex-col gap-1">
        <Eyebrow id={sectionsHeadingId} className="px-2 text-fg-on-nav-muted">
          {t("nav.sectionsHeading")}
        </Eyebrow>
        <ul className="flex flex-col">
          {REPORT_SECTIONS.map((section) => (
            <li key={section.id}>
              <SectionNavItem to={casePath(caseId, "report", section.id)} title={section.title} state="empty" statusLabel={t("status.notStarted")} />
            </li>
          ))}
        </ul>
      </nav>
    </SidebarFrame>
  );
}

/** The case (or brand) on top, the lists in the middle, scrolling on their own when the window is short, and the footer always in view. */
function SidebarFrame({ top, children, footerExtra }: { top: ReactNode; children: ReactNode; footerExtra?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-[18px] py-[18px]">
      <div className="px-3.5">{top}</div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-3.5">{children}</div>
      <div className="px-3.5">
        <SidebarFooter extra={footerExtra} />
      </div>
    </div>
  );
}

function SidebarFooter({ extra }: { extra?: ReactNode }) {
  const { t } = useTranslation();
  const { language, changeLanguage } = useLanguage();
  return (
    <div className="flex flex-col gap-2">
      {extra}
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 text-xs text-fg-on-nav-muted">
        <span>{t("ai.notConnected")}</span>
        <div role="group" aria-label={t("nav.languageLabel")} className="flex gap-0.5">
          {LANGUAGES.map((option) => (
            <Tooltip key={option} content={t(`languages.${option}`)} lang={option}>
              <Button
                variant="nav"
                lang={option}
                aria-label={t(`languages.${option}`)}
                aria-pressed={language === option}
                onClick={() => {
                  if (language !== option) void changeLanguage(option).catch(() => undefined);
                }}
                className="min-w-control text-xs aria-pressed:bg-nav-current aria-pressed:font-semibold aria-pressed:text-fg-on-nav-current aria-pressed:hover:bg-nav-current"
              >
                {option.toUpperCase()}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}
