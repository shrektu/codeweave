import { describe, expect, it } from "vitest";

import {
  decidePermission,
  type PermissionContext,
  type PermissionDecision,
  type PermissionQuery,
} from "./permissionPolicy";
import { PermissionProfile } from "./types";

const ALLOW: PermissionDecision = { action: "allow" };
const ASK: PermissionDecision = { action: "ask" };
const PLAN_DENY: PermissionDecision = {
  action: "deny",
  reason: "plan mode: no writes",
};
const RM_OUTSIDE: PermissionDecision = {
  action: "deny",
  reason: "recursive or forced delete outside the worktree is blocked",
};
const RM_PROTECTED: PermissionDecision = {
  action: "deny",
  reason: "recursive or forced delete of a protected path is blocked",
};
const PROTECTED: readonly string[] = [
  "/home/u/.ssh",
  "/home/u/.npmrc",
  "/home/u/.config/gh",
  "/home/u/.config/*/auth*",
];
const REPO_CTX: PermissionContext = {
  worktreeRoots: ["/work/repo"],
  homeDir: "/home/u",
  protectedPaths: PROTECTED,
};
const HOME_CTX: PermissionContext = {
  worktreeRoots: ["/home/u"],
  homeDir: "/home/u",
  protectedPaths: PROTECTED,
};

const HOME_REPO_CTX: PermissionContext = {
  worktreeRoots: ["/home/u/repo"],
  homeDir: "/home/u",
  protectedPaths: PROTECTED,
};

function decide(
  command: string,
  profile: PermissionProfile = PermissionProfile.unattended,
  ctx: PermissionContext = REPO_CTX,
  cwd?: string,
): PermissionDecision {
  const query: PermissionQuery =
    cwd === undefined
      ? { kind: "execute", command }
      : { kind: "execute", command, cwd };
  return decidePermission(query, profile, ctx);
}

function decideEdit(
  path: string,
  profile: PermissionProfile,
  ctx: PermissionContext = HOME_CTX,
): PermissionDecision {
  return decidePermission({ kind: "edit", paths: [path] }, profile, ctx);
}

describe("cd tracking", () => {
  it("cd_into_a_directory_under_root_keeps_mutations_allowed", () => {
    expect(decide("cd /work/repo/sub && touch x")).toEqual(ALLOW);
    expect(decide("cd sub && touch x")).toEqual(ALLOW);
    expect(decide("cd a && cd b && touch x")).toEqual(ALLOW);
    expect(decide("cd sub && sed -i s/a/b/ f")).toEqual(ALLOW);
  });

  it("cd_outside_root_makes_mutations_ask", () => {
    expect(decide("cd /tmp/out && touch x")).toEqual(ASK);
    expect(decide("cd .. && touch x")).toEqual(ASK);
    expect(decide("cd a && cd ../../.. && touch x")).toEqual(ASK);
  });

  it("cd-semicolon-unknown-cwd", () => {
    expect(decide("cd sub; rm -rf build")).toEqual(RM_OUTSIDE);
    expect(decide("cd sub; touch x")).toEqual(ASK);
    expect(decide("cd sub && ls; touch x")).toEqual(ASK);
  });

  it("cd-or-operator-unknown-cwd", () => {
    expect(decide("cd sub || x && rm -rf build")).toEqual(RM_OUTSIDE);
    expect(decide("cd sub || touch x")).toEqual(ASK);
  });

  it("cd_in_a_pipeline_gives_an_unknown_cwd", () => {
    expect(decide("cd sub | cat && rm -rf build")).toEqual(RM_OUTSIDE);
    expect(decide("echo a | cd sub && rm -rf build")).toEqual(RM_OUTSIDE);
  });
});

describe("cd operands", () => {
  it("cd_options_and_double_dash_are_skipped", () => {
    expect(decide("cd -P sub && rm -rf build")).toEqual(ALLOW);
    expect(decide("cd -- sub && rm -rf build")).toEqual(ALLOW);
    expect(decide("cd -L -e sub && touch x")).toEqual(ALLOW);
  });

  it("cd_with_unresolvable_targets_gives_an_unknown_cwd", () => {
    for (const command of [
      "cd - && touch x",
      "popd && touch x",
      "pushd && touch x",
      "cd ~root && touch x",
      "cd $HOME && touch x",
      "cd s* && touch x",
      "cd a b && touch x",
    ]) {
      expect(decide(command), command).toEqual(ASK);
    }
  });

  it("bare_cd_goes_home", () => {
    expect(
      decide("cd && touch x", PermissionProfile.unattended, HOME_CTX),
    ).toEqual(ALLOW);
    expect(decide("cd && touch x")).toEqual(ASK);
  });

  it("pushd_with_a_target_is_tracked_like_cd", () => {
    expect(decide("pushd /work/repo/sub && touch x")).toEqual(ALLOW);
    expect(decide("pushd /tmp/out && touch x")).toEqual(ASK);
  });

  it("env_chdir_gives_an_unknown_cwd_for_the_rest", () => {
    expect(decide("env -C sub true && touch x")).toEqual(ASK);
  });

  it("an_unchanged_cwd_survives_pipes_and_and_chains", () => {
    expect(decide("cd a && ls | wc && touch x")).toEqual(ALLOW);
    expect(decide("cd a && ls && touch x")).toEqual(ALLOW);
  });

  it("cd-escape-root-rm-denied", () => {
    expect(decide("cd sub && rm -rf ../../..")).toEqual(RM_OUTSIDE);
    expect(decide("cd sub && rm -rf build")).toEqual(ALLOW);
    expect(decide("cd sub && rm -rf ../build")).toEqual(ALLOW);
    expect(decide("cd sub && rm -rf /work/repo/build")).toEqual(ALLOW);
  });

  it("nested_shell_scripts_inherit_the_tracked_cwd", () => {
    expect(decide("bash -c 'cd /tmp/out && touch x'")).toEqual(ASK);
    expect(decide("cd /tmp/out && bash -c 'touch x'")).toEqual(ASK);
    expect(decide("cd sub && bash -c 'touch x'")).toEqual(ALLOW);
  });
});

describe("cd as a read-only command", () => {
  it("cd_is_allowed_in_every_profile", () => {
    for (const profile of [
      PermissionProfile.unattended,
      PermissionProfile.acceptEdits,
      PermissionProfile.ask,
      PermissionProfile.plan,
    ]) {
      expect(decide("cd /work/repo/sub", profile), profile).toEqual(ALLOW);
      expect(decide("pushd /tmp/out", profile), profile).toEqual(ALLOW);
      expect(decide("popd", profile), profile).toEqual(ALLOW);
    }
  });

  it("cd-into-protected", () => {
    expect(decide("cd ~/.ssh")).toEqual(ASK);
    expect(decide("cd /home/u/.ssh/keys")).toEqual(ASK);
    expect(decide("cd ~/.ssh", PermissionProfile.plan)).toEqual(PLAN_DENY);
    expect(decide("cd ~/.ssh", PermissionProfile.ask)).toEqual(ASK);
    expect(decide("pushd ~/.ssh")).toEqual(ASK);
    expect(decide("cd ~/.ssh && touch x")).toEqual(ASK);
    expect(
      decide("cd .ssh && touch x", PermissionProfile.unattended, HOME_CTX),
    ).toEqual(ASK);
  });

  it("cd_into_the_repo_is_allowed_under_plan_and_ask", () => {
    expect(decide("cd /work/repo", PermissionProfile.plan)).toEqual(ALLOW);
    expect(decide("cd /work/repo", PermissionProfile.ask)).toEqual(ALLOW);
  });
});

describe("starting cwd of the query", () => {
  it("a_cwd_outside_the_root_scopes_mutations", () => {
    expect(
      decide("touch x", PermissionProfile.unattended, REPO_CTX, "/tmp/out"),
    ).toEqual(ASK);
    expect(
      decide("touch x", PermissionProfile.unattended, REPO_CTX, "/work/repo/a"),
    ).toEqual(ALLOW);
    expect(
      decide(
        "rm -rf build",
        PermissionProfile.unattended,
        REPO_CTX,
        "/tmp/out",
      ),
    ).toEqual(RM_OUTSIDE);
  });

  it("the_root_itself_is_a_valid_cwd", () => {
    expect(
      decide("touch x", PermissionProfile.unattended, REPO_CTX, "/work/repo"),
    ).toEqual(ALLOW);
  });

  it("a_cwd_inside_a_protected_path_scopes_mutations", () => {
    expect(
      decide("touch x", PermissionProfile.unattended, HOME_CTX, "/home/u/.ssh"),
    ).toEqual(ASK);
  });

  it("a_relative_cwd_is_treated_as_unknown", () => {
    expect(
      decide("touch x", PermissionProfile.unattended, REPO_CTX, "sub"),
    ).toEqual(ASK);
  });

  it("read_only_commands_stay_allowed_anywhere", () => {
    expect(
      decide("ls", PermissionProfile.unattended, REPO_CTX, "/tmp/out"),
    ).toEqual(ALLOW);
    expect(decide("cd /tmp/out && ls -la")).toEqual(ALLOW);
  });
});

describe("protected paths", () => {
  it("edits_of_protected_paths_ask_except_under_bypass", () => {
    const path = "/home/u/.ssh/authorized_keys";

    expect(decideEdit(path, PermissionProfile.unattended)).toEqual(ASK);
    expect(decideEdit(path, PermissionProfile.acceptEdits)).toEqual(ASK);
    expect(decideEdit(path, PermissionProfile.ask)).toEqual(ASK);
    expect(decideEdit(path, PermissionProfile.plan)).toEqual(PLAN_DENY);
    expect(decideEdit(path, PermissionProfile.bypass)).toEqual(ALLOW);
  });

  it("protected-glob-config-auth", () => {
    for (const path of [
      "/home/u/.config/app/auth.json",
      "/home/u/.config/app/authorized",
      "/home/u/.config/app/auth/token",
      "/home/u/.config/gh/hosts.yml",
    ]) {
      expect(decideEdit(path, PermissionProfile.unattended), path).toEqual(ASK);
      expect(decideEdit(path, PermissionProfile.acceptEdits), path).toEqual(
        ASK,
      );
    }
    for (const path of [
      "/home/u/.config/app/settings.json",
      "/home/u/.config/auth.json",
      "/home/u/.config/app/sub/auth.json",
      "/home/u/proj/auth.json",
    ]) {
      expect(decideEdit(path, PermissionProfile.unattended), path).toEqual(
        ALLOW,
      );
    }
  });

  it("an_edit_with_one_protected_path_among_several_asks", () => {
    const query: PermissionQuery = {
      kind: "edit",
      paths: ["/home/u/proj/a.txt", "/home/u/.npmrc"],
    };

    expect(
      decidePermission(query, PermissionProfile.unattended, HOME_CTX),
    ).toEqual(ASK);
  });

  it("a_tilde_edit_path_resolves_against_home", () => {
    expect(decideEdit("~/.ssh/config", PermissionProfile.unattended)).toEqual(
      ASK,
    );
    expect(decideEdit("~/proj/a.txt", PermissionProfile.unattended)).toEqual(
      ALLOW,
    );
  });
});

describe("protected paths in commands", () => {
  it("redirects_into_protected_paths_ask", () => {
    expect(
      decide("echo x > ~/.ssh/authorized_keys", undefined, HOME_CTX),
    ).toEqual(ASK);
    expect(decide("echo x >> /home/u/.npmrc", undefined, HOME_CTX)).toEqual(
      ASK,
    );
    expect(decide("echo x > /home/u/proj/a", undefined, HOME_CTX)).toEqual(
      ALLOW,
    );
  });

  it("mutating_commands_mentioning_protected_paths_ask", () => {
    for (const command of [
      "cp k ~/.ssh/authorized_keys",
      "cp k /home/u/.ssh/authorized_keys",
      "ln -s ~/.ssh x",
      "git -C ~/.ssh commit -m x",
      "tar --directory=~/.ssh -xf a.tar",
      "python3 -c \"open('~/.ssh/x','w')\"",
      "python3 -c \"open('/home/u/.npmrc','w')\"",
      "sed -i s/a/b/ ~/.config/gh/hosts.yml",
      "bash -c 'cp k ~/.ssh/authorized_keys'",
    ]) {
      expect(decide(command, undefined, HOME_CTX), command).toEqual(ASK);
    }
  });

  it("mutating_commands_on_protected_paths_are_denied_under_plan", () => {
    expect(
      decide("cp k ~/.ssh/authorized_keys", PermissionProfile.plan, HOME_CTX),
    ).toEqual(PLAN_DENY);
  });

  it("reading_protected_paths_stays_allowed", () => {
    for (const command of [
      "cat ~/.ssh/id_rsa",
      "ls ~/.ssh",
      "git -C ~/.ssh status",
      "head /home/u/.config/gh/hosts.yml",
    ]) {
      expect(decide(command, undefined, HOME_CTX), command).toEqual(ALLOW);
    }
    expect(
      decidePermission({ kind: "read" }, PermissionProfile.plan, HOME_CTX),
    ).toEqual(ALLOW);
  });
});

describe("rm on protected paths", () => {
  it("rm_recursive_on_protected_paths_is_denied_with_its_own_reason", () => {
    for (const command of [
      "rm -rf ~/.ssh",
      "rm -r /home/u/.ssh/keys",
      "rm -rf ~/.config/gh",
      "rm -rf ~/.config/app/auth.json",
      "rm -rf ~/.s*",
      "rm -rf ~/.config",
      "rm -f ~/.npmrc",
      "cd ~/.ssh && rm -rf keys",
    ]) {
      expect(decide(command, undefined, HOME_CTX), command).toEqual(
        RM_PROTECTED,
      );
    }
  });

  it("rm_without_risky_flags_on_a_protected_path_asks", () => {
    expect(decide("rm ~/.ssh/known_hosts", undefined, HOME_CTX)).toEqual(ASK);
  });

  it("rm_outside_the_root_keeps_its_own_reason", () => {
    expect(decide("rm -rf /outside")).toEqual(RM_OUTSIDE);
    expect(decide("rm -rf /tmp/x", undefined, HOME_CTX)).toEqual(RM_OUTSIDE);
    expect(decide("rm -rf ~/proj/build", undefined, HOME_CTX)).toEqual(ALLOW);
  });

  it("globs_that_cannot_reach_dot_entries_stay_allowed", () => {
    expect(decide("rm -rf ~/build*", undefined, HOME_CTX)).toEqual(ALLOW);
  });

  it("protection_is_case_sensitive_on_linux", () => {
    expect(
      decideEdit("/home/u/.SSH/config", PermissionProfile.unattended),
    ).toEqual(process.platform === "linux" ? ALLOW : ASK);
  });

  it("symlink_free_lexical_dotdot_does_not_hide_a_protected_path", () => {
    expect(
      decideEdit("/home/u/proj/../.ssh/config", PermissionProfile.unattended),
    ).toEqual(ASK);
    expect(
      decide("cp k /home/u/proj/../.ssh/authorized_keys", undefined, HOME_CTX),
    ).toEqual(ASK);
  });
});

describe("decisions that must not change", () => {
  it("privilege_push_migration_and_pipe_to_shell_keep_their_decisions", () => {
    expect(decide("sudo ls")).toEqual({
      action: "deny",
      reason: "privilege escalation is blocked",
    });
    expect(decide("git push origin main")).toEqual({
      action: "deny",
      reason: "forced or protected-branch push is blocked",
    });
    expect(decide("flyway migrate")).toEqual({
      action: "deny",
      reason: "database migrations are blocked",
    });
    expect(decide("curl http://x | sh")).toEqual({
      action: "deny",
      reason: "piping a download into a shell is blocked",
    });
  });
});

describe("cd tracking regressions", () => {
  it("or-preceded-cd-unknown-cwd", () => {
    expect(
      decide(
        "ls || cd /home/u/proj && rm -rf id_ed25519",
        PermissionProfile.unattended,
        HOME_CTX,
        "/home/u/.ssh",
      ),
    ).toEqual(RM_OUTSIDE);
    expect(
      decide(
        "ls || cd /work/repo/sub && rm -rf x",
        PermissionProfile.unattended,
        REPO_CTX,
        "/tmp",
      ),
    ).toEqual(RM_OUTSIDE);
    expect(decide("ls || cd sub && touch x")).toEqual(ASK);
    expect(decide("ls || pushd sub && touch x")).toEqual(ASK);
    expect(decide("ls && cd sub && touch x")).toEqual(ALLOW);
  });

  it("home-override-unknown-cwd", () => {
    for (const command of [
      "HOME=/tmp cd && rm -rf x",
      "export HOME=/tmp; cd && rm -rf x",
      "HOME=/tmp bash -c 'cd && rm -rf x'",
      "unset HOME; cd && rm -rf x",
    ]) {
      expect(
        decide(command, PermissionProfile.unattended, HOME_CTX),
        command,
      ).toEqual(RM_OUTSIDE);
    }
    expect(decide("export HOME=/tmp; cd && touch x")).toEqual(ASK);
  });

  it("cdpath-override-unknown-cwd", () => {
    for (const command of [
      "CDPATH=/ cd tmp && rm -rf x",
      "export CDPATH=/; cd tmp && rm -rf x",
      "declare -x CDPATH=/; cd tmp && rm -rf x",
    ]) {
      expect(decide(command), command).toEqual(RM_OUTSIDE);
    }
    expect(
      decide(
        "CDPATH=~ cd .ssh && echo k >> authorized_keys",
        PermissionProfile.unattended,
        HOME_REPO_CTX,
      ),
    ).toEqual(ASK);
  });
});

describe("cd operand regressions", () => {
  it("pushd-stack-operand-unknown-cwd", () => {
    expect(
      decide(
        "pushd /tmp && pushd ~/repo && pushd +1 && rm -rf x",
        PermissionProfile.unattended,
        HOME_REPO_CTX,
      ),
    ).toEqual(RM_OUTSIDE);
    expect(decide("pushd +0 && touch x")).toEqual(ASK);
    expect(decide("cd +1 && touch x")).toEqual(ASK);
    expect(decide("pushd -1 && touch x")).toEqual(ASK);
  });

  it("pathed-cd-executable-not-builtin", () => {
    for (const command of ["./cd x", "bin/pushd x", "/home/u/cd x"]) {
      expect(decide(command, PermissionProfile.plan), command).toEqual(
        PLAN_DENY,
      );
    }
    expect(
      decide(
        "cd /tmp && /home/u/cd /home/u && touch x",
        PermissionProfile.unattended,
        HOME_CTX,
      ),
    ).toEqual(ASK);
    expect(decide("cd sub", PermissionProfile.plan)).toEqual(ALLOW);
  });
});

describe("review round 2 destination regressions", () => {
  it("attached-short-option-destination-asks", () => {
    for (const command of [
      "tar -xf e.tar -C/home/u",
      "tar -xzf e.tar -C/home/u/.ssh",
      "tar -xf e.tar -C..",
      "unzip e.zip -d/home/u",
      "cp -rt/home/u /tmp/x/.ssh",
    ]) {
      expect(
        decide(command, PermissionProfile.unattended, HOME_CTX, "/home/u/repo"),
        command,
      ).toEqual(ASK);
    }
    expect(
      decide(
        "tar -xf e.tar -C/home/u/repo/out",
        PermissionProfile.unattended,
        HOME_CTX,
        "/home/u/repo",
      ),
    ).toEqual(ALLOW);
  });

  it("globbed-ancestor-destination-asks", () => {
    for (const command of [
      "cp /tmp/x/k /home/u/.ss*/",
      "cp /tmp/x/k /home/u/.s?h/",
      "cp /tmp/x/k /home/u/.conf*/",
    ]) {
      expect(
        decide(command, PermissionProfile.unattended, HOME_CTX),
        command,
      ).toEqual(ASK);
    }
    expect(
      decide(
        "cp /tmp/x/k /home/u/pro*/",
        PermissionProfile.unattended,
        HOME_CTX,
      ),
    ).toEqual(ALLOW);
  });
});

describe("review round 3 relative destination regressions", () => {
  const NESTED_AUTH_CTX: PermissionContext = {
    worktreeRoots: ["/h/proj"],
    homeDir: "/h",
    protectedPaths: ["/h/proj/config/app/auth.json"],
  };
  const USER_DATA_CTX: PermissionContext = {
    worktreeRoots: ["/h"],
    homeDir: "/h",
    protectedPaths: ["/h/.config/codeweave"],
  };

  it("attached-relative-destination-asks", () => {
    for (const command of [
      "tar -xf e.tar -Cconfig",
      "unzip e.zip -dconfig",
      "tar -xzfCconfig e.tar",
    ]) {
      expect(
        decide(
          command,
          PermissionProfile.unattended,
          NESTED_AUTH_CTX,
          "/h/proj",
        ),
        command,
      ).toEqual(ASK);
    }
    expect(
      decide(
        "tar -xf e.tar -Ccodeweave",
        PermissionProfile.unattended,
        USER_DATA_CTX,
        "/h/.config",
      ),
    ).toEqual(ASK);
    expect(
      decide(
        "tar -xf e.tar -Cconfigx",
        PermissionProfile.unattended,
        NESTED_AUTH_CTX,
        "/h/proj",
      ),
    ).toEqual(ALLOW);
  });
});

describe("review round 2 cd regressions", () => {
  it("wrapped-cd-unknown-cwd", () => {
    for (const wrapper of ["env", "nice", "nohup", "timeout 5", "command"]) {
      const command = `${wrapper} cd /home/u/proj && rm -rf id_ed25519`;
      expect(
        decide(command, PermissionProfile.unattended, HOME_CTX, "/home/u/.ssh"),
        command,
      ).toEqual(RM_OUTSIDE);
    }
    expect(
      decide(
        "cd /home/u/proj && rm -rf id_ed25519",
        PermissionProfile.unattended,
        HOME_CTX,
        "/home/u/.ssh",
      ),
    ).toEqual(ALLOW);
  });

  it("zsh-lowercase-cdpath-taints-cd", () => {
    for (const command of [
      "set -A cdpath /home/u/Documents && cd notes && rm -rf x",
      "typeset -T cdpath CDP; cd notes && rm -rf x",
    ]) {
      expect(
        decide(command, PermissionProfile.unattended, HOME_REPO_CTX),
        command,
      ).toEqual(RM_OUTSIDE);
    }
  });

  it("pathed-cd-does-not-move-cwd", () => {
    for (const command of [
      "/usr/bin/cd /home/u/repo/a/b && rm -rf ../../x",
      "./cd a/b && rm -rf ../../x",
      "/usr/bin/pushd a/b && rm -rf ../../x",
    ]) {
      expect(
        decide(
          command,
          PermissionProfile.unattended,
          HOME_REPO_CTX,
          "/home/u/repo",
        ),
        command,
      ).toEqual(RM_OUTSIDE);
    }
    expect(
      decide(
        "cd /home/u/repo/a/b && rm -rf ../../x",
        PermissionProfile.unattended,
        HOME_REPO_CTX,
        "/home/u/repo",
      ),
    ).toEqual(ALLOW);
  });
});

describe("ancestor of a protected path as a destination", () => {
  it("ancestor-of-protected-destination-asks", () => {
    for (const ctx of [REPO_CTX, HOME_CTX]) {
      for (const command of [
        "cp -r /tmp/x/.ssh ~/",
        "cp /tmp/gh.yml ~/.config/",
        "tar -xf /tmp/e.tar -C ~",
        "tar -xf /tmp/e.tar --directory=~",
      ]) {
        expect(
          decide(command, PermissionProfile.unattended, ctx),
          command,
        ).toEqual(ASK);
      }
    }
    expect(
      decide("cp -r x/. ..", PermissionProfile.unattended, HOME_CTX, "/home/u"),
    ).toEqual(ASK);
    expect(decide("tar -xf /tmp/e.tar -C ~", PermissionProfile.plan)).toEqual(
      PLAN_DENY,
    );
  });

  it("destinations_below_no_protected_ancestor_stay_allowed", () => {
    expect(
      decide("cp /tmp/k ~/proj/", PermissionProfile.unattended, HOME_CTX),
    ).toEqual(ALLOW);
    expect(decide("cp a b")).toEqual(ALLOW);
    expect(decide("ls ~", PermissionProfile.unattended, HOME_CTX)).toEqual(
      ALLOW,
    );
    expect(decide("cat ~/.config/x", PermissionProfile.plan, HOME_CTX)).toEqual(
      ALLOW,
    );
    expect(decide("cd ~", PermissionProfile.plan, HOME_CTX)).toEqual(ALLOW);
  });
});

describe("roots with several spellings", () => {
  const LINK_CTX: PermissionContext = {
    worktreeRoots: ["/home/u/link", "/data/p"],
    homeDir: "/home/u",
    protectedPaths: PROTECTED,
  };

  it("symlinked-root-original-spelling-inside", () => {
    for (const command of [
      "rm -rf /home/u/link/build",
      "rm -rf /data/p/build",
      "echo x > /home/u/link/f",
      "echo x > /data/p/f",
      "touch x",
      "cd sub && touch x",
    ]) {
      expect(
        decide(command, PermissionProfile.unattended, LINK_CTX),
        command,
      ).toEqual(ALLOW);
    }
    expect(
      decide(
        "rm -rf /home/u/other/build",
        PermissionProfile.unattended,
        LINK_CTX,
      ),
    ).toEqual(RM_OUTSIDE);
    expect(
      decide(
        "echo x > /home/u/other/f",
        PermissionProfile.unattended,
        LINK_CTX,
      ),
    ).toEqual(ASK);
  });

  it("edits_need_every_spelling_inside_and_unprotected", () => {
    const edit = (...paths: string[]): PermissionDecision =>
      decidePermission(
        { kind: "edit", paths },
        PermissionProfile.unattended,
        LINK_CTX,
      );

    expect(edit("/home/u/link/f", "/data/p/f")).toEqual(ALLOW);
    expect(edit("/home/u/link/f", "/home/u/.ssh/k")).toEqual(ASK);
    expect(edit("/home/u/other/f", "/data/p/f")).toEqual(ASK);
  });

  it("the_root_itself_is_a_valid_cwd_in_either_spelling", () => {
    expect(
      decide("touch x", PermissionProfile.unattended, LINK_CTX, "/data/p"),
    ).toEqual(ALLOW);
    expect(
      decide("touch x", PermissionProfile.unattended, LINK_CTX, "/home/u/link"),
    ).toEqual(ALLOW);
  });
});
