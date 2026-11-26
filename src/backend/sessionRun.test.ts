import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAttachmentStore } from "../../tests/fakes/fakeAttachmentStore";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import { INITIAL_SESSION_STATE } from "../domain/sessionReducer";
import { PermissionProfile, ProviderId, type Account } from "../domain/types";

import { settled } from "../../tests/fakes/settle";

import { createAccountReservations } from "./accountReservations";
import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentHandle,
  type AgentStartSpec,
  type AgentToolAccess,
} from "./agentAdapter";
import { createLeaseModes } from "./leaseModes";
import {
  createSessionService,
  type ResumeSeed,
  type SessionService,
} from "./session";
import { createJsonStore } from "./storage";

const ACCOUNT: Account = {
  id: "acc-a",
  provider: ProviderId.claude,
  label: "A",
  configDir: "/cfg/a",
  order: 0,
};
const ALLOW_ONCE = "allow-once";
const REQUEST_ID = "per_1";
const READ_REQUEST: AgentEvent = {
  type: "permission_request",
  requestId: REQUEST_ID,
  toolCallId: "t1",
  title: "Read notes",
  kind: "read",
  locations: [],
  options: [
    { optionId: ALLOW_ONCE, name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};

interface Rig {
  readonly service: SessionService;
  readonly cwd: string;
  readonly answers: [string, string][];
  readonly emit: (event: AgentEvent) => void;
  readonly releaseWorktree: () => void;
  readonly untilPrompted: () => Promise<undefined>;
  readonly finishTurn: () => void;
}

const tempDirs: string[] = [];
const services: SessionService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createHandle(
  listeners: Set<(event: AgentEvent) => void>,
  answers: [string, string][],
  turn: PromiseWithResolvers<undefined>,
  prompted: PromiseWithResolvers<undefined>,
): AgentHandle {
  return {
    accountId: ACCOUNT.id,
    nativeSessionId: null,
    resumed: false,
    runId: "run-1",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: () => {
      listeners.forEach((listener) => {
        listener(READ_REQUEST);
      });
      prompted.resolve(undefined);
      return turn.promise;
    },
    answerPermission: (requestId, optionId) => {
      answers.push([requestId, optionId]);
    },
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => Promise.resolve({ ok: true }),
  };
}

function serviceOn(
  store: ReturnType<typeof createJsonStore>,
  adapter: AgentAdapter,
  inspectWorktree: (dir: string) => Promise<{ isRepo: false; cwd: string }>,
  attachments: ReturnType<typeof fakeAttachmentStore>,
): SessionService {
  return createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
    publishView: () => undefined,
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree,
    newRunId: () => "run-1",
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? "/home/u"),
    protectedPaths: () => Promise.resolve([]),
    attachments,
  });
}

async function openRig(attachments = fakeAttachmentStore()): Promise<Rig> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-run-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-run-cwd-"));
  tempDirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT]);
  const listeners = new Set<(event: AgentEvent) => void>();
  const answers: [string, string][] = [];
  const worktree = Promise.withResolvers<undefined>();
  const turn = Promise.withResolvers<undefined>();
  const prompted = Promise.withResolvers<undefined>();
  const handle = createHandle(listeners, answers, turn, prompted);
  const adapter: AgentAdapter = {
    start: () => Promise.resolve({ ok: true, handle }),
  };
  const service = serviceOn(
    store,
    adapter,
    async (dir) => {
      await worktree.promise;
      return { isRepo: false, cwd: dir };
    },
    attachments,
  );
  services.push(service);
  return {
    service,
    cwd,
    answers,
    emit: (event) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
    releaseWorktree: () => {
      worktree.resolve(undefined);
    },
    untilPrompted: () => prompted.promise,
    finishTurn: () => {
      turn.resolve(undefined);
    },
  };
}

async function withPendingRequest(profile: PermissionProfile): Promise<Rig> {
  const rig = await openRig();
  await rig.service.start({ cwd: rig.cwd, profile });
  void rig.service.prompt("go");
  await rig.untilPrompted();
  return rig;
}

it("settled_record_rejects_click", async () => {
  const rig = await withPendingRequest(PermissionProfile.ask);

  rig.emit({
    type: "permission_settled",
    requestId: REQUEST_ID,
    optionId: ALLOW_ONCE,
  });

  expect(rig.service.view()?.permissions).toEqual([]);
  expect(() => {
    rig.service.answerPermission(REQUEST_ID, ALLOW_ONCE);
  }).toThrow("Permission request was already answered");
  expect(rig.answers).toEqual([]);
});

it("auto_answer_after_settle_is_silent", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rig = await withPendingRequest(PermissionProfile.unattended);

  rig.emit({
    type: "permission_settled",
    requestId: REQUEST_ID,
    optionId: ALLOW_ONCE,
  });
  rig.releaseWorktree();
  await settled(() => {
    expect(rig.service.view()?.permissions).toEqual([]);
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(rig.answers).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
  rig.finishTurn();
});

const ACCOUNT_B: Account = { ...ACCOUNT, id: "acc-b", label: "B", order: 1 };
const TOKEN = "flow-token-1234567890";
const TOOLS: AgentToolAccess = {
  server: "codeweave",
  url: "http://127.0.0.1:41234/mcp",
  token: TOKEN,
  toolNames: ["list_flows"],
};
const PREAMBLE = "You orchestrate.";
const PREAMBLE_GAP = "\n\n";
const RATE_LIMITED: AgentEvent = {
  type: "turn_error",
  errorKind: "rate_limit",
  rpcCode: null,
  message: "usage limit reached",
};

interface ToolRigOptions {
  readonly events?: Readonly<Record<string, readonly AgentEvent[]>>;
  readonly replayed?: Readonly<Record<string, readonly AgentEvent[]>>;
  readonly contextFailure?: Error;
  readonly startFailure?: string;
  readonly promptFailures?: number;
}

interface ToolRig {
  readonly service: SessionService;
  readonly cwd: string;
  readonly specs: AgentStartSpec[];
  readonly prompts: Record<string, string[]>;
  readonly attempts: string[];
  readonly nativeIds: Record<string, string | null>;
}

function toolHandle(
  spec: AgentStartSpec,
  events: readonly AgentEvent[],
  replayed: readonly AgentEvent[],
  prompts: Record<string, string[]>,
  attempts: string[],
  failures: { count: number },
  nativeIds: Record<string, string | null>,
): AgentHandle {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    accountId: spec.account.id,
    get nativeSessionId(): string | null {
      return nativeIds[spec.account.id] ?? null;
    },
    get resumed(): boolean {
      return spec.resume !== undefined;
    },
    runId: spec.runId,
    subscribe: (listener) => {
      listeners.add(listener);
      replayed.forEach((event) => {
        listener(event);
      });
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: (text) => {
      attempts.push(text);
      if (failures.count > 0) {
        failures.count -= 1;
        return Promise.reject(new Error("send failed"));
      }
      (prompts[spec.account.id] ??= []).push(text);
      for (const event of events) {
        listeners.forEach((listener) => {
          listener(event);
        });
      }
      return Promise.resolve();
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => Promise.resolve({ ok: true }),
  };
}

async function openToolRig(options: ToolRigOptions = {}): Promise<ToolRig> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-tools-user-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-tools-cwd-"));
  tempDirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT, ACCOUNT_B]);
  const specs: AgentStartSpec[] = [];
  const prompts: Record<string, string[]> = {};
  const attempts: string[] = [];
  const failures = { count: options.promptFailures ?? 0 };
  const nativeIds: Record<string, string | null> = {};
  const adapter: AgentAdapter = {
    start: (spec) => {
      specs.push(spec);
      nativeIds[spec.account.id] = spec.resume?.nativeSessionId ?? null;
      return Promise.resolve(
        options.startFailure === undefined
          ? {
              ok: true,
              handle: toolHandle(
                spec,
                options.events?.[spec.account.id] ?? [],
                options.replayed?.[spec.account.id] ?? [],
                prompts,
                attempts,
                failures,
                nativeIds,
              ),
            }
          : {
              ok: false,
              reason: AgentStartFailure.error,
              message: options.startFailure,
            },
      );
    },
  };
  let runs = 0;
  const service = createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
    publishView: () => undefined,
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree: (dir) =>
      options.contextFailure === undefined
        ? Promise.resolve({ isRepo: false, cwd: dir })
        : Promise.reject(options.contextFailure),
    newRunId: () => {
      runs += 1;
      return `run-${String(runs)}`;
    },
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: "/home/u",
    resolveFolder: (requested) => Promise.resolve(requested ?? "/home/u"),
    protectedPaths: () => Promise.resolve([]),
    attachments: fakeAttachmentStore(),
  });
  services.push(service);
  return { service, cwd, specs, prompts, attempts, nativeIds };
}

async function untilIdle(service: SessionService): Promise<void> {
  await settled(() => {
    expect(service.view()?.turnInFlight).toBe(false);
    expect(service.isSettled()).toBe(true);
  });
}

it("prepends_the_preamble_once_per_agent_handle", async () => {
  const rig = await openToolRig();
  await rig.service.start(
    { cwd: rig.cwd },
    { tools: TOOLS, preamble: PREAMBLE },
  );

  await rig.service.prompt("first");
  await untilIdle(rig.service);
  await rig.service.prompt("second");
  await untilIdle(rig.service);

  expect(rig.prompts[ACCOUNT.id]).toEqual([
    `${PREAMBLE}${PREAMBLE_GAP}first`,
    "second",
  ]);
  expect(rig.service.view()?.orchestrate).toBe(true);
});

it("sends_the_prompt_unchanged_without_a_preamble", async () => {
  const rig = await openToolRig();
  await rig.service.start({ cwd: rig.cwd });

  await rig.service.prompt("plain");
  await untilIdle(rig.service);

  expect(rig.prompts[ACCOUNT.id]).toEqual(["plain"]);
  expect(rig.specs[0]).not.toHaveProperty("tools");
  expect(rig.service.view()?.orchestrate).toBe(false);
});

it("passes_tools_on_rotation_and_repeats_the_preamble_for_the_new_handle", async () => {
  const rig = await openToolRig({ events: { [ACCOUNT.id]: [RATE_LIMITED] } });
  await rig.service.start(
    { cwd: rig.cwd },
    { tools: TOOLS, preamble: PREAMBLE },
  );

  await rig.service.prompt("go");
  await settled(() => {
    expect(rig.prompts[ACCOUNT_B.id]).toHaveLength(1);
  });

  expect(rig.specs.map((spec) => [spec.account.id, spec.tools])).toEqual([
    [ACCOUNT.id, TOOLS],
    [ACCOUNT_B.id, TOOLS],
  ]);
  expect(rig.prompts[ACCOUNT.id]).toEqual([`${PREAMBLE}${PREAMBLE_GAP}go`]);
  expect(rig.prompts[ACCOUNT_B.id]?.[0]?.startsWith(PREAMBLE)).toBe(true);
});

it("rotation_model_not_written_into_previous_turn", async () => {
  const rig = await openToolRig({
    events: { [ACCOUNT.id]: [RATE_LIMITED] },
    replayed: { [ACCOUNT_B.id]: [{ type: "model", model: "model-b" }] },
    contextFailure: new Error("worktree gone"),
  });
  await rig.service.start({ cwd: rig.cwd });

  await rig.service.prompt("go");
  await settled(() => {
    expect(rig.specs.map((spec) => spec.account.id)).toEqual([
      ACCOUNT.id,
      ACCOUNT_B.id,
    ]);
    expect(rig.service.view()?.turnInFlight).toBe(false);
    expect(rig.service.view()?.currentModel).toBe("model-b");
  });

  expect(rig.service.view()?.turns).toEqual([
    expect.objectContaining({ accountId: ACCOUNT.id, effectiveModel: null }),
  ]);
});

it("opencode_repeat_turn_keeps_served_model", async () => {
  const rig = await openToolRig({
    replayed: { [ACCOUNT.id]: [{ type: "model", model: "served-a" }] },
  });
  await rig.service.start({ cwd: rig.cwd });

  await rig.service.prompt("first");
  await untilIdle(rig.service);
  await rig.service.prompt("second");
  await untilIdle(rig.service);

  expect(rig.service.view()?.turns.map((turn) => turn.effectiveModel)).toEqual([
    "served-a",
    "served-a",
  ]);
});

it("masks_the_flow_tool_token_in_events_and_errors", async () => {
  const leaking: readonly AgentEvent[] = [
    { type: "text", text: `the token is ${TOKEN} ok` },
    {
      type: "turn_error",
      errorKind: null,
      rpcCode: null,
      message: `failed with ${TOKEN}`,
    },
  ];
  const rig = await openToolRig({ events: { [ACCOUNT.id]: leaking } });
  await rig.service.start(
    { cwd: rig.cwd },
    { tools: TOOLS, preamble: PREAMBLE },
  );

  await rig.service.prompt("go");
  await untilIdle(rig.service);

  const serialized = JSON.stringify(rig.service.view());
  expect(serialized).toContain("[redacted:flow tool token]");
  expect(serialized).not.toContain(TOKEN);
  const failing = await openToolRig({ startFailure: `refused ${TOKEN}` });
  await expect(
    failing.service.start({ cwd: failing.cwd }, { tools: TOOLS }),
  ).rejects.toThrow(
    "Could not start the agent: refused [redacted:flow tool token]",
  );
});

const RESUME_ID = "old-session-id";
const RESUME_CREATED_AT = 1234;

function resumeSeed(): ResumeSeed {
  return {
    id: RESUME_ID,
    createdAt: RESUME_CREATED_AT,
    state: {
      ...INITIAL_SESSION_STATE,
      prompts: [{ seq: 0, text: "old goal", attachments: [] }],
      messages: [{ id: null, text: "old reply", seq: 1 }],
      nextSeq: 2,
    },
    nativeSessions: [],
    contextPackage: "PACKAGE",
  };
}

it("resume_package_sent_only_with_first_prompt", async () => {
  const rig = await openToolRig();
  await rig.service.start(
    { cwd: rig.cwd },
    { resume: resumeSeed(), preamble: PREAMBLE },
  );

  await rig.service.prompt("first");
  await untilIdle(rig.service);
  await rig.service.prompt("second");
  await untilIdle(rig.service);

  expect(rig.prompts[ACCOUNT.id]).toEqual([
    `PACKAGE${PREAMBLE_GAP}${PREAMBLE}${PREAMBLE_GAP}first`,
    "second",
  ]);
});

it("resumed_seq_continues_after_stored_max", async () => {
  const rig = await openToolRig();
  await rig.service.start({ cwd: rig.cwd }, { resume: resumeSeed() });

  await rig.service.prompt("first");
  await untilIdle(rig.service);

  const view = rig.service.view();
  expect(view?.id).toBe(RESUME_ID);
  expect(view?.createdAt).toBe(RESUME_CREATED_AT);
  expect(view?.prompts).toEqual([
    { seq: 0, text: "old goal", attachments: [] },
    { seq: 2, text: "first", attachments: [] },
  ]);
  expect(view?.messages).toEqual([{ id: null, text: "old reply", seq: 1 }]);
});

it("package_skipped_when_handle_resumed", async () => {
  const rig = await openToolRig();
  await rig.service.start(
    { cwd: rig.cwd },
    {
      resume: {
        ...resumeSeed(),
        nativeSessions: [
          { accountId: ACCOUNT.id, nativeSessionId: "native-session-1" },
        ],
      },
    },
  );

  await rig.service.prompt("first");
  await untilIdle(rig.service);

  expect(rig.specs[0]?.resume).toEqual({
    nativeSessionId: "native-session-1",
  });
  expect(rig.prompts[ACCOUNT.id]).toEqual(["first"]);
  expect(rig.service.view()?.id).toBe(RESUME_ID);
});

it("native_id_used_only_by_its_account", async () => {
  const rig = await openToolRig({ events: { [ACCOUNT.id]: [RATE_LIMITED] } });
  await rig.service.start(
    { cwd: rig.cwd },
    {
      resume: {
        ...resumeSeed(),
        nativeSessions: [
          { accountId: ACCOUNT.id, nativeSessionId: "native-session-1" },
        ],
      },
    },
  );

  await rig.service.prompt("first");
  await settled(() => {
    expect(rig.specs).toHaveLength(2);
  });
  await untilIdle(rig.service);

  expect(rig.specs[0]?.resume).toEqual({
    nativeSessionId: "native-session-1",
  });
  expect(rig.specs[1]?.resume).toBeUndefined();
  expect(
    rig.service
      .nativeSessions()
      .some((entry) => entry.accountId === ACCOUNT_B.id),
  ).toBe(false);
});

it("native_ids_follow_live_handle", async () => {
  const rig = await openToolRig();
  await rig.service.start({ cwd: rig.cwd });

  expect(rig.service.nativeSessions()).toEqual([]);

  rig.nativeIds[ACCOUNT.id] = "conv-live";
  expect(rig.service.nativeSessions()).toEqual([
    { accountId: ACCOUNT.id, nativeSessionId: "conv-live" },
  ]);

  rig.nativeIds[ACCOUNT.id] = "conv-next";
  expect(rig.service.nativeSessions()).toEqual([
    { accountId: ACCOUNT.id, nativeSessionId: "conv-next" },
  ]);
});

it("resume_package_survives_failed_first_prompt", async () => {
  const rig = await openToolRig({ promptFailures: 1 });
  await rig.service.start({ cwd: rig.cwd }, { resume: resumeSeed() });

  await rig.service.prompt("first");
  await untilIdle(rig.service);
  await rig.service.prompt("second");
  await untilIdle(rig.service);

  expect(rig.attempts).toEqual([
    `PACKAGE${PREAMBLE_GAP}first`,
    `PACKAGE${PREAMBLE_GAP}second`,
  ]);
  expect(rig.prompts[ACCOUNT.id]).toEqual([`PACKAGE${PREAMBLE_GAP}second`]);
});

const CLAIMED_ATTACHMENT = {
  id: "a".repeat(64),
  name: "photo.png",
  mimeType: "image/png" as const,
  bytes: 10,
};

function deferredAttachmentStore(): {
  readonly store: ReturnType<typeof fakeAttachmentStore>;
  readonly entered: Promise<undefined>;
  readonly claim: PromiseWithResolvers<string>;
} {
  const entered = Promise.withResolvers<undefined>();
  const claim = Promise.withResolvers<string>();
  return {
    store: fakeAttachmentStore({
      claim: () => {
        entered.resolve(undefined);
        return claim.promise;
      },
    }),
    entered: entered.promise,
    claim,
  };
}

it("concurrent_prompt_during_image_claim_is_rejected_as_busy", async () => {
  const deferred = deferredAttachmentStore();
  const rig = await openRig(deferred.store);
  await rig.service.start({ cwd: rig.cwd, profile: PermissionProfile.ask });

  const first = rig.service.prompt("one", {
    attachments: [CLAIMED_ATTACHMENT],
  });
  await deferred.entered;

  expect(rig.service.view()?.turnInFlight).toBe(true);
  await expect(rig.service.prompt("two")).rejects.toMatchObject({
    code: "SESSION_BUSY",
  });

  deferred.claim.resolve("/tmp/photo.png");
  await first;
  await rig.untilPrompted();
  rig.finishTurn();
  await settled(() => {
    expect(rig.service.view()?.turnInFlight).toBe(false);
  });
  expect(rig.service.view()?.prompts.map((prompt) => prompt.text)).toEqual([
    "one",
  ]);
});

it("stop_during_image_claim_records_no_prompt", async () => {
  const deferred = deferredAttachmentStore();
  const rig = await openRig(deferred.store);
  await rig.service.start({ cwd: rig.cwd, profile: PermissionProfile.ask });

  const first = rig.service.prompt("one", {
    attachments: [CLAIMED_ATTACHMENT],
  });
  await deferred.entered;
  expect(rig.service.view()?.turnInFlight).toBe(true);
  await rig.service.stop();

  deferred.claim.resolve("/tmp/photo.png");

  await expect(first).rejects.toMatchObject({ code: "SESSION_BUSY" });
  expect(rig.service.view()?.prompts).toEqual([]);
});
