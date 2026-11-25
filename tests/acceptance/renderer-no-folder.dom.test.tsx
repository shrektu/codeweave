import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../../src/shared/constants";
import { App } from "../../src/renderer/App";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeFlowsList,
  makeSession,
  makeSettings,
  makeSnapshot,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const PICKED_CWD = "/home/user/picked";
const HOME_FOLDER = "/home/user";
const WORKSPACE = "/home/user/workspace";
const TASK = "Fix the failing login test";
const TASK_BOX = "Task";
const START_BUTTON = "Start";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi({
    pickFolder: () => Promise.resolve(PICKED_CWD),
  });
});

afterEach(cleanup);

function clientWith(
  settings: Parameters<typeof makeSettings>[0] = {},
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond(
    "sessions/snapshot",
    makeSnapshot({ settings: makeSettings(settings) }),
  );
  client.respond("flows/list", makeFlowsList({ flows: [] }));
  client.respond("session/start", makeSession({ cwd: HOME_FOLDER }));
  client.respond("session/prompt", { accepted: true });
  return client;
}

function requestsOf(client: FakeIpcClient, method: string): unknown[] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params);
}

function startButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: START_BUTTON });
}

it("start_prompt_typed_task_starts_without_a_folder_then_prompts", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);

  fireEvent.change(await screen.findByRole("textbox", { name: TASK_BOX }), {
    target: { value: `  ${TASK}  ` },
  });
  fireEvent.click(startButton());

  await waitFor(() => {
    expect(requestsOf(client, "session/prompt")).toEqual([
      { sessionId: "sess-1", text: TASK },
    ]);
  });
  expect(requestsOf(client, "session/start")).toEqual([{}]);
  const order = client.requests.map((request) => request.method);
  expect(order.indexOf("session/start")).toBeLessThan(
    order.indexOf("session/prompt"),
  );
});

it("start_prompt_start_is_disabled_while_the_task_is_blank", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);

  const box = await screen.findByRole("textbox", { name: TASK_BOX });
  expect(startButton().disabled).toBe(true);

  fireEvent.change(box, { target: { value: "   " } });
  expect(startButton().disabled).toBe(true);

  fireEvent.change(box, { target: { value: TASK } });
  expect(startButton().disabled).toBe(false);
  expect(requestsOf(client, "session/start")).toEqual([]);
});

it("start_prompt_hint_shows_where_a_no_folder_session_starts", async () => {
  renderWithServices(
    <App />,
    clientWith({
      defaultWorkspace: WORKSPACE,
      defaultWorkspaceResolved: WORKSPACE,
    }),
  );

  expect(
    await screen.findByText(
      `Starts in ${WORKSPACE}. The agent finds the repository itself.`,
    ),
  ).toBeTruthy();
});

it("start_prompt_no_folder_start_keeps_provider_and_orchestrate", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);

  fireEvent.click(await screen.findByRole("checkbox", { name: "Orchestrate" }));
  fireEvent.change(screen.getByRole("textbox", { name: TASK_BOX }), {
    target: { value: TASK },
  });
  fireEvent.click(startButton());

  await waitFor(() => {
    expect(requestsOf(client, "session/start")).toEqual([
      { orchestrate: true },
    ]);
  });
});

it("start_prompt_choose_folder_still_starts_in_the_picked_folder", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);

  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(requestsOf(client, "session/start")).toEqual([{ cwd: PICKED_CWD }]);
  });
  expect(requestsOf(client, "session/prompt")).toEqual([]);
});

it("start_prompt_failed_start_shows_the_error_and_sends_no_prompt", async () => {
  const client = clientWith();
  client.fail(
    "session/start",
    new Error("Default workspace does not exist: /gone"),
  );
  renderWithServices(<App />, client);

  fireEvent.change(await screen.findByRole("textbox", { name: TASK_BOX }), {
    target: { value: TASK },
  });
  fireEvent.click(startButton());

  expect(
    await screen.findByText("Default workspace does not exist: /gone"),
  ).toBeTruthy();
  expect(requestsOf(client, "session/prompt")).toEqual([]);
});

it("start_prompt_start_is_disabled_while_the_start_is_pending", async () => {
  const client = clientWith();
  const gate = Promise.withResolvers<ReturnType<typeof makeSession>>();
  client.on("session/start", () => gate.promise);
  renderWithServices(<App />, client);

  fireEvent.change(await screen.findByRole("textbox", { name: TASK_BOX }), {
    target: { value: TASK },
  });
  fireEvent.click(startButton());

  await waitFor(() => {
    expect(startButton().disabled).toBe(true);
  });
  expect(requestsOf(client, "session/start")).toEqual([{}]);
  gate.resolve(makeSession({ cwd: HOME_FOLDER }));
});

function startsBackendThenFails(client: FakeIpcClient): void {
  client.on("session/start", () => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "session/changed",
      payload: makeSession({ cwd: HOME_FOLDER }),
    });
    return Promise.reject(new Error("Request timed out"));
  });
}

function composerBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>("Describe the task");
}

function expectNoStartPrompt(): void {
  expect(screen.queryByRole("button", { name: START_BUTTON })).toBeNull();
  expect(screen.queryByRole("textbox", { name: TASK_BOX })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Orchestrate" })).toBeNull();
}

async function typeTaskAndStart(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: TASK_BOX }), {
    target: { value: TASK },
  });
  fireEvent.click(startButton());
}

it("start_failure_keeps_typed_task", async () => {
  const client = clientWith();
  startsBackendThenFails(client);
  renderWithServices(<App />, client);

  await typeTaskAndStart();

  expect(await screen.findByText("Request timed out")).toBeTruthy();
  expect(composerBox().value).toBe(TASK);
});

it("live_session_never_shows_start_prompt", async () => {
  const client = clientWith();
  startsBackendThenFails(client);
  renderWithServices(<App />, client);

  await typeTaskAndStart();

  expect(await screen.findByText("Request timed out")).toBeTruthy();
  expectNoStartPrompt();
});

it("prompt_failure_keeps_typed_task", async () => {
  const client = clientWith();
  client.on("session/start", () => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "session/changed",
      payload: makeSession({ cwd: HOME_FOLDER }),
    });
    return Promise.resolve(makeSession({ cwd: HOME_FOLDER }));
  });
  client.fail("session/prompt", new Error("Prompt rejected"));
  renderWithServices(<App />, client);

  await typeTaskAndStart();

  expect(await screen.findByText("Prompt rejected")).toBeTruthy();
  expectNoStartPrompt();
  expect(composerBox().value).toBe(TASK);
});

const FIRST_SESSION = "sess-1";
const SECOND_SESSION = "sess-2";
const SEND_BUTTON = "Send";

function emitSession(
  client: FakeIpcClient,
  overrides: Parameters<typeof makeSession>[0],
): void {
  client.emit({
    v: PROTOCOL_VERSION,
    event: "session/changed",
    payload: makeSession({ cwd: HOME_FOLDER, ...overrides }),
  });
}

async function failFirstPromptThenResendIt(
  client: FakeIpcClient,
): Promise<void> {
  client.on("session/start", () => {
    emitSession(client, { id: FIRST_SESSION });
    return Promise.resolve(
      makeSession({ cwd: HOME_FOLDER, id: FIRST_SESSION }),
    );
  });
  client.fail("session/prompt", new Error("Prompt rejected"));
  await typeTaskAndStart();
  expect(await screen.findByText("Prompt rejected")).toBeTruthy();
  expect(composerBox().value).toBe(TASK);
  client.respond("session/prompt", { accepted: true });
  fireEvent.click(screen.getByRole("button", { name: SEND_BUTTON }));
  await waitFor(() => {
    expect(composerBox().value).toBe("");
  });
}

it("stale-unsent-draft-not-restored-in-new-session", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);
  await failFirstPromptThenResendIt(client);

  emitSession(client, {
    id: FIRST_SESSION,
    phase: { phase: "stopped" },
  });
  client.on("session/start", () => {
    emitSession(client, { id: SECOND_SESSION });
    return Promise.resolve(
      makeSession({ cwd: PICKED_CWD, id: SECOND_SESSION }),
    );
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose folder…" }),
  );

  await waitFor(() => {
    expect(requestsOf(client, "session/start")).toHaveLength(2);
  });
  await waitFor(() => {
    expectNoStartPrompt();
  });
  expect(composerBox().value).toBe("");
});

it("unsent_draft_belongs_to_the_session_that_failed", async () => {
  const client = clientWith();
  client.on("session/start", () => {
    emitSession(client, { id: FIRST_SESSION });
    return Promise.resolve(
      makeSession({ cwd: HOME_FOLDER, id: FIRST_SESSION }),
    );
  });
  client.fail("session/prompt", new Error("Prompt rejected"));
  renderWithServices(<App />, client);
  await typeTaskAndStart();
  expect(await screen.findByText("Prompt rejected")).toBeTruthy();
  expect(composerBox().value).toBe(TASK);

  emitSession(client, { id: SECOND_SESSION, cwd: PICKED_CWD });
  fireEvent.click(
    await within(screen.getByRole("region", { name: "Sessions" })).findByText(
      "picked",
    ),
  );

  await waitFor(() => {
    expect(composerBox().value).toBe("");
  });
});

it("task_start_box_is_not_mistaken_for_the_composer_before_a_session", async () => {
  const client = clientWith();
  renderWithServices(<App />, client);

  await screen.findByRole("textbox", { name: TASK_BOX });

  expect(screen.queryByPlaceholderText("Describe the task")).toBeNull();
});
