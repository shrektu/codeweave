import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import { RPC_CODE_PEER_CLOSED, RPC_MESSAGE_PEER_CLOSED } from "./constants";

export type RpcId = number | string;

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (
  id: RpcId,
  method: string,
  params: unknown,
) => void;

export interface CodexRpc {
  readonly closed: Promise<void>;
  request<S extends z.ZodType>(
    method: string,
    params: unknown,
    schema: S,
  ): Promise<z.output<S>>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: NotificationHandler): void;
  onServerRequest(handler: ServerRequestHandler): void;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, code: number, message: string): void;
  close(): void;
}

const EnvelopeSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

interface PendingRequest {
  readonly accept: (raw: unknown) => void;
  readonly reject: (error: unknown) => void;
}

function parseLine(line: string): Envelope | null {
  try {
    const parsed = EnvelopeSchema.safeParse(JSON.parse(line));
    if (parsed.success) {
      return parsed.data;
    }
    console.warn("codex app-server sent an unexpected message", line);
  } catch (error) {
    console.warn("codex app-server sent an unparseable line", error);
  }
  return null;
}

function peerClosed(): CodexRpcError {
  return new CodexRpcError(RPC_CODE_PEER_CLOSED, RPC_MESSAGE_PEER_CLOSED);
}

class CodexRpcPeer implements CodexRpc {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private readonly requestHandlers: ServerRequestHandler[] = [];
  private readonly lines: Interface;
  private readonly output: Writable;
  private readonly closeSignal = Promise.withResolvers<undefined>();
  private nextId = 0;
  private isClosed = false;

  constructor(input: Readable, output: Writable) {
    this.output = output;
    this.lines = createInterface({ input });
    input.on("error", (error: Error) => {
      this.onStreamError(error);
    });
    this.lines.on("error", (error: Error) => {
      this.onStreamError(error);
    });
    this.lines.on("line", (line) => {
      this.onLine(line);
    });
    this.lines.on("close", () => {
      this.isClosed = true;
      this.failAll();
      this.closeSignal.resolve(undefined);
    });
  }

  get closed(): Promise<void> {
    return this.closeSignal.promise;
  }

  request<S extends z.ZodType>(
    method: string,
    params: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    if (this.isClosed) {
      return Promise.reject(peerClosed());
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<z.output<S>>((resolve, reject) => {
      const accept = (raw: unknown): void => {
        const result = schema.safeParse(raw);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(
            new Error(`Invalid ${method} response: ${result.error.message}`),
          );
        }
      };
      this.pending.set(id, { accept, reject });
      this.write(
        params === undefined ? { id, method } : { id, method, params },
      );
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.requestHandlers.push(handler);
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  close(): void {
    this.lines.close();
  }

  private onStreamError(error: Error): void {
    if (this.isClosed) {
      return;
    }
    console.warn("codex app-server stream error", error);
    this.close();
  }

  private write(message: Readonly<Record<string, unknown>>): void {
    if (this.isClosed || this.output.destroyed || this.output.writableEnded) {
      return;
    }
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(peerClosed());
    }
  }

  private onLine(line: string): void {
    if (line.trim() === "") {
      return;
    }
    const message = parseLine(line);
    if (message === null) {
      return;
    }
    try {
      this.dispatch(message);
    } catch (error) {
      console.error("codex rpc handler failed", error);
    }
  }

  private dispatch(message: Envelope): void {
    if (message.method === undefined) {
      if (typeof message.id === "number") {
        this.settle(message.id, message);
      }
      return;
    }
    if (message.id === undefined) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params);
      }
      return;
    }
    for (const handler of this.requestHandlers) {
      handler(message.id, message.method, message.params);
    }
  }

  private settle(id: number, message: Envelope): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(id);
    if (message.error !== undefined) {
      const { code, message: text, data } = message.error;
      entry.reject(new CodexRpcError(code, text, data));
      return;
    }
    entry.accept(message.result ?? {});
  }
}

export function createCodexRpc(input: Readable, output: Writable): CodexRpc {
  return new CodexRpcPeer(input, output);
}
