import { describe, expect, it, vi, type Mock } from "vitest";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartResult,
  type AgentStartSpec,
} from "../../src/backend/agentAdapter";
import { createProviderAdapter } from "../../src/backend/providerAdapter";
import { PermissionProfile, ProviderId } from "../../src/domain/types";

interface StubAdapter {
  readonly adapter: AgentAdapter;
  readonly start: Mock<AgentAdapter["start"]>;
}

function specFor(provider: ProviderId): AgentStartSpec {
  return {
    account: {
      id: `acc-${provider}`,
      provider,
      label: provider,
      configDir: `/cfg/${provider}`,
      order: 0,
    },
    cwd: "/work",
    profile: PermissionProfile.ask,
    runId: "run-1",
    executable: `/usr/bin/${provider}`,
  };
}

function stubAdapter(message: string): StubAdapter {
  const start = vi.fn<AgentAdapter["start"]>((): Promise<AgentStartResult> =>
    Promise.resolve({
      ok: false,
      reason: AgentStartFailure.needsLogin,
      message,
    }),
  );
  return { adapter: { start }, start };
}

describe("provider adapter", () => {
  it("unsupported_provider_start_fails", async () => {
    const adapter = createProviderAdapter({
      [ProviderId.claude]: stubAdapter("claude adapter").adapter,
    });

    const result = await adapter.start(specFor(ProviderId.codex));

    expect(result).toEqual({
      ok: false,
      reason: AgentStartFailure.error,
      message: "Provider codex is not supported",
    });
  });

  it("provider_adapter_dispatches_to_the_accounts_provider", async () => {
    const claude = stubAdapter("claude adapter");
    const codex = stubAdapter("codex adapter");
    const adapter = createProviderAdapter({
      [ProviderId.claude]: claude.adapter,
      [ProviderId.codex]: codex.adapter,
    });
    const spec = specFor(ProviderId.codex);

    const result = await adapter.start(spec);

    expect(result).toEqual({
      ok: false,
      reason: AgentStartFailure.needsLogin,
      message: "codex adapter",
    });
    expect(codex.start).toHaveBeenCalledExactlyOnceWith(spec);
    expect(claude.start).not.toHaveBeenCalled();
  });
});
