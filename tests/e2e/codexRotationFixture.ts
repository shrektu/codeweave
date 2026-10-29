import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORAGE_VERSION } from "../../src/backend/constants";
import { createJsonStore } from "../../src/backend/storage";
import {
  EffectLevel,
  ProviderId,
  type Account,
  type PermissionProfile,
} from "../../src/domain/types";
import { assertIsolatedCodexHome } from "../fakes/codexHomeGuard";
import { ResponsesScenario } from "../fakes/responsesMock";

import {
  KEY_A,
  KEY_B,
  WORKSPACE_PREFIX,
  createRepo,
  type RotationWorkspace,
} from "./rotationFixture";

const CODEX_BINARY = "codex";
const CONFIG_FILE = "config.toml";
const LOGIN_ARGS = ["login", "--with-api-key"] as const;
const CODEX_HOME_ENV = "CODEX_HOME";
const INHERITED_ENV_KEYS = ["PATH", "HOME"] as const;
const MOCK_PROVIDER = "mock";
const MOCK_MODEL = "mock-model";
const STDERR_LIMIT = 2000;

export const CODEX_ROTATION_SCENARIOS: Readonly<
  Record<string, ResponsesScenario>
> = {
  [KEY_A]: ResponsesScenario.toolThen429,
  [KEY_B]: ResponsesScenario.ok,
};

export class CodexLoginError extends Error {
  constructor(home: string, reason: string) {
    super(`codex login failed for ${home}: ${reason}`);
    this.name = "CodexLoginError";
  }
}

function codexConfig(baseUrl: string): string {
  return [
    'cli_auth_credentials_store = "file"',
    `model = "${MOCK_MODEL}"`,
    `model_provider = "${MOCK_PROVIDER}"`,
    `[model_providers.${MOCK_PROVIDER}]`,
    `name = "${MOCK_PROVIDER}"`,
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
}

function loginEnv(home: string): Record<string, string> {
  const inherited = INHERITED_ENV_KEYS.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(inherited), [CODEX_HOME_ENV]: home };
}

export async function loginWithApiKey(
  home: string,
  baseUrl: string,
  apiKey: string,
  executable: string = CODEX_BINARY,
): Promise<void> {
  assertIsolatedCodexHome(home, baseUrl);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, LOGIN_ARGS, {
      env: loginEnv(home),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      reject(new CodexLoginError(home, error.message));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new CodexLoginError(home, `exit code ${String(code)}: ${stderr}`));
    });
    child.stdin.end(apiKey);
  });
}

async function createCodexHome(
  home: string,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  assertIsolatedCodexHome(home, baseUrl);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, CONFIG_FILE), codexConfig(baseUrl));
  await loginWithApiKey(home, baseUrl, apiKey);
}

function codexAccount(
  id: string,
  label: string,
  configDir: string,
  order: number,
): Account {
  return { id, provider: ProviderId.codex, label, configDir, order };
}

export async function createCodexRotationWorkspace(
  profile: PermissionProfile,
  baseUrl: string,
): Promise<RotationWorkspace> {
  const root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
  const dispose = (): Promise<void> =>
    rm(root, { recursive: true, force: true });
  try {
    const userData = join(root, "user-data");
    const repo = join(root, "repo");
    const accountA = codexAccount("acc-a", "A", join(root, "codex-a"), 0);
    const accountB = codexAccount("acc-b", "B", join(root, "codex-b"), 1);
    await createRepo(repo);
    await createCodexHome(accountA.configDir, baseUrl, KEY_A);
    await createCodexHome(accountB.configDir, baseUrl, KEY_B);
    const store = createJsonStore(userData);
    await store.writeAccounts([accountA, accountB]);
    await store.writeSettings({
      version: STORAGE_VERSION,
      permissionProfile: profile,
      effectLevel: EffectLevel.auto,
      claudeExecutable: null,
      codexExecutable: null,
    });
    return { root, userData, repo, accountA, accountB, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function assertWorkspaceIsolated(
  workspace: RotationWorkspace,
  baseUrl: string,
): void {
  assertIsolatedCodexHome(workspace.accountA.configDir, baseUrl);
  assertIsolatedCodexHome(workspace.accountB.configDir, baseUrl);
}
