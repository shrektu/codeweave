import { expect, it } from "vitest";

import { createSerializer } from "./serialize";

it("serializer_continues_after_rejected_task", async () => {
  const serialized = createSerializer();
  const failure = new Error("boom");

  const first = serialized(() => Promise.reject(failure));
  const second = serialized(() => Promise.resolve("next"));

  await expect(first).rejects.toBe(failure);
  await expect(second).resolves.toBe("next");
});

it("serializer_runs_tasks_one_at_a_time_in_call_order", async () => {
  const serialized = createSerializer();
  const events: string[] = [];
  const gate = Promise.withResolvers<undefined>();

  const slow = serialized(async () => {
    events.push("slow:start");
    await gate.promise;
    events.push("slow:end");
  });
  const fast = serialized(() => {
    events.push("fast");
    return Promise.resolve();
  });
  await Promise.resolve();
  expect(events).toEqual(["slow:start"]);
  gate.resolve(undefined);
  await Promise.all([slow, fast]);

  expect(events).toEqual(["slow:start", "slow:end", "fast"]);
});
