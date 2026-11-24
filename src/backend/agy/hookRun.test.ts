import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runHook, type HookRunDeps } from "./hookRun";

const drive = vi.hoisted(() => ({ alias: "", real: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const resolved = (path: string): string =>
    drive.alias !== "" && path.startsWith(drive.alias)
      ? `${drive.real}${path.slice(drive.alias.length)}`
      : path;
  return {
    ...actual,
    lstat: (path: string) => actual.lstat(resolved(path)),
    realpath: (path: string) => actual.realpath(resolved(path)),
    open: (path: string, flags: number) => actual.open(resolved(path), flags),
  };
});

const WORKTREE = "/work/repo";
const SCOPE_ENV = {
  CODEWEAVE_AGY_HOME: "/home/u",
  CODEWEAVE_AGY_PROTECTED: '["/home/u/.ssh"]',
};
const VALID_ENV = {
  CODEWEAVE_AGY_PROFILE: "unattended",
  CODEWEAVE_AGY_WORKTREE: WORKTREE,
  ...SCOPE_ENV,
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

const ALLOW_LINE = '{"decision":"allow"}\n';
const SEED_TEXT = "before\n";

let root = "";
let snapDir = "";

function envFor(profile: string, withSnapshot = true): HookRunDeps["env"] {
  return {
    CODEWEAVE_AGY_PROFILE: profile,
    CODEWEAVE_AGY_WORKTREE: root,
    ...SCOPE_ENV,
    ...(withSnapshot ? { CODEWEAVE_AGY_SNAPSHOT_DIR: snapDir } : {}),
  };
}

function toolPayload(
  name: string,
  path: string,
  ids: Readonly<Record<string, unknown>> = {
    conversationId: "conv-1",
    stepIdx: 2,
  },
): string {
  return JSON.stringify({
    ...ids,
    toolCall: { name, args: { Path: path } },
    workspacePaths: [root],
  });
}

function runWith(input: string, env: HookRunDeps["env"]): Promise<string[]> {
  return lines(() => Promise.resolve(input), env);
}

function useHookDirs(): void {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agy-hook-root-")));
    snapDir = await mkdtemp(join(tmpdir(), "agy-hook-snap-"));
    await writeFile(join(root, "a.txt"), SEED_TEXT);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    drive.alias = "";
    drive.real = "";
    await Promise.all(
      [root, snapDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
}

describe("agy hook before-snapshots", () => {
  useHookDirs();

  it("allowed_edit_writes_before_snapshot", async () => {
    const path = join(root, "a.txt");
    const listedAtWrite: string[][] = [];

    await runHook({
      readInput: () => Promise.resolve(toolPayload("edit_file", path)),
      env: envFor("accept-edits"),
      write: () => {
        listedAtWrite.push(readdirSync(snapDir));
      },
    });

    expect(listedAtWrite).toEqual([["conv-1~2.json"]]);
    expect(
      JSON.parse(await readFile(join(snapDir, "conv-1~2.json"), "utf8")),
    ).toEqual({
      entries: [{ path, snapshot: { kind: "text", text: SEED_TEXT } }],
    });
  });

  it("aliased_worktree_root_still_records_before_snapshot", async () => {
    drive.alias = join(tmpdir(), "agy-hook-alias-drive");
    drive.real = root;
    const path = join(drive.alias, "a.txt");
    const payload = JSON.stringify({
      conversationId: "conv-1",
      stepIdx: 2,
      toolCall: { name: "edit_file", args: { Path: path } },
      workspacePaths: [drive.alias],
    });

    const written = await runWith(payload, {
      ...envFor("accept-edits"),
      CODEWEAVE_AGY_WORKTREE: drive.alias,
    });

    expect(written).toEqual([ALLOW_LINE]);
    expect(
      JSON.parse(await readFile(join(snapDir, "conv-1~2.json"), "utf8")),
    ).toEqual({
      entries: [{ path, snapshot: { kind: "text", text: SEED_TEXT } }],
    });
  });

  it("denied_edit_writes_nothing", async () => {
    const written = await runWith(
      toolPayload("edit_file", join(root, "a.txt")),
      envFor("ask"),
    );

    expect(JSON.parse(written[0] ?? "")).toMatchObject({ decision: "deny" });
    expect(await readdir(snapDir)).toEqual([]);
  });

  it("read_tool_writes_nothing", async () => {
    const written = await runWith(
      toolPayload("read_file", join(root, "a.txt")),
      envFor("accept-edits"),
    );

    expect(written).toEqual([ALLOW_LINE]);
    expect(await readdir(snapDir)).toEqual([]);
  });

  it.each([undefined, "", "relative/dir"])(
    "missing_snapshot_env_%s_keeps_decision",
    async (dir) => {
      const written = await runWith(
        toolPayload("edit_file", join(root, "a.txt")),
        { ...envFor("accept-edits", false), CODEWEAVE_AGY_SNAPSHOT_DIR: dir },
      );

      expect(written).toEqual([ALLOW_LINE]);
      expect(await readdir(snapDir)).toEqual([]);
    },
  );
});

describe("agy hook snapshot failure modes", () => {
  useHookDirs();

  it("payload_without_step_ids_writes_nothing", async () => {
    const written = await runWith(
      toolPayload("edit_file", join(root, "a.txt"), {}),
      envFor("accept-edits"),
    );

    expect(written).toEqual([ALLOW_LINE]);
    expect(await readdir(snapDir)).toEqual([]);
  });

  it("snapshot_write_failure_keeps_allow_decision", async () => {
    await rm(snapDir, { recursive: true, force: true });

    const written = await runWith(
      toolPayload("edit_file", join(root, "a.txt")),
      envFor("accept-edits"),
    );

    expect(written).toEqual([ALLOW_LINE]);
    expect(console.error).toHaveBeenCalledWith(
      "agy diff snapshot failed",
      expect.any(Error),
    );
  });

  it.skipIf(process.platform === "win32")(
    "fifo_edit_keeps_hook_fast",
    async () => {
      const fifo = join(root, "pipe");
      execFileSync("mkfifo", [fifo]);

      const written = await runWith(
        toolPayload("edit_file", fifo),
        envFor("accept-edits"),
      );

      expect(written).toEqual([ALLOW_LINE]);
      expect(
        JSON.parse(await readFile(join(snapDir, "conv-1~2.json"), "utf8")),
      ).toEqual({
        entries: [{ path: fifo, snapshot: { kind: "binary" } }],
      });
    },
    2000,
  );
});

describe("agy hook decisions with the snapshot env", () => {
  useHookDirs();

  const cases: readonly {
    readonly name: string;
    readonly profile: string;
    readonly input: () => string;
  }[] = [
    {
      name: "allowed_edit",
      profile: "accept-edits",
      input: () => toolPayload("edit_file", join(root, "a.txt")),
    },
    {
      name: "asked_edit",
      profile: "ask",
      input: () => toolPayload("edit_file", join(root, "a.txt")),
    },
    {
      name: "edit_outside_under_unattended",
      profile: "unattended",
      input: () => toolPayload("write_file", join(root, "..", "elsewhere.txt")),
    },
    {
      name: "agents_dir_edit",
      profile: "accept-edits",
      input: () => toolPayload("edit_file", join(root, ".agents", "x.md")),
    },
    {
      name: "read",
      profile: "ask",
      input: () => toolPayload("read_file", join(root, "a.txt")),
    },
    { name: "garbage", profile: "accept-edits", input: () => "not json" },
    {
      name: "unknown_profile",
      profile: "root",
      input: () => toolPayload("edit_file", join(root, "a.txt")),
    },
    {
      name: "plan_edit",
      profile: "plan",
      input: () => toolPayload("write_file", join(root, "b.txt")),
    },
  ];

  it.each(cases)(
    "decision_output_identical_with_snapshot_env_$name",
    async ({ profile, input }) => {
      const without = await runWith(input(), envFor(profile, false));
      const withSnapshot = await runWith(input(), envFor(profile));

      expect(withSnapshot).toEqual(without);
    },
  );
});
