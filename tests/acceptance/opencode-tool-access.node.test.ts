import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentToolAccess } from "../../src/backend/agentAdapter";
import type { ExecText } from "../../src/backend/exec";
import { createVersionProbe } from "../../src/backend/opencode/version";
import type { AgentEvent } from "../../src/domain/events";
import { PermissionProfile } from "../../src/domain/types";
import {
  createOpencodeRig,
  disposeOpencodeRigs,
  opencodeServerOf,
} from "../fakes/fakeOpencodeServer";
import {
  createOpencodeV2Rig,
  opencodeV2ServerOf,
} from "../fakes/fakeOpencodeV2Server";

const TOKEN = "tok-secret-0123456789";
const SERVER = "codeweave";
const URL = "http://127.0.0.1:45871/mcp";
const TOOLS: AgentToolAccess = {
  server: SERVER,
  url: URL,
  token: TOKEN,
  toolNames: ["ping", "run_flow"],
};
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const REFUSAL = {
  ok: false,
  reason: "error",
  message: "Orchestrate needs OpenCode 2.3.2 or newer",
};
const UNDETECTABLE_PREFIX = "The OpenCode version could not be determined.";
const V2_ASKED_ACTIONS = ["shell", "edit", "webfetch", "external_directory"];

afterEach(disposeOpencodeRigs);

function printing(stdout: string): ReturnType<typeof vi.fn<ExecText>> {
  return vi.fn<ExecText>(() => Promise.resolve(stdout));
}

function probeFor(stdout: string): ReturnType<typeof createVersionProbe> {
  return createVersionProbe({ exec: printing(stdout), platform: "linux" });
}

describe("opencode v1 tool access", () => {
  it("run_config_has_the_remote_mcp_server_and_codeweave_tools_are_not_asked", async () => {
    const rig = await createOpencodeRig();

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result.ok).toBe(true);
    const config = rig.container.startups[0]?.config;
    expect(config).toMatchObject({
      mcp: {
        codeweave: {
          type: "remote",
          url: URL,
          headers: BEARER,
          enabled: true,
        },
      },
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        external_directory: "ask",
      },
    });
    expect(config).not.toHaveProperty("permission.codeweave_ping");
    expect(config).not.toHaveProperty("permission.*");
  });

  it("run_config_has_no_mcp_entry_without_tools", async () => {
    const rig = await createOpencodeRig();

    await rig.start();

    expect(rig.container.startups[0]?.config).not.toHaveProperty("mcp");
  });

  it.skipIf(process.platform === "win32")(
    "run_config_with_the_token_is_0600_and_removed_with_the_run",
    async () => {
      const rig = await createOpencodeRig();
      const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);
      if (!result.ok) {
        throw new Error(result.message);
      }

      expect(rig.container.startups[0]?.configFileMode).toBe(0o600);
      expect(rig.container.startups[0]?.runDirMode).toBe(0o700);

      await result.handle.stop(100);

      expect(await readdir(rig.runtimeRoot)).toEqual([]);
    },
  );

  it("never_puts_the_tool_token_in_argv", async () => {
    const rig = await createOpencodeRig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    const spec = rig.container.specs[0];
    expect(JSON.stringify(spec?.args)).not.toContain(TOKEN);
    expect(Object.values(spec?.env ?? {}).join("\n")).not.toContain(TOKEN);
  });

  it("supports_tools_on_1_19_5", async () => {
    const rig = await createOpencodeRig({
      generationFor: probeFor("1.19.5\n"),
    });

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result.ok).toBe(true);
    expect(rig.container.startups[0]?.config).toHaveProperty("mcp.codeweave");
  });
});

describe("opencode v2 tool access", () => {
  it("run_config_has_the_remote_mcp_server_without_codemode_and_tools_are_not_asked", async () => {
    const rig = await createOpencodeV2Rig();

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result.ok).toBe(true);
    const config = rig.container.startups[0]?.config;
    expect(config).toMatchObject({
      mcp: {
        servers: {
          codeweave: {
            type: "remote",
            url: URL,
            headers: BEARER,
            codemode: false,
          },
        },
      },
      permissions: V2_ASKED_ACTIONS.map((action) => ({
        action,
        resource: "*",
        effect: "ask",
      })),
    });
  });

  it("run_config_has_no_mcp_entry_without_tools", async () => {
    const rig = await createOpencodeV2Rig();

    await rig.start();

    expect(rig.container.startups[0]?.config).not.toHaveProperty("mcp");
  });

  it.skipIf(process.platform === "win32")(
    "run_config_with_the_token_is_0600_and_removed_with_the_run",
    async () => {
      const rig = await createOpencodeV2Rig();
      const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);
      if (!result.ok) {
        throw new Error(result.message);
      }

      expect(rig.container.startups[0]?.configFileMode).toBe(0o600);

      await result.handle.stop(100);

      expect(await readdir(rig.runtimeRoot)).toEqual([]);
    },
  );

  it("never_puts_the_tool_token_in_argv", async () => {
    const rig = await createOpencodeV2Rig();

    await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    const spec = rig.container.specs[0];
    expect(JSON.stringify(spec?.args)).not.toContain(TOKEN);
    expect(Object.values(spec?.env ?? {}).join("\n")).not.toContain(TOKEN);
  });
});

describe("opencode v2 tool server naming", () => {
  it("uses_the_server_name_verbatim_as_the_key", async () => {
    const rig = await createOpencodeV2Rig();

    await rig.start(PermissionProfile.ask, "run-1", {
      ...TOOLS,
      server: "my server.v2",
    });

    expect(rig.container.startups[0]?.config).toHaveProperty("mcp.servers", {
      "my server.v2": {
        type: "remote",
        url: URL,
        headers: BEARER,
        codemode: false,
      },
    });
  });
});

describe("opencode v2 tool access version gate", () => {
  it("refuses_tools_on_OpenCode_older_than_2.3.2", async () => {
    const rig = await createOpencodeV2Rig({
      generationFor: probeFor("opencode v2.3.1\n"),
    });

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result).toEqual(REFUSAL);
    expect(rig.container.specs).toHaveLength(0);
    expect(await readdir(rig.runtimeRoot)).toEqual([]);
  });

  it("still_starts_without_tools_on_2.2.5", async () => {
    const rig = await createOpencodeV2Rig({
      generationFor: probeFor("opencode v2.2.5\n"),
    });

    const result = await rig.start();

    expect(result.ok).toBe(true);
  });

  it.each(["opencode v2.3.2\n", "opencode v2.10.0\n"])(
    "starts_tools_on_%j",
    async (stdout) => {
      const rig = await createOpencodeV2Rig({
        generationFor: probeFor(stdout),
      });

      const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

      expect(result.ok).toBe(true);
      expect(rig.container.startups[0]?.config).toHaveProperty(
        "mcp.servers.codeweave",
      );
    },
  );

  it("refuses_tools_when_the_version_cannot_be_parsed", async () => {
    const rig = await createOpencodeV2Rig({
      generationFor: probeFor("garbage\n"),
    });

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(result.ok ? "" : result.message).toContain(UNDETECTABLE_PREFIX);
    expect(rig.container.specs).toHaveLength(0);
  });
});

describe("opencode tool token redaction", () => {
  it("redacts the tool token in a start failure", async () => {
    const rig = await createOpencodeRig();
    rig.container.config.exitBeforeListening = true;
    rig.container.config.stderrText = `mcp connect failed: Authorization: Bearer ${TOKEN}`;

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.message;
    expect(message).toContain("Authorization: Bearer [redacted]");
    expect(message).not.toContain(TOKEN);
  });

  it("redacts the tool token in a v2 start failure", async () => {
    const rig = await createOpencodeV2Rig();
    rig.container.config.exitBeforeListening = true;
    rig.container.config.stderrText = `mcp connect failed: Authorization: Bearer ${TOKEN}`;

    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : result.message;
    expect(message).toContain("Authorization: Bearer [redacted]");
    expect(message).not.toContain(TOKEN);
  });
});

describe("opencode tool token redaction in turns", () => {
  it("redacts the tool token in a turn failure", async () => {
    const rig = await createOpencodeRig();
    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);
    if (!result.ok) {
      throw new Error(result.message);
    }
    const events: AgentEvent[] = [];
    result.handle.subscribe((event) => events.push(event));
    opencodeServerOf(rig).enqueue([
      {
        type: "error",
        name: "APIError",
        message: `mcp said Bearer ${TOKEN} rejected`,
        statusCode: 500,
      },
      { type: "idle" },
    ]);

    await result.handle.prompt("go", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "mcp said Bearer [redacted] rejected",
      },
    ]);
  });

  it("redacts the tool token in a v2 turn failure", async () => {
    const rig = await createOpencodeV2Rig();
    const result = await rig.start(PermissionProfile.ask, "run-1", TOOLS);
    if (!result.ok) {
      throw new Error(result.message);
    }
    const events: AgentEvent[] = [];
    result.handle.subscribe((event) => events.push(event));
    opencodeV2ServerOf(rig).enqueue([
      { type: "started" },
      {
        type: "failed",
        error: {
          type: "provider.unknown",
          message: `mcp said Bearer ${TOKEN} rejected`,
        },
      },
    ]);

    await result.handle.prompt("go", { model: null });

    expect(events).toEqual([
      {
        type: "turn_error",
        errorKind: null,
        rpcCode: null,
        message: "mcp said Bearer [redacted] rejected",
      },
    ]);
  });
});
