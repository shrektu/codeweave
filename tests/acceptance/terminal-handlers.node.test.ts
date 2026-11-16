import { afterEach, expect, it, vi } from "vitest";

import { createHandlers } from "../../src/backend/handlers";
import type { IpcHandlers } from "../../src/backend/ipcServer";
import { createJsonStore } from "../../src/backend/storage";
import type { TerminalService } from "../../src/backend/terminal/service";
import { IpcError } from "../../src/shared/protocol";
import type { SessionView } from "../../src/shared/views";
import { createTerminalRig, type TerminalRig } from "../fakes/fakeTerminal";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessions,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const COLS = 90;
const ROWS = 25;
const rigs: TerminalRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
  vi.restoreAllMocks();
});

function sessionIn(cwd: string): SessionView {
  return {
    id: "sess-1",
    cwd,
    provider: "claude",
    profile: "ask",
    phase: { phase: "running", accountId: "acc-1" },
    activeAccountId: "acc-1",
    activeProvider: "claude",
    messages: [],
    toolCalls: [],
    permissions: [],
    limits: [],
    lastTurn: null,
    turnInFlight: false,
    flowRef: null,
  };
}

async function handlersFor(
  terminals: TerminalService,
  startedIn: string,
): Promise<IpcHandlers> {
  const userData = await makeTempDir();
  return createHandlers({
    store: createJsonStore(userData),
    ...fakeSecrets(userData),
    userData,
    broadcast: vi.fn(),
    flowRuns: fakeFlowRuns(),
    sessions: fakeSessions({
      start: () => Promise.resolve(sessionIn(startedIn)),
    }),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals,
    postUpdaterConfig: () => undefined,
  });
}

function newRig(): TerminalRig {
  const rig = createTerminalRig();
  rigs.push(rig);
  return rig;
}

async function failureCode(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof IpcError ? error.code : String(error);
  }
  return "resolved";
}

async function sessionStart(
  handlers: IpcHandlers,
  cwd: string,
): Promise<SessionView> {
  return handlers["session/start"]({ cwd });
}

it("terminal_handlers_drive_the_service_and_report_it_in_the_snapshot", async () => {
  const rig = newRig();
  const cwd = await rig.folder();
  const handlers = await handlersFor(rig.service, cwd);
  const before = await handlers["sessions/snapshot"]({});

  const opened = await handlers["terminal/open"]({
    cwd,
    cols: COLS,
    rows: ROWS,
  });
  const input = await handlers["terminal/input"]({
    id: opened.terminal.id,
    data: "ls\r",
  });
  const after = await handlers["sessions/snapshot"]({});

  expect(before.terminal).toBeNull();
  expect(opened.replay).toBe("");
  expect(input).toEqual({ ok: true });
  expect(rig.spawnAt(0).pty.written).toEqual(["ls\r"]);
  expect(after.terminal).toEqual(opened.terminal);
});

it("stale_id_is_not_found", async () => {
  const rig = newRig();
  const cwd = await rig.folder();
  const handlers = await handlersFor(rig.service, cwd);
  await handlers["terminal/open"]({ cwd, cols: COLS, rows: ROWS });

  const failures = await Promise.all([
    failureCode(() => handlers["terminal/input"]({ id: "gone", data: "x" })),
    failureCode(() =>
      handlers["terminal/resize"]({ id: "gone", cols: 80, rows: 24 }),
    ),
    failureCode(() => handlers["terminal/ack"]({ id: "gone", chars: 1 })),
    failureCode(() => handlers["terminal/detach"]({ id: "gone" })),
  ]);

  expect(failures).toEqual([
    "NOT_FOUND",
    "NOT_FOUND",
    "NOT_FOUND",
    "NOT_FOUND",
  ]);
  await expect(handlers["terminal/close"]({ id: "gone" })).resolves.toEqual({
    closed: false,
  });
  expect(rig.service.view()?.status).toBe("running");
});

it("session_start_in_another_worktree_closes_the_terminal", async () => {
  const rig = newRig();
  const terminalFolder = await rig.folder("terminal");
  const otherFolder = await rig.folder("other");
  const handlers = await handlersFor(rig.service, otherFolder);
  await handlers["terminal/open"]({
    cwd: terminalFolder,
    cols: COLS,
    rows: ROWS,
  });

  const view = await sessionStart(handlers, otherFolder);

  expect(view.cwd).toBe(otherFolder);
  expect(rig.service.view()).toBeNull();
  expect(rig.spawnAt(0).pty.kills).toEqual(["SIGHUP"]);
});

it("session_start_in_the_same_worktree_keeps_the_terminal", async () => {
  const rig = newRig();
  const cwd = await rig.folder();
  const handlers = await handlersFor(rig.service, cwd);
  await handlers["terminal/open"]({ cwd, cols: COLS, rows: ROWS });

  await sessionStart(handlers, cwd);

  expect(rig.service.view()?.status).toBe("running");
  expect(rig.spawnAt(0).pty.kills).toEqual([]);
});

it("session_start_succeeds_even_when_the_terminal_retarget_fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const handlers = await handlersFor(
    fakeTerminals({
      retarget: () => Promise.reject(new Error("resolve failed")),
    }),
    "/work/project",
  );

  const view = await sessionStart(handlers, "/work/project");

  expect(view.cwd).toBe("/work/project");
  expect(error).toHaveBeenCalledOnce();
});
