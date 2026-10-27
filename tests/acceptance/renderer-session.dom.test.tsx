import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PermissionCard } from "../../src/renderer/components/PermissionCard";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { RotationPhaseView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makePermission,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
} from "../fakes/fakeIpcClient";

process.env.TZ = "UTC";

const PICKED_FOLDER = "/home/user/picked";

beforeEach(() => {
  window.codeweave = {
    gpuAccelerated: true,
    pickFolder: () => Promise.resolve(PICKED_FOLDER),
  };
});

afterEach(cleanup);

function allButtonsDisabled(): boolean {
  return screen
    .getAllByRole<HTMLButtonElement>("button")
    .every((button) => button.disabled);
}

it("permission_card_renders_adapter_option_names", () => {
  const client = createFakeIpcClient();
  client.respond("permission/answer", { ok: true });
  renderWithServices(<PermissionCard permission={makePermission()} />, client);

  expect(screen.getByText("Needs approval")).toBeTruthy();
  expect(screen.getByText("pnpm test")).toBeTruthy();
  const always = screen.getByRole("button", { name: "Always allow" });
  const once = screen.getByRole("button", { name: "Allow this once" });
  expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(once.classList.contains("pri")).toBe(true);
  expect(always.classList.contains("pri")).toBe(false);

  fireEvent.click(always);

  expect(client.requests).toContainEqual({
    method: "permission/answer",
    params: { requestId: "req-1", optionId: "opt-always" },
  });
});

it("permission_card_disables_buttons_while_request_in_flight", async () => {
  const client = createFakeIpcClient();
  const gate = Promise.withResolvers<{ ok: true }>();
  client.on("permission/answer", () => gate.promise);
  renderWithServices(<PermissionCard permission={makePermission()} />, client);

  fireEvent.click(screen.getByRole("button", { name: "Reject" }));

  await waitFor(() => {
    expect(allButtonsDisabled()).toBe(true);
  });
  gate.resolve({ ok: true });
});

it("permission_card_shows_error_inline", async () => {
  const client = createFakeIpcClient();
  client.fail(
    "permission/answer",
    new IpcRemoteError(IpcErrorCode.EXPIRED, "Request expired"),
  );
  renderWithServices(<PermissionCard permission={makePermission()} />, client);

  fireEvent.click(screen.getByRole("button", { name: "Reject" }));

  expect(await screen.findByText("Request expired")).toBeTruthy();
});

it("session_start_uses_picked_folder", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  client.respond("session/start", makeSession({ cwd: PICKED_FOLDER }));
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText("No session")).toBeTruthy();
  expect(screen.getByText("Choose a project folder to start.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER },
    });
  });
});

it("session_start_does_nothing_when_picker_is_cancelled", async () => {
  let pickerCalls = 0;
  window.codeweave.pickFolder = () => {
    pickerCalls += 1;
    return Promise.resolve(null);
  };
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(pickerCalls).toBe(1);
  });
  expect(
    client.requests.filter((request) => request.method === "session/start"),
  ).toEqual([]);
});

it("session_start_shows_backend_error_inline", async () => {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  client.fail(
    "session/start",
    new IpcRemoteError(IpcErrorCode.UNAVAILABLE, "Sessions are unavailable"),
  );
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  expect(await screen.findByText("Sessions are unavailable")).toBeTruthy();
});

it.each<[RotationPhaseView, string]>([
  [{ phase: "running", accountId: "acc-1" }, "Running on Work"],
  [
    { phase: "switching", from: "acc-1", to: "acc-2" },
    "Switching from Work to Personal",
  ],
  [
    { phase: "waiting", accountId: "acc-2", until: 1_793_095_200 },
    "Waiting for Personal until 10:00",
  ],
  [
    { phase: "failed", reason: "spawn failed", runningAccountId: null },
    "Failed: spawn failed",
  ],
  [{ phase: "halted" }, "Halted: no usable accounts"],
  [{ phase: "stopped" }, "Stopped"],
])("session_phase_line_%j", (phase, expected) => {
  const state = readyState(
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", label: "Work" }),
        makeAccount({ id: "acc-2", label: "Personal", order: 1 }),
      ],
      session: makeSession({ phase }),
    }),
  );
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(state),
  );

  expect(screen.getByText(expected)).toBeTruthy();
  expect(screen.getByText("/home/user/project")).toBeTruthy();
});

it("session_stop_sends_request", () => {
  const client = createFakeIpcClient();
  client.respond("session/stop", { stopped: true });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(readyState(makeSnapshot({ session: makeSession() }))),
  );

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

  expect(client.requests).toContainEqual({
    method: "session/stop",
    params: {},
  });
});
