import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { ProviderId } from "../../src/domain/types";
import {
  RIG_NOW_MS,
  closeRigs,
  openRig,
  type BackendRig,
} from "../fakes/backendRig";
import { OPENCODE_SESSION_ID } from "../fakes/fakeOpencodeServer";
import type { OpencodeV2Step } from "../fakes/fakeOpencodeV2Server";
import { settled } from "../fakes/settle";

const GO_LIMIT_TURN: readonly OpencodeV2Step[] = [
  { type: "started" },
  {
    type: "failed",
    error: {
      type: "provider.go-limit",
      message: "OpenCode Go 5 hour usage limit reached.",
      status: 429,
      retryAfterMs: 120_000,
    },
  },
];
const RESETS_AT = 1_700_000_120;
const PROMPT_PATH = `/api/session/${OPENCODE_SESSION_ID}/prompt`;
const PromptBodySchema = z.looseObject({ text: z.string() });
const ACCOUNT_LABELS = ["Groq A", "Cerebras B"] as const;

afterEach(closeRigs);

async function addAccount(
  rig: BackendRig,
  label: string,
  provider: "groq" | "cerebras",
): Promise<string> {
  const { account } = await rig.call("accounts/add", {
    label,
    configDir: join(rig.userData, "accounts", label.replaceAll(" ", "-")),
    provider: ProviderId.opencode,
    api: {
      provider,
      model: "llama-3.3-70b",
      baseUrl: null,
      rotation: true,
    },
    apiKey: `sk-test-${provider}-0001`,
  });
  return account.id;
}

it("opencode_2x_session_rotates_on_a_go_limit", async () => {
  const rig = await openRig({ opencodeV2: true });
  const [first, second] = [
    await addAccount(rig, ACCOUNT_LABELS[0], "groq"),
    await addAccount(rig, ACCOUNT_LABELS[1], "cerebras"),
  ];
  rig.opencodeV2Container.scriptNextServer(GO_LIMIT_TURN);

  const started = await rig.call("session/start", {
    cwd: rig.cwd,
    provider: "opencode",
  });
  await rig.call("session/prompt", { text: "ship the release" });

  const handoff = await settled(() => {
    const [request] =
      rig.opencodeV2Container.servers[1]?.requestsTo("POST", PROMPT_PATH) ?? [];
    if (request === undefined) {
      throw new Error("the second server has no prompt yet");
    }
    return PromptBodySchema.parse(request.body).text;
  });
  await settled(async () => {
    expect((await rig.session()).phase).toEqual({
      phase: "running",
      accountId: second,
    });
  });
  expect(handoff).toContain("1. ship the release");
  expect(rig.order.slice(0, 3)).toEqual([
    "spawn:run-1",
    "stop-confirmed:run-1",
    "spawn:run-2",
  ]);
  expect(await rig.store.readSwitchLog(10)).toEqual([
    {
      at: RIG_NOW_MS,
      sessionId: started.id,
      from: first,
      to: second,
      reason: "rate_limit",
      resetsAt: RESETS_AT,
      contextPackageChars: handoff.length,
    },
  ]);
});
