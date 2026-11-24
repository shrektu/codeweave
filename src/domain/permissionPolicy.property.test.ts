import { posix } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decidePermission,
  type PermissionContext,
  type PermissionDecision,
  type PermissionQuery,
} from "./permissionPolicy";
import { PermissionProfile } from "./types";

const ROOT = "/work/repo";
const HOME = "/home/u";
const NUM_RUNS = 300;
const SEVERITY: Readonly<Record<PermissionDecision["action"], number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};
const PATTERNS: readonly string[] = [
  "/work/repo/secret",
  "/work/repo/.config/*/auth*",
  "/home/u/.ssh",
  "/home/u/.npmrc",
];
const CTX: PermissionContext = {
  worktreeRoots: [ROOT],
  homeDir: HOME,
  protectedPaths: PATTERNS,
};
const PROFILES: readonly PermissionProfile[] = [
  PermissionProfile.unattended,
  PermissionProfile.acceptEdits,
  PermissionProfile.ask,
  PermissionProfile.plan,
];

const NAME = fc.constantFrom(
  "a",
  "b",
  "build",
  "dist",
  "src",
  "secret",
  ".config",
  "app",
  "auth.json",
  "authx",
  "notes",
);
const REL_SEGMENT = fc.oneof(
  { weight: 5, arbitrary: NAME },
  { weight: 2, arbitrary: fc.constant("..") },
  { weight: 1, arbitrary: fc.constant(".") },
);
const INSIDE_DIR = fc
  .array(NAME, { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join("/"));
const REL_TARGET = fc
  .array(REL_SEGMENT, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join("/"));

function decide(
  query: PermissionQuery,
  profile: PermissionProfile,
  ctx: PermissionContext = CTX,
): PermissionDecision {
  return decidePermission(query, profile, ctx);
}

function run(
  command: string,
  profile: PermissionProfile = PermissionProfile.unattended,
  ctx: PermissionContext = CTX,
): PermissionDecision {
  return decide({ kind: "execute", command }, profile, ctx);
}

function segmentsBelow(root: string, absolute: string): string[] | null {
  const relation = posix.relative(root, absolute);
  return relation === "" || relation.startsWith("..")
    ? null
    : relation.split("/");
}

function oracleProtected(absolute: string): boolean {
  const parts = segmentsBelow(ROOT, absolute) ?? [];
  const [first = "", , third = ""] = parts;
  return (
    first === "secret" ||
    (first === ".config" && parts.length >= 3 && third.startsWith("auth"))
  );
}

function oracleProtectedAncestor(absolute: string): boolean {
  const parts = segmentsBelow(ROOT, absolute);
  return (
    parts !== null &&
    parts[0] === ".config" &&
    parts.length < 3 &&
    !oracleProtected(absolute)
  );
}

function oracleDecision(inside: string, target: string): string {
  const cwd = posix.resolve(ROOT, inside);
  const resolved = posix.resolve(cwd, target);
  const rmInside = segmentsBelow(ROOT, resolved) !== null;
  if (
    !rmInside ||
    oracleProtected(resolved) ||
    oracleProtectedAncestor(resolved)
  ) {
    return "deny";
  }
  return oracleProtected(cwd) ? "ask" : "allow";
}

describe("property: cd followed by rm -rf", () => {
  it("P1_decision_follows_the_lexical_resolution", () => {
    fc.assert(
      fc.property(INSIDE_DIR, REL_TARGET, (inside, target) => {
        const decision = run(`cd ${inside} && rm -rf ${target}`);

        return decision.action === oracleDecision(inside, target);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const OUTSIDE_OR_PROTECTED = fc.constantFrom(
  "/tmp",
  "/etc",
  "/work",
  "/work/other",
  "/work/repo/..",
  "/home/u",
  "/home/u/other",
  "~",
  "~/proj",
  "/home/u/.ssh",
  "~/.ssh/keys",
  "/work/repo/secret",
  "/work/repo/secret/deep",
  "/work/repo/.config/app/auth.json",
);
const MUTATING = fc.constantFrom(
  "touch x",
  "rm x",
  "mkdir d",
  "cp a b",
  "sed -i s/a/b/ f",
  "echo hi > f",
  "npm install",
  "make",
  "git commit -m x",
  "tee f",
  "chmod 600 f",
  "mv a b",
);

const READ_ONLY_LEAD = fc.constantFrom("ls", "pwd", "cat f", "git status");
const CD_VERB = fc.constantFrom("cd", "pushd");
const OUTSIDE_CWD = fc.constantFrom(
  "/tmp",
  "/work",
  "/home/u",
  "/home/u/.ssh",
  "/work/repo/secret",
);
const INSIDE_TARGET = fc.constantFrom("/work/repo", "/work/repo/a", "sub");
const OR_CD_INSIDE = fc
  .tuple(READ_ONLY_LEAD, CD_VERB, INSIDE_TARGET, MUTATING)
  .map(
    ([lead, verb, dir, command]) => `${lead} || ${verb} ${dir} && ${command}`,
  );
const CD_OVERRIDE_PREFIX = fc.constantFrom(
  "HOME=/tmp cd",
  "HOME=/tmp pushd",
  "CDPATH=/ cd",
  "CDPATH=~ cd",
  "export HOME=/tmp; cd",
  "export CDPATH=/; cd",
  "declare -x CDPATH=/; cd",
  "unset CDPATH; cd",
);
const CD_WRAPPER = fc.constantFrom("env", "nice", "nohup", "timeout 5");
const PROTECTED_DESTINATION = fc.constantFrom(
  "/home/u",
  "/home/u/.ssh",
  "~",
  "~/.ssh/keys",
  "/home/u/.npmrc",
  "/work/repo/secret",
  "/work/repo/.config",
  "/work/repo/.config/app/auth.json",
  "secret",
  ".config",
);
const ATTACHED_DESTINATION = fc.constantFrom(
  "tar -xf e.tar -C",
  "unzip e.zip -d",
  "cp -rt",
  "tar -xzf e.tar -C",
);
const CD_OVERRIDE_TARGET = fc.constantFrom(
  "",
  "tmp",
  "sub",
  ".ssh",
  "~",
  "/work/repo/a",
  "+1",
);

describe("property: leaving the root or entering protected paths", () => {
  it("P2_cd_out_then_a_mutation_is_never_allowed_unattended", () => {
    fc.assert(
      fc.property(OUTSIDE_OR_PROTECTED, MUTATING, (dir, command) => {
        const decision = run(`cd ${dir} && ${command}`);

        return decision.action !== "allow";
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2_an_or_preceded_cd_out_then_a_mutation_is_never_allowed", () => {
    fc.assert(
      fc.property(
        READ_ONLY_LEAD,
        CD_VERB,
        OUTSIDE_OR_PROTECTED,
        MUTATING,
        (lead, verb, dir, command) => {
          const decision = run(`${lead} || ${verb} ${dir} && ${command}`);

          return decision.action !== "allow";
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2_an_or_preceded_cd_into_the_root_from_outside_is_never_allowed", () => {
    fc.assert(
      fc.property(OUTSIDE_CWD, OR_CD_INSIDE, (cwd, command) => {
        const decision = decide(
          { kind: "execute", command, cwd },
          PermissionProfile.unattended,
        );

        return decision.action !== "allow";
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2_a_wrapped_cd_into_the_root_from_outside_is_never_allowed", () => {
    fc.assert(
      fc.property(
        OUTSIDE_CWD,
        CD_WRAPPER,
        INSIDE_TARGET,
        MUTATING,
        (cwd, wrapper, dir, command) => {
          const decision = decide(
            {
              kind: "execute",
              command: `${wrapper} cd ${dir} && ${command}`,
              cwd,
            },
            PermissionProfile.unattended,
          );

          return decision.action !== "allow";
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2_an_attached_destination_on_a_protected_path_is_never_allowed", () => {
    fc.assert(
      fc.property(
        ATTACHED_DESTINATION,
        PROTECTED_DESTINATION,
        (verb, destination) => {
          const decision = run(`${verb}${destination} a`);

          return decision.action !== "allow";
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2_common_flag_words_keep_their_allow_decisions", () => {
    for (const command of ["rm -rf build", "ls -la", "git commit -m msg"]) {
      expect(run(command).action, command).toBe("allow");
    }
  });

  it("P2_an_overridden_cd_then_a_mutation_is_never_allowed", () => {
    fc.assert(
      fc.property(
        CD_OVERRIDE_PREFIX,
        CD_OVERRIDE_TARGET,
        MUTATING,
        (prefix, target, command) => {
          const decision = run(`${prefix} ${target} && ${command}`);

          return decision.action !== "allow";
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

const PROTECTED_BASE = fc.constantFrom(
  "/home/u/.ssh",
  "/home/u/.npmrc",
  "/work/repo/secret",
  "/work/repo/.config/app/auth.json",
  "/work/repo/.config/other/authorized",
);
const BELOW = fc.array(NAME, { maxLength: 3 }).map((parts) => parts.join("/"));
const NOISE = fc.constantFrom("", "/.", "//", "/zzz/..");

function neverAllowsEditBelow(
  base: string,
  below: string,
  noise: string,
): boolean {
  const path = [base, below].filter((part) => part !== "").join("/");
  const query: PermissionQuery = {
    kind: "edit",
    paths: [`${posix.dirname(path)}${noise}/${posix.basename(path)}`],
  };
  return PROFILES.every((profile) => decide(query, profile).action !== "allow");
}

describe("property: protected edit paths", () => {
  it("P3_an_edit_below_a_protected_pattern_is_never_allowed", () => {
    fc.assert(fc.property(PROTECTED_BASE, BELOW, NOISE, neverAllowsEditBelow), {
      numRuns: NUM_RUNS,
    });
  });
});

const VERB = fc.constantFrom(
  "cat",
  "ls",
  "touch",
  "rm",
  "rm -rf",
  "rm -r",
  "cp a",
  "mv a",
  "sed -i s/a/b/",
  "tee",
  "mkdir",
  "chmod 600",
  "git status",
  "git commit -m x",
  "npm install",
  "echo hi >",
);
const PATH_ARG = fc.constantFrom(
  "f",
  "sub/f",
  "../f",
  "/tmp/x",
  "~/f",
  "~/.ssh/k",
  "/home/u/.ssh/k",
  "/home/u/.npmrc",
  "/work/repo/a",
  "/work/repo/secret/k",
  "/work/repo/.config/app/auth.json",
  "build",
  "./build",
);
const COMMAND = fc
  .tuple(VERB, PATH_ARG)
  .map(([verb, path]) => `${verb} ${path}`);
const PROFILE = fc.constantFrom(...PROFILES);
const EXTRA_PATTERNS = fc.subarray(
  [
    "/work/repo/build",
    "/work/repo/sub",
    "/tmp",
    "/home/u/*",
    "/work/repo/*/a*",
    "/work/repo",
  ],
  { minLength: 1 },
);

function widened(extra: readonly string[]): PermissionContext {
  return { ...CTX, protectedPaths: [...PATTERNS, ...extra] };
}

function commandNeverLoosens(
  command: string,
  profile: PermissionProfile,
  extra: readonly string[],
): boolean {
  const before = run(command, profile);
  const after = run(command, profile, widened(extra));
  return SEVERITY[after.action] >= SEVERITY[before.action];
}

function editNeverLoosens(
  path: string,
  profile: PermissionProfile,
  extra: readonly string[],
): boolean {
  const query: PermissionQuery = { kind: "edit", paths: [path] };
  return (
    SEVERITY[decide(query, profile, widened(extra)).action] >=
    SEVERITY[decide(query, profile).action]
  );
}

describe("property: monotonicity", () => {
  it("P4_more_protected_patterns_never_loosen_a_decision", () => {
    fc.assert(
      fc.property(COMMAND, PROFILE, EXTRA_PATTERNS, commandNeverLoosens),
      { numRuns: NUM_RUNS },
    );
  });

  it("P4_edits_are_monotone_in_the_patterns_too", () => {
    fc.assert(
      fc.property(PATH_ARG, PROFILE, EXTRA_PATTERNS, editNeverLoosens),
      { numRuns: NUM_RUNS },
    );
  });
});

const CD_TARGET = fc.constantFrom(
  "sub",
  "..",
  "/tmp",
  "~",
  "/work/repo/a",
  "/home/u/.ssh",
  "-",
  "$HOME",
);

describe("property: a cd prefix", () => {
  it("P5_prefixing_cd_semicolon_never_loosens_a_decision", () => {
    fc.assert(
      fc.property(CD_TARGET, COMMAND, PROFILE, (dir, command, profile) => {
        const plain = run(command, profile);
        const prefixed = run(`cd ${dir}; ${command}`, profile);

        return SEVERITY[prefixed.action] >= SEVERITY[plain.action];
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
