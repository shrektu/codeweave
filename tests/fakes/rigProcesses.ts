import { realpath } from "node:fs/promises";

import {
  createAgentProcesses,
  type AgentProcesses,
} from "../../src/backend/agentProcesses";
import { WorktreeLocks } from "../../src/backend/locks";
import type { ProcessContainer } from "../../src/backend/process/container";

export function resolvePathLockKey(cwd: string): Promise<string> {
  return realpath(cwd);
}

export function rigProcesses(container: ProcessContainer): AgentProcesses {
  return createAgentProcesses({
    container,
    locks: new WorktreeLocks(),
    resolveLockKey: resolvePathLockKey,
  });
}
