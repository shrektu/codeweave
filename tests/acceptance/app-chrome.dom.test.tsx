import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { AccountsDialog } from "../../src/renderer/components/AccountsDialog";
import { SettingsDialog } from "../../src/renderer/components/SettingsDialog";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowsList,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const STYLES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "renderer",
  "styles",
);
const CWD = "/home/user/project";
const LONG_LABEL = "A very long account label that must not push the layout";
const BACKEND_PID = 77;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function appClient(): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: BACKEND_PID });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      session: makeSession({ cwd: CWD }),
      accounts: [makeAccount({ label: LONG_LABEL })],
    }),
  );
  client.respond("flows/list", makeFlowsList());
  return client;
}

function ruleBody(file: string, selector: string): string {
  const css = readFileSync(join(STYLES_DIR, file), "utf8");
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) {
    throw new Error(`${file} has no rule for ${selector}`);
  }
  return css.slice(start, css.indexOf("}", start));
}

it("dialog_close_button_keeps_name_close", () => {
  const onClose = vi.fn<() => void>();
  renderWithServices(<SettingsDialog onClose={onClose} />, appClient());

  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  expect(onClose).toHaveBeenCalledTimes(1);
});

it("header_toolbar_buttons_keep_names", async () => {
  vi.stubEnv("DEV", false);
  renderWithServices(<App />, appClient());

  const backend = await screen.findByRole("status", { name: "Backend" });
  expect(backend.textContent).toBe("Connected");
  expect(backend.getAttribute("data-pid")).toBe(BACKEND_PID.toString());
  for (const name of ["Terminal", "Accounts", "Settings"]) {
    expect(screen.getByRole("button", { name }).textContent).toBe(name);
  }
  vi.unstubAllEnvs();
});

it("update_banner_sits_outside_the_header", async () => {
  window.codeweave = makeCodeweaveApi({
    getAvailableUpdate: () => Promise.resolve({ version: "99.0.0" }),
  });
  renderWithServices(<App />, appClient());

  const text = await screen.findByText("Codeweave 99.0.0 is available.");
  const banner = text.closest('[role="status"]');

  expect(banner).not.toBeNull();
  expect(banner?.closest(".app-header")).toBeNull();
  expect(banner?.closest(".app-notices")).not.toBeNull();
});

it("segmented_tabs_mark_current", async () => {
  renderWithServices(<App />, appClient());

  const session = await screen.findByRole("tab", { name: "Session" });
  const flow = screen.getByRole("tab", { name: "Flow" });
  const agents = screen.getByRole("tab", { name: "Agents" });
  expect(session.getAttribute("aria-selected")).toBe("true");
  expect(flow.getAttribute("aria-selected")).toBe("false");

  fireEvent.click(agents);

  expect(session.getAttribute("aria-selected")).toBe("false");
  expect(agents.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    "tab-agents",
  );
});

it("long_account_labels_are_ellipsized_in_sidebar_and_dialog", async () => {
  renderWithServices(<App />, appClient());
  const sidebarLabel = await screen.findByText(LONG_LABEL, {
    selector: ".item-label",
  });
  cleanup();
  renderWithServices(<AccountsDialog onClose={vi.fn()} />, appClient());
  const dialogLabel = await screen.findByText(LONG_LABEL, {
    selector: ".account-label",
  });

  expect(sidebarLabel.className).toBe("item-label");
  expect(dialogLabel.className).toBe("account-label");
  for (const [file, selector] of [
    ["sidebar.css", ".item-label"],
    ["dialogs.css", ".account-label"],
  ] as const) {
    const body = ruleBody(file, selector);
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("overflow: hidden");
  }
});
