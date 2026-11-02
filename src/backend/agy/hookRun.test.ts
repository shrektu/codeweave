import { afterEach, describe, expect, it, vi } from "vitest";

import { runHook, type HookRunDeps } from "./hookRun";

const WORKTREE = "/work/repo";
const VALID_ENV = {
  CODEWEAVE_AGY_PROFILE: "unattended",
  CODEWEAVE_AGY_WORKTREE: WORKTREE,
};
const READ_PAYLOAD = JSON.stringify({
  toolCall: { name: "read_file", args: { Path: "/work/repo/a.txt" } },
  workspacePaths: [WORKTREE],
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function lines(
  readInput: HookRunDeps["readInput"],
  env: HookRunDeps["env"] = VALID_ENV,
): Promise<string[]> {
  const written: string[] = [];
  await runHook({
    readInput,
    env,
    write: (line) => {
      written.push(line);
    },
  });
  return written;
}

describe("agy hook run", () => {
  it("allowed_call_prints_one_allow_line", async () => {
    expect(await lines(() => Promise.resolve(READ_PAYLOAD))).toEqual([
      '{"decision":"allow"}\n',
    ]);
  });

  it("hook_never_prints_empty_output_when_reading_stdin_throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const written = await lines(() => Promise.reject(new Error("EPIPE")));

    expect(written).toEqual([
      '{"decision":"deny","reason":"Codeweave policy hook failed; denied"}\n',
    ]);
  });

  it("hook_never_prints_empty_output_when_the_policy_throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
    });
    const env = { ...VALID_ENV, CODEWEAVE_AGY_WORKTREE: "/work/repo" };
    Object.defineProperty(env, "CODEWEAVE_AGY_PROFILE", {
      get: (): string => {
        throw new Error("env exploded");
      },
    });

    const written = await lines(() => Promise.resolve(hostile), env);

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toMatchObject({ decision: "deny" });
  });

  it.each([undefined, "", "root", "BYPASS"])(
    "unknown_profile_%s_is_denied_for_a_harmless_read",
    async (profile) => {
      const written = await lines(() => Promise.resolve(READ_PAYLOAD), {
        ...VALID_ENV,
        CODEWEAVE_AGY_PROFILE: profile,
      });

      expect(written).toEqual([
        '{"decision":"deny","reason":"Codeweave permission profile is missing or unknown; denied"}\n',
      ]);
    },
  );
});

describe("agy hook run input validation", () => {
  it.each([undefined, ""])("missing_worktree_%s_is_denied", async (root) => {
    const written = await lines(() => Promise.resolve(READ_PAYLOAD), {
      ...VALID_ENV,
      CODEWEAVE_AGY_WORKTREE: root,
    });

    expect(JSON.parse(written[0] ?? "")).toMatchObject({ decision: "deny" });
  });

  it.each(["", "not json", "[]", '{"toolCall":{}}', '{"toolCall":{"name":3}}'])(
    "malformed_input_%s_is_denied",
    async (input) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(await lines(() => Promise.resolve(input))).toEqual([
        '{"decision":"deny","reason":"Codeweave could not read the tool call; denied"}\n',
      ]);
    },
  );

  it("camel_case_payload_with_extra_keys_is_accepted", async () => {
    const payload = JSON.stringify({
      artifactDirectoryPath: "/tmp/a",
      conversationId: "c",
      stepIdx: 3,
      toolCall: { name: "list_dir", args: { Path: "/work/repo" }, extra: 1 },
      workspacePaths: [WORKTREE],
    });

    expect(await lines(() => Promise.resolve(payload))).toEqual([
      '{"decision":"allow"}\n',
    ]);
  });
});
