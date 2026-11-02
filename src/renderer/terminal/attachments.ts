import type { IpcClient } from "../ipc";

interface ClientAttachments {
  latest: number;
  closeRequested: boolean;
}

const registry = new WeakMap<IpcClient, ClientAttachments>();

function stateOf(client: IpcClient): ClientAttachments {
  const existing = registry.get(client);
  if (existing !== undefined) {
    return existing;
  }
  const created: ClientAttachments = { latest: 0, closeRequested: false };
  registry.set(client, created);
  return created;
}

export function beginAttachment(client: IpcClient): number {
  const state = stateOf(client);
  state.latest += 1;
  state.closeRequested = false;
  return state.latest;
}

export function isLatestAttachment(
  client: IpcClient,
  generation: number,
): boolean {
  return stateOf(client).latest === generation;
}

export function requestPendingClose(client: IpcClient): void {
  stateOf(client).closeRequested = true;
}

export function isCloseRequested(client: IpcClient): boolean {
  return stateOf(client).closeRequested;
}
