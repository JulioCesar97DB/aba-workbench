/* Spans of text that never overlap, kept in order: overlap queries in logarithmic time, so de-identifying and restoring stay linear. */

/** Non-overlapping spans kept sorted by start. */
export class Spans<T extends { start: number; end: number }> {
  readonly items: T[] = [];
  /** Index of the first span that ends after `start`. */
  #first(start: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].end <= start) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  overlapping(start: number, end: number): T[] {
    const out: T[] = [];
    for (let i = this.#first(start); i < this.items.length && this.items[i].start < end; i++) out.push(this.items[i]);
    return out;
  }
  add(span: T): void {
    this.items.splice(this.#first(span.start), 0, span);
  }
}
