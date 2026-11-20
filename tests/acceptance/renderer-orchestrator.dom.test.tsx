import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { App } from "../../src/renderer/App";
import { createAppStore } from "../../src/renderer/store";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import type { FlowRunView, SessionView } from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowRun,
  makeFlowsList,
  makeMessage,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const PICKED_CWD = "/home/user/picked";
const PROJECT_CWD = "/home/user/project";
const WORKTREE_CWD = "/work/worktrees/run-a";
const ORCHESTRATOR_ID = "orchestrator-session";
const MAIN_TEXT = "Orchestrator chat message";
const NODE_TEXT = "Building the login form";
const WAIT_OPTIONS = { timeout: 5000 } as const;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_CWD),
  });
});

afterEach(cleanup);

function orchestrator(overrides: Partial<SessionView> = {}): SessionView {
  return makeSession({
    id: ORCHESTRATOR_ID,
    cwd: PROJECT_CWD,
    orchestrate: true,
    messages: [makeMessage({ text: MAIN_TEXT })],
    ...overrides,
  });
}

function nodeSession(overrides: Partial<SessionView> = {}): SessionView {
  return makeSession({
    id: "node-session",
    cwd: WORKTREE_CWD,
    flowRef: { flowId: "ship", nodeId: "build" },
    turnInFlight: true,
    messages: [makeMessage({ text: NODE_TEXT })],
    ...overrides,
  });
}

function ownedRun(overrides: Partial<FlowRunView> = {}): FlowRunView {
  return makeFlowRun({
    runId: "run-a",
    flowId: "ship",
    flowTitle: "Fix the bug",
    cwd: WORKTREE_CWD,
    origin: "orchestrator",
    placement: "worktree",
    branch: "codeweave/run-a",
    ownerSessionId: ORCHESTRATOR_ID,
    ...overrides,
  });
}

function clientWith(
  snapshot: Parameters<typeof makeSnapshot>[0],
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond("sessions/snapshot", makeSnapshot(snapshot));
  client.respond("flows/list", makeFlowsList());
  client.respond("session/start", orchestrator());
  return client;
}

function requestsOf(client: FakeIpcClient, method: string): unknown[] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

function emitFlowRun(client: FakeIpcClient, run: FlowRunView): void {
  client.emit({ v: PROTOCOL_VERSION, event: "flow/changed", payload: run });
}

async function findTimeline(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Orchestrator timeline" });
}

function runItems(timeline: HTMLElement): HTMLElement[] {
  return within(timeline).getAllByRole("listitem");
}

function graphNode(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
}

async function findGraphNode(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const node = graphNode(id);
    if (node === null) {
      throw new Error(`Graph node ${id} is not rendered`);
    }
    return node;
  }, WAIT_OPTIONS);
}

function runningSnapshot(): Parameters<typeof makeSnapshot>[0] {
  return {
    session: orchestrator(),
    flowRuns: [
      ownedRun({
        status: "running",
        currentNodeId: "build",
        nodes: [
          { id: "build", status: "running", visits: 1, result: null },
          { id: "review", status: "idle", visits: 0, result: null },
        ],
      }),
    ],
    flowSessions: [{ runId: "run-a", view: nodeSession() }],
  };
}

it("start_prompt_orchestrate_sends_orchestrate_without_a_flow_node", async () => {
  const client = clientWith({});
  renderWithServices(<App />, client);

  fireEvent.click(await screen.findByRole("checkbox", { name: "Orchestrate" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));

  await waitFor(() => {
    expect(requestsOf(client, "session/start")).toEqual([
      { cwd: PICKED_CWD, orchestrate: true },
    ]);
  });
  expect(requestsOf(client, "flows/list")).toEqual([]);
  expect(
    screen.getByText("The agent plans the task and runs flows for it."),
  ).toBeTruthy();
});

it("start_prompt_disables_orchestrate_for_gemini_and_says_why", async () => {
  const client = clientWith({
    accounts: [
      makeAccount({ id: "acc-1", provider: "claude" }),
      makeAccount({ id: "acc-2", provider: "gemini", label: "Google" }),
    ],
  });
  renderWithServices(<App />, client);

  fireEvent.change(await screen.findByRole("combobox", { name: "Agent" }), {
    target: { value: "gemini" },
  });

  const checkbox = await screen.findByRole("checkbox", { name: "Orchestrate" });
  expect((checkbox as HTMLInputElement).disabled).toBe(true);
  expect(
    screen.getByText("Orchestrate is not available for Gemini (agy) yet."),
  ).toBeTruthy();
});

function timelineSnapshot(): Parameters<typeof makeSnapshot>[0] {
  return {
    session: orchestrator(),
    flowRuns: [
      makeFlowRun({
        runId: "run-foreign",
        flowTitle: "Foreign flow",
        ownerSessionId: "another-session",
      }),
      ownedRun({
        runId: "run-b",
        flowTitle: "Add the form",
        status: "done",
        placement: "in_place",
        branch: null,
        round: 2,
        currentNodeId: null,
        decisions: [
          {
            nodeId: "review",
            reason: "rounds_exhausted",
            decision: "another_round",
            note: "Tests still fail",
          },
          {
            nodeId: "review",
            reason: "rounds_exhausted",
            decision: "approve",
            note: "Looks good now",
          },
        ],
      }),
      ownedRun({
        status: "awaiting_decision",
        round: 1,
        currentNodeId: null,
        decision: { reason: "missing_verdict", nodeId: "review" },
      }),
    ],
  };
}

function itemAt(timeline: HTMLElement, index: number): HTMLElement {
  const item = runItems(timeline)[index];
  if (item === undefined) {
    throw new Error(`The timeline has no item ${index.toString()}`);
  }
  return item;
}

it("timeline_lists_only_the_runs_of_the_orchestrator_newest_first", async () => {
  const client = clientWith(timelineSnapshot());
  renderWithServices(<App />, client);

  const timeline = await findTimeline();

  expect(
    within(timeline).getByRole("heading", {
      name: "Flows run by the orchestrator",
    }),
  ).toBeTruthy();
  expect(runItems(timeline)).toHaveLength(2);
  expect(within(timeline).queryByText("Foreign flow")).toBeNull();
  const first = itemAt(timeline, 0);
  const second = itemAt(timeline, 1);
  expect(within(first).getByText("Fix the bug")).toBeTruthy();
  expect(within(first).getByText("Worktree · codeweave/run-a")).toBeTruthy();
  expect(within(first).getByText("Waiting for the orchestrator")).toBeTruthy();
  expect(within(first).getByText("Round 1 of 2")).toBeTruthy();
  expect(
    within(first).getByText("review ended without a verdict."),
  ).toBeTruthy();
  expect(within(second).getByText("Add the form")).toBeTruthy();
  expect(within(second).getByText("In place")).toBeTruthy();
  expect(within(second).getByText("Done")).toBeTruthy();
  expect(within(second).getByText("Round 2 of 2")).toBeTruthy();
  expect(within(second).getByText("Another round at review")).toBeTruthy();
  expect(within(second).getByText("Tests still fail")).toBeTruthy();
  expect(within(second).getByText("Approve at review")).toBeTruthy();
  expect(within(second).getByText("Looks good now")).toBeTruthy();
  expect(within(second).getByText("Flow finished.")).toBeTruthy();
});

it("timeline_follows_flow_changed", async () => {
  const client = clientWith(timelineSnapshot());
  renderWithServices(<App />, client);
  const timeline = await findTimeline();

  emitFlowRun(
    client,
    ownedRun({
      status: "done",
      round: 1,
      currentNodeId: null,
      decisions: [
        {
          nodeId: "review",
          reason: "missing_verdict",
          decision: "stop",
          note: "Not worth another round",
        },
      ],
    }),
  );
  emitFlowRun(
    client,
    ownedRun({ runId: "run-c", flowTitle: "Newest flow", status: "running" }),
  );

  await waitFor(() => {
    expect(runItems(timeline)).toHaveLength(3);
  });
  const newest = itemAt(timeline, 0);
  const updated = itemAt(timeline, 1);
  expect(within(newest).getByText("Newest flow")).toBeTruthy();
  expect(within(updated).getByText("Stop at review")).toBeTruthy();
  expect(within(updated).getByText("Not worth another round")).toBeTruthy();
  expect(within(updated).getByText("Flow finished.")).toBeTruthy();
});

it("timeline_says_when_the_orchestrator_has_run_no_flows", async () => {
  const client = clientWith({ session: orchestrator() });
  renderWithServices(<App />, client);

  const timeline = await findTimeline();

  expect(within(timeline).getByText("No flows yet.")).toBeTruthy();
});

it("show_graph_opens_the_run_graph_and_its_node_opens_the_node_session_with_a_way_back", async () => {
  const client = clientWith(runningSnapshot());
  renderWithServices(<App />, client);
  const timeline = await findTimeline();

  fireEvent.click(within(timeline).getByRole("button", { name: "Show graph" }));

  const buildNode = await findGraphNode("build");
  expect(
    screen.getByRole("tab", { name: "Flow" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    buildNode.querySelector(".flow-node")?.getAttribute("data-state"),
  ).toBe("working");
  expect(requestsOf(client, "flows/list")).toEqual([{ cwd: PROJECT_CWD }]);

  fireEvent.click(buildNode);

  expect(await screen.findByText(NODE_TEXT)).toBeTruthy();
  expect(screen.getByText("Node session of Fix the bug")).toBeTruthy();
  expect(screen.queryByText(MAIN_TEXT)).toBeNull();
  expect(
    screen.getByPlaceholderText<HTMLTextAreaElement>("Describe the task")
      .disabled,
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Back to orchestrator" }));

  expect(await screen.findByText(MAIN_TEXT)).toBeTruthy();
  expect(screen.queryByText(NODE_TEXT)).toBeNull();
  expect(screen.queryByText("Node session of Fix the bug")).toBeNull();
});

it("a_user_flow_after_the_orchestrator_stopped_is_shown_instead_of_the_old_focused_run", async () => {
  const client = clientWith(runningSnapshot());
  renderWithServices(<App />, client);
  const timeline = await findTimeline();
  fireEvent.click(within(timeline).getByRole("button", { name: "Show graph" }));
  await findGraphNode("build");

  act(() => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "session/changed",
      payload: orchestrator({ phase: { phase: "stopped" } }),
    });
  });
  emitFlowRun(
    client,
    makeFlowRun({
      runId: "run-user",
      flowId: "ship",
      flowTitle: "User flow",
      cwd: PROJECT_CWD,
      origin: "user",
      status: "running",
      currentNodeId: "build",
      nodes: [{ id: "build", status: "running", visits: 1, result: null }],
    }),
  );
  client.emit({
    v: PROTOCOL_VERSION,
    event: "flowSession/changed",
    payload: {
      runId: "run-user",
      view: nodeSession({ id: "user-node-session" }),
    },
  });

  expect(await screen.findByText("User flow")).toBeTruthy();
  expect(screen.queryByText("Fix the bug")).toBeNull();
  expect(screen.queryByText(/Node session of/)).toBeNull();
});

it("a_focused_run_that_is_gone_falls_back_to_the_orchestrator_chat", async () => {
  const client = clientWith(runningSnapshot());
  const store = createAppStore(client);
  renderWithServices(<App />, client, store);
  await screen.findByText(MAIN_TEXT);

  act(() => {
    store.focusRun("run-evicted");
  });

  expect(screen.getByText(MAIN_TEXT)).toBeTruthy();
  expect(screen.queryByText(/Node session of/)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  expect(await screen.findByRole("region", { name: "Flow" })).toBeTruthy();
});
