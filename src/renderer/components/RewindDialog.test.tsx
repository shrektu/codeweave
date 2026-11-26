import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RestoreAction, RestoreSkipReason } from "../../domain/checkpoints";
import type { RestorePlanView } from "../../shared/views";
import { RewindDialog } from "./RewindDialog";
import { makeCodeweaveApi } from "../../../tests/fakes/fakeCodeweaveApi";
import {
  createFakeIpcClient,
  makeAccount,
  makePrompt,
  makeRestorePlan,
  makeRewindResult,
  makeSnapshot,
  readyState,
  renderWithServices,
  staticStore,
  type FakeIpcClient,
} from "../../../tests/fakes/fakeIpcClient";

const SESSION_ID = "sess-1";
const PROMPT = makePrompt({ seq: 3, text: "third prompt" });
const CONFLICT = "/work/conflict.txt";
const UNVERIFIABLE = "/work/unverifiable.txt";
const BINARY = "/work/binary.bin";
const PROTECTED = "/work/protected.txt";

beforeEach(() => {
  window.codeweave = makeCodeweaveApi();
});

afterEach(cleanup);

function plan(files: RestorePlanView["files"]): RestorePlanView {
  return makeRestorePlan({
    sessionId: SESSION_ID,
    promptSeq: PROMPT.seq,
    files,
  });
}

function renderDialog(
  client: FakeIpcClient,
  onClose: () => void = vi.fn<() => void>(),
): void {
  renderWithServices(
    <RewindDialog
      sessionId={SESSION_ID}
      prompt={PROMPT}
      onClose={onClose}
      onRewound={vi.fn()}
    />,
    client,
    staticStore(readyState(makeSnapshot({ accounts: [makeAccount()] }))),
  );
}

it("lists unrestorable files with their reason", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    plan([
      {
        path: BINARY,
        action: RestoreAction.none,
        skip: RestoreSkipReason.binary,
      },
      {
        path: PROTECTED,
        action: RestoreAction.none,
        skip: RestoreSkipReason.protected,
      },
    ]),
  );
  renderDialog(client);

  expect(await screen.findByText(BINARY)).toBeTruthy();
  expect(screen.getByText("Binary file")).toBeTruthy();
  expect(screen.getByText(PROTECTED)).toBeTruthy();
  expect(
    screen.getByText(
      "Protected location (such as app data or account folders).",
    ),
  ).toBeTruthy();
});

it("hides file sections in conversation only mode", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    plan([
      { path: "/work/restored.txt", action: RestoreAction.write, skip: null },
    ]),
  );
  renderDialog(client);

  expect(await screen.findByText("Files to restore")).toBeTruthy();
  fireEvent.click(screen.getByText("Conversation only"));
  expect(screen.queryByText("Files to restore")).toBeNull();
  expect(screen.queryByText("Files changed outside the agent")).toBeNull();
});

it("sends only ticked conflict paths", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    plan([
      {
        path: CONFLICT,
        action: RestoreAction.write,
        skip: RestoreSkipReason.conflict,
      },
      {
        path: UNVERIFIABLE,
        action: RestoreAction.write,
        skip: RestoreSkipReason.unverifiable,
      },
    ]),
  );
  client.respond("session/rewind", makeRewindResult());
  renderDialog(client);

  const boxes = await screen.findAllByRole("checkbox");
  const second = boxes[1];
  if (second === undefined) {
    throw new Error("no second checkbox");
  }
  fireEvent.click(second);
  fireEvent.click(screen.getByRole("button", { name: "Rewind" }));

  expect(client.requests).toContainEqual({
    method: "session/rewind",
    params: {
      sessionId: SESSION_ID,
      promptSeq: PROMPT.seq,
      mode: "conversation_and_files",
      overwrite: [UNVERIFIABLE],
    },
  });
});

it("keeps the dialog open when rewind fails", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    plan([
      { path: "/work/restored.txt", action: RestoreAction.write, skip: null },
    ]),
  );
  client.fail("session/rewind", new Error("Rewind failed"));
  renderDialog(client);

  fireEvent.click(await screen.findByRole("button", { name: "Rewind" }));

  expect(await screen.findByText("Rewind failed")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("shows noFiles when the plan is empty", async () => {
  const client = createFakeIpcClient();
  client.respond("session/rewindPreview", plan([]));
  renderDialog(client);

  expect(
    await screen.findByText("No recorded file edits since this prompt."),
  ).toBeTruthy();
  expect(screen.queryByText("Files to restore")).toBeNull();
});

it("cancel is disabled while the rewind is pending", async () => {
  const client = createFakeIpcClient();
  client.respond(
    "session/rewindPreview",
    plan([
      { path: "/work/restored.txt", action: RestoreAction.write, skip: null },
    ]),
  );
  const gate = Promise.withResolvers<undefined>();
  client.on("session/rewind", () =>
    gate.promise.then(() => makeRewindResult()),
  );
  const onClose = vi.fn<() => void>();
  renderDialog(client, onClose);

  fireEvent.click(await screen.findByRole("button", { name: "Rewind" }));

  const cancel = screen.getByRole<HTMLButtonElement>("button", {
    name: "Cancel",
  });
  const close = screen.getByRole<HTMLButtonElement>("button", {
    name: "Close",
  });
  await waitFor(() => {
    expect(cancel.disabled).toBe(true);
    expect(close.disabled).toBe(true);
  });

  fireEvent.click(cancel);
  fireEvent.click(close);
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );

  expect(onClose).not.toHaveBeenCalled();
  gate.resolve(undefined);
});
