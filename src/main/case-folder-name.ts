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
function baseName(label: string, room = 0, max = MAX_FOLDER_NAME_LENGTH, empty = EMPTY_FOLDER_NAME): string {
  let name = label.normalize("NFC").replace(FORBIDDEN, "-").replace(/\s+/gu, " ");
  name = tidyEnds(cut(tidyEnds(name), max - room));
  name = tidyEnds(name);
  if (name === "") name = empty;
  // Windows reads "CON.txt" and "CON .txt" as the device CON too: the part before the first dot counts.
  const dot = name.indexOf(".");
  const stem = (dot === -1 ? name : name.slice(0, dot)).trimEnd();
  if (RESERVED.test(stem)) {
    const rest = dot === -1 ? "" : name.slice(dot);
    name = `${stem} case${rest}`;
    if (name.length > max - room) name = `${stem} case`;
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

/*
 * A PDF's name in a case's folder, when it is copied in (src/main/case-pdfs.ts): the
 * original name's part before ".pdf" made safe by the same steps as a folder name (at
 * most MAX_PDF_STEM_LENGTH characters, "Document" when nothing is left), then ".pdf". A
 * name already in the folder, compared the same way, gets " 2", " 3" and so on before
 * ".pdf". The file is then made with an exclusive create, so nothing is ever overwritten.
 */
export const MAX_PDF_STEM_LENGTH = 100;
export const EMPTY_PDF_STEM = "Document";

export function* pdfFileNames(original: string, taken: Iterable<string> = []): Generator<string> {
  const used = new Set([...taken].map(folderNameKey));
  const stem = original.normalize("NFC").replace(/\.pdf$/i, "");
  const first = `${baseName(stem, 0, MAX_PDF_STEM_LENGTH, EMPTY_PDF_STEM)}.pdf`;
  if (!used.has(folderNameKey(first))) yield first;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${baseName(stem, suffix.length, MAX_PDF_STEM_LENGTH, EMPTY_PDF_STEM)}${suffix}.pdf`;
    if (!used.has(folderNameKey(candidate))) yield candidate;
  }
}
