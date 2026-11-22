import type { GenerateEvent, GenerateOptions, Provider } from "../src/lib/providers/types.ts";

export interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** A fetch that records each request and answers from `respond`. No network is touched. */
export function stubFetch(respond: (request: CapturedRequest) => Response) {
  const calls: CapturedRequest[] = [];
  const fetchStub = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body;
    const body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const captured = { url, headers: new Headers(init?.headers), body };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return { fetchStub, calls };
}

export function sseResponse(events: Array<[string, unknown]>): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

export const PDF_BASE64 = Buffer.from("%PDF-1.4 invented test file").toString("base64");

export function options(model: string): GenerateOptions {
  return {
    credential: { kind: "api-key", apiKey: "test-key-not-real" },
    model,
    effort: "high",
    maxOutputTokens: 32_000,
    signal: new AbortController().signal,
    prompt: {
      system: "RULES",
      task: "SECTION RULES AND REQUEST",
      sources: [
        { id: "cde", title: "CDE notes", kind: "text", text: "CDE text" },
        { id: "vineland-3", title: "Vineland-3 report", kind: "pdf", filename: "vineland-3.pdf", base64: PDF_BASE64 },
      ],
    },
  };
}

export async function collect(provider: Provider, opts: GenerateOptions): Promise<GenerateEvent[]> {
  const events: GenerateEvent[] = [];
  for await (const event of provider.generate(opts)) events.push(event);
  return events;
}
