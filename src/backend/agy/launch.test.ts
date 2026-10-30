import { describe, expect, it } from "vitest";

import { PermissionProfile } from "../../domain/types";

import { agyTurnLine, buildAgyLaunch, buildAgyUsageLaunch } from "./launch";
import { agySettingsFor } from "./permissions";

const EXECUTABLE = "/home/jane/.local/bin/agy";
const ENV = { PATH: "/usr/bin", AGY_CLI_DISABLE_AUTO_UPDATE: "0" };

function launchFor(
  profile: PermissionProfile,
  conversationId: string | null,
): ReturnType<typeof buildAgyLaunch> {
  return buildAgyLaunch({
    executable: EXECUTABLE,
    env: ENV,
    permissions: agySettingsFor(profile),
    conversationId,
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
      "-p=",
    ]);
  });

  it("resumed_plan_conversation_orders_mode_then_conversation_then_prompt", () => {
    const launch = launchFor(PermissionProfile.plan, "conv-7");

    expect(launch.args.slice(6)).toEqual([
      "--mode",
      "plan",
      "--conversation",
      "conv-7",
      "-p=",
    ]);
  });

  it("settings_argument_is_the_json_of_the_profile_settings", () => {
    const launch = launchFor(PermissionProfile.ask, null);

    expect(JSON.parse(launch.args[5] ?? "null")).toMatchObject({
      toolPermission: "request-review",
      useG1Credits: false,
      permissions: {
        deny: expect.arrayContaining(["write_file(*)"]) as unknown,
      },
    });
  });
});

describe("agy launch environment and turn lines", () => {
  it("env_keeps_the_input_and_forces_auto_update_off", () => {
    const launch = launchFor(PermissionProfile.ask, null);

    expect(launch.env).toEqual({
      PATH: "/usr/bin",
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    });
    expect(ENV.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("0");
  });

  it("usage_launch_asks_for_json_output_of_the_usage_command", () => {
    const launch = buildAgyUsageLaunch({ executable: EXECUTABLE, env: ENV });

    expect(launch.args).toEqual(["-p", "/usage", "--output-format", "json"]);
    expect(launch.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
  });

  it("turn_line_is_one_json_line_with_escaped_newlines", () => {
    expect(agyTurnLine("a\nb é")).toBe(
      '{"event":"user","message":{"role":"user","content":"a\\nb é"}}\n',
    );
  });
});
