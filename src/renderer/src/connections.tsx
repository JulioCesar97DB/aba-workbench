import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Connections } from "../../shared/api.ts";

/*
 * The AI connections' state, once for the whole app, so the sidebar and Settings always
 * agree. The main process sends every change (a sign-in, a refresh that failed, a key
 * removed); the interface only ever holds states and the account's display name.
 */

interface ConnectionsState {
  /** Null until the main process has answered. */
  connections: Connections | null;
  /** The state could not be read at all. */
  failed: boolean;
}

const ConnectionsContext = createContext<ConnectionsState>({ connections: null, failed: false });

export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionsState>({ connections: null, failed: false });
  useEffect(() => {
    let live = true;
    const unsubscribe = window.aba.onConnectionsChange((connections) => {
      if (live) setState({ connections, failed: false });
    });
    window.aba.getConnections().then(
      (connections) => {
        if (live) setState((current) => (current.connections ? current : { connections, failed: false }));
      },
      () => {
        if (live) setState((current) => (current.connections ? current : { connections: null, failed: true }));
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return <ConnectionsContext value={state}>{children}</ConnectionsContext>;
}

export function useConnections(): ConnectionsState {
  return useContext(ConnectionsContext);
}
