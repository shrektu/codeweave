import { chooseTerminalRenderer, type TerminalRenderer } from "./options";

export type WebglAttach = (onLoss: () => void) => (() => void) | null;

export interface RendererSwitch {
  current(): TerminalRenderer;
  subscribe(listener: (renderer: TerminalRenderer) => void): () => void;
  setGpuAccelerated(accelerated: boolean): void;
  dispose(): void;
}

interface RendererListeners {
  subscribe(listener: (renderer: TerminalRenderer) => void): () => void;
  notify(renderer: TerminalRenderer): void;
  clear(): void;
}

function createListeners(): RendererListeners {
  const listeners = new Set<(renderer: TerminalRenderer) => void>();
  return {
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    notify(renderer): void {
      for (const listener of listeners) {
        listener(renderer);
      }
    },
    clear: () => {
      listeners.clear();
    },
  };
}

export function createRendererSwitch(
  attach: WebglAttach,
  gpuAccelerated: boolean,
): RendererSwitch {
  const listeners = createListeners();
  let accelerated = gpuAccelerated;
  let webglFailed = false;
  let detach: (() => void) | null = null;
  let renderer: TerminalRenderer = "dom";
  let disposed = false;

  const publish = (): void => {
    const next: TerminalRenderer = detach === null ? "dom" : "webgl";
    if (next !== renderer) {
      renderer = next;
      listeners.notify(next);
    }
  };

  const onLoss = (): void => {
    detach = null;
    webglFailed = true;
    publish();
  };

  const reconcile = (): void => {
    const wanted = chooseTerminalRenderer({
      gpuAccelerated: accelerated,
      webglFailed,
    });
    if (wanted === "webgl" && detach === null) {
      detach = attach(onLoss);
      webglFailed = detach === null;
    } else if (wanted === "dom" && detach !== null) {
      const release = detach;
      detach = null;
      release();
    }
    publish();
  };

  reconcile();

  return {
    current: () => renderer,
    subscribe: (listener) => listeners.subscribe(listener),
    setGpuAccelerated(next): void {
      if (!disposed) {
        accelerated = next;
        reconcile();
      }
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
    },
  };
}
