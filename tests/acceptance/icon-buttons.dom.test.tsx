import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApiProviderId } from "../../src/domain/apiProviders";
import { App } from "../../src/renderer/App";
import { AccountsDialog } from "../../src/renderer/components/AccountsDialog";
import { ModelCatalogDialog } from "../../src/renderer/components/ModelCatalogDialog";
import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import { TerminalFactoryContext } from "../../src/renderer/terminal/xterm";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import { createFakeXtermFactory } from "../fakes/fakeXterm";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowsList,
  makeModelCatalog,
  makeSession,
  makeSnapshot,
  makeTerminal,
  makeVaultStatus,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const COMPONENTS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "renderer",
  "components",
);
const GLYPH_ICONS = /[✕✓×⟳▸▾●○↗⚙✎]|\p{Extended_Pictographic}/u;
const CWD = "/home/user/project";
const WAIT_OPTIONS = { timeout: 5000 } as const;
const HEADER_BUTTONS = ["Terminal", "Accounts", "Settings"];

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function appClient(): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      session: makeSession({ cwd: CWD }),
      accounts: [
        makeAccount(),
        makeAccount({ id: "acc-2", label: "Personal", order: 1 }),
      ],
      terminal: makeTerminal({ cwd: CWD }),
    }),
  );
  client.respond("flows/list", makeFlowsList());
  client.respond("vault/status", makeVaultStatus());
  client.respond("terminal/open", {
    terminal: makeTerminal({ cwd: CWD }),
    replay: "",
  });
  client.respond("terminal/input", { ok: true });
  client.respond("terminal/resize", { ok: true });
  client.respond("terminal/ack", { ok: true });
  client.respond("terminal/detach", { ok: true });
  return client;
}

function buttonsOf(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")];
}

function nameOf(button: HTMLButtonElement): string {
  return (button.getAttribute("aria-label") ?? button.textContent).trim();
}

function unnamedButtons(root: ParentNode): string[] {
  return buttonsOf(root)
    .filter((button) => nameOf(button) === "")
    .map((button) => button.outerHTML);
}

function iconOnlyWithoutTitle(root: ParentNode): string[] {
  return buttonsOf(root)
    .filter(
      (button) =>
        button.textContent.trim() === "" &&
        (button.getAttribute("aria-label") === null ||
          (button.getAttribute("title") ?? "") === ""),
    )
    .map((button) => button.outerHTML);
}

function sourceFiles(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => join(COMPONENTS_DIR, name));
}

it("icon_buttons_have_accessible_names", async () => {
  const fake = createFakeXtermFactory();
  renderWithServices(
    <TerminalFactoryContext value={fake.factory}>
      <App />
    </TerminalFactoryContext>,
    appClient(),
  );
  await screen.findByText("Work", { selector: ".item-label" });
  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  await screen.findByRole("region", { name: "Terminal" });

  const tabs = ["Session", "Flow", "Agents"];
  for (const tab of tabs) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    await screen.findByRole("tabpanel", { name: tab }, WAIT_OPTIONS);
    expect(unnamedButtons(document.body)).toEqual([]);
    expect(iconOnlyWithoutTitle(document.body)).toEqual([]);
  }
  for (const name of HEADER_BUTTONS) {
    const button = screen.getByRole("button", { name });
    expect(button.querySelector("svg.lucide")).not.toBeNull();
  }
});

it("dialog_buttons_have_accessible_names_and_icons", async () => {
  const client = appClient();
  client.respond("models/catalog", makeModelCatalog());
  const dialogs = [
    <SettingsDialog key="settings" onClose={vi.fn<() => void>()} />,
    <AccountsDialog key="accounts" onClose={vi.fn<() => void>()} />,
    <ModelCatalogDialog
      key="catalog"
      provider={ApiProviderId.groq}
      onPick={vi.fn()}
      onClose={vi.fn<() => void>()}
    />,
  ];
  for (const dialog of dialogs) {
    const { unmount } = renderWithServices(dialog, client);
    const modal = await screen.findByRole("dialog");

    expect(unnamedButtons(modal)).toEqual([]);
    expect(iconOnlyWithoutTitle(modal)).toEqual([]);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.querySelector("svg.lucide")).not.toBeNull();
    unmount();
  }
});

it("components_use_lucide_icons_only", () => {
  const offenders = [
    ...sourceFiles(),
    join(COMPONENTS_DIR, "..", "App.tsx"),
  ].filter((file) => GLYPH_ICONS.test(readFileSync(file, "utf8")));

  expect(offenders.map((file) => file.slice(COMPONENTS_DIR.length))).toEqual(
    [],
  );
});
