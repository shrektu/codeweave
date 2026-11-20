import type { Lease, LeaseMode, LockKeyResolver, WorktreeLocks } from "./locks";
import type {
  Contained,
  ProcessContainer,
  SpawnSpec,
  StopResult,
} from "./process/container";

export interface AgentFailure {
  readonly runId: string;
  readonly key: string;
  readonly survivors: readonly number[];
}

export interface AgentProcess {
  readonly contained: Contained;
  stop(graceMs: number): Promise<StopResult>;
}

export interface AgentProcessesDeps {
  readonly container: ProcessContainer;
  readonly locks: WorktreeLocks;
  readonly resolveLockKey: LockKeyResolver;
  readonly leaseModeOf: (runId: string) => LeaseMode;
  readonly onFailure?: (failure: AgentFailure) => void;
}

export interface AgentProcesses {
  start(spec: SpawnSpec): Promise<AgentProcess>;
}

const CLEANUP_GRACE_MS = 0;

function settle(
  result: StopResult,
  lease: Lease,
  runId: string,
  onFailure: ((failure: AgentFailure) => void) | undefined,
): StopResult {
  if (result.ok) {
    lease.release();
  } else {
    onFailure?.({ runId, key: lease.key, survivors: result.survivors });
  }
  return result;
}

export function createAgentProcesses(deps: AgentProcessesDeps): AgentProcesses {
  return {
    async start(spec: SpawnSpec): Promise<AgentProcess> {
      const lease = deps.locks.acquire(
        await deps.resolveLockKey(spec.cwd),
        deps.leaseModeOf(spec.runId),
      );
      let contained: Contained;
      try {
        contained = await deps.container.spawn(spec);
      } catch (error) {
        lease.release();
        throw error;
      }
      let inFlight: Promise<StopResult> | null = null;
      const stop = (graceMs: number): Promise<StopResult> => {
        inFlight ??= contained
          .stop(graceMs)
          .then((result) => settle(result, lease, spec.runId, deps.onFailure))
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      };
      contained.onExit(() => {
        stop(CLEANUP_GRACE_MS).catch((error: unknown) => {
          console.error(`cleanup after exit failed: ${spec.runId}`, error);
        });
      });
      return { contained, stop };
    },
  };
}
