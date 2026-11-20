import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API_PROVIDERS, ApiAuth } from "../../domain/apiProviders";
import { MODEL_TIERS } from "../../domain/modelTiers";
import type { AgentToolAccess } from "../agentAdapter";

import {
  AUTHORIZATION_HEADER,
  BEARER_PREFIX,
  CONFIG_FILE_NAME,
  FILE_REFERENCE_PREFIX,
  FILE_REFERENCE_SUFFIX,
  KEY_FILE_NAME,
  MCP_SERVER_TYPE_REMOTE,
  OPENAI_COMPATIBLE_PACKAGE,
  PERMISSION_ASK,
  RUN_DIR_MODE,
  RUN_DIR_PREFIX,
  SECRET_FILE_MODE,
  SHARE_DISABLED,
  XDG_RUNTIME_DIR_ENV,
} from "./constants";

export interface ApiKeyCredentials {
  readonly auth: typeof ApiAuth.apiKey;
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly apiKey: string;
}

export interface ConsoleLoginCredentials {
  readonly auth: typeof ApiAuth.consoleLogin;
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl: null;
}

export type OpencodeCredentials = ApiKeyCredentials | ConsoleLoginCredentials;

export interface OpencodeProviderConfig {
  readonly options: { readonly apiKey: string; readonly baseURL?: string };
  readonly npm?: string;
  readonly models?: Readonly<Record<string, { readonly name: string }>>;
}

export interface OpencodeMcpServer {
  readonly type: typeof MCP_SERVER_TYPE_REMOTE;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly enabled: true;
}

export interface OpencodeSessionConfig {
  readonly mcp?: Readonly<Record<string, OpencodeMcpServer>>;
  readonly enabled_providers: readonly string[];
  readonly model: string;
  readonly small_model: string;
  readonly autoupdate: false;
  readonly share: typeof SHARE_DISABLED;
  readonly permission: typeof ASKED_PERMISSIONS;
  readonly provider: Readonly<Record<string, OpencodeProviderConfig>>;
}

export type SessionConfigInput = (
  | {
      readonly credentials: ApiKeyCredentials;
      readonly keyFilePath: string;
    }
  | {
      readonly credentials: ConsoleLoginCredentials;
      readonly keyFilePath: null;
    }
) & { readonly tools?: AgentToolAccess | undefined };

export interface RunFiles {
  readonly dir: string;
  readonly keyFile: string | null;
  readonly configFile: string;
}

export interface RunFilesInput {
  readonly credentials: OpencodeCredentials;
  readonly runtimeRoot: string;
  readonly tools?: AgentToolAccess | undefined;
  readonly buildConfig: (input: SessionConfigInput) => object;
}

const ASKED_PERMISSIONS = {
  edit: PERMISSION_ASK,
  bash: PERMISSION_ASK,
  webfetch: PERMISSION_ASK,
  external_directory: PERMISSION_ASK,
} as const;

function providerConfig(
  credentials: ApiKeyCredentials,
  keyFilePath: string,
): OpencodeProviderConfig {
  const apiKey = `${FILE_REFERENCE_PREFIX}${keyFilePath}${FILE_REFERENCE_SUFFIX}`;
  if (credentials.baseUrl === null) {
    return { options: { apiKey } };
  }
  return {
    npm: OPENAI_COMPATIBLE_PACKAGE,
    options: { apiKey, baseURL: credentials.baseUrl },
    models: declaredModels(credentials),
  };
}

export function declaredModels(
  credentials: OpencodeCredentials,
): Record<string, { readonly name: string }> {
  const routed = MODEL_TIERS.filter(
    (tier) =>
      API_PROVIDERS[tier.provider].opencodeId === credentials.providerId,
  ).map((tier) => tier.modelId);
  return Object.fromEntries(
    [credentials.model, ...routed].map((model) => [model, { name: model }]),
  );
}

export function bearerHeaders(tools: AgentToolAccess): Record<string, string> {
  return { [AUTHORIZATION_HEADER]: `${BEARER_PREFIX}${tools.token}` };
}

function remoteMcpServer(tools: AgentToolAccess): OpencodeMcpServer {
  return {
    type: MCP_SERVER_TYPE_REMOTE,
    url: tools.url,
    headers: bearerHeaders(tools),
    enabled: true,
  };
}

export function buildSessionConfig(
  input: SessionConfigInput,
): OpencodeSessionConfig {
  const { providerId, model } = input.credentials;
  const qualified = `${providerId}/${model}`;
  return {
    ...(input.tools === undefined
      ? {}
      : { mcp: { [input.tools.server]: remoteMcpServer(input.tools) } }),
    enabled_providers: [providerId],
    model: qualified,
    small_model: qualified,
    autoupdate: false,
    share: SHARE_DISABLED,
    permission: ASKED_PERMISSIONS,
    provider:
      input.keyFilePath === null
        ? {}
        : {
            [providerId]: providerConfig(input.credentials, input.keyFilePath),
          },
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
  if (files.keyFile !== null) {
    await rm(files.keyFile, { force: true });
  }
}

interface PreparedKey {
  readonly keyFile: string | null;
  readonly configInput: SessionConfigInput;
}

async function prepareKey(
  credentials: OpencodeCredentials,
  dir: string,
  tools: AgentToolAccess | undefined,
): Promise<PreparedKey> {
  if (credentials.auth === ApiAuth.consoleLogin) {
    return {
      keyFile: null,
      configInput: { credentials, keyFilePath: null, tools },
    };
  }
  const keyFile = join(dir, KEY_FILE_NAME);
  await writeFile(keyFile, credentials.apiKey, {
    mode: SECRET_FILE_MODE,
    flag: "wx",
  });
  return {
    keyFile,
    configInput: { credentials, keyFilePath: keyFile, tools },
  };
}

export async function createRunFiles(input: RunFilesInput): Promise<RunFiles> {
  const dir = await mkdtemp(join(input.runtimeRoot, RUN_DIR_PREFIX));
  try {
    await chmod(dir, RUN_DIR_MODE);
    const { keyFile, configInput } = await prepareKey(
      input.credentials,
      dir,
      input.tools,
    );
    const configFile = join(dir, CONFIG_FILE_NAME);
    await writeFile(
      configFile,
      JSON.stringify(input.buildConfig(configInput)),
      { mode: SECRET_FILE_MODE, flag: "wx" },
    );
    return { dir, keyFile, configFile };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
