import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createHandlers } from "../../src/backend/handlers";
import type { IpcHandlers } from "../../src/backend/ipcServer";
import { createJsonStore } from "../../src/backend/storage";
import { IpcError } from "../../src/shared/protocol";
import type { SessionView } from "../../src/shared/views";
import { fakeOrchestrator } from "../fakes/fakeOrchestrator";
import {
  fakeFlowRuns,
  fakeProbes,
  fakeSessionPool,
  fakeSessions,
  fakeTerminals,
} from "../fakes/fakeSessions";
import { fakeSecrets } from "../fakes/fakeVault";
import { makeTempDir } from "../fakes/processHelpers";

const OLD_SETTINGS_FILE =
  '{"version":1,"permissionProfile":"plan","effectLevel":"low","claudeExecutable":"/opt/claude"}';
const COLS = 80;
const ROWS = 24;
const RECENT_LIMIT = 8;
const STARTED_FOLDERS = 10;
const DEFAULT_CWD = "/home/user";

function sessionIn(cwd: string | undefined): SessionView {
  return {
    id: "sess-1",
    cwd: cwd ?? DEFAULT_CWD,
    explicitFolder: cwd !== undefined,
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
    currentModel: null,
    contextUsage: null,
    turns: [],
    orchestrate: false,
  };
}

async function rig(): Promise<{
  handlers: IpcHandlers;
  userData: string;
  broadcast: ReturnType<typeof vi.fn>;
}> {
  const userData = await makeTempDir();
  const broadcast = vi.fn();
  const handlers = createHandlers({
    store: createJsonStore(userData),
    ...fakeSecrets(userData),
    userData,
    homeDir: userData,
    broadcast,
    flowRuns: fakeFlowRuns(),
    orchestrator: fakeOrchestrator(),
    sessions: fakeSessionPool(
      fakeSessions({ start: ({ cwd }) => Promise.resolve(sessionIn(cwd)) }),
    ),
    probes: fakeProbes(),
    catalog: { load: () => Promise.resolve({ models: [], error: null }) },
    containerStatus: { available: true, message: null },
    terminals: fakeTerminals({
      open: ({ cwd }) =>
        Promise.resolve({
          terminal: {
            id: "term-1",
            cwd,
            shell: "/bin/sh",
            status: "running",
            exitCode: null,
          },
          replay: "",
        }),
    }),
    postUpdaterConfig: () => undefined,
  });
  return { handlers, userData, broadcast };
}

async function recentOf(handlers: IpcHandlers): Promise<readonly string[]> {
  const settings = await handlers["settings/get"]({});
  return settings.recentFolders;
}

it("recent_folders_recorded_on_use_and_capped", async () => {
  const { handlers } = await rig();
  const base = await makeTempDir();
  const flowFolder = join(base, "flows-project");
  const terminalFolder = join(base, "terminal-project");
  const libraryFolder = join(base, "library");
  await mkdir(flowFolder);

  await handlers["session/start"]({ cwd: join(base, "session-project") });
  await handlers["flows/list"]({ cwd: flowFolder });
  await handlers["terminal/open"]({
    cwd: terminalFolder,
    cols: COLS,
    rows: ROWS,
  });
  await handlers["settings/set"]({ definitionLibrary: libraryFolder });

  expect(await recentOf(handlers)).toEqual([
    libraryFolder,
    terminalFolder,
    flowFolder,
    join(base, "session-project"),
  ]);

  for (let index = 0; index < STARTED_FOLDERS; index += 1) {
    await handlers["session/start"]({
      cwd: join(base, `many-${index.toString()}`),
    });
  }
  await handlers["session/start"]({ cwd: terminalFolder });
  const capped = await recentOf(handlers);

  expect(capped).toHaveLength(RECENT_LIMIT);
  expect(capped[0]).toBe(terminalFolder);
  expect(capped[1]).toBe(
    join(base, `many-${(STARTED_FOLDERS - 1).toString()}`),
  );
  expect(capped.filter((folder) => folder === terminalFolder)).toHaveLength(1);
  expect(capped).not.toContain(join(base, "session-project"));
});

it("recent_folder_relative_path_is_not_recorded", async () => {
  const { handlers } = await rig();

  await handlers["session/start"]({ cwd: "relative/project" });

  expect(await recentOf(handlers)).toEqual([]);
});

it("recent_folder_stale_still_listed", async () => {
  const { handlers } = await rig();
  const base = await makeTempDir();
  const gone = join(base, "gone");
  await handlers["session/start"]({ cwd: gone });

  expect(await recentOf(handlers)).toEqual([gone]);
});

it("recent_folder_failed_use_is_not_recorded", async () => {
  const { handlers } = await rig();

  await expect(
    handlers["settings/set"]({ definitionLibrary: "relative/library" }),
  ).rejects.toBeInstanceOf(IpcError);

  expect(await recentOf(handlers)).toEqual([]);
});

it("recent_folders_absent_in_old_settings_file_defaults_empty", async () => {
  const { handlers, userData } = await rig();
  await writeFile(join(userData, "settings.json"), OLD_SETTINGS_FILE);

  const view = await handlers["settings/get"]({});

  expect(view.recentFolders).toEqual([]);
  expect(view.claudeExecutable).toBe("/opt/claude");
  expect(view.effectLevel).toBe("low");
  expect(view.permissionProfile).toBe("plan");
});

function settingsEvents(broadcast: ReturnType<typeof vi.fn>): unknown[][] {
  return broadcast.mock.calls.filter(
    (call: unknown[]) => call[0] === "settings/changed",
  );
}

it("recent_folder_repeat_use_does_not_broadcast", async () => {
  const { handlers, broadcast } = await rig();
  const base = await makeTempDir();

  await handlers["terminal/open"]({ cwd: base, cols: COLS, rows: ROWS });
  await handlers["terminal/open"]({ cwd: base, cols: COLS, rows: ROWS });

  expect(await recentOf(handlers)).toEqual([base]);
  expect(settingsEvents(broadcast)).toHaveLength(1);
});

it("recent_folder_trailing_separator_deduped_on_use", async () => {
  const { handlers } = await rig();
  const base = await makeTempDir();

  await handlers["session/start"]({ cwd: `${base}/` });
  await handlers["session/start"]({ cwd: base });

  expect(await recentOf(handlers)).toEqual([base]);
});

it("account_config_dir_not_recorded_as_recent_folder", async () => {
  const { handlers } = await rig();
  const configDir = await makeTempDir();

  await handlers["accounts/add"]({
    label: "Work",
    configDir,
    provider: "claude",
  });

  expect(await recentOf(handlers)).toEqual([]);
});

it("session_start_without_a_folder_records_no_recent_folder", async () => {
  const { handlers } = await rig();

  await handlers["session/start"]({});

  expect(await recentOf(handlers)).toEqual([]);
});

it("flows_list_without_cwd_records_no_recent_folder", async () => {
  const { handlers } = await rig();

  await handlers["flows/list"]({});

  expect(await recentOf(handlers)).toEqual([]);
});
