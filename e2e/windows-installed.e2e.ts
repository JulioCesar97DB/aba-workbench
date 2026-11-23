import { _electron as electron } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describeAccess } from "../src/main/owner-only.ts";
import type { AbaApi } from "../src/shared/api.ts";
import { execFileSync } from "node:child_process";
import { connectionStubLog, expect, packagedExecutable, stubConnections, stubFolderDialog, test } from "./app.ts";

/*
 * The installed Windows app as she will first start it, run by the release workflow
 * (.github/workflows/release.yml) on a windows-2025 runner, after the installer has
 * installed the app and scripts/windows-installer-check.ps1 has:
 *   - moved Documents and Desktop into OneDrive (Known Folder Move, as OneDrive's folder
 *     backup does), and
 *   - put Spanish first in Windows' languages.
 *
 * Unlike every other test, this one uses the machine's real home folder and the app's real
 * data folder (%APPDATA%\ABA Workbench): that is what it checks. So it runs only when
 * ABA_INSTALLED_APP_CHECK=1 on a CI runner (a throwaway machine) with Windows, against the
 * installed app (ABA_PACKAGED_EXECUTABLE); everywhere else it is skipped. What it leaves
 * behind (a case, the credentials file) is what the uninstall check then proves is kept.
 * Only invented data; the Claude key is fake and every request to a provider is answered
 * inside the app.
 */

// window.aba inside the page is reached through globalThis: the e2e code has no DOM types.
/** Asked for by the release workflow; then the test must run, never be skipped. */
const requested = process.env.ABA_INSTALLED_APP_CHECK === "1";

const CASE_LABEL = "Invented installer check";
const FAKE_CLAUDE_KEY = "sk-ant-api03-installer-check-not-a-real-key";

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (folder: string, parent: string) => {
  const relative = path.relative(parent.toLowerCase(), folder.toLowerCase());
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// eslint-disable-next-line no-empty-pattern -- the test needs no fixture: it starts the installed app itself.
test("the installed app's first start: Spanish from Windows, cases in the home folder although Documents and Desktop are in OneDrive, owner-only credentials, sign-in on 127.0.0.1 only", async ({}, testInfo) => {
  test.skip(!requested, "only on a CI Windows runner, against the installed app (ABA_INSTALLED_APP_CHECK=1)");
  // Asked for: anything missing fails rather than skips, so the release can never pass without this check.
  expect(testInfo.project.name, "the packaged project").toBe("packaged");
  expect(process.platform, "Windows").toBe("win32");
  expect(process.env.CI, "a CI runner, never a computer someone uses").toBe("true");
  expect(process.env.ABA_PACKAGED_EXECUTABLE, "the installed app").toBeTruthy();
  const executable = packagedExecutable();
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const appData = process.env.APPDATA ?? "";

  // Installed per user, with no administrator rights, under %LOCALAPPDATA%\Programs.
  expect(inside(executable, path.join(localAppData, "Programs"))).toBe(true);
  // A first start: the app has never saved settings on this machine.
  expect(existsSync(path.join(appData, "ABA Workbench", "settings.json"))).toBe(false);

  // No --user-data-dir and no --home-folder: the app's own folders, as on her laptop.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({ executablePath: executable, args: [], env });
  try {
    const where = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      home: electronApp.getPath("home"),
      documents: electronApp.getPath("documents"),
      desktop: electronApp.getPath("desktop"),
      userData: electronApp.getPath("userData"),
      languages: electronApp.getPreferredSystemLanguages(),
      resources: process.resourcesPath,
    }));
    expect(where.packaged).toBe(true);
    expect(same(where.userData, path.join(appData, "ABA Workbench"))).toBe(true);
    // The installed app finds its writing rules and the fonts' license in its own resources folder.
    expect(existsSync(path.join(where.resources, "rules", "assessment.md"))).toBe(true);
    expect(existsSync(path.join(where.resources, "licenses", "IBM-Plex-OFL.txt"))).toBe(true);
    // The runner was set up as a OneDrive user's machine; the app sees it that way.
    expect(where.documents.toLowerCase()).toContain("onedrive");
    expect(where.desktop.toLowerCase()).toContain("onedrive");
    expect(same(where.home, homedir())).toBe(true);
    // And as a Spanish Windows.
    expect(where.languages[0]?.toLowerCase().startsWith("es")).toBe(true);

    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    expect((await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.getSettings())).language).toBe("es");

    // The default cases folder: ABA Workbench in the home folder, never in Documents or on the Desktop.
    const expected = path.join(homedir(), "ABA Workbench");
    const folder = await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.getCasesFolder());
    expect(folder.isDefault).toBe(true);
    expect(same(folder.displayPath, expected)).toBe(true);
    expect(inside(folder.displayPath, where.documents)).toBe(false);
    expect(inside(folder.displayPath, where.desktop)).toBe(false);

    // Her first case goes there.
    const created = await page.evaluate((label) => (globalThis as unknown as { aba: AbaApi }).aba.createCase({ label }), CASE_LABEL);
    expect(created.outcome).toBe("created");
    expect(existsSync(path.join(expected, CASE_LABEL, "aba-case.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(expected, CASE_LABEL, "aba-case.json"), "utf8")).label).toBe(CASE_LABEL);

    // A cases folder inside the install folder is refused.
    await stubFolderDialog(app, path.join(path.dirname(where.resources), "resources"));
    expect((await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.chooseCasesFolder())).outcome).toBe("inside-app");

    // The credentials file, in her real app data folder, is readable by her only.
    await stubConnections(app, { claudeKey: FAKE_CLAUDE_KEY, jwks: { keys: [] } });
    expect((await page.evaluate((key) => (globalThis as unknown as { aba: AbaApi }).aba.saveClaudeKey(key), FAKE_CLAUDE_KEY)).outcome).toBe("saved");
    const credentials = path.join(where.userData, "credentials.json");
    const access = await describeAccess(credentials);
    const entries = access.split(/\r?\n/).filter((line) => /:\([A-Z,()]+\)\s*$/.test(line.trim()) || /:\(F\)/.test(line));
    expect(entries, access).toHaveLength(1);
    expect(access).not.toMatch(/\(I\)/);

    // ChatGPT sign-in: its one-time listener is bound to 127.0.0.1 only, never to every
    // address, which is what keeps Windows' firewall from asking her anything. The browser
    // is faked (stubConnections): the address it would open is only recorded.
    const signIn = page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.signInToChatGpt());
    await expect.poll(async () => (await connectionStubLog(app)).opened.length).toBe(1);
    const redirect = new URL(new URL((await connectionStubLog(app)).opened[0]).searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("127.0.0.1");
    // Every TCP socket, IPv4 and IPv6; a listening one has no remote end (0.0.0.0:0 or [::]:0),
    // read that way because netstat's state word is translated on a Spanish Windows.
    const listening = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "netstat.exe"), ["-ano"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[0] === "TCP" && columns[1]?.endsWith(`:${redirect.port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(columns[2] ?? ""));
    expect(listening.map((columns) => columns[1])).toEqual([`127.0.0.1:${redirect.port}`]);
    await page.evaluate(() => (globalThis as unknown as { aba: AbaApi }).aba.cancelChatGptSignIn());
    expect((await signIn).outcome).not.toBe("signed-in");
  } finally {
    await app.close();
  }
});
