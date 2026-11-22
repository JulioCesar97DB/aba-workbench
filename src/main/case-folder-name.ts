/*
 * A case's folder name, from the label the user typed (owner's decision, 2026-11-22):
 * readable in Finder and Explorer, and safe on macOS, Windows and Linux.
 *
 * 1. Unicode NFC.
 * 2. The characters Windows forbids in a name (< > : " / \\ | ? *) and control characters become "-".
 * 3. Each run of spaces becomes one space.
 * 4. Dots and spaces at the start (a hidden folder on macOS) and at the end (Windows drops them) go.
 * 5. At most 60 characters (UTF-16 units, cut between whole characters, so an accent or an emoji is never split).
 * 6. An empty result becomes "Case".
 * 7. A name Windows reserves for a device (CON, PRN, AUX, NUL, COM0-9, LPT0-9, also with
 *    superscript digits, any case, with or without an extension) gets " case" after it: "CON case".
 * 8. A name already taken in the cases folder, compared ignoring case and Unicode form (as
 *    macOS and Windows do), gets " 2", " 3" and so on.
 * The folder is then made with an exclusive create (src/main/cases.ts), so an existing
 * folder is never touched even if one appears between the check and the create.
 */

export const MAX_FOLDER_NAME_LENGTH = 60;
export const EMPTY_FOLDER_NAME = "Case";

const FORBIDDEN = /[<>:"/\\|?*\p{Cc}]/gu;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Cuts to at most `max` UTF-16 units without splitting a character (grapheme). */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

function tidyEnds(text: string): string {
  return text.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
}

/** Steps 1 to 7, leaving `room` characters for a suffix. */
function baseName(label: string, room = 0): string {
  let name = label.normalize("NFC").replace(FORBIDDEN, "-").replace(/\s+/gu, " ");
  name = tidyEnds(cut(tidyEnds(name), MAX_FOLDER_NAME_LENGTH - room));
  name = tidyEnds(name);
  if (name === "") name = EMPTY_FOLDER_NAME;
  // Windows reads "CON.txt" and "CON .txt" as the device CON too: the part before the first dot counts.
  const dot = name.indexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot)).trimEnd();
  if (RESERVED.test(stem)) {
    const rest = dot === -1 ? "" : name.slice(dot);
    name = `${stem} case${rest}`;
    if (name.length > MAX_FOLDER_NAME_LENGTH - room) name = `${stem} case`;
  }
  return name;
}

/** How two names compare on macOS's and Windows's usual file systems: case and Unicode form ignored. */
export function folderNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * The candidates for a case's folder, in order: the base name, then "name 2", "name 3"...
 * Names in `taken` are skipped. The caller creates the first that does not exist.
 */
export function* caseFolderNames(label: string, taken: Iterable<string> = []): Generator<string> {
  const used = new Set([...taken].map(folderNameKey));
  const first = baseName(label);
  if (!used.has(folderNameKey(first))) yield first;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${baseName(label, suffix.length)}${suffix}`;
    if (!used.has(folderNameKey(candidate))) yield candidate;
  }
}

/** The first candidate: the folder name a new case would get. */
export function caseFolderName(label: string, taken: Iterable<string> = []): string {
  return caseFolderNames(label, taken).next().value as string;
}
