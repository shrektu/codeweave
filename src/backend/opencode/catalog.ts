import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  API_PROVIDERS,
  ApiProviderId,
  ApiTier,
  FreeModels,
} from "../../domain/apiProviders";
import { FREE_MODEL_MARKER } from "../../domain/modelChoice";
import { PermissionProfile, ProviderId } from "../../domain/types";
import { CATALOG_PROBE_TIMEOUT_MS } from "../../shared/constants";
import type { CatalogModel, ModelCatalog } from "../../shared/views";
import type { AgentStartSpec } from "../agentAdapter";
import type { AgentProcesses } from "../agentProcesses";

import { createOpencodeClient } from "./client";
import {
  CONFIG_FILE_NAME,
  FILE_REFERENCE_PREFIX,
  FILE_REFERENCE_SUFFIX,
  KEY_FILE_NAME,
  READY_TIMEOUT_MS,
  RUN_DIR_MODE,
  SECRET_FILE_MODE,
  SHARE_DISABLED,
  OpencodeGeneration,
} from "./constants";
import { accountDirs, buildOpencodeLaunch } from "./launch";
import type { ProvidersResponse } from "./protocol";
import type { GenerationProbe } from "./version";
import { watchProcess } from "./watch";

export const CATALOG_DIR_NAME = "opencode-catalog";
export const CATALOG_RUN_ID_PREFIX = "catalog-";
export const CATALOG_PROBE_TIMEOUT_MESSAGE = "model catalog probe timed out";

const CATALOG_ACCOUNT_DIR = "account";
const CATALOG_RUN_DIR = "run";
const CATALOG_PLACEHOLDER_KEY = "catalog-placeholder-key";
const CATALOG_ACCOUNT_ID = "opencode-catalog";

const CATALOG_PROVIDER_IDS: readonly ApiProviderId[] = Object.values(
  ApiProviderId,
).filter((id) => id !== ApiProviderId.custom);

const PROVIDER_BY_OPENCODE_ID: ReadonlyMap<string, ApiProviderId> = new Map(
  CATALOG_PROVIDER_IDS.map((id) => [API_PROVIDERS[id].opencodeId, id] as const),
);

const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  capabilities: z.object({
    toolcall: z.boolean(),
    input: z.object({ text: z.boolean() }),
    output: z.object({ text: z.boolean() }),
  }),
  cost: z.object({ input: z.number(), output: z.number() }).optional(),
  limit: z.object({ context: z.number() }).optional(),
});
type RegistryModel = z.infer<typeof ModelSchema>;

export interface ModelCatalogDeps {
  readonly processes: AgentProcesses;
  readonly envFor: (spec: AgentStartSpec) => Record<string, string>;
  readonly resolveExecutable: () => Promise<string>;
  readonly generationFor: GenerationProbe;
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly comSpec?: string;
  readonly fetchImpl: typeof fetch;
  readonly freePort: () => Promise<number>;
  readonly newPassword: () => string;
  readonly newRunId: () => string;
  readonly stopGraceMs: number;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
}

export interface ModelCatalogService {
  load(): Promise<ModelCatalog>;
}

interface CatalogFiles {
  readonly configDir: string;
  readonly configFile: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUsableModel(model: RegistryModel): boolean {
  const { toolcall, input, output } = model.capabilities;
  return toolcall && input.text && output.text;
}

function toCatalogModel(
  providerId: ApiProviderId,
  model: RegistryModel,
): CatalogModel {
  const info = API_PROVIDERS[providerId];
  const costIn = model.cost?.input ?? null;
  const costOut = model.cost?.output ?? null;
  return {
    providerId,
    modelId: model.id,
    name: model.name,
    contextWindow: model.limit?.context ?? null,
    costIn,
    costOut,
    free:
      model.id.includes(FREE_MODEL_MARKER) ||
      (costIn === 0 && costOut === 0) ||
      (info.tier === ApiTier.free && info.freeModels === FreeModels.all),
    trainsOnData: info.trainsOnData,
  };
}

export function toCatalogModels(response: ProvidersResponse): CatalogModel[] {
  return response.providers.flatMap((provider) => {
    const providerId = PROVIDER_BY_OPENCODE_ID.get(provider.id);
    if (providerId === undefined) {
      return [];
    }
    return Object.values(provider.models).flatMap((raw) => {
      const parsed = ModelSchema.safeParse(raw);
      return parsed.success && isUsableModel(parsed.data)
        ? [toCatalogModel(providerId, parsed.data)]
        : [];
    });
  });
}

function catalogConfig(keyFile: string): Record<string, unknown> {
  const apiKey = `${FILE_REFERENCE_PREFIX}${keyFile}${FILE_REFERENCE_SUFFIX}`;
  const ids = CATALOG_PROVIDER_IDS.map((id) => API_PROVIDERS[id].opencodeId);
  return {
    enabled_providers: ids,
    autoupdate: false,
    share: SHARE_DISABLED,
    provider: Object.fromEntries(
      ids.map((id) => [id, { options: { apiKey } }]),
    ),
  };
}

async function writeCatalogFiles(directory: string): Promise<CatalogFiles> {
  const configDir = join(directory, CATALOG_ACCOUNT_DIR);
  const runDir = join(directory, CATALOG_RUN_DIR);
  await Promise.all(
    [...Object.values(accountDirs(configDir)), runDir].map((dir) =>
      mkdir(dir, { recursive: true, mode: RUN_DIR_MODE }),
    ),
  );
  const keyFile = join(runDir, KEY_FILE_NAME);
  const configFile = join(runDir, CONFIG_FILE_NAME);
  await writeFile(keyFile, CATALOG_PLACEHOLDER_KEY, { mode: SECRET_FILE_MODE });
  await writeFile(configFile, JSON.stringify(catalogConfig(keyFile)), {
    mode: SECRET_FILE_MODE,
  });
  return { configDir, configFile };
}

function startSpecFor(
  deps: ModelCatalogDeps,
  files: CatalogFiles,
  executable: string,
  runId: string,
): AgentStartSpec {
  return {
    account: {
      id: CATALOG_ACCOUNT_ID,
      provider: ProviderId.opencode,
      label: CATALOG_ACCOUNT_ID,
      configDir: files.configDir,
      order: 0,
    },
    cwd: deps.directory,
    profile: PermissionProfile.plan,
    runId,
    executable,
  };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(CATALOG_PROBE_TIMEOUT_MESSAGE));
  }, ms);
  try {
    return await Promise.race([work, promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeModels(
  deps: ModelCatalogDeps,
  executable: string,
): Promise<CatalogModel[]> {
  const startedAt = Date.now();
  const files = await writeCatalogFiles(deps.directory);
  const runId = deps.newRunId();
  const password = deps.newPassword();
  const env = deps.envFor(startSpecFor(deps, files, executable, runId));
  await deps.generationFor(executable, {
    env: { ...env, ...accountDirs(files.configDir) },
    cwd: deps.directory,
  });
  const launch = buildOpencodeLaunch({
    generation: OpencodeGeneration.v1,
    executable,
    configDir: files.configDir,
    configFile: files.configFile,
    password,
    port: await deps.freePort(),
    env,
    platform: deps.platform,
    comSpec: deps.comSpec,
  });
  const agentProcess = await deps.processes.start({
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd: deps.directory,
    runId,
    ...(launch.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
  });
  const watch = watchProcess(agentProcess.contained);
  const query = async (): Promise<CatalogModel[]> => {
    const baseUrl = await watch.listening(
      deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    const client = createOpencodeClient({
      baseUrl,
      password,
      directory: deps.directory,
      fetchImpl: deps.fetchImpl,
      ...(deps.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: deps.requestTimeoutMs }),
    });
    await watch.untilExit(client.warmUp());
    return toCatalogModels(await watch.untilExit(client.providers()));
  };
  const budgetMs = deps.probeTimeoutMs ?? CATALOG_PROBE_TIMEOUT_MS;
  try {
    return await withDeadline(query(), budgetMs - (Date.now() - startedAt));
  } finally {
    const stopped = await agentProcess.stop(deps.stopGraceMs);
    if (!stopped.ok) {
      console.error(
        `model catalog probe ${runId} left processes behind: ${stopped.survivors.join(",")}`,
      );
    }
  }
}

function failure(error: unknown): ModelCatalog {
  return { models: [], error: messageOf(error) };
}

interface CachedCatalog {
  readonly executable: string;
  readonly order: number;
  readonly models: readonly CatalogModel[];
}

export function createModelCatalog(
  deps: ModelCatalogDeps,
): ModelCatalogService {
  let cached: CachedCatalog | null = null;
  let lastOrder = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<ModelCatalog>>();

  async function probe(
    executable: string,
    order: number,
  ): Promise<ModelCatalog> {
    try {
      const models = await probeModels(deps, executable);
      if (cached === null || cached.order < order) {
        cached = { executable, order, models };
      }
      return { models, error: null };
    } catch (error) {
      console.error("the model catalog probe failed", error);
      return failure(error);
    }
  }

  function enqueue(executable: string): Promise<ModelCatalog> {
    lastOrder += 1;
    const order = lastOrder;
    const result = tail.then(() => probe(executable, order));
    tail = result;
    pending.set(executable, result);
    void result.finally(() => {
      if (pending.get(executable) === result) {
        pending.delete(executable);
      }
    });
    return result;
  }

  return {
    async load(): Promise<ModelCatalog> {
      let executable: string;
      try {
        executable = await deps.resolveExecutable();
      } catch (error) {
        return failure(error);
      }
      if (cached?.executable === executable) {
        return { models: [...cached.models], error: null };
      }
      return pending.get(executable) ?? enqueue(executable);
    },
  };
}
