import { app, session } from "electron";

/*
 * App-wide hardening from Electron's security checklist
 * (https://www.electronjs.org/docs/latest/tutorial/security). The window's own settings
 * (context isolation, sandbox, no Node integration) are in index.ts; the content security
 * policy is in src/renderer/index.html.
 */

/** Must run before the app is ready. */
export function hardenWebContents(): void {
  // Every renderer runs in Chromium's sandbox, whatever a window's settings say.
  app.enableSandbox();
  app.on("web-contents-created", (_event, contents) => {
    // The interface never navigates: it is one page that changes itself (items 13 and 14).
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    // No <webview> tags (item 12).
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** Denies every permission (camera, microphone, notifications, devices...); the interface needs none (item 5). */
export function denyAllPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}
