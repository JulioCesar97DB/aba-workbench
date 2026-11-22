/**
 * The only sender the main process answers: the top frame of its own window, showing the
 * app's own interface. Electron's security checklist, item 17 ("Validate the sender of
 * all IPC messages"). The origin is checked, not the URL, as Electron's docs advise.
 */
export function isTrustedFrame(frame: { origin: string; parent: unknown } | null, trustedOrigin: string): boolean {
  return frame !== null && frame.parent === null && frame.origin === trustedOrigin;
}
