import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { STORAGE_VERSION } from "../../src/backend/constants";
import { createJsonStore } from "../../src/backend/storage";
import {
  EffectLevel,
  ProviderId,
  type Account,
  type PermissionProfile,
} from "../../src/domain/types";
import { MockScenario } from "../fakes/anthropicMock";

const execFileAsync = promisify(execFile);

export const WORKSPACE_PREFIX = "codeweave-rotation-";
const API_KEY_HELPER_KEY = "apiKeyHelper";
const SETTINGS_FILE = "settings.json";
const EFFECTS_FILE = "effects.log";
export const REPO_SEED_FILE = "README.md";
const GIT_IDENTITY_ARGS = [
  "-c",
  "user.name=Rotation Test",
  "-c",
  "user.email=rotation@example.com",
  "-c",
  "commit.gpgsign=false",
] as const;

export const KEY_A = "test-key-a";
export const KEY_B = "test-key-b";
export const ROTATION_COMMAND = "echo deploy-side-effect | tee -a effects.log";
export const ROTATION_PROMPT = "Record the side effect in effects.log";
export const ROTATION_SCENARIOS: Readonly<Record<string, MockScenario>> = {
  [KEY_A]: MockScenario.toolThen429,
  [KEY_B]: MockScenario.ok,
};
export const ALLOW_ONCE_KIND = "allow_once";

const AGENT_ENV_ISOLATION: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
};

export function rotationAgentEnv(
  mockUrl: string,
): Readonly<Record<string, string>> {
  return { ...AGENT_ENV_ISOLATION, ANTHROPIC_BASE_URL: mockUrl };
}

export interface CleanupStack {
  add(dispose: () => Promise<void>): void;
  run(): Promise<void>;
}

export function createCleanupStack(): CleanupStack {
  const disposers: (() => Promise<void>)[] = [];
  return {
    add: (dispose) => {
      disposers.push(dispose);
    },
    run: async () => {
      const errors: unknown[] = [];
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "cleanup failed");
      }
    },
  };
}

export interface RotationWorkspace {
  readonly root: string;
  readonly userData: string;
  readonly repo: string;
  readonly accountA: Account;
  readonly accountB: Account;
  dispose(): Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...GIT_IDENTITY_ARGS, ...args], { cwd });
}

export async function createRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet"]);
  await writeFile(join(dir, REPO_SEED_FILE), "rotation test\n");
  await git(dir, ["add", REPO_SEED_FILE]);
  await git(dir, ["commit", "--quiet", "-m", "Initial commit"]);
}

async function createConfigDir(dir: string, apiKey: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, SETTINGS_FILE),
    JSON.stringify({ [API_KEY_HELPER_KEY]: `echo ${apiKey}` }),
  );
}

function account(
  id: string,
  label: string,
  configDir: string,
  order: number,
): Account {
  return { id, provider: ProviderId.claude, label, configDir, order };
}

export async function createRotationWorkspace(
  profile: PermissionProfile,
): Promise<RotationWorkspace> {
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  const userData = join(root, "user-data");
  const repo = join(root, "repo");
  const accountA = account("acc-a", "A", join(root, "config-a"), 0);
  const accountB = account("acc-b", "B", join(root, "config-b"), 1);
  await createRepo(repo);
  await createConfigDir(accountA.configDir, KEY_A);
  await createConfigDir(accountB.configDir, KEY_B);
  const store = createJsonStore(userData);
  await store.writeAccounts([accountA, accountB]);
  await store.writeSettings({
    version: STORAGE_VERSION,
    permissionProfile: profile,
    effectLevel: EffectLevel.auto,
    claudeExecutable: null,
    codexExecutable: null,
    agyExecutable: null,
    opencodeExecutable: null,
    terminalShell: null,
  });
  return {
    root,
    userData,
    repo,
    accountA,
    accountB,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export async function readEffectLines(repo: string): Promise<string[]> {
  const text = await readFile(join(repo, EFFECTS_FILE), "utf8");
  return text.split("\n").filter((line) => line !== "");
}
