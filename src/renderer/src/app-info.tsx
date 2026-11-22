import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppInfo } from "../../shared/api.ts";

const AppInfoContext = createContext<AppInfo | null>(null);

/** Asks the main process once for the app's name, version and kind of build. */
export function AppInfoProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    window.aba.getAppInfo().then(setInfo, () => setInfo(null));
  }, []);
  return <AppInfoContext value={info}>{children}</AppInfoContext>;
}

/** Null until the main process has answered. */
export function useAppInfo(): AppInfo | null {
  return useContext(AppInfoContext);
}
