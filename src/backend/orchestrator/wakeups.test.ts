import { afterEach, expect, it, vi } from "vitest";

import { FlowRunStatus } from "../../domain/flowRun";
import type { FlowReportEntry } from "../../domain/orchestratorReport";
import { IpcError, IpcErrorCode } from "../../shared/protocol";
import { SAMPLE_RUN } from "../../../tests/fakes/fakeFlowControl";

import { createWakeupQueue, type WakeupQueueDeps } from "./wakeups";

type FakeSession = WakeupQueueDeps["session"];

interface Rig {
  readonly session: FakeSession;
  readonly prompts: string[];
  readonly state: { settled: boolean };
  readonly changeView: () => void;
}

function entry(runId: string, status: FlowRunStatus): FlowReportEntry {
  return { view: { ...SAMPLE_RUN, runId, status }, note: null };
}

function describeEntries(entries: readonly FlowReportEntry[]): string {
  return entries.map(({ view }) => `${view.runId}:${view.status}`).join(",");
}

function rigWith(
  prompt: (text: string) => Promise<void> = () => Promise.resolve(),
): Rig {
  const listeners = new Set<() => void>();
  const prompts: string[] = [];
  const state = { settled: true };
  const session: FakeSession = {
    isSettled: () => state.settled,
    prompt: (text) => {
      prompts.push(text);
      return prompt(text);
    },
    onViewChanged: (listener) => {
      const wrapped = (): void => {
        listener(null);
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
  return {
    session,
    prompts,
    state,
    changeView: () => {
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("delivers_one_prompt_for_a_report_on_a_settled_session", () => {
  const rig = rigWith();
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });

  queue.enqueue(entry("run-1", FlowRunStatus.done));

  expect(rig.prompts).toEqual(["run-1:done"]);
});

it("keeps_a_report_queued_when_prompt_is_rejected_busy_and_delivers_it_on_the_next_view_change", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let rejectNext = true;
  const rig = rigWith(() => {
    if (rejectNext) {
      rejectNext = false;
      return Promise.reject(
        new IpcError(IpcErrorCode.SESSION_BUSY, "The session is busy"),
      );
    }
    return Promise.resolve();
  });
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });

  queue.enqueue(entry("run-1", FlowRunStatus.awaitingDecision));
  await vi.waitFor(() => {
    expect(rig.prompts).toHaveLength(1);
  });
  rig.changeView();

  await vi.waitFor(() => {
    expect(rig.prompts).toEqual([
      "run-1:awaiting_decision",
      "run-1:awaiting_decision",
    ]);
  });
  rig.changeView();
  expect(rig.prompts).toHaveLength(2);
});

it("keeps_the_newer_state_when_a_rejected_prompt_is_restored", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const first = Promise.withResolvers<undefined>();
  let calls = 0;
  const rig = rigWith(async () => {
    calls += 1;
    if (calls === 1) {
      await first.promise;
      throw new IpcError(IpcErrorCode.SESSION_BUSY, "busy");
    }
  });
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });

  queue.enqueue(entry("run-1", FlowRunStatus.awaitingDecision));
  queue.enqueue(entry("run-1", FlowRunStatus.done));
  first.resolve(undefined);
  await vi.waitFor(() => {
    rig.changeView();
    expect(rig.prompts).toHaveLength(2);
  });

  expect(rig.prompts).toEqual(["run-1:awaiting_decision", "run-1:done"]);
});

it("coalesces_two_states_of_one_run_into_the_latest", () => {
  const rig = rigWith();
  rig.state.settled = false;
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });

  queue.enqueue(entry("run-1", FlowRunStatus.awaitingDecision));
  queue.enqueue(entry("run-2", FlowRunStatus.done));
  queue.enqueue(entry("run-1", FlowRunStatus.done));
  expect(rig.prompts).toEqual([]);
  rig.state.settled = true;
  rig.changeView();

  expect(rig.prompts).toEqual(["run-1:done,run-2:done"]);
});

it("delivers_nothing_after_dispose", () => {
  const rig = rigWith();
  rig.state.settled = false;
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });
  queue.enqueue(entry("run-1", FlowRunStatus.done));

  queue.dispose();
  rig.state.settled = true;
  rig.changeView();
  queue.enqueue(entry("run-2", FlowRunStatus.done));

  expect(rig.prompts).toEqual([]);
});

it("does_not_start_a_second_flush_while_one_is_in_flight", async () => {
  const inFlight = Promise.withResolvers<undefined>();
  const rig = rigWith(() => inFlight.promise);
  const queue = createWakeupQueue({
    session: rig.session,
    build: describeEntries,
  });

  queue.enqueue(entry("run-1", FlowRunStatus.done));
  queue.enqueue(entry("run-2", FlowRunStatus.done));
  rig.changeView();

  expect(rig.prompts).toEqual(["run-1:done"]);
  inFlight.resolve(undefined);
  await vi.waitFor(() => {
    rig.changeView();
    expect(rig.prompts).toEqual(["run-1:done", "run-2:done"]);
  });
});
