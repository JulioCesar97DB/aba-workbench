import type { ElectronApplication } from "@playwright/test";

/*
 * pnpm eval --rehearse: the whole run, through the real app, with a fake provider inside
 * the app's main process (its fetch replaced, as the window tests do), so a rehearsal
 * proves the harness without one request leaving the computer. It answers as Claude
 * (the route that takes an API key) on a throwaway profile of its own: a draft is a
 * short invented text, a consistency check finds nothing, and the judge answers valid
 * JSON for the items and facts it is asked about, except its first answer of the run,
 * which leaves an item out so the repair request is exercised too; the case map's requests get a
 * valid, nearly empty map. Any other address is refused.
 */

/** A key only the fake provider accepts. */
export const REHEARSAL_CLAUDE_KEY = "sk-ant-api03-rehearsal-not-a-real-key";

export async function installRehearsalProvider(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, claudeKey) => {
    const g = globalThis as unknown as { fetch: typeof fetch; rehearsal?: { judged: number } };
    if (g.rehearsal) return;
    g.rehearsal = { judged: 0 };
    const state = g.rehearsal;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const between = (text: string, tag: string) => {
      const start = text.indexOf(`<${tag}>`);
      const end = text.indexOf(`</${tag}>`);
      return start >= 0 && end > start ? text.slice(start + tag.length + 2, end) : "";
    };
    const answerFor = (task: string): string => {
      if (task.includes("<section-under-review")) {
        const items = [...between(task, "rubric").matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]);
        const facts = [...between(task, "key-facts").matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]);
        const title = /<section-under-review title="([^"]+)"/.exec(task)?.[1] ?? "";
        const ids: Record<string, string> = {
          "Background Information": "background-information",
          "Medical Necessity Criteria": "medical-necessity",
          "Strengths and Weaknesses": "strengths-and-weaknesses",
          "Environmental Changes": "environmental-changes",
          "Family/Caregiver Involvement": "family-caregiver-involvement",
          "Generalization and Maintenance": "generalization-and-maintenance",
          "Discharge and Service Fading Plan": "discharge-and-service-fading-plan",
          "Risk Assessment": "risk-assessment",
          "Crisis Plan": "crisis-plan",
        };
        const id = ids[title] ?? title;
        const first = state.judged++ === 0 && !task.includes("<previous-answer>");
        const answer = {
          section: id,
          items: (first ? items.slice(1) : items).map((item, index) => ({ id: item, score: (index % 3) as 0 | 1 | 2, reason: "Rehearsal score.", evidence: [] })),
          keyFacts: facts.map((fact, index) => ({ id: fact, status: index % 2 === 0 ? "present" : "partial", quote: "" })),
        };
        return JSON.stringify(answer);
      }
      if (task.includes("Consistency check")) return "NO CONTRADICTIONS";
      // The case map's two requests (scripts/map-verify.mts --rehearse): a valid, nearly empty map.
      if (task.includes("Map request: case facts")) {
        return JSON.stringify({ client: null, caregivers: [], settings: [], deficits: [], strengths: [], facts: [], openItems: [{ kind: "missing", text: "Rehearsal: no real map was drafted.", homeSection: null }], report: [] });
      }
      if (task.includes("Map request: behaviors")) return JSON.stringify({ behaviors: [], groups: [], risks: [], openItems: [] });
      return [
        "This is a rehearsal draft written by the fake provider of pnpm eval --rehearse; no model wrote it.",
        "Her mother reported the concerns described in the parent interview [MISSING: rehearsal marker].",
      ].join("\n\n");
    };
    g.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : null;
      const headers = new Headers(init?.headers);
      const key = headers.get("x-api-key") ?? (headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (url.startsWith("https://api.anthropic.com/v1/models")) {
        return key === claudeKey
          ? json({ data: [{ type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null })
          : json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
      }
      if (url.startsWith("https://api.anthropic.com/v1/messages")) {
        const request = JSON.parse(body ?? "{}") as { model: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
        const task = request.messages.at(-1)?.content.at(-1)?.text ?? "";
        const text = answerFor(task);
        const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
        const events: Array<[string, unknown]> = [
          ["message_start", { type: "message_start", message: { id: "msg_rehearsal", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ...(text.match(/[^ ]+ */g) ?? []).map((piece): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }]),
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 50 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const [event, data] of events) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`The rehearsal refused a request to ${new URL(url).host}: a rehearsal never reaches a real provider.`);
    }) as typeof fetch;
  }, REHEARSAL_CLAUDE_KEY);
}
