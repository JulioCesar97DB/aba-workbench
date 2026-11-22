import { toSafeError } from "./providers";

/**
 * A text/event-stream response. Each event is "event: <name>" plus one JSON line.
 * A comment line goes out every 15 seconds so that proxies and HTTP/1.1 clients
 * keep the connection open while the model is thinking and no text flows yet.
 */
export function eventStream(
  requestSignal: AbortSignal,
  run: (send: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([requestSignal, cancelled.signal]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (open) controller.enqueue(encoder.encode(chunk));
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);

      try {
        await run(send, signal);
      } catch (error) {
        if (!signal.aborted) {
          const safe = toSafeError(error);
          send("error", { code: safe.code, message: safe.message, status: safe.status });
        }
      } finally {
        clearInterval(heartbeat);
        open = false;
        try {
          controller.close();
        } catch {
          // already closed because the client went away
        }
      }
    },
    cancel() {
      // The client disconnected: stop the provider call so it stops costing money.
      cancelled.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}
