import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHangingExec,
  raceAgainstHang,
} from "../../../tests/fakes/hangingExec";
import { SYSTEMD_CALL_TIMEOUT_MS } from "../constants";
import type { ExecText } from "../exec";

import { StopFailureReason } from "./container";
import { spawnChild } from "./contained";
import {
  buildSystemdRunArgs,
  createSystemdScopeContainer,
  parseScopeUnits,
} from "./linux";

const HANG_MS = 1000;
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

async function spawnIdleChild(): Promise<ChildProcessWithoutNullStreams> {
  const child = await spawnChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {},
  );
  children.push(child);
  return child;
}

describe("systemd scope container", () => {
  it("systemd_run_args_include_unit_and_killmode", () => {
    expect(
      buildSystemdRunArgs(
        {
          command: "claude",
          args: ["--print", "hi there"],
          env: {},
          cwd: "/work",
          runId: "run-1",
        },
        "inst1",
      ),
    ).toEqual([
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "-p",
      "KillMode=control-group",
      "--unit=codeweave-inst1-run-1",
      "--",
      "claude",
      "--print",
      "hi there",
    ]);
  });

  it("parse_scope_units_keeps_only_codeweave_scopes", () => {
    const listing = [
      "codeweave-a1.scope loaded active running Codeweave run a1",
      "  codeweave-b2.scope loaded failed failed Codeweave run b2",
      "app-other.scope loaded active running Something else",
      "codeweave-c3.service loaded active running Not a scope",
      "",
    ].join("\n");

    expect(parseScopeUnits(listing)).toEqual([
      "codeweave-a1.scope",
      "codeweave-b2.scope",
    ]);
  });
});

describe("systemd scope orphans", () => {
  it("sweep_spares_live_instance_and_own_scope", async () => {
    const calls: string[][] = [];
    const exec: ExecText = (file, args) => {
      calls.push([file, ...args]);
      return Promise.resolve(
        args.includes("list-units")
          ? [
              "codeweave-stale1-a1.scope loaded active running x",
              "codeweave-live2-b2.scope loaded active running y",
              "codeweave-cur3-c3.scope loaded active running z",
              "codeweave-stale1-own-run.scope loaded active running w",
              "codeweave-stale10-d4.scope loaded active running v",
              "codeweave-stale1-e5.scope loaded active running u",
              "",
            ].join("\n")
          : "",
      );
    };
    const paths: string[] = [];
    const container = createSystemdScopeContainer({
      exec,
      instanceId: "cur3",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve(
          "0::/user.slice/user-1000.slice/user@1000.service/app.slice/codeweave-stale1-own-run.scope\n",
        );
      },
    });

    expect(await container.sweepOrphans(["stale1"])).toBe(2);

    const killed = calls.filter((call) => call.includes("kill"));
    expect(killed.map((call) => call.at(-1)).sort()).toEqual([
      "codeweave-stale1-a1.scope",
      "codeweave-stale1-e5.scope",
    ]);
    expect(paths).toEqual(["/proc/self/cgroup"]);
  });

  it("sweep_ignores_stale_ids_that_are_not_safe_unit_name_parts", async () => {
    const calls: string[][] = [];
    const container = createSystemdScopeContainer({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve(
          "codeweave-a-b-r1.scope loaded active running x\n",
        );
      },
      readFile: () => Promise.resolve("0::/user.slice\n"),
    });

    expect(await container.sweepOrphans(["a-b", "../x", ""])).toBe(0);

    expect(calls.filter((call) => call.includes("kill"))).toEqual([]);
  });

  it("sweep_without_stale_instances_does_not_call_systemctl", async () => {
    const calls: string[][] = [];
    const container = createSystemdScopeContainer({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve("");
      },
    });

    expect(await container.sweepOrphans([])).toBe(0);

    expect(calls).toEqual([]);
  });

  it("members_come_from_unit_control_group_procs", async () => {
    const readPaths: string[] = [];
    let procsContent = "4001\n4002\n";
    const container = createSystemdScopeContainer({
      exec: () =>
        Promise.resolve("/user.slice/user-1000.slice/codeweave-r.scope\n"),
      spawnChild: () => spawnIdleChild(),
      readFile: (path) => {
        readPaths.push(path);
        return Promise.resolve(procsContent);
      },
    });
    const contained = await container.spawn({
      command: "claude",
      args: [],
      env: {},
      cwd: process.cwd(),
      runId: "r",
    });

    expect(await contained.isEmpty()).toBe(false);
    procsContent = "";
    expect(await contained.isEmpty()).toBe(true);
    expect(readPaths[0]).toBe(
      "/sys/fs/cgroup/user.slice/user-1000.slice/codeweave-r.scope/cgroup.procs",
    );
  });
});

describe("systemd call timeouts", () => {
  it("systemd_call_timeout_keeps_lock", async () => {
    const { exec, calls } = createHangingExec(["show"], "");
    const container = createSystemdScopeContainer({
      exec,
      instanceId: "inst",
      spawnChild: () => spawnIdleChild(),
    });
    const contained = await container.spawn({
      command: "claude",
      args: [],
      env: {},
      cwd: process.cwd(),
      runId: "r",
    });

    const result = await raceAgainstHang(contained.stop(0), HANG_MS);

    expect(result).toEqual({
      ok: false,
      reason: StopFailureReason.notEmptyAfterTimeout,
      survivors: [],
    });
    expect(
      calls.every((call) => call.timeoutMs === SYSTEMD_CALL_TIMEOUT_MS),
    ).toBe(true);
  });

  it("every_systemctl_call_carries_the_systemd_timeout", async () => {
    const { exec, calls } = createHangingExec([], "");
    const container = createSystemdScopeContainer({
      exec,
      instanceId: "cur",
      readFile: () => Promise.resolve("0::/user.slice\n"),
    });

    await container.sweepOrphans(["old"]);

    expect(calls.map((call) => call.timeoutMs)).toEqual([
      SYSTEMD_CALL_TIMEOUT_MS,
    ]);
  });
});

describe("systemd scope membership", () => {
  it("rejects_instance_id_that_is_not_a_safe_unit_name_part", () => {
    for (const instanceId of ["bad-id", "a b", "../x", ""]) {
      expect(
        () => createSystemdScopeContainer({ instanceId }),
        instanceId,
      ).toThrow(RangeError);
    }
  });

  it("gone_unit_counts_as_empty", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const container = createSystemdScopeContainer({
      exec: () => Promise.resolve("/user.slice/codeweave-r.scope\n"),
      spawnChild: () => spawnIdleChild(),
      readFile: () => Promise.reject(missing),
    });
    const contained = await container.spawn({
      command: "claude",
      args: [],
      env: {},
      cwd: process.cwd(),
      runId: "r",
    });

    expect(await contained.isEmpty()).toBe(true);
  });

  it("dying_scope_enodev_confirms_empty_on_stop", async () => {
    const dying = Object.assign(new Error("ENODEV: no such device, read"), {
      code: "ENODEV",
    });
    const container = createSystemdScopeContainer({
      exec: () => Promise.resolve("/user.slice/codeweave-r.scope\n"),
      spawnChild: () => spawnIdleChild(),
      readFile: () => Promise.reject(dying),
    });
    const contained = await container.spawn({
      command: "claude",
      args: [],
      env: {},
      cwd: process.cwd(),
      runId: "r",
    });

    expect(await contained.stop(0)).toEqual({ ok: true });
  });

  it("rejects_run_id_that_is_not_a_safe_unit_name", async () => {
    const container = createSystemdScopeContainer({
      spawnChild: () => spawnIdleChild(),
    });

    await expect(
      container.spawn({
        command: "claude",
        args: [],
        env: {},
        cwd: process.cwd(),
        runId: "../evil run",
      }),
    ).rejects.toThrow(RangeError);
  });
});

const SPEC = {
  command: "/bin/sh",
  args: ["-l"],
  env: { TERM: "xterm-256color" },
  cwd: "/work",
  runId: "run-1",
};
const LAUNCHED = { pid: 77, hasExited: () => false };

describe("systemd scope container launch", () => {
  it("launch_wraps_the_command_in_a_scope_and_exposes_its_members", async () => {
    const launches: {
      command: string;
      args: readonly string[];
      cwd: string;
    }[] = [];
    const showCalls: (readonly string[])[] = [];
    const readPaths: string[] = [];
    const container = createSystemdScopeContainer({
      instanceId: "inst1",
      exec: (_file, args) => {
        showCalls.push(args);
        return Promise.resolve("/user.slice/codeweave-inst1-run-1.scope\n");
      },
      readFile: (path) => {
        readPaths.push(path);
        return Promise.resolve("77\n88\n");
      },
      spawnChild: () => spawnIdleChild(),
    });

    const { process: launched, ops } = await container.launch(
      SPEC,
      (command, args, options) => {
        launches.push({ command, args, cwd: options.cwd });
        return Promise.resolve(LAUNCHED);
      },
    );

    expect(launches).toEqual([
      {
        command: "systemd-run",
        args: [
          "--user",
          "--scope",
          "--collect",
          "--quiet",
          "-p",
          "KillMode=control-group",
          "--unit=codeweave-inst1-run-1",
          "--",
          "/bin/sh",
          "-l",
        ],
        cwd: "/work",
      },
    ]);
    expect(launched).toBe(LAUNCHED);
    expect(await ops.members()).toEqual([77, 88]);
    expect(showCalls[0]?.at(-1)).toBe("codeweave-inst1-run-1.scope");
    expect(readPaths).toEqual([
      "/sys/fs/cgroup/user.slice/codeweave-inst1-run-1.scope/cgroup.procs",
    ]);
  });
});

describe("systemd scope container launch inputs", () => {
  it("launch_passes_the_environment_to_the_launcher_unchanged", async () => {
    const container = createSystemdScopeContainer({
      instanceId: "inst1",
      spawnChild: () => spawnIdleChild(),
    });
    let received: Readonly<Record<string, string>> = {};

    await container.launch(SPEC, (_command, _args, options) => {
      received = options.env;
      return Promise.resolve(LAUNCHED);
    });

    expect(received).toEqual({ TERM: "xterm-256color" });
  });

  it("launch_rejects_an_unsafe_run_id_without_launching", async () => {
    const container = createSystemdScopeContainer({
      spawnChild: () => spawnIdleChild(),
    });
    let launched = false;

    await expect(
      container.launch({ ...SPEC, runId: "../evil run" }, () => {
        launched = true;
        return Promise.resolve(LAUNCHED);
      }),
    ).rejects.toThrow(RangeError);

    expect(launched).toBe(false);
  });
});
