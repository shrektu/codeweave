import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { SHUTDOWN_DONE_MESSAGE_TYPE } from "../shared/constants";
import { fromMainPort } from "../shared/port";
import {
  ConnectMessageSchema,
  ShutdownMessageSchema,
  type ShutdownDoneMessage,
} from "../shared/protocol";

import { parseBackendArgs } from "./args";
import { locateClaudeAcpEntry } from "./claude/launch";
import type { ConnectionRegistry } from "./connections";
import { createProcessContainer } from "./process/select";
import { createParentPortVault } from "./secrets/vault";
import {
  createBackendRegistry,
  createExecutableResolver,
  startBackend,
} from "./startup";
import { inspectWorktree } from "./worktree";

let connections: ConnectionRegistry | null = null;

const ready = startBackend({
  args: parseBackendArgs(process.argv),
  vault: createParentPortVault(process.parentPort),
  broadcast: (event, payload) => {
    connections?.broadcast(event, payload);
  },
  createContainer: (instanceId) =>
    createProcessContainer(process.platform, undefined, instanceId),
  execPath: process.execPath,
  adapterEntry: locateClaudeAcpEntry(),
  parentEnv: process.env,
  homeDir: homedir(),
  platform: process.platform,
  now: () => Date.now(),
  schedule: (atMillis, run) => {
    const timer = setTimeout(run, Math.max(0, atMillis - Date.now()));
    return () => {
      clearTimeout(timer);
    };
  },
  newRunId: () => randomUUID(),
  resolveExecutable: createExecutableResolver(process.env, process.platform),
  inspectWorktree,
}).then((backend) => {
  connections = createBackendRegistry(backend);
  return { backend, registry: connections };
});

ready.catch((error: unknown) => {
  console.error("backend failed to start", error);
  process.exit(1);
});

async function handleShutdown(): Promise<void> {
  const { backend } = await ready;
  await backend.shutdown();
}

process.parentPort.on("message", (event) => {
  if (ShutdownMessageSchema.safeParse(event.data).success) {
    handleShutdown()
      .catch((error: unknown) => {
        console.error("backend shutdown failed", error);
      })
      .finally(() => {
        const done: ShutdownDoneMessage = { type: SHUTDOWN_DONE_MESSAGE_TYPE };
        process.parentPort.postMessage(done);
      });
    return;
  }
  const [port] = event.ports;
  if (
    port === undefined ||
    !ConnectMessageSchema.safeParse(event.data).success
  ) {
    return;
  }
  void ready.then(({ registry }) => {
    registry.connect(fromMainPort(port));
  });
});
