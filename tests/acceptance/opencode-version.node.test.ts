import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { ExecText } from "../../src/backend/exec";
import { createVersionProbe } from "../../src/backend/opencode/version";
import {
  OPENCODE_RIG_EXECUTABLE,
  createOpencodeRig,
  disposeOpencodeRigs,
  type OpencodeRig,
} from "../fakes/fakeOpencodeServer";

const UNSUPPORTED_MESSAGE =
  "OpenCode 2.3.2 is not supported. Codeweave works with opencode 1.19.x (npm i -g opencode-ai@1.19.5).";
const UNDETECTABLE_MESSAGE =
  "The OpenCode version could not be determined. Codeweave works with opencode 1.19.x (npm i -g opencode-ai@1.19.5).";

afterEach(disposeOpencodeRigs);

function rigPrinting(
  exec: ExecText,
  platform: NodeJS.Platform = "linux",
): Promise<OpencodeRig> {
  return createOpencodeRig({
    generationFor: createVersionProbe({ exec, platform }),
  });
}

function printing(stdout: string): ReturnType<typeof vi.fn<ExecText>> {
  return vi.fn<ExecText>(() => Promise.resolve(stdout));
}

it("refuses_the_second_start_after_opencode_was_upgraded_in_place", async () => {
  const exec = vi
    .fn<ExecText>()
    .mockResolvedValueOnce("1.19.5\n")
    .mockResolvedValueOnce("opencode v2.3.2\n");
  const rig = await createOpencodeRig({
    generationFor: createVersionProbe({ exec, platform: "linux" }),
  });
  const first = await rig.start();
  if (first.ok) {
    await first.handle.stop(0);
  }

  const second = await rig.start(undefined, "run-2");

  expect(first.ok).toBe(true);
  expect(second).toEqual({
    ok: false,
    reason: "error",
    message: UNSUPPORTED_MESSAGE,
  });
  expect(rig.container.specs).toHaveLength(1);
});

it("probes_the_version_in_the_session_directory", async () => {
  const exec = printing("1.19.5\n");
  const rig = await rigPrinting(exec);

  await rig.start();

  expect(exec.mock.calls[0]?.[2]).toMatchObject({ cwd: rig.cwd });
});

it("fails_the_start_with_the_unsupported_version_message_on_opencode_2x", async () => {
  const rig = await rigPrinting(printing("opencode v2.3.2\n"));

  const result = await rig.start();

  expect(result).toEqual({
    ok: false,
    reason: "error",
    message: UNSUPPORTED_MESSAGE,
  });
  expect(rig.container.specs).toHaveLength(0);
  expect(await readdir(rig.runtimeRoot)).toEqual([]);
});

it("fails_the_start_when_the_version_command_fails", async () => {
  const rig = await rigPrinting(
    vi.fn<ExecText>(() => Promise.reject(new Error("spawn opencode ENOENT"))),
  );

  const result = await rig.start();

  expect(result).toEqual({
    ok: false,
    reason: "error",
    message: UNDETECTABLE_MESSAGE,
  });
  expect(rig.container.specs).toHaveLength(0);
  expect(await readdir(rig.runtimeRoot)).toEqual([]);
});

it("fails_the_start_when_the_version_output_is_unreadable", async () => {
  const rig = await rigPrinting(printing("garbage\n"));

  const result = await rig.start();

  expect(result).toEqual({
    ok: false,
    reason: "error",
    message: UNDETECTABLE_MESSAGE,
  });
  expect(rig.container.specs).toHaveLength(0);
});

it("starts_on_opencode_1_19_5_after_one_version_call_with_the_account_dirs", async () => {
  const exec = printing("1.19.5\n");
  const rig = await rigPrinting(exec);

  const result = await rig.start();

  expect(result.ok).toBe(true);
  expect(exec).toHaveBeenCalledTimes(1);
  const [file, args, options] = exec.mock.calls[0] ?? [];
  expect(file).toBe(OPENCODE_RIG_EXECUTABLE);
  expect(args).toEqual(["--version"]);
  expect(options?.env).toMatchObject({
    HOME: join(rig.accountDir, "home"),
    XDG_CONFIG_HOME: join(rig.accountDir, "config"),
    XDG_DATA_HOME: join(rig.accountDir, "data"),
    XDG_CACHE_HOME: join(rig.accountDir, "cache"),
    XDG_STATE_HOME: join(rig.accountDir, "state"),
  });
  expect(rig.container.specs).toHaveLength(1);
});
