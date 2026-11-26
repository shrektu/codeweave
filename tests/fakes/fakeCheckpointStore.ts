import type { CheckpointStore } from "../../src/backend/checkpointStore";
import type { CheckpointEntry } from "../../src/backend/checkpointPlan";
import type {
  RestorePlanView,
  RestoreReportView,
} from "../../src/shared/views";

export function fakeCheckpointStore(
  overrides: Partial<CheckpointStore> = {},
): CheckpointStore {
  return {
    record: () => Promise.resolve(),
    entries: () => Promise.resolve<readonly CheckpointEntry[]>([]),
    plan: (sessionId, promptSeq) =>
      Promise.resolve<RestorePlanView>({ sessionId, promptSeq, files: [] }),
    restore: () =>
      Promise.resolve<RestoreReportView>({
        restored: [],
        deleted: [],
        skipped: [],
      }),
    fold: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    ...overrides,
  };
}
