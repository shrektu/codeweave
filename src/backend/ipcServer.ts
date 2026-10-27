import { z } from "zod";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { PortLike } from "../shared/port";
import {
  IpcErrorCode,
  RequestSchema,
  type IpcRequest,
  type IpcResponse,
  type RequestMethod,
  type ResultMap,
} from "../shared/protocol";

export type IpcHandlers = {
  [M in RequestMethod]: () => ResultMap[M] | Promise<ResultMap[M]>;
};

const EnvelopeSchema = z.looseObject({
  v: z.unknown().optional(),
  id: z.unknown().optional(),
  method: z.unknown().optional(),
});

function failure(
  id: string | null,
  code: IpcErrorCode,
  message: string,
): IpcResponse {
  return {
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}

async function dispatch(
  request: IpcRequest,
  handlers: IpcHandlers,
): Promise<IpcResponse> {
  try {
    const result = await handlers[request.method]();
    return { v: PROTOCOL_VERSION, id: request.id, ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(request.id, IpcErrorCode.INTERNAL, message);
  }
}

async function handleMessage(
  payload: unknown,
  handlers: IpcHandlers,
): Promise<IpcResponse> {
  const envelope = EnvelopeSchema.safeParse(payload);
  const { v, id, method } = envelope.success ? envelope.data : {};
  const requestId = typeof id === "string" ? id : null;

  if (typeof v === "number" && v !== PROTOCOL_VERSION) {
    return failure(
      requestId,
      IpcErrorCode.UNSUPPORTED_VERSION,
      `Unsupported protocol version ${String(v)}`,
    );
  }
  if (typeof method === "string" && !Object.hasOwn(handlers, method)) {
    return failure(
      requestId,
      IpcErrorCode.UNKNOWN_METHOD,
      `Unknown method ${method}`,
    );
  }
  const request = RequestSchema.safeParse(payload);
  if (!request.success) {
    return failure(requestId, IpcErrorCode.VALIDATION, request.error.message);
  }
  return dispatch(request.data, handlers);
}

export interface IpcServer {
  dispose(): void;
}

export function createIpcServer(
  port: PortLike,
  handlers: IpcHandlers,
): IpcServer {
  let disposed = false;
  const stopListening = port.onMessage((payload) => {
    void handleMessage(payload, handlers).then((response) => {
      if (!disposed) {
        port.post(response);
      }
    });
  });
  const server: IpcServer = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      stopListening();
      port.close();
    },
  };
  port.onClose(() => {
    server.dispose();
  });
  return server;
}
