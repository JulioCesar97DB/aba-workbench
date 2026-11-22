/**
 * Renders the invented fixtures to PDF with headless Google Chrome:
 * - the score reports (fixtures/cases/<case>/reports/*.html), next to case.json;
 * - the PDF text extraction fixtures (fixtures/pdf-text/): layout-check.pdf from its HTML,
 *   and two PDFs with no text layer, made from a picture of scan-source.html the way a
 *   scanner makes one: scan.pdf (one page, a picture only) and mixed.pdf (a text page,
 *   then a picture page).
 * Run after editing one of them; name a group to render only it:
 *   node scripts/render-fixture-pdfs.mts [cases] [pdf-text]
 * The default Chrome location is macOS's; on Windows or Linux, set CHROME_PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const groups = process.argv.slice(2);
const wanted = (group: string) => groups.length === 0 || groups.includes(group);

function printToPdf(html: string, output: string): void {
  execFileSync(chrome, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${output}`, pathToFileURL(html).href], { stdio: "ignore" });
  console.log(`rendered ${path.relative(process.cwd(), output)}`);
}

if (wanted("cases")) {
  const casesDir = path.resolve("fixtures/cases");
  for (const caseId of readdirSync(casesDir)) {
    const reportsDir = path.join(casesDir, caseId, "reports");
    for (const file of readdirSync(reportsDir).filter((f) => f.endsWith(".html"))) {
      printToPdf(path.join(reportsDir, file), path.join(casesDir, caseId, file.replace(/\.html$/, ".pdf")));
    }
  }
}

if (wanted("pdf-text")) {
  const dir = path.resolve("fixtures/pdf-text");
  printToPdf(path.join(dir, "layout-check.html"), path.join(dir, "layout-check.pdf"));
  const work = mkdtempSync(path.join(tmpdir(), "aba-fixture-scan-"));
  try {
    const png = path.join(work, "scan.png");
    execFileSync(chrome, ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=816,1056", `--screenshot=${png}`, pathToFileURL(path.join(dir, "scan-source.html")).href], { stdio: "ignore" });
    const picture = `<img src="data:image/png;base64,${readFileSync(png).toString("base64")}" style="display:block;width:100%;height:100vh;object-fit:contain">`;
    const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0}body{margin:0}.break{break-before:page}</style></head><body>${body}</body></html>`;
    writeFileSync(path.join(work, "scan.html"), page(picture));
    printToPdf(path.join(work, "scan.html"), path.join(dir, "scan.pdf"));
    const text = "<p style=\"font:11pt Helvetica,Arial,sans-serif;margin:48px\">Invented cover letter. The scores of Bruno Desconocido Prueba are on the next page, which was scanned: it is a picture with no text.</p>";
    writeFileSync(path.join(work, "mixed.html"), page(`${text}<div class="break">${picture}</div>`));
    printToPdf(path.join(work, "mixed.html"), path.join(dir, "mixed.pdf"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
