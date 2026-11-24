import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PermissionCard } from "../../src/renderer/components/PermissionCard";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { RotationPhaseView, TurnRouteView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeMessage,
  makePermission,
  makeSession,
  makeSnapshot,
  makeTool,
  readyState,
  renderWithServices,
  staticStore,
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

process.env.TZ = "UTC";

const PICKED_FOLDER = "/home/user/picked";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_FOLDER),
  });
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
  expect(
    screen.getByText("Type a task to start, or choose a folder."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER },
    });
  });
});

it("start_prompt_sends_provider", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      accounts: [
        makeAccount({ id: "codex-1", provider: "codex", label: "Codex" }),
        makeAccount({ id: "codex-2", provider: "codex", label: "Spare" }),
      ],
    }),
  );
  client.respond("session/start", makeSession({ provider: "codex" }));
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER, provider: "codex" },
    });
  });
});

it("start_prompt_shows_agent_select_only_for_multiple_providers", async () => {
  const single = createFakeIpcClient();
  single.respond(
    "sessions/snapshot",
    makeSnapshot({ accounts: [makeAccount({ id: "acc-1" })] }),
  );
  const first = renderWithServices(<SessionStream />, single);
  await screen.findByRole("button", { name: "Choose folder…" });
  expect(screen.queryByLabelText("Agent")).toBeNull();
  first.unmount();

  const mixed = createFakeIpcClient();
  mixed.respond(
    "sessions/snapshot",
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", provider: "claude", label: "Work" }),
        makeAccount({
          id: "codex-1",
          provider: "codex",
          label: "Codex",
          order: 1,
        }),
        makeAccount({
          id: "acc-2",
          provider: "claude",
          label: "Spare",
          order: 2,
        }),
      ],
    }),
  );
  mixed.respond("session/start", makeSession({ provider: "codex" }));
  renderWithServices(<SessionStream />, mixed);

  const agent = await screen.findByLabelText<HTMLSelectElement>("Agent");
  expect(
    within(agent)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Claude", "Codex"]);
  expect(agent.value).toBe("claude");
  fireEvent.change(agent, { target: { value: "codex" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(mixed.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER, provider: "codex" },
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
  [{ phase: "running", accountId: "acc-1" }, "Idle on Work"],
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

function renderHeader(session: ReturnType<typeof makeSession>): void {
  const state = readyState(
    makeSnapshot({
      accounts: [
        makeAccount({ id: "acc-1", label: "Work", provider: "codex" }),
      ],
      session,
    }),
  );
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(state),
  );
}

it("session_header_shows_provider_account_model", () => {
  renderHeader(
    makeSession({
      activeProvider: "codex",
      currentModel: "gpt-6.1-sol",
    }),
  );

  const model = screen.getByLabelText("Model in use");
  expect(model.textContent).toBe("gpt-6.1-sol");
  expect(model.className).toBe("session-model");
  expect(document.querySelector(".session-provider")?.textContent).toBe(
    "Codex",
  );
  expect(document.querySelector(".session-account")?.textContent).toBe("Work");
  expect(document.querySelector(".session-identity")?.textContent).toBe(
    "Codex · Work · gpt-6.1-sol",
  );
  expect(screen.getByText("Idle on Work")).toBeTruthy();
});

it("session_header_says_cli_default_when_no_model_is_reported", () => {
  renderHeader(makeSession({ activeProvider: "codex", currentModel: null }));

  expect(screen.getByLabelText("Model in use").textContent).toBe("CLI default");
});

it("session_header_shows_a_dash_without_an_active_account", () => {
  renderHeader(
    makeSession({
      activeProvider: "codex",
      activeAccountId: null,
      phase: { phase: "halted" },
    }),
  );

  expect(document.querySelector(".session-account")?.textContent).toBe("—");
});

it.each<[RotationPhaseView]>([
  [{ phase: "stopped" }],
  [{ phase: "failed", reason: "spawn failed", runningAccountId: null }],
  [{ phase: "halted" }],
])("start_prompt_offered_after_session_stopped_%j", async (phase) => {
  const client = createFakeIpcClient();
  client.respond("session/start", makeSession({ cwd: PICKED_FOLDER }));
  const state = readyState(
    makeSnapshot({
      session: makeSession({
        phase,
        messages: [makeMessage({ id: "m1", text: "Earlier reply", seq: 0 })],
      }),
    }),
  );
  renderWithServices(<SessionStream />, client, staticStore(state));

  expect(screen.getByText("Earlier reply")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/start",
      params: { cwd: PICKED_FOLDER },
    });
  });
});

it("start_prompt_hidden_while_session_is_running", () => {
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(readyState(makeSnapshot({ session: makeSession() }))),
  );

  expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
});

it("session_stream_renders_in_arrival_order", () => {
  const state = readyState(
    makeSnapshot({
      session: makeSession({
        messages: [
          makeMessage({ id: "m1", text: "First reply", seq: 0 }),
          makeMessage({ id: "m2", text: "Second reply", seq: 3 }),
        ],
        toolCalls: [makeTool({ title: "Run tests", seq: 1 })],
        permissions: [makePermission({ title: "Write file", seq: 2 })],
      }),
    }),
  );
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(state),
  );

  const items = within(screen.getByRole("list")).getAllByRole("listitem");

  expect(items).toHaveLength(4);
  expect(items[0]?.textContent).toContain("First reply");
  expect(items[1]?.textContent).toContain("Run tests");
  expect(items[2]?.textContent).toContain("Write file");
  expect(items[3]?.textContent).toContain("Second reply");
});

function renderRunning(turnInFlight: boolean): void {
  renderWithServices(
    <SessionStream />,
    createFakeIpcClient(),
    staticStore(
      readyState(
        makeSnapshot({
          accounts: [makeAccount({ id: "acc-1", label: "Work" })],
          session: makeSession({ turnInFlight }),
        }),
      ),
    ),
  );
}

it("session_head_working_during_turn", () => {
  renderRunning(true);

  expect(screen.getByText("Working on Work")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
});

it("session_head_idle_after_turn_end", () => {
  renderRunning(false);

  expect(screen.getByText("Idle on Work")).toBeTruthy();
  expect(screen.getByRole("button", { name: "End session" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

it("session_stop_sends_request", () => {
  const client = createFakeIpcClient();
  client.respond("session/stop", { stopped: true });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(
        makeSnapshot({ session: makeSession({ turnInFlight: true }) }),
      ),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

  expect(client.requests).toContainEqual({
    method: "session/stop",
    params: {},
  });
});

function makeTurn(overrides: Partial<TurnRouteView> = {}): TurnRouteView {
  return {
    promptSeq: 0,
    accountId: "acc-1",
    model: "openai/gpt-oss-20b",
    effectiveModel: null,
    apiProvider: "groq",
    requestedClass: "light",
    servedClass: "light",
    source: "routed",
    ...overrides,
  };
}

function renderTurns(turns: TurnRouteView[]): void {
  const client = createFakeIpcClient();
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      session: makeSession({
        messages: [makeMessage({ text: "Done", seq: 1 })],
        turns,
      }),
    }),
  );
  renderWithServices(<SessionStream />, client);
}

it("turn badge shows the routed model and class", async () => {
  renderTurns([makeTurn({ effectiveModel: "groq/openai/gpt-oss-20b" })]);

  const badge = await screen.findByText("groq/openai/gpt-oss-20b · light");
  expect(badge.getAttribute("title")).toBe(
    "This turn used groq/openai/gpt-oss-20b (light)",
  );
  const items = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(items.indexOf("groq/openai/gpt-oss-20b · light")).toBeLessThan(
    items.indexOf("Done"),
  );
});

it("turn badge shows the class fallback", async () => {
  renderTurns([
    makeTurn({
      model: "openai/gpt-oss-120b",
      requestedClass: "standard",
      servedClass: "heavy",
    }),
  ]);

  expect(
    await screen.findByText("groq/openai/gpt-oss-120b · standard → heavy"),
  ).toBeTruthy();
});

it("turn badge marks a not routed turn", async () => {
  renderTurns([
    makeTurn({
      requestedClass: "standard",
      servedClass: null,
      source: "account",
    }),
  ]);

  expect(
    await screen.findByText("groq/openai/gpt-oss-20b · standard · not routed"),
  ).toBeTruthy();
});

it("turn badge shows the CLI default", async () => {
  renderTurns([
    makeTurn({
      model: null,
      apiProvider: null,
      requestedClass: "standard",
      servedClass: null,
      source: "cli_default",
    }),
  ]);

  expect(
    await screen.findByText("CLI default · standard · not routed"),
  ).toBeTruthy();
});
