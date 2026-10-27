import { useEffect, useState } from "react";

import { request } from "./ipc";

export type BackendStatus =
  | { state: "connecting" }
  | { state: "ready"; pid: number }
  | { state: "unavailable"; message: string };

export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>({ state: "connecting" });

  useEffect(() => {
    let active = true;
    void request("ping", {})
      .then((result) => {
        if (active) {
          setStatus({ state: "ready", pid: result.backendPid });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          const message =
            error instanceof Error ? error.message : String(error);
          setStatus({ state: "unavailable", message });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return status;
}
