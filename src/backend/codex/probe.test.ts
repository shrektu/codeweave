import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScriptedCodexContainer,
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type FakeCodexConfig,
} from "../../../tests/fakes/fakeCodexAppServer";
import { ACCOUNT_CODEX_A } from "../../../tests/fakes/backendRig";
import { StopFailureReason, type ProcessContainer } from "../process/container";

import { createCodexLimitProbe, type CodexProbeDeps } from "./probe";

const GRACE_MS = 7;
const TIMEOUT_MS = 40;
const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const RPC_INTERNAL_ERROR = -32603;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const EXECUTABLE = "/opt/codex/bin/codex";

const OK_CONFIG: FakeCodexConfig = {
  rateLimitReads: [
    {
      kind: "ok",
      response: rateLimitsResponse(
        rateSnapshot(rateWindow(40, FIVE_HOUR_MINUTES, RESET_AT), null),
      ),
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(
  config: FakeCodexConfig,
  overrides: Partial<CodexProbeDeps> = {},
): {
  container: ScriptedCodexContainer;
  probe: ReturnType<typeof createCodexLimitProbe>;
} {
  const container = new ScriptedCodexContainer();
  Object.assign(container.config, config);
  const probe = createCodexLimitProbe({
    container,
    envFor: () => ({ PATH: "/usr/bin", HOME: "/home/jane" }),
    executable: () => Promise.resolve(EXECUTABLE),
    platform: "linux",
    timeoutMs: TIMEOUT_MS,
    stopGraceMs: GRACE_MS,
    newRunId: () => "probe-test",
    ...overrides,
  });
  return { container, probe };
}

function stopCallsOf(container: ScriptedCodexContainer): number[][] {
  return container.contained.map((process) => process.stopCalls);
}

describe("codex limit probe", () => {
  it("returns the limits read from the account and stops the process", async () => {
    const { container, probe } = setup(OK_CONFIG);

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({
      kind: "limits",
      limits: {
        primary: {
          usedPercent: 40,
          windowDurationMins: 300,
          resetsAt: RESET_AT,
        },
        secondary: null,
        rateLimitReachedType: null,
        ordinaryUsageAllowed: true,
      },
    });
    expect(container.specs).toEqual([
      {
        command: EXECUTABLE,
        args: ["app-server"],
        env: {
          PATH: "/usr/bin",
          HOME: "/home/jane",
          CODEX_HOME: ACCOUNT_CODEX_A.configDir,
        },
        cwd: ACCOUNT_CODEX_A.configDir,
        runId: "probe-test",
      },
    ]);
    expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
  });

  it("launches a windows shim through cmd with verbatim arguments", async () => {
    const { container, probe } = setup(OK_CONFIG, {
      platform: "win32",
      comSpec: "C:\\Windows\\cmd.exe",
      executable: () => Promise.resolve("C:\\tools\\codex.cmd"),
    });

    await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(container.specs[0]).toMatchObject({
      command: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\tools\\codex.cmd" app-server"'],
      windowsVerbatimArguments: true,
    });
  });

  it("reports needs_login for a logged-out home without reading limits", async () => {
    const { container, probe } = setup({ loggedIn: false });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "needs_login" });
    expect(container.servers[0]?.methods()).not.toContain(
      "account/rateLimits/read",
    );
    expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
  });
});

describe("codex limit probe read errors", () => {
  it.each([RPC_INVALID_REQUEST, RPC_INTERNAL_ERROR])(
    "reports no_limits when the read fails with code %i",
    async (code) => {
      const { container, probe } = setup({
        rateLimitReads: [{ kind: "error", code, message: "not available" }],
      });

      const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

      expect(result).toEqual({ kind: "no_limits" });
      expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
    },
  );

  it("fails quietly on an unexpected rpc error and still stops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, probe } = setup({
      rateLimitReads: [
        { kind: "error", code: RPC_METHOD_NOT_FOUND, message: "nope" },
      ],
    });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "failed" });
    expect(warn.mock.calls[0]?.[0]).toBe(
      `limit probe failed: ${ACCOUNT_CODEX_A.id}`,
    );
    expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
  });

  it("times out a hung read, stops the process and fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, probe } = setup({ rateLimitReads: [{ kind: "hang" }] });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "failed" });
    expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
    expect(warn.mock.calls[0]?.[0]).toBe(
      `limit probe failed: ${ACCOUNT_CODEX_A.id}`,
    );
  });
});

describe("codex limit probe abort and launch failures", () => {
  it("stops the process early when the signal aborts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, probe } = setup(
      { rateLimitReads: [{ kind: "hang" }] },
      { timeoutMs: 60_000 },
    );
    const controller = new AbortController();

    const running = probe(ACCOUNT_CODEX_A, controller.signal);
    await vi.waitFor(() => {
      expect(container.servers[0]?.methods()).toContain(
        "account/rateLimits/read",
      );
    });
    controller.abort();

    await expect(running).resolves.toEqual({ kind: "failed" });
    expect(stopCallsOf(container)).toEqual([[GRACE_MS]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not spawn when the signal is already aborted", async () => {
    const { container, probe } = setup(OK_CONFIG);
    const controller = new AbortController();
    controller.abort();

    await expect(probe(ACCOUNT_CODEX_A, controller.signal)).resolves.toEqual({
      kind: "failed",
    });
    expect(container.specs).toEqual([]);
  });
});

describe("codex limit probe launch failures", () => {
  it("fails without spawning when the executable cannot be resolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { container, probe } = setup(OK_CONFIG, {
      executable: () => Promise.reject(new Error("Codex executable not found")),
    });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "failed" });
    expect(container.specs).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toBe(
      `limit probe failed: ${ACCOUNT_CODEX_A.id}`,
    );
  });

  it("stop_that_throws_is_not_released", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const inner = new ScriptedCodexContainer();
    Object.assign(inner.config, OK_CONFIG);
    const container: ProcessContainer = {
      kind: inner.kind,
      spawn: async (spec) => ({
        ...(await inner.spawn(spec)),
        stop: () => Promise.reject(new Error("kill failed")),
      }),
      sweepOrphans: () => inner.sweepOrphans(),
    };
    const { probe } = setup(OK_CONFIG, { container });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "unstopped" });
    expect(error).toHaveBeenCalledOnce();
  });

  it("stop_with_survivors_is_not_released", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const container = new ScriptedCodexContainer([
      {
        ok: false,
        reason: StopFailureReason.notEmptyAfterTimeout,
        survivors: [4242],
      },
    ]);
    Object.assign(container.config, OK_CONFIG);
    const probe = createCodexLimitProbe({
      container,
      envFor: () => ({}),
      executable: () => Promise.resolve(EXECUTABLE),
      platform: "linux",
      timeoutMs: TIMEOUT_MS,
      stopGraceMs: GRACE_MS,
      newRunId: () => "probe-test",
    });

    const result = await probe(ACCOUNT_CODEX_A, new AbortController().signal);

    expect(result).toEqual({ kind: "unstopped" });
    expect(warn).toHaveBeenCalledWith(
      `limit probe left processes behind: ${ACCOUNT_CODEX_A.id}`,
    );
  });
});
