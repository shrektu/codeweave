import { ApiAuth } from "../domain/apiProviders";
import { MS_PER_SECOND } from "../domain/constants";
import { rotationPool } from "../domain/rotationPool";
import {
  mergeRuntime,
  type AccountRuntime,
  type RotationPorts,
} from "../domain/rotation";
import type { SecretEntry } from "../domain/secretMask";
import type { SessionState } from "../domain/sessionReducer";
import {
  ProviderId,
  type Account,
  type EpochMillis,
  type WorktreeState,
} from "../domain/types";
import { IpcError, IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type { NativeSessionRef, SessionView } from "../shared/views";

import type { AccountReservations } from "./accountReservations";
import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartResult,
  type AgentToolAccess,
} from "./agentAdapter";
import type { ConnectionRegistry } from "./connections";
import {
  CONTAINER_UNAVAILABLE_MESSAGE,
  SESSION_START_STOPPED_MESSAGE,
} from "./constants";
import { createInFlight } from "./inFlight";
import type { LeaseModes } from "./leaseModes";
import { LeaseMode } from "./locks";
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
  readonly publishView: (view: SessionView | null) => void;
  readonly reserved: AccountReservations;
  readonly leaseModes: LeaseModes;
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
  readonly protectedPaths: () => Promise<readonly string[]>;
  readonly homeDir: string;
  readonly resolveFolder: (requested: string | undefined) => Promise<string>;
}

export interface ResumeSeed {
  readonly id: string;
  readonly createdAt: number;
  readonly state: SessionState;
  readonly nativeSessions: readonly NativeSessionRef[];
  readonly contextPackage: string;
}

export interface StartOptions {
  readonly leaseMode?: LeaseMode;
  readonly tools?: AgentToolAccess;
  readonly preamble?: string;
  readonly resume?: ResumeSeed;
  readonly explicitFolder?: boolean;
}

export interface SessionService {
  view(): SessionView | null;
  start(
    params: ParamsMap["session/start"],
    options?: StartOptions,
  ): Promise<SessionView>;
  prompt(text: string, overrides?: PromptOverrides): Promise<void>;
  stop(): Promise<void>;
  answerPermission(requestId: string, optionId: string): void;
  isInUse(accountId: string): boolean;
  ownRuntimeOf(accountId: string): AccountRuntime | null;
  onRuntimeChanged(listener: () => void): () => void;
  onViewChanged(listener: (view: SessionView | null) => void): () => void;
  isLive(): boolean;
  isSettled(): boolean;
  nativeSessions(): readonly NativeSessionRef[];
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

interface StartToken {
  cancelled: boolean;
}

type StartInput = ParamsMap["session/start"] &
  Omit<StartOptions, "leaseMode"> & {
    readonly leaseMode: LeaseMode;
  };

type StartRequest = StartInput & {
  readonly cwd: string;
  readonly explicitFolder: boolean;
};

const isCancelled = (token: StartToken): boolean => token.cancelled;

interface RunWiring {
  readonly runtimeOf: (accountId: string) => AccountRuntime;
  readonly reserved: AccountReservations;
  readonly loginFailures: ReadonlySet<string>;
  readonly onRuntimeSettled: () => void;
}

function nativeResumeOf(
  resume: ResumeSeed | undefined,
  accountId: string,
): { readonly nativeSessionId: string } | undefined {
  const nativeSessionId = resume?.nativeSessions.find(
    (entry) => entry.accountId === accountId,
  )?.nativeSessionId;
  return nativeSessionId === undefined ? undefined : { nativeSessionId };
}

function resumableAccount(
  deps: SessionServiceDeps,
  wiring: RunWiring,
  accounts: readonly Account[],
  resume: ResumeSeed | undefined,
): Account | null {
  if (resume === undefined) {
    return null;
  }
  return (
    accounts.find(
      (account) =>
        nativeResumeOf(resume, account.id) !== undefined &&
        canStartWith(deps, wiring, account),
    ) ?? null
  );
}

function canStartWith(
  deps: SessionServiceDeps,
  wiring: RunWiring,
  account: Account,
): boolean {
  const keyed =
    account.provider !== ProviderId.opencode ||
    account.api?.auth === ApiAuth.consoleLogin ||
    deps.hasKey(account.id);
  return (
    keyed &&
    !wiring.loginFailures.has(account.id) &&
    !deps.isBlocked(account.id) &&
    isUsable(wiring.runtimeOf(account.id), deps.now())
  );
}

async function createRun(
  deps: SessionServiceDeps,
  params: StartRequest,
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
  const resumeAccount = resumableAccount(deps, wiring, accounts, params.resume);
  const initial =
    resumeAccount ??
    accounts.find((account) => canStartWith(deps, wiring, account));
  if (initial === undefined) {
    throw new IpcError(IpcErrorCode.CONFLICT, NO_USABLE_ACCOUNT_MESSAGE);
  }
  const resumeSpecs = params.resume?.nativeSessions;
  const settings = await deps.store.readSettings();
  const run = new SessionRun({
    deps,
    spec: {
      cwd: params.cwd,
      explicitFolder: params.explicitFolder,
      profile: params.profile ?? settings.permissionProfile,
      flowRef: params.flowRef ?? null,
      model: params.model ?? null,
      taskClass: params.taskClass ?? null,
      defaultTaskClass: settings.defaultTaskClass,
      tools: params.tools ?? null,
      preamble: params.preamble ?? null,
      ...(resumeSpecs === undefined || resumeSpecs.length === 0
        ? {}
        : { resume: resumeSpecs }),
    },
    provider,
    registered,
    accounts,
    initial,
    leaseMode: params.leaseMode,
    reserved: wiring.reserved,
    loginFailures: wiring.loginFailures,
    onRuntimeSettled: wiring.onRuntimeSettled,
    ...(params.resume === undefined ? {} : { resume: params.resume }),
  });
  return { run, initial };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const views = observeViews(deps.publishView);
  const observed: SessionServiceDeps = { ...deps, publishView: views.publish };
  const { reserved } = deps;
  let run: SessionRun | null = null;
  let opening: SessionRun | null = null;
  let pending: StartToken | null = null;
  const starts = createInFlight();
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
  const startRuntimeOf = (accountId: string): AccountRuntime =>
    mergeRuntime(
      ownRuntimeOf(accountId),
      exhaustedProbe(accountId),
      deps.now(),
    );
  const openRun = async (
    params: StartRequest,
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
    params: StartRequest,
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
  const startStopped = (): IpcError =>
    new IpcError(IpcErrorCode.CONFLICT, SESSION_START_STOPPED_MESSAGE);
  const abandon = async (created: SessionRun): Promise<never> => {
    await created.discard();
    if (created.hasAgents()) {
      run = created;
    }
    throw startStopped();
  };
  const launchOpened = async (
    created: CreatedRun,
    token: StartToken,
  ): Promise<AgentStartResult> => {
    if (isCancelled(token)) {
      return abandon(created.run);
    }
    return created.run.begin(created.initial);
  };
  const beginRun = async (
    params: StartRequest,
    token: StartToken,
  ): Promise<{ created: CreatedRun; result: AgentStartResult }> => {
    const loginFailures = new Set<string>();
    let created = await openRun(params, loginFailures);
    let result = await launchOpened(created, token);
    while (isRetryable(result, created.initial)) {
      if (isLoginFailure(result, created.initial)) {
        loginFailures.add(created.initial.id);
      }
      created = await reopen(params, loginFailures, created, result);
      result = await launchOpened(created, token);
    }
    return { created, result };
  };
  const runStart = async (
    input: StartInput,
    token: StartToken,
  ): Promise<SessionRun> => {
    try {
      const params: StartRequest = {
        ...input,
        cwd: await deps.resolveFolder(input.cwd),
        explicitFolder: input.explicitFolder ?? input.cwd !== undefined,
      };
      await releasePrevious();
      if (isCancelled(token)) {
        throw startStopped();
      }
      const { created, result } = await beginRun(params, token);
      if (isCancelled(token)) {
        await abandon(created.run);
      }
      if (!result.ok) {
        throw startError(created.initial, result, (text) =>
          created.run.maskText(text),
        );
      }
      run = created.run;
      return created.run;
    } finally {
      opening = null;
      pending = null;
    }
  };
  const interruptStart = async (): Promise<void> => {
    if (pending === null) {
      return;
    }
    pending.cancelled = true;
    opening?.markClosed();
    await starts.settled();
  };
  const releasePrevious = async (): Promise<void> => {
    await run?.close();
    if (run?.hasAgents() === true) {
      throw new IpcError(IpcErrorCode.CONFLICT, PREVIOUS_AGENT_RUNNING_MESSAGE);
    }
  };

  return {
    view: () => run?.view() ?? null,
    async start(params, options): Promise<SessionView> {
      if (!deps.containerStatus.available) {
        throw new IpcError(
          IpcErrorCode.UNAVAILABLE,
          deps.containerStatus.message ?? CONTAINER_UNAVAILABLE_MESSAGE,
        );
      }
      if (pending !== null || run?.isLive() === true) {
        throw new IpcError(
          IpcErrorCode.CONFLICT,
          "A session is already running",
        );
      }
      const token: StartToken = { cancelled: false };
      pending = token;
      const request: StartInput = {
        ...params,
        ...options,
        leaseMode: options?.leaseMode ?? LeaseMode.exclusive,
      };
      const started = await starts.track(() => runStart(request, token));
      const view = started.view();
      observed.publishView(view);
      checkRuntime();
      return view;
    },
    prompt: async (text, overrides) => {
      requireRun().prompt(text, overrides);
      return Promise.resolve();
    },
    stop: async () => {
      await interruptStart();
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
    isLive: () => pending !== null || (run?.isLive() ?? false),
    isSettled: () => run?.isSettled() ?? false,
    nativeSessions: () => run?.nativeSessions() ?? [],
    answerPermission: (requestId, optionId) => {
      requireRun().answerPermission(requestId, optionId);
    },
    isInUse: (accountId) =>
      reserved.has(accountId) ||
      (opening?.isInUse(accountId) ?? false) ||
      (run?.isInUse(accountId) ?? false),
    ownRuntimeOf,
    setAccounts: (next) => {
      run?.setAccounts(next);
    },
    shutdown: async () => {
      await interruptStart();
      await run?.close();
    },
  };
}
