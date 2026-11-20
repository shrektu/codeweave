import type { FlowReportEntry } from "../../domain/orchestratorReport";
import type { SessionService } from "../session";

export interface WakeupQueueDeps {
  readonly session: Pick<
    SessionService,
    "isSettled" | "prompt" | "onViewChanged"
  >;
  readonly build: (entries: readonly FlowReportEntry[]) => string;
}

export interface WakeupQueue {
  enqueue(entry: FlowReportEntry): void;
  dispose(): void;
}

export function createWakeupQueue({
  session,
  build,
}: WakeupQueueDeps): WakeupQueue {
  const pending = new Map<string, FlowReportEntry>();
  let flushing = false;
  let disposed = false;

  const restore = (taken: ReadonlyMap<string, FlowReportEntry>): void => {
    for (const [runId, entry] of taken) {
      if (!disposed && !pending.has(runId)) {
        pending.set(runId, entry);
      }
    }
  };
  const flush = async (): Promise<void> => {
    if (disposed || flushing || pending.size === 0 || !session.isSettled()) {
      return;
    }
    flushing = true;
    const taken = new Map(pending);
    pending.clear();
    try {
      await session.prompt(build([...taken.values()]));
    } catch (error) {
      console.warn("failed to deliver a flow report", error);
      restore(taken);
    } finally {
      flushing = false;
    }
  };
  const unsubscribe = session.onViewChanged(() => {
    void flush();
  });

  return {
    enqueue: (entry) => {
      if (disposed) {
        return;
      }
      pending.set(entry.view.runId, entry);
      void flush();
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
      pending.clear();
    },
  };
}
