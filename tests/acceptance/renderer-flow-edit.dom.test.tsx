import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { EdgeKind } from "../../src/domain/types";
import { App } from "../../src/renderer/App";
import { FlowGraph } from "../../src/renderer/components/FlowGraph";
import { draftOf } from "../../src/renderer/flowDraft";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { FlowsList } from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeFlow,
  makeFlowsList,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const captured = vi.hoisted(() => ({
  props: null as ReactFlowProps | null,
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => {
      captured.props = props;
      return createElement(actual.ReactFlow, props);
    },
  };
});

const SESSION_CWD = "/home/user/project";
const WAIT_OPTIONS = { timeout: 5000 } as const;
const CONFLICT_TEXT =
  "This flow changed on disk. Reload to edit the latest version.";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function appClient(list: FlowsList = makeFlowsList()): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({ session: makeSession({ cwd: SESSION_CWD }) }),
  );
  client.respond("flows/list", list);
  return client;
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

async function openFlowTab(client: FakeIpcClient): Promise<void> {
  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));
  await findGraphNode("build");
}

async function startEditing(client: FakeIpcClient): Promise<void> {
  await openFlowTab(client);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("form", { name: "Add node" });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" });
}

function savedRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "flows/save")
    .map((request) => request.params);
}

function addNode(id: string, agent: string, provider: string): void {
  const form = screen.getByRole("form", { name: "Add node" });
  fireEvent.change(within(form).getByLabelText("Node id"), {
    target: { value: id },
  });
  fireEvent.change(within(form).getByLabelText("Agent"), {
    target: { value: agent },
  });
  fireEvent.change(within(form).getByLabelText("Provider"), {
    target: { value: provider },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Add node" }));
}

function addEdge(from: string, to: string, kind: string, gate: boolean): void {
  const form = screen.getByRole("form", { name: "Add edge" });
  fireEvent.change(within(form).getByLabelText("From"), {
    target: { value: from },
  });
  fireEvent.change(within(form).getByLabelText("To"), {
    target: { value: to },
  });
  fireEvent.change(within(form).getByLabelText("Kind"), {
    target: { value: kind },
  });
  if (gate) {
    fireEvent.click(within(form).getByLabelText("Gate"));
  }
  fireEvent.click(within(form).getByRole("button", { name: "Add edge" }));
}

it("flow_edit_adds_node_and_saves_wire_flow", async () => {
  const client = appClient();
  const saved = makeFlow({
    revision: "rev-2",
    nodes: [
      { id: "build", agent: "implementer", provider: null, taskClass: null },
      { id: "review", agent: "reviewer", provider: null, taskClass: null },
      { id: "docs", agent: "reviewer", provider: "codex", taskClass: null },
    ],
  });
  client.respond("flows/save", makeFlowsList({ flows: [saved] }));
  await startEditing(client);

  const form = screen.getByRole("form", { name: "Add node" });
  const providerSelect = within(form).getByLabelText("Provider");
  expect((providerSelect as HTMLSelectElement).options[0]?.textContent).toBe(
    "Agent default (Claude)",
  );
  expect(saveButton().disabled).toBe(true);

  addNode("docs", "reviewer", "codex");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 2,
          nodes: [
            { id: "build", agent: "implementer" },
            { id: "review", agent: "reviewer" },
            { id: "docs", agent: "reviewer", provider: "codex" },
          ],
          edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
        },
      },
    ]);
  }, WAIT_OPTIONS);
  await screen.findByRole("button", { name: "Edit" }, WAIT_OPTIONS);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(await findGraphNode("docs")).toBeTruthy();
});

it("flow_edit_removes_node_and_its_edges", async () => {
  const client = appClient();
  client.respond(
    "flows/save",
    makeFlowsList({
      flows: [
        makeFlow({
          revision: "rev-2",
          nodes: [
            {
              id: "build",
              agent: "implementer",
              provider: null,
              taskClass: null,
            },
          ],
          edges: [],
        }),
      ],
    }),
  );
  await startEditing(client);

  fireEvent.click(await findGraphNode("review"));
  fireEvent.click(await screen.findByRole("button", { name: "Remove node" }));
  await waitFor(() => {
    expect(graphNode("review")).toBeNull();
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 2,
          nodes: [{ id: "build", agent: "implementer" }],
          edges: [],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_edit_adds_edge_with_kind_and_gate_via_form", async () => {
  const client = appClient();
  client.respond("flows/save", makeFlowsList());
  await startEditing(client);

  addEdge("review", "build", EdgeKind.reviews, true);
  await waitFor(() => {
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(2);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 2,
          nodes: [
            { id: "build", agent: "implementer" },
            { id: "review", agent: "reviewer" },
          ],
          edges: [
            { from: "build", to: "review", kind: "hands_off_to" },
            { from: "review", to: "build", kind: "reviews", gate: true },
          ],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_edit_changes_agent_and_provider", async () => {
  const client = appClient();
  client.respond("flows/save", makeFlowsList());
  await startEditing(client);

  fireEvent.click(await findGraphNode("build"));
  const panel = await screen.findByRole("region", { name: "Node build" });
  fireEvent.change(within(panel).getByLabelText("Agent"), {
    target: { value: "reviewer" },
  });
  fireEvent.change(within(panel).getByLabelText("Provider"), {
    target: { value: "gemini" },
  });
  await waitFor(() => {
    expect(
      within(graphNode("build") ?? document.body).getByText("custom"),
    ).toBeTruthy();
  }, WAIT_OPTIONS);
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 2,
          nodes: [
            {
              id: "build",
              agent: "reviewer",
              provider: "gemini",
            },
            { id: "review", agent: "reviewer" },
          ],
          edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_edit_sets_max_rounds", async () => {
  const client = appClient();
  client.respond("flows/save", makeFlowsList());
  await startEditing(client);

  fireEvent.change(screen.getByLabelText("Max rounds"), {
    target: { value: "5" },
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 5,
          nodes: [
            { id: "build", agent: "implementer" },
            { id: "review", agent: "reviewer" },
          ],
          edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_edit_invalid_draft_disables_save_and_lists_errors", async () => {
  const client = appClient(
    makeFlowsList({
      flows: [
        makeFlow({
          nodes: [
            {
              id: "build",
              agent: "implementer",
              provider: null,
              taskClass: null,
            },
            { id: "review", agent: "ghost", provider: null, taskClass: null },
          ],
        }),
      ],
    }),
  );
  await startEditing(client);

  expect(
    await screen.findByText('Node "review" uses unknown agent "ghost"'),
  ).toBeTruthy();
  expect(saveButton().disabled).toBe(true);

  addNode("build", "implementer", "");
  expect(
    await screen.findByText('Node id "build" already exists'),
  ).toBeTruthy();

  addEdge("review", "build", EdgeKind.handsOffTo, false);
  expect(
    await screen.findByText("Cycle in flow order: build -> review -> build"),
  ).toBeTruthy();
  expect(saveButton().disabled).toBe(true);

  fireEvent.click(saveButton());
  expect(savedRequests(client)).toEqual([]);
});

it("flow_edit_conflict_keeps_draft_and_offers_reload", async () => {
  const client = appClient();
  client.on("flows/save", () => {
    throw new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch");
  });
  await startEditing(client);

  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  expect(await screen.findByText(CONFLICT_TEXT, {}, WAIT_OPTIONS)).toBeTruthy();
  expect(graphNode("docs")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

  client.respond(
    "flows/list",
    makeFlowsList({
      flows: [makeFlow({ revision: "rev-9", title: "Ship it v9" })],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));

  await screen.findByRole("button", { name: "Edit" }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(graphNode("docs")).toBeNull();
  }, WAIT_OPTIONS);
  expect(screen.queryByText(CONFLICT_TEXT)).toBeNull();
  expect(
    client.requests.filter((request) => request.method === "flows/list"),
  ).toHaveLength(2);
});

it("flow_edit_discard_restores_read_only_graph", async () => {
  const client = appClient();
  await startEditing(client);

  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));

  await screen.findByRole("button", { name: "Edit" }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(graphNode("docs")).toBeNull();
  }, WAIT_OPTIONS);
  expect(screen.queryByRole("form", { name: "Add node" })).toBeNull();
  expect(savedRequests(client)).toEqual([]);
});

async function renderEditableGraph(): Promise<{
  onDraftChange: ReturnType<typeof vi.fn>;
  onSelectionChange: ReturnType<typeof vi.fn>;
  props: ReactFlowProps;
}> {
  const onDraftChange = vi.fn();
  const onSelectionChange = vi.fn();
  const flow = makeFlow();
  render(
    <FlowGraph
      editable
      flow={flow}
      agents={makeFlowsList().agents}
      session={null}
      draft={draftOf(flow)}
      selection={null}
      onDraftChange={onDraftChange}
      onSelectionChange={onSelectionChange}
      onOpenSession={vi.fn()}
    />,
  );
  await findGraphNode("build");
  if (captured.props === null) {
    throw new Error("ReactFlow was not rendered");
  }
  return { onDraftChange, onSelectionChange, props: captured.props };
}

it("flow_graph_connect_adds_hands_off_edge", async () => {
  const { onDraftChange, onSelectionChange, props } =
    await renderEditableGraph();

  props.onConnect?.({
    source: "review",
    target: "build",
    sourceHandle: null,
    targetHandle: null,
  });

  expect(onDraftChange).toHaveBeenCalledWith({
    id: "ship",
    title: "Ship it",
    maxRounds: 2,
    nodes: [
      { id: "build", agent: "implementer", provider: null, taskClass: null },
      { id: "review", agent: "reviewer", provider: null, taskClass: null },
    ],
    edges: [
      { from: "build", to: "review", kind: "hands_off_to", gate: false },
      { from: "review", to: "build", kind: "hands_off_to", gate: false },
    ],
  });
  expect(onSelectionChange).toHaveBeenCalledWith({
    kind: "edge",
    key: "review->build:hands_off_to",
  });
});

it("flow_graph_connect_ignores_self_and_duplicate_edges", async () => {
  const { onDraftChange, props } = await renderEditableGraph();

  props.onConnect?.({
    source: "build",
    target: "build",
    sourceHandle: null,
    targetHandle: null,
  });
  props.onConnect?.({
    source: "build",
    target: "review",
    sourceHandle: null,
    targetHandle: null,
  });

  expect(onDraftChange).not.toHaveBeenCalled();
});

it("flow_graph_delete_removes_selected_node_and_clears_selection", async () => {
  const { onDraftChange, onSelectionChange, props } =
    await renderEditableGraph();

  props.onDelete?.({
    nodes: [{ id: "review", position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  });

  expect(onDraftChange).toHaveBeenCalledWith({
    id: "ship",
    title: "Ship it",
    maxRounds: 2,
    nodes: [
      { id: "build", agent: "implementer", provider: null, taskClass: null },
    ],
    edges: [],
  });
  expect(onSelectionChange).toHaveBeenCalledWith(null);
});

it("flow_graph_read_only_disables_connect_and_delete", async () => {
  render(
    <FlowGraph
      flow={makeFlow()}
      agents={makeFlowsList().agents}
      session={null}
      onOpenSession={vi.fn()}
    />,
  );
  await findGraphNode("build");

  expect(captured.props?.nodesConnectable).toBe(false);
  expect(captured.props?.deleteKeyCode).toBeNull();
  expect(captured.props?.onConnect).toBeUndefined();
  expect(captured.props?.onDelete).toBeUndefined();
});

const ROUNDS_TEXT = "Max rounds must be a whole number from 1 to 10";

function isDisabled(element: HTMLElement): boolean {
  return element.matches(":disabled");
}

it("flow_edit_disables_editing_while_save_pending", async () => {
  const client = appClient();
  const reply = Promise.withResolvers<FlowsList>();
  client.on("flows/save", () => reply.promise);
  await startEditing(client);

  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toHaveLength(1);
  }, WAIT_OPTIONS);
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(isDisabled(within(inspector).getByLabelText("Max rounds"))).toBe(true);
  const form = within(inspector).getByRole("form", { name: "Add node" });
  expect(
    isDisabled(within(form).getByRole("button", { name: "Add node" })),
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Discard" }).disabled,
  ).toBe(true);
  expect(saveButton().disabled).toBe(true);
  expect(captured.props?.nodesConnectable).toBe(false);
  expect(captured.props?.deleteKeyCode).toBeNull();
  expect(captured.props?.onConnect).toBeUndefined();
  expect(captured.props?.onDelete).toBeUndefined();

  reply.resolve(makeFlowsList());
  await screen.findByRole("button", { name: "Edit" }, WAIT_OPTIONS);
});

it("flow_edit_disabled_while_reloading", async () => {
  const client = appClient();
  client.on("flows/save", () => {
    throw new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch");
  });
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());
  await screen.findByText(CONFLICT_TEXT, {}, WAIT_OPTIONS);

  const reply = Promise.withResolvers<FlowsList>();
  client.on("flows/list", () => reply.promise);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));

  const edit = await screen.findByRole(
    "button",
    { name: "Edit" },
    WAIT_OPTIONS,
  );
  expect((edit as HTMLButtonElement).disabled).toBe(true);

  reply.resolve(makeFlowsList({ flows: [makeFlow({ revision: "rev-9" })] }));
  await waitFor(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Edit" }).disabled,
    ).toBe(false);
  }, WAIT_OPTIONS);
});

it("flow_edit_stale_draft_after_reload_sends_base_revision", async () => {
  const client = appClient();
  client.on("flows/save", () => {
    throw new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch");
  });
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");

  fireEvent.click(screen.getByRole("tab", { name: "Session" }));
  client.respond(
    "flows/list",
    makeFlowsList({ flows: [makeFlow({ revision: "rev-new" })] }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  await findGraphNode("build");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await screen.findByText(CONFLICT_TEXT, {}, WAIT_OPTIONS);
  expect(savedRequests(client)).toEqual([
    {
      cwd: SESSION_CWD,
      file: "flows/ship.md",
      revision: "rev-1",
      flow: {
        id: "ship",
        title: "Ship it",
        maxRounds: 2,
        nodes: [
          { id: "build", agent: "implementer" },
          { id: "review", agent: "reviewer" },
          { id: "docs", agent: "reviewer" },
        ],
        edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
      },
    },
  ]);
});

it("flow_edit_draft_survives_tab_switch", async () => {
  const client = appClient();
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  fireEvent.change(screen.getByLabelText("Max rounds"), {
    target: { value: "4" },
  });

  fireEvent.click(screen.getByRole("tab", { name: "Session" }));
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));

  await findGraphNode("build");
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(saveButton()).toBeTruthy();
  await findGraphNode("docs");
  expect(screen.getByLabelText<HTMLInputElement>("Max rounds").value).toBe("4");
});

it("flow_edit_max_rounds_accepts_clear_and_retype", async () => {
  const client = appClient();
  client.respond("flows/save", makeFlowsList());
  await startEditing(client);
  const input = screen.getByLabelText<HTMLInputElement>("Max rounds");

  fireEvent.change(input, { target: { value: "" } });
  expect(input.value).toBe("");
  expect(screen.getByText(ROUNDS_TEXT)).toBeTruthy();
  expect(saveButton().disabled).toBe(true);

  fireEvent.change(input, { target: { value: "5" } });
  expect(input.value).toBe("5");
  expect(screen.queryByText(ROUNDS_TEXT)).toBeNull();
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 5,
          nodes: [
            { id: "build", agent: "implementer" },
            { id: "review", agent: "reviewer" },
          ],
          edges: [{ from: "build", to: "review", kind: "hands_off_to" }],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

it("flow_edit_max_rounds_out_of_range_disables_save_and_resets_on_blur", async () => {
  const client = appClient();
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  const input = screen.getByLabelText<HTMLInputElement>("Max rounds");

  fireEvent.change(input, { target: { value: "99" } });
  expect(screen.getByText(ROUNDS_TEXT)).toBeTruthy();
  expect(saveButton().disabled).toBe(true);

  fireEvent.blur(input);
  expect(input.value).toBe("2");
  expect(screen.queryByText(ROUNDS_TEXT)).toBeNull();
  expect(saveButton().disabled).toBe(false);
});

it("flow_graph_edge_selection_edits_kind_gate_and_removes", async () => {
  const client = appClient();
  client.respond("flows/save", makeFlowsList());
  await startEditing(client);

  const edge = await waitFor(() => {
    const found = document.querySelector(".react-flow__edge");
    if (found === null) {
      throw new Error("Graph edge is not rendered");
    }
    return found;
  }, WAIT_OPTIONS);
  fireEvent.click(edge);
  const panel = await screen.findByRole("region", {
    name: "Edge build->review:hands_off_to",
  });
  fireEvent.change(within(panel).getByLabelText("Kind"), {
    target: { value: EdgeKind.reviews },
  });
  const reviewsPanel = await screen.findByRole("region", {
    name: "Edge build->review:reviews",
  });
  fireEvent.click(within(reviewsPanel).getByLabelText("Gate"));
  expect(
    within(reviewsPanel).getByLabelText<HTMLInputElement>("Gate").checked,
  ).toBe(true);

  fireEvent.click(
    within(reviewsPanel).getByRole("button", { name: "Remove edge" }),
  );
  await waitFor(() => {
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(0);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());

  await waitFor(() => {
    expect(savedRequests(client)).toEqual([
      {
        cwd: SESSION_CWD,
        file: "flows/ship.md",
        revision: "rev-1",
        flow: {
          id: "ship",
          title: "Ship it",
          maxRounds: 2,
          nodes: [
            { id: "build", agent: "implementer" },
            { id: "review", agent: "reviewer" },
          ],
          edges: [],
        },
      },
    ]);
  }, WAIT_OPTIONS);
});

const SETTLE_OPTIONS = { timeout: 1000 } as const;

async function startSaveAndSelectNode(
  client: FakeIpcClient,
  reply: PromiseWithResolvers<FlowsList>,
): Promise<void> {
  client.on("flows/save", () => reply.promise);
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  await waitFor(() => {
    expect(saveButton().disabled).toBe(false);
  });
  fireEvent.click(saveButton());
  await waitFor(() => {
    expect(savedRequests(client)).toHaveLength(1);
  }, WAIT_OPTIONS);
  fireEvent.click(await findGraphNode("review"));
  await screen.findByRole("region", { name: "Node review" }, WAIT_OPTIONS);
}

it("flow_edit_selection_during_save_still_leaves_edit_mode", async () => {
  const client = appClient();
  const reply = Promise.withResolvers<FlowsList>();
  await startSaveAndSelectNode(client, reply);

  reply.resolve(
    makeFlowsList({ flows: [makeFlow({ revision: "rev-2", title: "Saved" })] }),
  );

  await screen.findByRole("button", { name: "Edit" }, SETTLE_OPTIONS);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("flow_edit_selection_during_save_still_shows_conflict", async () => {
  const client = appClient();
  const reply = Promise.withResolvers<FlowsList>();
  await startSaveAndSelectNode(client, reply);

  reply.reject(new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch"));

  await screen.findByText(CONFLICT_TEXT, {}, SETTLE_OPTIONS);
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
});

const MISSING_FLOW_TEXT = "This flow is no longer on disk.";

async function editThenReloadWith(
  client: FakeIpcClient,
  list: FlowsList,
): Promise<void> {
  await startEditing(client);
  addNode("docs", "reviewer", "");
  await findGraphNode("docs");
  fireEvent.click(screen.getByRole("tab", { name: "Session" }));
  client.respond("flows/list", list);
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  await screen.findByText(MISSING_FLOW_TEXT, {}, SETTLE_OPTIONS);
}

it("flow_edit_missing_flow_after_reload_offers_discard", async () => {
  const client = appClient(
    makeFlowsList({
      flows: [
        makeFlow(),
        makeFlow({
          id: "other",
          file: "flows/other.md",
          title: "Other flow",
          nodes: [
            {
              id: "solo",
              agent: "implementer",
              provider: null,
              taskClass: null,
            },
          ],
          edges: [],
        }),
      ],
    }),
  );
  const remaining = makeFlow({
    id: "other",
    file: "flows/other.md",
    title: "Other flow",
    nodes: [
      { id: "solo", agent: "implementer", provider: null, taskClass: null },
    ],
    edges: [],
  });
  await editThenReloadWith(client, makeFlowsList({ flows: [remaining] }));

  expect(saveButton().disabled).toBe(true);
  expect(screen.queryByText("Other flow")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Discard" }));

  await findGraphNode("solo");
  expect(screen.queryByText(MISSING_FLOW_TEXT)).toBeNull();
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
});

it("flow_edit_missing_last_flow_keeps_discard", async () => {
  const client = appClient();
  await editThenReloadWith(client, makeFlowsList({ flows: [] }));

  expect(saveButton().disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Discard" }));

  await screen.findByText("No flows found in this folder.", {}, WAIT_OPTIONS);
  expect(screen.queryByText(MISSING_FLOW_TEXT)).toBeNull();
});
