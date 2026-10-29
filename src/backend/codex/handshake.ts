import {
  CLIENT_NAME,
  CLIENT_TITLE,
  CLIENT_VERSION,
  CodexMethod,
} from "./constants";
import {
  AccountReadResponseSchema,
  InitializeResponseSchema,
} from "./protocol";
import type { CodexRpc } from "./rpc";

export interface CodexAccountState {
  readonly needsLogin: boolean;
}

export async function openCodexAccount(
  rpc: CodexRpc,
): Promise<CodexAccountState> {
  await rpc.request(
    CodexMethod.initialize,
    {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: CLIENT_VERSION,
      },
    },
    InitializeResponseSchema,
  );
  rpc.notify(CodexMethod.initialized);
  const account = await rpc.request(
    CodexMethod.accountRead,
    {},
    AccountReadResponseSchema,
  );
  return { needsLogin: account.account === null && account.requiresOpenaiAuth };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`Timed out after ${String(ms)} ms`));
  }, ms);
  return Promise.race([promise, timeout.promise]).finally(() => {
    clearTimeout(timer);
  });
}
