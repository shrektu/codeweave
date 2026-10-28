import { useEffect, useState } from "react";

import { errorMessage } from "./errorMessage";
import type { IpcClient } from "./ipc";

export type BackendStatus =
  | { state: "connecting" }
  | { state: "ready"; pid: number }
  | { state: "unavailable"; message: string };

export function useBackendStatus(client: IpcClient): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>({ state: "connecting" });

  useEffect(() => {
    let active = true;
    void client
      .request("ping", {})
      .then((result) => {
        if (active) {
          setStatus({ state: "ready", pid: result.backendPid });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus({ state: "unavailable", message: errorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  return status;
}
