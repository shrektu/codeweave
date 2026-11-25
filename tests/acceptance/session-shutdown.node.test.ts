import { afterEach, expect, it, vi } from "vitest";

import { SESSION_START_STOPPED_MESSAGE } from "../../src/backend/constants";
import { IpcErrorCode } from "../../src/shared/protocol";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  type BackendRig,
} from "../fakes/backendRig";
import type { ScriptStep } from "../fakes/fakeAcpAgent";
import type { FakeContained } from "../fakes/fakeContainer";
import { settled } from "../fakes/settle";

const RATE_LIMIT_FAILURE: ScriptStep = {
  type: "fail",
  code: -32603,
  message: "Rate limit reached",
  data: { errorKind: "rate_limit" },
};

interface AppendHold {
  entered: PromiseWithResolvers<undefined>;
  release: PromiseWithResolvers<undefined>;
}

const appendHooks = vi.hoisted(() => ({
  hold: undefined as AppendHold | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (
      ...args: Parameters<typeof actual.appendFile>
    ): Promise<void> => {
      const hold = appendHooks.hold;
      if (hold !== undefined) {
        appendHooks.hold = undefined;
        hold.entered.resolve(undefined);
        await hold.release.promise;
      }
      await actual.appendFile(...args);
    },
  };
});

afterEach(async () => {
  appendHooks.hold = undefined;
  await closeRigs();
});

function containedOf(rig: BackendRig, index: number): FakeContained {
  const contained = rig.container.contained[index];
  if (contained === undefined) {
    throw new Error(`container ${String(index)} was not spawned`);
  }
  return contained;
}

function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function stoppedBroadcast(rig: BackendRig): Promise<void> {
  await settled(() => {
    const last = rig.broadcastsOf("session/changed").at(-1);
    expect(last).toMatchObject({ phase: { phase: "stopped" } });
  });
  await nextMacrotask();
}

it("dispose_waits_for_in_flight_switch_log_append", async () => {
  const hold: AppendHold = {
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await rig.call("session/start", startParams(rig));
  appendHooks.hold = hold;
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "go",
  });
  await hold.entered.promise;

  const state = { disposed: false };
  const disposing = rig.dispose().then(() => {
    state.disposed = true;
  });
  try {
    await stoppedBroadcast(rig);
    expect(state.disposed).toBe(false);
  } finally {
    hold.release.resolve(undefined);
  }
  await disposing;
  expect(await rig.store.readSwitchLog(10)).toHaveLength(1);
});

it("dispose_waits_for_launch_started_during_close", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  await rig.call("session/start", startParams(rig));
  containedOf(rig, 0).holdStops();
  rig.container.holdStops();
  agentOf(rig).enqueue([RATE_LIMIT_FAILURE]);
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "go",
  });
  await settled(() => {
    expect(containedOf(rig, 0).stopCalls).toHaveLength(1);
  });

  const state = { disposed: false };
  const disposing = rig.dispose().then(() => {
    state.disposed = true;
  });
  try {
    await nextMacrotask();
    containedOf(rig, 0).resolveOldestHeldStop();
    await settled(() => {
      expect(containedOf(rig, 1).stopCalls).toHaveLength(1);
    });
    await stoppedBroadcast(rig);
    expect(state.disposed).toBe(false);
  } finally {
    for (const contained of rig.container.contained) {
      contained.resolveHeldStops();
    }
  }
  await disposing;
});

async function firstSpawnEntered(rig: BackendRig): Promise<void> {
  await settled(() => {
    expect(
      rig.order.filter((entry) => entry.startsWith("spawn:")),
    ).toHaveLength(1);
  });
}

function stopCallCounts(rig: BackendRig): number[] {
  return rig.container.contained.map((contained) => contained.stopCalls.length);
}

async function livePhases(rig: BackendRig): Promise<string[]> {
  const { sessions } = await rig.call("sessions/snapshot", {});
  return sessions
    .filter((session) => session.phase.phase !== "stopped")
    .map((session) => session.phase.phase);
}

const START_STOPPED = {
  code: IpcErrorCode.CONFLICT,
  message: SESSION_START_STOPPED_MESSAGE,
};

it("shutdown_during_initial_start_stops_the_launching_agent", async () => {
  const gate = Promise.withResolvers<undefined>();
  const rig = await openRig({ accounts: [ACCOUNT_A], spawnGate: gate.promise });
  const starting = rig.call("session/start", startParams(rig));
  const outcome = starting.catch((error: unknown) => error);
  await firstSpawnEntered(rig);

  const disposing = rig.dispose();
  gate.resolve(undefined);
  await disposing;

  expect(stopCallCounts(rig)).toEqual([1]);
  expect(await outcome).toMatchObject(START_STOPPED);
  await nextMacrotask();
  expect(await livePhases(rig)).toEqual([]);
});
