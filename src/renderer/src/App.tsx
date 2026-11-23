import { CSPProvider } from "@base-ui/react/csp-provider";
import { createHashRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppInfoProvider } from "./app-info.tsx";
import { ConnectionsProvider } from "./connections.tsx";
import { TooltipProvider } from "./components/Tooltip.tsx";
import { CaseIndex, CaseRoute, ReportScreen, StepScreen } from "./screens/Case.tsx";
import { SectionScreen } from "./screens/Section.tsx";
import { CaseMapScreen } from "./screens/CaseMap.tsx";
import { DevCheck } from "./screens/DevCheck.tsx";
import { Home } from "./screens/Home.tsx";
import { NotFound } from "./screens/NotFound.tsx";
import { SourcesScreen } from "./screens/Sources.tsx";
import { SourceTextScreen } from "./screens/SourceText.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { AppShell } from "./shell/AppShell.tsx";

/*
 * The screens and their addresses. The router keeps the address in the URL's hash
 * (#/settings): the app's pages never navigate (src/main/security.ts blocks it), a hash
 * change stays inside the page, and a reload comes back to the same screen. One shell
 * holds every screen, so moving into or out of a case keeps the announcements and the
 * focus handling of AppShell.
 */
const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      { path: "settings", element: <SettingsScreen /> },
      // Linked in development builds only (see DevCheck.tsx).
      { path: "dev-check", element: <DevCheck /> },
      {
        path: "cases/:caseId",
        element: <CaseRoute />,
        children: [
          { index: true, element: <CaseIndex /> },
          { path: "sources", element: <SourcesScreen /> },
          { path: "sources/text/:sourceId", element: <SourceTextScreen /> },
          { path: "sources/new/:type", element: <SourceTextScreen /> },
          { path: "case-map", element: <CaseMapScreen /> },
          { path: "interventions", element: <StepScreen step="interventions" /> },
          { path: "report", element: <ReportScreen /> },
          { path: "report/:sectionId", element: <SectionScreen /> },
          { path: "review", element: <StepScreen step="review" /> },
          { path: "*", element: <NotFound /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    // Base UI's own <style> tags would break the content security policy; none is needed.
    <CSPProvider disableStyleElements>
      <AppInfoProvider>
        <ConnectionsProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </ConnectionsProvider>
      </AppInfoProvider>
    </CSPProvider>
  );
}
