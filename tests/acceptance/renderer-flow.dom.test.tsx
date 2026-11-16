import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  parseAgentDocuments,
  parseFlowFile,
  type ParseResult,
} from "../../src/domain/flows";
import { App } from "../../src/renderer/App";
import { FlowGraph } from "../../src/renderer/components/FlowGraph";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import type { AgentView, FlowView, SessionView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAgent,
  makeFlow,
  makeFlowsList,
  makePermission,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const PICKED_FOLDER = "/home/user/picked";
const SESSION_CWD = "/home/user/project";
const WAIT_OPTIONS = { timeout: 5000 } as const;

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.value;
}

function exampleFlow(): FlowView {
  const { id, title, nodes, edges } = unwrap(
    parseFlowFile(readFileSync(join(ROOT_DIR, "flows", "example.md"), "utf8")),
  );
  return makeFlow({
    id,
    title,
    nodes: nodes.map((node) => ({ ...node, provider: null })),
    edges: edges.map((edge) => ({ ...edge, gate: false })),
  });
}

function exampleAgents(): AgentView[] {
  return unwrap(
    parseAgentDocuments(
      readFileSync(join(ROOT_DIR, "agents", "example.md"), "utf8"),
    ),
  ).map(({ definition: { id, role, provider, permissionProfile }, body }) => ({
    id,
    role,
    provider,
    permissionProfile,
    body,
  }));
}

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_FOLDER),
  });
});

afterEach(cleanup);

function appClient(
  session: SessionView | null = makeSession({ cwd: SESSION_CWD }),
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond("sessions/snapshot", makeSnapshot({ session }));
  return client;
}

async function findNode(id: string): Promise<HTMLElement> {
  const label = await screen.findByText(id, {}, WAIT_OPTIONS);
  const node = label.closest<HTMLElement>(".react-flow__node");
  if (node === null) {
    throw new Error(`Node ${id} is not inside a flow node`);
  }
  return node;
}

it("flow_graph_renders_example_nodes_edges_and_opens_session", async () => {
  const onOpenSession = vi.fn();
  const session = makeSession({
    flowRef: { flowId: "implement-and-review", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={exampleFlow()}
      agents={exampleAgents()}
      session={session}
      onOpenSession={onOpenSession}
    />,
  );

  const build = await findNode("build");
  const review = await findNode("review");
  expect(
    within(build).getByText(
      "Implements the planned change and keeps the tests green",
    ),
  ).toBeTruthy();
  expect(
    within(review).getByText("Reviews the diff for bugs and reports findings"),
  ).toBeTruthy();
  expect(
    await screen.findByText("hands off to", {}, WAIT_OPTIONS),
  ).toBeTruthy();
  expect(await screen.findByText("reviews", {}, WAIT_OPTIONS)).toBeTruthy();
  expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(2);

  fireEvent.click(review);
  expect(onOpenSession).not.toHaveBeenCalled();
  fireEvent.click(build);
  expect(onOpenSession).toHaveBeenCalledTimes(1);
});

it("flow_graph_hides_attribution_and_draws_background", async () => {
  render(
    <FlowGraph
      flow={exampleFlow()}
      agents={exampleAgents()}
      session={null}
      onOpenSession={vi.fn()}
    />,
  );

  await findNode("build");
  expect(document.querySelector(".react-flow__attribution")).toBeNull();
  const background = document.querySelector(".react-flow__background");
  expect(background).not.toBeNull();
  expect(background?.querySelector("circle")).not.toBeNull();
});

it("flow_graph_session_node_shows_rate_limited_while_waiting", async () => {
  const session = makeSession({
    phase: { phase: "waiting", accountId: "acc-1", until: 99 },
    turnInFlight: true,
    flowRef: { flowId: "ship", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={session}
      onOpenSession={vi.fn()}
    />,
  );

  const build = await findNode("build");
  const review = await findNode("review");
  expect(within(build).getByText("Rate limited")).toBeTruthy();
  expect(within(review).getByText("Idle")).toBeTruthy();
});

it("flow_graph_shows_permission_state_for_pending_permission", async () => {
  const session = makeSession({
    permissions: [makePermission()],
    flowRef: { flowId: "ship", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={session}
      onOpenSession={vi.fn()}
    />,
  );

  expect(
    within(await findNode("build")).getByText("Needs approval"),
  ).toBeTruthy();
});

it("flow_graph_ignores_session_bound_to_another_flow", async () => {
  const onOpenSession = vi.fn();
  const session = makeSession({
    turnInFlight: true,
    flowRef: { flowId: "other", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={session}
      onOpenSession={onOpenSession}
    />,
  );

  const build = await findNode("build");
  expect(within(build).getByText("Idle")).toBeTruthy();
  fireEvent.click(build);
  expect(onOpenSession).not.toHaveBeenCalled();
});

it("flow_graph_animates_edges_leaving_a_working_node", async () => {
  const session = makeSession({
    turnInFlight: true,
    flowRef: { flowId: "ship", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={session}
      onOpenSession={vi.fn()}
    />,
  );

  await findNode("build");
  await waitFor(() => {
    expect(
      document.querySelectorAll(".react-flow__edge.animated"),
    ).toHaveLength(1);
  }, WAIT_OPTIONS);
});

it("flow_graph_shows_working_after_failed_turn", async () => {
  const session = makeSession({
    lastTurn: { kind: "failed", message: "boom" },
    turnInFlight: true,
    flowRef: { flowId: "ship", nodeId: "build" },
  });

  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={session}
      onOpenSession={vi.fn()}
    />,
  );

  expect(within(await findNode("build")).getByText("Working")).toBeTruthy();
  await waitFor(() => {
    expect(
      document.querySelectorAll(".react-flow__edge.animated"),
    ).toHaveLength(1);
  }, WAIT_OPTIONS);
});

it("flow_graph_does_not_animate_edges_when_nothing_works", async () => {
  render(
    <FlowGraph
      flow={makeFlow()}
      agents={[makeAgent()]}
      session={null}
      onOpenSession={vi.fn()}
    />,
  );

  await findNode("build");
  await screen.findByText("hands off to", {}, WAIT_OPTIONS);
  expect(document.querySelectorAll(".react-flow__edge.animated")).toHaveLength(
    0,
  );
});

it("app_flow_tab_opens_session_tab_on_session_node_click", async () => {
  const client = appClient(
    makeSession({
      cwd: SESSION_CWD,
      flowRef: { flowId: "ship", nodeId: "build" },
    }),
  );
  client.respond("flows/list", makeFlowsList());

  renderWithServices(<App />, client);
  const sessionTab = await screen.findByRole("tab", { name: "Session" });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));

  const build = await findNode("build");
  expect(
    screen.getByRole("tab", { name: "Flow" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    client.requests.filter((request) => request.method === "flows/list"),
  ).toEqual([{ method: "flows/list", params: { cwd: SESSION_CWD } }]);
  fireEvent.click(build);

  await waitFor(() => {
    expect(
      screen
        .getByRole("tab", { name: "Session" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
  expect(screen.getByRole("region", { name: "Session" })).toBeTruthy();
});

it("flow_tab_without_session_asks_to_start_one", async () => {
  const client = appClient(null);
  client.respond("sessions/snapshot", makeSnapshot());

  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));

  expect(
    await screen.findByText("Start a session to see its flows."),
  ).toBeTruthy();
  expect(
    client.requests.some((request) => request.method === "flows/list"),
  ).toBe(false);
});

it("flow_tab_lists_file_errors", async () => {
  const client = appClient();
  client.respond(
    "flows/list",
    makeFlowsList({
      errors: [
        { file: "flows/bad.md", messages: ["Missing YAML frontmatter"] },
        {
          file: "agents/x.md",
          messages: ["Agent 1: id: Required", "Agent 2: role: Required"],
        },
      ],
    }),
  );

  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));

  expect(
    await screen.findByText(
      "Could not read flows/bad.md: Missing YAML frontmatter",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Could not read agents/x.md: Agent 1: id: Required; Agent 2: role: Required",
    ),
  ).toBeTruthy();
});

it("flow_tab_switches_between_flows_with_picker", async () => {
  const client = appClient();
  client.respond(
    "flows/list",
    makeFlowsList({
      flows: [
        makeFlow(),
        makeFlow({
          id: "solo",
          title: "Solo run",
          nodes: [{ id: "alone", agent: "implementer", provider: null }],
          edges: [],
        }),
      ],
    }),
  );

  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));
  await findNode("build");
  fireEvent.change(screen.getByRole("combobox", { name: "Flow" }), {
    target: { value: "solo" },
  });

  await findNode("alone");
  expect(screen.queryByText("build")).toBeNull();
});

it("flow_tab_shows_request_failure", async () => {
  const client = appClient();
  client.fail("flows/list", new Error("backend exploded"));

  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));

  expect(await screen.findByText("backend exploded")).toBeTruthy();
});

it("flow_tab_reports_when_no_flows_exist", async () => {
  const client = appClient();
  client.respond("flows/list", { flows: [], agents: [], errors: [] });

  renderWithServices(<App />, client);
  fireEvent.click(await screen.findByRole("tab", { name: "Flow" }));

  expect(
    await screen.findByText("No flows found in this folder."),
  ).toBeTruthy();
});

function startPromptClient(list = makeFlowsList()): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", makeSnapshot());
  client.respond("flows/list", list);
  client.respond("session/start", makeSession({ cwd: PICKED_FOLDER }));
  return client;
}

function startRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "session/start")
    .map((request) => request.params);
}

it("start_prompt_sends_flow_ref_for_chosen_node", async () => {
  const client = startPromptClient();
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );
  const select = await screen.findByRole("combobox", { name: "Flow node" });
  expect(
    within(select)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["None", "Ship it / build", "Ship it / review"]);
  const review = screen.getByRole<HTMLOptionElement>("option", {
    name: "Ship it / review",
  });
  fireEvent.change(select, { target: { value: review.value } });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));

  await waitFor(() => {
    expect(startRequests(client)).toEqual([
      { cwd: PICKED_FOLDER, flowRef: { flowId: "ship", nodeId: "review" } },
    ]);
  });
  expect(
    client.requests.find((r) => r.method === "flows/list")?.params,
  ).toEqual({
    cwd: PICKED_FOLDER,
  });
});

it("start_prompt_omits_flow_ref_for_none", async () => {
  const client = startPromptClient();
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );
  await screen.findByRole("combobox", { name: "Flow node" });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));

  await waitFor(() => {
    expect(startRequests(client)).toEqual([{ cwd: PICKED_FOLDER }]);
  });
});

it("start_prompt_starts_right_away_without_flows", async () => {
  const client = startPromptClient({ flows: [], agents: [], errors: [] });
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(startRequests(client)).toEqual([{ cwd: PICKED_FOLDER }]);
  });
  expect(screen.queryByRole("combobox", { name: "Flow node" })).toBeNull();
});

it("start_prompt_starts_right_away_when_flow_listing_fails", async () => {
  const client = startPromptClient();
  client.fail("flows/list", new Error("no access"));
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(startRequests(client)).toEqual([{ cwd: PICKED_FOLDER }]);
  });
});

it("start_prompt_no_duplicate_key_warning", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const client = startPromptClient(
    makeFlowsList({
      flows: [makeFlow(), makeFlow({ id: "ship-copy" })],
    }),
  );
  renderWithServices(<SessionStream />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );
  await screen.findByRole("combobox", { name: "Flow node" });

  const warnings = errors.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes("same key")),
  );
  errors.mockRestore();
  expect(warnings).toEqual([]);
});
