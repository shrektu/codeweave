import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RestoreAction, RestoreSkipReason } from "../../src/domain/checkpoints";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import type {
  RestorePlanView,
  RestoreReportView,
  SessionView,
  Snapshot,
} from "../../src/shared/views";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import { createAppStore } from "../../src/renderer/store";
import type { AppState } from "../../src/renderer/store";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowRun,
  makeHistoryEntry,
  makePrompt,
  makeRestorePlan,
  makeRewindResult,
  makeSession,
  makeSnapshot,
  makeStoredSession,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const SESSION_ID = "sess-1";
const PAST_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_PROMPT = makePrompt({ seq: 0, text: "first prompt" });
const SECOND_PROMPT = makePrompt({ seq: 1, text: "second prompt" });
const RESTORED = "/work/project/restored.txt";
const CREATED = "/work/project/created.txt";
const CHANGED = "/work/project/changed.txt";
const UNSURE = "/work/project/unsure.txt";
const BINARY = "/work/project/binary.bin";
const TOO_LARGE = "/work/project/large.txt";
const NOT_REPORTED = "/work/project/not-reported.txt";
const MISMATCH = "/work/project/mismatch.txt";
const EVICTED = "/work/project/evicted.txt";
const PROTECTED = "/work/project/protected.txt";
const REWIND_BUTTON = "Rewind to here";
const TASK_PLACEHOLDER = "Describe the task";

const REPORT: RestoreReportView = {
  restored: [RESTORED],
  deleted: [CREATED],
  skipped: [{ path: CHANGED, reason: RestoreSkipReason.conflict }],
};

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function mainSession(
  overrides: Partial<ReturnType<typeof makeSession>> = {},
): SessionView {
  return makeSession({
    id: SESSION_ID,
    cwd: "/work/project",
    prompts: [FIRST_PROMPT, SECOND_PROMPT],
    ...overrides,
  });
}

function fullPlan(overrides: Partial<RestorePlanView> = {}): RestorePlanView {
  return makeRestorePlan({
    sessionId: SESSION_ID,
    promptSeq: SECOND_PROMPT.seq,
    files: [
      { path: RESTORED, action: RestoreAction.write, skip: null },
      { path: CREATED, action: RestoreAction.delete, skip: null },
      {
        path: CHANGED,
        action: RestoreAction.write,
        skip: RestoreSkipReason.conflict,
      },
      {
        path: UNSURE,
        action: RestoreAction.write,
        skip: RestoreSkipReason.unverifiable,
      },
      {
        path: BINARY,
        action: RestoreAction.none,
        skip: RestoreSkipReason.binary,
      },
      {
        path: TOO_LARGE,
        action: RestoreAction.none,
        skip: RestoreSkipReason.tooLarge,
      },
      {
        path: NOT_REPORTED,
        action: RestoreAction.none,
        skip: RestoreSkipReason.notReported,
      },
      {
        path: MISMATCH,
        action: RestoreAction.none,
        skip: RestoreSkipReason.patchMismatch,
      },
      {
        path: EVICTED,
        action: RestoreAction.none,
        skip: RestoreSkipReason.evicted,
      },
      {
        path: PROTECTED,
        action: RestoreAction.none,
        skip: RestoreSkipReason.protected,
      },
    ],
    ...overrides,
  });
}

function renderStream(
  client: FakeIpcClient,
  snapshot: Snapshot,
  overrides: Partial<AppState> = {},
): void {
  renderWithServices(
    <SessionStream />,
    client,
    staticStore({ ...readyState(snapshot), ...overrides }),
  );
}

function sessionSnapshot(
  overrides: Partial<ReturnType<typeof makeSession>> = {},
): Snapshot {
  return makeSnapshot({
    sessions: [mainSession(overrides)],
    accounts: [makeAccount()],
  });
}

async function openRewind(index = 1): Promise<HTMLElement> {
  const buttons = await screen.findAllByRole("button", { name: REWIND_BUTTON });
  const button = buttons[index];
  if (button === undefined) {
    throw new Error(`no rewind button ${String(index)}`);
  }
  fireEvent.click(button);
  return screen.findByRole("dialog");
}

it("every idle main prompt card offers a rewind button without changing its text", async () => {
  const client = createFakeIpcClient();
  renderStream(client, sessionSnapshot());

  const cards = await screen.findAllByRole("listitem", { name: "You" });
  expect(cards).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: REWIND_BUTTON })).toHaveLength(
    2,
  );
  expect(cards.map((card) => card.textContent)).toEqual([
    FIRST_PROMPT.text,
    SECOND_PROMPT.text,
  ]);
});

it("a prompt card of a busy session has no rewind button", async () => {
  const client = createFakeIpcClient();
  renderStream(client, sessionSnapshot({ turnInFlight: true }));

  expect(await screen.findByText(FIRST_PROMPT.text)).toBeTruthy();
  expect(screen.queryByRole("button", { name: REWIND_BUTTON })).toBeNull();
});

it("a focused child run stream has no rewind button", async () => {
  const client = createFakeIpcClient();
  const orchestrator = mainSession({ id: "orch-1", orchestrate: true });
  const runView = makeSession({
    id: "run-session",
    prompts: [makePrompt({ seq: 0, text: "child prompt" })],
    flowRef: { flowId: "solo", nodeId: "build" },
  });
  renderStream(
    client,
    makeSnapshot({
      sessions: [orchestrator],
      accounts: [makeAccount()],
      flowRuns: [makeFlowRun({ runId: "run-1", ownerSessionId: "orch-1" })],
      flowSessions: [{ runId: "run-1", view: runView }],
    }),
    { activeSessionId: "orch-1", focusedRunId: "run-1" },
  );

  expect(await screen.findByText("child prompt")).toBeTruthy();
  expect(screen.queryByRole("button", { name: REWIND_BUTTON })).toBeNull();
});

it("the dialog previews the prompt's plan with sections and reasons", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();

  expect(client.requests).toContainEqual({
    method: "session/rewindPreview",
    params: { sessionId: SESSION_ID, promptSeq: SECOND_PROMPT.seq },
  });
  expect(within(dialog).getByText("Files to restore")).toBeTruthy();
  expect(within(dialog).getByText("Created files to delete")).toBeTruthy();
  expect(
    within(dialog).getByText("Files changed outside the agent"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("Files that cannot be restored"),
  ).toBeTruthy();
  for (const path of [
    RESTORED,
    CREATED,
    CHANGED,
    UNSURE,
    BINARY,
    TOO_LARGE,
    NOT_REPORTED,
    MISMATCH,
    EVICTED,
    PROTECTED,
  ]) {
    expect(within(dialog).getByText(path)).toBeTruthy();
  }
  for (const reason of [
    "Binary file",
    "File is over 1 MB",
    "The agent did not report what it changed.",
    "The recorded change no longer matches the file.",
    "The saved copy was dropped to stay within the checkpoint size limit.",
    "Protected location (such as app data or account folders).",
  ]) {
    expect(within(dialog).getByText(reason)).toBeTruthy();
  }
  expect(
    within(dialog).getByText(
      "Codeweave cannot check the current content because the file is binary or too large.",
    ),
  ).toBeTruthy();
});

it("confirm sends the mode and only ticked conflicts and fills the composer", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.respond(
    "session/rewind",
    makeRewindResult({
      promptText: SECOND_PROMPT.text,
      report: REPORT,
      session: mainSession({ prompts: [FIRST_PROMPT] }),
    }),
  );
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();
  const checkboxes = within(dialog).getAllByRole("checkbox");
  const conflictBox = checkboxes[0];
  if (conflictBox === undefined) {
    throw new Error("no overwrite checkbox");
  }
  fireEvent.click(conflictBox);
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/rewind",
      params: {
        sessionId: SESSION_ID,
        promptSeq: SECOND_PROMPT.seq,
        mode: "conversation_and_files",
        overwrite: [CHANGED],
      },
    });
  });
  expect(
    (await screen.findByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER))
      .value,
  ).toBe(SECOND_PROMPT.text);
  const status = await screen.findByRole("status");
  expect(status.textContent).toBe(
    "Rewind complete: 1 restored, 1 deleted, 1 skipped.",
  );
});

it("files mode leaves the composer empty", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.respond(
    "session/rewind",
    makeRewindResult({ promptText: SECOND_PROMPT.text, report: REPORT }),
  );
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByText("Files only"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/rewind",
      params: {
        sessionId: SESSION_ID,
        promptSeq: SECOND_PROMPT.seq,
        mode: "files",
        overwrite: [],
      },
    });
  });
  expect(
    (await screen.findByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER))
      .value,
  ).toBe("");
});

it("a history-only session rewinds into its resume composer", async () => {
  const client = createFakeIpcClient();
  const stored = makeStoredSession({
    id: PAST_ID,
    cwd: "/work/past",
    title: "old one",
    prompts: [
      makePrompt({ seq: 0, text: "old one" }),
      makePrompt({ seq: 1, text: "old two" }),
    ],
  });
  client.respond(
    "session/rewindPreview",
    makeRestorePlan({
      sessionId: PAST_ID,
      promptSeq: 1,
      files: [],
    }),
  );
  client.respond(
    "session/rewind",
    makeRewindResult({ promptText: "old two", report: null, session: null }),
  );
  renderStream(
    client,
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    {
      activeSessionId: PAST_ID,
      history: [makeHistoryEntry({ id: PAST_ID, title: "old one" })],
      historyTranscripts: { [PAST_ID]: stored },
    },
  );

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/rewind",
      params: {
        sessionId: PAST_ID,
        promptSeq: 1,
        mode: "conversation_and_files",
        overwrite: [],
      },
    });
  });
  expect(
    (await screen.findByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER))
      .value,
  ).toBe("old two");
});

it("preview errors are shown in the dialog", async () => {
  const client = createFakeIpcClient();
  client.fail("session/rewindPreview", new Error("Preview failed"));
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();

  expect(await within(dialog).findByText("Preview failed")).toBeTruthy();
});

it("a rewind error keeps the dialog open", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.fail("session/rewind", new Error("Rewind failed"));
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));

  expect(await within(dialog).findByText("Rewind failed")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("a conversation only dialog hides the file sections", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByText("Conversation only"));

  expect(within(dialog).queryByText("Files to restore")).toBeNull();
  expect(
    within(dialog).queryByText("Files changed outside the agent"),
  ).toBeNull();
  expect(
    within(dialog).getByText(
      "After a conversation rewind, the agent continues from a summary of the remaining conversation without its own session memory.",
    ),
  ).toBeTruthy();
});

it("rewinding the same prompt twice keeps the composer text", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.respond(
    "session/rewind",
    makeRewindResult({
      promptText: SECOND_PROMPT.text,
      session: mainSession({ prompts: [FIRST_PROMPT] }),
    }),
  );
  client.respond("session/prompt", { accepted: true });
  renderStream(client, sessionSnapshot());

  const first = await openRewind();
  await within(first).findByText("Files to restore");
  fireEvent.click(within(first).getByRole("button", { name: "Rewind" }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
    ).toBe(SECOND_PROMPT.text);
  });

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
    ).toBe("");
  });

  const second = await openRewind();
  await within(second).findByText("Files to restore");
  fireEvent.click(within(second).getByRole("button", { name: "Rewind" }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
    ).toBe(SECOND_PROMPT.text);
  });
});

it("a sent prompt does not come back after switching sessions", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "sessions/snapshot",
    makeSnapshot({
      sessions: [
        mainSession(),
        makeSession({
          id: "sess-2",
          prompts: [makePrompt({ seq: 0, text: "other prompt" })],
        }),
      ],
      accounts: [makeAccount()],
    }),
  );
  client.respond("session/rewindPreview", fullPlan());
  client.respond(
    "session/rewind",
    makeRewindResult({
      promptText: SECOND_PROMPT.text,
      session: mainSession({ prompts: [FIRST_PROMPT] }),
    }),
  );
  client.respond("session/prompt", { accepted: true });
  const store = createAppStore(client);
  renderWithServices(<SessionStream />, client, store);
  await screen.findByText("other prompt");
  store.activateSession(SESSION_ID);
  await screen.findAllByRole("button", { name: REWIND_BUTTON });

  const dialog = await openRewind();
  await within(dialog).findByText("Files to restore");
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
    ).toBe(SECOND_PROMPT.text);
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
    ).toBe("");
  });

  store.activateSession("sess-2");
  await screen.findByText("other prompt");
  store.activateSession(SESSION_ID);
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: REWIND_BUTTON })).toHaveLength(
      2,
    );
  });

  expect(
    screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER).value,
  ).toBe("");
});

it("the dialog stays mounted when a live rewind removes the session", async () => {
  const client = createFakeIpcClient();
  const stored = makeStoredSession({
    id: SESSION_ID,
    cwd: "/work/project",
    prompts: [FIRST_PROMPT],
  });
  client.respond("sessions/snapshot", sessionSnapshot());
  client.respond("history/list", {
    entries: [makeHistoryEntry({ id: SESSION_ID })],
  });
  client.respond("history/get", stored);
  client.respond("session/rewindPreview", fullPlan());
  client.on("session/rewind", () => {
    client.emit({
      v: PROTOCOL_VERSION,
      event: "session/removed",
      payload: { sessionId: SESSION_ID },
    });
    throw new Error("Rewind failed");
  });
  const store = createAppStore(client);
  renderWithServices(<SessionStream />, client, store);

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));

  expect(await screen.findByText("Rewind failed")).toBeTruthy();
  const previews = client.requests.filter(
    (request) => request.method === "session/rewindPreview",
  );
  expect(previews).toHaveLength(1);
});

it("the status line clears on a conversation only rewind", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.on("session/rewind", (params) =>
    makeRewindResult({
      promptText: SECOND_PROMPT.text,
      report: params.mode === "files" ? REPORT : null,
    }),
  );
  renderStream(client, sessionSnapshot());

  const filesDialog = await openRewind();
  fireEvent.click(within(filesDialog).getByText("Files only"));
  fireEvent.click(within(filesDialog).getByRole("button", { name: "Rewind" }));
  expect(await screen.findByRole("status")).toBeTruthy();

  const conversationDialog = await openRewind();
  fireEvent.click(within(conversationDialog).getByText("Conversation only"));
  fireEvent.click(
    within(conversationDialog).getByRole("button", { name: "Rewind" }),
  );

  await waitFor(() => {
    expect(screen.queryByRole("status")).toBeNull();
  });
});

it("the status line clears after sending a prompt", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", fullPlan());
  client.respond(
    "session/rewind",
    makeRewindResult({ promptText: SECOND_PROMPT.text, report: REPORT }),
  );
  client.respond("session/prompt", { accepted: true });
  renderStream(client, sessionSnapshot());

  const dialog = await openRewind();
  fireEvent.click(within(dialog).getByText("Files only"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Rewind" }));
  expect(await screen.findByRole("status")).toBeTruthy();

  fireEvent.change(
    screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER),
    { target: { value: "next" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(screen.queryByRole("status")).toBeNull();
  });
});
