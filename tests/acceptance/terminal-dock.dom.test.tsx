import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { EffectLevel, TerminalStatus } from "../../src/domain/types";
import { App } from "../../src/renderer/App";
import { PROTOCOL_VERSION } from "../../src/shared/constants";
import { TerminalFactoryContext } from "../../src/renderer/terminal/xterm";
import type { ParamsMap, RequestMethod } from "../../src/shared/protocol";
import type { Snapshot } from "../../src/shared/views";
import {
  createFakeXtermFactory,
  FAKE_FIT_SIZE,
  type FakeXterm,
  type FakeXtermFactory,
} from "../fakes/fakeXterm";
import {
  createFakeIpcClient,
  makeSession,
  makeSettings,
  makeSnapshot,
  makeTerminal,
  renderWithServices,
  type FakeIpcClient,
} from "../fakes/fakeIpcClient";
import {
  createFakeGpuAcceleration,
  makeCodeweaveApi,
  type FakeGpuAcceleration,
} from "../fakes/fakeCodeweaveApi";

import { shownPath } from "./pathFieldHelpers";

const DOCK_STORAGE_KEY = "codeweave.terminalDock";
const SESSION_CWD = "/home/user/project";
const PICKED_CWD = "/home/user/picked";
const RUNNING_CWD = "/home/user/running";
const TERMINAL_ID = "term-1";
const NEW_TERMINAL_ID = "term-2";
const HIDE_KEY = { code: "Backquote", ctrlKey: true } as const;

interface Rig {
  client: FakeIpcClient;
  fake: FakeXtermFactory;
  pickFolder: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  gpu: FakeGpuAcceleration;
}

function setup(
  snapshot: Partial<Snapshot> = {},
  gpuAccelerated = true,
  replay = "",
): Rig {
  const pickFolder = vi.fn<() => Promise<string | null>>(() =>
    Promise.resolve(PICKED_CWD),
  );
  const gpu = createFakeGpuAcceleration(gpuAccelerated);
  window.codeweave = makeCodeweaveApi({ ...gpu.api, pickFolder });
  const client = createFakeIpcClient();
  client.respond("ping", { pong: true, backendPid: 1 });
  client.respond("sessions/snapshot", makeSnapshot(snapshot));
  client.on("terminal/open", ({ cwd }) => ({
    terminal: makeTerminal({ cwd }),
    replay,
  }));
  client.respond("terminal/input", { ok: true });
  client.respond("terminal/resize", { ok: true });
  client.respond("terminal/ack", { ok: true });
  client.respond("terminal/detach", { ok: true });
  client.respond("terminal/close", { closed: true });
  client.respond("settings/set", makeSettings());
  const fake = createFakeXtermFactory();
  renderWithServices(
    <TerminalFactoryContext value={fake.factory}>
      <App />
    </TerminalFactoryContext>,
    client,
  );
  return { client, fake, pickFolder, gpu };
}

function paramsOf<M extends RequestMethod>(
  client: FakeIpcClient,
  method: M,
): ParamsMap[M][] {
  return client.requests
    .filter((request) => request.method === method)
    .map((request) => request.params as ParamsMap[M]);
}

async function openDock(): Promise<HTMLElement> {
  const toggle = await screen.findByRole("button", { name: "Terminal" });
  fireEvent.click(toggle);
  return screen.findByRole("region", { name: "Terminal" });
}

function rendererOf(): string | null {
  const region = screen.getByRole("region", { name: "Terminal" });
  return (
    region.querySelector(".terminal-host")?.getAttribute("data-renderer") ??
    null
  );
}

async function openedTerminal(rig: Rig): Promise<FakeXterm> {
  await waitFor(() => {
    expect(rig.fake.terminals).toHaveLength(1);
  });
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/open")).not.toHaveLength(0);
  });
  const terminal = rig.fake.terminals[0];
  if (terminal === undefined) {
    throw new Error("No terminal was created");
  }
  await waitFor(() => {
    expect(rendererOf()).not.toBeNull();
  });
  return terminal;
}

function emitData(rig: Rig, id: string, data: string): void {
  rig.client.emit({
    v: PROTOCOL_VERSION,
    event: "terminal/data",
    payload: { id, data },
  });
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("terminal_dock_toggles_with_header_button", async () => {
  setup();
  const toggle = await screen.findByRole("button", { name: "Terminal" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(toggle.getAttribute("title")).toBe("Toggle terminal (Ctrl+`)");
  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();

  fireEvent.click(toggle);

  expect(await screen.findByRole("region", { name: "Terminal" })).toBeTruthy();
  expect(toggle.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(toggle);

  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});

it("terminal_dock_toggles_with_ctrl_backquote", async () => {
  setup();
  await screen.findByRole("button", { name: "Terminal" });

  fireEvent.keyDown(window, HIDE_KEY);
  expect(await screen.findByRole("region", { name: "Terminal" })).toBeTruthy();

  fireEvent.keyDown(window, HIDE_KEY);
  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();

  fireEvent.keyDown(window, { code: "Backquote" });
  expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
});

it("terminal_opens_in_session_cwd", async () => {
  const rig = setup({ sessions: [makeSession({ cwd: SESSION_CWD })] });
  await openDock();

  await openedTerminal(rig);

  expect(paramsOf(rig.client, "terminal/open")).toEqual([
    { cwd: SESSION_CWD, cols: FAKE_FIT_SIZE.cols, rows: FAKE_FIT_SIZE.rows },
  ]);
  expect(screen.queryByRole("button", { name: "Open in folder…" })).toBeNull();
});

it("terminal_without_session_opens_in_picked_folder", async () => {
  const rig = setup();
  const dock = await openDock();
  expect(rig.client.requests.map((request) => request.method)).not.toContain(
    "terminal/open",
  );

  fireEvent.click(
    await within(dock).findByRole("button", { name: "Open in folder…" }),
  );

  await openedTerminal(rig);
  expect(rig.pickFolder).toHaveBeenCalledTimes(1);
  expect(paramsOf(rig.client, "terminal/open")[0]?.cwd).toBe(PICKED_CWD);
});

it("terminal_picker_cancel_keeps_the_folder_button", async () => {
  const rig = setup();
  rig.pickFolder.mockResolvedValue(null);
  const dock = await openDock();

  fireEvent.click(
    await within(dock).findByRole("button", { name: "Open in folder…" }),
  );

  await waitFor(() => {
    expect(rig.pickFolder).toHaveBeenCalledTimes(1);
  });
  expect(
    within(dock).getByRole("button", { name: "Open in folder…" }),
  ).toBeTruthy();
  expect(paramsOf(rig.client, "terminal/open")).toEqual([]);
});

it("running_terminal_is_attached_with_replay_written_first", async () => {
  const rig = setup(
    {
      sessions: [makeSession({ cwd: SESSION_CWD })],
      terminal: makeTerminal({ cwd: RUNNING_CWD }),
    },
    true,
    "earlier output\r\n",
  );
  await openDock();

  const terminal = await openedTerminal(rig);

  expect(paramsOf(rig.client, "terminal/open")[0]?.cwd).toBe(RUNNING_CWD);
  expect(terminal.writes).toEqual(["earlier output\r\n"]);
});

it("typed_keys_reach_the_shell", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);

  terminal.type("ls\r");

  expect(paramsOf(rig.client, "terminal/input")).toEqual([
    { id: TERMINAL_ID, data: "ls\r" },
  ]);
});

it("paste_larger_than_input_limit_is_split", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);

  terminal.type("a".repeat(65_536 + 5));

  expect(
    paramsOf(rig.client, "terminal/input").map((params) => params.data.length),
  ).toEqual([65_536, 5]);
});

it("terminal_data_is_written_and_acked_once_per_frame", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);

  emitData(rig, TERMINAL_ID, "hello");
  emitData(rig, TERMINAL_ID, " world");

  expect(terminal.writes).toEqual(["hello", " world"]);
  await nextFrame();
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/ack")).toEqual([
      { id: TERMINAL_ID, chars: 11 },
    ]);
  });
});

it("data_for_stale_terminal_is_ignored", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);

  emitData(rig, "term-old", "ghost");
  emitData(rig, TERMINAL_ID, "real");

  expect(terminal.writes).toEqual(["real"]);
  await nextFrame();
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/ack")).toEqual([
      { id: TERMINAL_ID, chars: 4 },
    ]);
  });
});

it("exited_shell_shows_exit_code_and_restart", async () => {
  const rig = setup({
    terminal: makeTerminal({
      id: TERMINAL_ID,
      cwd: RUNNING_CWD,
      status: TerminalStatus.exited,
      exitCode: 3,
    }),
  });
  const dock = await openDock();

  expect(
    await within(dock).findByText("Shell exited with code 3"),
  ).toBeTruthy();
  expect(rig.fake.terminals).toHaveLength(0);

  fireEvent.click(within(dock).getByRole("button", { name: "Restart" }));

  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/open")).toEqual([
      { cwd: RUNNING_CWD, cols: 80, rows: 24 },
    ]);
  });
});

it("open_failure_is_shown_and_retry_opens_again", async () => {
  const rig = setup({ sessions: [makeSession()] });
  rig.client.fail("terminal/open", new Error("shell is missing"));
  const dock = await openDock();

  expect(await within(dock).findByText("shell is missing")).toBeTruthy();

  rig.client.on("terminal/open", ({ cwd }) => ({
    terminal: makeTerminal({ cwd, id: NEW_TERMINAL_ID }),
    replay: "",
  }));
  fireEvent.click(within(dock).getByRole("button", { name: "Retry" }));

  await waitFor(() => {
    expect(within(dock).queryByText("shell is missing")).toBeNull();
  });
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/open")).toHaveLength(2);
  });
});

it("hiding_the_dock_detaches_and_keeps_the_shell", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);

  fireEvent.keyDown(window, HIDE_KEY);

  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/detach")).toEqual([
      { id: TERMINAL_ID },
    ]);
  });
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
  expect(terminal.disposed).toBe(true);
});

it("close_button_kills_the_shell_and_hides_the_dock", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const dock = await openDock();
  await openedTerminal(rig);
  act(() => {
    rig.client.emit({
      v: PROTOCOL_VERSION,
      event: "terminal/changed",
      payload: makeTerminal(),
    });
  });

  fireEvent.click(within(dock).getByRole("button", { name: "Close" }));

  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/close")).toEqual([
      { id: TERMINAL_ID },
    ]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
  });
});

it("hide_button_hides_without_closing", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const dock = await openDock();
  await openedTerminal(rig);

  fireEvent.click(within(dock).getByRole("button", { name: "Hide" }));

  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
  });
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
});

it("terminal_uses_webgl_when_gpu_accelerated", async () => {
  const rig = setup({ sessions: [makeSession()] }, true);
  await openDock();

  await openedTerminal(rig);

  expect(rendererOf()).toBe("webgl");
});

it("terminal_uses_dom_without_gpu", async () => {
  const rig = setup({ sessions: [makeSession()] }, false);
  await openDock();

  await openedTerminal(rig);

  expect(rendererOf()).toBe("dom");
});

it("open_terminal_switches_to_webgl_when_gpu_acceleration_is_reported", async () => {
  const rig = setup({ sessions: [makeSession()] }, false);
  await openDock();
  const terminal = await openedTerminal(rig);
  expect(rendererOf()).toBe("dom");

  act(() => {
    rig.gpu.set(true);
  });

  await waitFor(() => {
    expect(rendererOf()).toBe("webgl");
  });
  expect(rig.fake.terminals).toEqual([terminal]);
});

it("open_terminal_falls_back_to_dom_when_gpu_acceleration_is_lost", async () => {
  const rig = setup({ sessions: [makeSession()] }, true);
  await openDock();
  const terminal = await openedTerminal(rig);
  expect(rendererOf()).toBe("webgl");

  act(() => {
    rig.gpu.set(false);
  });

  await waitFor(() => {
    expect(rendererOf()).toBe("dom");
  });
  expect(rig.fake.terminals).toEqual([terminal]);
});

it("webgl_context_loss_falls_back_to_dom", async () => {
  const rig = setup({ sessions: [makeSession()] }, true);
  await openDock();
  const terminal = await openedTerminal(rig);
  expect(rendererOf()).toBe("webgl");

  act(() => {
    terminal.loseContext();
  });

  await waitFor(() => {
    expect(rendererOf()).toBe("dom");
  });
});

it("dock_height_is_clamped_by_the_keyboard_splitter", async () => {
  setup();
  const dock = await openDock();
  const splitter = within(dock).getByRole("separator");
  expect(splitter.getAttribute("aria-orientation")).toBe("horizontal");
  expect(splitter.getAttribute("aria-valuenow")).toBe("280");

  fireEvent.keyDown(splitter, { key: "ArrowUp" });
  expect(splitter.getAttribute("aria-valuenow")).toBe("304");

  for (let step = 0; step < 20; step += 1) {
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
  }
  expect(splitter.getAttribute("aria-valuenow")).toBe("120");
});

it("dock_open_state_is_persisted_and_restored", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "Terminal" }));
  await screen.findByRole("region", { name: "Terminal" });
  expect(localStorage.getItem(DOCK_STORAGE_KEY)).toBe("open");

  cleanup();
  setup();

  expect(await screen.findByRole("region", { name: "Terminal" })).toBeTruthy();
});

it("dock_state_survives_blocked_storage", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  setup();

  fireEvent.click(await screen.findByRole("button", { name: "Terminal" }));

  expect(await screen.findByRole("region", { name: "Terminal" })).toBeTruthy();
});

function gateOpens(rig: Rig, replay = ""): PromiseWithResolvers<undefined>[] {
  const gates: PromiseWithResolvers<undefined>[] = [];
  rig.client.on("terminal/open", async ({ cwd }) => {
    const gate = Promise.withResolvers<undefined>();
    gates.push(gate);
    await gate.promise;
    return { terminal: makeTerminal({ cwd }), replay };
  });
  return gates;
}

async function pendingOpens(rig: Rig, count: number): Promise<void> {
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/open")).toHaveLength(count);
  });
}

it("data_before_open_result_is_not_duplicated_after_replay", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const gates = gateOpens(rig, "replayed");
  await openDock();
  await pendingOpens(rig, 1);
  const terminal = rig.fake.terminals[0];

  emitData(rig, TERMINAL_ID, "early");
  emitData(rig, "term-old", "ghost");
  expect(terminal?.writes).toEqual([]);
  gates[0]?.resolve(undefined);

  await waitFor(() => {
    expect(terminal?.writes).toEqual(["replayed"]);
  });
  await nextFrame();
  expect(terminal?.writes).toEqual(["replayed"]);
});

it("hide_while_open_pending_detaches_late_terminal", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const gates = gateOpens(rig);
  await openDock();
  await pendingOpens(rig, 1);

  fireEvent.keyDown(window, HIDE_KEY);
  gates[0]?.resolve(undefined);

  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/detach")).toEqual([
      { id: TERMINAL_ID },
    ]);
  });
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
});

it("close_while_open_pending_closes_late_terminal", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const gates = gateOpens(rig);
  const dock = await openDock();
  await pendingOpens(rig, 1);

  fireEvent.click(within(dock).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
  });
  gates[0]?.resolve(undefined);

  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/close")).toEqual([
      { id: TERMINAL_ID },
    ]);
  });
  expect(paramsOf(rig.client, "terminal/detach")).toEqual([]);
});

it("stale_open_result_does_not_detach_newer_attachment", async () => {
  const rig = setup({ sessions: [makeSession()] });
  const gates = gateOpens(rig);
  await openDock();
  await pendingOpens(rig, 1);

  fireEvent.keyDown(window, HIDE_KEY);
  fireEvent.keyDown(window, HIDE_KEY);
  await pendingOpens(rig, 2);
  gates[0]?.resolve(undefined);
  gates[1]?.resolve(undefined);
  await waitFor(() => {
    expect(rendererOf()).not.toBeNull();
  });
  await nextFrame();

  expect(paramsOf(rig.client, "terminal/detach")).toEqual([]);
  expect(paramsOf(rig.client, "terminal/close")).toEqual([]);
});

it("acks_flow_while_animation_frames_are_throttled", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);
  vi.stubGlobal("requestAnimationFrame", () => 0);

  emitData(rig, TERMINAL_ID, "hello");
  emitData(rig, TERMINAL_ID, " world");

  expect(terminal.writes).toEqual(["hello", " world"]);
  await waitFor(() => {
    expect(paramsOf(rig.client, "terminal/ack")).toEqual([
      { id: TERMINAL_ID, chars: 11 },
    ]);
  });
});

it("terminal_resize_is_sent_once_per_changed_size", async () => {
  const callbacks: ((entries: ResizeObserverEntry[]) => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        callbacks.push(callback);
      }
      observe(): void {
        return undefined;
      }
      unobserve(): void {
        return undefined;
      }
      disconnect(): void {
        return undefined;
      }
    },
  );
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);
  const resize = async (): Promise<void> => {
    for (const callback of callbacks) {
      callback([]);
    }
    await nextFrame();
  };

  terminal.fitSize = { cols: 120, rows: 40 };
  await resize();
  await resize();
  terminal.fitSize = null;
  await resize();

  expect(paramsOf(rig.client, "terminal/resize")).toEqual([
    { id: TERMINAL_ID, cols: 120, rows: 40 },
  ]);
});

it("terminal_follows_the_effect_level_setting", async () => {
  const rig = setup({
    sessions: [makeSession()],
    settings: makeSettings({ effectLevel: EffectLevel.low }),
  });
  await openDock();
  const terminal = await openedTerminal(rig);
  expect(new Set(terminal.levels)).toEqual(new Set(["low"]));

  act(() => {
    rig.client.emit({
      v: PROTOCOL_VERSION,
      event: "settings/changed",
      payload: makeSettings({ effectLevel: EffectLevel.full }),
    });
  });

  await waitFor(() => {
    expect(terminal.levels.at(-1)).toBe("full");
  });
});

it("terminal_theme_updates_on_theme_change", async () => {
  const rig = setup({ sessions: [makeSession()] });
  await openDock();
  const terminal = await openedTerminal(rig);
  const before = terminal.themeRefreshes;

  document.documentElement.dataset.theme = "light";

  await waitFor(() => {
    expect(terminal.themeRefreshes).toBe(before + 1);
  });

  document.documentElement.dataset.theme = "dark";

  await waitFor(() => {
    expect(terminal.themeRefreshes).toBe(before + 2);
  });
});

it("settings_terminal_shell_field_persists_the_value", async () => {
  const rig = setup({ settings: makeSettings({ terminalShell: "/bin/zsh" }) });
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });

  const field = within(dialog).getByRole("group", {
    name: "Terminal shell path",
  });
  expect(shownPath("/bin/zsh", field)?.getAttribute("title")).toBe("/bin/zsh");
  expect(
    within(dialog).getByText("Leave empty to detect your shell automatically."),
  ).toBeTruthy();
  const container = field.parentElement;
  if (container === null) {
    throw new Error("The field has no container");
  }
  const typeShell = (value: string): void => {
    fireEvent.click(within(field).getByRole("button", { name: "Edit path" }));
    fireEvent.change(within(field).getByRole("textbox"), {
      target: { value },
    });
    fireEvent.click(within(field).getByRole("button", { name: "Use path" }));
  };
  typeShell("/usr/bin/fish");
  fireEvent.click(within(container).getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(paramsOf(rig.client, "settings/set")).toEqual([
      { terminalShell: "/usr/bin/fish" },
    ]);
  });

  typeShell("");
  fireEvent.click(within(container).getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(paramsOf(rig.client, "settings/set")).toEqual([
      { terminalShell: "/usr/bin/fish" },
      { terminalShell: null },
    ]);
  });
});
