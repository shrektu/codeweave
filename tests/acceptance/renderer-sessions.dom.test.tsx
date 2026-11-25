import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { App } from "../../src/renderer/App";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowsList,
  makeMessage,
  makePermission,
  makeSession,
  makeSnapshot,
  makeVaultStatus,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function setupClient(snapshot: ReturnType<typeof makeSnapshot>): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond("sessions/snapshot", snapshot);
  client.respond("flows/list", makeFlowsList());
  client.respond("vault/status", makeVaultStatus());
  client.respond("session/prompt", { accepted: true });
  client.respond("permission/answer", { ok: true });
  return client;
}

it("sidebar_lists_sessions_with_status", async () => {
  const sessions = [
    makeSession({
      id: "s-plain",
      cwd: "/work/alpha",
      turnInFlight: true,
    }),
    makeSession({
      id: "s-orch",
      cwd: "/work/beta",
      orchestrate: true,
      permissions: [makePermission()],
    }),
    makeSession({
      id: "s-ended",
      cwd: "/home/user",
      explicitFolder: false,
      phase: { phase: "stopped" },
    }),
  ];
  const client = setupClient(
    makeSnapshot({
      sessions,
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<Sidebar onManageAccounts={() => undefined} />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  expect(within(nav).getByText("alpha")).toBeTruthy();
  expect(within(nav).getByText("beta")).toBeTruthy();
  expect(within(nav).getByText("No folder")).toBeTruthy();
  expect(within(nav).getByText("Orchestrator")).toBeTruthy();
  expect(within(nav).getByText("Running")).toBeTruthy();
  expect(within(nav).getByText("Needs permission")).toBeTruthy();
  expect(within(nav).getByText("Stopped")).toBeTruthy();
  const activeItem = within(nav)
    .getByText("beta")
    .closest("[aria-current='true']");
  expect(activeItem).not.toBeNull();
});

it("clicking_session_switches_stream_and_composer_target", async () => {
  const s1 = makeSession({
    id: "s-1",
    cwd: "/work/one",
    messages: [makeMessage({ text: "First stream", seq: 1 })],
  });
  const s2 = makeSession({
    id: "s-2",
    cwd: "/work/two",
    messages: [makeMessage({ text: "Second stream", seq: 1 })],
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [s1, s2],
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<App />, client);

  await screen.findByText("Second stream");
  const nav = screen.getByRole("region", { name: "Sessions" });
  fireEvent.click(within(nav).getByText("one"));

  await screen.findByText("First stream");
  const composer = screen.getByPlaceholderText("Describe the task");
  fireEvent.change(composer, { target: { value: "Hello one" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/prompt",
      params: {
        sessionId: "s-1",
        text: "Hello one",
      },
    });
  });
});

it("new_session_shows_start_form", async () => {
  const client = setupClient(
    makeSnapshot({
      sessions: [makeSession({ id: "s-1", cwd: "/work/one" })],
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(within(nav).getByRole("button", { name: "New session" }));

  expect(screen.getByPlaceholderText("What should the agent do?")).toBeTruthy();
});

it("started_session_becomes_active", async () => {
  const existing = makeSession({ id: "s-1", cwd: "/work/one" });
  const started = makeSession({ id: "s-2", cwd: "/work/two" });
  const client = setupClient(
    makeSnapshot({
      sessions: [existing],
      accounts: [makeAccount()],
    }),
  );
  client.on("session/start", () => {
    client.emit({ v: 7, event: "session/changed", payload: started });
    return started;
  });

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(within(nav).getByRole("button", { name: "New session" }));
  fireEvent.change(screen.getByPlaceholderText("What should the agent do?"), {
    target: { value: "Start two" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => {
    const item = within(nav).getByText("two").closest("[aria-current='true']");
    expect(item).not.toBeNull();
  });
});

it("close_button_only_on_ended_sessions", async () => {
  const live = makeSession({ id: "s-live", cwd: "/work/live" });
  const ended = makeSession({
    id: "s-ended",
    cwd: "/work/ended",
    phase: { phase: "stopped" },
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [live, ended],
      accounts: [makeAccount()],
    }),
  );
  client.respond("session/close", { closed: true });

  renderWithServices(<Sidebar onManageAccounts={() => undefined} />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  const closeButtons = within(nav).getAllByRole("button", {
    name: "Close session",
  });
  expect(closeButtons).toHaveLength(1);
  fireEvent.click(within(nav).getByRole("button", { name: "Close session" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/close",
      params: { sessionId: "s-ended" },
    });
  });
});

it("permission_answer_sends_active_session_id", async () => {
  const session = makeSession({
    id: "s-perm",
    cwd: "/work/perm",
    permissions: [makePermission({ requestId: "req-9" })],
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [session],
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<App />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Allow this once" }),
  );

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "permission/answer",
      params: {
        requestId: "req-9",
        optionId: "opt-once",
        sessionId: "s-perm",
      },
    });
  });
});

it("first_snapshot_activates_newest_ended_session", async () => {
  const older = makeSession({
    id: "s-1",
    cwd: "/work/one",
    phase: { phase: "stopped" },
  });
  const newer = makeSession({
    id: "s-2",
    cwd: "/work/two",
    phase: { phase: "stopped" },
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [older, newer],
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  expect(
    within(nav).getByText("two").closest("[aria-current='true']"),
  ).not.toBeNull();
});

it("late_started_session_becomes_active_after_start_timeout", async () => {
  const client = setupClient(
    makeSnapshot({
      sessions: [],
      accounts: [makeAccount()],
    }),
  );
  client.fail("session/start", new Error("Request timed out"));

  renderWithServices(<App />, client);

  fireEvent.change(
    await screen.findByPlaceholderText("What should the agent do?"),
    { target: { value: "Start late" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Request timed out");

  client.emit({
    v: 7,
    event: "session/changed",
    payload: makeSession({ id: "s-late", cwd: "/work/late" }),
  });

  const nav = screen.getByRole("region", { name: "Sessions" });
  const late = await within(nav).findByText("late");
  expect(late.closest("[aria-current='true']")).not.toBeNull();
});

it("new_session_ignores_other_orchestrators_runs", async () => {
  const orch = makeSession({
    id: "orch-a",
    cwd: "/work/orch",
    orchestrate: true,
  });
  const ended = makeSession({
    id: "ended-b",
    cwd: "/work/ended",
    phase: { phase: "stopped" },
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [orch, ended],
      accounts: [makeAccount()],
      flowRuns: [
        {
          runId: "run-a",
          flowId: "ship",
          flowTitle: "Ship",
          cwd: "/work/orch",
          task: "Work",
          status: "running",
          round: 0,
          maxRounds: 1,
          currentNodeId: "build",
          nodes: [],
          decision: null,
          decisions: [],
          failure: null,
          origin: "orchestrator",
          placement: "worktree",
          branch: null,
          ownerSessionId: "orch-a",
        },
      ],
      flowSessions: [
        {
          runId: "run-a",
          view: makeSession({
            id: "node-a",
            cwd: "/work/orch",
            messages: [makeMessage({ text: "Orch child node", seq: 1 })],
          }),
        },
      ],
    }),
  );

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(within(nav).getByRole("button", { name: "New session" }));

  expect(screen.getByPlaceholderText("What should the agent do?")).toBeTruthy();
  expect(screen.queryByText("Orch child node")).toBeNull();
});

it("flow_run_blocked_while_background_session_live", async () => {
  const liveBg = makeSession({ id: "s-live", cwd: "/work/live" });
  const endedActive = makeSession({
    id: "s-ended",
    cwd: "/work/ended",
    phase: { phase: "stopped" },
  });
  const client = setupClient(
    makeSnapshot({
      sessions: [liveBg, endedActive],
      accounts: [makeAccount()],
    }),
  );

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("region", { name: "Sessions" });
  fireEvent.click(within(nav).getByText("ended"));
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));

  expect(
    await screen.findByText("End the current session to run a flow."),
  ).toBeTruthy();
});
