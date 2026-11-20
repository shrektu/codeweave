import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentEvent } from "../domain/events";
import { PermissionProfile, ProviderId, type Account } from "../domain/types";

import { settled } from "../../tests/fakes/settle";

import { createAccountReservations } from "./accountReservations";
import type { AgentAdapter, AgentHandle } from "./agentAdapter";
import { createLeaseModes } from "./leaseModes";
import { createSessionService, type SessionService } from "./session";
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

async function openRig(): Promise<Rig> {
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
  const service = createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
    publishView: () => undefined,
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree: async (dir) => {
      await worktree.promise;
      return { isRepo: false, cwd: dir };
    },
    newRunId: () => "run-1",
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
  });
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
