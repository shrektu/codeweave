import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { API_PROVIDERS, ApiProviderId } from "../../src/domain/apiProviders";
import { IpcErrorCode, ParamsSchemas } from "../../src/shared/protocol";
import type { ParamsMap } from "../../src/shared/protocol";
import { closeRigs, openRig, type BackendRig } from "../fakes/backendRig";
import { makeTempDir } from "../fakes/processHelpers";

const KEYS_FILE = "api-keys.json";
const ACCOUNTS_FILE = "accounts.json";
const OPENCODE_DATA_PATH = ["data", "opencode"];
const SOME_KEY = "sk-test-console-0001";
const NO_CONSOLE_MESSAGE = "This provider has no Console login";
const CONSOLE_WITH_KEY_MESSAGE = "A Console login account takes no API key";
const KEY_REQUIRED_MESSAGE = "API key is required";
const SET_KEY_REJECTED_MESSAGE =
  "This account signs in with the OpenCode Console and holds no API key";

afterEach(closeRigs);

type OpencodeAddParams = Extract<
  ParamsMap["accounts/add"],
  { provider: "opencode" }
>;

function consoleParams(rig: BackendRig): OpencodeAddParams {
  return {
    label: "Go console",
    configDir: join(rig.userData, "accounts", "go-console"),
    provider: "opencode",
    api: {
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      baseUrl: null,
      rotation: true,
      auth: "console_login",
    },
  };
}

function rawAddParams(auth: string | undefined, provider: string): unknown {
  return {
    label: "Raw",
    configDir: "/x",
    provider: "opencode",
    api: {
      provider,
      model: "m",
      baseUrl: null,
      rotation: true,
      ...(auth === undefined ? {} : { auth }),
    },
  };
}

async function keysFileText(rig: BackendRig): Promise<string> {
  const file = join(rig.userData, KEYS_FILE);
  return existsSync(file) ? readFile(file, "utf8") : "";
}

function issueMessages(result: {
  success: boolean;
  error?: { issues: readonly { message: string }[] };
}): string[] {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

it("console_login_add_creates_a_keyless_account_with_its_data_dir", async () => {
  const rig = await openRig({});
  const params = consoleParams(rig);

  const { account } = await rig.call("accounts/add", params);

  expect(account.api?.auth).toBe("console_login");
  expect(account.hasKey).toBe(false);
  expect(account.keyHint).toBeNull();
  expect(await keysFileText(rig)).not.toContain(account.id);
  const dataDir = join(params.configDir, ...OPENCODE_DATA_PATH);
  expect((await stat(dataDir)).isDirectory()).toBe(true);
});

it("console_login_account_rejects_set_key_and_stores_nothing", async () => {
  const rig = await openRig({});
  const { account } = await rig.call("accounts/add", consoleParams(rig));

  await expect(
    rig.call("accounts/setKey", { id: account.id, apiKey: SOME_KEY }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: SET_KEY_REJECTED_MESSAGE,
  });

  expect(await keysFileText(rig)).not.toContain(account.id);
  const listed = await rig.call("accounts/list", {});
  expect(listed.accounts[0]).toMatchObject({ hasKey: false, keyHint: null });
});

it("console_login_for_a_provider_without_it_is_rejected_by_the_schema", () => {
  const result = ParamsSchemas["accounts/add"].safeParse(
    rawAddParams("console_login", "groq"),
  );

  expect(result.success).toBe(false);
  expect(issueMessages(result)).toContain(NO_CONSOLE_MESSAGE);
});

it.each([["api_key"], [undefined]])(
  "api_key_account_without_a_key_is_rejected_by_the_schema_%s",
  (auth) => {
    const result = ParamsSchemas["accounts/add"].safeParse(
      rawAddParams(auth, "groq"),
    );

    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain(KEY_REQUIRED_MESSAGE);
  },
);

it("console_login_with_an_api_key_is_rejected_by_the_schema", () => {
  const result = ParamsSchemas["accounts/add"].safeParse({
    ...(rawAddParams("console_login", "opencode-go") as object),
    apiKey: SOME_KEY,
  });

  expect(result.success).toBe(false);
  expect(issueMessages(result)).toContain(CONSOLE_WITH_KEY_MESSAGE);
});

it("rejects a console login request that carries an API key and stores nothing", async () => {
  const rig = await openRig({});

  await expect(
    rig.call("accounts/add", { ...consoleParams(rig), apiKey: SOME_KEY }),
  ).rejects.toMatchObject({
    code: IpcErrorCode.VALIDATION,
    message: CONSOLE_WITH_KEY_MESSAGE,
  });

  expect(await keysFileText(rig)).toBe("");
  expect((await rig.call("accounts/list", {})).accounts).toEqual([]);
});

it("stored_account_without_auth_loads_as_api_key", async () => {
  const userData = await makeTempDir();
  await writeFile(
    join(userData, ACCOUNTS_FILE),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "old-go",
          provider: "opencode",
          label: "Old Go",
          configDir: "/cfg/old-go",
          order: 0,
          api: {
            provider: "opencode-go",
            model: "kimi-k2.7-code",
            baseUrl: null,
            rotation: true,
          },
        },
      ],
    }),
  );
  const rig = await openRig({ userData });

  const listed = await rig.call("accounts/list", {});

  expect(listed.accounts[0]?.api?.auth).toBe("api_key");
});

it("accounts_file_omits_auth_for_api_key_and_keeps_it_for_console_login", async () => {
  const rig = await openRig({});
  const keyed = await rig.call("accounts/add", {
    label: "Groq",
    configDir: join(rig.userData, "accounts", "groq"),
    provider: "opencode",
    api: {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: null,
      rotation: true,
      auth: "api_key",
    },
    apiKey: SOME_KEY,
  });
  const console = await rig.call("accounts/add", consoleParams(rig));

  await rig.call("accounts/move", { id: console.account.id, direction: "up" });

  const written = JSON.parse(
    await readFile(join(rig.userData, ACCOUNTS_FILE), "utf8"),
  ) as { accounts: { id: string; api: Record<string, unknown> }[] };
  const apiOf = (id: string): Record<string, unknown> | undefined =>
    written.accounts.find((entry) => entry.id === id)?.api;
  expect(apiOf(keyed.account.id)).toEqual({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    baseUrl: null,
    rotation: true,
  });
  expect(apiOf(console.account.id)).toEqual({
    provider: "opencode-go",
    model: "kimi-k2.7-code",
    baseUrl: null,
    rotation: true,
    auth: "console_login",
  });
});

it("opencode_zen_provider_is_registered_and_console_login_is_limited", () => {
  expect(API_PROVIDERS["opencode-zen"]).toMatchObject({
    opencodeId: "opencode",
    consoleLogin: true,
  });
  expect(
    Object.values(ApiProviderId)
      .filter((id) => API_PROVIDERS[id].consoleLogin)
      .sort(),
  ).toEqual(["opencode-go", "opencode-zen"]);
});
