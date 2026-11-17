import { statSync, type Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { RUN_DIR_PREFIX } from "../../src/backend/opencode/constants";
import { defaultRuntimeRoot } from "../../src/backend/opencode/config";
import type { ApiProviderId } from "../../src/domain/apiProviders";
import { ProviderId } from "../../src/domain/types";
import type { ParamsMap } from "../../src/shared/protocol";
import { ChatScenario } from "../fakes/openaiChatMock";

export const OPENCODE_KEY_A = "sk-test-fake-key-A";
export const OPENCODE_KEY_B = "sk-test-fake-key-B";
export const OPENCODE_KEYS = [OPENCODE_KEY_A, OPENCODE_KEY_B] as const;
export const OPENCODE_ROTATION_SCENARIOS: Readonly<
  Record<string, ChatScenario>
> = {
  [OPENCODE_KEY_A]: ChatScenario.toolThen429,
  [OPENCODE_KEY_B]: ChatScenario.ok,
};

const OPENCODE_BINARY = "opencode";
const MOCK_MODEL = "mock-model";
const CUSTOM_API_PROVIDER = "custom";

export interface OpencodeAccountSpec {
  readonly label: string;
  readonly apiKey: string;
  readonly provider?: ApiProviderId;
  readonly model?: string;
}

export const OPENCODE_ACCOUNT_SPECS: readonly OpencodeAccountSpec[] = [
  { label: "A", apiKey: OPENCODE_KEY_A },
  { label: "B", apiKey: OPENCODE_KEY_B },
];

type OpencodeAddParams = Extract<
  ParamsMap["accounts/add"],
  { provider: typeof ProviderId.opencode }
>;

export function opencodeAddParams(
  spec: OpencodeAccountSpec,
  userData: string,
  mockUrl: string,
): OpencodeAddParams {
  return {
    label: spec.label,
    configDir: join(userData, "accounts", spec.label.toLowerCase()),
    provider: ProviderId.opencode,
    api: {
      provider: spec.provider ?? CUSTOM_API_PROVIDER,
      model: spec.model ?? MOCK_MODEL,
      baseUrl: mockUrl,
      rotation: true,
    },
    apiKey: spec.apiKey,
  };
}

const EXECUTE_BITS = 0o111;
const MISSING_CODE = "ENOENT";

function isExecutable(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  return (
    stats !== undefined && stats.isFile() && (stats.mode & EXECUTE_BITS) !== 0
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === MISSING_CODE
  );
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

async function readIfPresent(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isMissing(error)) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

export function opencodeBinaryOnPath(): string {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const found = dirs
    .map((dir) => join(dir, OPENCODE_BINARY))
    .find((candidate) => isExecutable(candidate));
  if (found === undefined) {
    throw new Error(
      "the opencode CLI is not on PATH; install it with `npm i -g opencode-ai@1.19.5`",
    );
  }
  return found;
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await listDir(dir);
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) {
        return filesUnder(path);
      }
      return Promise.resolve(entry.isFile() ? [path] : []);
    }),
  );
  return nested.flat();
}

export async function findKeyLeaks(
  dirs: readonly string[],
  keys: readonly string[],
): Promise<string[]> {
  const files = (await Promise.all(dirs.map(filesUnder))).flat();
  const leaks = await Promise.all(
    files.map(async (file) => {
      const content = await readIfPresent(file);
      return keys.some((key) => content.includes(key)) ? [file] : [];
    }),
  );
  return leaks.flat();
}

const KEYRING_PRELOAD_FILE = "keyring-preload.cjs";
const KEYRING_PRELOAD_SOURCE =
  'require("electron").app.commandLine.appendSwitch("password-store", "gnome-libsecret");\n';

export async function writeKeyringPreload(dir: string): Promise<string> {
  const path = join(dir, KEYRING_PRELOAD_FILE);
  await writeFile(path, KEYRING_PRELOAD_SOURCE);
  return path;
}

export async function runtimeRunDirs(): Promise<string[]> {
  const root = defaultRuntimeRoot(process.env);
  const entries = await listDir(root);
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(RUN_DIR_PREFIX),
    )
    .map((entry) => join(root, entry.name));
}
