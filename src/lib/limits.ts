/**
 * Vercel Functions rejected request bodies above 4.5 MB, so the hosted app checked the
 * size before sending. The owner chose a plain cap with a clear message (2026-11-21): no
 * upload service, no text extraction. The desktop app has no such platform limit; what
 * replaces it is open with the owner, so until then the cap stays here, in one place.
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
