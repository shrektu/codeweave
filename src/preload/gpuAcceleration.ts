export interface GpuAccelerationFeed {
  fetch(): Promise<unknown>;
  subscribe(handler: (payload: unknown) => void): void;
}

export interface GpuAccelerationState {
  current(): boolean;
  onChanged(listener: (accelerated: boolean) => void): () => void;
}

export function createGpuAccelerationState(
  feed: GpuAccelerationFeed,
): GpuAccelerationState {
  const listeners = new Set<(accelerated: boolean) => void>();
  let value = false;
  let pushed = false;
  const apply = (payload: unknown): void => {
    const next = payload === true;
    if (next === value) {
      return;
    }
    value = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  feed.subscribe((payload) => {
    pushed = true;
    apply(payload);
  });
  void feed
    .fetch()
    .then((payload) => {
      if (!pushed) {
        apply(payload);
      }
    })
    .catch((error: unknown) => {
      console.warn("Could not read the GPU acceleration state", error);
    });
  return {
    current: () => value,
    onChanged(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
