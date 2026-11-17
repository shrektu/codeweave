import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeJobApi, JobOp } from "../../../tests/fakes/fakeJobApi";

import {
  ContainerKind,
  type LaunchedProcess,
  type Launcher,
  type LaunchOptions,
  type SpawnSpec,
} from "./container";
import { JobApiError } from "./jobApi";
import { createJobObjectContainer, enterAppJob } from "./windows";

const ROOT_PID = 4321;
const GRANDCHILD_PID = 4400;
const FIRST_JOB = 1n;
const INSTANCE_ID = "0123456789abcdef0123456789abcdef";
const LATE_EXIT_DELAY_MS = 100;
const ASSIGN_FAILURE_MESSAGE = "process could not be assigned to its job";

const SPEC: SpawnSpec = {
  command: "node",
  args: ["agent.js"],
  env: { PATH: "C:\\bin" },
  cwd: "C:\\work",
  runId: "run-1",
};

interface RootProcess extends LaunchedProcess {
  exit(): void;
}

function rootProcess(initiallyExited = false): RootProcess {
  let exited = initiallyExited;
  return {
    pid: ROOT_PID,
    hasExited: () => exited,
    exit: () => {
      exited = true;
    },
  };
}

function launcherOf(root: RootProcess): Launcher<RootProcess> {
  return () => Promise.resolve(root);
}

function setup(): {
  api: FakeJobApi;
  kills: number[];
  container: ReturnType<typeof createJobObjectContainer>;
} {
  const api = new FakeJobApi();
  const kills: number[] = [];
  const container = createJobObjectContainer({
    api,
    instanceId: INSTANCE_ID,
    kill: (pid) => {
      kills.push(pid);
    },
  });
  return { api, kills, container };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("job object container launch", () => {
  it("reports_the_job_object_kind", () => {
    expect(setup().container.kind).toBe(ContainerKind.jobObject);
  });

  it("launch_assigns_pid_before_returning", async () => {
    const { api, container } = setup();

    await container.launch(SPEC, launcherOf(rootProcess()));

    expect(api.callsOf(JobOp.assignPid)).toEqual([
      { op: JobOp.assignPid, job: FIRST_JOB, pid: ROOT_PID },
    ]);
  });

  it("launch_failure_closes_job_handle", async () => {
    const { api, container } = setup();
    const failure = new Error("spawn failed");

    const outcome = container.launch(SPEC, () => Promise.reject(failure));

    await expect(outcome).rejects.toBe(failure);
    expect(api.calls.map((call) => call.op)).toEqual([
      JobOp.createJob,
      JobOp.close,
    ]);
    expect(api.callsOf(JobOp.close)[0]?.job).toBe(FIRST_JOB);
  });

  it("assign_failure_kills_the_process_and_closes_the_job", async () => {
    const { api, kills, container } = setup();
    api.assignPidFailure = new JobApiError("access denied");

    const outcome = container.launch(SPEC, launcherOf(rootProcess()));

    await expect(outcome).rejects.toBe(api.assignPidFailure);
    expect(kills).toEqual([ROOT_PID]);
    expect(api.callsOf(JobOp.close).map((call) => call.job)).toEqual([
      FIRST_JOB,
    ]);
  });

  it("assign_returning_false_for_a_live_process_kills_it_and_rejects", async () => {
    const { api, kills, container } = setup();
    api.processesExist = false;

    const outcome = container.launch(SPEC, launcherOf(rootProcess()));

    await expect(outcome).rejects.toThrow(ASSIGN_FAILURE_MESSAGE);
    await expect(outcome).rejects.toBeInstanceOf(JobApiError);
    expect(kills).toEqual([ROOT_PID]);
    expect(api.callsOf(JobOp.close).map((call) => call.job)).toEqual([
      FIRST_JOB,
    ]);
  });

  it("assign_failure_for_an_exited_process_gives_an_empty_container", async () => {
    const { api, kills, container } = setup();
    api.assignPidFailure = new JobApiError("access denied");

    const { ops } = await container.launch(SPEC, launcherOf(rootProcess(true)));

    expect(kills).toEqual([]);
    await expect(ops.members()).resolves.toEqual([]);
    await expect(ops.killMembers()).resolves.toBeUndefined();
    expect(api.callsOf(JobOp.terminate)).toHaveLength(0);
  });

  it("assign_grace_waits_for_a_late_exit", async () => {
    const { api, kills, container } = setup();
    api.processesExist = false;
    const root = rootProcess();
    setTimeout(() => {
      root.exit();
    }, LATE_EXIT_DELAY_MS);

    const { ops } = await container.launch(SPEC, launcherOf(root));

    expect(root.hasExited()).toBe(true);
    expect(kills).toEqual([]);
    await expect(ops.members()).resolves.toEqual([]);
  });

  it("launch_marks_the_environment_with_the_run_marker", async () => {
    const { container } = setup();
    const received: LaunchOptions[] = [];

    await container.launch(SPEC, (_command, _args, options) => {
      received.push(options);
      return Promise.resolve(rootProcess());
    });

    expect(received[0]?.env).toStrictEqual({
      PATH: "C:\\bin",
      CODEWEAVE_RUN_ID: `${INSTANCE_ID}:run-1`,
    });
  });

  it("launch_of_instantly_exiting_command_reports_empty_container", async () => {
    const { api, container } = setup();
    api.processesExist = false;

    const { ops } = await container.launch(SPEC, launcherOf(rootProcess(true)));

    await expect(ops.members()).resolves.toEqual([]);
    expect(api.callsOf(JobOp.close)).toHaveLength(1);
  });
});

describe("job object container ops", () => {
  it("members_close_handle_exactly_once_when_the_job_is_empty", async () => {
    const { api, container } = setup();
    const root = rootProcess();
    const { ops } = await container.launch(SPEC, launcherOf(root));
    api.adopt(FIRST_JOB, GRANDCHILD_PID);

    await expect(ops.members()).resolves.toEqual(
      expect.arrayContaining([GRANDCHILD_PID]),
    );
    expect(api.callsOf(JobOp.close)).toHaveLength(0);

    root.exit();
    await expect(ops.members()).resolves.toEqual(
      expect.arrayContaining([GRANDCHILD_PID]),
    );
    expect(api.callsOf(JobOp.close)).toHaveLength(0);

    api.exit(FIRST_JOB, GRANDCHILD_PID);
    api.exit(FIRST_JOB, ROOT_PID);
    await expect(ops.members()).resolves.toEqual([]);
    await expect(ops.members()).resolves.toEqual([]);
    expect(api.callsOf(JobOp.close)).toHaveLength(1);
  });

  it("handle_is_closed_when_the_job_is_empty_even_if_the_root_exit_is_late", async () => {
    const { api, container } = setup();
    const root = rootProcess();
    const { ops } = await container.launch(SPEC, launcherOf(root));
    await ops.killMembers();

    await expect(ops.members()).resolves.toEqual([]);

    expect(root.hasExited()).toBe(false);
    expect(api.callsOf(JobOp.close).map((call) => call.job)).toEqual([
      FIRST_JOB,
    ]);
    await expect(ops.members()).resolves.toEqual([]);
    await ops.killMembers();
    expect(api.callsOf(JobOp.close)).toHaveLength(1);
    expect(api.callsOf(JobOp.terminate)).toHaveLength(1);
  });
});

describe("job object container kill", () => {
  it("kill_after_close_is_noop", async () => {
    const { api, container } = setup();
    api.processesExist = false;
    const { ops } = await container.launch(SPEC, launcherOf(rootProcess(true)));
    await ops.members();

    await ops.killMembers();

    expect(api.callsOf(JobOp.terminate)).toHaveLength(0);
  });

  it("kill_members_terminates_the_job", async () => {
    const { api, container } = setup();
    const { ops } = await container.launch(SPEC, launcherOf(rootProcess()));
    api.adopt(FIRST_JOB, GRANDCHILD_PID);

    await ops.killMembers();

    expect(api.callsOf(JobOp.terminate).map((call) => call.job)).toEqual([
      FIRST_JOB,
    ]);
    await expect(ops.members()).resolves.toEqual([]);
  });
});

describe("job object container launch options", () => {
  it("windows_verbatim_arguments_reach_the_launcher", async () => {
    const { container } = setup();
    const received: LaunchOptions[] = [];
    const recording: Launcher<RootProcess> = (_command, _args, options) => {
      received.push(options);
      return Promise.resolve(rootProcess());
    };

    await container.launch(
      { ...SPEC, windowsVerbatimArguments: true },
      recording,
    );
    await container.launch({ ...SPEC, runId: "run-2" }, recording);

    expect(received).toStrictEqual([
      {
        env: { PATH: "C:\\bin", CODEWEAVE_RUN_ID: `${INSTANCE_ID}:run-1` },
        cwd: SPEC.cwd,
        windowsVerbatimArguments: true,
      },
      {
        env: { PATH: "C:\\bin", CODEWEAVE_RUN_ID: `${INSTANCE_ID}:run-2` },
        cwd: SPEC.cwd,
      },
    ]);
  });

  it("invalid_run_id_is_rejected", async () => {
    const { api, container } = setup();
    const launcher = vi.fn(launcherOf(rootProcess()));

    const outcome = container.launch({ ...SPEC, runId: "bad id!" }, launcher);

    await expect(outcome).rejects.toBeInstanceOf(RangeError);
    expect(launcher).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("sweep_reports_nothing_to_do", async () => {
    const { container } = setup();

    await expect(container.sweepOrphans(["OLD_INSTANCE"])).resolves.toBe(0);
  });
});

describe("enterAppJob", () => {
  it("self_job_failure_does_not_block_runs", async () => {
    const success = new FakeJobApi();

    const handle = enterAppJob(success);

    expect(handle).toBe(FIRST_JOB);
    expect(success.callsOf(JobOp.assignSelf)).toEqual([
      { op: JobOp.assignSelf, job: FIRST_JOB, pid: null },
    ]);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = new FakeJobApi();
    failing.assignSelfFailure = new JobApiError("already in a job");

    expect(enterAppJob(failing)).toBeNull();

    const container = createJobObjectContainer({
      api: failing,
      instanceId: INSTANCE_ID,
    });
    const { process } = await container.launch(SPEC, launcherOf(rootProcess()));
    expect(process.pid).toBe(ROOT_PID);
  });
});
