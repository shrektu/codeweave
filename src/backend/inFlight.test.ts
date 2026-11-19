import { expect, it } from "vitest";

import { createInFlight } from "./inFlight";

const RESULT = "done";
const FAILURE = new Error("work failed");

function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

it("track_returns_the_work_result_and_forgets_it", async () => {
  const inFlight = createInFlight();
  const gate = Promise.withResolvers<string>();

  const tracked = inFlight.track(() => gate.promise);
  expect(inFlight.size()).toBe(1);
  gate.resolve(RESULT);

  await expect(tracked).resolves.toBe(RESULT);
  expect(inFlight.size()).toBe(0);
});

it("track_propagates_rejection_and_forgets_it", async () => {
  const inFlight = createInFlight();
  const gate = Promise.withResolvers<string>();

  const tracked = inFlight.track(() => gate.promise);
  expect(inFlight.size()).toBe(1);
  gate.reject(FAILURE);

  await expect(tracked).rejects.toBe(FAILURE);
  expect(inFlight.size()).toBe(0);
});

it("settled_waits_for_tracked_work", async () => {
  const inFlight = createInFlight();
  const gate = Promise.withResolvers<undefined>();
  const state = { settled: false };

  const tracked = inFlight.track(() => gate.promise);
  const waiting = inFlight.settled().then(() => {
    state.settled = true;
  });
  await nextMacrotask();
  expect(state.settled).toBe(false);

  gate.resolve(undefined);
  await tracked;
  await waiting;
  expect(state.settled).toBe(true);
});

it("settled_resolves_when_tracked_work_rejects", async () => {
  const inFlight = createInFlight();
  const gate = Promise.withResolvers<undefined>();

  const tracked = inFlight.track(() => gate.promise);
  const handled = expect(tracked).rejects.toBe(FAILURE);
  const waiting = inFlight.settled();
  gate.reject(FAILURE);

  await expect(waiting).resolves.toBeUndefined();
  await handled;
});

it("settled_ignores_work_tracked_after_the_call", async () => {
  const inFlight = createInFlight();
  const early = Promise.withResolvers<undefined>();
  const late = Promise.withResolvers<undefined>();
  const state = { settled: false };

  const first = inFlight.track(() => early.promise);
  const waiting = inFlight.settled().then(() => {
    state.settled = true;
  });
  const second = inFlight.track(() => late.promise);
  early.resolve(undefined);
  await first;
  await waiting;

  expect(state.settled).toBe(true);
  expect(inFlight.size()).toBe(1);
  late.resolve(undefined);
  await second;
});
