import type { Effort, SourceDocument } from "./providers/types.ts";
import { isSectionId, type SectionId } from "./rules.ts";

/** The header that carries the user's own provider key. It is never stored or logged. */
export const KEY_HEADER = "x-provider-key";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface GenerateRequestBody {
  provider: string;
  model: string;
  section: SectionId;
  effort: Effort;
  maxOutputTokens: number;
  mode: "generate" | "prewarm";
  sources: SourceDocument[];
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isString = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function parseSource(raw: unknown, index: number): Result<SourceDocument> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: `sources[${index}] must be an object` };
  const s = raw as Record<string, unknown>;
  if (!isString(s.id, 80) || !/^[a-z0-9-]+$/.test(s.id)) return { ok: false, error: `sources[${index}].id must be a lowercase slug` };
  if (!isString(s.title)) return { ok: false, error: `sources[${index}].title is required` };
  if (s.kind === "text") {
    if (!isString(s.text, 400_000)) return { ok: false, error: `sources[${index}].text is required` };
    return { ok: true, value: { id: s.id, title: s.title, kind: "text", text: s.text } };
  }
  if (s.kind === "pdf") {
    if (!isString(s.filename) || !s.filename.toLowerCase().endsWith(".pdf")) {
      return { ok: false, error: `sources[${index}].filename must end in .pdf` };
    }
    if (!isString(s.base64, 30_000_000) || !/^[A-Za-z0-9+/]+=*$/.test(s.base64)) {
      return { ok: false, error: `sources[${index}].base64 must be base64 without line breaks` };
    }
    return { ok: true, value: { id: s.id, title: s.title, kind: "pdf", filename: s.filename, base64: s.base64 } };
  }
  return { ok: false, error: `sources[${index}].kind must be "text" or "pdf"` };
}

export function parseGenerateBody(raw: unknown): Result<GenerateRequestBody> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Body must be a JSON object." };
  const b = raw as Record<string, unknown>;
  if (!isString(b.provider, 40)) return { ok: false, error: "provider is required" };
  if (!isString(b.model, 120)) return { ok: false, error: "model is required" };
  if (!isSectionId(b.section)) return { ok: false, error: "section is not a known section id" };
  const effort = b.effort ?? "high";
  if (!EFFORTS.includes(effort as Effort)) return { ok: false, error: `effort must be one of ${EFFORTS.join(", ")}` };
  const maxOutputTokens = b.maxOutputTokens ?? 32_000;
  if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1_000 || maxOutputTokens > 128_000) {
    return { ok: false, error: "maxOutputTokens must be an integer between 1000 and 128000" };
  }
  const mode = b.mode ?? "generate";
  if (mode !== "generate" && mode !== "prewarm") return { ok: false, error: 'mode must be "generate" or "prewarm"' };
  if (!Array.isArray(b.sources) || b.sources.length === 0 || b.sources.length > 40) {
    return { ok: false, error: "sources must be a non-empty array (at most 40)" };
  }
  const sources: SourceDocument[] = [];
  for (const [index, rawSource] of b.sources.entries()) {
    const parsed = parseSource(rawSource, index);
    if (!parsed.ok) return parsed;
    sources.push(parsed.value);
  }
  return {
    ok: true,
    value: { provider: b.provider, model: b.model, section: b.section, effort: effort as Effort, maxOutputTokens, mode, sources },
  };
}
