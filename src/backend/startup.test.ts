import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderId, type Account, type ApiAccount } from "../domain/types";
import { IpcErrorCode } from "../shared/protocol";
import { createFakeVault, fakeSecrets } from "../../tests/fakes/fakeVault";
import {
  ACCOUNT_A,
  agentOf,
  closeRigs,
  openRig,
} from "../../tests/fakes/backendRig";
import {
  DEFAULT_PERMISSION_OPTIONS,
  type ScriptStep,
} from "../../tests/fakes/fakeAcpAgent";
import { settled } from "../../tests/fakes/settle";
import {
  hostBinDirWith as binDirWith,
  hostExecutable,
  hostResolverEnv,
  makeTempDir,
} from "../../tests/fakes/processHelpers";

import { API_KEYS_FILE } from "./constants";
import { createKeyStore, type KeyStore } from "./secrets/keyStore";
import { createCredentialsFor, createExecutableResolver } from "./startup";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRigs();
});

describe("createExecutableResolver", () => {
  it("resolves_each_provider_binary_from_path", async () => {
    const dir = await binDirWith("claude", "codex");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.claude, null)).toBe(
      hostExecutable(dir, "claude"),
    );
    expect(resolve(ProviderId.codex, null)).toBe(hostExecutable(dir, "codex"));
  });

  it("configured_path_wins_over_path_lookup", async () => {
    const dir = await binDirWith("codex");
    const custom = await binDirWith("my-codex");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.codex, hostExecutable(custom, "my-codex"))).toBe(
      hostExecutable(custom, "my-codex"),
    );
  });

  it.each([
    [
      ProviderId.claude,
      "The Claude CLI was not found. Install it and restart Codeweave, or set its full path under Settings → Claude executable.",
    ],
    [
      ProviderId.codex,
      "The Codex CLI was not found. Install it and restart Codeweave, or set its full path under Settings → Codex executable.",
    ],
    [
      ProviderId.gemini,
      "The agy CLI was not found. Install it and restart Codeweave, or set its full path under Settings → Gemini executable (agy).",
    ],
    [
      ProviderId.opencode,
      "The OpenCode CLI was not found. Install it and restart Codeweave, or set its full path under Settings → OpenCode executable.",
    ],
  ])("missing_%s_cli_names_the_settings_field", async (provider, message) => {
    const dir = await binDirWith("unrelated");
    const resolve = createExecutableResolver({ PATH: dir }, "linux");

    expect(() => resolve(provider, null)).toThrow(
      expect.objectContaining({ code: IpcErrorCode.UNAVAILABLE, message }),
    );
  });

  it("missing_configured_path_names_the_path_and_field", async () => {
    const dir = await binDirWith("codex");
    const gone = join(dir, "gone");
    const resolve = createExecutableResolver({ PATH: dir }, "linux");

    expect(() => resolve(ProviderId.codex, gone)).toThrow(
      expect.objectContaining({
        code: IpcErrorCode.UNAVAILABLE,
        message: `The Codex CLI was not found at "${gone}". Correct Settings → Codex executable, or clear it so Codeweave searches PATH again.`,
      }),
    );
  });

  it("resolves_opencode_binary_from_path", async () => {
    const dir = await binDirWith("opencode");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.opencode, null)).toBe(
      hostExecutable(dir, "opencode"),
    );
  });

  it("resolves_agy_binary_from_path_for_gemini", async () => {
    const dir = await binDirWith("agy");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(resolve(ProviderId.gemini, null)).toBe(hostExecutable(dir, "agy"));
  });

  it("agy_executable_null_falls_back_to_agy", async () => {
    const dir = await binDirWith("agy");
    const configured = await binDirWith("custom-agy");
    const resolve = createExecutableResolver(
      hostResolverEnv(dir),
      process.platform,
    );

    expect(
      resolve(ProviderId.gemini, hostExecutable(configured, "custom-agy")),
    ).toBe(hostExecutable(configured, "custom-agy"));
    expect(resolve(ProviderId.gemini, null)).toBe(hostExecutable(dir, "agy"));
  });

});

const STORED_KEY = "sk-test-credentials-0001";

function apiAccount(id: string, api: ApiAccount | undefined): Account {
  return {
    id,
    provider: api === undefined ? ProviderId.claude : ProviderId.opencode,
    label: id,
    configDir: `/cfg/${id}`,
    order: 0,
    api,
  };
}

const GROQ_API: ApiAccount = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  baseUrl: null,
  rotation: true,
  auth: "api_key",
};

async function credentialsRig(): Promise<{
  readonly dir: string;
  readonly keyStore: KeyStore;
}> {
  const dir = await makeTempDir();
  const { keyStore } = fakeSecrets(dir);
  return { dir, keyStore };
}

it("credentials_are_null_for_an_account_without_api_data", async () => {
  const { keyStore } = await credentialsRig();
  await keyStore.set("sub-1", STORED_KEY);

  expect(
    await createCredentialsFor(keyStore)(apiAccount("sub-1", undefined)),
  ).toBeNull();
});

it("credentials_are_null_when_no_key_is_stored", async () => {
  const { keyStore } = await credentialsRig();

  expect(
    await createCredentialsFor(keyStore)(apiAccount("api-1", GROQ_API)),
  ).toBeNull();
});

it("credentials_carry_registry_provider_id_model_and_stored_key", async () => {
  const { keyStore } = await credentialsRig();
  await keyStore.set("api-1", STORED_KEY);

  expect(
    await createCredentialsFor(keyStore)(apiAccount("api-1", GROQ_API)),
  ).toEqual({
    auth: "api_key",
    providerId: "groq",
    model: "llama-3.3-70b-versatile",
    baseUrl: null,
    apiKey: STORED_KEY,
  });
});

it("console_login_credentials_hold_no_key_and_never_read_the_key_store", async () => {
  const { keyStore } = await credentialsRig();
  const get = vi.spyOn(keyStore, "get");

  expect(
    await createCredentialsFor(keyStore)(
      apiAccount("go-1", {
        provider: "opencode-go",
        model: "kimi-k2.7-code",
        baseUrl: null,
        rotation: true,
        auth: "console_login",
      }),
    ),
  ).toEqual({
    auth: "console_login",
    providerId: "opencode-go",
    model: "kimi-k2.7-code",
    baseUrl: null,
  });
  expect(get).not.toHaveBeenCalled();
});

it("zen_console_credentials_use_the_opencode_provider_id", async () => {
  const { keyStore } = await credentialsRig();

  expect(
    await createCredentialsFor(keyStore)(
      apiAccount("zen-1", {
        provider: "opencode-zen",
        model: "big-pickle",
        baseUrl: null,
        rotation: false,
        auth: "console_login",
      }),
    ),
  ).toMatchObject({ providerId: "opencode", model: "big-pickle" });
});

it("credentials_for_custom_provider_keep_the_base_url", async () => {
  const { keyStore } = await credentialsRig();
  await keyStore.set("api-2", STORED_KEY);

  expect(
    await createCredentialsFor(keyStore)(
      apiAccount("api-2", {
        provider: "custom",
        model: "local-model",
        baseUrl: "http://127.0.0.1:9000/v1",
        rotation: false,
        auth: "api_key",
      }),
    ),
  ).toEqual({
    auth: "api_key",
    providerId: "custom",
    model: "local-model",
    baseUrl: "http://127.0.0.1:9000/v1",
    apiKey: STORED_KEY,
  });
});

it("undecryptable_key_is_logged_and_yields_null", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { dir, keyStore } = await credentialsRig();
  await keyStore.set("api-1", STORED_KEY);
  const reopened = createKeyStore({
    path: join(dir, API_KEYS_FILE),
    vault: createFakeVault(false),
  });

  const credentials = await createCredentialsFor(reopened)(
    apiAccount("api-1", GROQ_API),
  );

  expect(credentials).toBeNull();
  expect(error).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(error.mock.calls)).not.toContain(STORED_KEY);
});

it("session_permissions_protect_the_user_data_folder_inside_the_root", async () => {
  const root = await makeTempDir();
  const userData = join(root, ".codeweave");
  const rig = await openRig({
    userData,
    accounts: [ACCOUNT_A],
    homeDir: root,
  });
  const started = await rig.call("session/start", {
    cwd: root,
    profile: "unattended",
  });
  const guarded = join(userData, "accounts.json");
  const notes = join(root, "notes.txt");
  const edit = (id: string, path: string): ScriptStep => ({
    type: "permission",
    toolCallId: id,
    title: `Edit ${id}`,
    kind: "edit",
    rawInput: { file_path: path },
    paths: [path],
    options: DEFAULT_PERMISSION_OPTIONS,
  });
  agentOf(rig).enqueue([
    edit("notes", notes),
    edit("guarded", guarded),
    { type: "end", stopReason: "end_turn" },
  ]);

  await rig.call("session/prompt", { sessionId: started.id, text: "edit" });

  await settled(async () => {
    const { permissions } = await rig.session();
    expect(permissions.map((item) => item.toolCallId)).toEqual(["guarded"]);
    expect(agentOf(rig).permissionOutcomes).toEqual([
      { outcome: "selected", optionId: "allow-once" },
    ]);
  });
});
