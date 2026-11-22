import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PromptParts, SourceDocument } from "./providers/types.ts";

/**
 * The writing rules live as versioned Markdown files in /rules, not in code.
 * Every generation reports the versions it used, so an output can be traced back
 * to the exact rules that produced it.
 *
 * Scripts and tests run from the repository root and use this default. The desktop app
 * passes its own folder (see src/main/paths.ts), because a packaged app's working
 * directory is not the repository.
 */
export const DEFAULT_RULES_DIR = path.join(process.cwd(), "rules");

/** Same for every section and every case: this is the cached system prefix. */
const SYSTEM_FILES = ["assessment.md", "payers/florida-medicaid-molina.md", "instruments.md"];

export const SECTIONS = {
  "medical-necessity": {
    file: "sections/medical-necessity.md",
    title: "Medical Necessity Criteria",
    templateNumber: 4,
  },
} as const;

export type SectionId = keyof typeof SECTIONS;

interface RulesFile {
  id: string;
  version: string;
  body: string;
}

function parseRulesFile(raw: string, fileName: string): RulesFile {
  // A Windows checkout or editor may turn line endings into CRLF; the format is the same.
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`Rules file ${fileName} has no front matter.`);
  const fields = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const [key, ...rest] = line.split(":");
      return [key.trim(), rest.join(":").trim()];
    }),
  );
  if (!fields.id || !fields.version) throw new Error(`Rules file ${fileName} needs id and version.`);
  return { id: fields.id, version: fields.version, body: match[2].trim() };
}

const cache = new Map<string, Promise<RulesFile>>();

function loadRulesFile(rulesDir: string, relativePath: string): Promise<RulesFile> {
  const fullPath = path.join(rulesDir, relativePath);
  let pending = cache.get(fullPath);
  if (!pending) {
    pending = readFile(fullPath, "utf8").then((raw) => parseRulesFile(raw, relativePath));
    // In development the files are re-read on every request so edits show up at once.
    if (process.env.NODE_ENV === "production") cache.set(fullPath, pending);
  }
  return pending;
}

export async function buildPrompt(
  sectionId: SectionId,
  sources: SourceDocument[],
  rulesDir: string = DEFAULT_RULES_DIR,
): Promise<{ prompt: PromptParts; rulesVersions: Record<string, string> }> {
  const section = SECTIONS[sectionId];
  const [systemFiles, sectionFile] = await Promise.all([
    Promise.all(SYSTEM_FILES.map((file) => loadRulesFile(rulesDir, file))),
    loadRulesFile(rulesDir, section.file),
  ]);

  const rulesVersions = Object.fromEntries([...systemFiles, sectionFile].map((f) => [f.id, f.version]));
  const system = systemFiles.map((f) => f.body).join("\n\n---\n\n");
  const task = [
    sectionFile.body,
    "---",
    `Write the "${section.title}" section (section ${section.templateNumber} of the ABA Matrix template) for the client described in the sources. Use only what the sources say. Return only the text of the section, ready to paste.`,
  ].join("\n\n");

  return { prompt: { system, sources, task }, rulesVersions };
}
