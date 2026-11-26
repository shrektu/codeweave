import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAccountReservations } from "../../src/backend/accountReservations";
import {
  createAttachmentStore,
  type AttachmentFs,
  type AttachmentStore,
} from "../../src/backend/attachmentStore";
import { createHandlers } from "../../src/backend/handlers";
import { createLeaseModes } from "../../src/backend/leaseModes";
import {
  createSessionService,
  type SessionService,
} from "../../src/backend/session";
import { createJsonStore } from "../../src/backend/storage";
import { ATTACHMENTS_DIR } from "../../src/backend/constants";
import type { AgentAdapter, AgentHandle } from "../../src/backend/agentAdapter";
import type { AgentEvent } from "../../src/domain/events";
import { ImageMimeType, IMAGE_MAX_BYTES } from "../../src/domain/attachments";
import type { Account } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AttachmentView } from "../../src/shared/views";
import { fakeAttachmentStore } from "../fakes/fakeAttachmentStore";
import { fakeCheckpointStore } from "../fakes/fakeCheckpointStore";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionHistory,
  fakeSessionPool,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeSecrets } from "../fakes/fakeVault";
import {
  ACCOUNT_A,
  agentOf,
  closeRigs,
  openRig,
  startParams,
  turnEnded,
  type BackendRig,
} from "../fakes/backendRig";
import { settled } from "../fakes/settle";

const END_TURN = { type: "end", stopReason: "end_turn" } as const;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

const tempDirs: string[] = [];
const services: SessionService[] = [];

afterEach(async () => {
  await closeRigs();
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function geminiAccount(): Promise<Account> {
  const configDir = await mkdtemp(join(tmpdir(), "codeweave-gemini-"));
  tempDirs.push(configDir);
  return {
    id: "gemini-a",
    provider: "gemini",
    label: "Gemini",
    configDir,
    order: 0,
  };
}

function base64Of(bytes: Buffer): string {
  return bytes.toString("base64");
}

function idOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

function gifBytes(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(4)]);
}

function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.alloc(4),
    Buffer.from("WEBP", "latin1"),
    Buffer.alloc(4),
  ]);
}

async function stage(
  rig: BackendRig,
  bytes: Buffer,
  mimeType: ImageMimeType,
  name = "photo.png",
): Promise<AttachmentView> {
  return rig.call("attachments/stage", {
    name,
    mimeType,
    dataBase64: base64Of(bytes),
  });
}

async function startedRig(
  config: { readonly imageInput?: boolean } = {},
): Promise<BackendRig> {
  const rig = await openRig({
    accounts: [ACCOUNT_A],
    claudeConfig: config,
  });
  await rig.call("session/start", startParams(rig));
  return rig;
}

describe("attachments/stage", () => {
  it("stores_each_supported_image_under_staging_with_its_sha256_id", async () => {
    const rig = await startedRig();
    const cases: readonly (readonly [Buffer, ImageMimeType, string])[] = [
      [PNG_BYTES, ImageMimeType.png, "photo.png"],
      [jpegBytes(), ImageMimeType.jpeg, "photo.jpg"],
      [gifBytes(), ImageMimeType.gif, "photo.gif"],
      [webpBytes(), ImageMimeType.webp, "photo.webp"],
    ];

    for (const [bytes, mimeType, name] of cases) {
      const staged = await stage(rig, bytes, mimeType, name);

      expect(staged).toEqual({
        id: idOf(bytes),
        name,
        mimeType,
        bytes: bytes.length,
      });
      const extension = name.slice(name.lastIndexOf(".") + 1);
      const file = join(
        rig.userData,
        ATTACHMENTS_DIR,
        "staging",
        `${staged.id}.${extension}`,
      );
      expect(await readFile(file)).toEqual(bytes);
    }
  });

  it("rejects_oversize_empty_invalid_and_mismatched_images", async () => {
    const rig = await startedRig();
    const oversize = Buffer.concat([PNG_BYTES, Buffer.alloc(IMAGE_MAX_BYTES)]);

    await expect(stage(rig, oversize, ImageMimeType.png)).rejects.toMatchObject(
      {
        code: IpcErrorCode.VALIDATION,
      },
    );
    await expect(
      rig.call("attachments/stage", {
        name: "empty.png",
        mimeType: ImageMimeType.png,
        dataBase64: "",
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
    await expect(
      rig.call("attachments/stage", {
        name: "bad.png",
        mimeType: ImageMimeType.png,
        dataBase64: "not base64!",
      }),
    ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
    await expect(
      stage(rig, PNG_BYTES, ImageMimeType.jpeg, "wrong.jpg"),
    ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
  });
});

describe("session/prompt with attachments", () => {
  it("records_claims_and_forwards_images_to_claude", async () => {
    const rig = await startedRig({ imageInput: true });
    const staged = await stage(rig, PNG_BYTES, ImageMimeType.png);
    const { id } = await rig.session();
    agentOf(rig).enqueue([END_TURN]);

    await rig.call("session/prompt", {
      sessionId: id,
      text: "look at this",
      attachments: [staged],
    });
    await turnEnded(rig);

    const view = await rig.session();
    expect(view.prompts).toEqual([
      { seq: 0, text: "look at this", attachments: [staged] },
    ]);
    expect(await readdir(join(rig.userData, ATTACHMENTS_DIR, id))).toEqual([
      `${staged.id}.png`,
    ]);
    expect(agentOf(rig).promptImages).toEqual([
      { data: PNG_BASE64, mimeType: ImageMimeType.png },
    ]);
  });

  it("rejects_images_on_a_provider_without_image_input", async () => {
    const rig = await openRig({
      accounts: [await geminiAccount(), ACCOUNT_A],
    });
    await rig.call("session/start", { cwd: rig.cwd, provider: "gemini" });
    const staged = await stage(rig, PNG_BYTES, ImageMimeType.png);
    const { id } = await rig.session();

    await expect(
      rig.call("session/prompt", {
        sessionId: id,
        text: "look at this",
        attachments: [staged],
      }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.VALIDATION,
      message: "Gemini does not accept images",
    });

    expect((await rig.session()).prompts).toEqual([]);
    const [spawn] = rig.agyContainer.agySpawns();
    expect(spawn?.stdinLines).toEqual([]);
  });
});

describe("session view image input", () => {
  it("reflects_the_active_provider", async () => {
    const claude = await startedRig();
    const gemini = await openRig({ accounts: [await geminiAccount()] });
    await gemini.call("session/start", {
      cwd: gemini.cwd,
      provider: "gemini",
    });

    expect((await claude.session()).imageInput).toBe(true);
    expect((await gemini.session()).imageInput).toBe(false);
  });
});

describe("attachment history and resume", () => {
  it("keeps_attachments_in_history_and_lists_image_names_in_context", async () => {
    const rig = await startedRig({ imageInput: true });
    const staged = await stage(rig, PNG_BYTES, ImageMimeType.png);
    const { id } = await rig.session();
    agentOf(rig).enqueue([END_TURN]);
    await rig.call("session/prompt", {
      sessionId: id,
      text: "look at this",
      attachments: [staged],
    });
    await turnEnded(rig);

    const stored = await rig.call("history/get", { sessionId: id });
    expect(stored.prompts).toEqual([
      { seq: 0, text: "look at this", attachments: [staged] },
    ]);

    await rig.call("session/stop", { sessionId: id });
    await rig.call("session/close", { sessionId: id });
    const resumed = await rig.call("session/resume", { sessionId: id });
    expect(resumed.prompts).toEqual([
      { seq: 0, text: "look at this", attachments: [staged] },
    ]);

    agentOf(rig, 1).enqueue([END_TURN]);
    await rig.call("session/prompt", {
      sessionId: id,
      text: "continue",
      attachments: [staged],
    });
    await turnEnded(rig);
    expect(agentOf(rig, 1).prompts[0]).toContain("[images: photo.png]");
  });
});

describe("attachments/get", () => {
  it("returns_session_and_staged_bytes_and_rejects_unknown_ids", async () => {
    const rig = await startedRig({ imageInput: true });
    const staged = await stage(rig, PNG_BYTES, ImageMimeType.png);
    const { id } = await rig.session();
    agentOf(rig).enqueue([END_TURN]);
    await rig.call("session/prompt", {
      sessionId: id,
      text: "look at this",
      attachments: [staged],
    });
    await turnEnded(rig);

    expect(
      await rig.call("attachments/get", { sessionId: id, id: staged.id }),
    ).toEqual({
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    });
    expect(await rig.call("attachments/get", { id: staged.id })).toEqual({
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    });
    await expect(
      rig.call("attachments/get", { sessionId: id, id: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: IpcErrorCode.NOT_FOUND });
    await expect(
      rig.call("attachments/get", { id: "../escape" }),
    ).rejects.toMatchObject({ code: IpcErrorCode.VALIDATION });
  });
});

interface HandlerRig {
  readonly handlers: ReturnType<typeof createHandlers>;
  readonly service: SessionService;
  readonly cwd: string;
}

function fakeHandle(listeners: Set<(event: AgentEvent) => void>): AgentHandle {
  return {
    accountId: ACCOUNT_A.id,
    nativeSessionId: null,
    resumed: false,
    runId: "run-1",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: () => {
      listeners.forEach((listener) => {
        listener({ type: "turn_end", stopReason: "end_turn" });
      });
      return Promise.resolve();
    },
    answerPermission: () => undefined,
    setProfile: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    stop: () => Promise.resolve({ ok: true }),
  };
}

function handlerService(
  store: ReturnType<typeof createJsonStore>,
  adapter: AgentAdapter,
  attachments: ReturnType<typeof fakeAttachmentStore>,
  cwd: string,
): SessionService {
  return createSessionService({
    adapter,
    store,
    broadcast: () => undefined,
    publishView: () => undefined,
    reserved: createAccountReservations(),
    leaseModes: createLeaseModes(),
    now: () => 1_700_000_000_000,
    schedule: () => () => undefined,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    newRunId: () => "run-1",
    resolveExecutable: () => "/usr/bin/claude",
    stopGraceMs: 10,
    containerStatus: { available: true, message: null },
    externalRuntime: () => null,
    beforeLaunch: () => Promise.resolve(),
    isBlocked: () => false,
    hasKey: () => true,
    secrets: () => [],
    homeDir: tmpdir(),
    resolveFolder: (requested) => Promise.resolve(requested ?? cwd),
    protectedPaths: () => Promise.resolve([]),
    attachments,
  });
}

async function handlerRig(attachments: AttachmentStore): Promise<HandlerRig> {
  const userData = await mkdtemp(join(tmpdir(), "codeweave-handlers-"));
  const cwd = await mkdtemp(join(tmpdir(), "codeweave-handlers-cwd-"));
  tempDirs.push(userData, cwd);
  const store = createJsonStore(userData);
  await store.writeAccounts([ACCOUNT_A]);
  const listeners = new Set<(event: AgentEvent) => void>();
  const handle = fakeHandle(listeners);
  const adapter: AgentAdapter = {
    start: () => Promise.resolve({ ok: true, handle }),
  };
  const service = handlerService(store, adapter, attachments, cwd);
  services.push(service);
  const handlers = createHandlers({
    store,
    ...fakeSecrets(userData),
    userData,
    homeDir: tmpdir(),
    broadcast: () => undefined,
    sessions: fakeSessionPool(service),
    history: fakeSessionHistory(),
    checkpoints: fakeCheckpointStore(),
    attachments,
    inspectWorktree: (dir) => Promise.resolve({ isRepo: false, cwd: dir }),
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals(),
    postUpdaterConfig: () => undefined,
    editedFiles: {
      observeMain: () => undefined,
      observeRun: () => undefined,
      forget: () => undefined,
      views: () => [],
    },
  });
  return { handlers, service, cwd };
}

function deferredClaimStore(): {
  readonly store: ReturnType<typeof fakeAttachmentStore>;
  readonly entered: Promise<undefined>;
  readonly claim: PromiseWithResolvers<string>;
} {
  const entered = Promise.withResolvers<undefined>();
  const claim = Promise.withResolvers<string>();
  return {
    store: fakeAttachmentStore({
      claim: () => {
        entered.resolve(undefined);
        return claim.promise;
      },
    }),
    entered: entered.promise,
    claim,
  };
}

const CLAIMED_ATTACHMENT = {
  id: "a".repeat(64),
  name: "photo.png",
  mimeType: ImageMimeType.png,
  bytes: 10,
};

it("ipc_concurrent_prompt_during_image_claim_is_rejected_as_busy", async () => {
  const deferred = deferredClaimStore();
  const rig = await handlerRig(deferred.store);
  const view = await rig.handlers["session/start"]({
    cwd: rig.cwd,
    profile: "ask",
  });

  const first = rig.handlers["session/prompt"]({
    sessionId: view.id,
    text: "one",
    attachments: [CLAIMED_ATTACHMENT],
  });
  await deferred.entered;

  expect(rig.service.view()?.turnInFlight).toBe(true);
  await expect(
    rig.handlers["session/prompt"]({ sessionId: view.id, text: "two" }),
  ).rejects.toMatchObject({ code: IpcErrorCode.SESSION_BUSY });

  deferred.claim.resolve("/tmp/photo.png");
  await first;
  await settled(() => {
    expect(rig.service.view()?.turnInFlight).toBe(false);
  });
  expect(rig.service.view()?.prompts.map((prompt) => prompt.text)).toEqual([
    "one",
  ]);
});

it("ipc_stop_during_image_claim_records_no_prompt", async () => {
  const deferred = deferredClaimStore();
  const rig = await handlerRig(deferred.store);
  const view = await rig.handlers["session/start"]({
    cwd: rig.cwd,
    profile: "ask",
  });

  const first = rig.handlers["session/prompt"]({
    sessionId: view.id,
    text: "one",
    attachments: [CLAIMED_ATTACHMENT],
  });
  await deferred.entered;
  expect(rig.service.view()?.turnInFlight).toBe(true);
  await rig.handlers["session/stop"]({ sessionId: view.id });

  deferred.claim.resolve("/tmp/photo.png");

  await expect(first).rejects.toMatchObject({
    code: IpcErrorCode.SESSION_BUSY,
  });
  expect(rig.service.view()?.prompts).toEqual([]);
});

it("ipc_concurrent_stages_of_the_same_image_all_succeed", async () => {
  const rig = await openRig({ accounts: [ACCOUNT_A] });

  const staged = await Promise.all([
    stage(rig, PNG_BYTES, ImageMimeType.png),
    stage(rig, PNG_BYTES, ImageMimeType.png),
    stage(rig, PNG_BYTES, ImageMimeType.png),
  ]);

  expect(staged.map((view) => view.id)).toEqual([
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
  ]);
});

it("ipc_claim_replaces_a_truncated_session_file", async () => {
  const rig = await startedRig({ imageInput: true });
  const staged = await stage(rig, PNG_BYTES, ImageMimeType.png);
  const { id } = await rig.session();
  const sessionDir = join(rig.userData, ATTACHMENTS_DIR, id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${staged.id}.png`),
    PNG_BYTES.subarray(0, 4),
  );
  agentOf(rig).enqueue([END_TURN]);

  await rig.call("session/prompt", {
    sessionId: id,
    text: "look at this",
    attachments: [staged],
  });
  await turnEnded(rig);

  expect(agentOf(rig).promptImages).toEqual([
    { data: PNG_BASE64, mimeType: ImageMimeType.png },
  ]);
});

function renameError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

function realStore(dir: string, fs: AttachmentFs): AttachmentStore {
  return createAttachmentStore({ dir, fs });
}

it("ipc_stage_rename_collision_with_identical_target_succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-stage-"));
  tempDirs.push(dir);
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      if (to.startsWith(join(dir, "staging"))) {
        await writeFile(to, await readFile(from));
        throw renameError("EPERM");
      }
      await rename(from, to);
    },
  };
  const rig = await handlerRig(realStore(dir, fs));

  const staged = await rig.handlers["attachments/stage"]({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });

  expect(await readFile(join(dir, "staging", `${staged.id}.png`))).toEqual(
    PNG_BYTES,
  );
  expect(await readdir(join(dir, "staging"))).toEqual([`${staged.id}.png`]);
});

it("ipc_claim_rename_collision_with_identical_target_succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-claim-"));
  tempDirs.push(dir);
  let sessionTarget = "";
  let armed = false;
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      if (armed && to === sessionTarget) {
        await writeFile(to, await readFile(from));
        throw renameError("EPERM");
      }
      await rename(from, to);
    },
  };
  const rig = await handlerRig(realStore(dir, fs));
  const staged = await rig.handlers["attachments/stage"]({
    name: "photo.png",
    mimeType: ImageMimeType.png,
    dataBase64: PNG_BASE64,
  });
  const view = await rig.handlers["session/start"]({
    cwd: rig.cwd,
    profile: "ask",
  });
  sessionTarget = join(dir, view.id, `${staged.id}.png`);
  armed = true;

  await rig.handlers["session/prompt"]({
    sessionId: view.id,
    text: "look at this",
    attachments: [staged],
  });

  expect(await readFile(sessionTarget)).toEqual(PNG_BYTES);
  expect(await readdir(join(dir, view.id))).toEqual([`${staged.id}.png`]);
});

it("ipc_concurrent_stages_of_the_same_image_write_once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeweave-write-once-"));
  tempDirs.push(dir);
  let renames = 0;
  const fs: AttachmentFs = {
    rename: async (from, to) => {
      renames += 1;
      await rename(from, to);
    },
  };
  const rig = await handlerRig(realStore(dir, fs));

  const staged = await Promise.all([
    rig.handlers["attachments/stage"]({
      name: "photo.png",
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    }),
    rig.handlers["attachments/stage"]({
      name: "photo.png",
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    }),
    rig.handlers["attachments/stage"]({
      name: "photo.png",
      mimeType: ImageMimeType.png,
      dataBase64: PNG_BASE64,
    }),
  ]);

  expect(staged.map((view) => view.id)).toEqual([
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
    idOf(PNG_BYTES),
  ]);
  expect(renames).toBe(1);
});
