import { useEffect, useState } from "react";
import type { AppInfo, GenerationUpdateEvent } from "../../shared/api.ts";

/*
 * A development check, not a product screen: it proves that the window, the preload
 * bridge, the main process and the rules folder work together. Product screens, styling
 * and languages come later.
 */

interface Run {
  id: string;
  status: string;
  text: string;
  rulesVersions: Record<string, string> | null;
  finished: boolean;
}

function applyEvent(run: Run, event: GenerationUpdateEvent): Run {
  switch (event.type) {
    case "meta":
      return { ...run, rulesVersions: event.rulesVersions };
    case "status":
      return { ...run, status: event.phase === "thinking" ? "Thinking" : "Writing" };
    case "text":
      return { ...run, text: run.text + event.delta };
    case "fallback":
      return { ...run, status: `Continued by ${event.to}` };
    case "refusal":
      // Provider contract: a refusal invalidates all text received so far.
      return { ...run, text: "", status: "Refused" };
    case "done":
      return { ...run, status: event.complete ? `Done (${event.usage.outputTokens} output tokens)` : `Incomplete: ${event.stopReason}` };
    case "error":
      return { ...run, status: `Error: ${event.message}` };
    case "finished":
      return { ...run, finished: true, status: event.cancelled ? "Cancelled" : run.status };
  }
}

export function DevCheck() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    window.aba.getAppInfo().then(setInfo, () => setInfo(null));
  }, []);

  useEffect(
    () =>
      window.aba.onGenerationUpdate((update) =>
        setRun((current) => (current && current.id === update.generationId ? applyEvent(current, update.event) : current)),
      ),
    [],
  );

  const running = run !== null && !run.finished;

  async function start() {
    const id = crypto.randomUUID();
    setRun({ id, status: "Starting", text: "", rulesVersions: null, finished: false });
    try {
      await window.aba.startMockGeneration(id);
    } catch {
      setRun((current) => (current?.id === id ? { ...current, status: "Could not start", finished: true } : current));
    }
  }

  return (
    <main>
      <h1>{info ? info.name : "Loading"}</h1>
      <p>
        Development check{info ? `, version ${info.version}` : ""}. This screen only shows that the desktop app works end to
        end. It runs the mock provider: no AI call, no key, no cost.
      </p>
      <p>
        <button type="button" onClick={start} disabled={running}>
          Run mock generation
        </button>{" "}
        <button type="button" onClick={() => run && window.aba.cancelGeneration(run.id)} disabled={!running}>
          Cancel
        </button>
      </p>
      {run && (
        <section aria-live="polite">
          <p>Status: {run.status}</p>
          <p>
            Rules:{" "}
            {run.rulesVersions
              ? Object.entries(run.rulesVersions)
                  .map(([id, version]) => `${id} ${version}`)
                  .join(", ")
              : "not loaded yet"}
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{run.text}</pre>
        </section>
      )}
    </main>
  );
}
