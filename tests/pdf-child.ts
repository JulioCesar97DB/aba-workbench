/*
 * Starts the PDF reading process for the unit tests: child.ts (or a stand-in) as a Node.js
 * child process with the same messages as the Electron utility process the app uses.
 */
import { fork } from "node:child_process";
import path from "node:path";
import type { ChildHandle, SpawnChild } from "../src/main/pdf-text/isolated.ts";

export const CHILD = path.join(import.meta.dirname, "..", "src", "main", "pdf-text", "child.ts");
export const STAND_IN = path.join(import.meta.dirname, "pdf-child-stand-in.ts");

/** Every process a test started, to check they are all gone. */
export const started: Array<{ pid?: number; exited: () => boolean }> = [];

export function spawnNodeChild(script = CHILD, args: string[] = [], heapMb = 256): SpawnChild {
  return (): ChildHandle => {
    const child = fork(script, args, { execArgv: [`--max-old-space-size=${heapMb}`], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let exited = false;
    child.on("exit", () => (exited = true));
    started.push({ pid: child.pid, exited: () => exited });
    return {
      postMessage: (message) => child.send(message as never),
      onMessage: (listener) => child.on("message", listener),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
      kill: () => void child.kill("SIGKILL"),
    };
  };
}
