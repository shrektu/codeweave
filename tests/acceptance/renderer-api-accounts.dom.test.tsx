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
import { ModelCatalogDialog } from "../../src/renderer/components/ModelCatalogDialog";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import type { CatalogModel } from "../../src/shared/views";
import type { VaultStatus } from "../../src/shared/vault";
import {
  createFakeIpcClient,
  makeAccount,
  makeCatalogModel,
  makeModelCatalog,
  makeSession,
  makeSettings,
  makeSnapshot,
  makeVaultStatus,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const SUGGESTED_DIR = "/home/user/.codeweave-opencode";
const PICKED_FOLDER = "/home/user/picked";
const FAKE_KEY_A = "sk-test-fake-key-A";
const FAKE_KEY_B = "sk-test-fake-key-B";
const CUSTOM_URL = "https://llm.example.com/v1";

const FAST = makeCatalogModel({
  providerId: ApiProviderId.groq,
  modelId: "llama-fast",
  name: "Llama Fast",
  free: true,
  trainsOnData: false,
});
const PAID = makeCatalogModel({
  providerId: ApiProviderId.groq,
  modelId: "llama-paid",
  name: "Llama Paid",
  free: false,
  trainsOnData: false,
});
const GEMINI = makeCatalogModel({
  providerId: ApiProviderId.google,
  modelId: "gemini-flash",
  name: "Gemini Flash",
  free: true,
  trainsOnData: true,
});
const MYSTERY = makeCatalogModel({
  providerId: ApiProviderId.openrouter,
  modelId: "mystery-1",
  name: "Mystery Model",
  free: true,
  trainsOnData: "unknown",
});
const CATALOG: CatalogModel[] = [FAST, PAID, GEMINI, MYSTERY];

beforeEach(() => {
  window.codeweave = {
    gpuAccelerated: true,
    pickFolder: () => Promise.resolve(PICKED_FOLDER),
  };
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
  models = CATALOG,
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

function addRequests(client: FakeIpcClient): unknown[] {
  return client.requests.filter((request) => request.method === "accounts/add");
}

async function openOpencodeForm(client: FakeIpcClient): Promise<void> {
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(field("Config directory").value).toBe(SUGGESTED_DIR);
  });
  change("Agent", "opencode");
}

function fillAccount(model: string, key: string): void {
  change("Label", "Groq main");
  change("Model", model);
  change("API key", key);
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
}

it("adding_opencode_account_sends_api_fields_and_clears_key", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);

  change("API provider", "groq");
  fillAccount("llama-3.3-70b", FAKE_KEY_A);
  expect(field("API key").type).toBe("password");
  expect(field("API key").autocomplete).toBe("off");
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
        },
        apiKey: FAKE_KEY_A,
      },
    });
  });
  await waitFor(() => {
    expect(field("API key").value).toBe("");
  });
  expect(screen.queryByDisplayValue(FAKE_KEY_A)).toBeNull();
  expect(document.body.textContent).not.toContain(FAKE_KEY_A);
});

it("api_account_save_disabled_when_vault_unavailable", async () => {
  const client = opencodeClient({
    vault: makeVaultStatus({ available: false, reason: "Keychain is locked" }),
  });
  await openOpencodeForm(client);

  expect(await screen.findByText("Keychain is locked")).toBeTruthy();
  const button = screen.getByRole<HTMLButtonElement>("button", {
    name: "Add account",
  });
  expect(button.disabled).toBe(true);
  expect(client.requests).toContainEqual({
    method: "vault/status",
    params: {},
  });
});

it("api_account_save_disabled_with_generic_message_when_reason_missing", async () => {
  const client = opencodeClient({
    vault: makeVaultStatus({ available: false, reason: null }),
  });
  await openOpencodeForm(client);

  expect(
    await screen.findByText("Secure key storage is unavailable"),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Add account" })
      .disabled,
  ).toBe(true);
});

it("vault_status_is_not_requested_for_claude_accounts", async () => {
  const client = opencodeClient();
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(field("Config directory").value).toBe(SUGGESTED_DIR);
  });

  expect(client.requests.some((r) => r.method === "vault/status")).toBe(false);
  expect(screen.queryByLabelText("API key")).toBeNull();
});

it("rotation_defaults_follow_api_provider", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);

  expect(field("Use in rotation").checked).toBe(true);

  change("API provider", "deepseek");
  expect(field("Use in rotation").checked).toBe(false);

  fireEvent.click(field("Use in rotation"));
  expect(field("Use in rotation").checked).toBe(true);

  change("API provider", "moonshotai");
  expect(field("Use in rotation").checked).toBe(false);

  change("API provider", "cerebras");
  expect(field("Use in rotation").checked).toBe(true);
});

it("custom_provider_requires_base_url", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  expect(screen.queryByLabelText("Base URL")).toBeNull();

  change("API provider", "custom");
  fillAccount("my-model", FAKE_KEY_A);
  submit();

  expect(await screen.findByText("Base URL is required")).toBeTruthy();
  expect(addRequests(client)).toHaveLength(0);

  change("Base URL", CUSTOM_URL);
  submit();

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Groq main",
        configDir: SUGGESTED_DIR,
        provider: "opencode",
        api: {
          provider: "custom",
          model: "my-model",
          baseUrl: CUSTOM_URL,
          rotation: true,
        },
        apiKey: FAKE_KEY_A,
      },
    });
  });
});

it("missing_model_shows_validation_error", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);

  fillAccount("", FAKE_KEY_A);
  submit();
  expect(await screen.findByText("Model is required")).toBeTruthy();

  fillAccount("llama-3.3-70b", "");
  submit();
  expect(await screen.findByText("API key is required")).toBeTruthy();
  expect(addRequests(client)).toHaveLength(0);
});

it("key_field_cleared_when_switching_away_from_opencode", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);

  change("API key", FAKE_KEY_A);
  change("Agent", "claude");
  expect(screen.queryByLabelText("API key")).toBeNull();
  change("Agent", "opencode");

  expect(field("API key").value).toBe("");
});

const OPENCODE_ACCOUNT = makeAccount({
  id: "oc-1",
  provider: "opencode",
  label: "Groq main",
  api: {
    provider: "groq",
    model: "llama-3.3-70b",
    baseUrl: null,
    rotation: true,
  },
  hasKey: true,
  keyHint: "x7Qd",
});

it("api_account_row_shows_key_hint_not_key", async () => {
  const client = opencodeClient({
    accounts: [
      OPENCODE_ACCOUNT,
      makeAccount({
        id: "oc-2",
        provider: "opencode",
        label: "DeepSeek spare",
        order: 1,
        api: {
          provider: "deepseek",
          model: "deepseek-chat",
          baseUrl: null,
          rotation: false,
        },
      }),
    ],
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  const first = (await screen.findByText("Groq main")).closest("li");
  const second = screen.getByText("DeepSeek spare").closest("li");
  if (first === null || second === null) {
    throw new Error("account rows not found");
  }
  expect(within(first).getByText("Groq")).toBeTruthy();
  expect(within(first).getByText("llama-3.3-70b")).toBeTruthy();
  expect(within(first).getByText("Rotation on")).toBeTruthy();
  expect(within(first).getByText("Key …x7Qd")).toBeTruthy();
  expect(within(second).getByText("DeepSeek")).toBeTruthy();
  expect(within(second).getByText("Rotation off")).toBeTruthy();
  expect(within(second).getByText("No key saved")).toBeTruthy();
  expect(document.body.textContent).not.toContain("sk-");
});

it("replace_key_sends_set_key_and_clears_field", async () => {
  const client = opencodeClient({ accounts: [OPENCODE_ACCOUNT] });
  client.respond("accounts/setKey", OPENCODE_ACCOUNT);
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));
  expect(field("New API key").type).toBe("password");
  change("New API key", FAKE_KEY_B);
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/setKey",
      params: { id: "oc-1", apiKey: FAKE_KEY_B },
    });
  });
  await waitFor(() => {
    expect(screen.queryByDisplayValue(FAKE_KEY_B)).toBeNull();
  });
  expect(document.body.textContent).not.toContain(FAKE_KEY_B);
});

it("replace_key_shows_backend_error_and_keeps_editor", async () => {
  const client = opencodeClient({ accounts: [OPENCODE_ACCOUNT] });
  client.fail("accounts/setKey", new Error("Vault refused the key"));
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));
  change("New API key", FAKE_KEY_B);
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));

  expect(await screen.findByText("Vault refused the key")).toBeTruthy();
});

async function renderCatalog(
  provider: ApiProviderId | null,
  client: FakeIpcClient = opencodeClient(),
  onPick: (model: CatalogModel) => void = vi.fn<(m: CatalogModel) => void>(),
): Promise<void> {
  renderWithServices(
    <ModelCatalogDialog
      provider={provider}
      onPick={onPick}
      onClose={vi.fn<() => void>()}
    />,
    client,
  );
  await screen.findByLabelText("Search models");
}

function listedNames(): string[] {
  return CATALOG.map((model) => model.name).filter(
    (name) => screen.queryByText(name) !== null,
  );
}

it("model_catalog_filters_search_provider_free_and_training", async () => {
  await renderCatalog(null);
  await screen.findByText("Llama Fast");
  expect(listedNames()).toEqual([
    "Llama Fast",
    "Llama Paid",
    "Gemini Flash",
    "Mystery Model",
  ]);
  expect(screen.getByText("llama-fast")).toBeTruthy();

  change("Search models", "LLAMA");
  expect(listedNames()).toEqual(["Llama Fast", "Llama Paid"]);

  change("Search models", "mystery-1");
  expect(listedNames()).toEqual(["Mystery Model"]);

  change("Search models", "");
  fireEvent.click(field("Free only"));
  expect(listedNames()).toEqual([
    "Llama Fast",
    "Gemini Flash",
    "Mystery Model",
  ]);

  fireEvent.click(field("No training on data"));
  expect(listedNames()).toEqual(["Llama Fast"]);

  fireEvent.click(field("Free only"));
  expect(listedNames()).toEqual(["Llama Fast", "Llama Paid"]);

  fireEvent.click(field("No training on data"));
  change("Provider", "google");
  expect(listedNames()).toEqual(["Gemini Flash"]);

  change("Provider", "");
  expect(listedNames()).toHaveLength(CATALOG.length);
});

it("model_catalog_is_preset_to_the_chosen_provider", async () => {
  await renderCatalog(ApiProviderId.groq);
  await screen.findByText("Llama Fast");

  expect(field("Provider").value).toBe("groq");
  expect(listedNames()).toEqual(["Llama Fast", "Llama Paid"]);
});

it("model_catalog_shows_backend_error", async () => {
  const client = opencodeClient();
  client.respond("models/catalog", {
    models: [],
    error: "Catalog fetch failed",
  });
  await renderCatalog(null, client);

  expect(await screen.findByText("Catalog fetch failed")).toBeTruthy();
  expect(screen.queryByText("No models match")).toBeNull();
});

it("model_catalog_shows_loading_then_empty_state", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof makeModelCatalog>>();
  const client = opencodeClient();
  client.on("models/catalog", () => gate.promise);
  await renderCatalog(null, client);

  expect(screen.getByText("Loading models…")).toBeTruthy();
  gate.resolve(makeModelCatalog({ models: [] }));

  expect(await screen.findByText("No models match")).toBeTruthy();
  expect(screen.queryByText("Loading models…")).toBeNull();
});

it("catalog_unknown_training_fails_no_training_filter", async () => {
  const client = opencodeClient({ models: [MYSTERY] });
  await renderCatalog(null, client);
  await screen.findByText("Mystery Model");
  expect(screen.getByText("Training unknown")).toBeTruthy();

  fireEvent.click(field("No training on data"));

  expect(screen.queryByText("Mystery Model")).toBeNull();
  expect(screen.getByText("No models match")).toBeTruthy();
});

it("catalog_null_costs_render_dash", async () => {
  const client = opencodeClient({
    models: [
      makeCatalogModel({
        modelId: "no-prices",
        name: "No Prices",
        contextWindow: null,
        costIn: null,
        costOut: null,
        free: true,
      }),
      makeCatalogModel({
        modelId: "priced",
        name: "Priced",
        contextWindow: 8192,
        costIn: 0.5,
        costOut: 1.5,
        trainsOnData: true,
      }),
    ],
  });
  await renderCatalog(null, client);
  await screen.findByText("No Prices");

  const unpriced = screen.getByText("No Prices").closest("li");
  const priced = screen.getByText("Priced").closest("li");
  if (unpriced === null || priced === null) {
    throw new Error("catalog rows not found");
  }
  expect(within(unpriced).getByText("Context —")).toBeTruthy();
  expect(within(unpriced).getByText("In —")).toBeTruthy();
  expect(within(unpriced).getByText("Out —")).toBeTruthy();
  expect(within(unpriced).getByText("Free")).toBeTruthy();
  expect(within(priced).getByText("Context 8,192")).toBeTruthy();
  expect(within(priced).getByText("In $0.5")).toBeTruthy();
  expect(within(priced).getByText("Out $1.5")).toBeTruthy();
  expect(within(priced).getByText("Trains on data")).toBeTruthy();
});

it("picking_catalog_model_fills_model_field", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "groq");

  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  expect(await screen.findByText("Llama Fast")).toBeTruthy();
  expect(screen.queryByText("Gemini Flash")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use llama-paid" }));

  await waitFor(() => {
    expect(field("Model").value).toBe("llama-paid");
  });
  expect(screen.queryByLabelText("Search models")).toBeNull();
});

it("session_start_offers_opencode_when_api_accounts_exist", async () => {
  const client = opencodeClient({
    accounts: [
      makeAccount({ id: "acc-1", provider: "claude", label: "Work" }),
      OPENCODE_ACCOUNT,
    ],
  });
  client.respond("session/start", makeSession({ provider: "opencode" }));
  renderWithServices(<SessionStream />, client);

  const agent = await screen.findByLabelText<HTMLSelectElement>("Agent");
  expect(
    within(agent)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Claude", "OpenCode (API key)"]);
  fireEvent.change(agent, { target: { value: "opencode" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER, provider: "opencode" },
    });
  });
});

it("settings_saves_opencode_executable", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  client.respond("settings/set", makeSettings());
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const input = await screen.findByLabelText("OpenCode executable");
  fireEvent.change(input, { target: { value: "/opt/opencode/bin/opencode" } });
  const save = within(input.parentElement ?? document.body).getByRole(
    "button",
    {
      name: "Save",
    },
  );
  fireEvent.click(save);

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { opencodeExecutable: "/opt/opencode/bin/opencode" },
    });
  });
});

it("api_key_cleared_when_suggest_refresh_fails", async () => {
  const client = opencodeClient();
  let suggestCalls = 0;
  client.on("accounts/suggest", () => {
    suggestCalls += 1;
    if (suggestCalls > 1) {
      throw new Error("Suggest failed");
    }
    return { configDir: SUGGESTED_DIR };
  });
  await openOpencodeForm(client);

  fillAccount("llama-3.3-70b", FAKE_KEY_A);
  submit();

  expect(await screen.findByText("Suggest failed")).toBeTruthy();
  expect(field("API key").value).toBe("");
  expect(field("Label").value).toBe("");
  expect(field("Model").value).toBe("");
  expect(addRequests(client)).toHaveLength(1);
});

it("picking_model_of_other_provider_switches_api_provider", async () => {
  const client = opencodeClient();
  await openOpencodeForm(client);
  change("API provider", "deepseek");
  expect(field("Use in rotation").checked).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  await screen.findByLabelText("Search models");
  change("Provider", "");
  fireEvent.click(
    await screen.findByRole("button", { name: "Use llama-fast" }),
  );

  await waitFor(() => {
    expect(field("Model").value).toBe("llama-fast");
  });
  expect(field("API provider").value).toBe("groq");
  expect(field("Use in rotation").checked).toBe(true);
});

it("escape_in_model_catalog_keeps_accounts_dialog_open", async () => {
  const onClose = vi.fn<() => void>();
  const client = opencodeClient();
  renderWithServices(<AccountsDialog onClose={onClose} />, client);
  await waitFor(() => {
    expect(field("Config directory").value).toBe(SUGGESTED_DIR);
  });
  change("Agent", "opencode");
  change("API key", FAKE_KEY_A);

  fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
  const inner = (await screen.findByLabelText("Search models")).closest(
    "dialog",
  );
  if (inner === null) {
    throw new Error("catalog dialog not found");
  }
  fireEvent(inner, new Event("cancel", { cancelable: true }));

  await waitFor(() => {
    expect(screen.queryByLabelText("Search models")).toBeNull();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(field("API key").value).toBe(FAKE_KEY_A);
});
