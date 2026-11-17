import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ApiProviderId } from "../../src/domain/apiProviders";
import { PermissionProfile, ProviderId } from "../../src/domain/types";
import { App } from "../../src/renderer/App";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AgentView, FlowsList } from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAgent,
  makeCatalogModel,
  makeFlowsList,
  makeSession,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const CWD = "/home/user/project";
const WAIT_OPTIONS = { timeout: 5000 } as const;
const CONFLICT_TEXT =
  "This agent file changed on disk. Reload to edit the latest version.";
const UNKNOWN_MODEL_TEXT = "This model is not in the OpenCode catalog.";
const UNKNOWN_PROVIDER_TEXT =
  "The part before the first / is not a known API provider.";
const QUALIFIED_MODEL = "groq/llama-3.3-70b";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function listOf(agents: AgentView[]): FlowsList {
  return makeFlowsList({ agents });
}

const IMPLEMENTER = makeAgent();
const REVIEWER = makeAgent({
  id: "reviewer",
  file: "agents/reviewer.md",
  revision: "agent-rev-2",
  role: "Reviews diffs",
  provider: ProviderId.codex,
  permissionProfile: PermissionProfile.acceptEdits,
  body: "Reviews the change.",
});

function appClient(
  agents: AgentView[] = [IMPLEMENTER, REVIEWER],
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({ session: makeSession({ cwd: CWD }) }),
  );
  client.respond("flows/list", listOf(agents));
  return client;
}

async function showAgentsTab(client: FakeIpcClient): Promise<void> {
  renderWithServices(<App />, client);
  await screen.findByRole("tab", { name: "Session" });
  expect(screen.queryByRole("tab", { name: "Agents" })).not.toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
  await screen.findByRole("button", { name: "New agent" });
}

async function openAgent(id: string): Promise<void> {
  const list = await screen.findByRole("list", { name: "Agents" });
  const row = await within(list).findByRole("button", {
    name: new RegExp(`^${id}\\b`),
  });
  fireEvent.click(row);
  await waitFor(() => {
    expect(textbox("Id").value).toBe(id);
  }, WAIT_OPTIONS);
}

async function openAgentsTab(client: FakeIpcClient, id: string): Promise<void> {
  await showAgentsTab(client);
  await openAgent(id);
}

function textbox(name: string): HTMLInputElement | HTMLTextAreaElement {
  const element = screen.getByLabelText(name);
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`${name} is not a text field`);
  }
  return element;
}

function select(name: string): HTMLSelectElement {
  const element = screen.getByLabelText(name);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`${name} is not a select`);
  }
  return element;
}

function type(name: string, value: string): void {
  fireEvent.change(textbox(name), { target: { value } });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name });
}

function requestsOf(client: FakeIpcClient, method: string): unknown[] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

function listText(): string {
  return screen.getByRole("list", { name: "Agents" }).textContent;
}

it("agents_tab_lists_agents_and_opens_one", async () => {
  const detailed = makeAgent({
    model: "sonnet",
    taskClass: "heavy",
    body: "Line one.\nLine two.",
  });
  const client = appClient([detailed, REVIEWER]);
  await showAgentsTab(client);

  const names = within(screen.getByRole("list", { name: "Agents" }));
  expect(names.getByText("implementer")).toBeTruthy();
  expect(names.getByText("Reviews diffs")).toBeTruthy();
  expect(names.getByText("Codex")).toBeTruthy();

  await openAgent("implementer");

  expect(textbox("Role").value).toBe("Implements the planned change");
  expect(select("Provider").value).toBe("claude");
  expect(textbox("Model").value).toBe("sonnet");
  expect(select("Permission profile").value).toBe("plan");
  expect(select("Task class").value).toBe("heavy");
  expect(textbox("Instructions").value).toBe("Line one.\nLine two.");
  expect(button("Save").disabled).toBe(true);
});

it("agent_form_offers_the_three_task_classes_and_an_empty_choice", async () => {
  await openAgentsTab(appClient(), "implementer");

  const options = [...select("Task class").options].map((option) => [
    option.value,
    option.textContent,
  ]);

  expect(options).toEqual([
    ["", "—"],
    ["light", "light"],
    ["standard", "standard"],
    ["heavy", "heavy"],
  ]);
});

it("edit_and_save_sends_params_and_stays_on_saved_agent", async () => {
  const client = appClient();
  const saved = makeAgent({
    role: "New role",
    revision: "agent-rev-9",
    body: "New body",
  });
  client.respond("agents/save", listOf([saved, REVIEWER]));
  await openAgentsTab(client, "implementer");

  type("Role", "New role");
  type("Instructions", "New body");
  fireEvent.click(button("Save"));

  await waitFor(() => {
    expect(requestsOf(client, "agents/save")).toEqual([
      {
        cwd: CWD,
        file: "agents/implementer.md",
        revision: "agent-rev-1",
        id: "implementer",
        agent: {
          id: "implementer",
          role: "New role",
          provider: "claude",
          permissionProfile: "plan",
        },
        body: "New body",
      },
    ]);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(listText()).toContain("New role");
  }, WAIT_OPTIONS);
  expect(textbox("Id").value).toBe("implementer");
  expect(textbox("Role").value).toBe("New role");
  expect(button("Save").disabled).toBe(true);
});

it("validation_errors_disable_save", async () => {
  const client = appClient();
  await openAgentsTab(client, "implementer");

  type("Id", "bad id");
  expect(
    screen.getByText(
      "Agent id must start with a letter or digit and contain only letters, digits, _ and -",
    ),
  ).toBeTruthy();
  expect(button("Save").disabled).toBe(true);

  type("Id", "REVIEWER");
  expect(
    screen.getByText('Agent id "REVIEWER" is already used by another agent'),
  ).toBeTruthy();
  expect(button("Save").disabled).toBe(true);

  type("Id", "implementer");
  type("Role", "   ");
  expect(screen.getByText("Role must not be blank")).toBeTruthy();
  expect(button("Save").disabled).toBe(true);

  type("Role", "Fine role");
  type("Instructions", "before\n---\nafter");
  expect(
    screen.getByText(
      'Instructions must not contain a line that is exactly "---"',
    ),
  ).toBeTruthy();
  expect(button("Save").disabled).toBe(true);

  type("Instructions", "clean body");
  expect(button("Save").disabled).toBe(false);
  expect(requestsOf(client, "agents/save")).toEqual([]);
});

it("conflict_shows_reload_banner_and_keeps_draft", async () => {
  const client = appClient();
  client.fail(
    "agents/save",
    new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch"),
  );
  await openAgentsTab(client, "implementer");

  type("Role", "My draft role");
  fireEvent.click(button("Save"));

  expect(await screen.findByText(CONFLICT_TEXT, {}, WAIT_OPTIONS)).toBeTruthy();
  expect(textbox("Role").value).toBe("My draft role");
  expect(button("Reload")).toBeTruthy();
});

it("reload_after_conflict_reopens_from_disk", async () => {
  const client = appClient();
  client.fail(
    "agents/save",
    new IpcRemoteError(IpcErrorCode.CONFLICT, "revision mismatch"),
  );
  await openAgentsTab(client, "implementer");
  type("Role", "My draft role");
  fireEvent.click(button("Save"));
  await screen.findByText(CONFLICT_TEXT, {}, WAIT_OPTIONS);

  const onDisk = makeAgent({
    role: "Role from disk",
    revision: "agent-rev-7",
    body: "Body from disk",
  });
  client.respond("flows/list", listOf([onDisk, REVIEWER]));
  fireEvent.click(button("Reload"));

  await waitFor(() => {
    expect(textbox("Role").value).toBe("Role from disk");
  }, WAIT_OPTIONS);
  expect(textbox("Instructions").value).toBe("Body from disk");
  expect(screen.queryByText(CONFLICT_TEXT)).toBeNull();
  expect(button("Save").disabled).toBe(true);
});

it("create_new_agent_sends_create", async () => {
  const client = appClient();
  const created = makeAgent({
    id: "tester",
    file: "agents/tester.md",
    revision: "agent-rev-3",
    role: "Runs the tests",
    permissionProfile: PermissionProfile.ask,
    taskClass: "light",
    body: "Run the tests.",
  });
  client.respond("agents/create", listOf([IMPLEMENTER, REVIEWER, created]));
  await showAgentsTab(client);

  fireEvent.click(button("New agent"));
  await screen.findByLabelText("Id");
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(button("Save").disabled).toBe(true);
  type("Id", "tester");
  type("Role", "Runs the tests");
  fireEvent.change(select("Task class"), { target: { value: "light" } });
  type("Instructions", "Run the tests.");
  expect(button("Save").disabled).toBe(false);
  fireEvent.click(button("Save"));

  await waitFor(() => {
    expect(requestsOf(client, "agents/create")).toEqual([
      {
        cwd: CWD,
        agent: {
          id: "tester",
          role: "Runs the tests",
          provider: "claude",
          permissionProfile: "ask",
          taskClass: "light",
        },
        body: "Run the tests.",
      },
    ]);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(listText()).toContain("Runs the tests");
  }, WAIT_OPTIONS);
  expect(textbox("Id").value).toBe("tester");
  expect(button("Delete")).toBeTruthy();
});

it("delete_requires_confirmation_then_sends_delete", async () => {
  const client = appClient();
  client.respond("agents/delete", listOf([IMPLEMENTER]));
  await openAgentsTab(client, "reviewer");

  fireEvent.click(button("Delete"));
  expect(await screen.findByText(/agents\/reviewer\.md/)).toBeTruthy();
  expect(screen.getByText(/reviewer/, { selector: "dialog p" })).toBeTruthy();
  expect(requestsOf(client, "agents/delete")).toEqual([]);

  fireEvent.click(button("Delete agent"));

  await waitFor(() => {
    expect(requestsOf(client, "agents/delete")).toEqual([
      {
        cwd: CWD,
        file: "agents/reviewer.md",
        revision: "agent-rev-2",
        id: "reviewer",
      },
    ]);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(screen.queryByLabelText("Id")).toBeNull();
  }, WAIT_OPTIONS);
  expect(listText()).not.toContain("Reviews diffs");
});

it("delete_confirmation_says_file_stays_when_agents_share_it", async () => {
  const shared = [
    makeAgent({ id: "alpha", file: "agents/team.md" }),
    makeAgent({ id: "beta", file: "agents/team.md" }),
  ];
  const client = appClient(shared);
  await openAgentsTab(client, "alpha");

  fireEvent.click(button("Delete"));

  expect(
    await screen.findByText(
      /The file stays because it also holds 1 other agent/,
    ),
  ).toBeTruthy();
});

it("delete_and_rename_disabled_when_used_by_flow", async () => {
  const used = makeAgent({
    usedBy: [{ file: "flows/ship.md", title: "Ship it" }],
  });
  const client = appClient([used, REVIEWER]);
  await openAgentsTab(client, "implementer");

  expect(textbox("Id").readOnly).toBe(true);
  expect(button("Delete").disabled).toBe(true);
  expect(
    screen.getByText("Used by 1 flow. Remove it from those flows first."),
  ).toBeTruthy();
  expect(screen.getByText(/Ship it/)).toBeTruthy();

  await openAgent("reviewer");
  expect(textbox("Id").readOnly).toBe(false);
  expect(button("Delete").disabled).toBe(false);
});

it("draft_survives_tab_switch", async () => {
  const client = appClient();
  await openAgentsTab(client, "implementer");
  type("Role", "Half typed role");

  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  await screen.findByRole("region", { name: "Flow" });
  expect(screen.queryByLabelText("Instructions")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Agents" }));

  await waitFor(() => {
    expect(textbox("Role").value).toBe("Half typed role");
  }, WAIT_OPTIONS);
  expect(textbox("Id").value).toBe("implementer");
  expect(button("Save").disabled).toBe(false);
});

it("switching_agent_with_dirty_draft_asks_first", async () => {
  const client = appClient();
  await openAgentsTab(client, "implementer");
  type("Role", "Unsaved role");

  const list = within(screen.getByRole("list", { name: "Agents" }));
  fireEvent.click(list.getByRole("button", { name: /^reviewer\b/ }));
  expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy();
  expect(textbox("Id").value).toBe("implementer");

  fireEvent.click(button("Close"));
  await waitFor(() => {
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  }, WAIT_OPTIONS);
  expect(textbox("Id").value).toBe("implementer");
  expect(textbox("Role").value).toBe("Unsaved role");

  fireEvent.click(list.getByRole("button", { name: /^reviewer\b/ }));
  await screen.findByText("Discard unsaved changes?");
  fireEvent.click(button("Discard changes"));

  await waitFor(() => {
    expect(textbox("Id").value).toBe("reviewer");
  }, WAIT_OPTIONS);
  expect(textbox("Role").value).toBe("Reviews diffs");
});

it("opencode_model_suggestions_and_unknown_warning", async () => {
  const client = appClient();
  client.respond("models/catalog", {
    models: [
      makeCatalogModel({
        providerId: ApiProviderId.groq,
        modelId: "llama-3.3-70b",
      }),
    ],
    error: null,
  });
  await openAgentsTab(client, "implementer");
  expect(requestsOf(client, "models/catalog")).toEqual([]);
  expect(document.querySelector("datalist")).toBeNull();

  fireEvent.change(select("Provider"), { target: { value: "opencode" } });
  await waitFor(() => {
    expect(
      document.querySelector(`datalist option[value="${QUALIFIED_MODEL}"]`),
    ).not.toBeNull();
  }, WAIT_OPTIONS);
  expect(requestsOf(client, "models/catalog")).toHaveLength(1);
  expect(screen.queryByText(UNKNOWN_MODEL_TEXT)).toBeNull();

  type("Model", "groq/not-a-model");
  expect(screen.getByText(UNKNOWN_MODEL_TEXT)).toBeTruthy();

  type("Model", QUALIFIED_MODEL);
  expect(screen.queryByText(UNKNOWN_MODEL_TEXT)).toBeNull();

  fireEvent.change(select("Provider"), { target: { value: "codex" } });
  type("Model", "anything");
  expect(screen.queryByText(UNKNOWN_MODEL_TEXT)).toBeNull();
  expect(requestsOf(client, "models/catalog")).toHaveLength(1);
});

it("opencode_catalog_error_shows_note_without_warning", async () => {
  const client = appClient([
    makeAgent({ provider: ProviderId.opencode, model: "x/y" }),
  ]);
  client.respond("models/catalog", { models: [], error: "offline" });
  await openAgentsTab(client, "implementer");

  expect(
    await screen.findByText(
      /Model suggestions are unavailable/,
      {},
      WAIT_OPTIONS,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(UNKNOWN_MODEL_TEXT)).toBeNull();
});

const PICKED_CWD = "/home/user/picked";
const PICKED_AGENT = makeAgent({
  id: "picked-agent",
  file: "agents/picked-agent.md",
});

function stoppedClient(): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      session: makeSession({ cwd: CWD, phase: { phase: "stopped" } }),
    }),
  );
  client.on("flows/list", (params) =>
    params.cwd === PICKED_CWD
      ? listOf([PICKED_AGENT])
      : listOf([IMPLEMENTER, REVIEWER]),
  );
  return client;
}

function changeFolderButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Change folder…" });
}

it("viewing_agent_without_edits_keeps_change_folder", async () => {
  const client = stoppedClient();
  await showAgentsTab(client);
  expect(changeFolderButton()).not.toBeNull();

  await openAgent("implementer");
  expect(changeFolderButton()).not.toBeNull();

  fireEvent.click(button("New agent"));
  await screen.findByLabelText("Id");
  expect(changeFolderButton()).not.toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  await screen.findByRole("region", { name: "Flow" });
  expect(changeFolderButton()).not.toBeNull();
});

it("editing_agent_pins_folder_until_saved_or_discarded", async () => {
  const client = stoppedClient();
  await openAgentsTab(client, "implementer");
  expect(changeFolderButton()).not.toBeNull();

  type("Role", "Unsaved role");
  expect(changeFolderButton()).toBeNull();

  fireEvent.click(button("Discard"));
  await waitFor(() => {
    expect(textbox("Role").value).toBe("Implements the planned change");
  }, WAIT_OPTIONS);
  expect(changeFolderButton()).not.toBeNull();
});

it("picking_folder_with_clean_agent_open_switches_agents_tab", async () => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_CWD),
  });
  const client = stoppedClient();
  await openAgentsTab(client, "implementer");

  fireEvent.click(screen.getByRole("button", { name: "Change folder…" }));

  await waitFor(() => {
    expect(listText()).toContain("picked-agent");
  }, WAIT_OPTIONS);
  expect(listText()).not.toContain("reviewer");
  expect(requestsOf(client, "flows/list")).toContainEqual({ cwd: PICKED_CWD });
});

it("flow_add_node_lists_saved_agent", async () => {
  const client = appClient();
  const renamed = makeAgent({ id: "builder", file: "agents/builder.md" });
  const updated = listOf([renamed, REVIEWER]);
  client.respond("agents/save", updated);
  await openAgentsTab(client, "implementer");

  type("Id", "builder");
  fireEvent.click(button("Save"));
  await waitFor(() => {
    expect(requestsOf(client, "agents/save")).toHaveLength(1);
  }, WAIT_OPTIONS);
  await waitFor(() => {
    expect(listText()).toContain("builder");
  }, WAIT_OPTIONS);

  client.respond("flows/list", updated);
  fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = await screen.findByRole("form", { name: "Add node" });

  const options = within(within(form).getByLabelText("Agent")).getAllByRole(
    "option",
  );
  expect(options.map((option) => option.textContent)).toContain("builder");
});

const ROUTING_HELP =
  "Leave empty or set auto to let task-class routing pick a model on API-key accounts; subscriptions then use the CLI default.";
const PROVIDER_HELP: [string, string][] = [
  [
    "claude",
    "An alias (sonnet, opus, haiku) or a model id that Claude Code lists; sent with every turn.",
  ],
  ["codex", "A Codex model id; sent with every turn."],
  [
    "gemini",
    "A model name as `agy models` shows it, e.g. Gemini 4 Hydrogen (Medium); passed as --model.",
  ],
  ["opencode", "<provider>/<model>, e.g. groq/openai/gpt-oss-20b."],
];

it("agent model field explains the format per provider", async () => {
  const client = appClient();
  client.respond("models/catalog", { models: [], error: null });
  await openAgentsTab(client, "implementer");

  for (const [provider, help] of PROVIDER_HELP) {
    fireEvent.change(select("Provider"), { target: { value: provider } });
    expect(screen.getByText(`${help} ${ROUTING_HELP}`)).toBeTruthy();
  }
});

it("agent model field warns on an unknown opencode provider", async () => {
  const client = appClient();
  client.respond("models/catalog", { models: [], error: null });
  await openAgentsTab(client, "implementer");
  fireEvent.change(select("Provider"), { target: { value: "opencode" } });

  type("Model", "grok/llama");
  expect(screen.getByText(UNKNOWN_PROVIDER_TEXT)).toBeTruthy();

  type("Model", "groq/llama");
  expect(screen.queryByText(UNKNOWN_PROVIDER_TEXT)).toBeNull();

  type("Model", "auto");
  expect(screen.queryByText(UNKNOWN_PROVIDER_TEXT)).toBeNull();

  type("Model", "");
  expect(screen.queryByText(UNKNOWN_PROVIDER_TEXT)).toBeNull();
});
