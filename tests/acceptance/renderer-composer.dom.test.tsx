import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ApiProviderId } from "../../src/domain/apiProviders";
import { ProviderId } from "../../src/domain/types";
import { Composer } from "../../src/renderer/components/Composer";
import type { AppState, AppStore } from "../../src/renderer/store";
import type { RotationPhaseView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

afterEach(cleanup);

function textbox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>("Describe the task");
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
}

function sessionState(
  overrides: Parameters<typeof makeSession>[0] = {},
): AppState {
  return readyState(makeSnapshot({ sessions: [makeSession(overrides)] }));
}

it.each<[string, RotationPhaseView]>([
  ["switching", { phase: "switching", from: "acc-1", to: "acc-2" }],
  ["waiting", { phase: "waiting", accountId: "acc-1", until: 1 }],
  ["failed", { phase: "failed", reason: "boom", runningAccountId: null }],
  ["halted", { phase: "halted" }],
  ["stopped", { phase: "stopped" }],
])("composer_disabled_outside_running_phase_%s", (_name, phase) => {
  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(sessionState({ phase })),
  );

  expect(textbox().disabled).toBe(true);
  expect(sendButton().disabled).toBe(true);
});

it("composer_disabled_outside_running_or_during_turn", () => {
  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(sessionState({ turnInFlight: true })),
  );

  expect(textbox().disabled).toBe(true);
});

it("composer_disabled_without_a_session", () => {
  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(readyState(makeSnapshot())),
  );

  expect(textbox().disabled).toBe(true);
});

it("composer_disabled_when_backend_disconnected", () => {
  const state: AppState = { ...sessionState(), connection: "disconnected" };
  renderWithServices(<Composer />, createFakeIpcClient(), staticStore(state));

  expect(textbox().disabled).toBe(true);
});

it("composer_enabled_while_running_and_idle", () => {
  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(sessionState()),
  );

  expect(textbox().disabled).toBe(false);
});

it("composer_enter_sends_prompt_and_clears", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  renderWithServices(<Composer />, client, staticStore(sessionState()));

  fireEvent.change(textbox(), { target: { value: "Fix the build" } });
  fireEvent.keyDown(textbox(), { key: "Enter" });

  await waitFor(() => {
    expect(textbox().value).toBe("");
  });
  expect(client.requests).toContainEqual({
    method: "session/prompt",
    params: { sessionId: "sess-1", text: "Fix the build" },
  });
});

it("composer_shift_enter_does_not_send", () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  renderWithServices(<Composer />, client, staticStore(sessionState()));

  fireEvent.change(textbox(), { target: { value: "line one" } });
  fireEvent.keyDown(textbox(), { key: "Enter", shiftKey: true });

  expect(client.requests).toEqual([]);
  expect(textbox().value).toBe("line one");
});

const OPENCODE_ACCOUNT = makeAccount({
  id: "acc-oc",
  provider: ProviderId.opencode,
  label: "Groq",
  api: {
    provider: ApiProviderId.groq,
    model: "openai/gpt-oss-120b",
    baseUrl: null,
    rotation: true,
    auth: "api_key",
  },
});

function opencodeState(turnInFlight = false): AppState {
  return readyState(
    makeSnapshot({
      accounts: [OPENCODE_ACCOUNT],
      sessions: [
        makeSession({
          provider: ProviderId.opencode,
          activeProvider: ProviderId.opencode,
          activeAccountId: "acc-oc",
          phase: { phase: "running", accountId: "acc-oc" },
          turnInFlight,
        }),
      ],
    }),
  );
}

function classSelect(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>("Task class");
}

function modelInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Model override");
}

function sendText(value: string): void {
  fireEvent.change(textbox(), { target: { value } });
  fireEvent.keyDown(textbox(), { key: "Enter" });
}

function promptRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "session/prompt")
    .map((request) => request.params);
}

it("composer sends the chosen class and model", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  renderWithServices(<Composer />, client, staticStore(opencodeState()));

  expect(
    Array.from(classSelect().options, (option) => option.textContent),
  ).toEqual(["Auto", "Light", "Standard", "Heavy"]);
  fireEvent.change(classSelect(), { target: { value: "heavy" } });
  fireEvent.change(modelInput(), {
    target: { value: "groq/openai/gpt-oss-120b" },
  });
  sendText("Refactor the parser");

  await waitFor(() => {
    expect(textbox().value).toBe("");
  });
  expect(promptRequests(client)).toEqual([
    {
      sessionId: "sess-1",
      text: "Refactor the parser",
      taskClass: "heavy",
      model: { provider: "opencode", model: "groq/openai/gpt-oss-120b" },
    },
  ]);
});

it("composer choice persists across sends", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  renderWithServices(<Composer />, client, staticStore(opencodeState()));

  fireEvent.change(classSelect(), { target: { value: "light" } });
  sendText("first");
  await waitFor(() => {
    expect(textbox().value).toBe("");
  });
  sendText("second");
  await waitFor(() => {
    expect(promptRequests(client)).toHaveLength(2);
  });

  expect(classSelect().value).toBe("light");
  expect(promptRequests(client)).toEqual([
    { sessionId: "sess-1", text: "first", taskClass: "light" },
    { sessionId: "sess-1", text: "second", taskClass: "light" },
  ]);
});

it("composer class change during a turn applies to the next send", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  let state = opencodeState(true);
  const listeners = new Set<() => void>();
  const store: AppStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => () => undefined,
    activateSession: () => undefined,
    focusRun: () => undefined,
  };
  renderWithServices(<Composer />, client, store);

  expect(textbox().disabled).toBe(true);
  fireEvent.change(classSelect(), { target: { value: "heavy" } });
  expect(promptRequests(client)).toEqual([]);

  state = opencodeState(false);
  act(() => {
    listeners.forEach((listener) => {
      listener();
    });
  });
  sendText("next");

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "next", taskClass: "heavy" },
    ]);
  });
});

it("composer offers the account models and none for subscriptions", () => {
  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(opencodeState()),
  );
  const values = Array.from(
    document.querySelectorAll<HTMLOptionElement>("datalist option"),
    (option) => option.value,
  );
  expect(values).toEqual([
    "groq/openai/gpt-oss-20b",
    "groq/openai/gpt-oss-120b",
  ]);
  cleanup();

  renderWithServices(
    <Composer />,
    createFakeIpcClient(),
    staticStore(sessionState()),
  );
  expect(document.querySelectorAll("datalist option")).toHaveLength(0);
});

it("composer tags the model with the running account provider", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  const state = readyState(
    makeSnapshot({
      accounts: [OPENCODE_ACCOUNT],
      sessions: [
        makeSession({
          provider: ProviderId.claude,
          activeProvider: ProviderId.opencode,
          activeAccountId: "acc-oc",
          phase: { phase: "running", accountId: "acc-oc" },
        }),
      ],
    }),
  );
  renderWithServices(<Composer />, client, staticStore(state));

  fireEvent.change(modelInput(), {
    target: { value: "groq/openai/gpt-oss-20b" },
  });
  sendText("rotated");

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      {
        sessionId: "sess-1",
        text: "rotated",
        model: { provider: "opencode", model: "groq/openai/gpt-oss-20b" },
      },
    ]);
  });
});

it("composer resets its choice for a new session", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  let state = opencodeState();
  const listeners = new Set<() => void>();
  const store: AppStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => () => undefined,
    activateSession: () => undefined,
    focusRun: () => undefined,
  };
  renderWithServices(<Composer />, client, store);

  fireEvent.change(classSelect(), { target: { value: "heavy" } });
  fireEvent.change(modelInput(), {
    target: { value: "groq/openai/gpt-oss-120b" },
  });

  state = sessionState({ id: "sess-2" });
  act(() => {
    listeners.forEach((listener) => {
      listener();
    });
  });
  sendText("fresh");

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-2", text: "fresh" },
    ]);
  });
  expect(classSelect().value).toBe("");
  expect(modelInput().value).toBe("");
});

it("composer sends no class or model while both are on auto", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  renderWithServices(<Composer />, client, staticStore(opencodeState()));

  fireEvent.change(modelInput(), { target: { value: "  " } });
  sendText("plain");

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "plain" },
    ]);
  });
});
