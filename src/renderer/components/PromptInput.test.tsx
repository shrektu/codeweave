import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type JSX } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { ImageMimeType } from "../../domain/attachments";
import { DefinitionSource } from "../../domain/types";
import { thumbnailCache } from "../attachments";
import type { AttachmentView, FileCompletionItem } from "../../shared/views";
import {
  createFakeIpcClient,
  makeSession,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../../../tests/fakes/fakeIpcClient";

import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { Composer } from "./Composer";
import { PromptInput } from "./PromptInput";
import type { SlashBuiltin } from "../slashCommands";

const PROMPT_PLACEHOLDER = "Describe the task";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const EXISTING_BYTES = 8;

let attachmentSeq = 0;

afterEach(cleanup);

function textFile(): File {
  return new File(["notes"], "notes.txt", { type: "text/plain" });
}

function pngFile(name: string): File {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: ImageMimeType.png });
}

function attachmentView(name: string): AttachmentView {
  attachmentSeq += 1;
  return {
    id: attachmentSeq.toString(16).padStart(64, "0"),
    name,
    mimeType: ImageMimeType.png,
    bytes: EXISTING_BYTES,
  };
}

function attachmentViews(count: number): readonly AttachmentView[] {
  return Array.from({ length: count }, (_, index) =>
    attachmentView(`shot-${index.toString()}.png`),
  );
}

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
        pending.push({
          name: params.name,
          resolve,
        });
      }),
  );
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  return pending;
}

function stageImmediately(client: FakeIpcClient): void {
  client.on("attachments/stage", (params) => attachmentView(params.name));
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
}

function PromptHarness({
  initialAttachments = [],
  onSubmit,
  builtins,
}: {
  readonly initialAttachments?: readonly AttachmentView[];
  readonly onSubmit?: (() => void) | undefined;
  readonly builtins?: readonly SlashBuiltin[] | undefined;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] =
    useState<readonly AttachmentView[]>(initialAttachments);
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  return (
    <div>
      <PromptInput
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder={PROMPT_PLACEHOLDER}
        cwd={undefined}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        generation={generation}
        onPendingChange={setPending}
        imageInput
        providerLabel="Claude"
        builtins={builtins}
      />
      <button
        type="button"
        onClick={() => {
          setAttachments([]);
          setGeneration((current) => current + 1);
        }}
      >
        Clear attachments
      </button>
      <output>{pending ? "staging" : "idle"}</output>
    </div>
  );
}

function renderHarness(
  client: FakeIpcClient,
  initialAttachments: readonly AttachmentView[] = [],
  onSubmit?: () => void,
): void {
  renderWithServices(
    <PromptHarness
      initialAttachments={initialAttachments}
      onSubmit={onSubmit}
    />,
    client,
    staticStore(readyState(makeSnapshot())),
  );
}

function promptBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText<HTMLTextAreaElement>(PROMPT_PLACEHOLDER);
}

function pasteFile(name: string): void {
  fireEvent.paste(promptBox(), { clipboardData: { files: [pngFile(name)] } });
}

async function resolveStage(
  stage: DeferredStage | undefined,
  name: string,
): Promise<void> {
  await act(async () => {
    stage?.resolve(attachmentView(name));
    await Promise.resolve();
  });
}

it("sent_chip_is_not_restored_by_late_stage", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  renderHarness(client);

  pasteFile("late.png");
  await waitFor(() => {
    expect(stages).toHaveLength(1);
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear attachments" }));
  await resolveStage(stages[0], "late.png");

  expect(screen.queryByRole("img", { name: "late.png" })).toBeNull();
});

it("concurrent_pastes_keep_all_images", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  renderHarness(client);

  pasteFile("first.png");
  pasteFile("second.png");
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
  const stages = deferStages(client);
  renderHarness(client, attachmentViews(9));

  pasteFile("first.png");
  await waitFor(() => {
    expect(stages).toHaveLength(1);
  });
  pasteFile("second.png");

  expect(
    await screen.findByText("You can attach up to 10 images per prompt."),
  ).toBeTruthy();
  expect(stages).toHaveLength(1);
});

it("send_disabled_while_staging", async () => {
  const client = createFakeIpcClient();
  const stages = deferStages(client);
  renderHarness(client);

  pasteFile("slow.png");
  await waitFor(() => {
    expect(stages).toHaveLength(1);
  });
  expect(screen.getByText("staging")).toBeTruthy();

  await resolveStage(stages[0], "slow.png");
  await waitFor(() => {
    expect(screen.getByText("idle")).toBeTruthy();
  });
});

it("ime_enter_does_not_select_or_send", async () => {
  const client = createFakeIpcClient();
  const items: readonly FileCompletionItem[] = [{ path: "src", kind: "dir" }];
  client.respond("files/complete", { items: [...items] });
  const onSubmit = vi.fn<() => void>();
  renderHarness(client, [], onSubmit);
  const box = promptBox();

  fireEvent.change(box, { target: { value: "@sr" } });
  await screen.findByRole("option", { name: "src/" });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(box.value).toBe("@sr");
  expect(screen.getByRole("option", { name: "src/" })).toBeTruthy();

  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(onSubmit).not.toHaveBeenCalled();
});

it("text_drop_keeps_default_behaviour", () => {
  const client = createFakeIpcClient();
  stageImmediately(client);
  renderHarness(client);

  const notCancelled = fireEvent.drop(promptBox(), {
    dataTransfer: { files: [], types: ["text/plain"] },
  });

  expect(notCancelled).toBe(true);
  expect(
    client.requests.filter((request) => request.method === "attachments/stage"),
  ).toEqual([]);
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
  stageImmediately(client);
  renderHarness(client);

  const files = [
    textFile(),
    ...Array.from({ length: 10 }, (_, index) =>
      pngFile(`shot-${index.toString()}.png`),
    ),
  ];
  fireEvent.drop(promptBox(), { dataTransfer: { files, types: ["Files"] } });

  await waitFor(() => {
    expect(screen.getAllByRole("img")).toHaveLength(10);
  });
  expect(
    screen.queryByText("You can attach up to 10 images per prompt."),
  ).toBeNull();
});

it("thumbnail_survives_cache_eviction", () => {
  const attachment = attachmentView("survivor.png");
  const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
  const client = createFakeIpcClient();
  thumbnailCache.set(attachment.id, dataUrl);
  renderWithServices(
    <ThumbnailHarness attachment={attachment} />,
    client,
    staticStore(readyState(makeSnapshot())),
  );

  const image = screen.getByRole("img", { name: "survivor.png" });
  expect(image.getAttribute("src")).toBe(dataUrl);

  const filler = "x".repeat(17 * 1024 * 1024);
  thumbnailCache.set("filler-a", filler);
  thumbnailCache.set("filler-b", filler);
  expect(thumbnailCache.get(attachment.id)).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

  const survivor = screen.getByRole("img", { name: "survivor.png" });
  expect(survivor.getAttribute("src")).toBe(dataUrl);
});

const CLEAR_BUILTIN: SlashBuiltin = {
  name: "clear",
  description: "New session in this folder",
  run: () => true,
};

const SLASH_LIST_LABEL = "Slash commands";

function renderSlashHarness(
  client: FakeIpcClient,
  builtins: readonly SlashBuiltin[],
): void {
  renderWithServices(
    <PromptHarness builtins={builtins} />,
    client,
    staticStore(readyState(makeSnapshot())),
  );
}

function slashCommandRequests(client: FakeIpcClient): unknown[] {
  return client.requests
    .filter((request) => request.method === "commands/list")
    .map((request) => request.params);
}

it("leading_whitespace_does_not_open_the_menu", () => {
  const client = createFakeIpcClient();
  renderSlashHarness(client, [CLEAR_BUILTIN]);

  fireEvent.change(promptBox(), { target: { value: " /re" } });

  expect(screen.queryByRole("listbox")).toBeNull();
  expect(slashCommandRequests(client)).toEqual([]);
});

it("caret_after_the_first_space_closes_the_command_list", async () => {
  const client = createFakeIpcClient();
  renderSlashHarness(client, [CLEAR_BUILTIN]);
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/re" } });
  expect(
    await screen.findByRole("listbox", { name: SLASH_LIST_LABEL }),
  ).toBeTruthy();

  fireEvent.change(box, { target: { value: "/re " } });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("commands_list_failure_shows_builtins_only", async () => {
  const client = createFakeIpcClient();
  client.fail("commands/list", new Error("boom"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  renderSlashHarness(client, [CLEAR_BUILTIN]);

  fireEvent.change(promptBox(), { target: { value: "/" } });

  const list = await screen.findByRole("listbox", {
    name: SLASH_LIST_LABEL,
  });
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label")),
  ).toEqual(["/clear"]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("menu_refetches_commands_each_time_it_opens", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", { commands: [], errors: [] });
  renderSlashHarness(client, [CLEAR_BUILTIN]);
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/" } });
  await screen.findByRole("listbox", { name: SLASH_LIST_LABEL });
  expect(slashCommandRequests(client)).toHaveLength(1);

  fireEvent.change(box, { target: { value: "" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(box, { target: { value: "/" } });
  await screen.findByRole("listbox", { name: SLASH_LIST_LABEL });

  expect(slashCommandRequests(client)).toHaveLength(2);
});

it("empty_matches_and_errors_are_shown_as_status_lines", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", {
    commands: [],
    errors: [
      {
        file: "prompts/broken.md",
        source: DefinitionSource.project,
        messages: ["bad frontmatter"],
      },
    ],
  });
  renderSlashHarness(client, [CLEAR_BUILTIN]);

  fireEvent.change(promptBox(), { target: { value: "/zzz" } });

  const list = await screen.findByRole("listbox", {
    name: SLASH_LIST_LABEL,
  });
  expect(
    within(list).getByText("No matching commands; sending passes text as-is"),
  ).toBeTruthy();
  expect(
    within(list).getByText("1 command file could not be read and was skipped"),
  ).toBeTruthy();
  expect(within(list).queryAllByRole("option")).toHaveLength(0);
});

it("dismissed_bare_slash_reopens_after_retyping", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", { commands: [], errors: [] });
  renderSlashHarness(client, [CLEAR_BUILTIN]);
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/" } });
  await screen.findByRole("listbox", { name: SLASH_LIST_LABEL });
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();

  fireEvent.change(box, { target: { value: "" } });
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.change(box, { target: { value: "" } });
  fireEvent.change(box, { target: { value: "/" } });

  expect(
    await screen.findByRole("listbox", { name: SLASH_LIST_LABEL }),
  ).toBeTruthy();
});

it("enter_with_no_matching_command_submits", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", { commands: [], errors: [] });
  const onSubmit = vi.fn<() => void>();
  renderWithServices(
    <PromptHarness onSubmit={onSubmit} builtins={[]} />,
    client,
    staticStore(readyState(makeSnapshot())),
  );
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/foo" } });
  await screen.findByRole("listbox", { name: SLASH_LIST_LABEL });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("failed_builtin_from_the_menu_keeps_the_text", async () => {
  const client = createFakeIpcClient();
  client.respond("commands/list", { commands: [], errors: [] });
  const failing: SlashBuiltin = {
    name: "clear",
    description: "A command that fails",
    run: () => Promise.resolve(false),
  };
  renderSlashHarness(client, [failing]);
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/clear" } });
  await screen.findByRole("option", { name: "/clear" });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(box.value).toBe("/clear");
  });
});

it("model_builtin_keeps_staged_attachments", async () => {
  const client = createFakeIpcClient();
  client.respond("attachments/get", {
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  const attachment = attachmentView("shot.png");
  renderWithServices(
    <Composer initialAttachments={[attachment]} />,
    client,
    staticStore(
      readyState(
        makeSnapshot({
          sessions: [makeSession({ cwd: "/home/user/project" })],
        }),
      ),
    ),
  );
  const box = promptBox();

  fireEvent.change(box, { target: { value: "/model gpt-x" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => {
    expect(
      screen.getByLabelText<HTMLInputElement>("Model override").value,
    ).toBe("gpt-x");
  });
  expect(
    screen.queryByRole("list", { name: "Attached images" }),
  ).not.toBeNull();
});
