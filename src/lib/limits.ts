/**
 * Vercel Functions reject request bodies above 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE)
 * before our code runs, so the size is checked before sending. The owner chose a plain
 * cap with a clear message (2026-11-21): no upload service, no text extraction.
 */
export const MAX_REQUEST_BODY_BYTES = 4_500_000;

/** A message for the user when a request is too large to send, or null when it fits. */
export function requestTooLargeMessage(bodyBytes: number): string | null {
  if (bodyBytes <= MAX_REQUEST_BODY_BYTES) return null;
  const mb = (bodyBytes / 1_000_000).toFixed(1);
  return (
    `The sources add up to ${mb} MB, more than the 4.5 MB that can be sent in one request. ` +
    "Paste the text of the largest report instead of attaching its PDF."
  );
}
