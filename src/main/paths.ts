import path from "node:path";

export interface AppLocation {
  isPackaged: boolean;
  /** process.resourcesPath: Contents/Resources on macOS, resources next to the .exe on Windows. */
  resourcesPath: string;
  /** app.getAppPath(): in development, the folder that holds package.json. */
  appPath: string;
}

/**
 * Where the writing rules are. Packaged, electron-builder copies /rules into the app's
 * resources folder (electron-builder.yml, extraResources); in development and in an
 * unpackaged preview they are the repository's /rules, next to package.json.
 * `p` is only there so tests can check Windows paths on any machine.
 */
export function resolveRulesDir(location: AppLocation, p: path.PlatformPath = path): string {
  return location.isPackaged ? p.join(location.resourcesPath, "rules") : p.join(location.appPath, "rules");
}

/**
 * The folder the default cases folder goes in: the user's home folder, outside Documents,
 * which iCloud and OneDrive often sync (owner's decision, 2026-11-22). In development only,
 * --home-folder=<absolute path> stands in for it, so the window tests never touch the real
 * home folder; a packaged app ignores the option (owner's decision, 2026-11-22).
 */
export function resolveHomeFolder(options: { isPackaged: boolean; override: string; home: string }, p: path.PlatformPath = path): string {
  if (!options.isPackaged && options.override !== "" && p.isAbsolute(options.override)) return options.override;
  return options.home;
}

/**
 * Maps the path of an app:// URL to a file inside `root` (the built interface), or null
 * when the path is malformed or would leave `root`. "/" means index.html.
 */
export function resolveRendererFile(root: string, urlPathname: string, p: path.PlatformPath = path): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded.replace(/^[/\\]+/, "") || "index.html";
  const full = p.resolve(root, relativePath);
  const fromRoot = p.relative(root, full);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${p.sep}`) || p.isAbsolute(fromRoot)) return null;
  return full;
}
