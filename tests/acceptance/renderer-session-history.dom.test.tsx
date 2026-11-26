import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { App } from "../../src/renderer/App";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { IpcRemoteError } from "../../src/renderer/ipc";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { SessionView, StoredSession } from "../../src/shared/views";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makeFlowsList,
  makeHistoryEntry,
  makeMessage,
  makePrompt,
  makeSession,
  makeSnapshot,
  makeStoredSession,
  makeVaultStatus,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";

const PAST_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVED_ID = "33333333-3333-4333-8333-333333333333";
const ENDED_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const OLD_PROMPT = "Old prompt";
const OLD_ANSWER = "Old answer";
const NEW_PROMPT = "More work";
const NEW_REPLY = "New reply";
const BUSY_MESSAGE = "The session cannot take a prompt right now";
const REQUEST_VERSION = 7;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function pastSessionStored(
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return makeStoredSession({
    id: PAST_ID,
    title: OLD_PROMPT,
    cwd: "/work/past",
    prompts: [makePrompt({ seq: 0, text: OLD_PROMPT })],
    messages: [makeMessage({ id: "m1", text: OLD_ANSWER, seq: 1 })],
    ...overrides,
  });
}

function setupClient(
  snapshot: ReturnType<typeof makeSnapshot>,
  entries: ReturnType<typeof makeHistoryEntry>[] = [],
): FakeIpcClient {
  const client = createFakeIpcClient();
  client.respond("sessions/snapshot", snapshot);
  client.respond("history/list", { entries });
  client.respond("flows/list", makeFlowsList());
  client.respond("vault/status", makeVaultStatus());
  client.respond("session/prompt", { accepted: true });
  return client;
}

async function openPastSession(client: FakeIpcClient): Promise<void> {
  client.respond("history/get", pastSessionStored());
  renderWithServices(<App />, client);
  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));
}

it("past_sessions_listed_after_restart", async () => {
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [makeHistoryEntry({ id: PAST_ID, title: OLD_PROMPT, cwd: "/work/past" })],
  );

  renderWithServices(<Sidebar onManageAccounts={() => undefined} />, client);

  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  expect(await within(nav).findByText(OLD_PROMPT)).toBeTruthy();
});

it("past_session_shows_prompts_and_replies", async () => {
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [makeHistoryEntry({ id: PAST_ID, title: OLD_PROMPT, cwd: "/work/past" })],
  );

  await openPastSession(client);

  const promptItem = await screen.findByRole("listitem", { name: "You" });
  expect(within(promptItem).getByText(OLD_PROMPT)).toBeTruthy();
  const items = screen.getAllByRole("listitem");
  const promptIndex = items.indexOf(promptItem);
  const answerIndex = items.findIndex((item) =>
    item.textContent.includes(OLD_ANSWER),
  );
  expect(promptIndex).toBeGreaterThanOrEqual(0);
  expect(answerIndex).toBeGreaterThan(promptIndex);
});

it("typing_in_past_session_resumes_it", async () => {
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [makeHistoryEntry({ id: PAST_ID, title: OLD_PROMPT, cwd: "/work/past" })],
  );
  client.respond(
    "session/resume",
    makeSession({ id: PAST_ID, cwd: "/work/past" }),
  );

  await openPastSession(client);

  const composer = await screen.findByPlaceholderText("Describe the task");
  await waitFor(() => {
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
  fireEvent.change(composer, { target: { value: NEW_PROMPT } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/prompt",
      params: { sessionId: PAST_ID, text: NEW_PROMPT },
    });
  });
  const sessionCalls = client.requests
    .filter(
      (request) =>
        request.method === "session/resume" ||
        request.method === "session/prompt",
    )
    .map((request) => request.method);
  expect(sessionCalls).toEqual(["session/resume", "session/prompt"]);
});

it("live_stream_shows_user_prompts", async () => {
  const live = makeSession({
    id: "s-live",
    cwd: "/work/live",
    prompts: [makePrompt({ seq: 0, text: "Live question" })],
    messages: [makeMessage({ id: "m1", text: "Live answer", seq: 1 })],
  });
  const client = setupClient(
    makeSnapshot({ sessions: [live], accounts: [makeAccount()] }),
  );

  renderWithServices(<App />, client);

  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  expect(await within(nav).findByText("live")).toBeTruthy();
  const promptItem = await screen.findByRole("listitem", { name: "You" });
  expect(within(promptItem).getByText("Live question")).toBeTruthy();
  expect(screen.getByText("Live answer")).toBeTruthy();
});

function archiveClient(): FakeIpcClient {
  const ended = makeSession({
    id: ENDED_ID,
    cwd: "/work/ended",
    phase: { phase: "stopped" },
    prompts: [makePrompt({ seq: 0, text: "Ended task" })],
  });
  const endedEntry = makeHistoryEntry({
    id: ENDED_ID,
    title: "Ended task",
    cwd: "/work/ended",
    archived: false,
    updatedAt: 2,
  });
  const archivedEntry = makeHistoryEntry({
    id: ARCHIVED_ID,
    title: "Archived task",
    cwd: "/work/old",
    archived: true,
    updatedAt: 1,
  });
  const client = setupClient(
    makeSnapshot({ sessions: [ended], accounts: [makeAccount()] }),
    [endedEntry, archivedEntry],
  );
  client.on("session/close", () => {
    client.emit({
      v: REQUEST_VERSION,
      event: "session/removed",
      payload: { sessionId: ENDED_ID },
    });
    client.emit({
      v: REQUEST_VERSION,
      event: "history/changed",
      payload: { ...endedEntry, archived: true },
    });
    return { closed: true };
  });
  client.on("history/archive", ({ sessionId, archived }) => {
    const entry = { ...archivedEntry, id: sessionId, archived };
    client.emit({
      v: REQUEST_VERSION,
      event: "history/changed",
      payload: entry,
    });
    return entry;
  });
  return client;
}

it("x_archives_and_show_archived_restores", async () => {
  const client = archiveClient();
  renderWithServices(<Sidebar onManageAccounts={() => undefined} />, client);

  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  expect(within(nav).queryByText("Archived task")).toBeNull();

  fireEvent.click(within(nav).getByRole("button", { name: "Close session" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/close",
      params: { sessionId: ENDED_ID },
    });
    expect(within(nav).queryByText("Ended task")).toBeNull();
  });

  const toggle = within(nav).getByRole("checkbox", { name: "Show archived" });
  fireEvent.click(toggle);
  expect(await within(nav).findByText("Archived task")).toBeTruthy();
  expect(within(nav).getByText("Ended task")).toBeTruthy();

  const row = within(nav).getByText("Archived task").closest("li");
  if (row === null) {
    throw new Error("no archived row");
  }
  fireEvent.click(within(row).getByRole("button", { name: "Restore" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "history/archive",
      params: { sessionId: ARCHIVED_ID, archived: false },
    });
  });

  fireEvent.click(toggle);
  expect(await within(nav).findByText("Archived task")).toBeTruthy();
  expect(within(nav).queryByText("Ended task")).toBeNull();
});

function wireStaleClose(
  client: FakeIpcClient,
  entry: ReturnType<typeof makeHistoryEntry>,
  ended: ReturnType<typeof makeSession>,
  serve: (stored: StoredSession) => void,
): void {
  client.on("session/close", () => {
    serve(
      pastSessionStored({
        updatedAt: 3,
        archived: true,
        messages: ended.messages,
      }),
    );
    client.emit({
      v: REQUEST_VERSION,
      event: "session/removed",
      payload: { sessionId: PAST_ID },
    });
    client.emit({
      v: REQUEST_VERSION,
      event: "history/changed",
      payload: { ...entry, archived: true, updatedAt: 3 },
    });
    return { closed: true };
  });
}

function staleTranscriptRig(): {
  client: FakeIpcClient;
  entry: ReturnType<typeof makeHistoryEntry>;
  ended: ReturnType<typeof makeSession>;
  serve: (stored: StoredSession) => void;
} {
  const entry = makeHistoryEntry({
    id: PAST_ID,
    title: OLD_PROMPT,
    cwd: "/work/past",
    updatedAt: 1,
  });
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [entry],
  );
  let served = pastSessionStored({ updatedAt: 1 });
  client.on("history/get", () => served);
  const oldMessages = [makeMessage({ id: "m1", text: OLD_ANSWER, seq: 1 })];
  const resumed = makeSession({
    id: PAST_ID,
    cwd: "/work/past",
    prompts: [makePrompt({ seq: 0, text: OLD_PROMPT })],
    messages: oldMessages,
  });
  client.on("session/resume", () => {
    client.emit({
      v: REQUEST_VERSION,
      event: "session/changed",
      payload: resumed,
    });
    return resumed;
  });
  const ended = makeSession({
    id: PAST_ID,
    cwd: "/work/past",
    phase: { phase: "stopped" },
    prompts: [makePrompt({ seq: 0, text: OLD_PROMPT })],
    messages: [
      ...oldMessages,
      makeMessage({ id: "m2", text: NEW_REPLY, seq: 2 }),
    ],
  });
  wireStaleClose(client, entry, ended, (stored) => {
    served = stored;
  });
  return {
    client,
    entry,
    ended,
    serve: (stored) => {
      served = stored;
    },
  };
}

it("resumed_session_transcript_not_stale", async () => {
  const { client, entry, ended, serve } = staleTranscriptRig();
  renderWithServices(<App />, client);
  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));
  expect(await screen.findByText(OLD_ANSWER)).toBeTruthy();

  const composer = await screen.findByPlaceholderText("Describe the task");
  await waitFor(() => {
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
  fireEvent.change(composer, { target: { value: NEW_PROMPT } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    expect(
      client.requests.some((request) => request.method === "session/prompt"),
    ).toBe(true);
  });

  serve(pastSessionStored({ updatedAt: 2, messages: ended.messages }));
  client.emit({
    v: REQUEST_VERSION,
    event: "session/changed",
    payload: ended,
  });
  client.emit({
    v: REQUEST_VERSION,
    event: "history/changed",
    payload: { ...entry, updatedAt: 2 },
  });
  expect(await screen.findByText(NEW_REPLY)).toBeTruthy();

  fireEvent.click(await screen.findByRole("button", { name: "Close session" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/close",
      params: { sessionId: PAST_ID },
    });
  });
  expect(await screen.findByText(NEW_REPLY)).toBeTruthy();
});

it("resume_prompt_failure_keeps_text_and_error", async () => {
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [makeHistoryEntry({ id: PAST_ID, title: OLD_PROMPT, cwd: "/work/past" })],
  );
  const resumed = makeSession({ id: PAST_ID, cwd: "/work/past" });
  client.on("session/resume", () => {
    client.emit({
      v: REQUEST_VERSION,
      event: "session/changed",
      payload: resumed,
    });
    return resumed;
  });
  client.fail(
    "session/prompt",
    new IpcRemoteError(IpcErrorCode.SESSION_BUSY, BUSY_MESSAGE),
  );

  await openPastSession(client);

  const composer = await screen.findByPlaceholderText("Describe the task");
  await waitFor(() => {
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
  fireEvent.change(composer, { target: { value: NEW_PROMPT } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();
  const liveComposer = screen.getByPlaceholderText("Describe the task");
  expect((liveComposer as HTMLTextAreaElement).value).toBe(NEW_PROMPT);
});

async function resumeArchivedSession(text: string): Promise<void> {
  const nav = screen.getByRole("navigation", { name: "Sessions" });
  fireEvent.click(within(nav).getByRole("checkbox", { name: "Show archived" }));
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));
  await sendPrompt(text);
}

async function sendPrompt(text: string): Promise<void> {
  const composer = await screen.findByPlaceholderText("Describe the task");
  await waitFor(() => {
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function composerValue(): string {
  return screen.getByPlaceholderText<HTMLTextAreaElement>("Describe the task")
    .value;
}

function wireResumeView(client: FakeIpcClient, view: () => SessionView): void {
  client.on("session/resume", () => {
    const current = view();
    client.emit({
      v: REQUEST_VERSION,
      event: "session/changed",
      payload: current,
    });
    return current;
  });
}

function wireFailureClose(
  client: FakeIpcClient,
  entry: ReturnType<typeof makeHistoryEntry>,
  prompts: () => SessionView["prompts"],
  serve: (stored: StoredSession) => void,
): void {
  client.on("session/close", () => {
    serve(
      pastSessionStored({
        updatedAt: 5,
        archived: true,
        prompts: prompts(),
      }),
    );
    client.emit({
      v: REQUEST_VERSION,
      event: "session/removed",
      payload: { sessionId: PAST_ID },
    });
    client.emit({
      v: REQUEST_VERSION,
      event: "history/changed",
      payload: { ...entry, archived: true, updatedAt: 5 },
    });
    return { closed: true };
  });
}

function resumeFailureRig(): {
  client: FakeIpcClient;
  succeed: () => void;
  archive: () => void;
} {
  const entry = makeHistoryEntry({
    id: PAST_ID,
    title: OLD_PROMPT,
    cwd: "/work/past",
  });
  const client = setupClient(
    makeSnapshot({ sessions: [], accounts: [makeAccount()] }),
    [entry],
  );
  let served = pastSessionStored();
  client.on("history/get", () => served);
  const oldPrompt = makePrompt({ seq: 0, text: OLD_PROMPT });
  let resumeView = makeSession({
    id: PAST_ID,
    cwd: "/work/past",
    prompts: [oldPrompt],
  });
  wireResumeView(client, () => resumeView);
  client.fail(
    "session/prompt",
    new IpcRemoteError(IpcErrorCode.SESSION_BUSY, BUSY_MESSAGE),
  );
  const succeed = (): void => {
    client.respond("session/prompt", { accepted: true });
    const prompts = [oldPrompt, makePrompt({ seq: 2, text: NEW_PROMPT })];
    resumeView = makeSession({ id: PAST_ID, cwd: "/work/past", prompts });
    client.emit({
      v: REQUEST_VERSION,
      event: "session/changed",
      payload: resumeView,
    });
  };
  const archive = (): void => {
    wireFailureClose(
      client,
      entry,
      () => resumeView.prompts,
      (stored) => {
        served = stored;
      },
    );
    client.emit({
      v: REQUEST_VERSION,
      event: "session/changed",
      payload: { ...resumeView, phase: { phase: "stopped" } },
    });
  };
  return { client, succeed, archive };
}

it("resume_failure_cleared_after_successful_prompt", async () => {
  const { client, succeed, archive } = resumeFailureRig();
  renderWithServices(<App />, client);
  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));

  await sendPrompt(NEW_PROMPT);
  expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();
  expect(composerValue()).toBe(NEW_PROMPT);

  succeed();
  await waitFor(() => {
    expect(screen.queryByText(BUSY_MESSAGE)).toBeNull();
  });
  expect(composerValue()).toBe("");

  archive();
  fireEvent.click(await screen.findByRole("button", { name: "Close session" }));
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/close",
      params: { sessionId: PAST_ID },
    });
  });

  await resumeArchivedSession("Another task");
  await waitFor(() => {
    expect(screen.queryByText(BUSY_MESSAGE)).toBeNull();
  });
});

function sessionSwitchRig(): FakeIpcClient {
  const entry = makeHistoryEntry({
    id: PAST_ID,
    title: OLD_PROMPT,
    cwd: "/work/past",
  });
  const other = makeSession({ id: OTHER_ID, cwd: "/work/other" });
  const client = setupClient(
    makeSnapshot({ sessions: [other], accounts: [makeAccount()] }),
    [entry],
  );
  let served = pastSessionStored();
  client.on("history/get", () => served);
  const resumeView = makeSession({
    id: PAST_ID,
    cwd: "/work/past",
    prompts: [makePrompt({ seq: 0, text: OLD_PROMPT })],
  });
  wireResumeView(client, () => resumeView);
  client.fail(
    "session/prompt",
    new IpcRemoteError(IpcErrorCode.SESSION_BUSY, BUSY_MESSAGE),
  );
  client.on("session/close", () => {
    served = pastSessionStored({
      updatedAt: 6,
      archived: true,
      prompts: resumeView.prompts,
    });
    client.emit({
      v: REQUEST_VERSION,
      event: "session/removed",
      payload: { sessionId: PAST_ID },
    });
    client.emit({
      v: REQUEST_VERSION,
      event: "history/changed",
      payload: { ...entry, archived: true, updatedAt: 6 },
    });
    return { closed: true };
  });
  return client;
}

async function closeWithX(nav: HTMLElement): Promise<void> {
  fireEvent.click(
    await within(nav).findByRole("button", { name: "Close session" }),
  );
}

async function reopenArchived(nav: HTMLElement): Promise<void> {
  fireEvent.click(within(nav).getByRole("checkbox", { name: "Show archived" }));
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));
  await screen.findByPlaceholderText("Describe the task");
}

async function switchToOther(nav: HTMLElement): Promise<void> {
  fireEvent.click(within(nav).getByText("other"));
  await waitFor(() => {
    expect(
      within(nav).getByText("other").closest("[aria-current='true']"),
    ).not.toBeNull();
  });
}

it("resume_error_cleared_on_session_change", async () => {
  const client = sessionSwitchRig();
  const resumeView = makeSession({
    id: PAST_ID,
    cwd: "/work/past",
    prompts: [makePrompt({ seq: 0, text: OLD_PROMPT })],
  });
  renderWithServices(<App />, client);
  const nav = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(nav).findByText(OLD_PROMPT));
  await sendPrompt(NEW_PROMPT);
  expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();

  client.emit({
    v: REQUEST_VERSION,
    event: "session/changed",
    payload: { ...resumeView, phase: { phase: "stopped" } },
  });
  await closeWithX(nav);
  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/close",
      params: { sessionId: PAST_ID },
    });
  });

  await reopenArchived(nav);
  expect(screen.queryByText(BUSY_MESSAGE)).toBeNull();

  await sendPrompt("Again");
  expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();

  await switchToOther(nav);
  fireEvent.click(within(nav).getByText(OLD_PROMPT));
  await waitFor(() => {
    expect(screen.queryByText(BUSY_MESSAGE)).toBeNull();
  });
});
