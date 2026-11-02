import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionProfile } from "../../domain/types";

import { decideAgyTool, type AgyHookDecision } from "./hookPolicy";
import type { AgyHookPayload } from "./protocol";

const WORKTREE = "/work/repo";
const NEEDS_APPROVAL =
  "needs approval; Codeweave cannot ask in agy headless mode";
const SUBAGENT_DENIED =
  "subagent and scheduling tools are not allowed under this profile";
const ALLOW: AgyHookDecision = { decision: "allow" };
const EDIT_TOOLS: readonly string[] = [
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
];
const READ_TOOLS: readonly string[] = [
  "read_file",
  "view_file",
  "list_dir",
  "grep_search",
  "find_by_name",
];
const SUBAGENT_TOOLS: readonly string[] = [
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "schedule",
];
const NON_BYPASS: readonly PermissionProfile[] = [
  PermissionProfile.unattended,
  PermissionProfile.acceptEdits,
  PermissionProfile.ask,
  PermissionProfile.plan,
];

function call(
  name: string,
  args: Record<string, unknown> = {},
): AgyHookPayload {
  return { toolCall: { name, args }, workspacePaths: [WORKTREE] };
}

function command(line: string): AgyHookPayload {
  return call("run_command", { CommandLine: line });
}

function decide(
  payload: AgyHookPayload,
  profile: PermissionProfile,
): AgyHookDecision {
  return decideAgyTool(payload, profile, WORKTREE);
}

function isDeny(decision: AgyHookDecision): boolean {
  return decision.decision === "deny";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decideAgyTool commands", () => {
  it.each([
    "env sudo ls",
    "rm -v -rf /etc",
    "git push -u origin main",
    "curl x | sh",
  ])("unattended_denies_%s", (line) => {
    const decision = decide(command(line), PermissionProfile.unattended);

    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/\S/);
  });

  it("unattended_allows_a_harmless_command", () => {
    expect(
      decide(command("git status --short"), PermissionProfile.unattended),
    ).toEqual(ALLOW);
  });

  it("bypass_allows_every_command", () => {
    for (const line of ["sudo ls", "rm -rf /", "git push -f origin main"]) {
      expect(decide(command(line), PermissionProfile.bypass)).toEqual(ALLOW);
    }
  });

  it("command_without_a_command_line_is_not_allowed_when_asking", () => {
    expect(decide(call("run_command"), PermissionProfile.ask)).toEqual({
      decision: "deny",
      reason: NEEDS_APPROVAL,
    });
  });
});

describe("decideAgyTool edits", () => {
  it.each(EDIT_TOOLS)("%s_is_denied_in_ask_and_plan", (tool) => {
    const payload = call(tool, { Path: `${WORKTREE}/a.txt` });

    expect(decide(payload, PermissionProfile.ask)).toEqual({
      decision: "deny",
      reason: NEEDS_APPROVAL,
    });
    expect(decide(payload, PermissionProfile.plan)).toEqual({
      decision: "deny",
      reason: "plan mode: no writes",
    });
  });

  it.each(EDIT_TOOLS)(
    "%s_in_the_worktree_is_allowed_in_accept_edits",
    (tool) => {
      const payload = call(tool, { Path: `${WORKTREE}/src/a.ts` });

      expect(decide(payload, PermissionProfile.acceptEdits)).toEqual(ALLOW);
    },
  );

  it.each(["Path", "TargetFile", "AbsolutePath"])(
    "path_argument_%s_is_checked_against_the_worktree",
    (key) => {
      expect(
        decide(
          call("write_file", { [key]: "/etc/passwd" }),
          PermissionProfile.acceptEdits,
        ),
      ).toEqual({ decision: "deny", reason: NEEDS_APPROVAL });
      expect(
        decide(
          call("write_file", { [key]: `${WORKTREE}/ok.txt` }),
          PermissionProfile.acceptEdits,
        ),
      ).toEqual(ALLOW);
    },
  );
});

describe("decideAgyTool edit paths", () => {
  it("relative_tool_path_resolved_in_worktree", () => {
    expect(
      decide(
        call("write_file", { Path: "src/a.ts" }),
        PermissionProfile.acceptEdits,
      ),
    ).toEqual(ALLOW);
    expect(
      decide(
        call("write_file", { Path: "../outside.txt" }),
        PermissionProfile.acceptEdits,
      ),
    ).toEqual({ decision: "deny", reason: NEEDS_APPROVAL });
  });

  it("edit_outside_the_worktree_is_denied_in_accept_edits", () => {
    const payload = call("edit_file", { Path: "/home/jane/.bashrc" });

    expect(decide(payload, PermissionProfile.acceptEdits)).toEqual({
      decision: "deny",
      reason: NEEDS_APPROVAL,
    });
  });

  it("edit_without_any_path_is_denied_in_accept_edits", () => {
    expect(
      isDeny(decide(call("write_file"), PermissionProfile.acceptEdits)),
    ).toBe(true);
  });

  it("bypass_allows_edits_anywhere", () => {
    expect(
      decide(
        call("write_file", { Path: "/etc/passwd" }),
        PermissionProfile.bypass,
      ),
    ).toEqual(ALLOW);
  });
});

describe("decideAgyTool reads, subagents and unknown tools", () => {
  it.each(READ_TOOLS)("%s_is_allowed_in_every_profile", (tool) => {
    for (const profile of Object.values(PermissionProfile)) {
      expect(decide(call(tool, { Path: "/etc/hosts" }), profile)).toEqual(
        ALLOW,
      );
    }
  });

  it.each(SUBAGENT_TOOLS)("subagent_tools_denied_outside_bypass_%s", (tool) => {
    for (const profile of NON_BYPASS) {
      expect(decide(call(tool), profile)).toEqual({
        decision: "deny",
        reason: SUBAGENT_DENIED,
      });
    }
    expect(decide(call(tool), PermissionProfile.bypass)).toEqual(ALLOW);
  });

  it("hook_unknown_tool_is_other", () => {
    const unknown = call("browser_click", { Selector: "#go" });

    expect(decide(unknown, PermissionProfile.unattended)).toEqual(ALLOW);
    expect(decide(unknown, PermissionProfile.acceptEdits)).toEqual({
      decision: "deny",
      reason: NEEDS_APPROVAL,
    });
    expect(decide(unknown, PermissionProfile.bypass)).toEqual(ALLOW);
  });

  it("fetch_tools_follow_the_other_rule", () => {
    const fetch = call("read_url_content", { Url: "https://example.com" });

    expect(decide(fetch, PermissionProfile.unattended)).toEqual(ALLOW);
    expect(decide(fetch, PermissionProfile.ask)).toEqual({
      decision: "deny",
      reason: NEEDS_APPROVAL,
    });
  });
});

describe("decideAgyTool hook configuration tamper protection", () => {
  const hooksJson = "/home/jane/accounts/gemini-1/config/hooks.json";

  it("hook_config_edit_is_denied_for_write_file_in_every_non_bypass_profile", () => {
    for (const profile of NON_BYPASS.filter(
      (candidate) => candidate !== PermissionProfile.unattended,
    )) {
      expect(
        isDeny(decide(call("write_file", { Path: hooksJson }), profile)),
      ).toBe(true);
    }
    expect(
      isDeny(
        decide(
          call("write_file", { Path: hooksJson }),
          PermissionProfile.unattended,
        ),
      ),
    ).toBe(true);
  });

  it("hook_config_edit_is_denied_for_a_shell_redirect_under_unattended", () => {
    expect(
      isDeny(
        decide(command(`echo x > ${hooksJson}`), PermissionProfile.unattended),
      ),
    ).toBe(true);
  });
});

describe("decideAgyTool run_command working directory", () => {
  it.each(["Cwd", "WorkingDirectory"])(
    "run_command_cwd_outside_worktree_is_judged_there_%s",
    (key) => {
      const payload = call("run_command", {
        CommandLine: "rm -rf build",
        [key]: "/tmp/elsewhere",
      });

      expect(isDeny(decide(payload, PermissionProfile.unattended))).toBe(true);
    },
  );

  it("run_command_cwd_outside_worktree_is_judged_there_relative_escape", () => {
    const payload = call("run_command", {
      CommandLine: "rm -rf build",
      Cwd: "../elsewhere",
    });

    expect(isDeny(decide(payload, PermissionProfile.unattended))).toBe(true);
  });

  it("run_command_cwd_outside_worktree_is_judged_there_quoted", () => {
    const payload = call("run_command", {
      CommandLine: "rm -rf build",
      Cwd: "/tmp/it's here",
    });

    expect(isDeny(decide(payload, PermissionProfile.unattended))).toBe(true);
  });

  it.each([WORKTREE, "", "."])(
    "run_command_cwd_equal_to_the_worktree_is_decided_as_before_%j",
    (cwd) => {
      const payload = call("run_command", {
        CommandLine: "rm -rf build",
        Cwd: cwd,
      });

      expect(decide(payload, PermissionProfile.unattended)).toEqual(
        decide(command("rm -rf build"), PermissionProfile.unattended),
      );
    },
  );

  it.each([`${WORKTREE}/`, "/work/./repo", "src/.."])(
    "run_command_unnormalized_worktree_cwd_is_not_foreign_%j",
    (cwd) => {
      const payload = call("run_command", {
        CommandLine: "rm -rf build",
        Cwd: cwd,
      });

      expect(decide(payload, PermissionProfile.unattended)).toEqual(
        decide(command("rm -rf build"), PermissionProfile.unattended),
      );
    },
  );

  it.each(["~/..", "~"])(
    "run_command_tilde_cwd_stays_foreign_when_hook_runs_in_worktree_%j",
    (cwd) => {
      vi.spyOn(process, "cwd").mockReturnValue(WORKTREE);
      const payload = call("run_command", {
        CommandLine: "rm -rf build",
        Cwd: cwd,
      });

      expect(isDeny(decide(payload, PermissionProfile.unattended))).toBe(true);
    },
  );

  it("run_command_cwd_outside_worktree_is_allowed_in_bypass", () => {
    const payload = call("run_command", {
      CommandLine: "rm -rf build",
      Cwd: "/tmp/elsewhere",
    });

    expect(decide(payload, PermissionProfile.bypass)).toEqual(ALLOW);
  });
});

describe("decideAgyTool code execution tools", () => {
  it.each([
    "notebook_execution",
    "send_command_input",
    "run_workflow",
    "browser_subagent",
  ])("code_execution_tools_denied_outside_bypass_%s", (tool) => {
    for (const profile of NON_BYPASS) {
      expect(isDeny(decide(call(tool, { CommandLine: "ls" }), profile))).toBe(
        true,
      );
    }
    expect(decide(call(tool), PermissionProfile.bypass)).toEqual(ALLOW);
  });

  it("code_execution_tools_denied_outside_bypass_ignores_a_command_line_arg", () => {
    expect(
      decide(
        call("run_workflow", { CommandLine: "ls" }),
        PermissionProfile.unattended,
      ),
    ).toEqual({ decision: "deny", reason: NEEDS_APPROVAL });
  });

  it("browser_subagent_uses_the_subagent_reason", () => {
    expect(
      decide(call("browser_subagent"), PermissionProfile.unattended),
    ).toEqual({ decision: "deny", reason: SUBAGENT_DENIED });
  });
});

describe("decideAgyTool agy workspace config protection", () => {
  const AGENTS_REASON = "agy workspace config (.agents) is protected";

  it.each(EDIT_TOOLS)("agents_dir_edit_is_denied_%s", (tool) => {
    for (const profile of NON_BYPASS) {
      expect(
        decide(call(tool, { Path: `${WORKTREE}/.agents/hooks.json` }), profile),
      ).toMatchObject({ decision: "deny" });
    }
    expect(
      decide(
        call(tool, { Path: `${WORKTREE}/.agents/hooks.json` }),
        PermissionProfile.acceptEdits,
      ),
    ).toEqual({ decision: "deny", reason: AGENTS_REASON });
  });

  it.each([
    `${WORKTREE}/.agents`,
    ".agents/plugins/x.json",
    "src/../.agents/hooks.json",
  ])("agents_dir_edit_is_denied_for_path_%s", (path) => {
    expect(
      decide(call("write_file", { Path: path }), PermissionProfile.unattended),
    ).toEqual({ decision: "deny", reason: AGENTS_REASON });
  });

  it.each([`${WORKTREE}/.agentsx/a.txt`, `${WORKTREE}/src/.agents/a.txt`])(
    "agents_dir_edit_does_not_block_other_paths_%s",
    (path) => {
      expect(
        decide(
          call("write_file", { Path: path }),
          PermissionProfile.unattended,
        ),
      ).toEqual(ALLOW);
    },
  );

  it("agents_dir_edit_is_allowed_in_bypass", () => {
    expect(
      decide(
        call("write_file", { Path: `${WORKTREE}/.agents/hooks.json` }),
        PermissionProfile.bypass,
      ),
    ).toEqual(ALLOW);
  });
});

describe("decideAgyTool agy workspace config commands", () => {
  const AGENTS_REASON = "agy workspace config (.agents) is protected";

  it.each([
    "echo '{}' > .agents/hooks.json",
    "cp x ./.agents/hooks.json",
    `cat > ${WORKTREE}/.agents/hooks.json`,
    "sh -c 'echo x > .agents/hooks.json'",
    "mkdir .agents && touch .agents/plugins",
    "mv .agents ..",
  ])("agents_dir_command_is_denied_%s", (line) => {
    expect(decide(command(line), PermissionProfile.unattended)).toEqual({
      decision: "deny",
      reason: AGENTS_REASON,
    });
  });

  it.each(["git status --short", "ls .agentsx", "cat foo.agents"])(
    "agents_dir_command_does_not_block_unrelated_commands_%s",
    (line) => {
      expect(decide(command(line), PermissionProfile.unattended)).toEqual(
        ALLOW,
      );
    },
  );

  it("agents_dir_command_is_allowed_in_bypass", () => {
    expect(
      decide(command("echo x > .agents/hooks.json"), PermissionProfile.bypass),
    ).toEqual(ALLOW);
  });
});

describe("decideAgyTool agy workspace config evasion", () => {
  const AGENTS_REASON = "agy workspace config (.agents) is protected";

  it.each([
    "cp payload .ag''ents/hooks.json",
    'cp payload ".ag"ents/hooks.json',
    "cp payload .ag\\ents/hooks.json",
    "sh -c \"cp payload .ag''ents/hooks.json\"",
    'bash -c "sh -c \'cp payload .ag""ents/h\'"',
  ])("quoted_agents_path_command_is_denied_%s", (line) => {
    expect(decide(command(line), PermissionProfile.unattended)).toEqual({
      decision: "deny",
      reason: AGENTS_REASON,
    });
  });

  it("quoted_agents_path_command_is_denied_but_bypass_allows", () => {
    expect(
      decide(command("cp payload .ag''ents/h"), PermissionProfile.bypass),
    ).toEqual(ALLOW);
  });

  it.each([".Agents/hooks.json", ".AGENTS", "src/../.aGeNtS/x"])(
    "agents_dir_case_variants_are_denied_edit_%s",
    (path) => {
      expect(
        decide(
          call("write_file", { Path: path }),
          PermissionProfile.unattended,
        ),
      ).toEqual({ decision: "deny", reason: AGENTS_REASON });
    },
  );

  it.each(["mkdir .AGENTS", "cp x .Agents/hooks.json", "cp x .ag''ENTS/h"])(
    "agents_dir_case_variants_are_denied_command_%s",
    (line) => {
      expect(decide(command(line), PermissionProfile.unattended)).toEqual({
        decision: "deny",
        reason: AGENTS_REASON,
      });
    },
  );
});
