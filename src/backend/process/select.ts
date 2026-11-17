import { SYSTEMD_CALL_TIMEOUT_MS, SYSTEMD_RUN_BINARY } from "../constants";
import { execText, type ExecText } from "../exec";
import { newInstanceId } from "../instance";

import { ContainerUnavailableError, type ProcessContainer } from "./container";
import { loadJobApi, type JobApi } from "./jobApi";
import { createSystemdScopeContainer } from "./linux";
import { createEnvMarkerContainer, createProcProcessTable } from "./marker";
import { createPsProcessTable } from "./psTable";
import { createJobObjectContainer, enterAppJob } from "./windows";

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

async function createWindowsContainer(
  loadApi: () => Promise<JobApi>,
  instanceId: string,
): Promise<ProcessContainer> {
  let api: JobApi;
  try {
    api = await loadApi();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContainerUnavailableError(
      `Windows job objects are unavailable: ${reason}`,
      { cause: error },
    );
  }
  enterAppJob(api);
  return createJobObjectContainer({ api, instanceId });
}

export async function createProcessContainer(
  platform: NodeJS.Platform,
  probe: () => Promise<boolean> = probeSystemdUser,
  instanceId: string = newInstanceId(),
  loadApi: () => Promise<JobApi> = loadJobApi,
): Promise<ProcessContainer> {
  if (platform === "win32") {
    return createWindowsContainer(loadApi, instanceId);
  }
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
