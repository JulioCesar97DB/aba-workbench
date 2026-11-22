/**
 * Vercel Functions reject request bodies above 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE)
 * before our code runs, so the size is checked before sending. The owner chose a plain
 * cap with a clear message (2026-11-21): no upload service, no text extraction.
 */
export const MAX_REQUEST_BODY_BYTES = 4_500_000;

/**
 * A message for the user when a request is too large to send, or null when it fits.
 * Pass exact=false when the reading stopped at the limit and the true size is unknown.
 */
export function requestTooLargeMessage(bodyBytes: number, exact = true): string | null {
  if (bodyBytes <= MAX_REQUEST_BODY_BYTES) return null;
  const size = exact ? `add up to ${(bodyBytes / 1_000_000).toFixed(1)} MB, more than` : "are larger than";
  return `The sources ${size} the 4.5 MB that can be sent in one request. Paste the text of the largest report instead of attaching its PDF.`;
}

/**
 * Reads a request body as text, counting bytes as they arrive and stopping past the
 * limit, so a body without Content-Length (chunked) cannot get around the cap.
 */
export async function readBodyWithLimit(
  request: Request,
  limit = MAX_REQUEST_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; bytesRead: number }> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > limit) {
      await reader.cancel();
      return { ok: false, bytesRead };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}
