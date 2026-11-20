import { PermissionProfile, type Account } from "../../domain/types";
import type { AgentStartSpec } from "../agentAdapter";
import type { Contained, ProcessContainer } from "../process/container";

import { CodexMethod } from "./constants";
import { replaceRateLimits, type RateLimitState } from "./events";
import { openCodexAccount, withTimeout } from "./handshake";
import { buildCodexLaunch } from "./launch";
import { RateLimitsReadResponseSchema } from "./protocol";
import { CodexRpcError, createCodexRpc, type CodexRpc } from "./rpc";

export type ProbeResult =
  | { readonly kind: "limits"; readonly limits: RateLimitState }
  | { readonly kind: "needs_login" }
  | { readonly kind: "no_limits" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "failed" }
  | { readonly kind: "unstopped" };

export interface CodexProbeDeps {
  readonly container: ProcessContainer;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly executable: () => Promise<string>;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string | undefined;
  readonly timeoutMs: number;
  readonly stopGraceMs: number;
  readonly newRunId: () => string;
}

export type CodexLimitProbe = (
  account: Account,
  signal: AbortSignal,
) => Promise<ProbeResult>;

const RPC_CODE_INVALID_REQUEST = -32600;
const RPC_CODE_INTERNAL_ERROR = -32603;

const FAILED: ProbeResult = { kind: "failed" };
const UNREADABLE: ProbeResult = { kind: "unreadable" };
const NEEDS_LOGIN: ProbeResult = { kind: "needs_login" };
const NO_LIMITS: ProbeResult = { kind: "no_limits" };
const UNSTOPPED: ProbeResult = { kind: "unstopped" };

class ProbeAbortedError extends Error {
  constructor() {
    super("Limit probe aborted");
    this.name = "ProbeAbortedError";
  }
}

interface AbortWatch {
  readonly promise: Promise<never>;
  readonly release: () => void;
}

export function watchAbort(signal: AbortSignal): AbortWatch {
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => {
    aborted.reject(new ProbeAbortedError());
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    promise: aborted.promise,
    release: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function rpcCodeOf(error: unknown): number | null {
  return error instanceof CodexRpcError ? error.code : null;
}

async function readLimits(rpc: CodexRpc): Promise<ProbeResult> {
  const { needsLogin } = await openCodexAccount(rpc);
  if (needsLogin) {
    return NEEDS_LOGIN;
  }
  try {
    const response = await rpc.request(
      CodexMethod.rateLimitsRead,
      undefined,
      RateLimitsReadResponseSchema,
    );
    return {
      kind: "limits",
      limits: replaceRateLimits(
        response.rateLimits,
        response.ordinaryUsageAllowed,
        response.rateLimitsByLimitId,
      ),
    };
  } catch (error) {
    switch (rpcCodeOf(error)) {
      case RPC_CODE_INVALID_REQUEST:
        return NO_LIMITS;
      case RPC_CODE_INTERNAL_ERROR:
        return UNREADABLE;
      default:
        throw error;
    }
  }
}

async function spawnProbe(
  deps: CodexProbeDeps,
  account: Account,
): Promise<Contained> {
  const runId = deps.newRunId();
  const executable = await deps.executable();
  const spec: AgentStartSpec = {
    account,
    cwd: account.configDir,
    profile: PermissionProfile.plan,
    runId,
    executable,
  };
  const launch = buildCodexLaunch({
    executable,
    configDir: account.configDir,
    env: deps.envFor(spec),
    platform: deps.platform,
    comSpec: deps.comSpec,
  });
  return deps.container.spawn({
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd: account.configDir,
    runId,
    ...(launch.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
  });
}

async function stopProbe(
  contained: Contained,
  graceMs: number,
  accountId: string,
): Promise<boolean> {
  try {
    const result = await contained.stop(graceMs);
    if (!result.ok) {
      console.warn(`limit probe left processes behind: ${accountId}`);
    }
    return result.ok;
  } catch (error) {
    console.error(`stopping the limit probe failed: ${accountId}`, error);
    return false;
  }
}

async function readOrFail(
  deps: CodexProbeDeps,
  account: Account,
  signal: AbortSignal,
  rpc: CodexRpc,
): Promise<ProbeResult> {
  const abort = watchAbort(signal);
  try {
    return await withTimeout(
      Promise.race([readLimits(rpc), abort.promise]),
      deps.timeoutMs,
    );
  } catch (error) {
    if (!signal.aborted) {
      console.warn(`limit probe failed: ${account.id}`, error);
    }
    return FAILED;
  } finally {
    abort.release();
  }
}

async function runProbe(
  deps: CodexProbeDeps,
  account: Account,
  signal: AbortSignal,
  contained: Contained,
): Promise<ProbeResult> {
  const rpc = createCodexRpc(contained.stdout, contained.stdin);
  const result = await readOrFail(deps, account, signal, rpc);
  rpc.close();
  const stopped = await stopProbe(contained, deps.stopGraceMs, account.id);
  return stopped ? result : UNSTOPPED;
}

export function createCodexLimitProbe(deps: CodexProbeDeps): CodexLimitProbe {
  return async (account, signal) => {
    if (signal.aborted) {
      return FAILED;
    }
    let contained: Contained;
    try {
      contained = await spawnProbe(deps, account);
    } catch (error) {
      console.warn(`limit probe failed: ${account.id}`, error);
      return FAILED;
    }
    return runProbe(deps, account, signal, contained);
  };
}
