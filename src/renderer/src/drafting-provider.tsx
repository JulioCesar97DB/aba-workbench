import { useEffect, useState } from "react";
import type { DraftingProvider } from "../../shared/api.ts";
import { useConnections } from "./connections.tsx";

/*
 * Which AI a request goes to: the one she chose on this screen, else the one she drafted
 * with last, else the first connected. Shared by the section screen and the case map.
 */

export const PROVIDER_NAMES: Record<DraftingProvider, string> = { anthropic: "Claude", openai: "ChatGPT" };

export function useProviders(): { available: DraftingProvider[]; provider: DraftingProvider | null; choose: (provider: DraftingProvider) => void } {
  const { connections } = useConnections();
  const [chosen, setChosen] = useState<DraftingProvider | null>(null);
  const [last, setLast] = useState<DraftingProvider | null>(null);
  useEffect(() => {
    let live = true;
    window.aba.getAiPreferences().then(
      (preferences) => {
        if (live) setLast(preferences.lastProvider);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const available: DraftingProvider[] = [];
  if (connections && !connections.problem) {
    if (connections.claude.state === "connected") available.push("anthropic");
    if (connections.chatgpt.state === "connected") available.push("openai");
  }
  const pick = [chosen, last].find((candidate): candidate is DraftingProvider => candidate !== null && available.includes(candidate));
  return { available, provider: pick ?? available[0] ?? null, choose: setChosen };
}
