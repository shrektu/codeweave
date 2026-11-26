import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type JSX } from "react";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { ImageMimeType } from "../../src/domain/attachments";
import { ProviderId } from "../../src/domain/types";
import { Composer } from "../../src/renderer/components/Composer";
import { AttachmentThumbnail } from "../../src/renderer/components/AttachmentThumbnail";
import { PromptInput } from "../../src/renderer/components/PromptInput";
import { thumbnailCache } from "../../src/renderer/attachments";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import type { AppState, AppStore } from "../../src/renderer/store";
import type {
  AttachmentView,
  FileCompletionItem,
  SessionView,
} from "../../src/shared/views";
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
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

const CWD = "/home/user/project";
const TASK_PLACEHOLDER = "What should the agent do?";
const PROMPT_PLACEHOLDER = "Describe the task";
const LIST_NAME = "File and folder suggestions";
const PAST_ID = "22222222-2222-4222-8222-222222222222";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const OVERSIZED_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const EXISTING_BYTES = 8;

let warn: MockInstance<typeof console.warn>;
let attachmentSeq = 0;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  warn.mockRestore();
});

function pngBytes(): Uint8Array<ArrayBuffer> {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pngFile(name = "pixel.png"): File {
  return new File([pngBytes()], name, { type: ImageMimeType.png });
}

function oversizedPng(): File {
  return new File([new Uint8Array(OVERSIZED_BYTES)], "big.png", {
    type: ImageMimeType.png,
  });
}

function textFile(): File {
  return new File(["notes"], "notes.txt", { type: "text/plain" });
}

function nextAttachmentId(): string {
  attachmentSeq += 1;
  return attachmentSeq.toString(16).padStart(64, "0");
}

function attachmentViews(count: number): readonly AttachmentView[] {
  return Array.from({ length: count }, (_, index): AttachmentView => ({
    id: `${index.toString(16)}${"0".repeat(63)}`,
    name: `shot-${index.toString()}.png`,
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  }));
}

function composerState(
  overrides: Parameters<typeof makeSession>[0] = {},
): AppState {
  return readyState(
    makeSnapshot({
      accounts: [makeAccount()],
      sessions: [makeSession({ cwd: CWD, ...overrides })],
    }),
  );
}

function renderComposer(
  client: FakeIpcClient,
  overrides: Parameters<typeof makeSession>[0] = {},
): void {
  renderWithServices(
    <Composer />,
    client,
    staticStore(composerState(overrides)),
  );
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(PROMPT_PLACEHOLDER);
}

function taskBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER);
}

function typeInto(box: HTMLTextAreaElement, value: string): void {
  fireEvent.change(box, { target: { value } });
}

function pasteFiles(box: HTMLElement, files: readonly File[]): boolean {
  return fireEvent.paste(box, { clipboardData: { files } });
}

function dropFiles(box: HTMLElement, files: readonly File[]): void {
  fireEvent.drop(box, { dataTransfer: { files, types: ["Files"] } });
}

function completeWith(
  client: FakeIpcClient,
  items: readonly FileCompletionItem[],
): void {
  client.respond("files/complete", { items: [...items] });
}

function wireAttachments(
  client: FakeIpcClient,
  staged: AttachmentView[],
): void {
  client.on("attachments/stage", (params) => {
    const view: AttachmentView = {
      id: nextAttachmentId(),
      name: params.name,
      mimeType: params.mimeType,
      bytes: EXISTING_BYTES,
    };
    staged.push(view);
    return view;
  });
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
}

function completionRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "files/complete")
    .map((request) => request.params);
}

function promptRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "session/prompt")
    .map((request) => request.params);
}

async function openList(): Promise<HTMLElement> {
  return screen.findByRole("listbox", { name: LIST_NAME });
}

it("composer_mention_requests_completion_in_session_folder", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "src", kind: "dir" }]);
  renderComposer(client);

  typeInto(promptBox(), "@sr");

  expect(await openList()).toBeTruthy();
  expect(await screen.findByRole("option", { name: "src/" })).toBeTruthy();
  expect(completionRequests(client)).toEqual([{ cwd: CWD, query: "sr" }]);
});

it("enter_on_folder_inserts_path_and_keeps_list_open", async () => {
  const client = createFakeIpcClient();
  client.on("files/complete", (params) => ({
    items:
      params.query === "src/"
        ? [{ path: "src/main.ts", kind: "file" }]
        : [{ path: "src", kind: "dir" }],
  }));
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@sr");
  await screen.findByRole("option", { name: "src/" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe("@src/");
  });
  expect(await openList()).toBeTruthy();
  expect(
    await screen.findByRole("option", { name: "src/main.ts" }),
  ).toBeTruthy();
});

it("enter_on_file_inserts_path_and_closes_list", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "src/App.tsx", kind: "file" }]);
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@sr");
  await screen.findByRole("option", { name: "src/App.tsx" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe("@src/App.tsx ");
  });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("enter_with_open_list_does_not_send", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  completeWith(client, [{ path: "src", kind: "dir" }]);
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@sr");
  await screen.findByRole("option", { name: "src/" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe("@src/");
  });
  expect(promptRequests(client)).toEqual([]);
});

it("escape_then_enter_sends", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  completeWith(client, [{ path: "src", kind: "dir" }]);
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@sr");
  await openList();
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();

  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "@sr" },
    ]);
  });
});

it("path_with_space_is_quoted", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "my file.txt", kind: "file" }]);
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@my");
  await screen.findByRole("option", { name: "my file.txt" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe('@"my file.txt" ');
  });
});

it("stale_completion_response_is_ignored", async () => {
  const client = createFakeIpcClient();
  const pending: ((result: { items: FileCompletionItem[] }) => void)[] = [];
  client.on(
    "files/complete",
    () =>
      new Promise<{ items: FileCompletionItem[] }>((resolve) => {
        pending.push(resolve);
      }),
  );
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@s");
  await waitFor(() => {
    expect(pending).toHaveLength(1);
  });
  typeInto(box, "@sr");
  await waitFor(() => {
    expect(pending).toHaveLength(2);
  });

  await act(async () => {
    pending[1]?.({ items: [{ path: "src", kind: "dir" }] });
    await Promise.resolve();
  });
  expect(await screen.findByRole("option", { name: "src/" })).toBeTruthy();

  await act(async () => {
    pending[0]?.({ items: [{ path: "stale", kind: "dir" }] });
    await Promise.resolve();
  });
  expect(screen.getByRole("option", { name: "src/" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "stale/" })).toBeNull();
});

it("mention_inside_word_opens_nothing", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "b", kind: "dir" }]);
  renderComposer(client);
  const box = promptBox();

  vi.useFakeTimers();
  typeInto(box, "a@b");
  await vi.advanceTimersByTimeAsync(300);

  expect(completionRequests(client)).toEqual([]);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("start_prompt_without_folder_omits_cwd", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "src", kind: "dir" }]);
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(makeSnapshot({ sessions: [], accounts: [makeAccount()] })),
    ),
  );

  typeInto(taskBox(), "@sr");
  await screen.findByRole("option", { name: "src/" });
  expect(completionRequests(client)).toEqual([
    { cwd: "/home/user", query: "sr" },
  ]);

  cleanup();
  const unresolved = createFakeIpcClient();
  completeWith(unresolved, [{ path: "src", kind: "dir" }]);
  renderWithServices(
    <SessionStream />,
    unresolved,
    staticStore({ ...readyState(makeSnapshot()), snapshot: null }),
  );

  typeInto(taskBox(), "@sr");
  await screen.findByRole("option", { name: "src/" });
  expect(completionRequests(unresolved)).toEqual([{ query: "sr" }]);
});

it("paste_png_stages_and_shows_chip", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  pasteFiles(promptBox(), [pngFile()]);

  expect(await screen.findByRole("img", { name: "pixel.png" })).toBeTruthy();
  expect(client.requests).toContainEqual({
    method: "attachments/stage",
    params: {
      name: "pixel.png",
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    },
  });
  expect(
    screen.getByRole("img", { name: "pixel.png" }).getAttribute("src"),
  ).toBe(PNG_DATA_URL);
});

it("send_passes_staged_attachments_and_clears_chips", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  typeInto(box, "look at this");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "look at this", attachments: staged },
    ]);
  });
  await waitFor(() => {
    expect(box.value).toBe("");
  });
  expect(screen.queryByRole("img", { name: "pixel.png" })).toBeNull();
});

it("paste_without_images_keeps_default_paste", () => {
  const client = createFakeIpcClient();
  renderComposer(client);

  expect(pasteFiles(promptBox(), [])).toBe(true);
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
});

it("dropping_oversized_png_reports_too_large", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  dropFiles(promptBox(), [oversizedPng()]);

  expect(await screen.findByText("big.png exceeds 5 MB.")).toBeTruthy();
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
});

it("dropping_text_file_reports_wrong_type", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  dropFiles(promptBox(), [textFile()]);

  expect(
    await screen.findByText(
      "notes.txt is not a PNG, JPEG, GIF, or WebP image.",
    ),
  ).toBeTruthy();
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
});

it("eleventh_image_reports_too_many", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderWithServices(
    <PromptInput
      value=""
      onChange={() => undefined}
      placeholder={PROMPT_PLACEHOLDER}
      cwd={undefined}
      attachments={attachmentViews(MAX_ATTACHMENTS)}
      onAttachmentsChange={() => undefined}
      generation={0}
      onPendingChange={() => undefined}
      imageInput
      providerLabel="Claude"
    />,
    client,
    staticStore(composerState()),
  );

  pasteFiles(screen.getByPlaceholderText(PROMPT_PLACEHOLDER), [pngFile()]);

  expect(
    await screen.findByText("You can attach up to 10 images per prompt."),
  ).toBeTruthy();
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
});

it("failed_stage_reports_attach_error", async () => {
  const client = createFakeIpcClient();
  client.fail("attachments/stage", new Error("disk full"));
  renderComposer(client);

  pasteFiles(promptBox(), [pngFile()]);

  expect(await screen.findByText("Could not attach pixel.png.")).toBeTruthy();
});

it("dismiss_error_clears_it", async () => {
  const client = createFakeIpcClient();
  client.fail("attachments/stage", new Error("disk full"));
  renderComposer(client);

  pasteFiles(promptBox(), [pngFile()]);
  await screen.findByText("Could not attach pixel.png.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

  expect(screen.queryByRole("alert")).toBeNull();
});

it("remove_deletes_chip", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  pasteFiles(promptBox(), [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Remove pixel.png" }));

  await waitFor(() => {
    expect(screen.queryByRole("img", { name: "pixel.png" })).toBeNull();
  });
});

it("unsupported_agent_disables_send_until_images_removed", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client, {
    activeProvider: ProviderId.gemini,
    imageInput: false,
  });
  const box = promptBox();

  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  expect(
    screen.getByText(
      "Gemini cannot read images. Remove them or switch agents to send.",
    ),
  ).toBeTruthy();
  typeInto(box, "hello");
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  expect(send.disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Remove pixel.png" }));
  await waitFor(() => {
    expect(send.disabled).toBe(false);
  });
});

function startState(accounts: Parameters<typeof makeAccount>[0][]): AppState {
  return readyState(
    makeSnapshot({
      sessions: [],
      accounts: accounts.map((overrides) => makeAccount(overrides)),
    }),
  );
}

it("start_with_gemini_selected_disables_start", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      startState([
        { id: "acc-claude" },
        { id: "acc-gemini", provider: ProviderId.gemini },
      ]),
    ),
  );

  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: ProviderId.gemini },
  });
  const box = taskBox();
  typeInto(box, "Fix the build");
  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });

  const start = screen.getByRole<HTMLButtonElement>("button", {
    name: "Start",
  });
  expect(start.disabled).toBe(true);
});

it("start_with_claude_sends_attachments", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  client.respond("session/start", makeSession({ id: "sess-9", cwd: CWD }));
  client.respond("session/prompt", { accepted: true });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      startState([
        { id: "acc-claude" },
        { id: "acc-gemini", provider: ProviderId.gemini },
      ]),
    ),
  );

  const box = taskBox();
  typeInto(box, "Fix the build");
  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-9", text: "Fix the build", attachments: staged },
    ]);
  });
});

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

it("resume_composer_sends_attachments", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  client.respond("session/resume", makeSession({ id: PAST_ID, cwd: CWD }));
  client.respond("session/prompt", { accepted: true });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(resumeState(ProviderId.claude)),
  );

  const box = promptBox();
  typeInto(box, "continue");
  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: PAST_ID, text: "continue", attachments: staged },
    ]);
  });
});

it("resume_with_gemini_disables_send", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(resumeState(ProviderId.gemini)),
  );
  const box = promptBox();

  typeInto(box, "continue");
  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });

  expect(
    screen.getByText(
      "Gemini cannot read images. Remove them or switch agents to send.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
  ).toBe(true);
});

it("prompt_card_shows_attachment_thumbnails", async () => {
  const attachment: AttachmentView = {
    id: "ab".repeat(32),
    name: "diagram.png",
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
  const client = createFakeIpcClient();
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(
        makeSnapshot({
          sessions: [
            makeSession({
              cwd: CWD,
              prompts: [
                makePrompt({ seq: 0, text: "look", attachments: [attachment] }),
              ],
            }),
          ],
          accounts: [makeAccount()],
        }),
      ),
    ),
  );

  const image = await screen.findByRole("img", { name: "diagram.png" });
  expect(image.getAttribute("src")).toBe(PNG_DATA_URL);
  expect(client.requests).toContainEqual({
    method: "attachments/get",
    params: { sessionId: "sess-1", id: attachment.id },
  });
  const promptCard = screen.getByRole("listitem", { name: "You" });
  expect(within(promptCard).getByRole("img", { name: "diagram.png" })).toBe(
    image,
  );
});

it("failed_thumbnail_load_shows_the_name", async () => {
  const attachment: AttachmentView = {
    id: "cd".repeat(32),
    name: "broken.png",
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
  const client = createFakeIpcClient();
  client.fail("attachments/get", new Error("missing"));
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(
        makeSnapshot({
          sessions: [
            makeSession({
              cwd: CWD,
              prompts: [
                makePrompt({ seq: 0, text: "look", attachments: [attachment] }),
              ],
            }),
          ],
          accounts: [makeAccount()],
        }),
      ),
    ),
  );

  expect(await screen.findByText("broken.png")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "broken.png" })).toBeNull();
});

interface DeferredStage {
  readonly name: string;
  readonly resolve: (view: AttachmentView) => void;
}

function deferStages(client: FakeIpcClient): DeferredStage[] {
  const pending: DeferredStage[] = [];
  client.on(
    "attachments/stage",
    (params) =>
      new Promise((resolve) => {
        pending.push({ name: params.name, resolve });
      }),
  );
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  return pending;
}

function viewOf(name: string): AttachmentView {
  return {
    id: nextAttachmentId(),
    name,
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
}

async function resolveStage(
  stage: DeferredStage | undefined,
  name: string,
): Promise<void> {
  await act(async () => {
    stage?.resolve(viewOf(name));
    await Promise.resolve();
  });
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

it("sent_chip_is_not_restored_by_late_stage", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "go");
  await act(async () => {
    pasteFiles(box, [pngFile("late.png")]);
    fireEvent.keyDown(box, { key: "Enter" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(box.value).toBe("");
  });
  await resolveStage(stages[0], "late.png");

  expect(screen.queryByRole("img", { name: "late.png" })).toBeNull();
});

it("concurrent_pastes_keep_all_images", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  renderComposer(client);
  const box = promptBox();

  pasteFiles(box, [pngFile("first.png")]);
  pasteFiles(box, [pngFile("second.png")]);
  await waitFor(() => {
    expect(stages).toHaveLength(2);
  });
  await resolveStage(stages[1], "second.png");
  await resolveStage(stages[0], "first.png");

  expect(await screen.findByRole("img", { name: "first.png" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "second.png" })).toBeTruthy();
});

it("image_limit_counts_pending_stages", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);
  const box = promptBox();

  for (let index = 0; index < MAX_ATTACHMENTS - 1; index += 1) {
    const name = `shot-${index.toString()}.png`;
    pasteFiles(box, [pngFile(name)]);
    await screen.findByRole("img", { name });
  }

  const stages = deferStages(client);
  pasteFiles(box, [pngFile("first.png")]);
  await waitFor(() => {
    expect(stages).toHaveLength(1);
  });
  pasteFiles(box, [pngFile("second.png")]);

  expect(
    await screen.findByText("You can attach up to 10 images per prompt."),
  ).toBeTruthy();
  expect(stages).toHaveLength(1);
});

it("send_disabled_while_staging", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "go");
  pasteFiles(box, [pngFile()]);
  await waitFor(() => {
    expect(stages).toHaveLength(1);
  });
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  expect(send.disabled).toBe(true);

  await resolveStage(stages[0], "pixel.png");
  await screen.findByRole("img", { name: "pixel.png" });
  await waitFor(() => {
    expect(send.disabled).toBe(false);
  });
});

it("ime_enter_does_not_select_or_send", async () => {
  const client = createFakeIpcClient();
  client.respond("session/prompt", { accepted: true });
  completeWith(client, [{ path: "src", kind: "dir" }]);
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "@sr");
  await screen.findByRole("option", { name: "src/" });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(box.value).toBe("@sr");
  expect(screen.getByRole("option", { name: "src/" })).toBeTruthy();

  typeInto(box, "hello");
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(promptRequests(client)).toEqual([]);
});

it("failed_start_prompt_keeps_attachments_in_session_composer", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
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

  typeInto(taskBox(), "Fix the build");
  pasteFiles(taskBox(), [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => {
    expect(promptBox().value).toBe("Fix the build");
  });
  expect(screen.getByRole("img", { name: "pixel.png" })).toBeTruthy();
  expect(staged).toHaveLength(1);
});

it("failed_resume_keeps_attachments", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  client.respond("session/resume", makeSession({ id: PAST_ID, cwd: CWD }));
  client.fail("session/prompt", new Error("busy"));
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(resumeState(ProviderId.claude)),
  );
  const box = promptBox();

  typeInto(box, "continue");
  pasteFiles(box, [pngFile()]);
  await screen.findByRole("img", { name: "pixel.png" });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(screen.getByText("busy")).toBeTruthy();
  });
  expect(await screen.findByRole("img", { name: "pixel.png" })).toBeTruthy();
});

it("start_prompt_completes_in_default_workspace", async () => {
  const client = createFakeIpcClient();
  completeWith(client, [{ path: "src", kind: "dir" }]);
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

  typeInto(taskBox(), "@sr");

  await screen.findByRole("option", { name: "src/" });
  expect(completionRequests(client)).toEqual([
    { cwd: "/home/user/workspace", query: "sr" },
  ]);
});

it("text_drop_keeps_default_behaviour", () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  const notCancelled = fireEvent.drop(promptBox(), {
    dataTransfer: { files: [], types: ["text/plain"] },
  });

  expect(notCancelled).toBe(true);
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
});

it("thumbnail_cache_evicts_by_size", async () => {
  const HUGE_BASE64_CHARS = 20 * 1024 * 1024;
  const first: AttachmentView = {
    id: "aa".repeat(32),
    name: "first-huge.png",
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
  const second: AttachmentView = {
    id: "bb".repeat(32),
    name: "second-huge.png",
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
  const client = createFakeIpcClient();
  client.on("attachments/get", () => ({
    mimeType: ImageMimeType.png,
    dataBase64: "A".repeat(HUGE_BASE64_CHARS),
  }));
  const stateWith = (attachments: readonly AttachmentView[]): AppState =>
    readyState(
      makeSnapshot({
        sessions: [
          makeSession({
            cwd: CWD,
            prompts: [
              makePrompt({
                seq: 0,
                text: "look",
                attachments: [...attachments],
              }),
            ],
          }),
        ],
        accounts: [makeAccount()],
      }),
    );
  const requestsFor = (id: string): number =>
    client.requests.filter(
      (request) =>
        request.method === "attachments/get" &&
        (request.params as { id: string }).id === id,
    ).length;

  renderWithServices(
    <SessionStream />,
    client,
    staticStore(stateWith([first, second])),
  );
  await screen.findByRole("img", { name: "first-huge.png" });
  await screen.findByRole("img", { name: "second-huge.png" });
  expect(requestsFor(first.id)).toBe(1);

  cleanup();
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(stateWith([first])),
  );
  await screen.findByRole("img", { name: "first-huge.png" });

  expect(requestsFor(first.id)).toBe(2);
});

function ThumbnailHarness({
  attachment,
}: {
  readonly attachment: AttachmentView;
}): JSX.Element {
  const [revision, setRevision] = useState(0);
  return (
    <div>
      <AttachmentThumbnail attachment={attachment} />
      <button
        type="button"
        onClick={() => {
          setRevision((current) => current + 1);
        }}
      >
        {`Refresh ${revision.toString()}`}
      </button>
    </div>
  );
}

it("rejected_files_do_not_take_image_slots", async () => {
  const client = createFakeIpcClient();
  const staged: AttachmentView[] = [];
  wireAttachments(client, staged);
  renderComposer(client);

  const files = [
    textFile(),
    ...Array.from({ length: MAX_ATTACHMENTS }, (_, index) =>
      pngFile(`shot-${index.toString()}.png`),
    ),
  ];
  dropFiles(promptBox(), files);

  await waitFor(() => {
    expect(screen.getAllByRole("img")).toHaveLength(MAX_ATTACHMENTS);
  });
  expect(
    screen.queryByText("You can attach up to 10 images per prompt."),
  ).toBeNull();
});

it("thumbnail_survives_cache_eviction", () => {
  const attachment: AttachmentView = {
    id: "fa".repeat(32),
    name: "survivor.png",
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
  const client = createFakeIpcClient();
  thumbnailCache.set(attachment.id, PNG_DATA_URL);
  renderWithServices(
    <ThumbnailHarness attachment={attachment} />,
    client,
    staticStore(composerState()),
  );

  const image = screen.getByRole("img", { name: "survivor.png" });
  expect(image.getAttribute("src")).toBe(PNG_DATA_URL);

  const filler = "x".repeat(17 * 1024 * 1024);
  thumbnailCache.set("acceptance-filler-a", filler);
  thumbnailCache.set("acceptance-filler-b", filler);
  expect(thumbnailCache.get(attachment.id)).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

  const survivor = screen.getByRole("img", { name: "survivor.png" });
  expect(survivor.getAttribute("src")).toBe(PNG_DATA_URL);
});
