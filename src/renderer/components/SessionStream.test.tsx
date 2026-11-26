import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ImageMimeType } from "../../domain/attachments";
import { ProviderId } from "../../domain/types";
import type { AppState, AppStore } from "../store";
import { SessionStream } from "./SessionStream";
import {
  createFakeIpcClient,
  makeAccount,
  makeHistoryEntry,
  makePrompt,
  makeSession,
  makeSettings,
  makeSnapshot,
  makeStoredSession,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../../../tests/fakes/fakeIpcClient";
import type { SessionView } from "../../shared/views";
import { makeCodeweaveApi } from "../../../tests/fakes/fakeCodeweaveApi";

const CWD = "/home/user/project";
const PAST_ID = "22222222-2222-4222-8222-222222222222";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const EXISTING_BYTES = 8;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function pngFile(name = "pixel.png"): File {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: ImageMimeType.png });
}

let attachmentSeq = 0;

function wireAttachments(client: FakeIpcClient): void {
  client.on("attachments/stage", (params) => {
    attachmentSeq += 1;
    return {
      id: attachmentSeq.toString(16).padStart(64, "0"),
      name: params.name,
      mimeType: params.mimeType,
      bytes: EXISTING_BYTES,
    };
  });
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
}

function resumeState(provider: ProviderId): AppState {
  const entry = makeHistoryEntry({ id: PAST_ID, cwd: CWD, provider });
  const stored = makeStoredSession({
    id: PAST_ID,
    cwd: CWD,
    provider,
    prompts: [makePrompt({ seq: 0, text: "old prompt" })],
  });
  return {
    ...readyState(makeSnapshot({ sessions: [], accounts: [makeAccount()] })),
    activeSessionId: PAST_ID,
    history: [entry],
    historyTranscripts: { [PAST_ID]: stored },
  };
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>("Describe the task");
}

function taskBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(
    "What should the agent do?",
  );
}

function activatingStore(initial: AppState, started: SessionView): AppStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => () => undefined,
    activateSession: (sessionId) => {
      if (sessionId === null || state.snapshot === null) {
        return;
      }
      state = {
        ...state,
        activeSessionId: sessionId,
        snapshot: {
          ...state.snapshot,
          sessions: [...state.snapshot.sessions, started],
        },
      };
      notify();
    },
    focusRun: () => undefined,
    loadTranscript: () => Promise.resolve(null),
  };
}

it("failed_start_prompt_keeps_attachments_in_session_composer", async () => {
  const client = createFakeIpcClient();
  wireAttachments(client);
  const started = makeSession({ id: "sess-9", cwd: CWD });
  client.respond("session/start", started);
  client.fail("session/prompt", new Error("busy"));
  renderWithServices(
    <SessionStream />,
    client,
    activatingStore(
      readyState(makeSnapshot({ sessions: [], accounts: [makeAccount()] })),
      started,
    ),
  );

  fireEvent.change(taskBox(), { target: { value: "Fix the build" } });
  fireEvent.paste(taskBox(), { clipboardData: { files: [pngFile()] } });
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => {
    expect(promptBox().value).toBe("Fix the build");
  });
  expect(screen.getByRole("img", { name: "pixel.png" })).toBeTruthy();
});

it("failed_resume_keeps_attachments", async () => {
  const client = createFakeIpcClient();
  wireAttachments(client);
  client.respond("session/resume", makeSession({ id: PAST_ID, cwd: CWD }));
  client.fail("session/prompt", new Error("busy"));
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(resumeState(ProviderId.claude)),
  );

  fireEvent.change(promptBox(), { target: { value: "continue" } });
  fireEvent.paste(promptBox(), { clipboardData: { files: [pngFile()] } });
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(screen.getByText("busy")).toBeTruthy();
  });
  expect(await screen.findByRole("img", { name: "pixel.png" })).toBeTruthy();
});

it("start_prompt_completes_in_default_workspace", async () => {
  const client = createFakeIpcClient();
  client.respond("files/complete", { items: [{ path: "src", kind: "dir" }] });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(
        makeSnapshot({
          sessions: [],
          accounts: [makeAccount()],
          settings: makeSettings({
            defaultWorkspaceResolved: "/home/user/workspace",
          }),
        }),
      ),
    ),
  );

  fireEvent.change(screen.getByPlaceholderText("What should the agent do?"), {
    target: { value: "@sr" },
  });

  expect(await screen.findByRole("option", { name: "src/" })).toBeTruthy();
  expect(client.requests).toContainEqual({
    method: "files/complete",
    params: { cwd: "/home/user/workspace", query: "sr" },
  });
});
