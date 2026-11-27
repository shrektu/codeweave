import { expect, it, vi, type Mock } from "vitest";

import { RewindMode } from "../domain/checkpoints";
import { PermissionProfile, ProviderId } from "../domain/types";
import { emptyUsageLedger } from "../domain/usageLedger";
import { IpcErrorCode, type ParamsMap } from "../shared/protocol";
import type {
  PromptView,
  RestorePlanView,
  RestoreReportView,
  SessionView,
  StoredSession,
} from "../shared/views";

import type { SessionService } from "./session";
import {
  createRewindService,
  type RewindService,
  type RewindServiceDeps,
} from "./rewind";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_PROMPT: PromptView = { seq: 0, text: "first", attachments: [] };
const SECOND_PROMPT: PromptView = { seq: 2, text: "second", attachments: [] };
const PROMPTS: readonly PromptView[] = [FIRST_PROMPT, SECOND_PROMPT];
const EMPTY_REPORT: RestoreReportView = {
  restored: [],
  deleted: [],
  skipped: [],
};

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: SESSION_ID,
    createdAt: 0,
    cwd: "/repo",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    phase: { phase: "running", accountId: "acc-a" },
    activeAccountId: "acc-a",
    activeProvider: ProviderId.claude,
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
    currentModel: null,
    contextUsage: null,
    usage: emptyUsageLedger(),
    turns: [],
    orchestrate: false,
    imageInput: true,
    canCompact: false,
    prompts: [...PROMPTS],
    ...overrides,
  };
}

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    version: 1,
    id: SESSION_ID,
    createdAt: 0,
    updatedAt: 0,
    title: "first",
    cwd: "/repo",
    explicitFolder: true,
    provider: ProviderId.claude,
    profile: PermissionProfile.ask,
    orchestrate: false,
    archived: false,
    prompts: [...PROMPTS],
    messages: [],
    toolCalls: [],
    turns: [],
    lastTurn: null,
    usage: emptyUsageLedger(),
    nativeSessions: [],
    ...overrides,
  };
}

function fakeSession(overrides: Partial<SessionService> = {}): SessionService {
  return {
    view: () => view(),
    start: () => Promise.resolve(view()),
    prompt: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    answerPermission: () => undefined,
    isInUse: () => false,
    ownRuntimeOf: () => null,
    onRuntimeChanged: () => () => undefined,
    onViewChanged: () => () => undefined,
    isLive: () => true,
    isSettled: () => true,
    nativeSessions: () => [],
    setAccounts: () => undefined,
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

function params(
  mode: RewindMode = RewindMode.conversationAndFiles,
  promptSeq: number = FIRST_PROMPT.seq,
): ParamsMap["session/rewind"] {
  return { sessionId: SESSION_ID, promptSeq, mode, overwrite: [] };
}

interface HarnessOptions {
  readonly live?: SessionService | null;
  readonly openFlowRuns?: boolean;
  readonly stored?: StoredSession | null;
  readonly truncated?: StoredSession | null;
  readonly restoreError?: Error;
}

interface Harness {
  readonly service: RewindService;
  readonly plan: Mock;
  readonly restore: Mock;
  readonly fold: Mock;
  readonly get: Mock;
  readonly flush: Mock;
  readonly truncate: Mock;
  readonly closeMain: Mock;
  readonly resume: Mock;
}

function harness(options: HarnessOptions = {}): Harness {
  const restore = vi.fn((): Promise<RestoreReportView> =>
    options.restoreError === undefined
      ? Promise.resolve(EMPTY_REPORT)
      : Promise.reject(options.restoreError),
  );
  const plan = vi.fn((): Promise<RestorePlanView> =>
    Promise.resolve({
      sessionId: SESSION_ID,
      promptSeq: FIRST_PROMPT.seq,
      files: [],
    }),
  );
  const fold = vi.fn((): Promise<void> => Promise.resolve());
  const get = vi.fn((): Promise<StoredSession | null> =>
    Promise.resolve(options.stored ?? null),
  );
  const flush = vi.fn((): Promise<void> => Promise.resolve());
  const truncate = vi.fn((): Promise<StoredSession | null> =>
    Promise.resolve(options.truncated ?? null),
  );
  const closeMain = vi.fn((): Promise<void> => Promise.resolve());
  const resume = vi.fn((): Promise<SessionView> => Promise.resolve(view()));
  const deps: RewindServiceDeps = {
    sessions: { main: () => options.live ?? null, closeMain },
    history: { get, flush, truncate },
    checkpoints: { plan, restore, fold },
    hasOpenFlowRuns: () => options.openFlowRuns ?? false,
    resume,
  };
  return {
    service: createRewindService(deps),
    plan,
    restore,
    fold,
    get,
    flush,
    truncate,
    closeMain,
    resume,
  };
}

it("rewind rejects while a turn is in flight", async () => {
  const runtime = harness({
    live: fakeSession({
      view: () => view({ turnInFlight: true }),
      isLive: () => true,
    }),
  });

  await expect(runtime.service.rewind(params())).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "Stop the agent before rewinding",
  });
  expect(runtime.restore).not.toHaveBeenCalled();
  expect(runtime.truncate).not.toHaveBeenCalled();
  expect(runtime.closeMain).not.toHaveBeenCalled();
});

it("rewind rejects while a flow runs", async () => {
  const runtime = harness({ openFlowRuns: true });

  await expect(runtime.service.rewind(params())).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is running",
  });
  expect(runtime.restore).not.toHaveBeenCalled();
  expect(runtime.truncate).not.toHaveBeenCalled();
});

it("restore failure leaves the transcript untouched", async () => {
  const failure = new Error("the checkpoint blob is gone");
  const runtime = harness({
    live: fakeSession({ view: () => view(), isLive: () => true }),
    restoreError: failure,
  });

  await expect(runtime.service.rewind(params())).rejects.toThrow(
    "the checkpoint blob is gone",
  );
  expect(runtime.closeMain).not.toHaveBeenCalled();
  expect(runtime.truncate).not.toHaveBeenCalled();
  expect(runtime.fold).not.toHaveBeenCalled();
  expect(runtime.resume).not.toHaveBeenCalled();
});

it("files mode does not close the session", async () => {
  const runtime = harness({
    live: fakeSession({ view: () => view(), isLive: () => true }),
  });

  const result = await runtime.service.rewind(params(RewindMode.files));

  expect(result).toEqual({
    promptText: FIRST_PROMPT.text,
    report: EMPTY_REPORT,
    session: null,
  });
  expect(runtime.restore).toHaveBeenCalledWith(
    SESSION_ID,
    FIRST_PROMPT.seq,
    [],
  );
  expect(runtime.closeMain).not.toHaveBeenCalled();
  expect(runtime.truncate).not.toHaveBeenCalled();
  expect(runtime.fold).not.toHaveBeenCalled();
  expect(runtime.resume).not.toHaveBeenCalled();
});

it("conversation mode on a history-only session returns no session", async () => {
  const truncated = storedSession({ prompts: [FIRST_PROMPT] });
  const runtime = harness({
    stored: storedSession(),
    truncated,
  });

  const result = await runtime.service.rewind(params(RewindMode.conversation));

  expect(result).toEqual({
    promptText: FIRST_PROMPT.text,
    report: null,
    session: null,
  });
  expect(runtime.flush).toHaveBeenCalled();
  expect(runtime.truncate).toHaveBeenCalledWith(SESSION_ID, FIRST_PROMPT.seq);
  expect(runtime.fold).toHaveBeenCalledWith(
    SESSION_ID,
    FIRST_PROMPT.seq,
    FIRST_PROMPT.seq,
  );
  expect(runtime.closeMain).not.toHaveBeenCalled();
  expect(runtime.resume).not.toHaveBeenCalled();
});

it("unknown prompt is not found", async () => {
  const runtime = harness();

  await expect(
    runtime.service.rewind(params(RewindMode.conversation, 999)),
  ).rejects.toMatchObject({
    code: IpcErrorCode.NOT_FOUND,
    message: "Prompt not found",
  });
  expect(runtime.restore).not.toHaveBeenCalled();
  expect(runtime.plan).not.toHaveBeenCalled();
});

it("rewind rejects while an orchestrator child run is open", async () => {
  const runtime = harness({ openFlowRuns: true });

  await expect(runtime.service.rewind(params())).rejects.toMatchObject({
    code: IpcErrorCode.CONFLICT,
    message: "A flow is running",
  });
  expect(runtime.restore).not.toHaveBeenCalled();
});

it("rewind folds to the last kept prompt, not N-1", async () => {
  const cutPrompt: PromptView = { seq: 5, text: "cut", attachments: [] };
  const runtime = harness({
    stored: storedSession({ prompts: [FIRST_PROMPT, cutPrompt] }),
    truncated: storedSession({ prompts: [FIRST_PROMPT] }),
  });

  await runtime.service.rewind(params(RewindMode.conversation, cutPrompt.seq));

  expect(runtime.fold).toHaveBeenCalledWith(
    SESSION_ID,
    cutPrompt.seq,
    FIRST_PROMPT.seq,
  );
});
