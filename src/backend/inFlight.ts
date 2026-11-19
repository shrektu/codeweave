export interface InFlight {
  readonly track: <T>(work: () => Promise<T>) => Promise<T>;
  readonly size: () => number;
  readonly settled: () => Promise<void>;
}

export function createInFlight(): InFlight {
  const pending = new Set<Promise<unknown>>();
  return {
    track: <T>(work: () => Promise<T>): Promise<T> => {
      const running = work();
      pending.add(running);
      return running.finally(() => {
        pending.delete(running);
      });
    },
    size: () => pending.size,
    settled: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
