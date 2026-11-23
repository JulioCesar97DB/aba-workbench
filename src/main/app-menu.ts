import type { MenuItemConstructorOptions } from "electron";

/*
 * The application menu (owner's decision, 2026-11-22). A development build (pnpm dev, the
 * built app the window tests run) keeps Electron's default menu, with Reload, Force
 * Reload and Toggle Developer Tools. The packaged app has none of those, nor their
 * keyboard shortcuts: a reload or the developer tools are of no use to the clinician, and
 * Cmd+R / Ctrl+R is a browser habit. It keeps the macOS app menu, File (close, or quit),
 * the standard Edit menu on every system (undo, redo, cut, copy, paste, select all), View
 * with zoom and full screen only, and Window.
 */

/** The menu's template, or null to keep Electron's default menu (a development build). */
export function appMenuTemplate({ packaged, platform }: { packaged: boolean; platform: NodeJS.Platform }): MenuItemConstructorOptions[] | null {
  if (!packaged) return null;
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { role: "windowMenu" },
  ];
}

/** Roles the packaged menu must never hold, anywhere in it. */
export const DEVELOPMENT_ONLY_ROLES = ["reload", "forceReload", "toggleDevTools"] as const;
