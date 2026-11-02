import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { writeAgyHookConfig } from "../../src/backend/agy/hookConfig";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const HOOK_SOURCE = join(REPO_ROOT, "src", "backend", "agy", "hook.ts");
const BUNDLE_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 20_000;
const WORKTREE = "/work/repo";
const NEEDS_APPROVAL =
  "needs approval; Codeweave cannot ask in agy headless mode";
const METACHARACTER_DIR = "we ird'q\"d$e`f";
const HooksFileSchema = z.object({
  codeweave: z.object({
    PreToolUse: z.array(
      z.object({ hooks: z.array(z.object({ command: z.string() })) }),
    ),
  }),
});

interface HookRun {
  readonly stdout: string;
  readonly code: number | null;
}

let scratch = "";
let bundle = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "codeweave-agy-hook-"));
  await build({
    configFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: HOOK_SOURCE,
      outDir: join(scratch, "bundle"),
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        output: { format: "es", entryFileNames: "agyHook.mjs" },
      },
    },
  });
  bundle = join(scratch, "bundle", "agyHook.mjs");
}, BUNDLE_TIMEOUT_MS);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function payload(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    conversationId: "conv-1",
    stepIdx: 2,
    toolCall: { name, args },
    workspacePaths: [WORKTREE],
  });
}

function run(
  command: string,
  args: readonly string[],
  stdin: string | null,
  env: Record<string, string>,
): Promise<HookRun> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({ stdout, code });
    });
    if (stdin !== null) {
      child.stdin?.end(stdin);
    }
  });
}

function runHook(
  stdin: string | null,
  profile: string | null,
  worktree: string | null = WORKTREE,
): Promise<HookRun> {
  return run(process.execPath, [bundle], stdin, {
    ...(profile === null ? {} : { CODEWEAVE_AGY_PROFILE: profile }),
    ...(worktree === null ? {} : { CODEWEAVE_AGY_WORKTREE: worktree }),
  });
}

function decisionOf(result: HookRun): unknown {
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(1);
  expect(result.stdout.endsWith("\n")).toBe(true);
  return JSON.parse(lines[0] ?? "");
}

describe("agy hook entry as a child process", () => {
  it(
    "allows_a_read_only_command_under_unattended",
    async () => {
      const result = await runHook(
        payload("run_command", { CommandLine: "git status --short" }),
        "unattended",
      );

      expect(result.code).toBe(0);
      expect(decisionOf(result)).toEqual({ decision: "allow" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "denies_a_privileged_command_with_a_reason",
    async () => {
      const result = await runHook(
        payload("run_command", { CommandLine: "env sudo ls" }),
        "unattended",
      );

      expect(result.code).toBe(0);
      expect(decisionOf(result)).toEqual({
        decision: "deny",
        reason: expect.stringMatching(/\S/) as unknown,
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "maps_ask_to_deny_with_the_headless_reason",
    async () => {
      const result = await runHook(
        payload("write_file", { Path: `${WORKTREE}/a.txt` }),
        "ask",
      );

      expect(decisionOf(result)).toEqual({
        decision: "deny",
        reason: NEEDS_APPROVAL,
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("agy hook entry fail-closed inputs", () => {
  it(
    "malformed_stdin_is_denied_not_empty",
    async () => {
      const result = await runHook("{not json", "bypass");

      expect(result.code).toBe(0);
      expect(decisionOf(result)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "closed_stdin_is_denied_not_empty",
    async () => {
      const result = await runHook(null, "bypass");

      expect(decisionOf(result)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "unknown_profile_is_denied_even_for_a_harmless_tool",
    async () => {
      const harmless = payload("read_file", { Path: `${WORKTREE}/a.txt` });

      for (const profile of ["root", "", null]) {
        const result = await runHook(harmless, profile);

        expect(decisionOf(result)).toMatchObject({ decision: "deny" });
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "missing_worktree_is_denied",
    async () => {
      const result = await runHook(
        payload("read_file", { Path: "a.txt" }),
        "bypass",
        null,
      );

      expect(decisionOf(result)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("agy hook tamper protection", () => {
  it(
    "hook_config_edit_is_denied_for_a_file_write_and_a_redirect",
    async () => {
      const hooksJson = join(scratch, "account", "config", "hooks.json");

      const write = await runHook(
        payload("write_file", { Path: hooksJson }),
        "unattended",
      );
      const redirect = await runHook(
        payload("run_command", { CommandLine: `echo x > ${hooksJson}` }),
        "unattended",
      );

      expect(decisionOf(write)).toMatchObject({ decision: "deny" });
      expect(decisionOf(redirect)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("agy hook run_command working directory", () => {
  it(
    "run_command_cwd_outside_worktree_is_judged_there",
    async () => {
      const result = await runHook(
        payload("run_command", {
          CommandLine: "rm -rf build",
          Cwd: "/tmp/elsewhere",
        }),
        "unattended",
      );

      expect(decisionOf(result)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "run_command_cwd_equal_to_the_worktree_is_decided_as_before",
    async () => {
      const inside = await runHook(
        payload("run_command", {
          CommandLine: "rm -rf build",
          Cwd: WORKTREE,
        }),
        "unattended",
      );
      const withoutCwd = await runHook(
        payload("run_command", { CommandLine: "rm -rf build" }),
        "unattended",
      );

      expect(decisionOf(inside)).toEqual(decisionOf(withoutCwd));
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "run_command_unnormalized_worktree_cwd_is_not_foreign",
    async () => {
      const inside = await runHook(
        payload("run_command", {
          CommandLine: "rm -rf build",
          Cwd: `${WORKTREE}/`,
        }),
        "unattended",
      );
      const withoutCwd = await runHook(
        payload("run_command", { CommandLine: "rm -rf build" }),
        "unattended",
      );

      expect(decisionOf(inside)).toEqual(decisionOf(withoutCwd));
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "run_command_tilde_cwd_stays_foreign_when_hook_runs_in_worktree",
    async () => {
      const result = await runHook(
        payload("run_command", { CommandLine: "rm -rf build", Cwd: "~/.." }),
        "unattended",
        process.cwd(),
      );

      expect(decisionOf(result)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("agy hook code execution tools and workspace config", () => {
  it(
    "code_execution_tools_denied_outside_bypass_notebook_execution",
    async () => {
      const denied = await runHook(
        payload("notebook_execution", { Cell: "import os" }),
        "unattended",
      );
      const allowed = await runHook(
        payload("notebook_execution", { Cell: "import os" }),
        "bypass",
      );

      expect(decisionOf(denied)).toEqual({
        decision: "deny",
        reason: NEEDS_APPROVAL,
      });
      expect(decisionOf(allowed)).toEqual({ decision: "allow" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "quoted_agents_path_command_and_case_variants_are_denied",
    async () => {
      const quoted = await runHook(
        payload("run_command", {
          CommandLine: "cp payload .ag''ents/hooks.json",
        }),
        "unattended",
      );
      const upper = await runHook(
        payload("write_file", { Path: `${WORKTREE}/.Agents/hooks.json` }),
        "unattended",
      );

      expect(decisionOf(quoted)).toMatchObject({ decision: "deny" });
      expect(decisionOf(upper)).toMatchObject({ decision: "deny" });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "agents_dir_edit_and_command_are_denied",
    async () => {
      const write = await runHook(
        payload("write_file", { Path: `${WORKTREE}/.agents/hooks.json` }),
        "unattended",
      );
      const command = await runHook(
        payload("run_command", { CommandLine: "echo {} > .agents/hooks.json" }),
        "unattended",
      );

      expect(decisionOf(write)).toEqual({
        decision: "deny",
        reason: "agy workspace config (.agents) is protected",
      });
      expect(decisionOf(command)).toEqual({
        decision: "deny",
        reason: "agy workspace config (.agents) is protected",
      });
    },
    RUN_TIMEOUT_MS,
  );
});

async function hookCommandIn(
  dir: string,
  execPath: string,
  hookEntry: string,
): Promise<string> {
  const configDir = join(dir, "account");
  await writeAgyHookConfig({
    configDir,
    execPath,
    hookEntry,
    platform: process.platform,
  });
  const parsed = HooksFileSchema.parse(
    JSON.parse(await readFile(join(configDir, "config", "hooks.json"), "utf8")),
  );
  return parsed.codeweave.PreToolUse[0]?.hooks[0]?.command ?? "";
}

function runCommandViaSh(command: string): Promise<HookRun> {
  return run(
    "sh",
    ["-c", command],
    payload("run_command", { CommandLine: "rm -v -rf /etc" }),
    {
      CODEWEAVE_AGY_PROFILE: "unattended",
      CODEWEAVE_AGY_WORKTREE: WORKTREE,
    },
  );
}

describe.skipIf(process.platform === "win32")(
  "agy hook through the written hooks.json command",
  () => {
    it(
      "hook_command_quotes_shell_metacharacters_and_prints_a_decision",
      async () => {
        const dir = join(scratch, METACHARACTER_DIR);
        await mkdir(dir, { recursive: true });
        const execPath = join(dir, "no de");
        const entry = join(dir, "agyHook.mjs");
        await symlink(process.execPath, execPath);
        await copyFile(bundle, entry);

        const command = await hookCommandIn(dir, execPath, entry);
        const result = await runCommandViaSh(command);

        expect(result.code).toBe(0);
        expect(decisionOf(result)).toMatchObject({ decision: "deny" });
      },
      RUN_TIMEOUT_MS,
    );

    it(
      "wrapper_tampering_cannot_disable_gate_after_overwriting_config_files",
      async () => {
        const dir = join(scratch, "tampered");
        const command = await hookCommandIn(dir, process.execPath, bundle);
        const configPath = join(dir, "account", "config");
        await writeFile(join(configPath, "codeweave-agy-hook.sh"), "");
        await writeFile(join(configPath, "hooks.json"), "{}");
        const respawned = await hookCommandIn(dir, process.execPath, bundle);

        const result = await runCommandViaSh(respawned);

        expect(respawned).toBe(command);
        expect(await readdir(configPath)).toEqual(["hooks.json"]);
        expect(decisionOf(result)).toMatchObject({ decision: "deny" });
      },
      RUN_TIMEOUT_MS,
    );
  },
);
