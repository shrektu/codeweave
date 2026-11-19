import { expect, it } from "vitest";

import { killTreeWith, type RunCommand } from "./processHelpers";

const PID = 6940;
const LISTED = `"node.exe","${String(PID)}","Console","1","10,000 K"\r\n`;
const NOT_LISTED =
  "INFO: No tasks are running which match the specified criteria.\r\n";
const SHORT_BUDGET_MS = 150;
const LONG_BUDGET_MS = 1000;

interface FakeRun {
  readonly run: RunCommand;
  readonly calls: string[];
}

function fakeRun(
  taskkill: Error | null,
  tasklistOutputs: readonly string[],
): FakeRun {
  const calls: string[] = [];
  let tasklistCalls = 0;
  const run: RunCommand = (file) => {
    calls.push(file);
    if (file === "taskkill") {
      return taskkill === null
        ? Promise.resolve({ stdout: "SUCCESS" })
        : Promise.reject(taskkill);
    }
    const index = Math.min(tasklistCalls, tasklistOutputs.length - 1);
    tasklistCalls += 1;
    return Promise.resolve({ stdout: tasklistOutputs[index] ?? "" });
  };
  return { run, calls };
}

it("kill_tree_tolerates_process_that_exits_during_taskkill", async () => {
  const failure = new Error(
    "Command failed: taskkill /F /T /PID 6940 ERROR: There is no running instance of the task.",
  );
  const fake = fakeRun(failure, [LISTED, LISTED, NOT_LISTED]);

  await expect(
    killTreeWith(PID, { run: fake.run, timeoutMs: LONG_BUDGET_MS }),
  ).resolves.toBeUndefined();
});

it("kill_tree_rethrows_taskkill_error_when_process_stays_alive", async () => {
  const failure = new Error("Command failed: taskkill /F /T /PID 6940");
  const fake = fakeRun(failure, [LISTED]);

  await expect(
    killTreeWith(PID, { run: fake.run, timeoutMs: SHORT_BUDGET_MS }),
  ).rejects.toBe(failure);
});

it("kill_tree_resolves_when_taskkill_succeeds", async () => {
  const fake = fakeRun(null, [LISTED]);

  await expect(
    killTreeWith(PID, { run: fake.run, timeoutMs: LONG_BUDGET_MS }),
  ).resolves.toBeUndefined();

  expect(fake.calls).toEqual(["taskkill"]);
});
