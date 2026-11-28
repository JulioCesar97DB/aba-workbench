import { useEffect, useRef, useState } from "react";
import type { GenerationUpdateEvent } from "../../../shared/api.ts";
import { useAppInfo } from "../app-info.tsx";
import { Button } from "../components/Button.tsx";
import { PageHeader } from "../shell/PageHeader.tsx";
import { WorkArea } from "../shell/WorkArea.tsx";

/*
 * A development check, not a product screen: it proves that the window, the preload
 * bridge, the main process and the rules folder work together. Linked from the sidebar
 * in development builds only (pnpm dev, pnpm preview, the built window tests); the
 * packaged app has no link to it, and the window tests reach it at #/dev-check. It is
 * for developers, so it stays in English (lang="en") whatever the screen language.
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
    // Only a section's generation saves a version or checks it, and only a case map draft reports its parts; the development check does neither.
    case "saved":
    case "checked":
    case "map-progress":
    case "map-preview":
    case "map-saved":
    case "map-review":
    case "map-review-saved":
      return run;
  }
}

export function DevCheck() {
  const info = useAppInfo();
  const [run, setRun] = useState<Run | null>(null);
  const runningId = useRef<string | null>(null);

  useEffect(
    () =>
      window.aba.onGenerationUpdate((update) =>
        setRun((current) => (current && current.id === update.generationId ? applyEvent(current, update.event) : current)),
      ),
    [],
  );

  const running = run !== null && !run.finished;
  useEffect(() => {
    runningId.current = running ? run.id : null;
  });

  // Leaving the screen stops its generation: nobody could see or cancel it any more.
  useEffect(
    () => () => {
      if (runningId.current) void window.aba.cancelGeneration(runningId.current);
    },
    [],
  );

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
    <div lang="en" className="flex flex-1 flex-col">
      <WorkArea header={<PageHeader title="Development check" meta={info ? `${info.name} ${info.version}` : undefined} />}>
        <div className="flex max-w-measure flex-col gap-4">
          <p>
            Development check{info ? `, version ${info.version}` : ""}. This screen only shows that the desktop app works end to
            end. It runs the mock provider: no AI call, no key, no cost.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={start} disabled={running}>
              Run mock generation
            </Button>
            <Button onClick={() => run && window.aba.cancelGeneration(run.id)} disabled={!running}>
              Cancel
            </Button>
          </div>
          {run && (
            <section aria-live="polite" className="flex flex-col gap-2 text-sm">
              <p>Status: {run.status}</p>
              <p className="font-mono text-xs text-fg-muted">
                Rules:{" "}
                {run.rulesVersions
                  ? Object.entries(run.rulesVersions)
                      .map(([id, version]) => `${id} ${version}`)
                      .join(", ")
                  : "not loaded yet"}
              </p>
              <pre className="rounded-md border border-border bg-surface-muted p-3 font-mono text-xs whitespace-pre-wrap">{run.text}</pre>
            </section>
          )}
        </div>
      </WorkArea>
    </div>
  );
}
