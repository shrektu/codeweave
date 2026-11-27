import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { ImageMimeType } from "../../src/domain/attachments";
import {
  DefinitionSource,
  PermissionProfile,
  ProviderId,
  SlashCommandKind,
} from "../../src/domain/types";
import { Composer } from "../../src/renderer/components/Composer";
import { SessionStream } from "../../src/renderer/components/SessionStream";
import type { AppState, AppStore } from "../../src/renderer/store";
import type { AttachmentView, SlashCommandView } from "../../src/shared/views";
import {
  createFakeIpcClient,
  makeAccount,
  makeHistoryEntry,
  makePrompt,
  makeRestorePlan,
  makeSession,
  makeSnapshot,
  makeStoredSession,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";
import { makeCodeweaveApi } from "../fakes/fakeCodeweaveApi";

const CWD = "/home/user/project";
const PROMPT_PLACEHOLDER = "Describe the task";
const TASK_PLACEHOLDER = "What should the agent do?";
const SLASH_LIST = "Slash commands";
const PAST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const OLD_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_LATER = 1_700_000_200_000;
const UPDATED_EARLIER = 1_700_000_100_000;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  warn.mockRestore();
});

function libraryCommand(
  overrides: Partial<SlashCommandView> = {},
): SlashCommandView {
  return {
    name: "review",
    description: "Review changed files",
    kind: SlashCommandKind.prompt,
    source: DefinitionSource.project,
    file: "prompts/review.md",
    body: "Review the diff.",
    ...overrides,
  };
}

function commandsWith(
  commands: readonly SlashCommandView[],
  errors: readonly {
    file: string;
    source: DefinitionSource;
    messages: string[];
  }[] = [],
): {
  commands: SlashCommandView[];
  errors: { file: string; source: DefinitionSource; messages: string[] }[];
} {
  return { commands: [...commands], errors: [...errors] };
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
  state: AppState = composerState(),
): void {
  renderWithServices(<Composer />, client, staticStore(state));
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(PROMPT_PLACEHOLDER);
}

function taskBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(TASK_PLACEHOLDER);
}

function modelInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Model override");
}

function typeInto(box: HTMLTextAreaElement, value: string): void {
  fireEvent.change(box, { target: { value } });
}

function promptRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "session/prompt")
    .map((request) => request.params);
}

function commandRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "commands/list")
    .map((request) => request.params);
}

function optionLabels(list: HTMLElement): (string | null)[] {
  return within(list)
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));
}

interface Recording {
  readonly store: AppStore;
  readonly activated: (string | null)[];
}

function recordingStore(initial: AppState): Recording {
  const activated: (string | null)[] = [];
  return {
    activated,
    store: {
      ...staticStore(initial),
      activateSession: (sessionId) => {
        activated.push(sessionId);
      },
    },
  };
}

function resumeState(): AppState {
  const entry = makeHistoryEntry({ id: PAST_ID, cwd: CWD });
  const stored = makeStoredSession({
    id: PAST_ID,
    cwd: CWD,
    prompts: [makePrompt({ seq: 0, text: "old prompt" })],
  });
  return {
    ...readyState(makeSnapshot({ sessions: [], accounts: [makeAccount()] })),
    activeSessionId: PAST_ID,
    history: [entry],
    historyTranscripts: { [PAST_ID]: stored },
  };
}

it("slash_at_start_lists_builtins_and_library_commands", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([
      libraryCommand({ name: "review", description: "Review changed files" }),
      libraryCommand({
        name: "preview",
        description: "Show the file",
        kind: SlashCommandKind.skill,
        source: DefinitionSource.library,
        file: "skills/preview.md",
      }),
    ]),
  );
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/");

  const list = await screen.findByRole("listbox", { name: SLASH_LIST });
  expect(optionLabels(list)).toEqual([
    "/clear",
    "/model",
    "/resume",
    "/review",
    "/preview",
  ]);
  const review = within(list).getByRole("option", { name: "/review" });
  expect(within(review).getByText("Prompt")).toBeTruthy();
  expect(within(review).getByText("Project")).toBeTruthy();
  const preview = within(list).getByRole("option", { name: "/preview" });
  expect(within(preview).getByText("Skill")).toBeTruthy();
  expect(within(preview).getByText("Library")).toBeTruthy();

  typeInto(box, "/re");

  expect(optionLabels(list)).toEqual(["/resume", "/review", "/preview"]);
});

it("slash_mid_text_opens_nothing", async () => {
  const client = createFakeIpcClient();
  client.respond("files/complete", {
    items: [{ path: "src", kind: "dir" }],
  });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "fix /re");

  expect(screen.queryByRole("listbox")).toBeNull();
  expect(commandRequests(client)).toEqual([]);

  typeInto(box, "fix @sr");

  expect(await screen.findByRole("option", { name: "src/" })).toBeTruthy();
});

it("saved_prompt_expands_arguments_on_send", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([
      libraryCommand({ body: "Review $ARGUMENTS and $ARGUMENTS" }),
    ]),
  );
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/rev");
  await screen.findByRole("option", { name: "/review" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe("/review ");
  });

  typeInto(box, "/review src/a.ts");
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "Review src/a.ts and src/a.ts" },
    ]);
  });
});

it("prompt_without_placeholder_appends_arguments", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([libraryCommand({ body: "Review the diff." })]),
  );
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/review src/b.ts");
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "Review the diff.\n\nsrc/b.ts" },
    ]);
  });
});

it("unknown_slash_text_is_sent_unchanged", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", commandsWith([]));
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/unknown thing");
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "/unknown thing" },
    ]);
  });
  expect(commandRequests(client)).toEqual([{ cwd: CWD }]);
});

it("clear_starts_a_new_session_and_activates_it", async () => {
  const client = createFakeIpcClient();
  client.respond("session/start", makeSession({ id: "sess-2" }));
  const recording = recordingStore(composerState());
  renderWithServices(<Composer />, client, recording.store);
  const box = promptBox();

  typeInto(box, "/clear");
  await screen.findByRole("option", { name: "/clear" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(recording.activated).toEqual(["sess-2"]);
  });
  expect(client.requests).toContainEqual({
    method: "session/start",
    params: {
      cwd: CWD,
      provider: ProviderId.claude,
      profile: PermissionProfile.ask,
    },
  });
  expect(promptRequests(client)).toEqual([]);
  expect(box.value).toBe("");
});

it("compact_calls_session_compact_and_hides_without_support", async () => {
  const client = createFakeIpcClient();
  client.respond("session/compact", { accepted: true });
  renderComposer(client, composerState({ canCompact: true }));
  const box = promptBox();

  typeInto(box, "/compact");
  await screen.findByRole("option", { name: "/compact" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(client.requests).toContainEqual({
      method: "session/compact",
      params: { sessionId: "sess-1" },
    });
  });

  cleanup();
  const plain = createFakeIpcClient();
  renderComposer(plain);
  typeInto(promptBox(), "/");

  const list = await screen.findByRole("listbox", { name: SLASH_LIST });
  expect(within(list).queryByRole("option", { name: "/compact" })).toBeNull();
});

it("model_sets_or_focuses_the_override", async () => {
  const client = createFakeIpcClient();
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/model gpt-x");
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(modelInput().value).toBe("gpt-x");
  });
  expect(box.value).toBe("");

  cleanup();
  const focusClient = createFakeIpcClient();
  renderComposer(focusClient);
  const focusBox = promptBox();

  typeInto(focusBox, "/model");
  await screen.findByRole("option", { name: "/model" });
  fireEvent.keyDown(focusBox, { key: "Enter" });
  fireEvent.keyDown(focusBox, { key: "Enter" });

  await waitFor(() => {
    expect(document.activeElement).toBe(modelInput());
  });
});

it("resume_lists_and_activates_earlier_sessions", async () => {
  const client = createFakeIpcClient();
  const state: AppState = {
    ...composerState(),
    history: [
      makeHistoryEntry({
        id: OTHER_ID,
        title: "Older work",
        cwd: "/home/user/other",
        updatedAt: UPDATED_EARLIER,
      }),
      makeHistoryEntry({
        id: PAST_ID,
        title: "Recent work",
        cwd: CWD,
        updatedAt: UPDATED_LATER,
      }),
      makeHistoryEntry({
        id: OLD_ID,
        title: "Archived work",
        archived: true,
        updatedAt: UPDATED_LATER,
      }),
    ],
  };
  const recording = recordingStore(state);
  renderWithServices(<Composer />, client, recording.store);
  const box = promptBox();

  typeInto(box, "/resume");
  await screen.findByRole("option", { name: "/resume" });
  fireEvent.keyDown(box, { key: "Enter" });

  const list = await screen.findByRole("listbox", { name: SLASH_LIST });
  expect(optionLabels(list)).toEqual(["Recent work", "Older work"]);

  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(recording.activated).toEqual([PAST_ID]);
  });

  cleanup();
  const emptyClient = createFakeIpcClient();
  renderComposer(emptyClient);
  const emptyBox = promptBox();

  typeInto(emptyBox, "/resume");
  await screen.findByRole("option", { name: "/resume" });
  fireEvent.keyDown(emptyBox, { key: "Enter" });

  const emptyList = await screen.findByRole("listbox", { name: SLASH_LIST });
  expect(within(emptyList).getByText("No earlier sessions")).toBeTruthy();
});

it("rewind_opens_the_dialog_for_the_latest_prompt", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    makeRestorePlan({ sessionId: "sess-1", promptSeq: 1 }),
  );
  const prompts = [
    makePrompt({ seq: 0, text: "first prompt" }),
    makePrompt({ seq: 1, text: "second prompt" }),
  ];
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(
        makeSnapshot({
          sessions: [makeSession({ cwd: CWD, prompts })],
          accounts: [makeAccount()],
        }),
      ),
    ),
  );
  const box = promptBox();

  typeInto(box, "/rewind");
  await screen.findByRole("option", { name: "/rewind" });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(
    await screen.findByRole("dialog", { name: "Rewind session" }),
  ).toBeTruthy();
  expect(client.requests).toContainEqual({
    method: "session/rewindPreview",
    params: { sessionId: "sess-1", promptSeq: 1 },
  });
});

it("start_and_resume_boxes_expand_library_commands_only", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([libraryCommand({ body: "Review the diff." })]),
  );
  client.respond("session/start", makeSession({ id: "sess-9", cwd: CWD }));
  client.respond("session/prompt", { accepted: true });
  renderWithServices(
    <SessionStream />,
    client,
    staticStore(
      readyState(makeSnapshot({ sessions: [], accounts: [makeAccount()] })),
    ),
  );

  typeInto(taskBox(), "/rev");

  const list = await screen.findByRole("listbox", { name: SLASH_LIST });
  expect(optionLabels(list)).toEqual(["/review"]);

  fireEvent.keyDown(taskBox(), { key: "Escape" });
  typeInto(taskBox(), "/review src/a.ts");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-9", text: "Review the diff.\n\nsrc/a.ts" },
    ]);
  });

  cleanup();
  const resumeClient = createFakeIpcClient();
  resumeClient.respond(
    "commands/list",
    commandsWith([libraryCommand({ body: "Review the diff." })]),
  );
  resumeClient.respond(
    "session/resume",
    makeSession({ id: PAST_ID, cwd: CWD }),
  );
  resumeClient.respond("session/prompt", { accepted: true });
  renderWithServices(
    <SessionStream />,
    resumeClient,
    staticStore(resumeState()),
  );
  const box = promptBox();

  typeInto(box, "/review src/c.ts");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(promptRequests(resumeClient)).toEqual([
      { sessionId: PAST_ID, text: "Review the diff.\n\nsrc/c.ts" },
    ]);
  });
});

it("keyboard_and_ime_follow_the_mention_rules", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([
      libraryCommand({ name: "review" }),
      libraryCommand({ name: "recap", file: "prompts/recap.md" }),
    ]),
  );
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/re");
  await screen.findByRole("option", { name: "/review" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "Tab" });

  await waitFor(() => {
    expect(box.value).toBe("/recap ");
  });

  typeInto(box, "/re");
  await screen.findByRole("listbox", { name: SLASH_LIST });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();

  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "/re" },
    ]);
  });

  typeInto(box, "/review");
  await screen.findByRole("option", { name: "/review" });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });

  expect(box.value).toBe("/review");
  expect(promptRequests(client)).toHaveLength(1);
});

it("builtin_failure_keeps_the_text_and_shows_the_error", async () => {
  const client = createFakeIpcClient();
  client.fail("session/compact", new Error("busy"));
  renderComposer(client, composerState({ canCompact: true }));
  const box = promptBox();

  typeInto(box, "/compact");
  await screen.findByRole("option", { name: "/compact" });
  fireEvent.keyDown(box, { key: "Escape" });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(await screen.findByText("Could not compact: busy")).toBeTruthy();
  expect(box.value).toBe("/compact");
});

it("send_resolves_with_fresh_commands_when_the_menu_never_opened", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "commands/list",
    commandsWith([libraryCommand({ body: "Review $ARGUMENTS" })]),
  );
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/review src/a.ts");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "Review src/a.ts" },
    ]);
  });
  expect(commandRequests(client)).toEqual([{ cwd: CWD }]);
});

it("slash_menu_reopens_after_escape_and_retype", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", commandsWith([]));
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/");
  await screen.findByRole("listbox", { name: SLASH_LIST });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();

  typeInto(box, "");
  typeInto(box, "hello");
  typeInto(box, "");
  typeInto(box, "/");

  expect(await screen.findByRole("listbox", { name: SLASH_LIST })).toBeTruthy();
});

it("unknown_command_sent_with_enter", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", commandsWith([]));
  client.respond("session/prompt", { accepted: true });
  renderComposer(client);
  const box = promptBox();

  typeInto(box, "/foo");
  await screen.findByRole("listbox", { name: SLASH_LIST });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(promptRequests(client)).toEqual([
      { sessionId: "sess-1", text: "/foo" },
    ]);
  });
});

it("compact_failure_from_the_menu_keeps_the_text", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", commandsWith([]));
  client.fail("session/compact", new Error("busy"));
  renderComposer(client, composerState({ canCompact: true }));
  const box = promptBox();

  typeInto(box, "/compact");
  await screen.findByRole("option", { name: "/compact" });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(await screen.findByText("Could not compact: busy")).toBeTruthy();
  expect(box.value).toBe("/compact");
});

it("typed_model_command_keeps_the_pasted_image", async () => {
  const client = createFakeIpcClient();
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  const attachment: AttachmentView = {
    id: "ab".repeat(32),
    name: "shot.png",
    mimeType: ImageMimeType.png,
    bytes: 8,
  };
  renderWithServices(
    <Composer initialAttachments={[attachment]} />,
    client,
    staticStore(composerState()),
  );
  const box = promptBox();

  typeInto(box, "/model gpt-x");
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(modelInput().value).toBe("gpt-x");
  });
  expect(
    screen.queryByRole("list", { name: "Attached images" }),
  ).not.toBeNull();
});
