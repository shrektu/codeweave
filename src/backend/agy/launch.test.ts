import { isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PermissionProfile } from "../../domain/types";

import { agyTurnLine, buildAgyLaunch, buildAgyUsageLaunch } from "./launch";
import { agySettingsFor } from "./permissions";

const EXECUTABLE = "/home/jane/.local/bin/agy";
const ENV = { PATH: "/usr/bin" };
const CONFIG_DIR = "/home/jane/accounts/gemini-1";
const WORKTREE = "/work/repo";

function launchFor(
  profile: PermissionProfile,
  conversationId: string | null,
): ReturnType<typeof buildAgyLaunch> {
  return buildAgyLaunch({
    executable: EXECUTABLE,
    env: ENV,
    permissions: agySettingsFor(profile),
    conversationId,
    configDir: CONFIG_DIR,
    profile,
    worktreeRoot: WORKTREE,
  });
}

describe("agy launch arguments", () => {
  it("fresh_conversation_has_no_conversation_flag_and_ends_with_empty_prompt", () => {
    const launch = launchFor(PermissionProfile.bypass, null);

    expect(launch.command).toBe(EXECUTABLE);
    expect(launch.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--settings",
      '{"toolPermission":"always-proceed","useG1Credits":false}',
      `--gemini_dir=${resolve(CONFIG_DIR)}`,
      "-p=",
    ]);
  });

  it("resumed_plan_conversation_orders_mode_conversation_gemini_dir_prompt", () => {
    const launch = launchFor(PermissionProfile.plan, "conv-7");

    expect(launch.args.slice(6)).toEqual([
      "--mode",
      "plan",
      "--conversation",
      "conv-7",
      `--gemini_dir=${resolve(CONFIG_DIR)}`,
      "-p=",
    ]);
  });

  it("settings_argument_is_the_json_of_the_profile_settings", () => {
    const launch = launchFor(PermissionProfile.ask, null);

    expect(JSON.parse(launch.args[5] ?? "null")).toEqual({
      toolPermission: "always-proceed",
      useG1Credits: false,
    });
  });

  it("relative_config_dir_becomes_an_absolute_gemini_dir", () => {
    const launch = buildAgyLaunch({
      executable: EXECUTABLE,
      env: ENV,
      permissions: agySettingsFor(PermissionProfile.ask),
      conversationId: null,
      configDir: "accounts/one",
      profile: PermissionProfile.ask,
      worktreeRoot: WORKTREE,
    });

    const flag = launch.args.find((arg) => arg.startsWith("--gemini_dir="));
    expect(flag).toBe(`--gemini_dir=${resolve("accounts/one")}`);
    expect(isAbsolute(flag?.slice("--gemini_dir=".length) ?? "")).toBe(true);
  });
});

describe("agy launch environment and turn lines", () => {
  it("env_keeps_the_input_and_names_profile_and_worktree", () => {
    const launch = launchFor(PermissionProfile.ask, null);

    expect(launch.env).toEqual({
      PATH: "/usr/bin",
      CODEWEAVE_AGY_PROFILE: "ask",
      CODEWEAVE_AGY_WORKTREE: WORKTREE,
    });
    expect(launch.env).not.toBe(ENV);
  });

  it("usage_launch_asks_for_json_output_of_the_usage_command", () => {
    const launch = buildAgyUsageLaunch({
      executable: EXECUTABLE,
      env: ENV,
      configDir: CONFIG_DIR,
    });

    expect(launch.args).toEqual([
      "-p",
      "/usage",
      "--output-format",
      "json",
      `--gemini_dir=${resolve(CONFIG_DIR)}`,
    ]);
    expect(launch.env).toEqual({ PATH: "/usr/bin" });
  });

  it("turn_line_is_one_json_line_with_escaped_newlines", () => {
    expect(agyTurnLine("a\nb é")).toBe(
      '{"event":"user","message":{"role":"user","content":"a\\nb é"}}\n',
    );
  });
});
