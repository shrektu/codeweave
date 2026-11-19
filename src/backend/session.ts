import { MS_PER_SECOND } from "../domain/constants";
import { rotationPool } from "../domain/rotationPool";
import {
  mergeRuntime,
  type AccountRuntime,
  type RotationPorts,
} from "../domain/rotation";
import type { SecretEntry } from "../domain/secretMask";
import {
  ProviderId,
  type Account,
  type EpochMillis,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { SessionView } from "../shared/views";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartResult,
} from "./agentAdapter";
import type { ConnectionRegistry } from "./connections";
import { CONTAINER_UNAVAILABLE_MESSAGE } from "./constants";
import { exhaustedOnly, SessionRun } from "./sessionRun";
import { observeViews } from "./sessionViews";
import type { JsonStore } from "./storage";
import type { PromptOverrides } from "./turnRouting";

export interface ContainerStatus {
  readonly available: boolean;
  readonly message: string | null;
}

export interface SessionServiceDeps {
  readonly adapter: AgentAdapter;
  readonly store: JsonStore;
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly now: () => EpochMillis;
  readonly schedule: RotationPorts["schedule"];
  readonly inspectWorktree: (cwd: string) => Promise<WorktreeState>;
  readonly newRunId: () => string;
  readonly resolveExecutable: (
    provider: ProviderId,
    configured: string | null,
  ) => string;
  readonly stopGraceMs: number;
  readonly containerStatus: ContainerStatus;
  readonly externalRuntime: (accountId: string) => AccountRuntime | null;
  readonly beforeLaunch: (accountId: string) => Promise<void>;
  readonly isBlocked: (accountId: string) => boolean;
  readonly hasKey: (accountId: string) => boolean;
  readonly secrets: (accounts: readonly Account[]) => readonly SecretEntry[];
}

export interface SessionService {
  view(): SessionView | null;
  start(params: ParamsMap["session/start"]): Promise<SessionView>;
  prompt(text: string, overrides?: PromptOverrides): Promise<void>;
  stop(): Promise<void>;
  answerPermission(requestId: string, optionId: string): void;
  isInUse(accountId: string): boolean;
  runtimeOf(accountId: string): AccountRuntime;
  onRuntimeChanged(listener: () => void): () => void;
  onViewChanged(listener: (view: SessionView | null) => void): () => void;
  isLive(): boolean;
  isSettled(): boolean;
  setAccounts(accounts: readonly Account[]): void;
  shutdown(): Promise<void>;
}

const READY: AccountRuntime = { status: "ready" };
const PREVIOUS_AGENT_RUNNING_MESSAGE = "The previous agent is still running";
const NO_USABLE_ACCOUNT_MESSAGE = "No usable account";

function startError(
  account: Account,
  result: AgentStartResult,
  mask: (text: string) => string,
): IpcError {
  if (!result.ok && result.reason === AgentStartFailure.needsLogin) {
    return new IpcError(
      IpcErrorCode.CONFLICT,
      `Account ${account.label} needs login`,
    );
  }
  return new IpcError(
    IpcErrorCode.UNAVAILABLE,
    mask(`Could not start the agent: ${result.ok ? "" : result.message}`),
  );
}

function runtimeSignature(
  runtime: ReadonlyMap<string, AccountRuntime> | undefined,
): string {
  const informative = [...(runtime ?? [])]
    .filter(([, value]) => value.status !== READY.status)
    .toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(informative);
}

function isUsable(runtime: AccountRuntime, now: EpochMillis): boolean {
  return (
    runtime.status === "ready" ||
    (runtime.status === "exhausted" && runtime.resetsAt * MS_PER_SECOND <= now)
  );
}

interface CreatedRun {
  readonly run: SessionRun;
  readonly initial: Account;
}

interface RunWiring {
  readonly runtimeOf: (accountId: string) => AccountRuntime;
  readonly reserved: Set<string>;
  readonly loginFailures: ReadonlySet<string>;
  readonly onRuntimeSettled: () => void;
}

function canStartWith(
  deps: SessionServiceDeps,
  wiring: RunWiring,
  account: Account,
): boolean {
  const keyed =
    account.provider !== ProviderId.opencode || deps.hasKey(account.id);
  return (
    keyed &&
    !wiring.loginFailures.has(account.id) &&
    !deps.isBlocked(account.id) &&
    isUsable(wiring.runtimeOf(account.id), deps.now())
  );
}

async function createRun(
  deps: SessionServiceDeps,
  params: ParamsMap["session/start"],
  wiring: RunWiring,
): Promise<CreatedRun> {
  const registered = (await deps.store.readAccounts()).toSorted(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  const provider = params.provider ?? registered[0]?.provider;
  if (provider === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, NO_USABLE_ACCOUNT_MESSAGE);
  }
  const accounts = rotationPool(provider, registered);
  const initial = accounts.find((account) =>
    canStartWith(deps, wiring, account),
  );
  if (initial === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, NO_USABLE_ACCOUNT_MESSAGE);
  }
  const settings = await deps.store.readSettings();
  const run = new SessionRun({
    deps,
    spec: {
      cwd: params.cwd,
      profile: params.profile ?? settings.permissionProfile,
      flowRef: params.flowRef ?? null,
      model: params.model ?? null,
      taskClass: params.taskClass ?? null,
      defaultTaskClass: settings.defaultTaskClass,
    },
    provider,
    registered,
    accounts,
    initial,
    reserved: wiring.reserved,
    loginFailures: wiring.loginFailures,
    onRuntimeSettled: wiring.onRuntimeSettled,
  });
  return { run, initial };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const views = observeViews(deps.broadcast);
  const observed: SessionServiceDeps = { ...deps, broadcast: views.broadcast };
  let run: SessionRun | null = null;
  let opening: SessionRun | null = null;
  let starting = false;
  const reserved = new Set<string>();
  let lastSignature = runtimeSignature(undefined);
  const listeners = new Set<() => void>();

  const checkRuntime = (): void => {
    const signature = runtimeSignature(run?.runtime());
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    listeners.forEach((listener) => {
      listener();
    });
  };
  const requireRun = (): SessionRun => {
    if (run === null) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, "There is no session");
    }
    return run;
  };
  const exhaustedProbe = exhaustedOnly(deps);
  const ownRuntimeOf = (accountId: string): AccountRuntime | null =>
    run?.ownRuntimeOf(accountId) ?? null;
  const runtimeOf = (accountId: string): AccountRuntime =>
    mergeRuntime(
      ownRuntimeOf(accountId),
      deps.externalRuntime(accountId),
      deps.now(),
    );
  const startRuntimeOf = (accountId: string): AccountRuntime =>
    mergeRuntime(
      ownRuntimeOf(accountId),
      exhaustedProbe(accountId),
      deps.now(),
    );
  const openRun = async (
    params: ParamsMap["session/start"],
    loginFailures: ReadonlySet<string>,
  ): Promise<CreatedRun> => {
    opening = null;
    const created = await createRun(observed, params, {
      runtimeOf: startRuntimeOf,
      reserved,
      loginFailures,
      onRuntimeSettled: checkRuntime,
    });
    opening = created.run;
    return created;
  };
  const isLoginFailure = (
    result: AgentStartResult,
    account: Account,
  ): boolean =>
    !result.ok &&
    result.reason === AgentStartFailure.needsLogin &&
    account.provider === ProviderId.opencode;
  const isRetryable = (result: AgentStartResult, initial: Account): boolean =>
    isLoginFailure(result, initial) ||
    (!result.ok &&
      result.reason === AgentStartFailure.unavailable &&
      deps.isBlocked(initial.id));
  const reopen = async (
    params: ParamsMap["session/start"],
    loginFailures: ReadonlySet<string>,
    failed: CreatedRun,
    result: AgentStartResult,
  ): Promise<CreatedRun> => {
    try {
      return await openRun(params, loginFailures);
    } catch (error) {
      const exhausted =
        error instanceof IpcError && error.code === IpcErrorCode.CONFLICT;
      if (exhausted && loginFailures.has(failed.initial.id)) {
        throw startError(failed.initial, result, (text) =>
          failed.run.maskText(text),
        );
      }
      throw error;
    }
  };
  const beginRun = async (
    params: ParamsMap["session/start"],
  ): Promise<{ created: CreatedRun; result: AgentStartResult }> => {
    const loginFailures = new Set<string>();
    let created = await openRun(params, loginFailures);
    let result = await created.run.begin(created.initial);
    while (isRetryable(result, created.initial)) {
      if (isLoginFailure(result, created.initial)) {
        loginFailures.add(created.initial.id);
      }
      created = await reopen(params, loginFailures, created, result);
      result = await created.run.begin(created.initial);
    }
    return { created, result };
  };
  const releasePrevious = async (): Promise<void> => {
    await run?.close();
    if (run?.hasAgents() === true) {
      throw new IpcError(IpcErrorCode.CONFLICT, PREVIOUS_AGENT_RUNNING_MESSAGE);
    }
  };

  return {
    view: () => run?.view() ?? null,
    async start(params): Promise<SessionView> {
      if (!deps.containerStatus.available) {
        throw new IpcError(
          IpcErrorCode.UNAVAILABLE,
          deps.containerStatus.message ?? CONTAINER_UNAVAILABLE_MESSAGE,
        );
      }
      if (starting || run?.isLive() === true) {
        throw new IpcError(
          IpcErrorCode.CONFLICT,
          "A session is already running",
        );
      }
      starting = true;
      try {
        await releasePrevious();
        const { created, result } = await beginRun(params);
        if (!result.ok) {
          throw startError(created.initial, result, (text) =>
            created.run.maskText(text),
          );
        }
        run = created.run;
      } finally {
        opening = null;
        starting = false;
      }
      const view = run.view();
      observed.broadcast("session/changed", view);
      checkRuntime();
      return view;
    },
    prompt: async (text, overrides) => {
      requireRun().prompt(text, overrides);
      return Promise.resolve();
    },
    stop: async () => {
      await run?.close();
      checkRuntime();
    },
    onRuntimeChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onViewChanged: views.listen,
    isLive: () => starting || (run?.isLive() ?? false),
    isSettled: () => run?.isSettled() ?? false,
    answerPermission: (requestId, optionId) => {
      requireRun().answerPermission(requestId, optionId);
    },
    isInUse: (accountId) =>
      reserved.has(accountId) ||
      (opening?.isInUse(accountId) ?? false) ||
      (run?.isInUse(accountId) ?? false),
    runtimeOf,
    setAccounts: (next) => {
      run?.setAccounts(next);
    },
    shutdown: async () => {
      await run?.close();
    },
  };
}
