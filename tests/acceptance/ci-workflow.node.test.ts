import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const AGY_INSTALL_STEP = "Install Antigravity CLI (Linux)";
const AGY_PINNED_URL =
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.11-5180209989812224/linux-x64/cli_linux_x64.tar.gz";
const AGY_PINNED_SHA512 =
  "2935601efa745ed6e314d32b415c71f44d9d455f0e6a2583372584be5a9074c28154cf81d5eec65b4416579453a3b3b05d3abe4d4f176754d5ef93a84af6cf28";
const AGY_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";
const AGY_BIN_DIR = "$RUNNER_TEMP/agy-bin";
const ROTATION_CONFIG = "playwright.rotation.config.ts";
const DEFAULT_CONFIG = "playwright.config.ts";
const PACK_COMMAND = "pnpm run pack";
const TERMINAL_SPEC = "tests/e2e/terminal.spec.ts";
const EXECUTABLE_ENV = "CODEWEAVE_E2E_EXECUTABLE";
const CLAUDE_INSTALL_STEP = "Install Claude Code CLI";
const ORCHESTRATOR_E2E_STEP = "Orchestrator end-to-end test";
const SPEC_NAME_PATTERN = /"([A-Za-z]+\.spec\.ts)"/g;
const LIST_PATTERNS = {
  testMatch: /testMatch:\s*\[([^\]]*)\]/,
  testIgnore: /testIgnore:\s*\[([^\]]*)\]/,
} as const;

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Workflow {
  readonly jobs: Readonly<
    Record<string, { readonly steps: readonly WorkflowStep[] }>
  >;
}

function workflowSteps(): readonly WorkflowStep[] {
  const text = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  return Object.values((parse(text) as Workflow).jobs).flatMap(
    (job) => job.steps,
  );
}

function specNames(
  file: string,
  list: keyof typeof LIST_PATTERNS,
): readonly string[] {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const body = LIST_PATTERNS[list].exec(text)?.[1] ?? "";
  return [...body.matchAll(SPEC_NAME_PATTERN)].map((match) => match[1] ?? "");
}

it("agy_ci_install_is_read_only", () => {
  const steps = workflowSteps();
  const install = steps.find((step) => step.name === AGY_INSTALL_STEP);
  const script = install?.run ?? "";

  expect(script).toContain(AGY_PINNED_URL);
  expect(script).toContain(AGY_PINNED_SHA512);
  expect(script).toContain(`install -m 0555`);
  expect(script).toContain(`chmod 0555 "${AGY_BIN_DIR}"`);
  expect(script).toContain(`"${AGY_BIN_DIR}/agy"`);
  expect(script).toContain(`echo "${AGY_BIN_DIR}" >> "$GITHUB_PATH"`);
  expect(script.trim().split("\n").at(-1)).toBe(
    `"${AGY_BIN_DIR}/agy" --version`,
  );
  expect(steps.flatMap((step) => Object.keys(step.env ?? {}))).not.toContain(
    AGY_AUTO_UPDATE_ENV,
  );
});

it("ci_verifies_the_packed_app_after_pack", () => {
  const steps = workflowSteps();
  const packIndex = steps.findIndex((step) => step.run === PACK_COMMAND);

  expect(steps[packIndex + 1]?.run).toBe("node scripts/release/verify.ts");
  expect(steps[packIndex + 1]?.if).toBeUndefined();
});

it("packed_app_terminal_spec_runs_on_every_os_after_pack", () => {
  const steps = workflowSteps();
  const packIndex = steps.findIndex((step) => step.run === PACK_COMMAND);
  const terminalSteps = steps.filter((step) =>
    step.run?.includes(TERMINAL_SPEC),
  );
  const byName = (name: string): WorkflowStep | undefined =>
    terminalSteps.find((step) => step.name === name);

  expect(packIndex).toBeGreaterThanOrEqual(0);
  expect(terminalSteps).toHaveLength(3);
  for (const step of terminalSteps) {
    expect(steps.indexOf(step)).toBeGreaterThan(packIndex);
  }
  const linux = byName("Packed app terminal test (Linux)");
  expect(linux?.run).toMatch(/^xvfb-run .*pnpm exec playwright test/);
  expect(linux?.env?.[EXECUTABLE_ENV]).toMatch(
    /\/release\/linux-unpacked\/codeweave$/,
  );
  const windows = byName("Packed app terminal test (Windows)");
  expect(windows?.env?.[EXECUTABLE_ENV]).toMatch(
    /\\release\\win-unpacked\\Codeweave\.exe$/,
  );
  const mac = byName("Packed app terminal test (macOS)");
  expect(mac?.run).toContain(`${EXECUTABLE_ENV}=`);
  expect(mac?.run).toContain("release/mac*/Codeweave.app");
  expect(mac?.run).toContain("/Contents/MacOS/Codeweave");
});

it("terminal_spec_is_part_of_the_default_e2e", () => {
  expect(specNames(DEFAULT_CONFIG, "testIgnore")).not.toContain(TERMINAL_SPEC);
});

it("rotation_specs_excluded_from_default_e2e", () => {
  const rotationSpecs = specNames(ROTATION_CONFIG, "testMatch");
  const ignoredSpecs = specNames(DEFAULT_CONFIG, "testIgnore");

  expect(rotationSpecs).toContain("agyRotation.spec.ts");
  expect(ignoredSpecs).toEqual(expect.arrayContaining([...rotationSpecs]));
});

it("orchestrator_e2e_runs_after_claude_install_on_every_os", () => {
  const steps = workflowSteps();
  const install = steps.findIndex((step) => step.name === CLAUDE_INSTALL_STEP);
  const orchestrator = steps.findIndex(
    (step) => step.name === ORCHESTRATOR_E2E_STEP,
  );

  expect(install).toBeGreaterThanOrEqual(0);
  expect(steps[install]?.if).toBeUndefined();
  expect(orchestrator).toBeGreaterThan(install);
});
