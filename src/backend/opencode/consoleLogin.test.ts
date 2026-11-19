import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecOptions, ExecText } from "../exec";

import {
  ConsoleLoginState,
  probeConsoleLogin,
  type ConsoleLoginDeps,
} from "./consoleLogin";

const CONFIG_DIR = "/home/jane/.oc-console";
const EXECUTABLE = "/usr/bin/opencode";
const LOGGED_IN = JSON.stringify([
  {
    id: "opencode",
    name: "OpenCode Console",
    connections: [{ type: "credential", id: "cred_x", label: "Personal" }],
  },
]);
const NEEDS_AUTH = JSON.stringify([
  {
    id: "opencode",
    connections: [
      {
        type: "credential",
        status: { status: "needs_auth", message: "Reconnect" },
      },
    ],
  },
]);
const ANSI_GREEN = "\u001B[32m";
const ANSI_RESET = "\u001B[0m";
const SHORT_TIMEOUT_MS = 40;

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

function depsReturning(output: string, calls: Call[] = []): ConsoleLoginDeps {
  const exec: ExecText = (file, args, options) => {
    calls.push({ file, args, options });
    return Promise.resolve(output);
  };
  return { exec, platform: "linux" };
}

function depsFailingWith(error: Error): ConsoleLoginDeps {
  return { exec: () => Promise.reject(error), platform: "linux" };
}

function probe(
  deps: ConsoleLoginDeps,
  signal?: AbortSignal,
): Promise<ConsoleLoginState> {
  return probeConsoleLogin(deps, {
    executable: EXECUTABLE,
    configDir: CONFIG_DIR,
    env: { PATH: "/usr/bin" },
    ...(signal === undefined ? {} : { signal }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeConsoleLogin", () => {
  it("console login probe parses output with ANSI colour and a warning line before the JSON", async () => {
    const output = `${ANSI_GREEN}warning: update available${ANSI_RESET}\n[warn] cache is cold\n${ANSI_GREEN}${LOGGED_IN}${ANSI_RESET}\n`;

    expect(await probe(depsReturning(output))).toBe(ConsoleLoginState.loggedIn);
  });

  it("console login probe treats a needs_auth connection as needs_login", async () => {
    expect(await probe(depsReturning(NEEDS_AUTH))).toBe(
      ConsoleLoginState.needsLogin,
    );
  });

  it.each([
    ["an empty list", "[]"],
    [
      "another provider",
      JSON.stringify([{ id: "openai", connections: [{ type: "credential" }] }]),
    ],
    [
      "a non credential connection",
      JSON.stringify([{ id: "opencode", connections: [{ type: "env" }] }]),
    ],
    ["no connections", JSON.stringify([{ id: "opencode", connections: [] }])],
  ])("console login probe reads %s as needs_login", async (_name, output) => {
    expect(await probe(depsReturning(output))).toBe(
      ConsoleLoginState.needsLogin,
    );
  });

  it.each([
    ["not JSON", "no list here"],
    ["a wrong shape", JSON.stringify([{ id: 7 }])],
    ["an empty output", ""],
  ])("console login probe reads %s as failed", async (_name, output) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await probe(depsReturning(output))).toBe(ConsoleLoginState.failed);
  });
});

describe("probeConsoleLogin process contract", () => {
  it("console login probe asks auth list standalone in the account sandbox", async () => {
    const calls: Call[] = [];

    await probe(depsReturning("[]", calls));

    const [call] = calls;
    expect(call?.file).toBe(EXECUTABLE);
    expect(call?.args).toEqual([
      "auth",
      "list",
      "--format",
      "json",
      "--standalone",
    ]);
    expect(call?.options?.cwd).toBe(CONFIG_DIR);
    expect(call?.options?.timeoutMs).toBe(15_000);
    expect(call?.options?.env).toMatchObject({
      PATH: "/usr/bin",
      OPENCODE_DB: join(CONFIG_DIR, "data", "opencode", "opencode.db"),
      XDG_DATA_HOME: join(CONFIG_DIR, "data"),
      HOME: join(CONFIG_DIR, "home"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
  });
});

describe("probeConsoleLogin failures", () => {
  it("console login probe never logs the output it read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secretLabel = "Personal-label-xyz";

    await probe(depsReturning(`{"label":"${secretLabel}"`));
    await probe(
      depsFailingWith(Object.assign(new Error(secretLabel), { code: 1 })),
    );

    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretLabel);
    expect(warn).toHaveBeenCalled();
  });

  it("console login probe reports an exit code as failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await probe(depsFailingWith(Object.assign(new Error("x"), { code: 2 }))),
    ).toBe(ConsoleLoginState.failed);
  });

  it("console login probe reports a killed process as failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = await probe(
      depsFailingWith(Object.assign(new Error("x"), { killed: true })),
    );

    expect(state).toBe(ConsoleLoginState.failed);
    expect(warn).toHaveBeenCalledWith(
      "the opencode console login probe failed: timeout",
    );
  });

  it("console login probe stops waiting when it is aborted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    const hanging: ConsoleLoginDeps = {
      exec: () => new Promise<string>(() => undefined),
      platform: "linux",
      timeoutMs: SHORT_TIMEOUT_MS,
    };

    const pending = probe(hanging, controller.signal);
    controller.abort();

    expect(await pending).toBe(ConsoleLoginState.failed);
  });

  it("console login probe does not run once it is already aborted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();

    expect(await probe(depsReturning(LOGGED_IN), controller.signal)).toBe(
      ConsoleLoginState.failed,
    );
  });
});
