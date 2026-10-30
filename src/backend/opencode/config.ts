import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_FILE_NAME,
  FILE_REFERENCE_PREFIX,
  FILE_REFERENCE_SUFFIX,
  KEY_FILE_NAME,
  OPENAI_COMPATIBLE_PACKAGE,
  PERMISSION_ASK,
  RUN_DIR_MODE,
  RUN_DIR_PREFIX,
  SECRET_FILE_MODE,
  SHARE_DISABLED,
  XDG_RUNTIME_DIR_ENV,
} from "./constants";

export interface OpencodeCredentials {
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly apiKey: string;
}

export interface OpencodeProviderConfig {
  readonly options: { readonly apiKey: string; readonly baseURL?: string };
  readonly npm?: string;
  readonly models?: Readonly<Record<string, { readonly name: string }>>;
}

export interface OpencodeSessionConfig {
  readonly enabled_providers: readonly string[];
  readonly model: string;
  readonly small_model: string;
  readonly autoupdate: false;
  readonly share: typeof SHARE_DISABLED;
  readonly permission: typeof ASKED_PERMISSIONS;
  readonly provider: Readonly<Record<string, OpencodeProviderConfig>>;
}

export interface SessionConfigInput {
  readonly credentials: OpencodeCredentials;
  readonly keyFilePath: string;
}

export interface RunFiles {
  readonly dir: string;
  readonly keyFile: string;
  readonly configFile: string;
}

export interface RunFilesInput {
  readonly credentials: OpencodeCredentials;
  readonly runtimeRoot: string;
}

const ASKED_PERMISSIONS = {
  edit: PERMISSION_ASK,
  bash: PERMISSION_ASK,
  webfetch: PERMISSION_ASK,
  external_directory: PERMISSION_ASK,
} as const;

function providerConfig(input: SessionConfigInput): OpencodeProviderConfig {
  const { credentials, keyFilePath } = input;
  const apiKey = `${FILE_REFERENCE_PREFIX}${keyFilePath}${FILE_REFERENCE_SUFFIX}`;
  if (credentials.baseUrl === null) {
    return { options: { apiKey } };
  }
  return {
    npm: OPENAI_COMPATIBLE_PACKAGE,
    options: { apiKey, baseURL: credentials.baseUrl },
    models: { [credentials.model]: { name: credentials.model } },
  };
}

export function buildSessionConfig(
  input: SessionConfigInput,
): OpencodeSessionConfig {
  const { providerId, model } = input.credentials;
  const qualified = `${providerId}/${model}`;
  return {
    enabled_providers: [providerId],
    model: qualified,
    small_model: qualified,
    autoupdate: false,
    share: SHARE_DISABLED,
    permission: ASKED_PERMISSIONS,
    provider: { [providerId]: providerConfig(input) },
  };
}

export function defaultRuntimeRoot(env: NodeJS.ProcessEnv): string {
  const runtimeDir = env[XDG_RUNTIME_DIR_ENV];
  return runtimeDir === undefined || runtimeDir === "" ? tmpdir() : runtimeDir;
}

export async function removeRunFiles(files: RunFiles): Promise<void> {
  await rm(files.dir, { recursive: true, force: true });
}

export async function removeKeyFile(files: RunFiles): Promise<void> {
  await rm(files.keyFile, { force: true });
}

export async function createRunFiles(input: RunFilesInput): Promise<RunFiles> {
  const dir = await mkdtemp(join(input.runtimeRoot, RUN_DIR_PREFIX));
  const files: RunFiles = {
    dir,
    keyFile: join(dir, KEY_FILE_NAME),
    configFile: join(dir, CONFIG_FILE_NAME),
  };
  try {
    await chmod(dir, RUN_DIR_MODE);
    await writeFile(files.keyFile, input.credentials.apiKey, {
      mode: SECRET_FILE_MODE,
      flag: "wx",
    });
    const config = buildSessionConfig({
      credentials: input.credentials,
      keyFilePath: files.keyFile,
    });
    await writeFile(files.configFile, JSON.stringify(config), {
      mode: SECRET_FILE_MODE,
      flag: "wx",
    });
  } catch (error) {
    await removeRunFiles(files);
    throw error;
  }
  return files;
}
