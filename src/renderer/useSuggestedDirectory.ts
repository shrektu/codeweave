import { useEffect, useState } from "react";

import { errorMessage } from "./errorMessage";
import type { IpcClient } from "./ipc";

export interface SuggestedDirectory {
  configDir: string;
  setConfigDir: (configDir: string) => void;
  error: string | null;
  refresh: () => Promise<void>;
}

async function suggestDirectory(client: IpcClient): Promise<string> {
  const { configDir } = await client.request("accounts/suggest", {});
  return configDir;
}

export function useSuggestedDirectory(client: IpcClient): SuggestedDirectory {
  const [configDir, setConfigDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void suggestDirectory(client)
      .then((suggested) => {
        if (active) {
          setConfigDir(suggested);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(errorMessage(caught));
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  const refresh = async (): Promise<void> => {
    setConfigDir(await suggestDirectory(client));
  };

  return { configDir, setConfigDir, error, refresh };
}
