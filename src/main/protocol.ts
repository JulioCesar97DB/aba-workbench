import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { resolveRendererFile } from "./paths.ts";

/*
 * The built interface is served from app://aba-workbench/ instead of file://, as Electron's
 * security checklist advises (item 18): a page gets one fixed origin to check IPC senders
 * against, and only the files of the built interface can be reached through it.
 */
const SCHEME = "app";
const HOST = "aba-workbench";
export const APP_ORIGIN = `${SCHEME}://${HOST}`;

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** Answers app:// requests with files from `rendererDir`, and nothing outside it. */
export function serveRenderer(rendererDir: string): void {
  const notFound = () => new Response("Not found", { status: 404 });
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return notFound();
    const file = resolveRendererFile(rendererDir, url.pathname);
    if (!file) return notFound();
    try {
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return notFound();
    }
  });
}
