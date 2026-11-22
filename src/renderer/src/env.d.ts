import type { AbaApi } from "../../shared/api.ts";

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts: the interface's only way into the main process. */
    aba: AbaApi;
  }
}
