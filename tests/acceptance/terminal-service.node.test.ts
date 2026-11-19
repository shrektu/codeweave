import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  TERMINAL_HIGH_WATERMARK_CHARS,
  TERMINAL_LOW_WATERMARK_CHARS,
  TERMINAL_REPLAY_MAX_CHARS,
} from "../../src/backend/constants";
import { resolveLockKey } from "../../src/backend/locks";
import { createShellDetector } from "../../src/backend/terminal/shell";
import { IpcError } from "../../src/shared/protocol";
import {
  createTerminalRig,
  type RecordedEvent,
  type TerminalRig,
  type TerminalRigOptions,
} from "../fakes/fakeTerminal";
import { makeTempDir, runGit } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

const COLS = 100;
const ROWS = 30;
const FIRST_ID = "term-1";
const rigs: TerminalRig[] = [];
const repos: string[] = [];

function newRig(options: TerminalRigOptions = {}): TerminalRig {
  const rig = createTerminalRig(options);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
  await Promise.all(
    repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

function payloadsOf(events: readonly RecordedEvent[], name: string): unknown[] {
  return events
    .filter((entry) => entry.event === name)
    .map((entry) => entry.payload);
}

function errorCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof IpcError ? error.code : String(error);
  }
  return "no error";
}

async function openInNewFolder(
  rig: TerminalRig,
): Promise<{ cwd: string; replay: string }> {
  const cwd = await rig.folder();
  const { replay } = await rig.service.open({ cwd, cols: COLS, rows: ROWS });
  expect(rig.spawns).toHaveLength(1);
  return { cwd, replay };
}

it("open_spawns_the_detected_shell_and_streams_typed_input", async () => {
  const rig = newRig();
  const cwd = await rig.folder();

  const opened = await rig.service.open({ cwd, cols: COLS, rows: ROWS });
  expect(rig.spawns).toHaveLength(1);
  const spawn = rig.spawnAt(0);
  spawn.pty.echoInput = true;
  rig.service.input(FIRST_ID, "echo cw-ok\n");
  rig.timers.fireAll();

  expect(opened).toEqual({
    terminal: {
      id: FIRST_ID,
      cwd,
      shell: "/bin/fake-shell",
      status: "running",
      exitCode: null,
    },
    replay: "",
  });
  expect(rig.spawns).toHaveLength(1);
  expect(spawn.command).toBe("/bin/fake-shell");
  expect(spawn.args).toEqual(["-l"]);
  expect(spawn.size).toEqual({ cols: COLS, rows: ROWS });
  expect(spawn.options.cwd).toBe(cwd);
  expect(spawn.pty.written).toEqual(["echo cw-ok\n"]);
  expect(payloadsOf(rig.events, "terminal/data")).toEqual([
    { id: FIRST_ID, data: "echo cw-ok\n" },
  ]);
  expect(payloadsOf(rig.events, "terminal/changed")).toEqual([opened.terminal]);
});

it("second_open_in_the_same_folder_attaches_and_returns_the_replay", async () => {
  const rig = newRig();
  const { cwd } = await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);
  pty.emitData("before detach\n");
  rig.timers.fireAll();
  rig.service.detach(FIRST_ID);
  pty.emitData("while detached\n");

  const attached = await rig.service.open({ cwd, cols: 120, rows: 40 });

  expect(rig.spawns).toHaveLength(1);
  expect(attached.terminal.id).toBe(FIRST_ID);
  expect(attached.replay).toBe("before detach\nwhile detached\n");
  expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
});

it("shell_exit_publishes_exited_status_and_input_is_rejected", async () => {
  const rig = newRig();
  const { cwd } = await openInNewFolder(rig);

  rig.spawnAt(0).pty.emitExit(3);

  expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toEqual({
    id: FIRST_ID,
    cwd,
    shell: "/bin/fake-shell",
    status: "exited",
    exitCode: 3,
  });
  expect(
    errorCodeOf(() => {
      rig.service.input(FIRST_ID, "ls\n");
    }),
  ).toBe("CONFLICT");
});

it("pty_is_paused_above_the_high_watermark_and_resumed_by_acks", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);

  pty.emitData("a".repeat(TERMINAL_HIGH_WATERMARK_CHARS / 2));
  pty.emitData("b".repeat(TERMINAL_HIGH_WATERMARK_CHARS / 2));
  const pausedAtHigh = pty.paused;
  pty.emitData("c");
  const pausedAboveHigh = pty.paused;
  rig.service.ack(FIRST_ID, TERMINAL_HIGH_WATERMARK_CHARS / 2);
  const pausedAtHalf = pty.paused;
  rig.service.ack(
    FIRST_ID,
    TERMINAL_HIGH_WATERMARK_CHARS / 2 - TERMINAL_LOW_WATERMARK_CHARS + 2,
  );

  expect(pausedAtHigh).toBe(false);
  expect(pausedAboveHigh).toBe(true);
  expect(pausedAtHalf).toBe(true);
  expect(pty.paused).toBe(false);
  expect(pty.pauseCalls).toBe(1);
  expect(pty.resumeCalls).toBe(1);
});

it("detach_resumes_a_paused_pty_and_stops_data_events", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);
  pty.emitData("a".repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
  const dataEventsBeforeDetach = payloadsOf(rig.events, "terminal/data").length;

  rig.service.detach(FIRST_ID);
  pty.emitData("quiet\n");
  rig.timers.fireAll();

  expect(pty.paused).toBe(false);
  expect(payloadsOf(rig.events, "terminal/data")).toHaveLength(
    dataEventsBeforeDetach,
  );
});

it("connection_close_detaches_and_resumes_paused_pty", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);
  pty.emitData("a".repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
  const pausedBefore = pty.paused;

  rig.service.detachAll();
  pty.emitData("b".repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));

  expect(pausedBefore).toBe(true);
  expect(pty.paused).toBe(false);
  expect(pty.pauseCalls).toBe(1);
});

it("detached_output_only_lands_in_the_bounded_replay_ring", async () => {
  const rig = newRig();
  const { cwd } = await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);
  rig.service.detach(FIRST_ID);
  const dataEventsBefore = payloadsOf(rig.events, "terminal/data").length;

  pty.emitData("x".repeat(TERMINAL_REPLAY_MAX_CHARS + 1000));
  const attached = await rig.service.open({ cwd, cols: COLS, rows: ROWS });

  expect(payloadsOf(rig.events, "terminal/data")).toHaveLength(
    dataEventsBefore,
  );
  expect(pty.pauseCalls).toBe(0);
  expect(attached.replay).toBe("x".repeat(TERMINAL_REPLAY_MAX_CHARS));
});

it("retarget_keeps_the_terminal_in_the_same_folder_and_closes_it_elsewhere", async () => {
  const rig = newRig();
  const { cwd } = await openInNewFolder(rig);
  const other = await rig.folder("other");
  const { pty } = rig.spawnAt(0);

  await rig.service.retarget(cwd);
  const viewAfterSameFolder = rig.service.view();
  await rig.service.retarget(other);

  expect(viewAfterSameFolder?.status).toBe("running");
  expect(pty.kills).toEqual(["SIGHUP"]);
  expect(rig.service.view()).toBeNull();
  expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toBeNull();
});

it("retarget_with_the_git_resolver_treats_subfolders_of_one_repository_as_the_same_folder", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const repo = await makeTempDir();
  repos.push(repo);
  await runGit(repo, ["init", "--quiet"]);
  const first = join(repo, "packages", "app");
  const second = join(repo, "packages", "web");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const rig = newRig({ resolveLockKey });
  await rig.service.open({ cwd: first, cols: COLS, rows: ROWS });
  const { pty } = rig.spawnAt(0);

  await rig.service.retarget(second);
  const viewInsideRepository = rig.service.view();
  await rig.service.retarget(await rig.folder("outside"));

  expect(viewInsideRepository?.status).toBe("running");
  expect(pty.kills).toEqual(["SIGHUP"]);
  expect(rig.service.view()).toBeNull();
});

it("shutdown_stops_the_terminal", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);

  await rig.service.shutdown();

  expect(pty.kills).toEqual(["SIGHUP"]);
  expect(pty.hasExited()).toBe(true);
  expect(rig.service.view()).toBeNull();
});

it("shell_runs_in_a_container_and_background_children_die_on_close", async () => {
  const rig = newRig();
  const { cwd } = await openInNewFolder(rig);
  rig.container.strayChildren.push(4242);

  const closed = await rig.service.close(FIRST_ID);

  expect(closed).toEqual({ closed: true });
  expect(rig.container.specs).toHaveLength(1);
  expect(rig.container.specs[0]).toMatchObject({
    command: "/bin/fake-shell",
    cwd,
    runId: FIRST_ID,
  });
  expect(rig.container.strayChildren).toEqual([]);
  expect(rig.container.killMembersCalls).toBeGreaterThanOrEqual(1);
});

it("shell_without_a_container_is_launched_directly_and_hung_up_on_close", async () => {
  const rig = newRig({ contained: false });
  await openInNewFolder(rig);

  await rig.service.close(FIRST_ID);

  expect(rig.container.specs).toEqual([]);
  expect(rig.spawnAt(0).pty.kills).toEqual(["SIGHUP"]);
  expect(rig.spawnAt(0).pty.hasExited()).toBe(true);
});

it("terminal_env_drops_provider_keys", async () => {
  const rig = newRig({
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "sk-test-fake",
      OPENAI_API_KEY: "sk-test-fake",
      GEMINI_API_KEY: "sk-test-fake",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
      CODEX_HOME: "/home/tester/.codex",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  await openInNewFolder(rig);

  expect(rig.spawnAt(0).options.env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Codeweave",
  });
});

it("close_announces_the_terminal_and_then_its_removal_only", async () => {
  const rig = newRig();
  await openInNewFolder(rig);

  await rig.service.close(FIRST_ID);

  expect(payloadsOf(rig.events, "terminal/changed")).toHaveLength(2);
  expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toBeNull();
});

it.skipIf(process.platform === "win32")(
  "path_lookup_skips_non_executable_shell",
  async () => {
    const blocked = await makeTempDir();
    const usable = await makeTempDir();
    await writeFile(join(blocked, "fakesh"), "");
    await chmod(join(blocked, "fakesh"), 0o644);
    await writeFile(join(usable, "fakesh"), "");
    await chmod(join(usable, "fakesh"), 0o755);
    const rig = newRig({
      setting: "fakesh",
      detectShell: createShellDetector("linux", {
        PATH: `${blocked}:${usable}`,
      }),
    });

    await openInNewFolder(rig);

    expect(rig.spawnAt(0).command).toBe(join(usable, "fakesh"));
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "path_lookup_skips_unsearchable_path_entry",
  async () => {
    const locked = await makeTempDir();
    const usable = await makeTempDir();
    await writeFile(join(usable, "fakesh"), "");
    await chmod(join(usable, "fakesh"), 0o755);
    await chmod(locked, 0o000);
    const rig = newRig({
      setting: "fakesh",
      detectShell: createShellDetector("linux", {
        PATH: `${join(locked, "bin")}:${usable}`,
      }),
    });

    try {
      await openInNewFolder(rig);
    } finally {
      await chmod(locked, 0o755);
    }

    expect(rig.spawnAt(0).command).toBe(join(usable, "fakesh"));
  },
);

it("no_terminal_data_after_stop_begins", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const { pty } = rig.spawnAt(0);
  pty.exitOnKill = false;
  rig.container.onKillMembers = () => {
    pty.emitExit(137);
  };

  const closing = rig.service.close(FIRST_ID);
  await vi.waitFor(() => {
    expect(rig.timers.activeCount()).toBe(1);
  });
  pty.emitData("dying output\n");
  rig.timers.fireAll();
  await closing;

  const names = rig.events.map((entry) => entry.event);
  expect(payloadsOf(rig.events, "terminal/data")).toEqual([]);
  expect(names).toEqual(["terminal/changed", "terminal/changed"]);
  expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toBeNull();
});

it("no_terminal_data_for_the_old_id_after_retarget_starts", async () => {
  const rig = newRig();
  await openInNewFolder(rig);
  const other = await rig.folder("other");
  const { pty } = rig.spawnAt(0);
  pty.exitOnKill = false;
  rig.container.onKillMembers = () => {
    pty.emitExit(137);
  };

  const retargeting = rig.service.retarget(other);
  await settled(() => {
    expect(rig.timers.activeCount()).toBe(1);
  });
  pty.emitData("dying output\n");
  rig.timers.fireAll();
  await retargeting;

  expect(payloadsOf(rig.events, "terminal/data")).toEqual([]);
});
