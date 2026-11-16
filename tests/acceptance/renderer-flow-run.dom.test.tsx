import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import type {
  FlowRunView,
  FlowsList,
  SessionView,
} from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeFlow,
  makeFlowRun,
  makeFlowsList,
  makeMessage,
  makePermission,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const handleRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: (props: Parameters<typeof actual.Handle>[0]) => {
      handleRenders.count += 1;
      return createElement(actual.Handle, props);
    },
  };
});

const PICKED_CWD = "/home/user/picked";
const SESSION_CWD = "/home/user/project";
const WAIT_OPTIONS = { timeout: 5000 } as const;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_CWD),
  });
});

afterEach(cleanup);

interface ClientOptions {
  session?: SessionView | null;
  flowRun?: FlowRunView | null;
  list?: FlowsList;
}

function appClient(options: ClientOptions = {}): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      session: options.session ?? null,
      flowRun: options.flowRun ?? null,
    }),
  );
  client.respond("flows/list", options.list ?? makeFlowsList());
  return client;
}

function openRun(overrides: Partial<FlowRunView> = {}): FlowRunView {
  return makeFlowRun({
    flowId: "ship",
    flowTitle: "Ship it",
    cwd: PICKED_CWD,
    ...overrides,
  });
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

function nodeState(id: string): string | null | undefined {
  return graphNode(id)
    ?.querySelector<HTMLElement>(".flow-node")
    ?.getAttribute("data-state");
}

async function expectNodeState(
  id: string,
  state: string,
  options: { timeout: number } = WAIT_OPTIONS,
): Promise<void> {
  await waitFor(() => {
    expect(nodeState(id)).toBe(state);
  }, options);
}

async function openFlowTab(client: FakeIpcClient): Promise<void> {
  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));
}

async function openFlowTabWithGraph(client: FakeIpcClient): Promise<void> {
  await openFlowTab(client);
  await findGraphNode("build");
}

async function pickFolder(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );
  await findGraphNode("build");
}

function emitFlowRun(client: FakeIpcClient, run: FlowRunView | null): void {
  client.emit({ v: PROTOCOL_VERSION, event: "flow/changed", payload: run });
}

function emitSession(client: FakeIpcClient, session: SessionView): void {
  client.emit({
    v: PROTOCOL_VERSION,
    event: "session/changed",
    payload: session,
  });
}

function requestsOf(client: FakeIpcClient, method: string): unknown[] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

function taskField(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>("Task");
}

function runButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Run flow" });
}

function typeTask(text: string): void {
  fireEvent.change(taskField(), { target: { value: text } });
}

it("flow_tab_without_session_picks_folder_and_lists_flows", async () => {
  const client = appClient();
  await openFlowTab(client);

  expect(screen.queryByText("Start a session to see its flows.")).toBeNull();
  expect(requestsOf(client, "flows/list")).toEqual([]);
  await pickFolder();

  expect(requestsOf(client, "flows/list")).toEqual([{ cwd: PICKED_CWD }]);
  expect(screen.getByRole("button", { name: "Run flow" })).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Session" }));
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  await findGraphNode("build");
  expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
});

it("flow_run_starts_with_task_and_selected_flow", async () => {
  const list = makeFlowsList({
    flows: [makeFlow(), makeFlow({ id: "fix", file: "flows/fix.md" })],
  });
  const client = appClient({ list });
  client.respond("flow/start", openRun({ flowId: "fix" }));
  await openFlowTab(client);
  await pickFolder();

  expect(runButton().disabled).toBe(true);
  typeTask("   ");
  expect(runButton().disabled).toBe(true);

  fireEvent.change(screen.getByRole("combobox", { name: "Flow" }), {
    target: { value: "fix" },
  });
  typeTask("  Add a login form  ");
  expect(runButton().disabled).toBe(false);
  fireEvent.click(runButton());

  await waitFor(() => {
    expect(requestsOf(client, "flow/start")).toEqual([
      { cwd: PICKED_CWD, flowId: "fix", task: "Add a login form" },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_run_shows_backend_start_errors", async () => {
  const client = appClient();
  client.fail(
    "flow/start",
    new IpcRemoteError(IpcErrorCode.CONFLICT, "A flow is already running."),
  );
  await openFlowTab(client);
  await pickFolder();

  typeTask("Do it");
  fireEvent.click(runButton());

  expect(await screen.findByText("A flow is already running.")).toBeTruthy();
});

it("flow_run_disabled_while_session_live_or_editing", async () => {
  const live = appClient({ session: makeSession({ cwd: SESSION_CWD }) });
  await openFlowTabWithGraph(live);
  typeTask("Do it");
  expect(runButton().disabled).toBe(true);
  expect(
    screen.getByText("End the current session to run a flow."),
  ).toBeTruthy();
  cleanup();

  const idle = appClient();
  await openFlowTab(idle);
  await pickFolder();
  typeTask("Do it");
  expect(runButton().disabled).toBe(false);
  expect(
    screen.queryByText("End the current session to run a flow."),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("form", { name: "Add node" });
  expect(runButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => {
    expect(runButton().disabled).toBe(false);
  }, WAIT_OPTIONS);
});

function runSession(overrides: Partial<SessionView> = {}): SessionView {
  return makeSession({
    cwd: PICKED_CWD,
    flowRef: { flowId: "ship", nodeId: "build" },
    turnInFlight: true,
    ...overrides,
  });
}

it("flow_run_shows_running_node_states_from_session", async () => {
  const client = appClient({ session: runSession() });
  await openFlowTab(client);
  await findGraphNode("build");
  expect(nodeState("build")).toBe("working");
  expect(nodeState("review")).toBe("idle");

  emitFlowRun(
    client,
    openRun({
      round: 1,
      nodes: [
        { id: "build", status: "running", visits: 1, result: null },
        { id: "review", status: "queued", visits: 0, result: null },
      ],
    }),
  );
  await expectNodeState("build", "working");
  await expectNodeState("review", "idle");
  expect(screen.getByText("Ship it")).toBeTruthy();
  expect(screen.getByText("Reviews: 1 of 2")).toBeTruthy();
  expect(screen.getByText("Add a login form")).toBeTruthy();

  emitSession(
    client,
    runSession({ permissions: [makePermission({ requestId: "req-2" })] }),
  );
  await expectNodeState("build", "awaiting_permission");

  emitSession(
    client,
    runSession({
      phase: { phase: "waiting", accountId: "acc-1", until: 1_900_000_000 },
    }),
  );
  await expectNodeState("build", "rate_limited");
});

it("flow_run_shows_done_and_failed_nodes_from_flow_changed", async () => {
  const client = appClient({ session: runSession() });
  await openFlowTab(client);
  await findGraphNode("build");
  emitFlowRun(
    client,
    openRun({
      round: 1,
      nodes: [
        { id: "build", status: "running", visits: 1, result: null },
        { id: "review", status: "queued", visits: 0, result: null },
      ],
    }),
  );
  await expectNodeState("build", "working");

  emitFlowRun(
    client,
    openRun({
      round: 1,
      currentNodeId: "review",
      nodes: [
        { id: "build", status: "done", visits: 1, result: "Built it." },
        { id: "review", status: "running", visits: 1, result: null },
      ],
    }),
  );
  await expectNodeState("build", "done");
  await expectNodeState("review", "working");

  emitFlowRun(
    client,
    openRun({
      status: "failed",
      failure: "review crashed",
      currentNodeId: null,
      nodes: [
        { id: "build", status: "done", visits: 1, result: "Built it." },
        { id: "review", status: "failed", visits: 1, result: null },
      ],
    }),
  );
  await expectNodeState("build", "done");
  await expectNodeState("review", "error");
  expect(await screen.findByText("Flow failed: review crashed")).toBeTruthy();
});

it("flow_run_lists_node_results_collapsed", async () => {
  const client = appClient({
    flowRun: openRun({
      nodes: [
        { id: "build", status: "done", visits: 2, result: "Built it." },
        { id: "review", status: "running", visits: 1, result: null },
      ],
    }),
  });
  await openFlowTab(client);
  await findGraphNode("build");

  const summary = await screen.findByText("build · visits 2");
  const details = summary.closest("details");
  expect(details?.open).toBe(false);
  expect(within(details as HTMLElement).getByText("Built it.")).toBeTruthy();
  expect(screen.queryByText("review · visits 1")).toBeNull();
});

const DECISION_CASES = [
  {
    reason: "gate",
    nodeId: "review",
    text: "Approve to continue to review.",
    buttons: ["Approve", "Stop"],
    click: "Approve",
    decision: "approve",
  },
  {
    reason: "rounds_exhausted",
    nodeId: "review",
    text: "review still requests changes after 2 reviews.",
    buttons: ["Approve", "Another round", "Stop"],
    click: "Another round",
    decision: "another_round",
  },
  {
    reason: "missing_verdict",
    nodeId: "review",
    text: "review ended without a verdict.",
    buttons: ["Approve", "Another round", "Stop"],
    click: "Stop",
    decision: "stop",
  },
] as const;

it("flow_run_approval_banner_sends_decision", async () => {
  for (const item of DECISION_CASES) {
    const client = appClient({
      flowRun: openRun({
        status: "awaiting_decision",
        round: 2,
        nodes: [
          { id: "build", status: "done", visits: 2, result: "x" },
          { id: "review", status: "done", visits: 2, result: "y" },
        ],
        decision: { reason: item.reason, nodeId: item.nodeId },
      }),
    });
    client.respond("flow/decide", openRun());
    await openFlowTab(client);

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(item.text)).toBeTruthy();
    const names = within(banner)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(item.buttons);

    fireEvent.click(within(banner).getByRole("button", { name: item.click }));
    await waitFor(() => {
      expect(requestsOf(client, "flow/decide")).toEqual([
        { runId: "run-1", decision: item.decision },
      ]);
    }, WAIT_OPTIONS);
    cleanup();
  }
});

it("flow_run_header_counts_finished_reviews", async () => {
  const cases = [
    { round: 0, text: "Reviews: 0 of 2" },
    { round: 2, text: "Reviews: 2 of 2" },
    { round: 3, text: "Reviews: 3 (limit 2)" },
  ];
  for (const { round, text } of cases) {
    const client = appClient({ flowRun: openRun({ round }) });
    await openFlowTab(client);

    expect(await screen.findByText(text)).toBeTruthy();
    cleanup();
  }
});

it("flow_run_banner_uses_paused_reviewer_count", async () => {
  const client = appClient({
    flowRun: openRun({
      status: "awaiting_decision",
      round: 5,
      nodes: [
        { id: "build", status: "done", visits: 3, result: "x" },
        { id: "review", status: "done", visits: 3, result: "y" },
        { id: "other", status: "done", visits: 5, result: "z" },
      ],
      decision: { reason: "rounds_exhausted", nodeId: "review" },
    }),
  });
  await openFlowTab(client);

  const banner = await screen.findByRole("alert");

  expect(
    within(banner).getByText("review still requests changes after 3 reviews."),
  ).toBeTruthy();
  expect(screen.getByText("Reviews: 5 (limit 2)")).toBeTruthy();
});

it("flow_run_stop_and_outcome_lines", async () => {
  const client = appClient({ flowRun: openRun() });
  client.respond("flow/stop", { stopped: true });
  await openFlowTab(client);

  expect(screen.queryByLabelText("Task")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Stop flow" }));
  await waitFor(() => {
    expect(requestsOf(client, "flow/stop")).toEqual([{}]);
  }, WAIT_OPTIONS);

  emitFlowRun(client, openRun({ status: "stopped" }));
  expect(await screen.findByText("Flow stopped.")).toBeTruthy();
  expect(taskField()).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop flow" })).toBeNull();

  emitFlowRun(client, openRun({ status: "done" }));
  expect(await screen.findByText("Flow finished.")).toBeTruthy();
  expect(screen.queryByText("Flow stopped.")).toBeNull();
});

it("flow_run_locks_editing_while_open", async () => {
  const list = makeFlowsList({
    flows: [makeFlow(), makeFlow({ id: "fix", file: "flows/fix.md" })],
  });
  const client = appClient({ list, flowRun: openRun() });
  await openFlowTab(client);
  await findGraphNode("build");

  const edit = screen.getByRole<HTMLButtonElement>("button", { name: "Edit" });
  expect(edit.disabled).toBe(true);
  expect(edit.title).toBe("Stop the flow to edit it.");
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", { name: "Flow" }).disabled,
  ).toBe(true);
  expect(document.querySelector(".flow-graph.editing")).toBeNull();

  emitFlowRun(client, openRun({ status: "done" }));
  await waitFor(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Edit" }).disabled,
    ).toBe(false);
  }, WAIT_OPTIONS);
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", { name: "Flow" }).disabled,
  ).toBe(false);
});

it("flow_graph_does_not_rerender_nodes_on_stream", async () => {
  const session = makeSession({
    cwd: SESSION_CWD,
    flowRef: { flowId: "ship", nodeId: "build" },
    turnInFlight: true,
  });
  const client = appClient({ session });
  await openFlowTabWithGraph(client);
  await findGraphNode("review");
  await expectNodeState("build", "working");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  const settled = handleRenders.count;

  emitSession(client, {
    ...session,
    messages: [makeMessage({ id: "m-1", text: "Working on it", seq: 1 })],
  });
  emitSession(client, {
    ...session,
    messages: [makeMessage({ id: "m-1", text: "Working on it now", seq: 1 })],
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  expect(handleRenders.count).toBe(settled);

  emitSession(client, {
    ...session,
    turnInFlight: false,
    lastTurn: { kind: "ended", stopReason: "end_turn" },
  });
  await expectNodeState("build", "done");
  expect(handleRenders.count).toBeGreaterThan(settled);
});

const RED_WAIT_OPTIONS = { timeout: 1500 } as const;

const ENDED_PHASES = [
  { phase: "stopped" },
  { phase: "failed", reason: "boom", runningAccountId: null },
  { phase: "halted" },
] as const;
const LIVE_MESSAGE = "End the current session to run a flow.";

it.each(ENDED_PHASES)(
  "flow_run_enabled_after_session_stopped_$phase",
  async (phase) => {
    const client = appClient();
    await openFlowTab(client);
    await pickFolder();
    emitSession(client, makeSession({ cwd: PICKED_CWD }));
    await screen.findByText(LIVE_MESSAGE, undefined, RED_WAIT_OPTIONS);
    typeTask("Do it");
    expect(runButton().disabled).toBe(true);

    emitSession(client, makeSession({ cwd: PICKED_CWD, phase }));

    await waitFor(() => {
      expect(runButton().disabled).toBe(false);
    }, RED_WAIT_OPTIONS);
    expect(screen.queryByText(LIVE_MESSAGE)).toBeNull();
  },
);

it("flow_tab_ignores_stopped_session_folder", async () => {
  const OTHER_CWD = "/home/user/other";
  window.codeweave = makeCodeweaveApi({
    pickFolder: vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(PICKED_CWD)
      .mockResolvedValueOnce(OTHER_CWD),
  });
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();

  emitSession(
    client,
    makeSession({ cwd: SESSION_CWD, phase: { phase: "stopped" } }),
  );

  const change = await screen.findByRole(
    "button",
    { name: "Change folder…" },
    RED_WAIT_OPTIONS,
  );
  expect(requestsOf(client, "flows/list")).toEqual([{ cwd: PICKED_CWD }]);
  fireEvent.click(change);
  await waitFor(() => {
    expect(requestsOf(client, "flows/list")).toEqual([
      { cwd: PICKED_CWD },
      { cwd: OTHER_CWD },
    ]);
  }, RED_WAIT_OPTIONS);
});

it("flow_tab_falls_back_to_ended_session_folder_when_none_picked", async () => {
  const client = appClient({
    session: makeSession({ cwd: SESSION_CWD, phase: { phase: "stopped" } }),
  });
  await openFlowTab(client);

  await waitFor(() => {
    expect(requestsOf(client, "flows/list")).toEqual([{ cwd: SESSION_CWD }]);
  }, RED_WAIT_OPTIONS);
  expect(
    screen.queryByText("Choose a project folder to see its flows."),
  ).toBeNull();
  await findGraphNode("build");
  expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
});

it("flow_tab_pins_folder_while_session_live_or_run_open", async () => {
  const live = appClient({ session: makeSession({ cwd: SESSION_CWD }) });
  await openFlowTabWithGraph(live);
  expect(requestsOf(live, "flows/list")).toEqual([{ cwd: SESSION_CWD }]);
  expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
  cleanup();

  const running = appClient({ flowRun: openRun() });
  await openFlowTabWithGraph(running);
  expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
});

it("flow_run_running_node_ignores_previous_session_state", async () => {
  const client = appClient({
    flowRun: openRun({
      round: 1,
      currentNodeId: "review",
      nodes: [
        { id: "build", status: "done", visits: 1, result: "Built it." },
        { id: "review", status: "running", visits: 1, result: null },
      ],
    }),
    session: runSession({
      phase: { phase: "failed", reason: "boom", runningAccountId: null },
      lastTurn: { kind: "failed", message: "boom" },
      turnInFlight: false,
    }),
  });
  await openFlowTab(client);
  await findGraphNode("review");

  await expectNodeState("review", "working", RED_WAIT_OPTIONS);
  await expectNodeState("build", "done");

  emitSession(
    client,
    runSession({
      flowRef: { flowId: "ship", nodeId: "review" },
      phase: { phase: "waiting", accountId: "acc-1", until: 1_900_000_000 },
    }),
  );
  await expectNodeState("review", "rate_limited");
});

it("flow_run_controls_survive_missing_flow", async () => {
  const client = appClient({
    flowRun: openRun({
      flowId: "gone",
      flowTitle: "Gone flow",
      status: "awaiting_decision",
      decision: { reason: "gate", nodeId: "review" },
    }),
  });
  client.respond("flow/stop", { stopped: true });
  client.respond("flow/decide", openRun());
  await openFlowTab(client);

  expect(
    await screen.findByText(
      "This flow is no longer on disk.",
      undefined,
      RED_WAIT_OPTIONS,
    ),
  ).toBeTruthy();
  expect(screen.getByText("Gone flow")).toBeTruthy();
  expect(screen.queryByLabelText("Task")).toBeNull();
  expect(graphNode("build")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => {
    expect(requestsOf(client, "flow/decide")).toEqual([
      { runId: "run-1", decision: "approve" },
    ]);
  }, RED_WAIT_OPTIONS);
  fireEvent.click(screen.getByRole("button", { name: "Stop flow" }));
  await waitFor(() => {
    expect(requestsOf(client, "flow/stop")).toEqual([{}]);
  }, RED_WAIT_OPTIONS);
});

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
}

async function startDraftWithNewNode(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const form = await screen.findByRole("form", { name: "Add node" });
  fireEvent.change(within(form).getByLabelText("Node id"), {
    target: { value: "docs" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Add node" }));
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  }, RED_WAIT_OPTIONS);
}

async function expectDraftKept(): Promise<void> {
  expect(saveButton().disabled).toBe(false);
  await findGraphNode("docs");
}

it("flow_edit_save_disabled_while_run_open", async () => {
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();
  await startDraftWithNewNode();

  emitFlowRun(client, openRun());

  await waitFor(() => {
    expect(saveButton().disabled).toBe(true);
  }, RED_WAIT_OPTIONS);
  expect(saveButton().title).toBe("Stop the flow to edit it.");
});

it("flow_edit_draft_survives_session_end_with_other_picked_folder", async () => {
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();
  emitSession(client, makeSession({ cwd: SESSION_CWD }));
  await waitFor(() => {
    expect(requestsOf(client, "flows/list")).toEqual([
      { cwd: PICKED_CWD },
      { cwd: SESSION_CWD },
    ]);
  }, RED_WAIT_OPTIONS);
  await findGraphNode("build");
  await startDraftWithNewNode();

  emitSession(
    client,
    makeSession({ cwd: SESSION_CWD, phase: { phase: "halted" } }),
  );

  await expectDraftKept();
  expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
});

it("flow_edit_draft_survives_session_start_in_other_folder", async () => {
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();
  await startDraftWithNewNode();

  emitSession(client, makeSession({ cwd: SESSION_CWD }));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  await expectDraftKept();
});

it("flow_tab_ignores_session_of_other_folder", async () => {
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();
  await startDraftWithNewNode();

  emitSession(
    client,
    makeSession({
      cwd: SESSION_CWD,
      flowRef: { flowId: "ship", nodeId: "build" },
      turnInFlight: true,
    }),
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  await expectDraftKept();
  expect(nodeState("build")).toBe("idle");
});

it("flow_tab_stays_on_ended_session_folder", async () => {
  const client = appClient();
  await openFlowTab(client);
  await pickFolder();
  emitSession(client, makeSession({ cwd: SESSION_CWD }));
  await waitFor(() => {
    expect(requestsOf(client, "flows/list")).toEqual([
      { cwd: PICKED_CWD },
      { cwd: SESSION_CWD },
    ]);
  }, RED_WAIT_OPTIONS);

  emitSession(
    client,
    makeSession({ cwd: SESSION_CWD, phase: { phase: "stopped" } }),
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  expect(requestsOf(client, "flows/list")).toEqual([
    { cwd: PICKED_CWD },
    { cwd: SESSION_CWD },
  ]);
  expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
});
