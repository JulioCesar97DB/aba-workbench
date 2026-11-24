/*
 * The items of a JSON answer as they arrive (case map speed, 2026-11-23): the case map's
 * answer is one object whose properties are lists of items (and the client, one object).
 * Fed the text piece by piece, the scanner says each time an item of a top-level list, or
 * a top-level object, has closed, with its exact text, so it can be read and checked
 * while the rest is still being written. It only finds where items begin and end; reading
 * them is JSON.parse's job. Text before the first "{" (a code fence, a sentence) is skipped.
 */

export interface ClosedItem {
  /** The top-level property: "behaviors", "caregivers", "client", … */
  list: string;
  /** The item's place in its list; null for a top-level object. */
  index: number | null;
  /** The item's JSON text. */
  text: string;
}

interface Frame {
  kind: "object" | "array";
  /** The property this container is the value of (in an object), or null. */
  key: string | null;
  /** Where the container starts in the text. */
  start: number;
  /** An array's next element index. */
  next: number;
}

export class JsonItemScanner {
  #text = "";
  #at = 0;
  #started = false;
  #stack: Frame[] = [];
  #inString = false;
  #escaped = false;
  #stringStart = 0;
  /** In an object, the next string is a property name. */
  #expectKey = false;
  /** The last property name read in the innermost object. */
  #lastKey: string | null = null;

  /** Adds the next piece of the answer; returns the items that closed in it, in order. */
  feed(piece: string): ClosedItem[] {
    this.#text += piece;
    const closed: ClosedItem[] = [];
    const text = this.#text;
    for (; this.#at < text.length; this.#at++) {
      const ch = text[this.#at];
      if (!this.#started) {
        if (ch !== "{") continue;
        this.#started = true;
      }
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (ch === "\\") this.#escaped = true;
        else if (ch === '"') {
          this.#inString = false;
          if (this.#expectKey) {
            try {
              this.#lastKey = JSON.parse(text.slice(this.#stringStart, this.#at + 1)) as string;
            } catch {
              this.#lastKey = null;
            }
            this.#expectKey = false;
          }
        }
        continue;
      }
      const top = this.#stack.at(-1);
      switch (ch) {
        case '"':
          this.#inString = true;
          this.#stringStart = this.#at;
          if (top?.kind === "array") top.next++;
          break;
        case "{":
        case "[": {
          const key = top?.kind === "object" ? this.#lastKey : null;
          if (top?.kind === "array") top.next++;
          this.#stack.push({ kind: ch === "{" ? "object" : "array", key, start: this.#at, next: 0 });
          this.#expectKey = ch === "{";
          this.#lastKey = null;
          break;
        }
        case "}":
        case "]": {
          const frame = this.#stack.pop();
          if (!frame) break;
          const parent = this.#stack.at(-1);
          const end = this.#at + 1;
          // An item of a list that is a property of the answer: [answer, list, item].
          if (this.#stack.length === 2 && parent?.kind === "array" && parent.key !== null && frame.kind === "object") {
            closed.push({ list: parent.key, index: parent.next - 1, text: text.slice(frame.start, end) });
          }
          // An object that is a property of the answer (the client): [answer, object].
          if (this.#stack.length === 1 && frame.kind === "object" && frame.key !== null) {
            closed.push({ list: frame.key, index: null, text: text.slice(frame.start, end) });
          }
          this.#expectKey = false;
          this.#lastKey = parent?.kind === "object" ? frame.key : null;
          break;
        }
        case ",":
          if (top?.kind === "object") this.#expectKey = true;
          break;
        default: {
          // A value that is not a container: a string is handled above; a number, true,
          // false or null in an array still takes a place in it.
          if (top?.kind === "array" && /[-0-9tfn]/u.test(ch) && !/[-0-9.eE+a-z]/u.test(text[this.#at - 1] ?? "")) top.next++;
        }
      }
    }
    return closed;
  }
}
