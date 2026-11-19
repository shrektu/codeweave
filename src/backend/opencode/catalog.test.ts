import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import {
  OPENCODE_RIG_EXECUTABLE,
  OPENCODE_RIG_PASSWORD,
  ScriptedOpencodeContainer,
} from "../../../tests/fakes/fakeOpencodeServer";
import { rigProcesses } from "../../../tests/fakes/rigProcesses";
import { settled } from "../../../tests/fakes/settle";

import {
  CATALOG_PROBE_TIMEOUT_MESSAGE,
  createModelCatalog,
  toCatalogModels,
  type ModelCatalogDeps,
  type ModelCatalogService,
} from "./catalog";
import { findFreePort } from "./port";

const CAPABLE = {
  toolcall: true,
  input: { text: true },
  output: { text: true },
};

function model(
  id: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    name: `Name ${id}`,
    capabilities: CAPABLE,
    cost: { input: 1, output: 2 },
    limit: { context: 1000, output: 100 },
    ...extra,
  };
}

function providers(
  ...entries: readonly [string, readonly Record<string, unknown>[]][]
): { providers: { id: string; models: Record<string, unknown> }[] } {
  return {
    providers: entries.map(([id, models]) => ({
      id,
      models: Object.fromEntries(models.map((item) => [String(item.id), item])),
    })),
  };
}

const SHORT_PROBE_BUDGET_MS = 20;
const SLOW_LAUNCH_MS = 80;
const roots: string[] = [];
const containers: ScriptedOpencodeContainer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    containers
      .splice(0)
      .flatMap((container) => container.servers.map((s) => s.close())),
  );
  await Promise.allSettled(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface CatalogRig {
  readonly catalog: ModelCatalogService;
  readonly container: ScriptedOpencodeContainer;
  readonly executable: { current: string };
  readonly directory: string;
}

async function catalogRig(
  resolve?: () => Promise<string>,
  overrides: Partial<ModelCatalogDeps> = {},
): Promise<CatalogRig> {
  const directory = await mkdtemp(join(tmpdir(), "codeweave-catalog-"));
  roots.push(directory);
  const container = new ScriptedOpencodeContainer([]);
  containers.push(container);
  const executable = { current: OPENCODE_RIG_EXECUTABLE };
  let runs = 0;
  const catalog = createModelCatalog({
    processes: rigProcesses(container),
    envFor: () => ({ PATH: "/usr/bin" }),
    resolveExecutable: resolve ?? (() => Promise.resolve(executable.current)),
    directory,
    platform: "linux",
    fetchImpl: fetch,
    freePort: findFreePort,
    newPassword: () => OPENCODE_RIG_PASSWORD,
    newRunId: () => {
      runs += 1;
      return `catalog-${String(runs)}`;
    },
    stopGraceMs: 25,
    readyTimeoutMs: 200,
    requestTimeoutMs: 500,
    ...overrides,
  });
  return { catalog, container, executable, directory };
}

it("zero_cost_model_is_free_even_on_a_paid_provider", () => {
  const result = toCatalogModels(
    providers([
      "deepseek",
      [
        model("deepseek-flash", { cost: { input: 0, output: 0 } }),
        model("deepseek-v4-pro", { cost: { input: 0.5, output: 1.5 } }),
      ],
    ]),
  );

  expect(result.map((item) => [item.modelId, item.free])).toEqual([
    ["deepseek-flash", true],
    ["deepseek-v4-pro", false],
  ]);
});

it("free_suffix_marks_model_free_despite_positive_cost", () => {
  const result = toCatalogModels(
    providers([
      "moonshotai",
      [model("kimi:free", { cost: { input: 3, output: 4 } })],
    ]),
  );

  expect(result).toEqual([
    {
      providerId: "moonshotai",
      modelId: "kimi:free",
      name: "Name kimi:free",
      contextWindow: 1000,
      costIn: 3,
      costOut: 4,
      free: true,
      trainsOnData: "unknown",
    },
  ]);
});

it("free_tier_provider_marks_every_model_free", () => {
  const [first] = toCatalogModels(
    providers([
      "groq",
      [model("llama", { cost: { input: 0.5, output: 0.7 } })],
    ]),
  );

  expect(first).toMatchObject({ free: true, trainsOnData: false });
});

it("paid_openrouter_model_is_not_free", () => {
  const result = toCatalogModels(
    providers([
      "openrouter",
      [
        model("vendor/paid-model", { cost: { input: 3, output: 15 } }),
        model("vendor/tagged:free", { cost: { input: 3, output: 15 } }),
        model("vendor/zero", { cost: { input: 0, output: 0 } }),
      ],
    ]),
  );

  expect(result.map((item) => [item.modelId, item.free])).toEqual([
    ["vendor/paid-model", false],
    ["vendor/tagged:free", true],
    ["vendor/zero", true],
  ]);
});

it("go_models_are_free_only_at_zero_cost", () => {
  const result = toCatalogModels(
    providers([
      "opencode-go",
      [
        model("kimi-k2.7-code", { cost: { input: 0.95, output: 4 } }),
        model("beam-free", { cost: { input: 0, output: 0 } }),
        model("tagged:free", { cost: { input: 3, output: 15 } }),
      ],
    ]),
  );

  expect(result.map((item) => [item.modelId, item.free])).toEqual([
    ["kimi-k2.7-code", false],
    ["beam-free", true],
    ["tagged:free", true],
  ]);
});

it("go_models_report_unknown_training", () => {
  const [first] = toCatalogModels(
    providers(["opencode-go", [model("kimi-k2.7-code")]]),
  );

  expect(first).toMatchObject({
    providerId: "opencode-go",
    trainsOnData: "unknown",
  });
});

it("google_models_report_training_on_data", () => {
  const [first] = toCatalogModels(providers(["google", [model("gemini-x")]]));

  expect(first).toMatchObject({ providerId: "google", trainsOnData: true });
});

it("unknown_and_custom_provider_ids_are_dropped", () => {
  const result = toCatalogModels(
    providers(
      ["azure", [model("gpt-x")]],
      ["custom", [model("local-model")]],
      ["mistral", [model("mistral-large")]],
    ),
  );

  expect(result.map((item) => item.providerId)).toEqual(["mistral"]);
});

it("models_without_tool_calls_or_text_io_are_dropped", () => {
  const result = toCatalogModels(
    providers([
      "groq",
      [
        model("kept"),
        model("no-tools", {
          capabilities: { ...CAPABLE, toolcall: false },
        }),
        model("no-text-input", {
          capabilities: { ...CAPABLE, input: { text: false } },
        }),
        model("no-text-output", {
          capabilities: { ...CAPABLE, output: { text: false } },
        }),
      ],
    ]),
  );

  expect(result.map((item) => item.modelId)).toEqual(["kept"]);
});

it("model_without_capabilities_or_with_wrong_shape_is_dropped", () => {
  const withoutCapabilities = model("bare");
  delete withoutCapabilities.capabilities;

  const result = toCatalogModels(
    providers([
      "groq",
      [
        withoutCapabilities,
        model("broken", { capabilities: "yes" }),
        model("ok"),
      ],
    ]),
  );

  expect(result.map((item) => item.modelId)).toEqual(["ok"]);
});

it("missing_cost_and_limit_become_null_without_marking_free_by_cost", () => {
  const bare = model("paid-bare");
  delete bare.cost;
  delete bare.limit;

  const [first] = toCatalogModels(providers(["deepseek", [bare]]));

  expect(first).toMatchObject({
    contextWindow: null,
    costIn: null,
    costOut: null,
    free: false,
  });
});

it("catalog_probe_result_is_cached_for_the_backend_process", async () => {
  const rig = await catalogRig();
  rig.container.config.providers = providers(["groq", [model("llama")]]);

  const first = await rig.catalog.load();
  const second = await rig.catalog.load();

  expect(second).toEqual(first);
  expect(first.models.map((item) => item.modelId)).toEqual(["llama"]);
  expect(rig.container.specs).toHaveLength(1);
  expect(rig.container.contained[0]?.stopCalls).toHaveLength(1);
});

it("concurrent_loads_share_one_probe", async () => {
  const rig = await catalogRig();
  rig.container.config.providers = providers(["groq", [model("llama")]]);

  const [first, second] = await Promise.all([
    rig.catalog.load(),
    rig.catalog.load(),
  ]);

  expect(second).toEqual(first);
  expect(rig.container.specs).toHaveLength(1);
});

it("changed_executable_invalidates_the_cache", async () => {
  const rig = await catalogRig();
  rig.container.config.providers = providers(["groq", [model("llama")]]);

  await rig.catalog.load();
  rig.executable.current = "/opt/other/opencode";
  await rig.catalog.load();

  expect(rig.container.specs.map((spec) => spec.command)).toEqual([
    OPENCODE_RIG_EXECUTABLE,
    "/opt/other/opencode",
  ]);
});

const SLOW_WARM_UP_MS = 100;
const OTHER_EXECUTABLE = "/opt/other/opencode";

async function loadWhileProbeRuns(
  rig: CatalogRig,
): Promise<
  readonly [
    Awaited<ReturnType<ModelCatalogService["load"]>>,
    Awaited<ReturnType<ModelCatalogService["load"]>>,
  ]
> {
  rig.container.config.providers = providers(["groq", [model("llama")]]);
  rig.container.config.delayedRoutes = new Map([["config", SLOW_WARM_UP_MS]]);
  const first = rig.catalog.load();
  await settled(() => {
    expect(rig.container.servers).toHaveLength(1);
  });
  rig.executable.current = OTHER_EXECUTABLE;
  rig.container.config.providers = providers([
    "mistral",
    [model("mistral-large")],
  ]);
  const second = rig.catalog.load();
  return [await first, await second];
}

it("executable_change_during_probe_runs_probes_one_at_a_time", async () => {
  const rig = await catalogRig();

  const [first, second] = await loadWhileProbeRuns(rig);

  expect(first.models.map((item) => item.modelId)).toEqual(["llama"]);
  expect(second.error).toBeNull();
  expect(second.models.map((item) => item.modelId)).toEqual(["mistral-large"]);
  expect(rig.container.specs.map((spec) => spec.command)).toEqual([
    OPENCODE_RIG_EXECUTABLE,
    OTHER_EXECUTABLE,
  ]);
  expect(rig.container.contained.map((item) => item.stopCalls.length)).toEqual([
    1, 1,
  ]);
});

it("stale_probe_does_not_overwrite_newer_cache", async () => {
  const rig = await catalogRig();
  await loadWhileProbeRuns(rig);

  const third = await rig.catalog.load();

  expect(third.models.map((item) => item.modelId)).toEqual(["mistral-large"]);
  expect(rig.container.specs).toHaveLength(2);
});

it("probe_past_deadline_reports_error_and_stops_process", async () => {
  const rig = await catalogRig(undefined, { probeTimeoutMs: 40 });
  rig.container.config.providers = providers(["groq", [model("llama")]]);
  rig.container.config.delayedRoutes = new Map([["config", 400]]);

  const result = await rig.catalog.load();

  expect(result).toEqual({
    models: [],
    error: "model catalog probe timed out",
  });
  expect(rig.container.contained[0]?.stopCalls).toHaveLength(1);
});

it("probe_whose_launch_outlasts_the_budget_times_out_without_a_timer_warning", async () => {
  const emitWarning = vi.spyOn(process, "emitWarning");
  const rig = await catalogRig(undefined, {
    probeTimeoutMs: SHORT_PROBE_BUDGET_MS,
    freePort: async () => {
      await sleep(SLOW_LAUNCH_MS);
      return findFreePort();
    },
  });
  rig.container.config.providers = providers(["groq", [model("llama")]]);
  rig.container.config.delayedRoutes = new Map([["config", 400]]);

  const result = await rig.catalog.load();

  expect(result).toEqual({
    models: [],
    error: CATALOG_PROBE_TIMEOUT_MESSAGE,
  });
  expect(rig.container.contained[0]?.stopCalls).toHaveLength(1);
  expect(
    emitWarning.mock.calls.filter(
      (call: readonly unknown[]) => call[1] === "TimeoutNegativeWarning",
    ),
  ).toEqual([]);
});

it("failed_probe_reports_error_and_is_retried_next_time", async () => {
  const rig = await catalogRig();
  rig.container.config.exitBeforeListening = true;

  const failed = await rig.catalog.load();
  rig.container.config.exitBeforeListening = false;
  rig.container.config.providers = providers(["groq", [model("llama")]]);
  const retried = await rig.catalog.load();

  expect(failed.models).toEqual([]);
  expect(failed.error).toBe("Agent process exited");
  expect(retried.error).toBeNull();
  expect(retried.models.map((item) => item.modelId)).toEqual(["llama"]);
});

it("unresolvable_executable_yields_empty_list_with_message", async () => {
  const rig = await catalogRig(() =>
    Promise.reject(new Error("The OpenCode executable was not found")),
  );

  const result = await rig.catalog.load();

  expect(result).toEqual({
    models: [],
    error: "The OpenCode executable was not found",
  });
  expect(rig.container.specs).toHaveLength(0);
});

it("probe_serves_on_loopback_with_isolated_directories", async () => {
  const rig = await catalogRig();
  rig.container.config.providers = providers(["groq", [model("llama")]]);

  await rig.catalog.load();

  const [spec] = rig.container.specs;
  expect(spec?.cwd).toBe(rig.directory);
  expect(spec?.env).toMatchObject({
    HOME: join(rig.directory, "account", "home"),
    XDG_DATA_HOME: join(rig.directory, "account", "data"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  });
  expect(spec?.args.slice(0, 4)).toEqual([
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
  ]);
  expect(spec?.args.at(-1)).toBe("--pure");
  expect(spec?.runId).toBe("catalog-1");
});
