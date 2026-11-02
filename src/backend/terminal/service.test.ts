import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcError } from "../../shared/protocol";
import { TerminalViewSchema } from "../../shared/views";
import {
  createTerminalRig,
  type RecordedEvent,
  type TerminalRig,
  type TerminalRigOptions,
} from "../../../tests/fakes/fakeTerminal";
import { TERMINAL_FLUSH_MAX_CHARS, TERMINAL_FLUSH_MS } from "../constants";

const COLS = 80;
const ROWS = 24;
const FIRST_ID = "term-1";
const SECOND_ID = "term-2";
const rigs: TerminalRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
  vi.restoreAllMocks();
});

function newRig(options: TerminalRigOptions = {}): TerminalRig {
  const rig = createTerminalRig(options);
  rigs.push(rig);
  return rig;
}

function payloadsOf(events: readonly RecordedEvent[], name: string): unknown[] {
  return events
    .filter((entry) => entry.event === name)
    .map((entry) => entry.payload);
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof IpcError ? error.code : String(error);
  }
  return "no error";
}

async function rejectionOf(pending: Promise<unknown>): Promise<IpcError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof IpcError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the promise to reject");
}

async function openIn(rig: TerminalRig, cwd?: string): Promise<string> {
  const folder = cwd ?? (await rig.folder());
  await rig.service.open({ cwd: folder, cols: COLS, rows: ROWS });
  return folder;
}

describe("open", () => {
  it("concurrent_open_spawns_one_shell", async () => {
    const rig = newRig();
    const cwd = await rig.folder();

    const [first, second] = await Promise.all([
      rig.service.open({ cwd, cols: COLS, rows: ROWS }),
      rig.service.open({ cwd, cols: COLS, rows: ROWS }),
    ]);

    expect(rig.spawns).toHaveLength(1);
    expect(first.terminal.id).toBe(FIRST_ID);
    expect(second.terminal.id).toBe(FIRST_ID);
  });

  it("open_in_missing_folder_fails_and_spawns_nothing", async () => {
    const rig = newRig();
    const missing = join(await rig.folder(), "gone");

    const error = await rejectionOf(
      rig.service.open({ cwd: missing, cols: COLS, rows: ROWS }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe(`The folder does not exist: ${missing}`);
    expect(rig.spawns).toHaveLength(0);
    expect(rig.container.specs).toHaveLength(0);
    expect(rig.service.view()).toBeNull();
    expect(rig.events).toEqual([]);
  });

  it("open_on_a_file_instead_of_a_folder_fails", async () => {
    const rig = newRig();
    const file = join(await rig.folder(), "notes.txt");
    await writeFile(file, "x");

    const error = await rejectionOf(
      rig.service.open({ cwd: file, cols: COLS, rows: ROWS }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(rig.spawns).toHaveLength(0);
  });

  it("open_attaches_when_the_folder_is_spelled_differently", async () => {
    const rig = newRig();
    const cwd = await rig.folder("project");

    await openIn(rig, cwd);
    const again = await rig.service.open({
      cwd: join(cwd, "..", "project"),
      cols: COLS,
      rows: ROWS,
    });

    expect(rig.spawns).toHaveLength(1);
    expect(again.terminal.id).toBe(FIRST_ID);
  });
});

describe("open over an existing terminal", () => {
  it("open_in_another_folder_replaces_the_shell_without_announcing_a_gap", async () => {
    const rig = newRig();
    const first = await openIn(rig);
    const second = await rig.folder("second");

    await rig.service.open({ cwd: second, cols: COLS, rows: ROWS });

    expect(rig.spawns).toHaveLength(2);
    expect(rig.spawnAt(0).pty.kills).toEqual(["SIGHUP"]);
    expect(rig.service.view()).toMatchObject({ id: SECOND_ID, cwd: second });
    expect(
      payloadsOf(rig.events, "terminal/changed").map(
        (view) => TerminalViewSchema.nullable().parse(view)?.cwd,
      ),
    ).toEqual([first, second]);
  });

  it("open_after_exit_starts_a_fresh_shell_in_the_same_folder", async () => {
    const rig = newRig();
    const cwd = await openIn(rig);
    rig.spawnAt(0).pty.emitExit(1);

    const reopened = await rig.service.open({ cwd, cols: COLS, rows: ROWS });

    expect(rig.spawns).toHaveLength(2);
    expect(reopened.terminal).toEqual({
      id: SECOND_ID,
      cwd,
      shell: "/bin/fake-shell",
      status: "running",
      exitCode: null,
    });
    expect(reopened.replay).toBe("");
  });

  it("open_reads_the_configured_shell_each_time", async () => {
    const seen: (string | null)[] = [];
    const rig = newRig({
      setting: "/opt/nu",
      detectShell: (setting) => {
        seen.push(setting);
        return Promise.resolve({ command: "/opt/nu", args: [] });
      },
    });

    await openIn(rig);

    expect(seen).toEqual(["/opt/nu"]);
    expect(rig.service.view()?.shell).toBe("/opt/nu");
  });
});

describe("failed open", () => {
  it("an_unresolvable_shell_fails_open_and_leaves_nothing_behind", async () => {
    const failure = new IpcError("UNAVAILABLE", "No usable shell was found");
    const rig = newRig({ detectShell: () => Promise.reject(failure) });

    const error = await rejectionOf(
      rig.service.open({ cwd: await rig.folder(), cols: COLS, rows: ROWS }),
    );

    expect(error).toBe(failure);
    expect(rig.spawns).toHaveLength(0);
    expect(rig.service.view()).toBeNull();
    expect(rig.timers.activeCount()).toBe(0);
    expect(rig.events).toEqual([]);
  });

  it("a_failing_launch_is_reported_as_unavailable_and_leaves_no_terminal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rig = newRig({ launchFailure: new Error("posix_spawnp failed") });

    const error = await rejectionOf(
      rig.service.open({ cwd: await rig.folder(), cols: COLS, rows: ROWS }),
    );

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toBe(
      "The terminal shell could not be started: posix_spawnp failed",
    );
    expect(rig.service.view()).toBeNull();
    expect(rig.timers.activeCount()).toBe(0);
    expect(rig.events).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("addressing a terminal", () => {
  it("input_after_exit_is_rejected", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);

    pty.emitExit(0);

    expect(
      codeOf(() => {
        rig.service.input(FIRST_ID, "x");
      }),
    ).toBe("CONFLICT");
    expect(
      codeOf(() => {
        rig.service.resize(FIRST_ID, 100, 40);
      }),
    ).toBe("CONFLICT");
    expect(pty.written).toEqual([]);
    expect(pty.resizes).toEqual([]);
  });

  it("ack_and_detach_after_exit_are_harmless", async () => {
    const rig = newRig();
    await openIn(rig);
    rig.spawnAt(0).pty.emitExit(0);

    expect(
      codeOf(() => {
        rig.service.ack(FIRST_ID, 5);
      }),
    ).toBe("no error");
    expect(
      codeOf(() => {
        rig.service.detach(FIRST_ID);
      }),
    ).toBe("no error");
  });
});

describe("addressing a stale terminal", () => {
  it("stale_id_is_not_found", async () => {
    const rig = newRig();
    expect(
      codeOf(() => {
        rig.service.input(FIRST_ID, "x");
      }),
    ).toBe("NOT_FOUND");
    const cwd = await openIn(rig);
    rig.spawnAt(0).pty.emitExit(0);
    await rig.service.open({ cwd, cols: COLS, rows: ROWS });

    expect(
      codeOf(() => {
        rig.service.input(FIRST_ID, "x");
      }),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(() => {
        rig.service.resize(FIRST_ID, 80, 24);
      }),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(() => {
        rig.service.ack(FIRST_ID, 1);
      }),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(() => {
        rig.service.detach(FIRST_ID);
      }),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(() => {
        rig.service.input(SECOND_ID, "x");
      }),
    ).toBe("no error");
  });

  it("close_of_an_unknown_id_changes_nothing", async () => {
    const rig = newRig();
    await openIn(rig);

    const result = await rig.service.close("other");

    expect(result).toEqual({ closed: false });
    expect(rig.service.view()?.status).toBe("running");
  });

  it("close_after_exit_removes_the_terminal", async () => {
    const rig = newRig();
    await openIn(rig);
    rig.spawnAt(0).pty.emitExit(2);

    const result = await rig.service.close(FIRST_ID);

    expect(result).toEqual({ closed: true });
    expect(rig.service.view()).toBeNull();
    expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toBeNull();
  });
});

describe("output batching", () => {
  it("output_is_batched_until_the_flush_timer_fires", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);

    pty.emitData("a");
    pty.emitData("b");
    pty.emitData("c");
    const beforeFlush = payloadsOf(rig.events, "terminal/data");
    rig.timers.fireAll();

    expect(beforeFlush).toEqual([]);
    expect(rig.timers.timers.map((timer) => timer.delayMs)).toEqual([
      TERMINAL_FLUSH_MS,
    ]);
    expect(payloadsOf(rig.events, "terminal/data")).toEqual([
      { id: FIRST_ID, data: "abc" },
    ]);
  });

  it("output_flushes_immediately_at_the_batch_limit", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);

    pty.emitData("x".repeat(TERMINAL_FLUSH_MAX_CHARS - 1));
    const belowLimit = payloadsOf(rig.events, "terminal/data").length;
    pty.emitData("y");

    expect(belowLimit).toBe(0);
    expect(payloadsOf(rig.events, "terminal/data")).toEqual([
      {
        id: FIRST_ID,
        data: `${"x".repeat(TERMINAL_FLUSH_MAX_CHARS - 1)}y`,
      },
    ]);
    expect(rig.timers.activeCount()).toBe(0);
  });
});

describe("output across exit and attach", () => {
  it("exit_flushes_pending_output_before_announcing_the_exit", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);

    pty.emitData("bye\n");
    pty.emitExit(0);

    expect(rig.events.slice(-2).map((entry) => entry.event)).toEqual([
      "terminal/data",
      "terminal/changed",
    ]);
    expect(payloadsOf(rig.events, "terminal/data")).toEqual([
      { id: FIRST_ID, data: "bye\n" },
    ]);
    expect(rig.timers.activeCount()).toBe(0);
  });

  it("attaching_drops_the_pending_batch_because_the_replay_already_has_it", async () => {
    const rig = newRig();
    const cwd = await openIn(rig);
    rig.spawnAt(0).pty.emitData("pending");

    const attached = await rig.service.open({ cwd, cols: COLS, rows: ROWS });
    rig.timers.fireAll();

    expect(attached.replay).toBe("pending");
    expect(payloadsOf(rig.events, "terminal/data")).toEqual([]);
  });

  it("output_while_detached_never_starts_a_flush_timer", async () => {
    const rig = newRig();
    await openIn(rig);
    rig.service.detach(FIRST_ID);

    rig.spawnAt(0).pty.emitData("quiet");

    expect(rig.timers.activeCount()).toBe(0);
  });
});

describe("stopping", () => {
  it("a_shell_that_ignores_hangup_is_killed_after_the_grace_period", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);
    pty.exitOnKill = false;
    rig.container.strayChildren.push(9001);
    rig.container.onKillMembers = () => {
      pty.emitExit(137);
    };

    const closing = rig.service.close(FIRST_ID);
    await vi.waitFor(() => {
      expect(rig.timers.activeCount()).toBe(1);
    });
    const graceDelays = rig.timers.timers.map((timer) => timer.delayMs);
    rig.timers.fireAll();
    await closing;

    expect(graceDelays).toEqual([1000]);
    expect(pty.kills).toEqual(["SIGHUP"]);
    expect(rig.container.killMembersCalls).toBe(1);
    expect(rig.container.strayChildren).toEqual([]);
    expect(pty.hasExited()).toBe(true);
  });

  it("no_terminal_data_after_stop_begins", async () => {
    const rig = newRig();
    await openIn(rig);
    const { pty } = rig.spawnAt(0);
    pty.exitOnKill = false;
    rig.container.onKillMembers = () => {
      pty.emitExit(137);
    };
    pty.emitData("before");

    const closing = rig.service.close(FIRST_ID);
    await vi.waitFor(() => {
      expect(rig.timers.activeCount()).toBe(1);
    });
    pty.emitData("dying");
    rig.timers.fireAll();
    await closing;

    expect(payloadsOf(rig.events, "terminal/data")).toEqual([]);
    expect(rig.timers.activeCount()).toBe(0);
  });

  it("a_shell_that_exits_on_hangup_cancels_the_grace_timer", async () => {
    const rig = newRig();
    await openIn(rig);

    await rig.service.close(FIRST_ID);

    expect(rig.timers.activeCount()).toBe(0);
  });

  it("stopping_an_exited_shell_still_reaps_its_background_children", async () => {
    const rig = newRig();
    await openIn(rig);
    rig.container.strayChildren.push(9002);

    rig.spawnAt(0).pty.emitExit(0);
    await rig.service.close(FIRST_ID);

    expect(rig.container.strayChildren).toEqual([]);
    expect(rig.spawnAt(0).pty.kills).toEqual([]);
  });
});

describe("stopping edge cases", () => {
  it("shutdown_without_a_terminal_is_a_no_op", async () => {
    const rig = newRig();

    await rig.service.shutdown();

    expect(rig.events).toEqual([]);
  });

  it("a_win32_shell_is_killed_without_a_signal", async () => {
    const rig = newRig({ platform: "win32", contained: false });
    await openIn(rig);

    await rig.service.close(FIRST_ID);

    expect(rig.spawnAt(0).pty.kills).toEqual([undefined]);
  });
});

describe("retarget", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("retarget_closes_when_terminal_folder_is_gone", async () => {
    const rig = newRig();
    const gone = await openIn(rig);
    const elsewhere = await rig.folder("elsewhere");
    await rm(gone, { recursive: true });

    await rig.service.retarget(elsewhere);

    expect(rig.service.view()).toBeNull();
    expect(rig.spawnAt(0).pty.kills).toEqual(["SIGHUP"]);
    expect(payloadsOf(rig.events, "terminal/changed").at(-1)).toBeNull();
  });

  it("retarget_without_a_terminal_does_nothing", async () => {
    const rig = newRig();

    await rig.service.retarget(await rig.folder());

    expect(rig.events).toEqual([]);
  });

  it("retarget_keeps_an_exited_terminal_in_the_same_folder", async () => {
    const rig = newRig();
    const cwd = await openIn(rig);
    rig.spawnAt(0).pty.emitExit(0);

    await rig.service.retarget(cwd);

    expect(rig.service.view()?.status).toBe("exited");
  });
});
