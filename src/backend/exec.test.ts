import { describe, expect, it } from "vitest";

import { execText } from "./exec";

const SLOW_SCRIPT = "setTimeout(() => {}, 2000)";
const SHORT_TIMEOUT_MS = 100;
const SLOW_ELAPSED_MS = 1500;

describe("execText", () => {
  it("returns_stdout_of_a_finished_command", async () => {
    expect(await execText(process.execPath, ["-e", "console.log('hi')"])).toBe(
      "hi\n",
    );
  });

  it("exec_passes_extra_env_on_top_of_the_process_env", async () => {
    process.env.CODEWEAVE_EXEC_INHERITED = "from-parent";
    try {
      const stdout = await execText(
        process.execPath,
        [
          "-e",
          "console.log(process.env.CODEWEAVE_EXEC_INHERITED, process.env.CODEWEAVE_EXEC_EXTRA)",
        ],
        { env: { CODEWEAVE_EXEC_EXTRA: "from-options" } },
      );

      expect(stdout).toBe("from-parent from-options\n");
    } finally {
      delete process.env.CODEWEAVE_EXEC_INHERITED;
    }
  });

  it("exec_timeout_kills_the_hanging_child", async () => {
    const startedAt = Date.now();

    await expect(
      execText(process.execPath, ["-e", SLOW_SCRIPT], {
        timeoutMs: SHORT_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({ killed: true });

    expect(Date.now() - startedAt).toBeLessThan(SLOW_ELAPSED_MS);
  });
});
