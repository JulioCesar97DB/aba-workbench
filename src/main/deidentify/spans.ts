/*
 * Spans of text that never overlap. Each position of the text records which span covers it,
 * so finding what overlaps a new span costs its own length, and adding one costs its length
 * too: no array is shifted, whatever the number of spans (linear in the text overall).
 */
export class Spans<T extends { start: number; end: number }> {
  readonly #all: T[] = [];
  #covered: Int32Array;

  /** `length`: the length of the text the spans are in. */
  constructor(length: number) {
    this.#covered = new Int32Array(Math.max(1, length)).fill(-1);
  }

  /** The spans that share a character with [start, end), in order. */
  overlapping(start: number, end: number): T[] {
    const out: T[] = [];
    let last = -1;
    for (let i = Math.max(0, start); i < end && i < this.#covered.length; i++) {
      const id = this.#covered[i];
      if (id !== -1 && id !== last) {
        out.push(this.#all[id]);
        last = id;
      }
    }
    return out;
  }

  add(span: T): void {
    const id = this.#all.length;
    this.#all.push(span);
    this.#covered.fill(id, Math.max(0, span.start), Math.min(this.#covered.length, span.end));
  }

  /** Every span, sorted by start. */
  get items(): T[] {
    return [...this.#all].sort((a, b) => a.start - b.start);
  }
}
