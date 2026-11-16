import { expect, it } from "vitest";

import { KeyedMutex } from "./keyedMutex";

const FIRST_KEY = "a";
const SECOND_KEY = "b";

it("keyed_mutex_runs_same_key_tasks_one_at_a_time", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  const gate = Promise.withResolvers<undefined>();

  const first = mutex.run(FIRST_KEY, async () => {
    events.push("first:start");
    await gate.promise;
    events.push("first:end");
  });
  const second = mutex.run(FIRST_KEY, () => {
    events.push("second:start");
    return Promise.resolve();
  });
  await Promise.resolve();
  events.push("gate:open");
  gate.resolve(undefined);
  await Promise.all([first, second]);

  expect(events).toEqual([
    "first:start",
    "gate:open",
    "first:end",
    "second:start",
  ]);
});

it("keyed_mutex_does_not_block_other_keys", async () => {
  const mutex = new KeyedMutex();
  const gate = Promise.withResolvers<undefined>();
  const blocked = mutex.run(FIRST_KEY, () => gate.promise);

  const other = await mutex.run(SECOND_KEY, () => Promise.resolve("done"));
  gate.resolve(undefined);
  await blocked;

  expect(other).toBe("done");
});

it("keyed_mutex_releases_after_a_failed_task", async () => {
  const mutex = new KeyedMutex();

  await expect(
    mutex.run(FIRST_KEY, () => Promise.reject(new Error("boom"))),
  ).rejects.toThrow("boom");
  const next = await mutex.run(FIRST_KEY, () => Promise.resolve("ran"));

  expect(next).toBe("ran");
});
