import { describe, expect, it, vi } from "vitest";

import type { ExecText } from "../exec";

import { OpencodeGeneration } from "./constants";
import {
  UnsupportedOpencodeVersionError,
  createVersionProbe,
  formatOpencodeVersion,
  generationOf,
  parseOpencodeVersion,
  type GenerationProbeOptions,
} from "./version";

const HINT =
  "Codeweave works with opencode 1.19.x (npm i -g opencode-ai@1.19.5) or 2.2.5 and newer (npm i -g @opencode/cli).";
const OPTIONS: GenerationProbeOptions = {
  env: { HOME: "/acct/home" },
  cwd: "/work/session",
};
const EXECUTABLE = "/usr/bin/opencode";
const COLOURED_VERSION_OUTPUT =
  "\u001b[1mopencode\u001b[0m \u001b[2mv\u001b[0m\u001b[1m2.3.2\u001b[0m\n";

describe("parseOpencodeVersion", () => {
  it.each([
    ["1.19.5\n", { major: 1, minor: 19, patch: 5 }],
    ["opencode v2.3.2\n", { major: 2, minor: 3, patch: 2 }],
    ["opencode v2.2.5-beta.1", { major: 2, minor: 2, patch: 5 }],
    ["\n\n  1.19.5\n", { major: 1, minor: 19, patch: 5 }],
    ["v1.19.5", { major: 1, minor: 19, patch: 5 }],
  ])("reads_%j", (stdout, expected) => {
    expect(parseOpencodeVersion(stdout)).toEqual(expected);
  });

  it("reads_a_version_printed_in_colour", () => {
    expect(parseOpencodeVersion(COLOURED_VERSION_OUTPUT)).toEqual({
      major: 2,
      minor: 3,
      patch: 2,
    });
  });

  it.each(["", "garbage", "v2", "1.19", "opencode"])("rejects_%j", (stdout) => {
    expect(parseOpencodeVersion(stdout)).toBeNull();
  });
});

describe("formatOpencodeVersion", () => {
  it("joins_the_three_numbers_with_dots", () => {
    expect(formatOpencodeVersion({ major: 2, minor: 3, patch: 2 })).toBe(
      "2.3.2",
    );
  });
});

describe("generationOf", () => {
  it.each([
    [1, 19, 5],
    [1, 0, 0],
  ])("maps_%i.%i.%i_to_v1", (major, minor, patch) => {
    expect(generationOf({ major, minor, patch })).toBe(OpencodeGeneration.v1);
  });

  it.each([
    [2, 2, 5],
    [2, 3, 2],
    [2, 10, 0],
    [2, 2, 10],
  ])("maps_%i.%i.%i_to_v2", (major, minor, patch) => {
    expect(generationOf({ major, minor, patch })).toBe(OpencodeGeneration.v2);
  });

  it.each([
    [0, 9, 0],
    [2, 0, 0],
    [2, 1, 9],
    [2, 2, 4],
    [3, 0, 0],
  ])("rejects_%i.%i.%i", (major, minor, patch) => {
    expect(generationOf({ major, minor, patch })).toBeNull();
  });
});

function printing(...outputs: string[]): ReturnType<typeof vi.fn<ExecText>> {
  const exec = vi.fn<ExecText>();
  for (const output of outputs) {
    exec.mockResolvedValueOnce(output);
  }
  return exec;
}

function probeOf(exec: ExecText): ReturnType<typeof createVersionProbe> {
  return createVersionProbe({ exec, platform: "linux" });
}

describe("createVersionProbe", () => {
  it("rejects_old_2x_and_3x_with_the_unsupported_message", async () => {
    await expect(
      probeOf(printing("opencode v2.2.4\n"))(EXECUTABLE, OPTIONS),
    ).rejects.toThrow(`OpenCode 2.2.4 is not supported. ${HINT}`);
    await expect(
      probeOf(printing("3.0.0\n"))(EXECUTABLE, OPTIONS),
    ).rejects.toThrow(`OpenCode 3.0.0 is not supported. ${HINT}`);
  });

  it("accepts_2x_from_2_2_5_as_v2", async () => {
    const generation = await probeOf(printing("opencode v2.2.5\n"))(
      EXECUTABLE,
      OPTIONS,
    );

    expect(generation).toBe(OpencodeGeneration.v2);
  });

  it("reports_an_undetectable_version_when_exec_rejects", async () => {
    const cause = new Error("timed out");
    const exec = vi.fn<ExecText>(() => Promise.reject(cause));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failure: unknown = await probeOf(exec)(EXECUTABLE, OPTIONS).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UnsupportedOpencodeVersionError);
    expect(failure).toMatchObject({
      message: `The OpenCode version could not be determined. ${HINT}`,
      cause,
    });
  });

  it("reports_an_undetectable_version_for_unparsable_output", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      probeOf(printing("garbage\n"))(EXECUTABLE, OPTIONS),
    ).rejects.toThrow(`The OpenCode version could not be determined. ${HINT}`);
  });
});

describe("createVersionProbe command", () => {
  it("runs_the_version_command_with_the_env_and_a_timeout", async () => {
    const exec = printing("1.19.5\n");

    const generation = await probeOf(exec)(EXECUTABLE, OPTIONS);

    expect(generation).toBe(OpencodeGeneration.v1);
    expect(exec).toHaveBeenCalledExactlyOnceWith(EXECUTABLE, ["--version"], {
      timeoutMs: 10_000,
      env: OPTIONS.env,
      cwd: OPTIONS.cwd,
    });
  });

  it("runs_a_windows_shim_through_comspec_verbatim", async () => {
    const exec = printing("1.19.5\n");
    const probe = createVersionProbe({
      exec,
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
    });

    await probe("C:\\tools\\opencode.cmd", OPTIONS);

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", '""C:\\tools\\opencode.cmd" --version"'],
      {
        timeoutMs: 10_000,
        env: OPTIONS.env,
        cwd: OPTIONS.cwd,
        windowsVerbatimArguments: true,
      },
    );
  });

  it("runs_the_version_command_in_the_given_directory", async () => {
    const exec = printing("1.19.5\n");

    await probeOf(exec)(EXECUTABLE, { env: OPTIONS.env, cwd: "/other/dir" });

    expect(exec.mock.calls[0]?.[2]).toMatchObject({ cwd: "/other/dir" });
  });

  it.each([
    ["opencode v2.2.5\n", true],
    ["opencode v2.3.1\n", true],
    ["opencode v2.3.2\n", false],
    ["opencode v2.10.0\n", false],
    ["1.19.5\n", false],
  ])("requiring_mcp_tools_on_%j_refuses_%s", async (stdout, refused) => {
    const probe = probeOf(printing(stdout));

    const outcome = probe(EXECUTABLE, { ...OPTIONS, requireMcpTools: true });

    if (refused) {
      await expect(outcome).rejects.toThrow(
        "Orchestrate needs OpenCode 2.3.2 or newer",
      );
    } else {
      await expect(outcome).resolves.toBeDefined();
    }
  });

  it("not_requiring_mcp_tools_accepts_2.2.5", async () => {
    const probe = probeOf(printing("opencode v2.2.5\n"));

    await expect(
      probe(EXECUTABLE, { ...OPTIONS, requireMcpTools: false }),
    ).resolves.toBe(OpencodeGeneration.v2);
  });

  it("sees_an_in_place_upgrade_on_the_next_probe", async () => {
    const probe = probeOf(printing("1.19.5\n", "opencode v2.1.0\n"));

    const first = await probe(EXECUTABLE, OPTIONS);

    expect(first).toBe(OpencodeGeneration.v1);
    await expect(probe(EXECUTABLE, OPTIONS)).rejects.toThrow(
      `OpenCode 2.1.0 is not supported. ${HINT}`,
    );
  });
});
