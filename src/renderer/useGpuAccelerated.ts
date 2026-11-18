import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  return window.codeweave.onGpuAcceleratedChanged(onChange);
}

function snapshot(): boolean {
  return window.codeweave.isGpuAccelerated();
}

export function useGpuAccelerated(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
