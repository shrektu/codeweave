import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Sidebar } from "../../src/renderer/components/Sidebar";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import type {
  FlowRunView,
  SessionView,
  Snapshot,
} from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowRun,
  makeMessage,
  makePermission,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const RUN_ID = "run-7";
const NODE_TEXT = "Building the login form";
const MAIN_TEXT = "Chatting with the user";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function nodeSession(overrides: Partial<SessionView> = {}): SessionView {
  return makeSession({
    id: "node-session",
    flowRef: { flowId: "ship", nodeId: "build" },
    messages: [makeMessage({ text: NODE_TEXT })],
    ...overrides,
  });
}

function clientFor(overrides: Partial<Snapshot>): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot(overrides));
  client.respond("permission/answer", { ok: true });
  client.respond("flow/stop", { stopped: true });
  return client;
}

function openRun(overrides: Partial<FlowRunView> = {}): FlowRunView {
  return makeFlowRun({ runId: RUN_ID, status: "running", ...overrides });
}

function requestsOf(client: FakeIpcClient, method: string): unknown[] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

it("session_stream_shows_the_node_session_of_an_open_run_without_a_main_session", async () => {
  const client = clientFor({
    flowRuns: [openRun()],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText(NODE_TEXT)).toBeTruthy();
  expect(screen.queryByText("No session")).toBeNull();
});

it("session_stream_prefers_the_main_session_over_a_run_session", async () => {
  const client = clientFor({
    session: makeSession({
      id: "main-session",
      messages: [makeMessage({ text: MAIN_TEXT })],
    }),
    flowRuns: [openRun({ origin: "orchestrator" })],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText(MAIN_TEXT)).toBeTruthy();
  expect(screen.queryByText(NODE_TEXT)).toBeNull();
});

it("shows_the_running_node_session_after_the_main_session_stopped", async () => {
  const client = clientFor({
    session: makeSession({
      id: "main-session",
      phase: { phase: "stopped" },
      messages: [makeMessage({ text: MAIN_TEXT })],
    }),
    flowRuns: [openRun()],
    flowSessions: [
      {
        runId: RUN_ID,
        view: nodeSession({
          permissions: [makePermission()],
          turnInFlight: true,
        }),
      },
    ],
  });
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText(NODE_TEXT)).toBeTruthy();
  expect(screen.queryByText(MAIN_TEXT)).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await waitFor(() => {
    expect(requestsOf(client, "permission/answer")).toEqual([
      { requestId: "req-1", optionId: "opt-reject", runId: RUN_ID },
    ]);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await waitFor(() => {
    expect(requestsOf(client, "flow/stop")).toEqual([{ runId: RUN_ID }]);
  });
});

it("session_stream_keeps_a_stopped_main_session_when_no_run_is_open", async () => {
  const client = clientFor({
    session: makeSession({
      id: "main-session",
      phase: { phase: "stopped" },
      messages: [makeMessage({ text: MAIN_TEXT })],
    }),
    flowRuns: [openRun({ status: "done" })],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText(MAIN_TEXT)).toBeTruthy();
  expect(screen.queryByText(NODE_TEXT)).toBeNull();
});

it("highlights_the_node_session_account_during_a_flow", async () => {
  const client = clientFor({
    accounts: [
      makeAccount({ id: "acc-1", label: "Work" }),
      makeAccount({ id: "acc-2", label: "Home" }),
    ],
    flowRuns: [openRun()],
    flowSessions: [
      {
        runId: RUN_ID,
        view: nodeSession({
          activeAccountId: "acc-2",
          phase: { phase: "running", accountId: "acc-2" },
        }),
      },
    ],
  });
  renderWithServices(
    <Sidebar onManageAccounts={vi.fn<() => void>()} />,
    client,
  );

  await screen.findByText("Home");

  expect(
    screen.getByText("Home").closest("li")?.getAttribute("aria-current"),
  ).toBe("true");
  expect(
    screen.getByText("Work").closest("li")?.getAttribute("aria-current"),
  ).toBeNull();
});

it("session_stream_hides_the_session_of_a_run_that_is_no_longer_open", async () => {
  const client = clientFor({
    flowRuns: [openRun({ status: "done" })],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  expect(await screen.findByText("No session")).toBeTruthy();
  expect(screen.queryByText(NODE_TEXT)).toBeNull();
});

it("node_session_permission_answer_carries_the_run_id", async () => {
  const client = clientFor({
    flowRuns: [openRun()],
    flowSessions: [
      {
        runId: RUN_ID,
        view: nodeSession({ permissions: [makePermission()] }),
      },
    ],
  });
  renderWithServices(<SessionStream />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

  await waitFor(() => {
    expect(requestsOf(client, "permission/answer")).toEqual([
      { requestId: "req-1", optionId: "opt-reject", runId: RUN_ID },
    ]);
  });
});

it("main_session_permission_answer_carries_no_run_id", async () => {
  const client = clientFor({
    session: makeSession({ permissions: [makePermission()] }),
    flowRuns: [openRun({ origin: "orchestrator" })],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

  await waitFor(() => {
    expect(requestsOf(client, "permission/answer")).toEqual([
      { requestId: "req-1", optionId: "opt-reject" },
    ]);
  });
});

it("node_session_stop_stops_its_run_and_not_the_main_session", async () => {
  const client = clientFor({
    flowRuns: [openRun()],
    flowSessions: [
      { runId: RUN_ID, view: nodeSession({ turnInFlight: true }) },
    ],
  });
  renderWithServices(<SessionStream />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

  await waitFor(() => {
    expect(requestsOf(client, "flow/stop")).toEqual([{ runId: RUN_ID }]);
  });
  expect(requestsOf(client, "session/stop")).toEqual([]);
});

it("main_session_stop_still_sends_session_stop", async () => {
  const client = clientFor({
    session: makeSession({ turnInFlight: true }),
  });
  client.respond("session/stop", { stopped: true });
  renderWithServices(<SessionStream />, client);

  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

  await waitFor(() => {
    expect(requestsOf(client, "session/stop")).toEqual([{}]);
  });
  expect(requestsOf(client, "flow/stop")).toEqual([]);
});

it("node_session_composer_cannot_prompt_the_main_session", async () => {
  const client = clientFor({
    flowRuns: [openRun()],
    flowSessions: [{ runId: RUN_ID, view: nodeSession() }],
  });
  renderWithServices(<SessionStream />, client);

  const box = await screen.findByPlaceholderText("Describe the task");

  expect((box as HTMLTextAreaElement).disabled).toBe(true);
});
