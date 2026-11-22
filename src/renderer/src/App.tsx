import { CSPProvider } from "@base-ui/react/csp-provider";
import { createHashRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppInfoProvider } from "./app-info.tsx";
import { TooltipProvider } from "./components/Tooltip.tsx";
import { CaseIndex, CaseLayout, ReportScreen, ReportSectionScreen, StepScreen } from "./screens/Case.tsx";
import { DevCheck } from "./screens/DevCheck.tsx";
import { Home } from "./screens/Home.tsx";
import { NotFound } from "./screens/NotFound.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { AppSidebar } from "./shell/Sidebar.tsx";

/*
 * The screens and their addresses. The router keeps the address in the URL's hash
 * (#/settings): the app's pages never navigate (src/main/security.ts blocks it), a hash
 * change stays inside the page, and a reload comes back to the same screen.
 */
const router = createHashRouter([
  {
    element: <AppShell sidebar={<AppSidebar />} />,
    children: [
      { index: true, element: <Home /> },
      { path: "settings", element: <SettingsScreen /> },
      // Linked in development builds only (see DevCheck.tsx).
      { path: "dev-check", element: <DevCheck /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  {
    path: "cases/:caseId",
    element: <CaseLayout />,
    children: [
      { index: true, element: <CaseIndex /> },
      { path: "sources", element: <StepScreen step="sources" /> },
      { path: "behaviors", element: <StepScreen step="behaviors" /> },
      { path: "interventions", element: <StepScreen step="interventions" /> },
      { path: "report", element: <ReportScreen /> },
      { path: "report/:sectionId", element: <ReportSectionScreen /> },
      { path: "review", element: <StepScreen step="review" /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    // Base UI's own <style> tags would break the content security policy; none is needed.
    <CSPProvider disableStyleElements>
      <AppInfoProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </AppInfoProvider>
    </CSPProvider>
  );
}
