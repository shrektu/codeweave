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
import { LOGIN_SHELL_PATH_TIMEOUT_MS } from "./constants";
import type { ConnectionRegistry } from "./connections";
import { execText } from "./exec";
import {
  isDirectory,
  passwdShell,
  readLoginShellPath,
  resolveLaunchEnv,
} from "./launchEnv";
import { createConsoleLoginProbe } from "./opencode/consoleLogin";
import { createConsoleUsageProbe } from "./opencode/consoleUsage";
import { createVersionProbe } from "./opencode/version";
import { createProcessContainer } from "./process/select";
import { isRunnableFileSync } from "./terminal/shell";
import { createParentPortVault } from "./secrets/vault";
import {
  createBackendRegistry,
  createExecutableResolver,
  startBackend,
} from "./startup";
import { inspectWorktree } from "./worktree";

let connections: ConnectionRegistry | null = null;

const args = parseBackendArgs(process.argv);
const vault = createParentPortVault(process.parentPort);

const ready = resolveLaunchEnv({
  env: process.env,
  platform: process.platform,
  homeDir: homedir(),
  userShell: passwdShell(),
  readShellPath: (shell) =>
    readLoginShellPath(shell, {
      env: process.env,
      cwd: homedir(),
      timeoutMs: LOGIN_SHELL_PATH_TIMEOUT_MS,
    }),
  isDirectory,
  isExecutable: (path) => isRunnableFileSync(path, process.platform),
})
  .then((env) =>
    startBackend({
      args,
      vault,
      broadcast: (event, payload) => {
        connections?.broadcast(event, payload);
      },
      createContainer: (instanceId) =>
        createProcessContainer(process.platform, undefined, instanceId),
      execPath: process.execPath,
      adapterEntry: locateClaudeAcpEntry(),
      parentEnv: env,
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
      resolveExecutable: createExecutableResolver(env, process.platform),
      inspectWorktree,
      opencodeConsoleLogin: createConsoleLoginProbe({
        exec: execText,
        platform: process.platform,
        ...(env.ComSpec === undefined ? {} : { comSpec: env.ComSpec }),
      }),
      opencodeConsoleUsage: createConsoleUsageProbe({
        exec: execText,
        platform: process.platform,
        ...(env.ComSpec === undefined ? {} : { comSpec: env.ComSpec }),
      }),
      opencodeGeneration: createVersionProbe({
        exec: execText,
        platform: process.platform,
        ...(env.ComSpec === undefined ? {} : { comSpec: env.ComSpec }),
      }),
      postUpdaterConfig: (message) => {
        process.parentPort.postMessage(message);
      },
    }),
  )
  .then((backend) => {
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
