import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSessionConfig,
  createRunFiles,
  defaultRuntimeRoot,
  removeKeyFile,
  removeRunFiles,
  type ApiKeyCredentials,
  type ConsoleLoginCredentials,
  type RunFiles,
} from "./config";

const BUILT_IN: ApiKeyCredentials = {
  auth: "api_key",
  providerId: "groq",
  model: "llama-3.3-70b",
  baseUrl: null,
  apiKey: "sk-test-A",
};
const CONSOLE: ConsoleLoginCredentials = {
  auth: "console_login",
  providerId: "opencode-go",
  model: "kimi-k2.7-code",
  baseUrl: null,
};
const CUSTOM: ApiKeyCredentials = {
  auth: "api_key",
  providerId: "custom",
  model: "my-model",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiKey: "sk-test-B",
};
const ASK_ALL = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  external_directory: "ask",
};

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeweave-config-test-"));
  roots.push(root);
  return root;
}

function keyPathOf(files: RunFiles): string {
  if (files.keyFile === null) {
    throw new Error("the run has no key file");
  }
  return files.keyFile;
}

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("buildSessionConfig", () => {
  it("built_in_provider_gets_only_the_key_reference", () => {
    expect(
      buildSessionConfig({ credentials: BUILT_IN, keyFilePath: "/run/key" }),
    ).toEqual({
      enabled_providers: ["groq"],
      model: "groq/llama-3.3-70b",
      small_model: "groq/llama-3.3-70b",
      autoupdate: false,
      share: "disabled",
      permission: ASK_ALL,
      provider: { groq: { options: { apiKey: "{file:/run/key}" } } },
    });
  });

  it("custom_endpoint_declares_an_openai_compatible_provider", () => {
    expect(
      buildSessionConfig({ credentials: CUSTOM, keyFilePath: "/run/key" }),
    ).toEqual({
      enabled_providers: ["custom"],
      model: "custom/my-model",
      small_model: "custom/my-model",
      autoupdate: false,
      share: "disabled",
      permission: ASK_ALL,
      provider: {
        custom: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "{file:/run/key}",
            baseURL: "http://127.0.0.1:9999/v1",
          },
          models: { "my-model": { name: "my-model" } },
        },
      },
    });
  });

  it("baseUrl account declares the provider tier models", () => {
    const credentials: ApiKeyCredentials = {
      auth: "api_key",
      providerId: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test-C",
    };

    const { provider } = buildSessionConfig({
      credentials,
      keyFilePath: "/run/key",
    });

    expect(provider.groq?.models).toEqual({
      "llama-3.3-70b-versatile": { name: "llama-3.3-70b-versatile" },
      "openai/gpt-oss-20b": { name: "openai/gpt-oss-20b" },
      "openai/gpt-oss-120b": { name: "openai/gpt-oss-120b" },
    });
  });

  it("go_base_url_account_declares_the_go_tier_models", () => {
    const credentials: ApiKeyCredentials = {
      auth: "api_key",
      providerId: "opencode-go",
      model: "kimi-k2.7-code",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test-D",
    };

    const { provider } = buildSessionConfig({
      credentials,
      keyFilePath: "/run/key",
    });

    const ids = [
      "kimi-k3",
      "kimi-k3.1-pro",
      "qwen3.8-max",
      "grok-4.7",
      "kimi-k2.7-code",
      "glm-5.2",
      "gpt-5.6-luna",
      "mimo-v2.6-flash",
      "longcat-2.0",
      "glm-5.3-flash",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "hy3",
      "gpt-6-luna",
      "minimax-m3.1-flash",
      "claude-haiku-5-5",
      "mimo-v2.6-pro",
      "minimax-m3",
    ];
    expect(provider["opencode-go"]?.models).toEqual(
      Object.fromEntries(ids.map((id) => [id, { name: id }])),
    );
  });

  it("baseUrl account whose model is a tier model declares it once", () => {
    const credentials: ApiKeyCredentials = {
      auth: "api_key",
      providerId: "groq",
      model: "openai/gpt-oss-120b",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test-C",
    };

    const { provider } = buildSessionConfig({
      credentials,
      keyFilePath: "/run/key",
    });

    expect(provider.groq?.models).toEqual({
      "openai/gpt-oss-120b": { name: "openai/gpt-oss-120b" },
      "openai/gpt-oss-20b": { name: "openai/gpt-oss-20b" },
    });
  });
});

describe("run files", () => {
  it("hold_the_key_and_a_config_that_references_it", async () => {
    const runtimeRoot = await newRoot();

    const files = await createRunFiles({
      credentials: BUILT_IN,
      runtimeRoot,
      buildConfig: buildSessionConfig,
    });

    expect(files.dir.startsWith(runtimeRoot)).toBe(true);
    expect(await readdir(files.dir)).toEqual(["api-key", "opencode.json"]);
    expect(await readFile(keyPathOf(files), "utf8")).toBe("sk-test-A");
    expect(
      JSON.parse(await readFile(files.configFile, "utf8")) as unknown,
    ).toMatchObject({
      provider: {
        groq: { options: { apiKey: `{file:${keyPathOf(files)}}` } },
      },
    });
  });

  it("run files for a console account contain no key file and no file reference", async () => {
    const files = await createRunFiles({
      credentials: CONSOLE,
      runtimeRoot: await newRoot(),
      buildConfig: buildSessionConfig,
    });

    expect(files.keyFile).toBeNull();
    expect(await readdir(files.dir)).toEqual(["opencode.json"]);
    const written = await readFile(files.configFile, "utf8");
    expect(written).not.toContain("{file:");
    expect(JSON.parse(written) as unknown).toMatchObject({
      model: "opencode-go/kimi-k2.7-code",
      provider: {},
    });
    await removeKeyFile(files);
    expect(await readdir(files.dir)).toEqual(["opencode.json"]);
  });

  it("run_files_hold_the_config_from_the_given_builder", async () => {
    const files = await createRunFiles({
      credentials: BUILT_IN,
      runtimeRoot: await newRoot(),
      buildConfig: (input) => ({ marker: input.keyFilePath }),
    });

    expect(
      JSON.parse(await readFile(files.configFile, "utf8")) as unknown,
    ).toEqual({ marker: keyPathOf(files) });
  });

  it.skipIf(process.platform === "win32")(
    "are_private_to_the_owner",
    async () => {
      const files = await createRunFiles({
        credentials: BUILT_IN,
        runtimeRoot: await newRoot(),
        buildConfig: buildSessionConfig,
      });

      expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(keyPathOf(files))).mode & 0o777).toBe(0o600);
      expect((await stat(files.configFile)).mode & 0o777).toBe(0o600);
    },
  );

  it("removing_the_key_keeps_the_config", async () => {
    const files = await createRunFiles({
      credentials: BUILT_IN,
      runtimeRoot: await newRoot(),
      buildConfig: buildSessionConfig,
    });

    await removeKeyFile(files);
    await removeKeyFile(files);

    expect(await readdir(files.dir)).toEqual(["opencode.json"]);
  });

  it("removal_is_idempotent", async () => {
    const files = await createRunFiles({
      credentials: BUILT_IN,
      runtimeRoot: await newRoot(),
      buildConfig: buildSessionConfig,
    });

    await removeRunFiles(files);
    await removeRunFiles(files);

    await expect(stat(files.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two_runs_never_share_a_directory", async () => {
    const runtimeRoot = await newRoot();

    const first = await createRunFiles({
      credentials: BUILT_IN,
      runtimeRoot,
      buildConfig: buildSessionConfig,
    });
    const second = await createRunFiles({
      credentials: CUSTOM,
      runtimeRoot,
      buildConfig: buildSessionConfig,
    });

    expect(first.dir).not.toBe(second.dir);
    expect(await readFile(keyPathOf(second), "utf8")).toBe("sk-test-B");
  });

  it("creation_fails_without_a_runtime_root", async () => {
    const missing = join(await newRoot(), "absent");

    await expect(
      createRunFiles({
        credentials: BUILT_IN,
        runtimeRoot: missing,
        buildConfig: buildSessionConfig,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("defaultRuntimeRoot", () => {
  it("prefers_xdg_runtime_dir_and_falls_back_to_tmpdir", () => {
    expect(defaultRuntimeRoot({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000",
    );
    expect(defaultRuntimeRoot({})).toBe(tmpdir());
    expect(defaultRuntimeRoot({ XDG_RUNTIME_DIR: "" })).toBe(tmpdir());
  });
});
