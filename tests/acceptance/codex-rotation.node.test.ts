import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createExecutableResolver } from "../../src/backend/startup";
import { IpcErrorCode } from "../../src/shared/protocol";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACCOUNT_CLAUDE_C,
  ACCOUNT_CODEX_A,
  ACCOUNT_CODEX_B,
  RIG_NOW_MS,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import {
  commandItem,
  itemCompleted,
  itemStarted,
  rateLimitsResponse,
  rateSnapshot,
  rateWindow,
  type RateLimitRead,
} from "../fakes/fakeCodexAppServer";
import { hostBinDirWith, hostResolverEnv } from "../fakes/processHelpers";
import { settled } from "../fakes/settle";

const RESET_AT = 1_700_003_600;
const FIVE_HOUR_MINUTES = 300;
const FULL_PERCENT = 100;
const LOW_PERCENT = 10;
const DEPLOY_COMMAND = "echo deploy-side-effect | tee -a effects.log";
const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Try again at 3:14 PM.";

const INITIAL_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(rateWindow(LOW_PERCENT, FIVE_HOUR_MINUTES, null), null),
  ),
};

const EXHAUSTED_READ: RateLimitRead = {
  kind: "ok",
  response: rateLimitsResponse(
    rateSnapshot(
      rateWindow(FULL_PERCENT, FIVE_HOUR_MINUTES, RESET_AT),
      null,
      "rate_limit_reached",
    ),
    false,
  ),
};

const TurnStartParamsSchema = z.looseObject({
  input: z.array(z.looseObject({ text: z.string() })),
});

afterEach(closeRigs);

function firstPromptOf(rig: BackendRig, serverIndex: number): string {
  const server = rig.codexContainer.servers[serverIndex];
  if (server === undefined) {
    throw new Error(`codex server ${String(serverIndex)} was not spawned`);
  }
  const [params] = server.paramsOf("turn/start");
  return TurnStartParamsSchema.parse(params).input[0]?.text ?? "";
}

async function rotateCodexA(rig: BackendRig): Promise<string> {
  rig.codexContainer.config.rateLimitReads = [INITIAL_READ, EXHAUSTED_READ];
  rig.codexContainer.scriptNext([
    itemStarted(commandItem("c1", DEPLOY_COMMAND, "inProgress")),
    itemCompleted(
      commandItem("c1", DEPLOY_COMMAND, "completed", "deploy-side-effect\n"),
    ),
    {
      type: "fail",
      codexErrorInfo: "usageLimitExceeded",
      message: USAGE_LIMIT_MESSAGE,
    },
  ]);
  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "codex",
  });
  await rig.call("session/prompt", {
    sessionId: (await rig.session()).id,
    text: "ship the release",
  });
  await settled(() => {
    expect(rig.codexContainer.servers).toHaveLength(2);
    expect(rig.codexContainer.servers[1]?.methods() ?? []).toContain(
      "turn/start",
    );
  });
  return started.id;
}

describe("codex rotation through the backend", () => {
  it("codex_rotation_switches_with_context_package", async () => {
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B, ACCOUNT_CLAUDE_C],
    });

    const sessionId = await rotateCodexA(rig);

    expect(rig.order.slice(0, 3)).toEqual([
      "spawn:run-1",
      "stop-confirmed:run-1",
      "spawn:run-2",
    ]);
    expect(await rig.contained[0]?.isEmpty()).toBe(true);
    const handoff = firstPromptOf(rig, 1);
    expect(handoff).toContain("1. ship the release");
    expect(handoff).toContain(`- ${DEPLOY_COMMAND}\n  Status: completed`);
    expect(handoff).toContain(
      "Side effect: do not re-run automatically; verify its effect first.",
    );
    await settled(async () => {
      const view = await rig.session();
      expect(view.phase).toEqual({
        phase: "running",
        accountId: ACCOUNT_CODEX_B.id,
      });
      expect(view.provider).toBe("codex");
    });
    expect(await rig.store.readSwitchLog(10)).toEqual([
      {
        at: RIG_NOW_MS,
        sessionId,
        from: ACCOUNT_CODEX_A.id,
        to: ACCOUNT_CODEX_B.id,
        reason: "rate_limit",
        resetsAt: RESET_AT,
        contextPackageChars: handoff.length,
      },
    ]);
    expect(rig.container.agents).toHaveLength(0);
    expect(
      rig.order.filter((entry) => entry.startsWith("spawn:")),
    ).toHaveLength(2);
  });
});

describe("codex session model through the backend", () => {
  it("thread_start_model_is_the_session_current_model_before_any_prompt", async () => {
    const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
    rig.codexContainer.config.threadModel = "gpt-5-codex";

    await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });

    const view = await rig.session();
    expect(view.currentModel).toBe("gpt-5-codex");
    expect(view.turns).toEqual([]);
  });

  it("session_without_a_reported_model_has_no_current_model", async () => {
    const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });

    await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });

    expect((await rig.session()).currentModel).toBeNull();
  });

  it("codex_default_turn_shows_announced_model", async () => {
    const rig = await openRig({ accounts: [ACCOUNT_CODEX_A] });
    rig.codexContainer.config.threadModel = "gpt-5-codex";
    await rig.call("session/start", { cwd: rig.cwd, provider: "codex" });

    await rig.call("session/prompt", {
      sessionId: (await rig.session()).id,
      text: "hello",
    });

    await settled(async () => {
      const view = await rig.session();
      expect(view.turnInFlight).toBe(false);
      expect(view.turns).toEqual([
        expect.objectContaining({
          model: null,
          effectiveModel: "gpt-5-codex",
        }),
      ]);
    });
  });

  it("current_model_follows_the_account_after_rotation", async () => {
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B],
    });
    rig.codexContainer.config.threadModel = "gpt-5-codex";

    await rotateCodexA(rig);

    await settled(async () => {
      const view = await rig.session();
      expect(view.phase).toEqual({
        phase: "running",
        accountId: ACCOUNT_CODEX_B.id,
      });
      expect(view.currentModel).toBe("gpt-5-codex");
    });
  });
});

describe("session provider selection", () => {
  it("codex_session_without_codex_accounts_starts_on_shared_subscription", async () => {
    const rig = await openRig({ accounts: [ACCOUNT_A, ACCOUNT_B] });

    const codexView = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "codex",
    });
    expect(codexView.provider).toBe("codex");
    expect(codexView.activeAccountId).toBe(ACCOUNT_A.id);
    expect(rig.codexContainer.servers).toHaveLength(0);
    await rig.call("session/stop", { sessionId: (await rig.session()).id });

    const view = await rig.call("session/start", { cwd: rig.cwd });
    expect(view.provider).toBe("claude");
    expect(view.activeAccountId).toBe(ACCOUNT_A.id);
    expect(rig.codexContainer.servers).toHaveLength(0);
  });

  it("session_without_any_usable_account_is_rejected", async () => {
    const rig = await openRig({ accounts: [] });
    await rig.call("accounts/add", {
      label: "Groq Off",
      configDir: join(rig.userData, "accounts", "Groq-Off"),
      provider: "opencode",
      api: {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        baseUrl: null,
        rotation: false,
        auth: "api_key",
      },
      apiKey: "sk-test-groq-off-0001",
    });

    await expect(
      rig.call("session/start", { cwd: rig.cwd, provider: "codex" }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.CONFLICT,
      message: "No usable account",
    });
  });

  it("session_without_provider_uses_first_accounts_provider", async () => {
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A, ACCOUNT_CODEX_B, ACCOUNT_CLAUDE_C],
    });

    const view = await rig.call("session/start", { cwd: rig.cwd });

    expect(view.provider).toBe("codex");
    expect(view.activeAccountId).toBe(ACCOUNT_CODEX_A.id);
    expect(rig.container.agents).toHaveLength(0);
    expect(rig.codexContainer.servers).toHaveLength(1);
  });

  it("missing_codex_executable_is_reported", async () => {
    const binDir = await hostBinDirWith("claude");
    const rig = await openRig({
      accounts: [ACCOUNT_CODEX_A, ACCOUNT_CLAUDE_C],
      resolveExecutable: createExecutableResolver(
        hostResolverEnv(binDir),
        process.platform,
      ),
    });

    await expect(
      rig.call("session/start", { cwd: rig.cwd, provider: "codex" }),
    ).rejects.toMatchObject({
      code: IpcErrorCode.UNAVAILABLE,
      message:
        "The Codex CLI was not found. Install it and restart Codeweave, or set its full path under Settings → Codex executable.",
    });

    const view = await rig.call("session/start", {
      cwd: rig.cwd,
      provider: "claude",
    });
    expect(view.activeAccountId).toBe(ACCOUNT_CLAUDE_C.id);
  });
});
