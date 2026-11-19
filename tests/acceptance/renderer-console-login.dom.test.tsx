import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiProviderId } from "../../src/domain/apiProviders";
import { AccountsDialog } from "../../src/renderer/components/AccountsDialog";
import type { CatalogModel } from "../../src/shared/views";
import type { VaultStatus } from "../../src/shared/vault";
import {
  createFakeIpcClient,
  makeAccount,
  makeCatalogModel,
  makeModelCatalog,
  makeSnapshot,
  makeVaultStatus,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

const SUGGESTED_DIR = "/home/user/.codeweave-opencode";
const FAKE_KEY = "sk-test-fake-key-A";
const SIGN_IN_LABEL = "Sign in with";
const CONSOLE_LOGIN_OPTION = "console_login";
const ACCOUNT_DIR = "/home/user/accounts/go main";
const ACCOUNT_DB = "/home/user/accounts/go main/data/opencode/opencode.db";

const GROQ_MODEL = makeCatalogModel({
  providerId: ApiProviderId.groq,
  modelId: "llama-fast",
  name: "Llama Fast",
  free: true,
  trainsOnData: false,
});

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface ClientOptions {
  accounts?: ReturnType<typeof makeAccount>[];
  vault?: VaultStatus;
  models?: CatalogModel[];
}

function opencodeClient({
  accounts = [],
  vault = makeVaultStatus(),
  models = [GROQ_MODEL],
}: ClientOptions = {}): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot({ accounts }));
  client.respond("accounts/suggest", { configDir: SUGGESTED_DIR });
  client.respond("vault/status", vault);
  client.respond("models/catalog", makeModelCatalog({ models }));
  client.respond("accounts/add", { account: makeAccount() });
  return client;
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

async function openOpencodeForm(client: FakeIpcClient): Promise<void> {
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(field("Config directory").value).toBe(SUGGESTED_DIR);
  });
  change("Agent", "opencode");
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
}

it("go_console_login_hides_key_and_sends_no_api_key", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "opencode-go");
  expect(screen.getByLabelText(SIGN_IN_LABEL)).toBeTruthy();

  change(SIGN_IN_LABEL, CONSOLE_LOGIN_OPTION);
  expect(screen.queryByLabelText("API key")).toBeNull();
  change("Label", "Go main");
  change("Model", "kimi-k2.7-code");
  submit();

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Go main",
        configDir: SUGGESTED_DIR,
        provider: "opencode",
        api: {
          provider: "opencode-go",
          model: "kimi-k2.7-code",
          baseUrl: null,
          rotation: true,
          auth: "console_login",
        },
      },
    });
  });
});

it("provider_without_console_login_has_no_sign_in_select", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "groq");
  expect(screen.queryByLabelText(SIGN_IN_LABEL)).toBeNull();

  change("Label", "Groq main");
  change("Model", "llama-3.3-70b");
  change("API key", FAKE_KEY);
  submit();

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Groq main",
        configDir: SUGGESTED_DIR,
        provider: "opencode",
        api: {
          provider: "groq",
          model: "llama-3.3-70b",
          baseUrl: null,
          rotation: true,
          auth: "api_key",
        },
        apiKey: FAKE_KEY,
      },
    });
  });
});

it("switching_provider_resets_console_login_choice", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "opencode-go");
  change(SIGN_IN_LABEL, CONSOLE_LOGIN_OPTION);
  expect(screen.queryByLabelText("API key")).toBeNull();

  change("API provider", "groq");

  expect(field("API key").type).toBe("password");
  expect(screen.queryByLabelText(SIGN_IN_LABEL)).toBeNull();
  change("API provider", "opencode-go");
  expect(field(SIGN_IN_LABEL).value).toBe("api_key");
});

it("picking_a_catalog_model_resets_console_login_choice", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "opencode-go");
  change(SIGN_IN_LABEL, CONSOLE_LOGIN_OPTION);

  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  await screen.findByLabelText("Search models");
  change("Provider", "");
  fireEvent.click(
    await screen.findByRole("button", { name: "Use llama-fast" }),
  );

  await waitFor(() => {
    expect(field("API provider").value).toBe("groq");
  });
  expect(field("API key").type).toBe("password");
  expect(screen.queryByLabelText(SIGN_IN_LABEL)).toBeNull();
});

it("console_login_keeps_add_enabled_when_vault_unavailable", async () => {
  const client = opencodeClient({
    vault: makeVaultStatus({ available: false, reason: "Keychain is locked" }),
  });
  await openOpencodeForm(client);
  expect(await screen.findByText("Keychain is locked")).toBeTruthy();

  change("API provider", "opencode-go");
  change(SIGN_IN_LABEL, CONSOLE_LOGIN_OPTION);

  expect(screen.queryByText("Keychain is locked")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Add account" })
      .disabled,
  ).toBe(false);
});

it("console_login_account_row_shows_login_commands", async () => {
  const client = opencodeClient({
    accounts: [
      makeAccount({
        id: "oc-go",
        provider: "opencode",
        label: "Go main",
        configDir: ACCOUNT_DIR,
        api: {
          provider: "opencode-go",
          model: "kimi-k2.7-code",
          baseUrl: null,
          rotation: true,
          auth: "console_login",
        },
      }),
    ],
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  const row = (await screen.findByText("Go main")).closest("li");
  if (row === null) {
    throw new Error("account row not found");
  }
  expect(within(row).getByText("OpenCode Go")).toBeTruthy();
  expect(within(row).getByText("kimi-k2.7-code")).toBeTruthy();
  expect(within(row).getByText("Rotation on")).toBeTruthy();
  expect(within(row).getByText("Console login")).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Replace key" })).toBeNull();
  expect(
    within(row).getByText(
      `OPENCODE_DB='${ACCOUNT_DB}' opencode auth login opencode --method device --standalone`,
    ),
  ).toBeTruthy();
  expect(
    within(row).getByText(
      `$env:OPENCODE_DB='${ACCOUNT_DB}'; opencode auth login opencode --method device --standalone`,
    ),
  ).toBeTruthy();
});

it("api_key_opencode_row_keeps_key_hint_and_replace_button", async () => {
  const client = opencodeClient({
    accounts: [
      makeAccount({
        id: "oc-1",
        provider: "opencode",
        label: "Groq main",
        api: {
          provider: "groq",
          model: "llama-3.3-70b",
          baseUrl: null,
          rotation: true,
          auth: "api_key",
        },
        hasKey: true,
        keyHint: "x7Qd",
      }),
    ],
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  const row = (await screen.findByText("Groq main")).closest("li");
  if (row === null) {
    throw new Error("account row not found");
  }
  expect(within(row).getByText("Key …x7Qd")).toBeTruthy();
  expect(within(row).getByRole("button", { name: "Replace key" })).toBeTruthy();
  expect(within(row).queryByText("Console login")).toBeNull();
  expect(within(row).queryByText("Sign in")).toBeNull();
});
