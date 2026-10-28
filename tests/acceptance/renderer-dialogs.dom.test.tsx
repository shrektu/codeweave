import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
      claudeExecutable:
        patch.claudeExecutable === undefined
          ? current.claudeExecutable
          : patch.claudeExecutable,
      codexExecutable: current.codexExecutable,
    };
    client.emit({ v: 3, event: "settings/changed", payload: current });
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

it("settings_dialog_sends_profile_and_warns_on_bypass", async () => {
  const client = settingsClient();
  renderWithServices(<SettingsDialog onClose={vi.fn<() => void>()} />, client);

  const bypass = await screen.findByRole("radio", { name: "Bypass" });
  expect(screen.queryByText(BYPASS_WARNING)).toBeNull();
  expect(
    screen.getByText("Claude runs every tool without asking."),
  ).toBeTruthy();
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
  const input = await screen.findByPlaceholderText("Found on PATH");

  fireEvent.change(input, { target: { value: "/opt/claude/bin/claude" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { claudeExecutable: "/opt/claude/bin/claude" },
    });
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "settings/set",
      params: { claudeExecutable: null },
    });
  });
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
      params: { label: "Personal", configDir: SUGGESTED_DIR },
    });
  });
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
