import { LeaseMode } from "./locks";

export interface LeaseModes {
  set(runId: string, mode: LeaseMode): void;
  modeOf(runId: string): LeaseMode;
  clear(runId: string): void;
}

export function createLeaseModes(): LeaseModes {
  const modes = new Map<string, LeaseMode>();
  return {
    set: (runId, mode) => {
      modes.set(runId, mode);
    },
    modeOf: (runId) => modes.get(runId) ?? LeaseMode.exclusive,
    clear: (runId) => {
      modes.delete(runId);
    },
  };
}
