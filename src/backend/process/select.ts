import { SYSTEMD_CALL_TIMEOUT_MS, SYSTEMD_RUN_BINARY } from "../constants";
import { execText, type ExecText } from "../exec";
import { newInstanceId } from "../instance";

import { ContainerUnavailableError, type ProcessContainer } from "./container";
import { createSystemdScopeContainer } from "./linux";
import { createEnvMarkerContainer, createProcProcessTable } from "./marker";
import { createPsProcessTable } from "./psTable";

const SYSTEMD_PROBE_ARGS = [
  "--user",
  "--scope",
  "--quiet",
  "--",
  "true",
] as const;

export async function probeSystemdUser(
  exec: ExecText = execText,
): Promise<boolean> {
  try {
    await exec(SYSTEMD_RUN_BINARY, SYSTEMD_PROBE_ARGS, {
      timeoutMs: SYSTEMD_CALL_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    console.warn("systemd user scopes unavailable", error);
    return false;
  }
}

export async function createProcessContainer(
  platform: NodeJS.Platform,
  probe: () => Promise<boolean> = probeSystemdUser,
  instanceId: string = newInstanceId(),
): Promise<ProcessContainer> {
  if (platform === "darwin") {
    return createEnvMarkerContainer({
      processTable: createPsProcessTable(),
      kill: (pid, signal) => process.kill(pid, signal),
      instanceId,
    });
  }
  if (platform !== "linux") {
    throw new ContainerUnavailableError(
      `No process container for platform ${platform}`,
    );
  }
  if (await probe()) {
    return createSystemdScopeContainer({ instanceId });
  }
  return createEnvMarkerContainer({
    processTable: createProcProcessTable(),
    kill: (pid, signal) => process.kill(pid, signal),
    instanceId,
  });
}
