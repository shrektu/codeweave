import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Composer } from "../../src/renderer/components/Composer";
import type { AppState } from "../../src/renderer/store";
import type { RotationPhaseView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
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
  return readyState(makeSnapshot({ session: makeSession(overrides) }));
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
    params: { text: "Fix the build" },
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
