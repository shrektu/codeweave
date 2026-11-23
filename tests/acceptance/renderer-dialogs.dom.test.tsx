import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PermissionProfile } from "../../src/domain/types";
import { AccountsDialog } from "../../src/renderer/components/AccountsDialog";
import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import {
  createFakeIpcClient,
  makeAccount,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const SUGGESTED_DIR = "/home/user/.claude-next";
const BYPASS_WARNING =
  "In Bypass mode the agent never asks, so Codeweave cannot block dangerous commands.";
const BYPASS_DESCRIPTION = "The agent runs every tool without asking.";
const CLAUDE_BYPASS_DESCRIPTION = "Claude runs every tool without asking.";
const CLAUDE_BYPASS_WARNING =
  "In Bypass mode Claude never asks, so Codeweave cannot block dangerous commands.";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function settingsClient(): FakeIpcClient {
  const client = createFakeIpcClient();
  let current = makeSettings();
  client.respond("sessions/snapshot", makeSnapshot({ settings: current }));
  client.on("settings/set", (patch) => {
    current = {
      permissionProfile: patch.permissionProfile ?? current.permissionProfile,
      effectLevel: patch.effectLevel ?? current.effectLevel,
      appearance: patch.appearance ?? current.appearance,
      claudeExecutable:
        patch.claudeExecutable === undefined
          ? current.claudeExecutable
          : patch.claudeExecutable,
      codexExecutable:
        patch.codexExecutable === undefined
          ? current.codexExecutable
          : patch.codexExecutable,
      opencodeExecutable:
        patch.opencodeExecutable === undefined
          ? current.opencodeExecutable
          : patch.opencodeExecutable,
      agyExecutable:
        patch.agyExecutable === undefined
          ? current.agyExecutable
          : patch.agyExecutable,
      terminalShell:
        patch.terminalShell === undefined
          ? current.terminalShell
          : patch.terminalShell,
      updateCheck: patch.updateCheck ?? current.updateCheck,
      updateChannel: patch.updateChannel ?? current.updateChannel,
      defaultTaskClass: patch.defaultTaskClass ?? current.defaultTaskClass,
      definitionLibrary:
        patch.definitionLibrary === undefined
          ? current.definitionLibrary
          : patch.definitionLibrary,
    };
    client.emit({ v: 7, event: "settings/changed", payload: current });
    return current;
  });
  return client;
}

function accountsClient(configDirs: string[] = []): FakeIpcClient {
  const client = createFakeIpcClient();
  const accounts = configDirs.map((configDir, order) =>
    makeAccount({
      id: `acc-${order.toString()}`,
      label: `Acc ${order.toString()}`,
      configDir,
      order,
    }),
  );
  client.respond("sessions/snapshot", makeSnapshot({ accounts }));
  client.respond("accounts/suggest", { configDir: SUGGESTED_DIR });
  return client;
}

function configDirInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Config directory");
}

const CLAUDE_SAVE_INDEX = 0;
const CODEX_SAVE_INDEX = 1;
const AGY_SAVE_INDEX = 3;
const LIBRARY_SAVE_INDEX = 5;

function saveButton(index: number): HTMLElement {
  const button = screen.getAllByRole("button", { name: "Save" })[index];
  if (button === undefined) {
    throw new Error(`no Save button at ${index.toString()}`);
  }
  return button;
}

it("settings_dialog_sends_profile_and_warns_on_bypass", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const bypass = await screen.findByRole("radio", { name: "Bypass" });
  expect(screen.queryByText(BYPASS_WARNING)).toBeNull();
  expect(screen.getByText(BYPASS_DESCRIPTION)).toBeTruthy();
  expect(
    screen.getByText("Read-only: edits and commands are denied."),
  ).toBeTruthy();

  fireEvent.click(bypass);

  await waitFor(() => {
    expect(screen.getByText(BYPASS_WARNING)).toBeTruthy();
  });
  expect(client.requests).toContainEqual({
    method: "settings/set",
    params: { permissionProfile: PermissionProfile.bypass },
  });
});

it("settings_dialog_sends_effect_level", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(await screen.findByRole("radio", { name: "Full" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { effectLevel: "full" },
    });
  });
});

it("settings_dialog_saves_executable_and_null_when_empty", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);
  const input = await screen.findByLabelText("Claude executable");

  fireEvent.change(input, { target: { value: "/opt/claude/bin/claude" } });
  fireEvent.click(saveButton(CLAUDE_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { claudeExecutable: "/opt/claude/bin/claude" },
    });
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(saveButton(CLAUDE_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { claudeExecutable: null },
    });
  });
});

it("settings_dialog_saves_codex_executable", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);
  const input = await screen.findByLabelText("Codex executable");

  fireEvent.change(input, { target: { value: "/opt/codex/bin/codex" } });
  fireEvent.click(saveButton(CODEX_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { codexExecutable: "/opt/codex/bin/codex" },
    });
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(saveButton(CODEX_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { codexExecutable: null },
    });
  });
});

it("settings_dialog_saves_agy_executable", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);
  const input = await screen.findByLabelText("Gemini executable (agy)");

  fireEvent.change(input, { target: { value: "/opt/agy/bin/agy" } });
  fireEvent.click(saveButton(AGY_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { agyExecutable: "/opt/agy/bin/agy" },
    });
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(saveButton(AGY_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { agyExecutable: null },
    });
  });
});

it("settings_dialog_saves_the_flow_library_folder_and_null_when_empty", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);
  const input = await screen.findByLabelText("Flow library folder");
  expect(input.getAttribute("placeholder")).toBe(
    "Default: Codeweave data folder/library",
  );

  fireEvent.change(input, { target: { value: "~/codeweave-library" } });
  fireEvent.click(saveButton(LIBRARY_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { definitionLibrary: "~/codeweave-library" },
    });
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(saveButton(LIBRARY_SAVE_INDEX));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { definitionLibrary: null },
    });
  });
});

it("bypass_texts_do_not_name_claude", async () => {
  renderWithServices(
    <SettingsDialog onClose={vi.fn<() => void>()} />,
    settingsClient(),
  );

  fireEvent.click(await screen.findByRole("radio", { name: "Bypass" }));

  await waitFor(() => {
    expect(screen.getByText(BYPASS_WARNING)).toBeTruthy();
  });
  expect(screen.getByText(BYPASS_DESCRIPTION)).toBeTruthy();
  expect(screen.queryByText(CLAUDE_BYPASS_DESCRIPTION)).toBeNull();
  expect(screen.queryByText(CLAUDE_BYPASS_WARNING)).toBeNull();
});

it("settings_dialog_close_button_calls_onClose", async () => {
  const onClose = vi.fn<() => void>();
  renderWithServices(<SettingsDialog onClose={onClose} />, settingsClient());
  await screen.findByRole("radio", { name: "Ask" });

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
});

it("accounts_dialog_prefills_default_dir", async () => {
  renderWithServices(
    <AccountsDialog onClose={vi.fn<() => void>()} />,
    accountsClient(),
  );

  await waitFor(() => {
    expect(configDirInput().value).toBe(SUGGESTED_DIR);
  });
  expect(screen.getByRole("dialog", { name: "Accounts" })).toBeTruthy();
});

it("accounts_dialog_adds_account", async () => {
  const client = accountsClient();
  client.respond("accounts/add", {
    account: makeAccount({ label: "Personal" }),
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(configDirInput().value).toBe(SUGGESTED_DIR);
  });

  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "Personal" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Personal",
        configDir: SUGGESTED_DIR,
        provider: "claude",
      },
    });
  });
});

it("accounts_dialog_adds_codex_account_with_provider", async () => {
  const client = accountsClient();
  client.respond("accounts/add", {
    account: makeAccount({ label: "Codex main", provider: "codex" }),
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(configDirInput().value).toBe(SUGGESTED_DIR);
  });

  const agent = screen.getByLabelText<HTMLSelectElement>("Agent");
  expect(
    within(agent)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Claude", "Codex", "Gemini", "OpenCode (API key)"]);
  expect(agent.value).toBe("claude");
  fireEvent.change(agent, { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "Codex main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Codex main",
        configDir: SUGGESTED_DIR,
        provider: "codex",
      },
    });
  });
});

it("accounts_dialog_shows_codex_login_command", async () => {
  const client = accountsClient();
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      accounts: [
        makeAccount({
          id: "acc-codex",
          provider: "codex",
          label: "Codex main",
          configDir: "/home/us er/it's",
        }),
      ],
    }),
  );
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(screen.getByText("Run this in a terminal:")).toBeTruthy();
  expect(
    screen.getByText("CODEX_HOME='/home/us er/it'\\''s' codex login"),
  ).toBeTruthy();
  expect(
    screen.getByText("$env:CODEX_HOME='/home/us er/it''s'; codex login"),
  ).toBeTruthy();
  expect(screen.queryByText(/CLAUDE_CONFIG_DIR/)).toBeNull();
});

it("accounts_dialog_adds_gemini_account_with_provider", async () => {
  const client = accountsClient();
  client.respond("accounts/add", {
    account: makeAccount({ label: "Gemini main", provider: "gemini" }),
  });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(configDirInput().value).toBe(SUGGESTED_DIR);
  });

  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "gemini" },
  });
  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "Gemini main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/add",
      params: {
        label: "Gemini main",
        configDir: SUGGESTED_DIR,
        provider: "gemini",
      },
    });
  });
});

it("accounts_dialog_shows_gemini_login_command", async () => {
  const client = accountsClient();
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      accounts: [
        makeAccount({
          id: "acc-gemini",
          provider: "gemini",
          label: "Gemini main",
          configDir: "/home/us er/it's",
        }),
      ],
    }),
  );
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(
    screen.getByText("Run this in a terminal, then sign in with Google:"),
  ).toBeTruthy();
  expect(screen.getAllByText("agy")).toHaveLength(2);
  expect(screen.queryByText(/CLAUDE_CONFIG_DIR|CODEX_HOME/)).toBeNull();
});

it("accounts_dialog_rejects_empty_label", async () => {
  const client = accountsClient();
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);
  await waitFor(() => {
    expect(configDirInput().value).toBe(SUGGESTED_DIR);
  });

  fireEvent.change(screen.getByLabelText("Label"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));

  expect(await screen.findByText("Label is required")).toBeTruthy();
  expect(
    client.requests.filter((request) => request.method === "accounts/add"),
  ).toEqual([]);
});

it("accounts_dialog_shows_quoted_login_commands", async () => {
  const client = accountsClient(["/home/us er/it's"]);
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(
    screen.getByText("Run this in a terminal, then type /login:"),
  ).toBeTruthy();
  expect(
    screen.getByText("CLAUDE_CONFIG_DIR='/home/us er/it'\\''s' claude"),
  ).toBeTruthy();
  expect(
    screen.getByText("$env:CLAUDE_CONFIG_DIR='/home/us er/it''s'; claude"),
  ).toBeTruthy();
  expect(screen.getByText("bash")).toBeTruthy();
  expect(screen.getByText("PowerShell")).toBeTruthy();
});

it("accounts_dialog_header_path_compacted", async () => {
  const fullPath = "/home/user/.config/codeweave/accounts/work";
  const client = accountsClient([fullPath]);
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  const path = await screen.findByText("…/accounts/work");
  expect(path.getAttribute("title")).toBe(fullPath);
  expect(screen.queryByText(fullPath)).toBeNull();
});

it("powershell_command_escapes_typographic_quotes_in_dialog", async () => {
  const client = accountsClient(["x’; calc; ’"]);
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  expect(
    await screen.findByText("$env:CLAUDE_CONFIG_DIR='x’’; calc; ’’'; claude"),
  ).toBeTruthy();
});

it("dialog_backdrop_blocks_background_clicks", async () => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  renderWithServices(
    <SettingsDialog onClose={vi.fn<() => void>()} />,
    settingsClient(),
  );
  await screen.findByRole("radio", { name: "Ask" });

  expect(showModal).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("dialog", { name: "Settings" }).hasAttribute("open"),
  ).toBe(true);
});

it("dialog_closes_element_on_unmount", async () => {
  const close = vi.spyOn(HTMLDialogElement.prototype, "close");
  const view = renderWithServices(
    <SettingsDialog onClose={vi.fn<() => void>()} />,
    settingsClient(),
  );
  await screen.findByRole("radio", { name: "Ask" });

  view.unmount();

  expect(close).toHaveBeenCalledTimes(1);
});

it("dialog_escape_closes_and_traps_focus", async () => {
  const onClose = vi.fn<() => void>();
  renderWithServices(<SettingsDialog onClose={onClose} />, settingsClient());
  const dialog = await screen.findByRole("dialog", { name: "Settings" });

  const notCancelled = fireEvent(
    dialog,
    new Event("cancel", { bubbles: false, cancelable: true }),
  );

  expect(notCancelled).toBe(false);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("accounts_dialog_moves_accounts", async () => {
  const client = accountsClient(["/a", "/b"]);
  client.respond("accounts/move", { accounts: [] });
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  const downButtons = await screen.findAllByRole("button", {
    name: "Move down",
  });
  for (const button of downButtons.slice(0, 1)) {
    fireEvent.click(button);
  }

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "accounts/move",
      params: { id: "acc-0", direction: "down" },
    });
  });
});

it("accounts_dialog_shows_conflict_message_on_remove", async () => {
  const client = accountsClient(["/a"]);
  client.fail(
    "accounts/remove",
    new IpcRemoteError(
      IpcErrorCode.CONFLICT,
      "Account is used by the running session",
    ),
  );
  renderWithServices(<AccountsDialog onClose={vi.fn<() => void>()} />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

  expect(
    await screen.findByText("Account is used by the running session"),
  ).toBeTruthy();
  expect(client.requests).toContainEqual({
    method: "accounts/remove",
    params: { id: "acc-0" },
  });
});

it("settings dialog sets the default task class", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const select =
    await screen.findByLabelText<HTMLSelectElement>("Default task class");
  expect(select.value).toBe("standard");
  fireEvent.change(select, { target: { value: "heavy" } });

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { defaultTaskClass: "heavy" },
    });
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText<HTMLSelectElement>("Default task class").value,
    ).toBe("heavy");
  });
});
