import type { ProviderId } from "../domain/types";

import {
  AgentStartFailure,
  type AgentAdapter,
  type AgentStartResult,
  type AgentStartSpec,
} from "./agentAdapter";

export function createProviderAdapter(
  adapters: Readonly<Partial<Record<ProviderId, AgentAdapter>>>,
): AgentAdapter {
  return {
    start(spec: AgentStartSpec): Promise<AgentStartResult> {
      const adapter = adapters[spec.account.provider];
      if (adapter === undefined) {
        return Promise.resolve({
          ok: false,
          reason: AgentStartFailure.error,
          message: `Provider ${spec.account.provider} is not supported`,
        });
      }
      return adapter.start(spec);
    },
  };
}
