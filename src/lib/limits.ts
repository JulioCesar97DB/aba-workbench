import type { PromptParts, ProviderId } from "./providers/types.ts";

/**
 * Each provider's documented limits for one generation request. The size is checked
 * before anything is sent; what cannot be checked beforehand (Claude's PDF pages) is
 * recognised in the provider's error and explained the same way. One entry per provider,
 * next to its source: update the entry, its source and checkedOn together when a
 * provider changes its limits.
 *
 * Sizes are counted in decimal megabytes (1 MB = 1,000,000 bytes): the providers' pages
 * say "MB" without saying which, and the decimal reading is the smaller one.
 */
export interface ProviderRequestLimit {
  /**
   * What the size limit counts: the whole request body, or the PDFs as they are sent
   * (base64, a third larger than the files).
   */
  counts: "request" | "encoded-files";
  maxBytes: number;
  /** The size limit in the provider's terms, as the user reads it. */
  label: string;
  /** PDF pages per request, when the provider documents a limit; checked by the provider. */
  maxPdfPages: number | null;
  source: string;
  checkedOn: string;
}

export const PROVIDER_REQUEST_LIMITS: Record<Exclude<ProviderId, "mock">, ProviderRequestLimit> = {
  // API overview, "Request size limits": "Messages, Token Counting: 128 MB", and "If you
  // exceed these limits, you'll receive a 413 request_too_large error." The PDF support
  // page repeats the 128 MB and adds: "Both limits are on the entire request payload,
  // including any other content sent alongside PDFs."
  // Pages, same table: "600 (100 when the request's context window is under 1M tokens)".
  // The models overview gives Claude Opus 5.5 and Claude Fable 5.2 a 1M-token context
  // window, so 600 applies to both. The page count is not checked before sending: it
  // needs a PDF parser (pages can sit inside compressed object streams), and the API
  // reports it; see pdfPageLimitMessage.
  anthropic: {
    counts: "request",
    maxBytes: 128_000_000,
    label: "Claude accepts requests of up to 128 MB",
    maxPdfPages: 600,
    source: "https://platform.claude.com/docs/en/build-with-claude/pdf-support",
    checkedOn: "2026-11-22",
  },
  // File inputs, "Usage considerations": "each file must be under 50 MB. The combined
  // limit across all files in the request is 50 MB." The page states no page limit and
  // no limit on the request as a whole, and does not say whether a file sent as base64
  // counts at its file size or at its encoded size; the stricter reading, the encoded
  // size, is used here.
  openai: {
    counts: "encoded-files",
    maxBytes: 50_000_000,
    label: "OpenAI accepts up to 50 MB of files in one request",
    maxPdfPages: null,
    source: "https://developers.openai.com/api/docs/guides/file-inputs",
    checkedOn: "2026-11-22",
  },
};

export interface RequestSize {
  /** The prompt as JSON: rules, sources (PDFs as base64) and section request. */
  requestBytes: number;
  /** The PDFs at their file size. */
  fileBytes: number;
  /** The PDFs as they are sent: their base64 text. */
  encodedFileBytes: number;
}

/**
 * The size of what a generation sends. requestBytes is the prompt serialized as JSON,
 * the bulk of any provider request; the provider's own fields add a few hundred bytes.
 */
export function measureRequest(prompt: PromptParts): RequestSize {
  let fileBytes = 0;
  let encodedFileBytes = 0;
  for (const source of prompt.sources) {
    if (source.kind !== "pdf") continue;
    const padding = source.base64.endsWith("==") ? 2 : source.base64.endsWith("=") ? 1 : 0;
    fileBytes += Math.floor((source.base64.length * 3) / 4) - padding;
    encodedFileBytes += source.base64.length;
  }
  return { requestBytes: new TextEncoder().encode(JSON.stringify(prompt)).byteLength, fileBytes, encodedFileBytes };
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const WHAT_TO_DO = "Remove a PDF, or paste the text of a report instead of attaching its PDF.";

/**
 * A message for the user when a request is over its provider's size limit, or null when
 * it fits (and always for the mock provider). It says how large the request is, what the
 * limit is, and what to do.
 */
export function requestTooLargeMessage(provider: ProviderId, size: RequestSize): string | null {
  if (provider === "mock") return null;
  const limit = PROVIDER_REQUEST_LIMITS[provider];
  if (limit.counts === "request") {
    if (size.requestBytes <= limit.maxBytes) return null;
    return `This request is ${megabytes(size.requestBytes)}; ${limit.label}. ${WHAT_TO_DO}`;
  }
  if (size.encodedFileBytes <= limit.maxBytes) return null;
  // Said in this order so the numbers do not seem to contradict the limit: the files may
  // be under 50 MB on disk and still over it once encoded for sending.
  return `The PDFs in this request are ${megabytes(size.fileBytes)}; sent to OpenAI they become ${megabytes(size.encodedFileBytes)}, over its ${limit.maxBytes / 1_000_000} MB limit for files in one request. ${WHAT_TO_DO}`;
}

/** For a provider's own "request too large" error (HTTP 413), when it comes anyway. */
export function providerTooLargeMessage(provider: Exclude<ProviderId, "mock">): string {
  return `The request was refused as too large; ${PROVIDER_REQUEST_LIMITS[provider].label}. ${WHAT_TO_DO}`;
}

/**
 * Whether a Claude refusal is about the PDF page limit. Anthropic documents the limit but
 * not the error's wording (and advises against matching messages), so this asks for the
 * shape of a limit: PDFs, pages, and a word such as "maximum" or "exceed". A refusal that
 * does not match keeps Claude's own message, unchanged.
 */
export function isPdfPageLimitError(providerMessage: string): boolean {
  return /\bpdf/i.test(providerMessage) && /\bpages?\b/i.test(providerMessage) && /\b(maximum|max|exceed(s|ed)?|limit|too many|at most|more than|up to)\b/i.test(providerMessage);
}

/** For Claude's error when the PDFs have more pages than it accepts in one request. */
export function pdfPageLimitMessage(providerMessage: string): string {
  const pages = PROVIDER_REQUEST_LIMITS.anthropic.maxPdfPages;
  return `The PDFs in this request have more pages than Claude accepts in one request (${pages} for the models this app uses). ${WHAT_TO_DO} Claude said: "${providerMessage.slice(0, 200)}"`;
}
