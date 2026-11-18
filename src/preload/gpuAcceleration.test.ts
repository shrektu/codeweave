import { afterEach, expect, it, vi } from "vitest";

import {
  createGpuAccelerationState,
  type GpuAccelerationFeed,
} from "./gpuAcceleration";

interface FakeFeed extends GpuAccelerationFeed {
  push(payload: unknown): void;
  answer(payload: unknown): void;
  fail(error: Error): void;
}

function createFeed(): FakeFeed {
  const answer = Promise.withResolvers<unknown>();
  let handler: (payload: unknown) => void = () => undefined;
  return {
    fetch: () => answer.promise,
    subscribe(next): void {
      handler = next;
    },
    push(payload): void {
      handler(payload);
    },
    answer(payload): void {
      answer.resolve(payload);
    },
    fail(error): void {
      answer.reject(error);
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("is_not_accelerated_before_main_answers", () => {
  const state = createGpuAccelerationState(createFeed());

  expect(state.current()).toBe(false);
});

it("adopts_state_fetched_at_load", async () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);

  feed.answer(true);
  await settle();

  expect(state.current()).toBe(true);
});

it("notifies_listeners_on_pushed_change", () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);
  const seen: boolean[] = [];
  state.onChanged((accelerated) => {
    seen.push(accelerated);
  });

  feed.push(true);
  feed.push(false);

  expect(seen).toEqual([true, false]);
  expect(state.current()).toBe(false);
});

it("pushed_state_wins_over_stale_fetch", async () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);

  feed.push(true);
  feed.answer(false);
  await settle();

  expect(state.current()).toBe(true);
});

it("treats_non_boolean_payload_as_not_accelerated", () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);
  feed.push(true);

  feed.push("true");

  expect(state.current()).toBe(false);
});

it("stays_not_accelerated_when_fetch_fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);
  const failure = new Error("ipc closed");

  feed.fail(failure);
  await settle();

  expect(state.current()).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
});

it("does_not_notify_when_state_is_unchanged", () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);
  const seen: boolean[] = [];
  state.onChanged((accelerated) => {
    seen.push(accelerated);
  });

  feed.push(false);
  feed.push(true);
  feed.push(true);

  expect(seen).toEqual([true]);
});

it("stops_notifying_after_unsubscribe", () => {
  const feed = createFeed();
  const state = createGpuAccelerationState(feed);
  const seen: boolean[] = [];
  const unsubscribe = state.onChanged((accelerated) => {
    seen.push(accelerated);
  });

  unsubscribe();
  feed.push(true);

  expect(seen).toEqual([]);
});
