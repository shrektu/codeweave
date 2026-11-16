import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const TAG_CONDITION = "startsWith(github.ref, 'refs/tags/v')";
const BUILD_COMMAND = "node scripts/release/build.ts ${{ matrix.target }}";

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly id?: string;
  readonly with?: Readonly<Record<string, string | number | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly "runs-on": string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly strategy?: {
    readonly "fail-fast": boolean;
    readonly matrix: {
      readonly include: readonly { target: string; runner: string }[];
    };
  };
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly on: {
    readonly push?: { readonly tags?: readonly string[] };
    readonly pull_request?: { readonly paths?: readonly string[] };
  } & Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly concurrency: { readonly group: string };
  readonly jobs: Readonly<Record<string, Job>>;
}

function loadWorkflow(): Workflow {
  return parse(
    readFileSync(
      join(REPO_ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    ),
  ) as Workflow;
}

function job(name: string): Job {
  const found = loadWorkflow().jobs[name];
  if (found === undefined) {
    throw new Error(`job ${name} is missing`);
  }
  return found;
}

function stepRunning(jobName: string, fragment: string): Step {
  const found = job(jobName).steps.find((step) => step.run?.includes(fragment));
  if (found === undefined) {
    throw new Error(`no step in ${jobName} runs ${fragment}`);
  }
  return found;
}

function runScripts(candidate: Job): string {
  return candidate.steps.map((step) => step.run ?? "").join("\n");
}

function secretRef(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function varRef(name: string): string {
  return `\${{ vars.${name} }}`;
}

describe("release workflow triggers", () => {
  it("runs_on_version_tags_and_on_pull_requests_touching_packaging_files", () => {
    const { on } = loadWorkflow();

    expect(Object.keys(on).toSorted()).toEqual(["pull_request", "push"]);
    expect(on.push?.tags).toEqual(["v*"]);
    expect(on.pull_request?.paths).toEqual([
      "electron-builder.yml",
      ".github/workflows/release.yml",
      "scripts/release/**",
      "build/**",
      "package.json",
    ]);
  });

  it("grants_read_only_contents_at_the_top_level_and_serialises_per_ref", () => {
    const workflow = loadWorkflow();

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency.group).toBe("release-${{ github.ref }}");
  });

  it("has_exactly_the_version_build_and_publish_jobs", () => {
    expect(Object.keys(loadWorkflow().jobs)).toEqual([
      "version",
      "build",
      "publish",
    ]);
  });
});

describe("release workflow build matrix", () => {
  it("builds_linux_x64_linux_arm64_windows_and_mac_without_failing_fast", () => {
    const { strategy } = job("build");

    expect(strategy?.["fail-fast"]).toBe(false);
    expect(strategy?.matrix.include).toEqual([
      { target: "linux", runner: "ubuntu-latest" },
      { target: "linux", runner: "ubuntu-24.04-arm" },
      { target: "windows", runner: "windows-latest" },
      { target: "mac", runner: "macos-latest" },
    ]);
    expect(job("build")["runs-on"]).toBe("${{ matrix.runner }}");
  });

  it("waits_for_the_version_job_only_when_it_ran", () => {
    const build = job("build");

    expect(build.needs).toBe("version");
    expect(build.if).toContain("needs.version.result == 'success'");
    expect(build.if).toContain("needs.version.result == 'skipped'");
  });

  it("installs_with_cpu_filters_only_on_windows_and_mac", () => {
    const steps = job("build").steps;
    const installs = steps.filter((step) =>
      step.run?.startsWith("pnpm install"),
    );

    expect(installs.map((step) => [step.if, step.run])).toEqual([
      ["matrix.target == 'linux'", "pnpm install --frozen-lockfile"],
      [
        "matrix.target != 'linux'",
        "pnpm install --frozen-lockfile --cpu x64 --cpu arm64",
      ],
    ]);
  });

  it("installs_rpm_tooling_on_linux_and_builds_before_packaging", () => {
    const steps = job("build").steps;
    const apt = steps.find((step) => step.run?.includes("apt-get install"));
    const buildIndex = steps.findIndex((step) => step.run === "pnpm build");
    const packIndex = steps.findIndex((step) => step.run === BUILD_COMMAND);

    expect(apt?.if).toBe("matrix.target == 'linux'");
    expect(apt?.run).toContain("rpm");
    expect(apt?.run).toContain("libarchive-tools");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(packIndex).toBeGreaterThan(buildIndex);
  });

  it("reuses_the_ci_checkout_pnpm_and_node_setup", () => {
    const steps = job("build").steps;

    expect(steps[0]?.uses).toBe("actions/checkout@v5");
    expect(steps[1]?.uses).toBe("pnpm/action-setup@v4");
    expect(steps[2]?.uses).toBe("actions/setup-node@v5");
    expect(steps[2]?.with).toEqual({ "node-version": 24, cache: "pnpm" });
  });
});

describe("release workflow signing environment", () => {
  const buildSteps = (): readonly Step[] =>
    job("build").steps.filter((step) => step.run === BUILD_COMMAND);

  it("passes_secrets_only_to_the_step_of_the_matching_target", () => {
    const byCondition = new Map(
      buildSteps().map((step) => [step.if, step.env]),
    );

    expect([...byCondition.keys()]).toEqual([
      "matrix.target == 'linux'",
      "matrix.target == 'windows'",
      "matrix.target == 'mac'",
    ]);
    expect(byCondition.get("matrix.target == 'linux'")).toBeUndefined();
  });

  it("maps_the_documented_mac_secrets", () => {
    const step = buildSteps().find(
      (candidate) => candidate.if === "matrix.target == 'mac'",
    );

    expect(step?.env).toEqual({
      CSC_LINK: secretRef("MAC_CSC_LINK"),
      CSC_KEY_PASSWORD: secretRef("MAC_CSC_KEY_PASSWORD"),
      APPLE_ID: secretRef("APPLE_ID"),
      APPLE_APP_SPECIFIC_PASSWORD: secretRef("APPLE_APP_SPECIFIC_PASSWORD"),
      APPLE_TEAM_ID: secretRef("APPLE_TEAM_ID"),
    });
  });

  it("maps_the_documented_azure_secrets_and_variables", () => {
    const step = buildSteps().find(
      (candidate) => candidate.if === "matrix.target == 'windows'",
    );

    expect(step?.env).toEqual({
      AZURE_TENANT_ID: secretRef("AZURE_TENANT_ID"),
      AZURE_CLIENT_ID: secretRef("AZURE_CLIENT_ID"),
      AZURE_CLIENT_SECRET: secretRef("AZURE_CLIENT_SECRET"),
      AZURE_SIGNING_ENDPOINT: varRef("AZURE_SIGNING_ENDPOINT"),
      AZURE_SIGNING_ACCOUNT: varRef("AZURE_SIGNING_ACCOUNT"),
      AZURE_SIGNING_PROFILE: varRef("AZURE_SIGNING_PROFILE"),
      AZURE_SIGNING_PUBLISHER: varRef("AZURE_SIGNING_PUBLISHER"),
    });
  });

  it("references_secrets_nowhere_outside_the_target_build_steps", () => {
    const text = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const references = text.match(/\$\{\{\s*(secrets|vars)\.[A-Z_]+/g) ?? [];

    expect(references).toHaveLength(12);
  });
});

describe("release workflow artifacts", () => {
  it("uploads_installers_and_update_manifests_per_target_and_arch", () => {
    const upload = job("build").steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(upload?.with?.name).toBe(
      "release-${{ matrix.target }}-${{ runner.arch }}",
    );
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    expect(upload?.with?.["retention-days"]).toBe(7);
    expect(String(upload?.with?.path).trim().split("\n")).toEqual([
      "release/*.AppImage",
      "release/*.deb",
      "release/*.rpm",
      "release/*.exe",
      "release/*.dmg",
      "release/*.zip",
      "release/*.blockmap",
      "release/*.yml",
      "!release/builder-debug.yml",
      "!release/builder-effective-config.yaml",
    ]);
  });
});

describe("release workflow reruns", () => {
  it("rerun_of_a_build_job_overwrites_its_existing_artifact", () => {
    const upload = job("build").steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload?.with?.overwrite).toBe(true);
  });
});

describe("release workflow version job", () => {
  it("runs_only_on_tags_and_exposes_version_and_prerelease", () => {
    const version = job("version");

    expect(version.if).toBe(TAG_CONDITION);
    expect(version.outputs).toEqual({
      version: "${{ steps.info.outputs.version }}",
      prerelease: "${{ steps.info.outputs.prerelease }}",
    });
    expect(stepRunning("version", "tagVersion.ts").id).toBe("info");
  });
});

describe("release workflow publish job", () => {
  it("publish_job_never_runs_on_pull_request", () => {
    const publish = job("publish");

    expect(publish.if).toBe(TAG_CONDITION);
    expect(publish.if).not.toContain("pull_request");
    expect(publish.needs).toEqual(["version", "build"]);
  });

  it("is_the_only_job_with_contents_write", () => {
    const jobs = loadWorkflow().jobs;
    const writers = Object.entries(jobs)
      .filter(([, candidate]) => candidate.permissions?.contents === "write")
      .map(([name]) => name);

    expect(writers).toEqual(["publish"]);
    expect(job("publish").permissions).toEqual({ contents: "write" });
  });

  it("merges_all_artifacts_into_dist", () => {
    const download = job("publish").steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );

    expect(download?.with).toEqual({ path: "dist", "merge-multiple": true });
  });

  it("creates_a_draft_with_generated_notes_and_reuploads_with_clobber", () => {
    const step = stepRunning("publish", "gh release");
    const script = step.run ?? "";

    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
      TAG: "${{ github.ref_name }}",
      VERSION: "${{ needs.version.outputs.version }}",
      PRERELEASE: "${{ needs.version.outputs.prerelease }}",
    });
    expect(script).toContain('gh release view "$TAG"');
    expect(script).toContain('gh release upload "$TAG" dist/* --clobber');
    expect(script).toContain('gh release create "$TAG" dist/*');
    expect(script).toContain("--draft");
    expect(script).toContain("--generate-notes");
    expect(script).toContain('--title "Codeweave $VERSION"');
    expect(script).toContain("--prerelease");
    expect(script).toContain('"$PRERELEASE" = "true"');
  });

  it("rerun_after_publication_refuses_to_clobber_public_assets", () => {
    const script = stepRunning("publish", "gh release").run ?? "";
    const guard = script.indexOf(
      'gh release view "$TAG" --json isDraft -q .isDraft',
    );
    const upload = script.indexOf('gh release upload "$TAG"');

    expect(guard).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(guard);
    expect(script).toMatch(/exit 1/);
    expect(script.indexOf("exit 1")).toBeLessThan(upload);
  });

  it("does_not_publish_from_any_other_job", () => {
    const jobs = loadWorkflow().jobs;
    const others = Object.entries(jobs).filter(([name]) => name !== "publish");
    const offenders = others.filter(([, candidate]) =>
      runScripts(candidate).includes("gh release"),
    );

    expect(offenders).toEqual([]);
  });
});

describe("release notes categories", () => {
  it("groups_changes_into_features_fixes_and_other", () => {
    const config = parse(
      readFileSync(join(REPO_ROOT, ".github", "release.yml"), "utf8"),
    ) as {
      changelog: {
        categories: { title: string; labels: string[] }[];
      };
    };

    expect(config.changelog.categories).toEqual([
      { title: "Features", labels: ["enhancement"] },
      { title: "Fixes", labels: ["bug"] },
      { title: "Other", labels: ["*"] },
    ]);
  });
});
