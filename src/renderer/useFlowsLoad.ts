import { useEffect, useState } from "react";

import type { FlowsList } from "../shared/views";

import { errorMessage } from "./errorMessage";
import { cwdParams } from "./flowDraft";
import { useApp } from "./services";

export type FlowsLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; list: FlowsList };

export interface FlowsSource {
  load: FlowsLoad;
  reloading: boolean;
  replace: (list: FlowsList) => void;
  reload: () => void;
}

interface LoadedFlows {
  cwd: string | null;
  load: FlowsLoad;
  reloadCount: number;
}

export function useFlowsLoad(cwd: string | null): FlowsSource {
  const { client, state } = useApp();
  const library = state.snapshot?.settings.definitionLibrary ?? null;
  const [loaded, setLoaded] = useState<LoadedFlows | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let active = true;
    const run = async (): Promise<void> => {
      let load: FlowsLoad;
      try {
        load = {
          status: "ready",
          list: await client.request("flows/list", cwdParams(cwd)),
        };
      } catch (error: unknown) {
        load = { status: "failed", message: errorMessage(error) };
      }
      if (active) {
        setLoaded({ cwd, load, reloadCount });
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [client, cwd, reloadCount, library]);

  return {
    load: loaded?.cwd === cwd ? loaded.load : { status: "loading" },
    reloading: loaded?.reloadCount !== reloadCount,
    replace: (list) => {
      setLoaded({ cwd, load: { status: "ready", list }, reloadCount });
    },
    reload: () => {
      setReloadCount((count) => count + 1);
    },
  };
}
