import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExecutableResolver } from "../../src/backend/startup";
import type { Account } from "../../src/domain/types";
import { IpcErrorCode } from "../../src/shared/protocol";
import type { AccountView } from "../../src/shared/views";
import {
  ACCOUNT_A,
  RIG_AGY_PATH,
  RIG_NOW_MS,
  agentOf,
  closeRigs,
  openRig,
  turnEnded,
  type BackendRig,
  type BackendRigOptions,
} from "../fakes/backendRig";
import { RIG_EXEC_PATH } from "../fakes/fakeAcpAgent";
import { NO_LIMITS_USAGE_MARKDOWN } from "../fakes/fakeClaudeUsage";
import { settlesWithin } from "../fakes/fakeCodexAppServer";
import { settled } from "../fakes/settle";
import {
  quotaFailureTurn,
  replyTurn,
  usageBucket,
  usageGroup,
  type UsageScript,
} from "../fakes/fakeAgy";
import {
  hostBinDirWith,
  hostExecutable,
  hostResolverEnv,
  makeTempDir,
} from "../fakes/processHelpers";

const CONV = "conv-1";
const FIVE_HOUR_RESET = 1_793_364_876;
const WEEKLY_RESET = 1_793_614_882;
const ABORT_SETTLE_MS = 2000;
const CHANGED_MESSAGE =
  "Gemini workspace config (.agents) changed during this session; review it and start a new session";

const EXHAUSTED_USAGE: UsageScript = {
  kind: "ok",
  groups: [
    usageGroup("Gemini Models", [
      usageBucket("gemini-weekly", "weekly", 0, "2026-11-02T10:21:22Z"),
      usageBucket("gemini-5h", "5h", 0, "2026-10-30T12:54:36Z"),
    ]),
  ],
};

const tempRoots: string[] = [];

afterEach(async () => {
  await closeRigs();
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface GeminiRig {
  readonly rig: BackendRig;
  readonly gemini: Account;
}

async function geminiRig(
  extra: Partial<BackendRigOptions> = {},
): Promise<GeminiRig> {
  const userData = await makeTempDir();
  tempRoots.push(userData);
  const gemini: Account = {
    id: "gemini-a",
    provider: "gemini",
    label: "Gemini",
    configDir: join(userData, "accounts", "gemini-a"),
    order: 0,
  };
  const rig = await openRig({
    userData,
    accounts: [gemini, ACCOUNT_A],
    ...extra,
  });
  return { rig, gemini };
}

async function firstCycleDone(rig: BackendRig): Promise<void> {
  await settled(() => {
    expect(rig.probeTasks).toHaveLength(1);
  });
}

async function viewOf(rig: BackendRig, id: string): Promise<AccountView> {
  const found = (await rig.call("accounts/list", {})).accounts.find(
    (account) => account.id === id,
  );
  if (found === undefined) {
    throw new Error(`account ${id} is not listed`);
  }
  return found;
}

describe("gemini session through the startup registration", () => {
  it("gemini_session_runs_through_startup_registration", async () => {
    const { rig, gemini } = await geminiRig();
    await firstCycleDone(rig);
    rig.agyContainer.scriptTurn(replyTurn(CONV, "Hello from Gemini"));

    const started = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "gemini",
    });
    await rig.call("session/prompt", {
      sessionId: (await rig.session()).id,
      text: "say hello",
    });
    await turnEnded(rig);

    expect(started).toMatchObject({
      provider: "gemini",
      activeAccountId: gemini.id,
    });
    expect((await rig.session()).lastTurn).toEqual({
      kind: "ended",
      stopReason: "end_turn",
    });
    const [spawn] = rig.agyContainer.agySpawns();
    expect(rig.agyContainer.agySpawns()).toHaveLength(1);
    expect(spawn?.spec.command).toBe(RIG_AGY_PATH);
    expect(spawn?.spec.cwd).toBe(rig.cwd);
    expect(spawn?.geminiDir).toBe(gemini.configDir);
    expect(spawn?.stdinLines[0]).toContain("say hello");
    expect(rig.container.agents).toHaveLength(0);
  });

  it("production_deps_write_the_hook_config_before_spawn", async () => {
    const { rig, gemini } = await geminiRig();
    await rig.call("session/start", { cwd: rig.cwd, provider: "gemini" });

    const [spawn] = rig.agyContainer.agySpawns();

    expect(spawn?.hooksJsonAtSpawn).toContain(RIG_EXEC_PATH);
    expect(spawn?.hooksJsonAtSpawn).toContain("agyHook.js");
    expect(spawn?.geminiDir).toBe(gemini.configDir);
  });

  it("production_deps_fingerprint_the_workspace_agents_dir", async () => {
    const { rig } = await geminiRig();
    await rig.call("session/start", { cwd: rig.cwd, provider: "gemini" });
    await mkdir(join(rig.cwd, ".agents"), { recursive: true });
    await writeFile(join(rig.cwd, ".agents", "hooks.json"), '{"evil":true}');
    rig.agyContainer.scriptTurn(replyTurn(CONV, "one"));

    await rig.call("session/prompt", {
      sessionId: (await rig.session()).id,
      text: "one",
    });
    await turnEnded(rig);

    expect((await rig.session()).lastTurn).toEqual({
      kind: "failed",
      message: CHANGED_MESSAGE,
    });
  });
});

describe("gemini quota rotation", () => {
  it("gemini_quota_rotates_to_next_subscription", async () => {
    const { rig, gemini } = await geminiRig();
    await firstCycleDone(rig);
    const started = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "gemini",
    });
    rig.agyContainer.scriptUsage(EXHAUSTED_USAGE);
    rig.agyContainer.scriptTurn(quotaFailureTurn(CONV));

    await rig.call("session/prompt", {
      sessionId: (await rig.session()).id,
      text: "ship the release",
    });

    await settled(async () => {
      const view = await rig.session();
      expect(view.phase).toEqual({
        phase: "running",
        accountId: ACCOUNT_A.id,
      });
    });
    const handoff = agentOf(rig).prompts[0] ?? "";
    expect(handoff).toContain("1. ship the release");
    expect(await rig.store.readSwitchLog(10)).toEqual([
      {
        at: RIG_NOW_MS,
        sessionId: started.id,
        from: gemini.id,
        to: ACCOUNT_A.id,
        reason: "rate_limit",
        resetsAt: WEEKLY_RESET,
        contextPackageChars: handoff.length,
      },
    ]);
    expect(rig.agyContainer.runningCount()).toBe(0);
    expect(rig.container.agents).toHaveLength(1);
  });
});

describe("gemini limit probe", () => {
  it("limit_probe_reports_gemini_limits_from_usage", async () => {
    const { rig, gemini } = await geminiRig({
      claudeProbeText: NO_LIMITS_USAGE_MARKDOWN,
    });

    await firstCycleDone(rig);

    expect(await viewOf(rig, gemini.id)).toMatchObject({
      runtime: { status: "ready" },
      limit: {
        accountId: gemini.id,
        status: "allowed",
        resetsAt: FIVE_HOUR_RESET,
        rateLimitType: "five_hour",
        utilization: 0.5,
        observedAt: RIG_NOW_MS,
      },
    });
    expect((await viewOf(rig, ACCOUNT_A.id)).limit).toBeNull();
    const probes = rig.agyContainer.probeSpawns();
    expect(probes).toHaveLength(1);
    expect(probes[0]?.spec.cwd).toBe(gemini.configDir);
    expect(probes[0]?.geminiDir).toBe(gemini.configDir);
    expect(rig.agyContainer.runningCount()).toBe(0);
  });

  it("limit_probe_marks_exhausted_gemini_account_with_reset", async () => {
    const { rig, gemini } = await geminiRig({ agyUsage: [EXHAUSTED_USAGE] });

    await firstCycleDone(rig);

    expect(await viewOf(rig, gemini.id)).toMatchObject({
      runtime: { status: "exhausted", resetsAt: WEEKLY_RESET },
      limit: { status: "rejected", resetsAt: WEEKLY_RESET, utilization: 1 },
    });
  });

  it("limit_probe_reports_logged_out_gemini_account", async () => {
    const { rig, gemini } = await geminiRig({
      agyUsage: [{ kind: "logged_out" }],
    });

    await firstCycleDone(rig);

    expect(await viewOf(rig, gemini.id)).toMatchObject({
      runtime: { status: "needs_login" },
      limit: null,
    });
    expect(rig.agyContainer.runningCount()).toBe(0);
  });
});

describe("gemini limit probe abort", () => {
  async function hangingProbeRig(): Promise<GeminiRig> {
    const geminiRigState = await geminiRig({ agyUsage: [{ kind: "hang" }] });
    await settled(() => {
      expect(geminiRigState.rig.agyContainer.probeSpawns()).toHaveLength(1);
    });
    return geminiRigState;
  }

  it("gemini_release_during_probe_stops_agy", async () => {
    const { rig } = await hangingProbeRig();
    rig.agyContainer.scriptTurn(replyTurn(CONV, "Hello from Gemini"));

    const starting = rig.call("session/start", {
      cwd: rig.cwd,
      provider: "gemini",
    });

    expect(await settlesWithin(starting, ABORT_SETTLE_MS)).toBe(true);
    expect(rig.agyContainer.probeSpawns()[0]?.contained.hasExited).toBe(true);
    expect(rig.agyContainer.probeSpawns()[0]?.contained.stopCalls).toHaveLength(
      1,
    );
  });

  it("gemini_dispose_during_probe_leaves_no_probe_process", async () => {
    const { rig } = await hangingProbeRig();

    expect(await settlesWithin(rig.dispose(), ABORT_SETTLE_MS)).toBe(true);
    expect(rig.agyContainer.runningCount()).toBe(0);
  });
});

describe("agy executable", () => {
  it("agy_executable_setting_is_used", async () => {
    const pathDir = await hostBinDirWith("agy", "claude");
    const otherDir = await hostBinDirWith("agy");
    tempRoots.push(pathDir, otherDir);
    const onPath = hostExecutable(pathDir, "agy");
    const configured = hostExecutable(otherDir, "agy");
    const { rig } = await geminiRig({
      agyExecutables: [onPath, configured],
      resolveExecutable: createExecutableResolver(
        hostResolverEnv(pathDir),
        process.platform,
      ),
    });
    const startedCommands = async (): Promise<string[]> => {
      await rig.call("session/start", { cwd: rig.cwd, provider: "gemini" });
      await rig.call("session/stop", { sessionId: (await rig.session()).id });
      return rig.agyContainer.agySpawns().map((spawn) => spawn.spec.command);
    };

    const fallback = await startedCommands();
    await rig.call("settings/set", { agyExecutable: configured });
    const withSetting = await startedCommands();
    await rig.call("settings/set", { agyExecutable: null });
    const cleared = await startedCommands();

    expect(fallback).toEqual([onPath]);
    expect(withSetting).toEqual([onPath, configured]);
    expect(cleared).toEqual([onPath, configured, onPath]);
  });

  it("missing_agy_executable_is_reported_and_other_providers_work", async () => {
    const binDir = await hostBinDirWith("claude");
    tempRoots.push(binDir);
    const { rig } = await geminiRig({
      resolveExecutable: createExecutableResolver(
        hostResolverEnv(binDir),
        process.platform,
      ),
    });

    await expect(
      rig.call("session/start", { cwd: rig.cwd, provider: "gemini" }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.UNAVAILABLE,
      message:
        "The agy CLI was not found. Install it and restart Codeweave, or set its full path under Settings → Gemini executable (agy).",
    });

    const view = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "claude",
    });
    expect(view.activeAccountId).toBe(ACCOUNT_A.id);
  });
});
