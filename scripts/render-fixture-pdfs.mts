/**
 * Renders the invented score reports (fixtures/cases/<case>/reports/*.html) to PDF
 * with headless Google Chrome, next to case.json. Run after editing a report:
 *   node scripts/render-fixture-pdfs.mts
 * Set CHROME_PATH if Chrome is not in the default macOS location.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const casesDir = path.resolve("fixtures/cases");

for (const caseId of readdirSync(casesDir)) {
  const reportsDir = path.join(casesDir, caseId, "reports");
  for (const file of readdirSync(reportsDir).filter((f) => f.endsWith(".html"))) {
    const output = path.join(casesDir, caseId, file.replace(/\.html$/, ".pdf"));
    execFileSync(chrome, [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${output}`,
      `file://${path.join(reportsDir, file)}`,
    ], { stdio: "ignore" });
    console.log(`rendered ${path.relative(process.cwd(), output)}`);
  }
}
