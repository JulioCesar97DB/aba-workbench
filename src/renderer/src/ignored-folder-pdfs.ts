import { useCallback, useSyncExternalStore } from "react";
import { folderFileKey } from "./document-checklist.ts";

/*
 * The PDFs of a case's folder she chose to ignore on the Documentos step ("Ignorar"). Kept
 * in this window only, per case, while the app runs: nothing is stored (asked to the owner
 * on UX-4; storing the list would change the case's data file). A reload of the window or
 * the next start of the app shows them again. A file that changed since (another size or
 * date) shows again at once, since it may be another document.
 *
 * Behind one small interface (useIgnoredFolderPdfs), so keeping the list in the case's
 * data file later changes only this module.
 */

const ignored = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type FolderFile = { name: string; bytes: number; modifiedAt: string };

export function useIgnoredFolderPdfs(caseId: string) {
  useSyncExternalStore(subscribe, () => version);
  const isIgnored = useCallback((file: FolderFile) => Boolean(ignored.get(caseId)?.has(folderFileKey(file))), [caseId]);
  const ignore = useCallback(
    (file: FolderFile) => {
      const keys = ignored.get(caseId) ?? new Set<string>();
      keys.add(folderFileKey(file));
      ignored.set(caseId, keys);
      changed();
    },
    [caseId],
  );
  const showAll = useCallback(() => {
    ignored.delete(caseId);
    changed();
  }, [caseId]);
  return { isIgnored, ignore, showAll };
}
