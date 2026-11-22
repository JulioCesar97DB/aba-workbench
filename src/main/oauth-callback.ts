import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Language } from "../shared/api.ts";
import { CALLBACK_PATH, sameSecret } from "./chatgpt-oauth.ts";

/*
 * The loopback callback of Sign in with ChatGPT: a one-time HTTP listener on 127.0.0.1,
 * started before the browser opens and closed as soon as one valid answer arrives (or the
 * attempt ends). It accepts exactly one request: a GET of /auth/callback, addressed to
 * 127.0.0.1 on its own port, that is a top-level navigation (not a script on another
 * page), carrying this attempt's state. Anything else is refused and the attempt keeps
 * waiting, so a stray or hostile request can neither complete nor end it. The code never
 * leaves the main process. Nothing here imports Electron.
 */

/** The port OpenAI's example uses; when another app holds it, one the system picks (owner's decision, 2026-11-22). */
export const PREFERRED_CALLBACK_PORT = 1455;

export type CallbackAnswer =
  /** OpenAI sent the user back with a code. `clientId`: the issued id, on a first registration. */
  | { kind: "code"; code: string; clientId: string | null; scope: string | null }
  /**
   * OpenAI sent the user back with an OAuth error (access_denied: access was not given).
   * `description` is OpenAI's own wording, for the main process's log only; `clientId` is
   * there when OpenAI had already issued one.
   */
  | { kind: "error"; error: string; description: string | null; clientId: string | null };

export interface CallbackListener {
  port: number;
  /** http://127.0.0.1:<port>/auth/callback: never "localhost" (OpenAI's rule). */
  redirectUri: string;
  /** False when the preferred port was taken and the system picked another. */
  onPreferredPort: boolean;
  /** Settles with the first valid answer. */
  answer: Promise<CallbackAnswer>;
  /** Stops listening; any later request finds nothing there. */
  close(): Promise<void>;
}

/** Why a request was refused, for tests; the browser only sees a short page. */
export type Refusal = "method" | "host" | "path" | "cross-origin" | "state" | "used";

const PAGES: Record<Language, Record<"done" | "declined" | "refused", { title: string; body: string }>> = {
  en: {
    done: { title: "You can close this tab", body: "ABA Workbench received your answer. Go back to the app to see the result." },
    declined: { title: "You can close this tab", body: "ABA Workbench was not given access. Go back to the app to choose what to do." },
    refused: { title: "Nothing to do here", body: "This address is not part of a sign-in ABA Workbench is waiting for." },
  },
  es: {
    done: { title: "Puedes cerrar esta pestaña", body: "ABA Workbench recibió tu respuesta. Vuelve a la app para ver el resultado." },
    declined: { title: "Puedes cerrar esta pestaña", body: "No se dio acceso a ABA Workbench. Vuelve a la app para elegir qué hacer." },
    refused: { title: "Aquí no hay nada que hacer", body: "Esta dirección no es parte de un inicio de sesión que ABA Workbench esté esperando." },
  },
};

function page(response: ServerResponse, status: number, language: Language, which: "done" | "declined" | "refused"): void {
  const { title, body } = PAGES[language][which];
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // No script, style, image or frame; not cached; the address (which held the code) is never sent on.
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(html);
}

/**
 * Checks one request against the attempt: the method, the Host header (which also stops
 * DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own name),
 * the exact path, that it is a top-level navigation and not a request from a script on
 * another site (a browser sends Origin and Sec-Fetch-Mode: cors for those), and the state.
 */
export function checkCallbackRequest(
  request: Pick<IncomingMessage, "method" | "url" | "headers">,
  expected: { port: number; state: string },
): { ok: true; url: URL } | { ok: false; refusal: Refusal } {
  if (request.method !== "GET") return { ok: false, refusal: "method" };
  if (request.headers.host !== `127.0.0.1:${expected.port}`) return { ok: false, refusal: "host" };
  let url: URL;
  try {
    url = new URL(request.url ?? "", `http://127.0.0.1:${expected.port}`);
  } catch {
    return { ok: false, refusal: "path" };
  }
  if (url.pathname !== CALLBACK_PATH) return { ok: false, refusal: "path" };
  const mode = request.headers["sec-fetch-mode"];
  const dest = request.headers["sec-fetch-dest"];
  if (request.headers.origin !== undefined || (mode !== undefined && mode !== "navigate") || (dest !== undefined && dest !== "document")) {
    return { ok: false, refusal: "cross-origin" };
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || !sameSecret(expected.state, states[0])) return { ok: false, refusal: "state" };
  return { ok: true, url };
}

/** The answer in a valid callback's address. */
export function readCallback(url: URL): CallbackAnswer {
  const error = url.searchParams.get("error");
  const clientId = url.searchParams.get("client_id");
  if (error !== null) {
    const description = url.searchParams.get("error_description");
    // Printable text only, and short: it goes to a log line.
    const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
    return { kind: "error", error: clean(error).slice(0, 100), description: description === null ? null : clean(description), clientId };
  }
  const code = url.searchParams.get("code");
  if (!code) return { kind: "error", error: "missing_code", description: null, clientId };
  return { kind: "code", code, clientId: url.searchParams.get("client_id"), scope: url.searchParams.get("scope") };
}

async function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const failed = () => resolve(false);
    server.once("error", failed);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", failed);
      resolve(true);
    });
  });
}

/**
 * Starts listening for this attempt's callback on 127.0.0.1: on `preferredPort`, or, when
 * that is taken, on a port the system picks. Null when neither can be had.
 */
export async function startCallbackListener(options: {
  state: string;
  language: () => Language;
  preferredPort?: number;
  /** Tests: told of each refused request. */
  onRefused?: (refusal: Refusal) => void;
}): Promise<CallbackListener | null> {
  let settled = false;
  let resolveAnswer!: (answer: CallbackAnswer) => void;
  const answer = new Promise<CallbackAnswer>((resolve) => (resolveAnswer = resolve));
  let port = 0;
  const server = createServer((request, response) => {
    if (settled) {
      options.onRefused?.("used");
      page(response, 410, options.language(), "refused");
      return;
    }
    const checked = checkCallbackRequest(request, { port, state: options.state });
    if (!checked.ok) {
      options.onRefused?.(checked.refusal);
      page(response, checked.refusal === "path" ? 404 : checked.refusal === "method" ? 405 : 400, options.language(), "refused");
      return;
    }
    settled = true;
    const result = readCallback(checked.url);
    page(response, 200, options.language(), result.kind === "code" ? "done" : "declined");
    resolveAnswer(result);
  });
  // A request that never finishes must not hold the attempt open.
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  const preferred = options.preferredPort ?? PREFERRED_CALLBACK_PORT;
  let onPreferredPort = await listen(server, preferred);
  if (!onPreferredPort && !(await listen(server, 0))) return null;
  port = (server.address() as AddressInfo).port;
  onPreferredPort = onPreferredPort || port === preferred;

  let closing: Promise<void> | null = null;
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    onPreferredPort,
    answer,
    close() {
      settled = true;
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
