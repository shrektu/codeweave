import {
  CATALOG_PROBE_TIMEOUT_MS,
  CATALOG_STOP_MARGIN_MS,
  PORT_CHANNEL,
  PROTOCOL_VERSION,
  SESSION_START_TIMEOUT_MS,
} from "../shared/constants";
import type { PortLike } from "../shared/port";
import {
  EventSchema,
  ResponseSchema,
  ResultSchemas,
  type IpcErrorCode,
  type IpcEvent,
  type IpcResponse,
  type ParamsMap,
  type RequestMethod,
  type ResultMap,
} from "../shared/protocol";

export const REQUEST_TIMEOUT_MS = 5000;
export const VAULT_REQUEST_TIMEOUT_MS = 130_000;
export const CATALOG_REQUEST_TIMEOUT_MS =
  CATALOG_PROBE_TIMEOUT_MS + CATALOG_STOP_MARGIN_MS;

const METHOD_TIMEOUTS_MS: Readonly<Partial<Record<RequestMethod, number>>> = {
  "accounts/add": VAULT_REQUEST_TIMEOUT_MS,
  "accounts/setKey": VAULT_REQUEST_TIMEOUT_MS,
  "models/catalog": CATALOG_REQUEST_TIMEOUT_MS,
  "session/start": SESSION_START_TIMEOUT_MS,
};

export class IpcRemoteError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcRemoteError";
    this.code = code;
  }
}

export interface IpcClient {
  request<M extends RequestMethod>(
    method: M,
    params: ParamsMap[M],
  ): Promise<ResultMap[M]>;
  subscribe(listener: (event: IpcEvent) => void): () => void;
}

function isEventMessage(data: unknown): boolean {
  return typeof data === "object" && data !== null && "event" in data;
}

export function fromDomPort(port: MessagePort): PortLike {
  return {
    post(data: unknown): void {
      port.postMessage(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      const handler = (event: MessageEvent<unknown>): void => {
        listener(event.data);
      };
      port.addEventListener("message", handler);
      port.start();
      return (): void => {
        port.removeEventListener("message", handler);
      };
    },
    onClose(listener: () => void): void {
      port.addEventListener("close", listener);
    },
    close(): void {
      port.close();
    },
  };
}

export function createIpcClient(port: PortLike): IpcClient {
  const pending = new Map<string, (response: IpcResponse) => void>();
  const listeners = new Set<(event: IpcEvent) => void>();

  port.onMessage((data) => {
    if (isEventMessage(data)) {
      const event = EventSchema.safeParse(data);
      if (event.success) {
        for (const listener of listeners) {
          listener(event.data);
        }
      } else {
        console.warn("Dropped an invalid IPC event", event.error);
      }
      return;
    }
    const parsed = ResponseSchema.safeParse(data);
    if (parsed.success && parsed.data.id !== null) {
      pending.get(parsed.data.id)?.(parsed.data);
    }
  });

  return {
    subscribe(listener: (event: IpcEvent) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    request<M extends RequestMethod>(
      method: M,
      params: ParamsMap[M],
    ): Promise<ResultMap[M]> {
      const id = crypto.randomUUID();
      const { promise, resolve, reject } =
        Promise.withResolvers<ResultMap[M]>();
      const timer = window.setTimeout(() => {
        reject(new Error(`IPC request "${method}" timed out`));
      }, METHOD_TIMEOUTS_MS[method] ?? REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        if (!response.ok) {
          reject(
            new IpcRemoteError(response.error.code, response.error.message),
          );
          return;
        }
        const result = ResultSchemas[method].safeParse(response.result);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(
            new Error(`IPC response to "${method}" has an invalid result`),
          );
        }
      });

      port.post({ v: PROTOCOL_VERSION, id, method, params });

      return promise.finally(() => {
        window.clearTimeout(timer);
        pending.delete(id);
      });
    },
  };
}

function waitForPort(): Promise<MessagePort> {
  const { promise, resolve } = Promise.withResolvers<MessagePort>();
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const [port] = event.ports;
    if (event.source === window && event.data === PORT_CHANNEL && port) {
      resolve(port);
    }
  });
  return promise;
}

export const connectedClient: Promise<IpcClient> = waitForPort().then((port) =>
  createIpcClient(fromDomPort(port)),
);
